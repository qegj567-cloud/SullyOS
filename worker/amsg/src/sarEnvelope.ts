/**
 * SAR 临时模块的信封在 worker 这一侧的处理：即时对话在云端生成时，模型回复是一个
 * `<SAR_MODULE_OUTPUT>` 信封，里面 `<CHAR_TRUE>` 是真意、`<CHAR_SURFACE>` 是被模块
 * 扭曲后的外显、`<USER_SURFACE>` 是用户本轮输入的外显。
 *
 * 分工：
 *   - 信封怎么读、外显怎么逐泡对齐，用的是前端同一份叶子（utils/vrWorld/sarEnvelopeCore）；
 *   - 这里补 worker 独有的三件事：工具循环每一轮的信封怎么逐轮拆、外显按 push 分段
 *     怎么对齐、任务 metadata 里那份快照怎么读和摘。
 *
 * 红线：外显只拿来展示，**绝不** classify、绝不执行里面的标签。副作用、self_log、
 * 情绪评估只认真意。
 */

import {
  consumeSARChatSurfaceChunk,
  parseSARModuleReplyRounds,
  type AmsgSarModuleSnapshot,
  type SARModuleRoundPiece,
  type SARModuleRuntimePlan,
} from '../../../utils/vrWorld/sarEnvelopeCore';
import { sanitizeIntoSegments, type Segment } from '../../../utils/sanitize';
import { classifyLLMOutput } from './classifier';

// ─── 任务 metadata 里的快照 ───

/** 任务 metadata 上快照的键；push 回程时只挂在最后一条上（见 agentic.processLLMRound）。 */
export const AMSG_SAR_META_KEY = 'amsgSar';

/**
 * USER_SURFACE 太长、一条 push 装不下时的旁路存储键（同思考链 / 情绪评估那套，
 * 见 index.ts 的 OFFLOAD_BATONS）。push 里只留 `metadata.amsgSarUserSurfaceRef` 指过来。
 */
export const amsgSarUserSurfaceKey = (clientTaskId: string) => `sar_user_surface:${clientTaskId}`;

/** 快照装不下时的旁路存储键；push 里只留 `metadata.amsgSarRef`。 */
export const amsgSarSnapshotKey = (clientTaskId: string) => `sar_snapshot:${clientTaskId}`;

/**
 * 某一条 push 的外显 meta 装不下时的旁路存储键；push 里只留 `metadata.amsgSarSurfaceRef`。
 * 一轮好几条 push 各挂各的外显，键里带段序号（构建 push 时的下标，0 起），互不覆盖。
 */
export const amsgSarSurfaceKey = (clientTaskId: string, segmentIndex: number) =>
  `sar_surface:${clientTaskId}:${segmentIndex}`;

/**
 * 外显横幅的长度上限（字符）。SAR 回合的一条 push 要同时装真意、外显横幅、外显 meta，
 * 横幅不截的话单段正文能装的字数会掉一半。锁屏横幅本来也显示不了这么长。
 */
export const SAR_SURFACE_BANNER_MAX = 100;

