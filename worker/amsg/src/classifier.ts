/**
 * amsg worker 服务端工具循环用的 SullyOS 业务标签分类器（调用方见 ./agentic.ts 的 processLLMRound）。
 *
 * 扫一轮 LLM 输出，判定：
 *   - 数据标签 (RECALL / SEARCH / READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*) →
 *     tool-request: 截出标签之前的 prefix, 并把标签转成 toolCalls, 由 worker 的
 *     executeToolCalls 就地执行后进下一轮.
 *   - 副作用标签 (ACTION:POKE / TRANSFER / ADD_EVENT / MUSIC_ACTION / XHS_LIKE /
 *     XHS_FAV / XHS_COMMENT / XHS_REPLY / XHS_POST / XHS_SHARE / schedule_message /
 *     DIARY / FS_DIARY / LIFE / NEWS_CARD) →
 *     finish + directive metadata. worker 识别但不执行, 客户端 applyAssistantPostProcessing
 *     看到 directives 非空时只重放、不再扫原文.
 *   - 其他 (结构型 + 纯文本) → finish, 原文给客户端 13 步管线消化.
 *
 * 同时返回 sanitizedBody / sanitizedPrefix — push notification.body 终态文本.
 * 跟 message 原文不重叠时由 onLLMOutput 条件塞进 payload.notification.body.
 *
 * 故意没有任何 sullyOS 业务执行逻辑 — 这层只做"看见什么标签 → 出什么 decision".
 * tool 实际跑在 utils/agenticTools.ts (worker 里经 dispatchAgenticTool 调用),
 * directive 实际重放在 utils/directiveReplayer.ts (客户端).
 *
 * 把分类逻辑放独立文件方便单测 (不需要起整个 cf adapter).
 */

import { sanitizeForNotification } from '../../../utils/sanitize';
import { extractTransferCommands, parseTransferAmount } from '../../../utils/transferFormat';
import { extractScheduleChangeDirectives } from '../../../utils/scheduleChangeParse';

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/**
 * MUSIC_ACTION 说的是哪一首歌 —— 标签语法里只有歌单名，带不动歌名。
 *
 * classifier 自己永远不产这个字段（它只看得到正文，看不到角色此刻在听什么）。填它的是
 * 主动消息 2.0 的 worker：到点渲染「你此刻在听：《X》」的时候顺手把 X 冻进来，客户端
 * 重放时才知道角色说的是哪首（见 worker/amsg/src/agentic.ts 的 attachSceneSong）。
 * 没填的时候（比如本地聊天），客户端取「用户此刻在听的那首」。
 */
export interface MusicActionSong {
  /** 歌曲 id；从角色歌单抽出来的都有，缺了就只能按名字对。 */
  id?: number;
  name: string;
  artists: string;
}

export type Directive =
  | { type: 'poke' }
  | { type: 'transfer'; amount: number }
  // 角色收下 / 退回用户那笔待处理转账。老实现没把这两个标签列进 SIDE_EFFECT_TAGS,
  // 它们留在正文里被 sanitize 剥成空块然后整块丢掉 —— push 路径上收/退根本不生效。
  | { type: 'transfer_accept' }
  | { type: 'transfer_return' }
  | { type: 'add_event'; title: string; date: string }
  // 角色改自己今天的日程 [[ACTION:CHANGE_SCHEDULE | 22:00 | 陪你聊天]]。不在 SIDE_EFFECT_TAGS
  // 里而走旁路，理由同转账：解析要认中文别名 / 全角标点 / 漏括号那一堆写法，那份容错
  // 跟客户端共用一份源码（utils/scheduleChangeParse）。
  | { type: 'change_schedule'; time: string; activity: string }
  | { type: 'schedule_message'; time: string; text: string }
  // song 是可选的后补字段（见 MusicActionSong），只有主动消息 2.0 的定时路径会填。
  | { type: 'music_action'; verb: string; args: string[]; song?: MusicActionSong }
  | { type: 'xhs_like'; noteId: string }
  | { type: 'xhs_fav'; noteId: string }
  | { type: 'xhs_comment'; noteId: string; text: string }
  | { type: 'xhs_reply'; noteId: string; commentId: string; text: string }
  | { type: 'xhs_post'; title: string; content: string; tags: string }
  | { type: 'xhs_share'; idx: number }
  // 生活记录代记 [[LIFE:MED|布洛芬]] / [[LIFE:PERIOD_START]] / [[LIFE:EXPENSE|38|打车]] ...
  // body = 冒号后的整段原文, 客户端拼回原 tag 交给 lifeRecords.executeLifeDirectives 解析,
  // 开关校验 / 去重 / 写库都在那边, 这里不拆字段。
  | { type: 'life_record'; body: string }
  // 分享热点卡片 [[NEWS_CARD: 来源|标题]] (来源可省略). body 原样带走, 客户端按 `|` 切。
  | { type: 'news_card'; body: string }
  // 写日记: 短形态 [[DIARY: title|content]] 或长形态 [[DIARY_START: title|mood]]\n content \n[[DIARY_END]],
  // 飞书同形态 (FS_ 前缀). title 可空 → 客户端兜底用 `${char.name}的日记 - M/D`. mood 可空.
  | { type: 'notion_write_diary'; title: string; content: string; mood?: string }
  | { type: 'feishu_write_diary'; title: string; content: string; mood?: string };

