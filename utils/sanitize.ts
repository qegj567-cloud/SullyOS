import { deduplicateVoiceText } from './voiceTextDedup';
import {extractFriendFeedReplyTags} from './friendFeedReplyFormat';
/**
 * 共享 sanitize 工具 — 零依赖纯字符串处理.
 *
 * 两个 facade:
 *  - sanitizeForBubble(text, opts)  — chatParser.sanitize 的实现, 给客户端 13 步管线**预处理**用.
 *    保留 SEND_EMOJI / [html] / <翻译> / <think> / [[INNER_STATE:...]] 等标签, 因为
 *    applyAssistantPostProcessing Step 4 (think chain) / Step 5 (html card) /
 *    Step 8 (双语) / Step 9 (sticker) 还要靠这些标签接管.
 *  - sanitizeForNotification(text)  — worker push 之前的**终态**处理, 没有下游 step,
 *    所以剥得更彻底: think 块 / INNER_STATE 全删, SEND_EMOJI → [表情：名称],
 *    [html]...[/html] → [HTML 卡片], <翻译> 只保留原文, 链接 → [链接：text].
 *
 * 真理来源:
 *  - 共享底层规则: utils/chatParser.ts:sanitize 原版正则 (lines 207-252)
 *  - notification 专用 / Step 9-相关规则: utils/applyAssistantPostProcessing.ts:normalizeAiContent
 */

import { segmentTextWithProtectedBlocks } from '@rei-standard/amsg-instant';

// ─── 底层 helper (共享, 无歧义清理) ─────────────────────────────────────────

/** `\\n` 字面 → 真实换行. 必须先跑, 否则后续 ^ 行锚定失效. */
const stripLiteralBackslashN = (t: string): string => t.replace(/\\n/g, '\n');

/**
 * 历史来源标签 → 换行（保留分隔语义）。
 *
 * 历史原文只会注入 `[聊天]/[通话]/[约会]`，但模型偶尔会在模仿时把标签做成
 * 中英混写（线上实例如 `[聊chat]`），甚至直接翻成 `[chat]`。这些仍然是内部
 * 元数据，不该作为角色正文展示。只对白名单中的三组来源词做容错，避免吞掉普通
 * 方括号内容。
 */
export const stripLeakedSourceTags = (t: string): string => t.replace(
  /\s*\[\s*(?:聊\s*(?:天|chat)|chat|通\s*(?:话|call)|call|约\s*(?:会|date)|date)\s*\]\s*/giu,
  '\n',
);

/** 4 种时间格式: 带括号 ISO / 行首裸 ISO / 中文 12h / 英文 12h */
const stripTimestamps = (t: string): string =>
  t
    .replace(/\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/g, '')
    .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s*/gm, '')
    .replace(/（[上下]午\d{1,2}[：:]\d{2}）/g, '')
    .replace(/\(\d{1,2}:\d{2}\s*[AP]M\)/gi, '');

/** `[2024年5月20]` / `[2024/5/20...]` 中文或斜杠日期 (兼容 normalizeAiContent 的更宽松匹配) */
const stripChineseDate = (t: string): string => t.replace(/\[\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*?\]/g, '');

/**
 * 整个字符串首行的角色名 prefix `Sully:` / `User:` (无 m flag — 跟
 * applyAssistantPostProcessing.ts:normalizeAiContent 行为对齐).
 */
const stripRoleNamePrefix = (t: string): string => t.replace(/^[\w一-龥]+:\s*/, '');

/**
 * 业务标签 (ACTION / RECALL / SEARCH / DIARY / READ_DIARY / FS_DIARY / FS_READ_DIARY /
 * DIARY_START / DIARY_END / FS_DIARY_START / FS_DIARY_END / MUSIC_ACTION) + schedule_message.
 * 保持跟 chatParser.sanitize 原版字节对齐 — 不含 READ_NOTE / XHS_x (那些只在 notification 路径剥).
 */
const stripBusinessTagsForBubble = (t: string): string =>
  extractFriendFeedReplyTags(extractFriendFeedReplyTags(t).text,'HOME_VISIT_REPLY').text
    .replace(/\[\[(?:ACTION|RECALL|SEARCH|DIARY|READ_DIARY|FS_DIARY|FS_READ_DIARY|DIARY_START|DIARY_END|FS_DIARY_START|FS_DIARY_END|MUSIC_ACTION)[:\s][\s\S]*?\]\]/g, '')
    // `[[记录:...]]` 整个命名空间 —— 历史渲染形态 (utils/transferFormat.ts:formatTransferRecord),
    // 模型复读历史会抄出来。能还原成动作的 (记录:TRANSFER) 在上游 chatParser / worker classifier
    // 已被消费; 走到这里的一律是纯 leak, 不进气泡。全角冒号一并容 (模型手写变体)。
    // 对原版 chatParser.sanitize 是**有意**分叉 (C4 oracle 测的是 refactor 不漂移, 这条是新规则)。
    .replace(/\[\[\s*[记記][录錄]\s*[:：][\s\S]*?\]\]/g, '')
    .replace(/\[schedule_message[^\]]*\]/g, '');

