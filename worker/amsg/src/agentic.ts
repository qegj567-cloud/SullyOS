/**
 * amsg worker 满血 v2 — 服务端工具循环的纯逻辑（不碰网络 / 存储，方便单测）。
 *
 * 业务标签的识别交给同目录的 classifier（./classifier）：
 *   - 数据标签（RECALL / SEARCH / READ_DIARY / XHS_* …）→ tool-request，
 *     由 index.ts 的 executeToolCalls 在 worker 里就地执行（客户端可能离线，
 *     工具只能在服务端跑）。
 *   - 副作用标签（POKE / TRANSFER / MUSIC_ACTION / 写日记 …）→ 结构化成
 *     directives 挂在最后一条 push 的 metadata 上，客户端收到时重放
 *     （activeMsgRuntime 的 isLastChunk 守卫保证只重放一次）。
 *
 * 推送只在 finish 时发生，所以中间轮的旁白和副作用要跨轮累积（FireSessionState），
 * finish 时一起出——用户一次收到整段回复，内容与逐轮说出来的一致。
 */

import {
  classifyLLMOutput,
  type Directive,
  type MusicActionSong,
  type ToolCall,
} from './classifier';
import type { ToolCallRecord } from '../../../utils/agenticToolFeedback';
import {
  extractTextFakedMcpCalls,
  MCP_FIRE_NAME_PREFIX,
  stripTextFakedMcpCalls,
  type McpFireServer,
  type McpResolvedToolCore,
} from '../../../utils/mcpFireCore';
import { sanitizeIntoSegments } from '../../../utils/sanitize';
import { AMSG_SILENT_MARK } from '../../../utils/amsgFirePack';
import {
  AMSG_FIRE_SCHEDULE_TOOL,
  extractFireScheduleTextCalls,
} from '../../../utils/amsgFireSchedule';
// type-only：编译期擦除，不会把 realtimeContext 的浏览器依赖打进 worker bundle。
import type { XhsNote } from '../../../utils/realtimeContext';
import {
  createSARModuleSurfaceMeta,
  planFromSARModuleSnapshot,
  type AmsgSarModuleSnapshot,
} from '../../../utils/vrWorld/sarEnvelopeCore';
import {
  AMSG_SAR_META_KEY,
  buildSarSurfaceSlots,
  clipSarSurfaceBanner,
  maskSarSurfaceBlocks,
  parseSarEnvelopeRounds,
  stripSarSnapshot,
  type SarEnvelopeParse,
} from './sarEnvelope';

/** 一次 fire 的跨轮累积状态（index.ts 按 sessionId 持有，finish/skip 后丢弃）。 */
export interface FireSessionState {
  /**
   * 中间轮旁白的**原始文本**（只剥了数据标签，副作用标签原样保留）。
   * 副作用不逐轮结构化——长形态日记这类跨行标签块可能被数据标签劈开两轮
   * （写日记写一半去 [[RECALL]]），逐轮扫会把孤立的 DIARY_START / DIARY_END
   * 当正文漏进 push、日记也丢。finish 时拼回全文统一扫一次。
   */
  narrations: string[];
  /**
   * 本次 fire 已经跑过的工具调用。两个用处：回喂时把清单报给模型（「这些查过了」），
   * 以及拦住同名同参的重复调用（见 executeToolCalls）。跨轮累积，fire 结束随 scratch 丢弃。
   */
  toolCalls: ToolCallRecord[];
  /** 被打回的重复调用次数（executeToolCalls 累加）。到阈值就收尾，见 MAX_DUPLICATE_TOOL_CALLS。 */
  duplicateToolCalls: number;
  /** 合成 tool_call id 的自增序号（正文那条路用；native 用模型自己的 id）。 */
  mcpCallSeq: number;
  /**
   * 出现 [[XHS_SHARE: n]] 那一轮手上的笔记列表快照（没出现过为 null）。
   *
   * 序号 n 指的是**模型写这句话时**看到的那份列表，而 finish 是拿本次 fire 结束时的
   * lastXhsNotesRef 解引用的——中间只要再搜一次，列表整个被换掉，正文聊的是 A 组第 3 篇
   * 露营帖、卡片推的却是 B 组第 3 篇口红帖。所以在那一轮就把当时的列表定格下来。
   */
  xhsShareNotes: XhsNote[] | null;
  /**
   * 最后一轮 LLM 的思考链（reasoning_content + 正文内联 `<think>`，见 index.ts 的
   * onLLMOutput）。每轮覆盖，finish 时随第一条 push 的 metadata 回客户端渲染思考链卡片。
   * 一轮都没给过思考的模型留 null，那时候一个字段都不挂。
   */
  finalReasoning: string | null;
}