export type ClassificationResult =
  | {
      kind: 'tool-request';
      /** 用户可见的前置 narration (剥掉了数据标签); 可能为空串 */
      prefix: string;
      /**
       * sanitizeForNotification(prefix). 给 push notification.body 用 — 业务标签 /
       * markdown / 时间戳 leak 都剥光. 跟 prefix 字节相同时 onLLMOutput 不重复塞,
       * 节省 payload size.
       */
      sanitizedPrefix: string;
      toolCalls: ToolCall[];
    }
  | {
      kind: 'finish';
      /** 剥光数据标签 + 副作用标签后的纯文本; 给客户端管线消化 */
      cleanedText: string;
      /**
       * sanitizeForNotification(cleanedText). 给 push notification.body 用. 见
       * sanitizedPrefix 注释 — 同样的"跟 cleanedText 相同则不塞"逻辑.
       */
      sanitizedBody: string;
      directives: Directive[];
    };

// ── 数据型 (tool-request) ────────────────────────────────────────────────

interface DataTagSpec {
  /** 全局正则; 一定要带 g flag 才能 matchAll 出多个调用 */
  re: RegExp;
  toolName: string;
  /** 把单条 match 转成 args 对象; 返回 null 跳过这条 (兼容降级) */
  toArgs: (m: RegExpMatchArray) => Record<string, unknown> | null;
}

const DATA_TAGS: DataTagSpec[] = [
  // [[RECALL: 2024-05]] / [[RECALL: 2024年5]]
  {
    re: /\[\[RECALL:\s*(\d{4})[-/年](\d{1,2})\]\]/g,
    toolName: 'recall',
    toArgs: (m) => ({ year: m[1], month: m[2].padStart(2, '0') }),
  },
  // [[SEARCH: query]]
  {
    re: /\[\[SEARCH:\s*(.+?)\]\]/g,
    toolName: 'web_search',
    toArgs: (m) => ({ query: m[1].trim() }),
  },
  // [[READ_DIARY: 2024-05-19]] / [[READ_DIARY: 今天]]
  {
    re: /\[\[READ_DIARY:\s*(.+?)\]\]/g,
    toolName: 'notion_read_diary',
    toArgs: (m) => ({ date: m[1].trim() }),
  },
  // [[FS_READ_DIARY: 2024-05-19]]
  {
    re: /\[\[FS_READ_DIARY:\s*(.+?)\]\]/g,
    toolName: 'feishu_read_diary',
    toArgs: (m) => ({ date: m[1].trim() }),
  },
  // [[READ_NOTE: keyword]]
  {
    re: /\[\[READ_NOTE:\s*(.+?)\]\]/g,
    toolName: 'read_note',
    toArgs: (m) => ({ keyword: m[1].trim() }),
  },
  // [[XHS_SEARCH: keyword]]
  {
    re: /\[\[XHS_SEARCH:\s*(.+?)\]\]/g,
    toolName: 'xhs_search',
    toArgs: (m) => ({ keyword: m[1].trim() }),
  },
  // [[XHS_BROWSE]] / [[XHS_BROWSE: category]]
  {
    re: /\[\[XHS_BROWSE(?::\s*(.+?))?\]\]/g,
    toolName: 'xhs_browse',
    toArgs: (m) => (m[1] ? { category: m[1].trim() } : {}),
  },
  // [[XHS_DETAIL: noteId]]
  {
    re: /\[\[XHS_DETAIL:\s*(.+?)\]\]/g,
    toolName: 'xhs_detail',
    toArgs: (m) => ({ noteId: m[1].trim() }),
  },
  // [[XHS_MY_PROFILE]]
  {
    re: /\[\[XHS_MY_PROFILE\]\]/g,
    toolName: 'xhs_my_profile',
    toArgs: () => ({}),
  },
];

