/**
 * 工具跑完之后跟模型说什么 —— 前台和 worker 共用这一份。
 *
 * 背景：工具本体早就抽成共用叶子了（agenticTools.ts），**编排没有**。前台的编排全在
 * applyAssistantPostProcessing.ts 里，那份文件绑死浏览器依赖（IndexedDB / 日记 / 小红书
 * 客户端），worker 打不进去，于是 worker 自己重写了一遍——重写的时候只写了「怎么跑循环」，
 * 没写「跑完跟模型说什么」。结果两边行为分叉：
 *
 *   前台：把结果包成一条 user 消息，明说「现在请结合这些细节回答」「不要再输出
 *         [[SEARCH:...]] 了」——所以它从来不打转。
 *   worker：把结果 JSON.stringify 一下就丢回去，零引导。模型看不出「这一步已经做完了」，
 *         提示词里但凡有一句常驻的「先去查 X」，它每轮都会照做，直接跑满上限。
 *
 * 跑满上限的代价不是「少查一次」：超限抛 AGENTIC_LOOP_EXCEEDED，任务不出清，下一分钟的
 * cron 把整条从头再跑一遍，反复烧 LLM。实测有过从 12:45 拖到 13:11 才收场的。
 *
 * 这份模块就是把「跑完说什么」也变成共用的一份。它只管措辞和「别重复」的规则，不碰
 * 具体工具怎么跑，所以两边各自的循环形态（前台是流水线、worker 是真循环）都能用。
 */

import { MCP_FIRE_NAME_PREFIX } from './mcpFireCore';

/**
 * 一次工具调用的指纹：工具名 + 规范化后的参数。
 *
 * 参数按 key 排序后序列化，`{a:1,b:2}` 和 `{b:2,a:1}` 算同一次调用——模型两轮之间
 * 重新拼参数时字段顺序常常会变，不规范化的话同一个查询会被当成两次不同的。
 */
export const toolCallFingerprint = (name: string, args: unknown): string => {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, normalize(v)]),
      );
    }
    return value;
  };
  return `${name}:${JSON.stringify(normalize(args ?? {}))}`;
};

/** 本次 fire 里已经调用过的一次工具。 */
export interface ToolCallRecord {
  name: string;
  fingerprint: string;
  /**
   * 这次调用到底跑没跑起来（`!neverRan(result)`）。没配 key / 连不上 / 服务器没开机的
   * 那些压根没发出请求，跟「跑了但没查到」不是一回事。
   *
   * 只有需要分辨这件事的地方才填（云端工具痕迹要靠它筛）。没填时按「跑过了」算，
   * 跟 neverRan 认不出形状时的兜底同一个口径。
   */
  ran?: boolean;
}

/** 工具名 → 给模型看的说法。认不出来的直接用原名，不编。 */
const TOOL_LABELS: Record<string, string> = {
  recall: '调取某个月的记忆',
  web_search: '联网搜索',
  notion_read_diary: '翻日记（Notion）',
  feishu_read_diary: '翻日记（飞书）',
  read_note: '翻对方的笔记',
  xhs_search: '在小红书搜索',
  xhs_browse: '刷小红书首页',
  xhs_my_profile: '打开自己的小红书',
  xhs_detail: '点开一条小红书笔记',
  // 后台到点时角色能给自己排下一条消息（worker 的 fire 循环里就这一个非数据工具）。
  // 漏在表外的话，回喂会拼出「你schedule_active_message，拿回了…」——内部工具名直接
  // 进了模型能看见的散文里。
  schedule_active_message: '给自己排下一条消息',
  // 前台聊天里角色还能取消 / 改期 / 查清单（见 utils/amsg2ToolBridge.ts）。同样是漏在
  // 表外就会把内部工具名拼进散文，所以三个一起登记。
  cancel_active_message: '取消一条排好的消息',
  renew_active_message: '把排好的消息改到别的时间',
  list_active_messages: '查自己排了哪些消息',
};

/**
 * 工具名 → 塞进「你__，拿回了下面这些」这句话里的说法。
 *
 * 用户自配的 MCP 工具不在上表里，名字还带着路由用的 mcp__ 前缀。直接回填原名会拼出
 * 「你mcp__get_secret，拿回了…」——句子读不通，内部前缀也漏进了模型能看见的散文里
 * （模型照着学，回头就往正文里写 mcp__ 开头的假调用）。所以这类名字剥掉前缀、
 * 补成完整的动宾短语。内置工具都在表里，走不到这两条分支。
 */
export const describeTool = (name: string): string => {
  const label = TOOL_LABELS[name];
  if (label) return label;
  if (name.startsWith(MCP_FIRE_NAME_PREFIX)) {
    return `调用「${name.slice(MCP_FIRE_NAME_PREFIX.length)}」`;
  }
  return name;
};

/**
 * 工具结果 → 回喂给模型的那段话。
 *
 * 结构照抄前台那套（`[系统: 做了什么]` + 结果 + `[系统: 接下来干嘛]`），关键是最后那段
 * 收尾：把本次已经用过的工具点名列出来，并且说死「同样的调用不要再来一遍」。裸 JSON 里
 * 没有任何东西在告诉模型「这一步结束了」，这段话就是。
 */