/** 截外显横幅：按字符（不劈开代理对）截到上限，超了末尾换成省略号。 */
export const clipSarSurfaceBanner = (banner: string): string => {
  const chars = Array.from(banner);
  return chars.length <= SAR_SURFACE_BANNER_MAX
    ? banner
    : `${chars.slice(0, SAR_SURFACE_BANNER_MAX - 1).join('')}…`;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** 模块状态至少得是个对象、带字符串 phase，不然 plan 和外显 meta 都没法算。 */
const isSurfaceSource = (value: unknown): boolean =>
  isPlainObject(value) && typeof value.phase === 'string';

/**
 * 从任务 metadata 读出快照。形状不对（不是对象 / v 不是 1 / 模块状态不是对象）就当没有：
 * 这一轮按普通回复处理，原文照发。
 */
export const readSarSnapshot = (
  metadata: Record<string, unknown> | null | undefined,
): AmsgSarModuleSnapshot | null => {
  const raw = metadata?.[AMSG_SAR_META_KEY];
  if (!isPlainObject(raw) || raw.v !== 1) return null;
  if (raw.character !== undefined && !isSurfaceSource(raw.character)) return null;
  if (raw.user !== undefined && !isSurfaceSource(raw.user)) return null;
  return raw as unknown as AmsgSarModuleSnapshot;
};

/**
 * 从要交给推送的 metadata 里摘掉快照。组 push 的那一层把 metadata 整个摊进每一条，
 * 不摘的话每个气泡都会被客户端铺上一份；它只该随最后一条回去一次。
 */
export const stripSarSnapshot = (
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> => {
  const { [AMSG_SAR_META_KEY]: _snapshot, ...rest } = (metadata ?? {}) as Record<string, unknown>;
  return rest;
};

// ─── 工具轮里把外显块藏起来 ───

const SURFACE_BLOCK_RE =
  /<(CHAR_SURFACE|USER_SURFACE)>[\s\S]*?(?:<\/\1>|(?=<\/?(?:SAR_MODULE_OUTPUT|CHAR_TRUE|CHAR_SURFACE|USER_SURFACE)>)|$)/gi;
const PLACEHOLDER = String.fromCharCode(5);
const PLACEHOLDER_RE = new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g');

export interface SarSurfaceMask {
  /** 外显块换成占位符之后的文本：数据标签、工具调用、副作用都只在它上面识别。 */
  masked: string;
  /** 把占位符换回原来的外显块（进旁白 / 拼全文之前调用）。 */
  restore: (text: string) => string;
}

/**
 * 把一轮输出里的 `<CHAR_SURFACE>` / `<USER_SURFACE>` 整块换成占位符。
 *
 * 外显是给人看的扭曲版本，模型常把真意里的标签原样抄进去。不藏起来的话，外显里的
 * `[[RECALL]]` 会触发工具、`schedule_active_message({...})` 会多排一条任务。占位符
 * 保住位置，攒旁白、拼全文时原样换回，finish 拆信封时外显还在原处。
 */
export const maskSarSurfaceBlocks = (text: string): SarSurfaceMask => {
  const blocks: string[] = [];
  const masked = text.replace(SURFACE_BLOCK_RE, (block) => {
    blocks.push(block);
    return `${PLACEHOLDER}${blocks.length - 1}${PLACEHOLDER}`;
  });
  return {
    masked,
    restore: (value) => (blocks.length === 0
      ? value
      : value.replace(PLACEHOLDER_RE, (_m, n) => blocks[Number(n)] ?? '')),
  };
};

// ─── 拆信封（逐轮） ───

/** 一轮输出拆出来的真意与它自己的外显（没守信封的那一轮没有外显）。 */
export type SarEnvelopePiece = SARModuleRoundPiece;

export interface SarEnvelopeParse {
  /** 真意全文：各轮真意按顺序换行拼接（跨轮重抄段已去重）。directives / 分段 / self_log 都只认它。 */
  canonical: string;
  /** 至少有一轮守了信封。全都没守时 canonical 就是各轮原文（只剥掉散落的信封标签）。 */
  enveloped: boolean;
  /** 每一轮各自的真意与外显，外显按轮对齐时用；不要求信封时为空。 */
  pieces: SarEnvelopePiece[];
  /** 用户本轮输入的外显（USER_SURFACE 原文，只在用户模块 active 时有）。 */
  userSurface?: string;
}

/**
 * finish 时逐轮拆信封（复用前端同一份 `parseSARModuleReplyRounds`）：
 *   - 这一轮守了信封 → 真意是它的 CHAR_TRUE，外显是它的 CHAR_SURFACE（只对齐这一轮的真意段）；
 *   - 这一轮没守（拆不出非空的 CHAR_TRUE）→ 这一轮原文照发、不带外显，只剥散落的信封标签；
 *   - 后续轮完整重抄前序轮真意时连同前序外显一起去重；用户外显取最后一个给了的那一轮。
 */
export const parseSarEnvelopeRounds = (
  rounds: string[],
  plan: SARModuleRuntimePlan,
): SarEnvelopeParse => {
  const parsed = parseSARModuleReplyRounds(rounds, plan);
  return {
    canonical: parsed.canonical,
    enveloped: parsed.enveloped,
    pieces: parsed.pieces,
    ...(parsed.userSurface ? { userSurface: parsed.userSurface } : {}),
  };
};

// ─── 外显按 push 分段对齐 ───

/** 对齐到某一条 push 的那段外显。 */
export interface SarSurfaceSlot {
  /** 外显原文（这一段），进 metadata.amsgSarSurface.surface，客户端按它展示。 */
  surface: string;
  /** 外显的横幅版本，替换这条 push 的 notification.body。 */
  banner: string;
}

const isEmojiSegment = (seg: Segment): boolean => /^\[\[SEND_EMOJI[:：]/i.test(seg.raw.trim());
const isHtmlSegment = (seg: Segment): boolean => /^\[html\][\s\S]*\[\/html\]$/i.test(seg.raw.trim());

const TRANSLATION_BLOCK_RE = /<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>([\s\S]*?)<\/译文>\s*<\/翻译>/;

/**
 * 判「是不是纯动作段」用的文本，跟客户端落库时交给 consumeSARChatSurfaceChunk 的那份同形：
 * 翻译块是 `原文\n%%BILINGUAL%%\n译文`，其余用横幅文本（引用已剥）。
 */
const alignKey = (seg: Segment): string => {
  const translation = seg.raw.match(TRANSLATION_BLOCK_RE);
  if (translation) {
    const original = translation[1].trim();
    const translated = translation[2].trim();
    return original && translated ? `${original}\n%%BILINGUAL%%\n${translated}` : (original || translated);
  }
  return seg.sanitized;
};

/**
 * 外显那一侧也按 push 的口径切段：先剔掉 `[[...]]` 指令和 `[html]` 块（它们只属于真意，
 * 不占外显槽位），再走同一个 sanitizeIntoSegments。翻译块、语音 + 字幕块各是一个原子段，
 * 跟真意那边同构。
 */
const segmentSurface = (surfaceText: string): Segment[] => {
  const prepared = surfaceText
    .replace(/\[html\][\s\S]*?\[\/html\]/gi, '\n')
    .replace(/\[\[[\s\S]*?\]\]/g, '');
  return sanitizeIntoSegments(prepared).filter((seg) => !isEmojiSegment(seg) && !isHtmlSegment(seg));
};

/**
 * 把一段外显按真意的 push 分段逐段对齐。规则与客户端 splitSARChatSurfaceBubbles +
 * renderAndPersist 的 takeMeta 一致：只有台词占外显槽位——表情段、HTML 段不消耗槽位；
 * 纯括号动作段的处理交给共用的 consumeSARChatSurfaceChunk。对不上的段返回 undefined。
 */
export const alignSarSurfaceSegments = (
  canonicalSegments: Segment[],
  surfaceText: string,
): Array<SarSurfaceSlot | undefined> => {
  const surfaceSegs = segmentSurface(surfaceText);
  const surfaceKeys = surfaceSegs.map(alignKey);
  let index = 0;
  return canonicalSegments.map((seg) => {
    if (isEmojiSegment(seg) || isHtmlSegment(seg)) return undefined;
    const consumed = consumeSARChatSurfaceChunk(alignKey(seg), surfaceKeys, index);
    index = consumed.nextIndex;
    if (consumed.surface === undefined) return undefined;
    const matched = surfaceSegs[consumed.nextIndex - 1];
    return matched ? { surface: matched.raw, banner: matched.sanitized } : undefined;
  });
};

/** 单段真意在 push 里会切成几段（与 processLLMRound 的 classify → sanitizeIntoSegments 同口径）。 */
const segmentCanonical = (text: string): Segment[] => {
  const scan = classifyLLMOutput(text);
  return sanitizeIntoSegments(scan.kind === 'finish' ? scan.cleanedText : scan.prefix);
};

/**
 * 给 finish 的每条 push 算外显。每一轮只跟自己那轮的外显对齐（第一轮的外显不能顶到第二轮
 * 的台词上，没守信封的那一轮一段外显都不挂）。各轮切出来的段数加起来跟实际 push 数对不上时
 * （跨轮的日记块之类），退回整体对齐。
 */
export const buildSarSurfaceSlots = (
  parse: SarEnvelopeParse,
  segments: Segment[],
): Array<SarSurfaceSlot | undefined> => {
  const none = segments.map(() => undefined);
  if (!parse.pieces.some((p) => p.surface)) return none;
  if (parse.pieces.length === 1) return alignSarSurfaceSegments(segments, parse.pieces[0].surface ?? '');

  const counts = parse.pieces.map((p) => segmentCanonical(p.canonical).length);
  if (counts.reduce((a, b) => a + b, 0) !== segments.length) {
    return alignSarSurfaceSegments(
      segments,
      parse.pieces.map((p) => p.surface).filter((s): s is string => !!s).join('\n'),
    );
  }
  const slots: Array<SarSurfaceSlot | undefined> = [];
  let offset = 0;
  parse.pieces.forEach((piece, i) => {
    const slice = segments.slice(offset, offset + counts[i]);
    offset += counts[i];
    slots.push(...(piece.surface ? alignSarSurfaceSegments(slice, piece.surface) : slice.map(() => undefined)));
  });
  return slots;
};