export const DATA_TOOL_NAMES = Object.freeze([...new Set(DATA_TAGS.map(spec => spec.toolName))]);

// ── 副作用型 (finish + directives) ───────────────────────────────────────

interface SideEffectSpec {
  re: RegExp;
  toDirective: (m: RegExpMatchArray) => Directive | null;
}

const SIDE_EFFECT_TAGS: SideEffectSpec[] = [
  // [[ACTION:POKE]]
  {
    re: /\[\[ACTION:POKE\]\]/g,
    toDirective: () => ({ type: 'poke' }),
  },
  // 转账 (TRANSFER / TRANSFER_ACCEPT / TRANSFER_RETURN) 不在这张表里 —— 见 classifyLLMOutput
  // 里的 extractTransferCommands, 那份解析跟客户端共用一份源码, 且要认模仿历史日志的口语形态。
  // [[ACTION:ADD_EVENT|title|date]]
  {
    re: /\[\[ACTION:ADD_EVENT\s*\|\s*(.*?)\s*\|\s*(.*?)\]\]/g,
    toDirective: (m) => ({ type: 'add_event', title: m[1], date: m[2] }),
  },
  // [schedule_message | time | fixed | text]  (note: 单方括号, 跟原 chatParser 一致)
  {
    re: /\[schedule_message\s*\|\s*(.+?)\s*\|\s*fixed\s*\|\s*(.+?)\]/g,
    toDirective: (m) => ({ type: 'schedule_message', time: m[1], text: m[2] }),
  },
  // [[MUSIC_ACTION:verb]] 或 [[MUSIC_ACTION:verb|arg1|arg2]]
  {
    re: /\[\[MUSIC_ACTION:(join|add|add_new|join_and_add|join_and_add_new)(?:\|([^\]]*))?\]\]/g,
    toDirective: (m) => ({
      type: 'music_action',
      verb: m[1],
      args: m[2] ? m[2].split('|').map((s) => s.trim()) : [],
    }),
  },
  // [[XHS_LIKE: noteId]]
  {
    re: /\[\[XHS_LIKE:\s*(.+?)\]\]/g,
    toDirective: (m) => ({ type: 'xhs_like', noteId: m[1].trim() }),
  },
  // [[XHS_FAV: noteId]]
  {
    re: /\[\[XHS_FAV:\s*(.+?)\]\]/g,
    toDirective: (m) => ({ type: 'xhs_fav', noteId: m[1].trim() }),
  },
  // [[XHS_COMMENT: noteId | text]]
  {
    re: /\[\[XHS_COMMENT:\s*([^|]+?)\s*\|\s*([^\]]+?)\]\]/g,
    toDirective: (m) => ({ type: 'xhs_comment', noteId: m[1].trim(), text: m[2].trim() }),
  },
  // [[XHS_REPLY: noteId | commentId | text]]
  {
    re: /\[\[XHS_REPLY:\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^\]]+?)\]\]/g,
    toDirective: (m) => ({
      type: 'xhs_reply',
      noteId: m[1].trim(),
      commentId: m[2].trim(),
      text: m[3].trim(),
    }),
  },
  // [[XHS_POST: title | content | tags]]   (用 s flag 兼容多行 content)
  {
    re: /\[\[XHS_POST:\s*([^|]+?)\s*\|\s*([\s\S]+?)\s*\|\s*([^\]]+?)\]\]/g,
    toDirective: (m) => ({
      type: 'xhs_post',
      title: m[1].trim(),
      content: m[2].trim(),
      tags: m[3].trim(),
    }),
  },
  // [[XHS_SHARE: 3]]
  {
    re: /\[\[XHS_SHARE:\s*(\d+)\]\]/g,
    toDirective: (m) => ({ type: 'xhs_share', idx: Number(m[1]) }),
  },
  // [[LIFE:MED|布洛芬]] 生活记录代记 — 跟 chatParser.ts 的 `\[\[LIFE:[^\]]*\]\]` 同口径,
  // 冒号后整段原样带走, 不在这里拆 verb/args (那份解析在 lifeRecords.parseLifeDirective)。
  {
    re: /\[\[LIFE:([^\]]*)\]\]/g,
    toDirective: (m) => ({ type: 'life_record', body: m[1] }),
  },
  // [[NEWS_CARD: 来源|标题]] 分享热点卡片 — 跟 chatParser.ts:NEWS_CARD_RE 同口径。
  {
    re: /\[\[NEWS_CARD:\s*([^\]]*?)\s*\]\]/g,
    toDirective: (m) => ({ type: 'news_card', body: m[1] }),
  },
  // 写日记 — 长形态: [[DIARY_START: title|mood]]\n content \n[[DIARY_END]]
  // 短形态: [[DIARY: title|content]] 或 [[DIARY: content]] (无 title)
  // 行为跟 applyAssistantPostProcessing.ts:465-495 字节对齐:
  //   - 长形态 header 含 `|` → title|mood 切, 不含 `|` → 整段 = title
  //   - 短形态 raw 含 `|` → title|content 切, 不含 `|` → 整段 = content (title 留空, 客户端兜底)
  // 多行 content 用 [\s\S]*? 跨行, 别用 `s` flag (worker 端 esbuild target 默认 ok 但避免冗余)
  {
    re: /\[\[DIARY_START:\s*(.+?)\]\]\n?([\s\S]*?)\[\[DIARY_END\]\]/g,
    toDirective: (m) => parseDiaryLong(m, 'notion_write_diary'),
  },
  {
    re: /\[\[DIARY:\s*([\s\S]+?)\]\]/g,
    toDirective: (m) => parseDiaryShort(m, 'notion_write_diary'),
  },
  // 飞书写日记 — 同形态, FS_ 前缀
  {
    re: /\[\[FS_DIARY_START:\s*(.+?)\]\]\n?([\s\S]*?)\[\[FS_DIARY_END\]\]/g,
    toDirective: (m) => parseDiaryLong(m, 'feishu_write_diary'),
  },
  {
    re: /\[\[FS_DIARY:\s*([\s\S]+?)\]\]/g,
    toDirective: (m) => parseDiaryShort(m, 'feishu_write_diary'),
  },
];