export const createFireSessionState = (): FireSessionState => ({
  narrations: [],
  toolCalls: [],
  duplicateToolCalls: 0,
  mcpCallSeq: 0,
  xhsShareNotes: null,
  finalReasoning: null,
});

/**
 * 连着重复请求同一个工具这么多次，就不再陪它转了，直接收尾把已有内容发出去。
 *
 * 光把重复调用打回去只省下了网络请求，模型该转还是转：提示词里但凡有一句常驻的
 * 「每轮先去查 X」，回喂里说什么都盖不过它——实测就是连着五轮都在请求同一个 recall，
 * 最后撞上轮次上限抛 AGENTIC_LOOP_EXCEEDED，任务不出清、下一分钟整条从头重跑。
 *
 * 收尾比转到上限好得多：用户至少收到角色已经写出来的那部分，任务也正常出清。
 * 阈值取 2 —— 第一次重复可能只是模型确认一下，连着两次就是真卡住了。
 */
export const MAX_DUPLICATE_TOOL_CALLS = 2;

/**
 * 普通内置工具最多几轮 LLM。搜索 / 记忆 / 排程通常 1~3 轮就能结束，继续保留原来的
 * 5 轮预算，避免一次普通主动消息因为模型打转而烧太多请求。
 *
 * 为什么要自己判：上游在最后一轮遇到 tool-request 会直接抛 AGENTIC_LOOP_EXCEEDED，
 * 这次攒下的旁白全丢、任务不出清、下一分钟整条从头重跑再烧一遍 LLM。到最后一轮就不再
 * 放行工具请求、用手上的内容收尾，用户至少收得到角色已经写出来的那部分。
 */
export const DEFAULT_TOOL_ITERATIONS = 5;

/**
 * 通用 MCP 的硬上限。游戏 / 论坛类 MCP 常见「读规则 → 查状态 → 执行动作 → 再查状态」；
 * 5 轮会稳定地卡在真正动作之前。这里给到 12，但不是固定跑 12 次：模型一旦返回正文就
 * 当场结束，连续重复调用也会由 MAX_DUPLICATE_TOOL_CALLS 提前收束，所以实际轮数仍是
 * 1~12 自适应。
 */
export const MCP_MAX_TOOL_ITERATIONS = 12;

/** 当前 fire 的工具预算：接了 MCP 才使用长预算，普通内置工具维持原成本。 */
export const resolveToolIterationBudget = (hasMcp: boolean): number =>
  hasMcp ? MCP_MAX_TOOL_ITERATIONS : DEFAULT_TOOL_ITERATIONS;

/** 判本轮旁白里有没有 [[XHS_SHARE: n]]（与 classifier 的模式同口径，非全局免得带 lastIndex）。 */
const XHS_SHARE_TAG_RE = /\[\[XHS_SHARE:\s*\d+\]\]/;

/** 组 push payload 需要的业务字段（都来自 sessionCtx / task metadata）。 */
export interface PushBuildInput {
  contactName: string;
  avatarUrl: string | null;
  /** 任务行 id（从 sess_task_<id> 拆出），拆不出为 null。 */
  taskId: string | null;
  /** 'auto' | 'prompted'（metadata.amsgMode 透传，缺省 'auto'）。 */
  messageType: string;
  metadata: Record<string, unknown>;
  /** 本次触发时刻（任务行 next_send_at），随每条 push 的 metadata.amsgOccurrenceMs 带回客户端。 */
  occurrenceMs: number;
  /**
   * round 1 XHS 工具抓到的笔记快照（stash.toolCtx.lastXhsNotesRef.current）。
   * amsg2 的 round 1 在 worker 里跑，客户端本地没有这份笔记列表——不带回去
   * [[XHS_SHARE: n]] 重放必然 available:0。
   * finish 时只挑 directive 引用到的几张随最后一条 push 带回（web push 单条
   * payload ~4KB，全量 8 张会撑爆整条 push，那就不是掉卡片而是掉消息了）。
   */
  xhsNotes?: XhsNote[];
  /** xsecToken 缓存快照（[noteId, token][]），点赞/评论/回复重放时客户端要用。 */
  xhsXsecTokens?: Array<[string, string]>;
  /**
   * 本次触发时 prompt 里写的「你此刻在听」是哪一首（没渲染那一段时为 null）。
   * 角色写了 MUSIC_ACTION 就把它冻进 directive，见 attachSceneSong。
   */
  sceneSong?: MusicActionSong | null;
  /**
   * 本轮的 SAR 临时模块快照（任务 metadata.amsgSar，index.ts 读出并校验过形状）。
   * 调用方要先把它从 `metadata` 里摘掉：它只随最后一条 push 原样回去一次。
   * 需要信封时 finish 在分段之前拆信封，只有真意进分段与 directives，外显逐段挂回。
   */
  sar?: AmsgSarModuleSnapshot | null;
}