/**
 * notification 路径专用 — 在 stripBusinessTagsForBubble 基础上额外剥 READ_NOTE / XHS_x /
 * LIFE / NEWS_CARD. 这些标签在 chatParser.sanitize 老路径里被保留 (downstream 由
 * applyAssistantPostProcessing / ChatParser.parseAndExecuteActions 重新扫描+执行),
 * 但 push notification 是终态, 不会再有 downstream, 所以剥得更狠.
 *
 * LIFE / NEWS_CARD 的副作用走 worker classifier 的 directive 通道 (SIDE_EFFECT_TAGS 里
 * 的 life_record / news_card), 跟 POKE / ADD_EVENT / DIARY 同一条路: 正文里剥光,
 * 结构化挂在最后一条 push 上, 客户端 reconstructDirectiveTags 拼回原 tag 执行。
 */
const stripBusinessTagsForNotification = (t: string): string =>
  stripBusinessTagsForBubble(t)
    .replace(/\[\[(?:READ_NOTE|XHS_[A-Z_]+|LIFE|NEWS_CARD)[:\s][\s\S]*?\]\]/g, '')
    .replace(/\[\[XHS_[A-Z_]+\]\]/g, '');

/**
 * 剥掉**所有** `[[...]]`, 不看标签名 —— 客户端 `chatParser.hasDisplayContent` 的口径.
 * 只在段级判空时用, 不参与正文清洗 (白名单之外的标签该不该留给客户端是另一件事).
 *
 * 存在的理由: 上面那两条白名单只认识约定好的标签, 模型现编的 `[[拥抱]]` 会原样留下来。
 * 客户端 hasDisplayContent 剥光一切 `[[...]]` 后判空, 这种段不落库; worker 这边却算它
 * 「有内容」照发一条 push —— 于是横幅响了一下、点进去一个气泡都没有。
 */
const stripAllDoubleBracketTags = (t: string): string => t.replace(/\[\[[\s\S]*?\]\]/g, '');

/** 引用类: `[[QUOTE|引用]] / [QUOTE|引用] / [回复 "..."] / 模仿历史渲染的 [xx引用了xx「…」…]` */
const stripQuotes = (t: string): string =>
  t
    .replace(/\[\[(?:QU[OA]TE|引用)[：:][\s\S]*?\]\]/g, '')
    .replace(/\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g, '')
    .replace(/\[回复\s*[""“][^""”]*?[""”](?:\.{0,3})\]\s*[：:]?\s*/g, '')
    // buildMessageHistory 把引用渲染成 [xx引用了xx说的「…」，并回复了 ↓]，模型会学这个格式输出。
    // 解析端 (applyAssistantPostProcessing QUOTE_RE_NL) 已把它认作引用，这里保证残留不漏进气泡/通知。
    .replace(/\[[^\[\]\n「」]{0,24}引用了[^\[\]\n「」]{0,24}「[^」\n]*?」[^\[\]\n]{0,24}\]\s*/g, '');

/**
 * 历史里的系统日志 leak — `[系统: ...]` / `[系统提示: ...]` / `[系统] ...` / `[System: ...]`。
 *
 * buildMessageHistory 把 transfer / interaction / 时间间隔提示都渲染成这个形态喂给模型
 * (`[系统: 你向xx转账 1999]`、`[系统: 用户戳了你一下]`、`[系统提示: 距离上一条消息: 3 小时]`),
 * 模型会照抄。这是**终线**: 能还原成动作的已经在上游被 chatParser (转账见
 * utils/transferFormat.ts) 认领走了, 走到这里的一律不该进气泡/通知。
 *
 * 加这条会让 sanitizeForBubble 跟 chatParser.sanitize 原版产生**有意的**行为分叉 ——
 * C4 oracle 测的是 refactor 不漂移, 这条是明确的新规则, 不属于漂移。
 */
const stripSystemLogLeak = (t: string): string =>
  t
    .replace(/[\[【]\s*(?:系统|系統|System)\s*(?:提示)?\s*[:：][^\[\]【】]*[\]】]\s*/gi, '')
    .replace(/\[\s*(?:系统|系統)\s*\]\s*/g, '');