/**
 * 这些 reason 的意思是「这次调用压根没跑到」：没配、没开、连不上、被拦下。
 *
 * 跟「跑了但没东西」（no_results / not_found / no_logs）必须分开：后者角色说
 * 「我搜了下没啥」是实话，前者说同一句就是把没发生的事说成发生过。裸 JSON 里
 * 一个 reason 字段拦不住这件事——模型看见 `ok:false` 只会挑个说法圆过去，所以下面
 * 明着写一句「不要说你查过」。
 *
 * 后台触发时最常走的就是这一类：小红书 / MCP 服务器多半跑在用户自己电脑上，
 * 人睡了机器关了，worker 那边怎么也连不上。
 *
 * `empty_content` 看着像「跑了但是空的」，其实不是：日记/笔记类工具只有在「条目找到了、
 * 每一篇正文都没读回来」时才发它（真的空白日记会带着「（空白日记）」正常返回），
 * 所以它也是一次读取失败。往这个集合里加名字前先确认语义，别照字面猜。
 */
const NEVER_RAN_REASONS = new Set([
  'unreachable',
  'not_enabled',
  'not_configured',
  'not_supported',
  'no_api_key',
  'no_identity',
  'parse_error',
  'empty_content',
  'unknown_tool',
  'tool_error',
  'mcp_error',
  'mcp_budget_exhausted',
]);

/** 结果是不是「这次没跑成」。形状认不出来时当作跑过了（不硬加一句可能不对的告诫）。 */
export const neverRan = (result: unknown): boolean => {
  if (!result || typeof result !== 'object') return false;
  const r = result as { ok?: unknown; reason?: unknown };
  return r.ok === false && typeof r.reason === 'string' && NEVER_RAN_REASONS.has(r.reason);
};

/**
 * 少数工具的结果需要额外补一句提醒，跟着结果一起回喂。
 *
 * 搜索结果里没有任何时间信息（拿回来的只有标题和摘要），模型看不出这条是今早的还是
 * 三年前的，很容易把一条旧闻当成刚发生的事讲出来——后台主动消息尤其明显，角色会
 * 兴冲冲地跟用户说一件早就过去的新闻。
 */
const TOOL_RESULT_NOTES: Record<string, string> = {
  web_search: '[系统: 搜索结果不带日期，不一定是最新的——别把旧闻当成刚发生的事说，也别自己给它安一个时间。]',
};

export const buildToolResultMessage = (opts: {
  name: string;
  /** dispatchAgenticTool 的返回值，原样序列化给模型看。 */
  result: unknown;
  /** 本次 fire 到目前为止调过的全部工具（含这一次）。 */
  history: ToolCallRecord[];
}): string => {
  const { name, result, history } = opts;
  const used = [...new Set(history.map((r) => describeTool(r.name)))];
  const label = describeTool(name);
  const head = neverRan(result)
    ? [
        `[系统: 你想${label}，但这次没能跑起来——下面是失败原因]`,
        JSON.stringify(result),
        '',
        `[系统: 这件事**没有发生**。不要在消息里说你${label}过、看到了什么、或者「查了没找到」——`,
        '那等于把没做过的事说成做过了。就当这回没查成：要么换个别的说，要么直接说你现在不方便查。]',
      ]
    : [
        `[系统: 你${label}，拿回了下面这些]`,
        JSON.stringify(result),
        ...(TOOL_RESULT_NOTES[name] ? [TOOL_RESULT_NOTES[name]] : []),
        '',
      ];
  return [
    ...head,
    `[系统: 本次已经用过的工具：${used.join('、')}。结果都在上面了，同样的调用不要再来一遍。`,
    '接下来：如果还没说完，直接把要发的消息写出来（只有确实还需要别的工具时，才调用一个还没用过的工具）。',
    // 「把要发的消息写出来」很容易被读成「从头再写一遍」：模型会把已经说出去的几句连同
    // 里面的标记一起重抄，下游照着标记再执行一次（转账就会真的发两次）。同时给「工具轮已经
    // 把话完整说完」留明确出口，避免没话可补时把前文换词复述一遍。
    '前面已经说出去的内容和标签不要重写，接着往下写就行——重写一遍，用户那边就会再收到一遍；如果前面的话已经把要说的完整表达完了、且与这次工具结果不冲突，不必再写补充文字，直接留空结束即可。',
    '别把工具调用当成回答——用户等的是你说的话。]',
  ].join('\n');
};

/**
 * 同一个调用又来了一次时回给模型的话（不真跑工具）。
 *
 * 光靠上面那段提示是软约束，模型不听就还是会转满上限、把任务拖进「不出清 → 下一分钟整条
 * 重跑」的循环。这条是硬的：同名同参第二次直接打回，一次网络请求都不发。它只拦**完全
 * 一样**的调用，换个月份、换个关键词都照常放行，多轮能力一点不减。
 */
export const buildDuplicateToolMessage = (name: string): string => [
  `[系统: 你刚刚已经${describeTool(name)}过一次了，参数完全相同，结果就在上面。]`,
  // 说「没有再执行」而不是「没有再去查」：这段话现在也管排程/取消/改期这类不是查询的
  // 工具，说成「查」的话，角色收到的交代跟它刚做的事对不上。
  '[系统: 这一次没有再执行。别再重复同样的调用了——如果还没说完，现在把要发的消息写出来（只有确实还需要别的工具时，才换一个还没用过的工具）。',
  '前面已经说出去的内容和标签不要重写，接着往下写就行；如果前面已经完整说完了，直接留空结束即可。]',
].join('\n');