/** 挂在最后一条 push metadata.xhsSession 的形状；idx 1-based，与 [[XHS_SHARE: n]] 同基。 */
export interface XhsSessionPayload {
  notes: Array<{ idx: number; note: XhsNote }>;
  xsecTokens: Array<[string, string]>;
}

/** desc 截断长度：卡片预览够用，省 push 配额。 */
const XHS_DESC_MAX = 120;

/**
 * 从 finish 时的全部 directives 里挑出 XHS 引用，组客户端重放要的最小数据包：
 *   - xhs_share 的 idx → 对应笔记（越界/编造的序号取不到就跳过，客户端照旧警告）；
 *   - xhs_like / fav / comment / reply 的 noteId → 对应 xsecToken。
 * 没有任何 XHS 引用（或引用全落空）→ null，metadata 不多挂键。
 *
 * 这里**不限张数**：角色说分享了几张就带几张。塞不塞得进一条 push 是 index.ts 组装时
 * 按真实字节预算算的，超出的部分旁路存 client_state（见 offloadOversizedPush），
 * 客户端取回后照样出卡——不会出现「说分享了 6 张只出来 4 张」。
 */
export function buildXhsSessionPayload(
  directives: Directive[],
  notes: XhsNote[] | undefined,
  xsecTokens: Array<[string, string]> | undefined,
): XhsSessionPayload | null {
  if (directives.length === 0) return null;
  const sharedIdx = new Set<number>();
  const refNoteIds = new Set<string>();
  for (const d of directives) {
    if (d.type === 'xhs_share') sharedIdx.add(d.idx);
    else if (d.type === 'xhs_like' || d.type === 'xhs_fav') refNoteIds.add(d.noteId);
    else if (d.type === 'xhs_comment' || d.type === 'xhs_reply') refNoteIds.add(d.noteId);
  }
  if (sharedIdx.size === 0 && refNoteIds.size === 0) return null;

  const pickedNotes: XhsSessionPayload['notes'] = [];
  for (const idx of [...sharedIdx].sort((a, b) => a - b)) {
    const note = idx >= 1 ? notes?.[idx - 1] : undefined;
    if (!note) continue;
    pickedNotes.push({ idx, note: { ...note, desc: (note.desc || '').slice(0, XHS_DESC_MAX) } });
  }
  const pickedTokens = (xsecTokens ?? []).filter(([noteId]) => refNoteIds.has(noteId));

  if (pickedNotes.length === 0 && pickedTokens.length === 0) return null;
  return { notes: pickedNotes, xsecTokens: pickedTokens };
}

/**
 * 把「这次角色在听的那首歌」冻进 music_action directive。
 *
 * 为什么要冻：正文里那句「我在听《X》」是 worker 到点挑的（renderFireSceneBlock），
 * 而 `[[MUSIC_ACTION:add|歌单标题]]` 标签里只有歌单名。客户端重放时若只能取「用户此刻
 * 在听的那首」，定时消息补收的那一刻用户多半什么都没在放 —— 正文聊着这首歌，卡片和加
 * 歌单却整个没发生；就算用户恰好在听，加的也是用户那首，不是角色说的那首。
 *
 * 这次没渲染「此刻在听」（不在听歌的时段 / 歌单空 / 跨天作废）就不附，客户端走它原来的
 * 实时快照那条路。其余类型的 directive 一概不动。
 */
export function attachSceneSong(
  directives: Directive[],
  sceneSong: MusicActionSong | null | undefined,
): Directive[] {
  if (!sceneSong) return directives;
  return directives.map((d) => (d.type === 'music_action' ? { ...d, song: sceneSong } : d));
}