type DiaryDirectiveType = 'notion_write_diary' | 'feishu_write_diary';

/**
 * 长日记 (DIARY_START..DIARY_END / FS_DIARY_START..FS_DIARY_END) → directive.
 * m[1] = header (可能含 `|`), m[2] = body. 跟客户端 applyAssistantPostProcessing.ts:473-484 同切法.
 */
function parseDiaryLong(m: RegExpMatchArray, type: DiaryDirectiveType): Directive | null {
  const header = m[1].trim();
  const content = (m[2] || '').trim();
  let title = '';
  let mood = '';
  if (header.includes('|')) {
    const parts = header.split('|');
    title = parts[0].trim();
    mood = parts.slice(1).join('|').trim();
  } else {
    title = header;
  }
  // title 可空 — 客户端 applyAssistantPostProcessing.ts:498-501 会用 `${char.name}的日记 - M/D` 兜底,
  // worker 端不知道角色名, 让客户端拼.
  return { type, title, content, mood: mood || undefined } as Directive;
}

/**
 * 短日记 ([[DIARY: ...]] / [[FS_DIARY: ...]]) → directive.
 * m[1] = raw (可能含 `|`). 跟客户端 applyAssistantPostProcessing.ts:486-495 同切法.
 */
function parseDiaryShort(m: RegExpMatchArray, type: DiaryDirectiveType): Directive | null {
  const raw = m[1].trim();
  let title = '';
  let content = '';
  if (raw.includes('|')) {
    const parts = raw.split('|');
    title = parts[0].trim();
    content = parts.slice(1).join('|').trim();
  } else {
    content = raw;
  }
  return { type, title, content } as Directive;
}

/**
 * 把 LLM 输出分类成一个 decision payload.
 *
 * @param text  ctx.llmOutputText (可能为空串 —— 纯 tool_calls 响应也合法; 不过那种情况我们
 *              不会进 SullyOS 分类器, 因为 SullyOS 走的是文本协议 [[...]], 不是 OpenAI tool
 *              格式. 但保留兼容性: 空字符串 → finish + 空 cleanedText)
 */