/** markdown 标题 `# heading` → `heading` (保留文字) */
const stripMarkdownHeaders = (t: string): string => t.replace(/^#{1,6}\s+/gm, '');

/** markdown 加粗 `**bold**` → `bold` (聊天里粗体没用, 直接吃掉星号) */
const stripMarkdownBold = (t: string): string => t.replace(/\*{2,}/g, '');

/** `---` / 空 bullet 行 */
const stripMarkdownDividers = (t: string): string =>
  t.replace(/^\s*---\s*$/gm, '').replace(/^\s*[-*+]\s*$/gm, '');

/** backtick: 保留 ``` `[[...]]` ``` 内部, 剥 ``` `` ``` 和单 backtick */
const stripBackticks = (t: string): string =>
  t
    .replace(/`(\[\[[\s\S]*?\]\])`/g, '$1')
    .replace(/``+/g, '')
    .replace(/(^|\s)`(\s|$)/gm, '$1$2');

/** `%%TRANS%%...` 老翻译标记 (保留 `%%BILINGUAL%%` 跟 `<翻译>` XML) */
const stripLegacyTrans = (t: string): string => t.replace(/%%TRANS%%[\s\S]*/gi, '');

/** `\n{3,}` → `\n\n` + trim */
const collapseWhitespace = (t: string): string => t.replace(/\n{3,}/g, '\n\n').trim();

// ─── notification 专用 helper ──────────────────────────────────────────────

/** `<think|thinking|thought>...</...>` 整块, 含未闭合兜底 */
const stripThinkBlocks = (t: string): string =>
  t
    .replace(/<(think|thinking|thought)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:think|thinking|thought)>[\s\S]*$/gi, '');

/** `[[INNER_STATE:...]]` */
const stripInnerState = (t: string): string => t.replace(/\[\[INNER_STATE:\s*[\s\S]*?\]\]/g, '');

/** `[text](url)` → `[链接：text]` (全角冒号) */
const replaceMarkdownLinks = (t: string): string =>
  t.replace(/\[([^\]]+)\]\([^)]+\)/g, '[链接：$1]');

/**
 * `[[SEND_EMOJI: 名称]]` → `[表情：名称]`.
 * 全角冒号一并容 (`[[SEND_EMOJI：抱抱]]` 是中文输入法下的高频手写变体, 跟
 * `[[记录：...]]` 那条同一个理由)。
 */
const replaceSendEmoji = (t: string): string =>
  t.replace(/\[\[SEND_EMOJI[:：]\s*(.+?)\]\]/g, '[表情：$1]');

/** `[xxx 发送了表情包: 名称]` → `[表情：名称]` (直接转最终展示, 跳过 SEND_EMOJI 中间形态) */
const replaceEmojiReverseTag = (t: string): string =>
  t.replace(/\[(?:你|User|用户|System|[\w一-龥]+)\s*发送了表情包[:：]\s*(.*?)\]/g, '[表情：$1]');

/** `[html]...[/html]` → `[HTML 卡片]` */
const replaceHtmlBlocks = (t: string): string =>
  t.replace(/\[html\][\s\S]*?\[\/html\]/gi, '[HTML 卡片]');

/** `<翻译>...</翻译>` → `<原文>` 内容 (banner 用; segment 路径里有专门 sentinel 保护跳过这条) */
const replaceTranslationForBanner = (t: string): string =>
  t
    .replace(/<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>[\s\S]*?<\/译文>\s*<\/翻译>/g, '$1')
    .replace(/<译文>[\s\S]*?<\/译文>/g, '')
    .replace(/<\/?(?:翻译|原文)>/g, '');

/** `<语音>...</语音>(<字幕>...</字幕>)` → 字幕优先、否则语音内文 (banner 用;
 *  segment 路径里有 sentinel 保护跳过这条)。闭合容许空格/简繁互换。 */
const replaceVoiceForBanner = (t: string): string =>
  t
    .replace(
      /(?:<字幕>([\s\S]*?)<\/字幕>\s*)?<[语語]音[^>]*>([\s\S]*?)<\/\s*[语語]音\s*>(?:\s*<字幕>([\s\S]*?)<\/字幕>)?/g,
      (_m, pre, inner, post) => ((post || pre || inner || '') as string).trim(),
    )
    .replace(/<字幕>([\s\S]*?)<\/字幕>/g, '$1')  // 落单字幕块: 剥标签留中文
    .replace(/<\/?字幕>/g, '');

// ─── 语音标签规整 (掉格式自愈) ──────────────────────────────────────────────

/**
 * 单个标签家族的配对修复扫描: 孤儿闭合删除、嵌套多余开标签删除、自闭合空标签删除、
 * 未闭合开标签在末尾补闭合。
 * closeBeforeTrailingSubtitle: 补语音闭合时, 若末尾跟着完整 <字幕> 块, 闭合插在字幕
 * 之前 —— 否则字幕会被吞进语音块里被朗读出来。
 */
function repairPairedTag(
  text: string,
  tokenRe: RegExp,
  closeFormOf: (openTok: string) => string,
  closeBeforeTrailingSubtitle: boolean,
): string {
  const kept: string[] = [];
  let cursor = 0;
  let openForm: string | null = null;
  let tok: RegExpExecArray | null;
  while ((tok = tokenRe.exec(text)) !== null) {
    const isClose = tok[0].startsWith('</');
    if (!isClose && /\/\s*>$/.test(tok[0])) {
      // 自闭合空标签: 无意义, 直接删 (别让配对逻辑把后文全吞进去)
      kept.push(text.slice(cursor, tok.index));
      cursor = tok.index + tok[0].length;
      continue;
    }
    if (isClose) {
      if (openForm === null) {
        // 孤儿闭合: 删除
        kept.push(text.slice(cursor, tok.index));
        cursor = tok.index + tok[0].length;
      } else {
        openForm = null; // 正常配对
      }
    } else if (openForm !== null) {
      // 块内又出现开标签 (嵌套/复读): 删掉多余的这个
      kept.push(text.slice(cursor, tok.index));
      cursor = tok.index + tok[0].length;
    } else {
      openForm = closeFormOf(tok[0]);
    }
  }
  kept.push(text.slice(cursor));
  let result = kept.join('');
  if (openForm !== null) {
    const closeTag = `</${openForm}>`;
    if (closeBeforeTrailingSubtitle) {
      const trail = result.match(/(\s*<字幕>[\s\S]*?<\/字幕>\s*)$/);
      if (trail) {
        const at = result.length - trail[0].length;
        return result.slice(0, at).replace(/\s+$/, '') + closeTag + trail[0].replace(/\s+$/, '');
      }
    }
    result = result.replace(/\s+$/, '') + closeTag;
  }
  return result;
}

/**
 * 把 LLM 写歪的 <语音> / <字幕> 标签修回规范形态, 让下游所有配对正则 (chunkText
 * 原子块保护 / MessageItem hasVoiceTag / parseVoiceOutput / worker Phase 1.5) 都能命中。
 * 落库前跑一次 (sanitizeForBubble / sanitizeIntoSegments), 下游不用各自容错。
 *
 * 修复的形态 (全部来自真实掉格式报告):
 *  1. 全角尖括号:  ＜语音＞…＜/语音＞ / ＜／字幕＞     → <语音>…</语音> / </字幕>
 *  2. 闭合标签内空格 / 全角斜杠: </ 语音 > / <／字幕>  → </语音> / </字幕>
 *  3. 开标签属性: <语音emotion=…> 少空格、全角引号 “” / 全角等号 ＝ → 规范属性
 *  4. 配对修复: 有开无闭 → 末尾补闭合 (语音的闭合会插在末尾完整 <字幕> 块之前);
 *     孤儿闭合 (无开) / 嵌套多余开标签 / 自闭合空标签 → 删除
 */
export function normalizeVoiceTags(t: string): string {
  if (!/[语語]音|字幕/.test(t)) return t; // fast path
  let result = t;
  // 1. 全角尖括号 → 半角 (只动语音/字幕标签本身, 不碰正文其他全角符号)
  result = result.replace(/＜\s*[/／]\s*([语語]音|字幕)\s*＞/g, '</$1>');
  result = result.replace(/＜\s*((?:[语語]音|字幕)[^<>＜＞]*?)\s*＞/g, '<$1>');
  // 2. 闭合标签规整: </ 语音 > / <／字幕> / < /语音> → </语音> 等
  result = result.replace(/<\s*[/／]\s*([语語]音|字幕)\s*>/g, '</$1>');
  // 3. 开标签属性规整: 少空格 / 全角引号 / 全角等号
  result = result.replace(/<([语語]音|字幕)\s*([^<>]*?)\s*>/g, (_m, tag: string, attrs: string) => {
    if (!attrs) return `<${tag}>`;
    const fixed = attrs.replace(/[“”＂]/g, '"').replace(/[‘’]/g, "'").replace(/＝/g, '=').trim();
    return `<${tag} ${fixed}>`;
  });
  // 4. 配对扫描: 先修语音 (闭合避让末尾字幕块), 再修字幕
  result = repairPairedTag(result, /<\/?[语語]音[^>]*>/g, tok => (/語/.test(tok) ? '語音' : '语音'), true);
  result = repairPairedTag(result, /<\/?字幕[^>]*>/g, () => '字幕', false);
  return result;
}

// ─── 翻译标签规整 (掉格式自愈) ──────────────────────────────────────────────

const simpTransTag = (tag: string): string => tag.replace(/譯/g, '译');

/**
 * 把 LLM 写歪的 <翻译>/<原文>/<译文> 标签修回规范形态
 * `<翻译><原文>X</原文><译文>Y</译文></翻译>`, 让下游所有严格配对正则
 * (applyAssistantPostProcessing Step 8 双语拆泡 / sanitizeIntoSegments Phase 1.5
 * 原子保护 / extractTranslationOriginal banner 提取) 都能命中。
 * 落库前跑一次 (三个 facade 都挂了), 下游不用各自容错。
 *
 * 修复的形态 (来自真实掉格式报告 —— 多模型多站点同时出现"掉格式"):
 *  1. 全角尖括号 / 全角斜杠 / 标签内空格 / 简繁互换: ＜／譯文＞ → </译文>
 *  2. 截断标签少写 `>`: 行尾/文尾/紧贴下一标签的 `</译文` → `</译文>` (截图报告形态)
 *  3. 配对修复: 有开无闭 → 末尾补闭合; 孤儿闭合 / 嵌套重复开标签 / 自闭合 → 删除
 *  4. 结构自愈 → 规范块:
 *     - 缺外层包裹 / 缺 </翻译>: `<原文>X</原文><译文>Y</译文>` → 补齐 <翻译> 包裹
 *     - sibling 幻觉: `<翻译>X</翻译><译文>Y</译文>` → 规范块
 *       (extractTranslationOriginal 注释里记录的已知形态)
 *  5. 兜底不变量: 自愈后文本里只允许存在规范完整块 —— 仍配不成对的翻译标签
 *     全部剥除、正文保留 (宁可退化成普通气泡, 也绝不把 `</译文` 这类破标签漏给用户)。
 */
export function normalizeTranslationTags(t: string): string {
  if (!/[<＜]\s*[/／]?\s*(?:翻[译譯]|原文|[译譯]文)/.test(t)) return t; // fast path
  let result = t;
  // 1. 全角尖括号/斜杠 + 标签内空格 + 简繁 → 规范半角简体
  result = result.replace(/[<＜]\s*[/／]\s*(翻[译譯]|原文|[译譯]文)\s*[>＞]/g, (_m, tag) => `</${simpTransTag(tag)}>`);
  result = result.replace(/[<＜]\s*(翻[译譯]|原文|[译譯]文)\s*[>＞]/g, (_m, tag) => `<${simpTransTag(tag)}>`);
  // 2. 截断补全: 行尾/文尾/紧贴下一个 `<` 处少写 `>` (流截断 / 模型偷懒的高频形态)
  result = result.replace(
    /[<＜]\s*([/／]?)\s*(翻[译譯]|原文|[译譯]文)\s*(?=$|\n|[<＜])/g,
    (_m, slash, tag) => `<${slash ? '/' : ''}${simpTransTag(tag)}>`,
  );
  // 3. 配对修复: 先内层 (原文/译文) 再外层 (翻译), 未闭合开标签才能按嵌套顺序补对
  result = repairPairedTag(result, /<\/?原文[^>]*>/g, () => '原文', false);
  result = repairPairedTag(result, /<\/?译文[^>]*>/g, () => '译文', false);
  result = repairPairedTag(result, /<\/?翻译[^>]*>/g, () => '翻译', false);
  // 4. 结构自愈。先把本来就规范的完整块 (多行/紧凑都算) 用占位符护住原样保留,
  //    只对剩余的掉格式残局做规范化重写。
  const HOLD = String.fromCharCode(3);
  const blocks: string[] = [];
  const hold = (m: string): string => { blocks.push(m); return `${HOLD}${blocks.length - 1}${HOLD}`; };
  result = result.replace(/<翻译>\s*<原文>[\s\S]*?<\/原文>\s*<译文>[\s\S]*?<\/译文>\s*<\/翻译>/g, hold);
  // 4a. 配好的 原文+译文 对 (外层 <翻译> 包裹缺失/只剩半边) → 规范块
  result = result.replace(
    /(?:<翻译>\s*)?<原文>([\s\S]*?)<\/原文>\s*<译文>([\s\S]*?)<\/译文>\s*(?:<\/翻译>)?/g,
    (_m, a: string, b: string) => hold(`<翻译><原文>${a.trim()}</原文><译文>${b.trim()}</译文></翻译>`),
  );
  // 4b. sibling 幻觉形态 <翻译>X</翻译><译文>Y</译文> → 规范块
  result = result.replace(
    /<翻译>\s*(?!<原文>)((?:(?!<\/?翻译>)[\s\S])*?)<\/翻译>\s*<译文>([\s\S]*?)<\/译文>/g,
    (_m, a: string, b: string) => hold(`<翻译><原文>${a.trim()}</原文><译文>${b.trim()}</译文></翻译>`),
  );
  // 5. 兜底不变量: 规范块之外不允许残留任何翻译标签。
  //    配不成对的 <译文> 整块是重复的目标语内容 —— 按 extractTranslationOriginal
  //    既有策略整块丢弃; 其余散标签 (全角/截断/贴字) 剥掉标签保留正文。
  result = result.replace(/<译文>[\s\S]*?<\/译文>/g, '');
  result = result.replace(/[<＜]\s*[/／]?\s*(?:翻[译譯]|原文|[译譯]文)\s*[>＞]?/g, '');
  result = result.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_m, n) => blocks[Number(n)] || '');
  return result;
}

/**
 * 翻译块只保留原文.
 *
 * 两种格式都处理:
 *  - 规范 (chatRequestPayload.ts prompt 教 LLM 用的): `<翻译><原文>X</原文><译文>Y</译文></翻译>` → `X`
 *  - LLM 幻觉常见错误:                                  `<翻译>X</翻译><译文>Y</译文>`             → `X`
 *
 * 第二种 LLM 偶尔会写, 严格 regex 不命中就会让 banner 上漏出原始 `<翻译>` 标签字符.
 * 处理顺序: 先吃规范形态, 再兜底吃 `<译文>` 整块 + 残留的 `<翻译>` / `<原文>` 标签.
 */
const extractTranslationOriginal = (t: string): string => {
  let result = t.replace(
    /<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>[\s\S]*?<\/译文>\s*<\/翻译>/g,
    '$1',
  );
  // 兜底: 先剥光 <译文>...</译文> 整块 (LLM 直接 sibling tag 的形态), 再剥残留的开/闭合标签
  result = result.replace(/<译文>[\s\S]*?<\/译文>/g, '');
  result = result.replace(/<\/?(?:翻译|原文)>/g, '');
  return result;
};

// ─── facade 高层 API ───────────────────────────────────────────────────────

/**
 * worker push notification.body 终态处理:
 *  - 剥光 <think> / INNER_STATE / 业务标签 / 引用 / 时间戳 / 历史 leak
 *  - 替换 SEND_EMOJI / [html] / [text](url) 为可读 placeholder
 *  - <翻译> 只保留原文
 *
 * 顺序很重要 — 见处理顺序注释.
 */
export function sanitizeForNotification(text: string): string {
  let result = text;
  // 1. 字面 \n 还原 — 否则后续 ^ 锚定失效
  result = stripLiteralBackslashN(result);
  // 2. think 块最早剥 — 里面可能含其他 tag 影响后续匹配
  result = stripThinkBlocks(result);
  // 3. HTML 块替换 — 内部 markdown/tag 不应被处理
  result = replaceHtmlBlocks(result);
  // 4. 反向 emoji tag 先于正向 SEND_EMOJI (反向可能也走 SEND_EMOJI 重写, 但这里直接转最终展示)
  result = replaceEmojiReverseTag(result);
  result = replaceSendEmoji(result);
  // 5. 翻译块保留原文剥译文 (先自愈掉格式的标签, 严格提取正则才能命中)
  result = normalizeTranslationTags(result);
  result = extractTranslationOriginal(result);
  // 6. LLM mimicking 历史的 leak: 时间戳 / 日期 / 角色名 prefix / 系统日志
  result = stripTimestamps(result);
  result = stripChineseDate(result);
  result = stripRoleNamePrefix(result);
  result = stripSystemLogLeak(result);
  // 7. 源标签 [聊天] 等
  result = stripLeakedSourceTags(result);
  // 8. 内部状态 / 业务标签 / 引用
  result = stripInnerState(result);
  result = stripBusinessTagsForNotification(result);
  result = stripQuotes(result);
  // 9. 链接 → [链接：text] (必须先于 markdown header/bold strip, 避免 [text](url) 内的 # 被误剥)
  result = replaceMarkdownLinks(result);
  // 10. markdown 修饰
  result = stripMarkdownHeaders(result);
  result = stripMarkdownBold(result);
  result = stripMarkdownDividers(result);
  // 11. backtick
  result = stripBackticks(result);
  // 12. 老翻译标记
  result = stripLegacyTrans(result);
  // 13. 空白收尾
  result = collapseWhitespace(result);
  return result;
}

/**
 * chatParser.sanitize 实现 — 客户端 13 步管线**预处理**.
 *
 * 跟 sanitizeForNotification 的差异:
 *  - 保留 SEND_EMOJI / [html] / <翻译> / <think> / [[INNER_STATE:...]] (后续 step 接管)
 *  - 保留 markdown 链接 text(url) (chatParser 老行为是只剥 url 留 text, 这里也保持一致)
 *  - keepCitations 选项控制 `[[QUOTE|引用]]` 是否保留 (chunking 用)
 */
export function sanitizeForBubble(
  text: string,
  options?: { keepCitations?: boolean },
): string {
  let result = text;
  // 1. 字面 \n 还原
  result = stripLiteralBackslashN(result);
  // 1.5. 语音/翻译标签自愈 — 必须在 chunkText 之前 (下游原子块保护 /
  //      applyAssistantPostProcessing Step 8 双语拆泡都靠严格配对正则)
  result = normalizeVoiceTags(result);
  result = normalizeTranslationTags(result);
  // 2. 源标签 / 时间戳 / 系统日志 leak / 业务标签
  result = stripLeakedSourceTags(result);
  result = stripTimestamps(result);
  result = stripSystemLogLeak(result);
  result = stripMarkdownHeaders(result);
  result = stripBusinessTagsForBubble(result);
  if (!options?.keepCitations) {
    result = stripQuotes(result);
  }
  // 3. backtick / markdown link (chatParser 老行为: 剥 url 留 text)
  result = stripBackticks(result);
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // 4. markdown bold / dividers
  result = stripMarkdownBold(result);
  result = stripMarkdownDividers(result);
  // 5. 老翻译标记
  result = stripLegacyTrans(result);
  // 6. 收尾
  result = deduplicateVoiceText(result);
  result = collapseWhitespace(result);
  return result;
}

// ─── Segments API (amsg-instant 0.8+ pushPayloads) ─────────────────────────

/**
 * 一段内容 → 一条 push.
 *  - `raw`: 给客户端 `message` 字段, 保留 SEND_EMOJI / [html] / <翻译> / <语音> /
 *           [[QUOTE|引用]] 等业务标签让 applyAssistantPostProcessing Step 5/7/8/9 +
 *           Chat.tsx extractVoiceTag 正确接管 (HTML 卡 / 引用回复 / 双语气泡 / sticker / 语音条)
 *  - `sanitized`: 给 `notification.body`, OS banner 显示用的可读 placeholder
 *
 * 两个字段在大多数 chunk 上是一样的 (普通文本); 只有原子单元 (SEND_EMOJI / [html] /
 * <翻译> / <语音>) 时两者才分叉.
 */
export interface Segment {
  raw: string;
  sanitized: string;
}

interface ProtectedAtomSegment {
  raw: string;
  sanitized: unknown;
  protect: boolean;
}

/**
 * worker push notification + bubble 共用的分段器.
 *
 * 算法:
 *  1. Phase 1   — 全文 strip suppress content (think 块 / INNER_STATE / 业务标签 /
 *                  时间戳 leak / source tag / 历史 leak / divider / 老 trans). 必须先全文
 *                  跑, 因为 think 跨多行, 单行 chunk 看不到完整块.
 *  1.5. Phase 1.5 — 用 amsg-instant 标准保护分段器识别客户端要二次消费的"原子语义块",
 *                   防止 chunkText 按 \n 把它们切碎: [html]...[/html] / <翻译>...</翻译> /
 *                   <语音>...</语音>. 保护块两侧按旧逻辑补 \n, 让 chunkText 必把它独立成 chunk.
 *  2. Phase 2   — chunkText: 只按显式换行切, 跟客户端 `chatParser.chunkText`
 *                  字节对齐 (普通空格属于正文, 不能把中日混排的一句话拦腰拆开).
 *  3. Phase 3   — 还原占位符 (独占 chunk → 直接成单 segment; 同行 inline → 替换回原文 +
 *                  banner 兜底). 每个文字 chunk 内拆 SEND_EMOJI 独立成段, 文字段跑
 *                  banner-only 替换 (markdown link / [html] / markdown header/bold/backtick /
 *                  引用 / <翻译> / <语音>).
 *
 * 不切句号 — 客户端 chunkText 也不切, 保持气泡数 == banner 数.
 *
 * 引用 ([[QUOTE|引用]] / [回复 "..."]) 跟 SEND_EMOJI 一样**不**剥, 留给客户端
 * applyAssistantPostProcessing Step 7 / per-chunk QUOTE_RE 配对设置 aiReplyTarget.
 * banner 那边在 sanitizeTextForBanner 里单独剥, 保证通知干净.
 *
 * 返回空数组的情况: LLM 整段输出 sanitize 完只剩 think / 业务标签 / 空白 — 此时
 * 不发任何 banner / bubble (skip-push 语义).
 */
export function sanitizeIntoSegments(text: string): Segment[] {
  // Phase 1: 全文 suppress
  let cleaned = stripLiteralBackslashN(text);
  cleaned = stripThinkBlocks(cleaned);
  cleaned = deduplicateVoiceText(normalizeVoiceTags(cleaned)); // 语音标签自愈 — Phase 1.5 的配对保护靠它兜底
  cleaned = normalizeTranslationTags(cleaned); // 翻译标签自愈 — 同上, Phase 1.5 的 <翻译> 原子保护靠它命中

  // Phase 1.5: 原子语义块交给 amsg-instant 标准 protected-block splitter 识别,
  // 再桥回旧 pipeline。这样只替换"如何保护原子块", 不改变后续清洗/分段语义。
  const ATOM_MARKER = String.fromCharCode(2);
  const atomBlocks: Segment[] = [];
  const atomSegments = segmentTextWithProtectedBlocks(cleaned, {
    splitText: (plainText: string) => [plainText],
    protectedPatterns: [
      {
        pattern: /\[html\][\s\S]*?\[\/html\]/i,
        preview: '[HTML 卡片]',
      },
      {
        pattern: /<翻译>\s*<原文>([\s\S]*?)<\/原文>\s*<译文>[\s\S]*?<\/译文>\s*<\/翻译>/,
        preview: (_raw: string, match: RegExpMatchArray) => (match[1] || '').trim() || '[翻译]',
      },
      {
        // 语音块 + 紧邻的 <字幕> 块是一个原子单元 (字幕是这条语音的中文对照, 拆开
        // 就配不上了)。字幕前置/后置都容忍; banner 预览优先用字幕 (用户读得懂中文)。
        // 闭合容许空格 + 简繁互换 (normalizeVoiceTags 已修, 这里不再依赖 \1 回引)。
        pattern: /(?:<字幕>([\s\S]*?)<\/字幕>\s*)?<[语語]音[^>]*>([\s\S]*?)<\/\s*[语語]音\s*>(?:\s*<字幕>([\s\S]*?)<\/字幕>)?/,
        preview: (_raw: string, match: RegExpMatchArray) =>
          (match[3] || match[1] || match[2] || '').trim() || '[语音]',
      },
    ],
  }) as ProtectedAtomSegment[];
  cleaned = atomSegments.map((seg) => {
    if (!seg.protect) return seg.raw;
    const idx = atomBlocks.length;
    atomBlocks.push({
      raw: seg.raw,
      sanitized: typeof seg.sanitized === 'string'
        ? seg.sanitized
        : sanitizeTextForBanner(seg.raw),
    });
    return `\n${ATOM_MARKER}B${idx}${ATOM_MARKER}\n`;
  }).join('');

  cleaned = extractTranslationOriginal(cleaned); // 兜底吃残留的 <译文> / <翻译> 标签
  cleaned = stripInnerState(cleaned);
  cleaned = stripBusinessTagsForNotification(cleaned);
  cleaned = stripTimestamps(cleaned);
  cleaned = stripChineseDate(cleaned);
  cleaned = stripRoleNamePrefix(cleaned);
  cleaned = stripLeakedSourceTags(cleaned);
  // 注意: 这里**不**剥 stripQuotes — 引用要带到客户端让 Step 7 配 aiReplyTarget.
  // sanitizeTextForBanner 单独剥引用给 notification.
  //
  // 同理**不**剥 stripSystemLogLeak: 模型抄出来的 `[系统: ...]` 原样留在 raw 里带给客户端。
  // 转账那一类不靠这条路 (worker classifier 已在 directive 通道认领, 见 classifier.ts
  // extractTransferCommands —— 因为独占一行的日志块 banner 为空会被下面的 skip 规则整块丢掉),
  // 这里保留是为了让还没被认领的形态到得了客户端。banner 侧在 sanitizeTextForBanner 剥干净。
  cleaned = stripLegacyTrans(cleaned);
  cleaned = stripMarkdownDividers(cleaned);

  // Phase 2: chunk 跟客户端 chatParser.chunkText 同算法 (内联避免 import chatParser
  // 把 DB / React / Capacitor 依赖拖进 worker bundle)
  const rawChunks = chunkText(cleaned);

  // Phase 3: 还原原子块占位符 + 拆 SEND_EMOJI + banner-only 替换
  const SOLO_RE = new RegExp(`^${ATOM_MARKER}B(\\d+)${ATOM_MARKER}$`);
  const GLOBAL_RE = new RegExp(`${ATOM_MARKER}B(\\d+)${ATOM_MARKER}`, 'g');
  const segments: Segment[] = [];
  // 引用标签独占一行时 banner 侧会被 stripQuotes 剥空，整段丢掉的话 raw 里的引用也跟着没了,
  // 客户端就配不上 replyTo——而提示词教的写法（回复开头写 [[QUOTE:]]）产出的正是这种形态。
  // 所以攒着，拼到下一个文字段的 raw 开头，客户端照常解析。表情段不消费它：客户端那边
  // 表情气泡本来也不挂 replyTo，引用会继续顺延到后面的文字气泡。
  let pendingQuoteRaw = '';
  for (const rawChunk of rawChunks) {
    const soloMatch = rawChunk.trim().match(SOLO_RE);
    if (soloMatch) {
      const blk = atomBlocks[Number(soloMatch[1])];
      if (blk) segments.push({ raw: blk.raw, sanitized: blk.sanitized });
      continue;
    }
    const parts = splitOnSendEmoji(rawChunk);
    for (const part of parts) {
      if (part.kind === 'emoji') {
        segments.push({
          raw: `[[SEND_EMOJI: ${part.name}]]`,
          sanitized: `[表情：${part.name}]`,
        });
        continue;
      }
      // 安全网: 占位符跟正文同行 (chunkText 没拆开) 时把整块还原回 raw,
      // sanitized 路径 sanitizeTextForBanner 会再把 [html]/<翻译>/<语音>/引用 折成 placeholder.
      let rawText = part.text.replace(
        GLOBAL_RE,
        (_m, n) => atomBlocks[Number(n)]?.raw || '',
      );
      rawText = rawText.trim();
      if (!rawText) continue;
      const sanitized = sanitizeTextForBanner(rawText).trim();
      if (!sanitized) {
        // 只有剥掉引用就空了的段才留着顺延；别的剥空成因（纯系统日志 leak 之类）照旧丢。
        if (!stripQuotes(rawText).trim()) pendingQuoteRaw += `${rawText}\n`;
        continue;
      }
      // 再按客户端口径判一次空：剥光所有 `[[...]]` 后什么都不剩的段（模型现编的未知
      // 标签独占一行），客户端不会落成气泡，这边也就别发横幅——两端判空规则一致，
      // 横幅数才等于气泡数。攒着的引用不消费，会继续顺延到后面真有正文的那一段。
      if (!stripAllDoubleBracketTags(sanitized).trim()) continue;
      segments.push({
        raw: pendingQuoteRaw ? `${pendingQuoteRaw}${rawText}` : rawText,
        sanitized,
      });
      pendingQuoteRaw = '';
    }
  }
  return segments;
}

/**
 * 单个文字 chunk 的 banner-side 替换. 不动 raw 文字, 只产 sanitized 版本.
 * SEND_EMOJI 已经在 splitOnSendEmoji 阶段独立成段, 这里不处理.
 *
 * 注意: 引用 / <翻译> / <语音> 在 sanitizeIntoSegments Phase 1.5 protect 路径里
 * 已经被占位符兜走, 走到这里的只可能是同行 inline / 残留 / 老格式 — 这里全部
 * 强制剥成 banner 友好的形态, 保证通知干净.
 */
function sanitizeTextForBanner(text: string): string {
  let result = text;
  result = replaceHtmlBlocks(result);            // [html]...[/html] → [HTML 卡片]
  result = replaceTranslationForBanner(result);  // <翻译>...</翻译> → 原文
  result = replaceVoiceForBanner(result);        // <语音>...</语音> → 内部文字
  result = stripQuotes(result);                  // 引用 / 回复 → ''
  result = stripSystemLogLeak(result);           // [系统: 你向xx转账 1999] 等历史日志 leak → ''
  result = replaceEmojiReverseTag(result);       // [xxx 发送了表情包: yyy] → [表情：yyy]
  result = replaceMarkdownLinks(result);         // [text](url) → [链接：text]
  result = stripMarkdownHeaders(result);
  result = stripMarkdownBold(result);
  result = stripBackticks(result);
  result = collapseWhitespace(result);
  return result;
}

/**
 * `chatParser.chunkText` 的无依赖版本. 行为字节对齐:
 *  1. 只按显式换行符切 (\n / \r\n / \r /   /  )
 *  2. trim + filter empty；行内普通空格原样保留
 */
function chunkText(text: string): string[] {
  return text.split(/(?:\r\n|\r|\n|\u2028|\u2029)+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * 把 chunk 里的 `[[SEND_EMOJI: 名称]]` 拆出来当独立 part. 跟客户端
 * `chatParser.splitResponse` 行为对齐 (输出 shape 不同, 这里用 kind 字段区分).
 *
 * 冒号容全角 (`[[SEND_EMOJI：抱抱]]`): 拆出来后 raw 按半角规范形态重写, 客户端拿到的
 * 永远是它认得的那一种。不容的话这段会当普通文字走下去, banner 上直接是裸标签。
 */
function splitOnSendEmoji(chunk: string): Array<
  | { kind: 'text'; text: string }
  | { kind: 'emoji'; name: string }
> {
  const re = /\[\[SEND_EMOJI[:：]\s*(.*?)\]\]/g;
  const parts: Array<{ kind: 'text'; text: string } | { kind: 'emoji'; name: string }> = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ kind: 'text', text: chunk.slice(lastIndex, m.index) });
    }
    parts.push({ kind: 'emoji', name: m[1].trim() });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < chunk.length) {
    parts.push({ kind: 'text', text: chunk.slice(lastIndex) });
  }
  if (parts.length === 0 && chunk) parts.push({ kind: 'text', text: chunk });
  return parts;
}