export type RoundDecision =
  | { decision: 'tool-request'; toolCalls: ToolCall[] }
  | { decision: 'finish'; pushPayloads: Array<Record<string, unknown>> }
  /** reason 直接进 last_skip，面板照实告诉用户那次为什么没响。 */
  | {
      decision: 'skip-push';
      reason: 'declined' | 'empty-generation' | 'side-effects-only';
      sideEffects?: { directives: Directive[]; xhsSession?: XhsSessionPayload };
      /**
       * 这一轮被整条丢掉、但仍要送到客户端的日程改动（没有就没有这个字段）。
       * 别的副作用丢了就丢了，日程不行——理由见下面 skip-push 那处的注释。
       */
      scheduleChanges?: Array<{ startTime: string; activity: string }>;
    };

/** 本轮的通用 MCP 识别输入（没配 MCP 的角色不传，行为与改动前完全一致）。 */
export interface McpRoundInput {
  resolve: Map<string, McpResolvedToolCore<McpFireServer>>;
  /** 本轮 LLM 响应里已识别为 MCP 的 native tool_calls（名字已是 mcp__ 声明名）；文本模式/无调用时缺省。 */
  nativeToolCalls?: ToolCall[];
}

/**
 * 本轮的任务管理工具识别输入（schedule / cancel / renew 共用一个池，
 * 由 index.ts 的 classifyNativeToolCalls 认领好传进来）。
 *
 * 和 MCP 一样两层：native tool_calls 优先，没有 native 的排程调用时从正文抠
 * schedule_active_message({...})。同一轮两处都写了排程时只认 native——同一个意图
 * 跑两遍就是排出两条一模一样的任务（取消 / 改期不教正文协议，没有这层问题）。
 */
export interface ScheduleRoundInput {
  nativeToolCalls?: ToolCall[];
}

/** classifyNativeToolCalls 的结果：认领的进两个池，认不出的名字留给调用方记日志。 */
export interface NativeCallClassification {
  /** 排程 / 取消 / 改期（声明清单命中），名字已改写成声明名。 */
  manage: ToolCall[];
  /** 通用 MCP（mcpResolve 命中），名字已改写成 `mcp__暴露名`。 */
  mcp: ToolCall[];
  /** 两份清单都对不上的原始名字（模型幻觉的工具），调用方丢弃并记日志。 */
  dropped: Array<string | null>;
}

/**
 * 把模型回报的名字解析成声明清单里的那一个。模型常把声明名的「姓」搞丢或换家：
 * 声明的是 `mcp__foo`，回报成 `foo`、`default_api:foo`、`functions.foo` 之类。
 * 原名严格命中优先（老规矩不变）；对不上再去掉命名空间取最后一段重试。
 * 每个候选按「mcp__ 前缀名 → 管理工具名 → MCP 裸名」的顺序找，清单键本身唯一，
 * 「唯一命中才认」由 Map/Set 语义天然保证。
 */
const resolveNativeFireToolName = (
  raw: string,
  manageToolNames: ReadonlySet<string>,
  mcpResolve: Map<string, McpResolvedToolCore> | null,
): { kind: 'manage' | 'mcp'; name: string } | null => {
  const candidates = [raw];
  const lastSegment = raw.split(/[:./]/).pop();
  if (lastSegment && lastSegment !== raw) candidates.push(lastSegment);
  for (const c of candidates) {
    if (!c) continue;
    if (c.startsWith(MCP_FIRE_NAME_PREFIX) && mcpResolve?.has(c.slice(MCP_FIRE_NAME_PREFIX.length))) {
      return { kind: 'mcp', name: c };
    }
    if (manageToolNames.has(c)) return { kind: 'manage', name: c };
    // 裸名回退：模型把 mcp__ 前缀弄丢时，报的就是暴露名本身。
    if (mcpResolve?.has(c)) return { kind: 'mcp', name: `${MCP_FIRE_NAME_PREFIX}${c}` };
  }
  return null;
};

/**
 * 认领本轮 LLM 响应里的 native tool_calls：管理工具（schedule / cancel / renew）
 * 与 MCP 各进各的池，两份清单都对不上的丢进 dropped。认领时名字改写回声明名——
 * 下游 executeToolCalls 按声明名分流、还要 slice mcp__ 前缀，裸名直接透传会撞上
 * 没有映射的名字。
 */