export function classifyLLMOutput(text: string): ClassificationResult {
  // 1. 先扫数据标签. 任意一个命中就走 tool-request, 同一轮多个 SEARCH/RECALL 也一次性收集.
  const toolCalls: ToolCall[] = [];
  for (const spec of DATA_TAGS) {
    // matchAll 拿迭代器, 转 array 才能多次遍历
    const matches = Array.from(text.matchAll(spec.re));
    for (const m of matches) {
      const args = spec.toArgs(m);
      if (!args) continue;
      toolCalls.push({
        id: `call_${spec.toolName}_${toolCalls.length}_${Date.now().toString(36)}`,
        type: 'function',
        function: { name: spec.toolName, arguments: JSON.stringify(args) },
      });
    }
  }

  if (toolCalls.length > 0) {
    // 把数据标签从可见 prefix 剥掉; 副作用标签**保留**在 prefix 里: 调用方把 prefix 当旁白
    // 跨轮累积, finish 时拼回全文再分类一次, 副作用标签在那次统一结构化成 directives.
    let prefix = text;
    for (const spec of DATA_TAGS) prefix = prefix.replace(spec.re, '');
    prefix = prefix.trim();
    const sanitizedPrefix = sanitizeForNotification(prefix);
    return { kind: 'tool-request', prefix, sanitizedPrefix, toolCalls };
  }

  // 2. 没数据标签 → 扫副作用标签, 凑成 directives.
  const directives: Directive[] = [];

  // 2.0 转账先走 utils/transferFormat —— 跟客户端 chatParser 共用同一份解析, 规范标签
  // (`[[ACTION:TRANSFER:520元]]` 这类金额写法一并容错) 和模仿历史日志的口语形态
  // (`[系统: 你向xx转账 1999]`) 一起认, 方向伪造的在那里就被丢掉了。
  //
  // 必须走 directive 通道而不是留在正文里让客户端扫: sanitizeIntoSegments 会把
  // "banner 文本为空" 的整块丢掉 (index.ts 拿 segments 发 push), 独占一行的转账日志
  // 到不了客户端。directives 挂在最后一条 push 上, 没有 segment 时还会单发一条
  // directive-only push, 是这类纯副作用唯一可靠的通道。
  const { text: textAfterTransfers, events: transferEvents } = extractTransferCommands(text);
  for (const ev of transferEvents) {
    if (ev.kind === 'send') {
      const amount = parseTransferAmount(ev.amount);
      if (amount !== null) directives.push({ type: 'transfer', amount });
    } else if (ev.kind === 'accept') {
      directives.push({ type: 'transfer_accept' });
    } else {
      directives.push({ type: 'transfer_return' });
    }
  }

  // 2.0b 日程修改同理走 directive 通道。不走的话标签会留在正文里，被 sanitizeIntoSegments
  // 的 stripBusinessTagsForNotification（正则含 ACTION）连 raw 一起剥掉——客户端永远收不到，
  // 角色嘴上说「日程改好了」而表其实没动，下一轮它读到的还是旧安排。
  // 解析跟客户端 scheduleChange 共用一份（中文「修改日程」、全角冒号、漏括号都认）。
  // 一个标签都没认出来时 cleanedText 就是原文——这条由 extractScheduleChangeDirectives
  // 自己保证，两侧都不必在外面再守一道（守漏的那一侧正文会悄悄少一截）。
  const scheduleParsed = extractScheduleChangeDirectives(textAfterTransfers);
  const textAfterSchedule = scheduleParsed.cleanedText;
  for (const d of scheduleParsed.directives) {
    directives.push({ type: 'change_schedule', time: d.startTime, activity: d.activity });
  }

  for (const spec of SIDE_EFFECT_TAGS) {
    const matches = Array.from(textAfterSchedule.matchAll(spec.re));
    for (const m of matches) {
      const d = spec.toDirective(m);
      if (d) directives.push(d);
    }
  }

  // 2.5 同一件事只出一个 directive.
  // 复述型模型经常把整条消息重写一遍 (先说一遍、再"总结"一遍), 同一个 [[ACTION:TRANSFER:520]]
  // 就会出现两次; 客户端重放没有去重, 放过去就是同一笔钱转两次账、同一篇日记写两遍。
  // 判据是 type + 参数**完全一致**: 金额不同 / 笔记 id 不同的两条仍是两件事, 照常都留。
  const dedupedDirectives: Directive[] = [];
  const seenDirectives = new Set<string>();
  for (const d of directives) {
    const key = JSON.stringify(d);
    if (seenDirectives.has(key)) {
      console.warn('[classifier] 同一条消息里重复的副作用, 只保留第一个:', key);
      continue;
    }
    seenDirectives.add(key);
    dedupedDirectives.push(d);
  }

  // 3. 不管 directives 有没有, 都剥光所有标签 (数据 + 副作用) 出干净文本.
  let cleanedText = textAfterSchedule;
  for (const spec of DATA_TAGS) cleanedText = cleanedText.replace(spec.re, '');
  for (const spec of SIDE_EFFECT_TAGS) cleanedText = cleanedText.replace(spec.re, '');
  cleanedText = cleanedText.trim();
  const sanitizedBody = sanitizeForNotification(cleanedText);

  return { kind: 'finish', cleanedText, sanitizedBody, directives: dedupedDirectives };
}