export const classifyNativeToolCalls = (
  rawToolCalls: unknown,
  manageToolNames: ReadonlySet<string>,
  mcpResolve: Map<string, McpResolvedToolCore> | null,
): NativeCallClassification => {
  const out: NativeCallClassification = { manage: [], mcp: [], dropped: [] };
  const calls = (Array.isArray(rawToolCalls) ? rawToolCalls : []) as ToolCall[];
  for (const tc of calls) {
    const raw = tc?.function?.name;
    const resolved = typeof raw === 'string' && raw
      ? resolveNativeFireToolName(raw, manageToolNames, mcpResolve)
      : null;
    if (!resolved) {
      out.dropped.push(typeof raw === 'string' && raw ? raw : null);
      continue;
    }
    const call = resolved.name === raw ? tc : { ...tc, function: { ...tc.function, name: resolved.name } };
    (resolved.kind === 'mcp' ? out.mcp : out.manage).push(call);
  }
  return out;
};

/**
 * 处理一轮 LLM 输出（入参已 stripReasoningTags）：
 *   - 有数据标签（或本轮有 MCP 调用）→ 原始旁白（prefix）暂存，返回 tool-request；
 *   - 无数据标签 → finish：把全部中间轮旁白 + 本轮正文**拼回一份全文**统一
 *     classify（跨轮被劈开的副作用标签块在这里合体），干净正文经
 *     sanitizeIntoSegments 分段（与客户端 chatParser.chunkText 同一份：
 *     按换行切、[[...]] / [html] / <翻译> / <语音> 等标签块保持原子），
 *     每段一条 push；全部 directives 挂最后一条的 metadata；
 *     全程无正文 → skip-push（这轮有没有副作用都不发，理由见分支处注释）。
 *
 * 还有一条穿透收尾：模型卡在同一个工具上出不来、或者已经是最后一轮时，本轮的工具请求
 * 不再放行，直接拿之前几轮的内容收尾；这一轮那句「等我查查」会被丢掉（它永远没有下文）。
 *
 * 通用 MCP 的调用识别是两层（native tool_calls + 正文协议），与前台同构，见函数体开头。
 *
 * SAR 临时模块生效（build.sar 要求信封）时，finish 在分段之前拆信封：只有 CHAR_TRUE
 * 进 classify / 分段；CHAR_SURFACE 逐段对齐挂 metadata.amsgSarSurface 并顶替横幅；
 * 快照与 USER_SURFACE 挂最后一条。线协议见 plans/amsg2-instant-chat-contract.md。
 */
export function processLLMRound(
  state: FireSessionState,
  llmOutputText: string,
  build: PushBuildInput,
  mcp?: McpRoundInput | null,
  schedule?: ScheduleRoundInput | null,
  /** 本轮序号（上游 sessionCtx.iteration，0-based）。到最后一轮就不再放行工具请求。 */
  iteration?: number,
  /** 与 onBeforeFire 回给上游的 maxToolIterations 必须是同一个值。 */
  maxToolIterations: number = DEFAULT_TOOL_ITERATIONS,
): RoundDecision {
  const isFinalRound = typeof iteration === 'number' && iteration >= maxToolIterations - 1;
  // SAR 临时模块生效时，回复是一个信封（见 ./sarEnvelope）。外显块先整块藏成占位符：
  // 下面所有识别（数据标签、MCP / 排程的正文调用、副作用）都只看得见真意那部分，
  // 攒旁白、拼全文时再原样换回。只剩余韵（不要求信封）时什么都不动。
  const sarPlan = planFromSARModuleSnapshot(build.sar ?? null);
  const sarMask = sarPlan?.requiresEnvelope ? maskSarSurfaceBlocks(llmOutputText) : null;
  const roundText = sarMask ? sarMask.masked : llmOutputText;
  const restoreSurfaces = (text: string): string => (sarMask ? sarMask.restore(text) : text);
  // 通用 MCP 两层识别（与前台同构）：native tool_calls 优先；没有 native 时
  // 用前台「兼容模式」同一个解析器从正文抠 tool_name({...})。两种来源都可能
  // 与数据标签同轮出现，最终合并成同一个 tool-request，executeToolCalls 按
  // mcp__ 前缀分流。正文里出现过的调用语法一律剥掉——它不能进旁白/推送。
  // 正文解析认 mcp__ 前缀名（native 模式下模型在 tools 数组里见到的名字带前缀，
  // 掉格式写进正文时写的也是它）——core 的 alsoMatchPrefix 选项负责，exposedName 回裸名。
  const nativeToolCalls = mcp?.nativeToolCalls ?? [];
  const textCalls = mcp?.resolve.size
    ? extractTextFakedMcpCalls(roundText, mcp.resolve, { alsoMatchPrefix: MCP_FIRE_NAME_PREFIX })
    : [];
  // 排程工具同样两层，语法提取与入列拆开管：正文里的排程语法**始终**抠出来剥掉
  // （跟 MCP 同一条红线：调用语法不能进旁白/推送），要不要当调用入列另说——
  // native 排程在场时不入列，同一意图两处都写的话，跑两遍就是排出两条一模一样的
  // 任务（而 MCP 那边重复调用只是白查一次）。池里现在可能混着 cancel / renew
  // （见 classifyNativeToolCalls），「不入列」只看有没有真正的 native 排程调用：
  // 本轮只 native 取消了一条时，正文里的排程语法照常入列，两个是不同意图。
  const nativeScheduleCalls = schedule?.nativeToolCalls ?? [];
  const hasNativeSchedule = nativeScheduleCalls.some(
    (tc) => tc?.function?.name === AMSG_FIRE_SCHEDULE_TOOL,
  );
  const scheduleTextCalls = schedule ? extractFireScheduleTextCalls(roundText) : [];
  const scheduleCalls: ToolCall[] = [
    ...nativeScheduleCalls,
    ...(hasNativeSchedule ? [] : scheduleTextCalls).map((c) => ({
      id: `sched_${state.mcpCallSeq++}`,
      type: 'function' as const,
      function: { name: AMSG_FIRE_SCHEDULE_TOOL, arguments: JSON.stringify(c.args) },
    })),
  ];

  const strippedText = scheduleTextCalls.length
    ? stripTextFakedMcpCalls(roundText, scheduleTextCalls)
    : roundText;
  const scanText = textCalls.length ? stripTextFakedMcpCalls(strippedText, textCalls) : strippedText;
  // native 在场时正文抠出来的不再入列（同一意图大概率两处都写了；库只给 assistant
  // 消息合并 decision 里的 toolCalls，native 已含语义）。两份都入列会把同一个工具跑
  // 两遍，第二次还会被判成重复调用往收尾计数上加。语法照剥。
  const mcpToolCalls: ToolCall[] = nativeToolCalls.length > 0
    ? nativeToolCalls
    : textCalls.map((c) => ({
        // id 只需在一轮的 assistant/tool 消息配对里唯一；本次 fire 内自增，绝不重号。
        id: `mcp_${state.mcpCallSeq++}`,
        type: 'function',
        // exposedName 恒为裸名（alsoMatchPrefix 的命中也回裸名），统一补前缀即可。
        function: { name: `${MCP_FIRE_NAME_PREFIX}${c.exposedName}`, arguments: JSON.stringify(c.args) },
      }));

  // MCP 与排程走同一条工具通道，executeToolCalls 按名字分流。
  const extraToolCalls = [...mcpToolCalls, ...scheduleCalls];

  const result = classifyLLMOutput(scanText);
  const isToolRound = result.kind === 'tool-request' || extraToolCalls.length > 0;

  if (isToolRound) {
    // prefix = 旁白 + 可能只写了一半的副作用标签块。这里不剥不结构化——
    // 等 finish 拼回全文统一扫（见 FireSessionState.narrations 注释）。
    // MCP-only 轮没有数据标签，整段剥净后的文本都是旁白（与 tag 轮的 prefix 同角色）。
    const narration = result.kind === 'tool-request' ? result.prefix : scanText;
    // 还能不能再转一轮：连着打回这么多次重复调用 = 模型卡在同一个工具上出不来；到最后一轮
    // 再返回 tool-request 则会被上游抛 AGENTIC_LOOP_EXCEEDED。两种情况都不再给下一轮，
    // 直接用手上的内容收尾——整条任务失败重跑的话，用户一个字都收不到。
    if (state.duplicateToolCalls < MAX_DUPLICATE_TOOL_CALLS && !isFinalRound) {
      // 旁白里存的是换回外显之后的原样，finish 拆信封时每一段都还是完整的。
      if (narration.trim()) state.narrations.push(restoreSurfaces(narration));
      // 这一轮说了「我分享给你」，那 n 指的就是此刻手上这份列表。定格下来，别让后面几轮
      // 的搜索把它换掉（详见 FireSessionState.xhsShareNotes）。只定格第一次：一次 fire 里
      // 跨两份列表各分享一张的情况极少，定格第一份至少让先说的那张对得上。
      if (state.xhsShareNotes === null && XHS_SHARE_TAG_RE.test(narration)) {
        state.xhsShareNotes = [...(build.xhsNotes ?? [])];
      }
      return {
        decision: 'tool-request',
        toolCalls: result.kind === 'tool-request' ? [...result.toolCalls, ...extraToolCalls] : extraToolCalls,
      };
    }
    // 穿透收尾：这一轮的旁白是「等我翻翻记录哈」这种半句，而它请求的工具永远不会跑了。
    // 发出去用户收到的最后一条就是一句没有下文的话，比少说这句更假——丢掉，只发之前
    // 几轮已经说完的内容。
  }

  // 拼回全文再扫一次。中间轮 prefix 里不含数据标签（prefix 定义即「首个数据标签
  // 之前」），本轮正文也没有（有就走上面 tool-request 分支了），所以这次分类必然
  // 落 finish；万一未来 classifier 语义变化落了 tool-request，取其 prefix 兜底，
  // 不让 fire 链在 finish 关头断掉。
  // 没有旁白（一轮直出，最常见）时全文就是本轮正文，同样的输入不必再扫一遍。
  // 从上面 tool-request 分支穿透下来收尾时，本轮的正文已经进过 narrations 了，
  // 这里再拼一次 llmOutputText 就会重复一段（而且它还带着那个转不出来的数据标签）。
  const thisRound = isToolRound ? '' : restoreSurfaces(scanText);
  const rounds = [...state.narrations, thisRound].filter((part) => part.trim().length > 0);
  const fullText = rounds.join('\n');
  // SAR 信封在这里拆：旁白本来就一轮一份，逐轮拆、逐轮降级（某一轮没守信封就原文照发），
  // 各轮真意再按顺序拼。之后的 classify / 分段 / directives 全部只认真意；外显绝不 classify。
  const sarParse: SarEnvelopeParse | null = sarPlan?.requiresEnvelope
    ? parseSarEnvelopeRounds(rounds, sarPlan)
    : null;
  // result 是在 scanText（剥掉 MCP 调用语法之后的文本）上算的，比对基准必须跟着换，
  // 否则 MCP 轮穿透到收尾时会拿错缓存。没有 MCP 参与时 scanText === llmOutputText，
  // 这里与改动前完全一致。信封轮不能复用：那份是在整个信封上算的，得对真意重扫。
  const finalScan = sarParse
    ? classifyLLMOutput(sarParse.canonical)
    : (fullText === scanText ? result : classifyLLMOutput(fullText));
  const cleanedText = finalScan.kind === 'finish' ? finalScan.cleanedText : finalScan.prefix;
  // 角色写了 MUSIC_ACTION 的话，把 prompt 里那句「你此刻在听」的那首歌冻进去（见 attachSceneSong）。
  const directives = attachSceneSong(
    finalScan.kind === 'finish' ? finalScan.directives : [],
    build.sceneSong,
  );

  // XHS 引用的笔记/token 与 directives 挂同一条 push（最后一条），客户端先落库再重放。
  // 笔记列表优先用「说要分享那一轮」定格的快照，没定格过（分享和搜索同一轮或压根没搜过）
  // 才用最终列表——两者此时是同一份。
  const xhsSession = buildXhsSessionPayload(
    directives, state.xhsShareNotes ?? build.xhsNotes, build.xhsXsecTokens);
  const finishMeta = directives.length > 0
    ? { directives, ...(xhsSession ? { xhsSession } : {}) }
    : undefined;
  // 角色决定这次不说（见 AMSG_SILENT_MARK）。标记出现在哪一轮都算数：说了不发就整条
  // 不发，标记旁边多写的话是它在解释自己为什么不说，不是要发给对方的。
  const declined = fullText.includes(AMSG_SILENT_MARK);
  const segments = declined ? [] : sanitizeIntoSegments(cleanedText);

  if (segments.length === 0) {
    // 没有正文就整条不发，这轮有没有副作用都一样。
    //
    // 空正文 push 的 banner body 也是空的：用户锁屏收到一条只有标题、正文空白的横幅，
    // 未读 +1，点进去 0 气泡。而订阅是按 userVisibleOnly:true 建的，用
    // notification.show:false 压掉横幅等于跟浏览器违约（Firefox 对不展示通知的 push 有
    // 配额、超了直接退订，iOS 可能撤权限，且都是静默发生），所以「发但不弹」也不是出路。
    //
    // 只有副作用标签、没有正文时同样放弃：角色一个字没说却在小红书点了赞、写了日记，
    // 用户看到的是「ta 什么都没说但做了事」，本身就穿帮。后台产生的副作用该等客户端
    // 上线时主动拉，不塞进一条没内容的推送里（amsg-sw README 里也是这个结论）。
    //
    // 日程改动是这条规矩里唯一的例外，单拎出来交给调用方走 emitResult。它不是做给用户
    // 看的动作，是角色在纠正自己的表：一起丢掉的话，下一次 fire 读到的还是那条旧安排，
    // 角色会反复想改又反复改不掉，用户那边则永远看到表和角色说的话对不上。emitResult
    // 落的是服务端收件箱，不占聊天正文，也不用为它硬发一条空推送。
    const scheduleChanges = directives
      .filter((d): d is Extract<Directive, { type: 'change_schedule' }> => d.type === 'change_schedule')
      .map((d) => ({ startTime: d.time, activity: d.activity }));
    return {
      decision: 'skip-push',
      reason: declined ? 'declined' : finishMeta ? 'side-effects-only' : 'empty-generation',
      ...(!declined && directives.some(d => d.type !== 'change_schedule') && finishMeta ? { sideEffects: finishMeta } : {}),
      ...(scheduleChanges.length > 0 ? { scheduleChanges } : {}),
    };
  }

  // SAR 外显：角色模块 active 且模型给了 CHAR_SURFACE 时逐段对齐。对上的那条 push 挂
  // amsgSarSurface，横幅也换成外显——界面默认显示外显，锁屏不能把真意漏出去。
  const sarCharacter = build.sar?.character;
  const surfaceSlots = sarParse && sarCharacter?.phase === 'active'
    ? buildSarSurfaceSlots(sarParse, segments)
    : [];
  // 快照原样随最后一条回去（客户端靠它写事件、推进回合，余韵轮 / 没守信封也一样）；
  // 用户外显同样只挂最后一条，原文不解析。
  const sarLastMeta: Record<string, unknown> = {
    ...(build.sar ? { [AMSG_SAR_META_KEY]: build.sar } : {}),
    ...(sarParse?.userSurface ? { amsgSarUserSurface: sarParse.userSurface } : {}),
  };
  const lastMeta = finishMeta || Object.keys(sarLastMeta).length > 0
    ? { ...(finishMeta ?? {}), ...sarLastMeta }
    : undefined;

  const lastIdx = segments.length - 1;
  return {
    decision: 'finish',
    pushPayloads: segments.map((seg, i) => {
      const slot = surfaceSlots[i];
      const surfaceMeta = slot && sarCharacter
        ? createSARModuleSurfaceMeta(sarCharacter, slot.surface)
        : undefined;
      const extra: Record<string, unknown> = {
        ...(surfaceMeta ? { amsgSarSurface: surfaceMeta } : {}),
        ...(i === lastIdx ? (lastMeta ?? {}) : {}),
      };
      return buildScheduledPush(
        seg.raw,
        build,
        Object.keys(extra).length > 0 ? extra : undefined,
        // 外显横幅截短：这条 push 还要装外显 meta，别把单段正文的字节预算吃掉一半。
        surfaceMeta && slot ? clipSarSurfaceBanner(slot.banner) : seg.sanitized,
      );
    }),
  };
}

/**
 * 单段 → 老链路 scheduled push 形状（业务字段同 v1，可选多挂
 * metadata 追加键（directives / xhsSession）与 notification）。messageId/sessionId/
 * timestamp/messageIndex/totalMessages 由库的 sendHookPushPayloads 统一补齐/覆写。
 *
 * bannerBody = segment 的 sanitized 文本，塞进 notification.body 给 OS banner
 * 显示（[[SEND_EMOJI: x]] → [表情：x] 这类可读形态）；message 保留 raw 让客户端
 * applyAssistantPostProcessing 渲染卡片/表情。不带 notification.show —— SW 对
 * content push 的默认弹窗行为不变。
 */
function buildScheduledPush(
  message: string,
  build: PushBuildInput,
  extraMeta?: Record<string, unknown>,
  bannerBody?: string,
): Record<string, unknown> {
  const title = `来自 ${build.contactName}`;
  return {
    messageKind: 'content' as const,
    messageType: build.messageType,
    source: 'scheduled' as const,
    message,
    title,
    contactName: build.contactName,
    avatarUrl: build.avatarUrl,
    messageSubtype: 'chat',
    taskId: build.taskId,
    metadata: {
      // SAR 快照不许摊进每一条（它只随最后一条经 extraMeta 回去）；调用方已摘过，这里兜一道。
      ...stripSarSnapshot(build.metadata),
      amsgOccurrenceMs: build.occurrenceMs,
      ...(extraMeta ?? {}),
    },
    ...(bannerBody !== undefined ? { notification: { title, body: bannerBody } } : {}),
  };
}
