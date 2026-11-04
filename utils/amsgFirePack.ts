/**
 * 主动消息 2.0「满血」fire_pack：前端拼好的 prompt 模板 + 时间槽位的渲染。
 *
 * prompt 不在排程时定稿，而是前端把「除时间性内容外的完整模板」同步到 worker 的
 * client_state（namespace `amsg:char:<id>`，key `fire_pack`），worker 到点用
 * renderFirePack 现算时间填槽——上下文永远是最后一次聊天的状态。这份模块被两边共用：
 *   - 前端 activeMsgClient 的 buildFirePack（排程 / 每轮聊完同步时打包）
 *   - worker/amsg/src/index.ts 的 onBeforeFire（fire 时现场渲染）
 * 时间文案只此一份，两边的槽位定义保证一致。
 *
 * 多任务共用每角色一份 fire_pack：「本次任务」指令随任务 metadata 走、到点填槽（v2 起）。
 *
 * 零运行时依赖（worker bundle 会打进这份代码，别在这里 import 前端环境的东西；类型引用
 * 编译期擦除，不算）。除了压缩那几个函数用 CompressionStream / base64（浏览器和 Workers
 * 运行时都自带），其余都是纯函数。
 */

import type { ActiveMsg2TaskRecord } from '../types';
import { renderFireSceneBlock, type AmsgFireScene } from './amsgFireScene';
import { DEFAULT_MAX_UNANSWERED_SENDS } from './amsgLimits';

// 连发上限的默认值与解析搬进了 amsgLimits（和其余几项上限住在一起），这里转出去给老调用方。
export { DEFAULT_MAX_UNANSWERED_SENDS, resolveMaxUnansweredSends } from './amsgLimits';

export const AMSG_STATE_NAMESPACE_PREFIX = 'amsg:char:';
export const amsgStateNamespace = (charId: string) => `${AMSG_STATE_NAMESPACE_PREFIX}${charId}`;
export const AMSG_FIRE_PACK_KEY = 'fire_pack';

/**
 * 角色到点自己发出去的那几条正文（每角色一份）。
 *
 * fire_pack 的【最近对话上下文】停在「用户最后一次聊天」那一刻，而主动消息发出去之后
 * 那份不会变——用户离线期间连着触发两次，第二次看到的上下文和第一次逐字一样，角色不知道
 * 自己刚说过什么，只能把同一句话换个说法再发一遍。worker 每次发完把正文追加到这里，
 * 下次到点连同 fire_pack 一起读回来，接在对话上下文后面。
 *
 * 用户重新聊天后客户端会传一份新的 fire_pack（新历史里本来就含这些消息），那时这份日志
 * 靠 basePackAt 对不上号自动作废，下一次 fire 直接覆盖成新的一份。
 */
export const AMSG_SELF_LOG_KEY = 'self_log';

/**
 * 大内容旁路：一条 push 塞不下的 XHS 会话数据（笔记详情 + xsecToken）存这个 key，
 * push 里只带 `metadata.xhsSessionRef` 指过来，客户端收到后按键取回、用完即删。
 *
 * 每个任务固定一份、下次触发直接覆盖——所以就算客户端一直没来取，存量也有上限，
 * 不需要额外的过期清理。worker 写（onLLMOutput）与客户端读（activeMsgRuntime）
 * 共用这一份键名，别在任何一侧另起炉灶。
 */
export const amsgXhsSessionKey = (clientTaskId: string) => `xhs_session:${clientTaskId}`;

// ─── 即时对话轻量包的模板占位 ───

/**
 * 即时对话轻量包的模板占位（角色 2.0 关着且没有任何任务时用）：定时任务那条路才渲染
 * 模板，这类角色的包正常没人渲染，每次发送重建一整份系统提示词 + 近史转写纯属白付
 * （主线程二次构建 + 手机上行几十 KB，都发生在拿到 202 之前）。写成一眼能认出来的
 * 标记，两侧共用这一份：客户端（activeMsgClient）发轻量包时填进 template；worker
 * 跑定时任务前认出它，就知道真模板还没补传上来，这一跳先延后重试而不是照渲。
 */
export const AMSG2_INSTANT_STUB_TEMPLATE =
  'AMSG2_INSTANT_STUB_TEMPLATE（即时对话轻量包：该角色无定时任务，模板未随发送重建；看到这条正文说明有本不该渲染模板的 fire 在渲染它）';

// ─── 即时对话的失败留痕（chat_fail） ───

/**
 * 即时对话整轮失败时的原因留痕（每角色一份，新的覆盖旧的）。
 *
 * 客户端 60s 点名判到「任务行已出清」后要向用户交代失败原因，而 lastError 埋在任务行
 * 的加密 payload 里——按角色扫全量任务列表（分页 + 逐条解密）几秒起步。worker 在
 * fire 收尾（amsgFireSettled，每次失败尝试覆盖写）和过期跳过（amsgStaleSkip）时顺手
 * 在这里留一份，客户端一次点名读回。记录带 uuid：读到的不是自己等的那一轮就当没有。
 */
export const AMSG_CHAT_FAIL_KEY = 'chat_fail';

export interface AmsgChatFailRecord {
  v: 1;
  /** 失败的是哪一轮（任务行 uuid）；客户端只认和待收记录对得上的那份。 */
  uuid: string;
  /** 失败原因（fire 抛错的 message；过期跳过固定为 'stale'）。 */
  reason: string;
  /** 失败那一跳时任务行上的重试计数。 */
  retryCount: number;
  /** 写入时刻（epoch ms）。 */
  at: number;
  /**
   * 底层错误的稳定 code，取自 fire 抛出来那个错误对象上的 `code`
   * （`LLM_CALL_FAILED` / `AGENTIC_BAD_DECISION` / `PUSH_PAYLOAD_TOO_LARGE` …）。
   * 客户端按它给「这次该怎么办」，不用去正则匹配 reason 那句人话。
   *
   * 没有配对的 `pushStatus`：那个数只有上游发 push 的那一步知道（存在包内私有的
   * WeakMap 上），fire 收尾这里拿到的错误对象上读不到。要用它得读上游写在任务行
   * 上的那份 lastError，客户端会把两边合起来看。
   */
  errorCode?: string;
}

/** 读回来的失败留痕；形状不对返回 null（这是提示通道不硬失败，没有就报笼统原因）。 */
export const parseChatFailRecord = (value: string | null | undefined): AmsgChatFailRecord | null => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AmsgChatFailRecord> | null;
    if (
      parsed && typeof parsed === 'object' && parsed.v === 1
      && typeof parsed.uuid === 'string' && typeof parsed.reason === 'string'
      && typeof parsed.retryCount === 'number' && typeof parsed.at === 'number'
    ) {
      return parsed as AmsgChatFailRecord;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

// ─── client_state 的值压缩 ───
//
// fire_pack 是「角色完整系统提示词 + 最近 30 条对话」，一份 40KB 起步，排了任务的角色
// 每聊完一轮就整份重传一次。压缩必须发生在**交给上游加密之前**：上游 putClientState 是
// 先加密再发，密文近似随机、gzip 压不动（实测只能抵消 base64 那点膨胀，省 25%），
// 而在这里先压再交出去，同一份内容实测省 60%，D1 里存的也跟着变小。

/**
 * 压缩过的值的前缀。
 *
 * 不是版本兼容用的，是「这一份到底压没压」的标记：内容太短时压完反而更大，
 * packStateValue 会原样返回，读侧靠这个前缀分辨该不该解压。
 */
const GZIP_VALUE_PREFIX = 'gz1:';

/** 运行时有没有压缩能力（老 Safari 没有 CompressionStream）。 */
const canCompress = (): boolean =>
  typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

// btoa/atob 只吃 latin1 字符串，二进制要一个字节一个字符地喂。整段 apply 展开会在大数据上
// 爆调用栈，按块拼。
const CHUNK = 0x8000;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const streamThrough = async (data: Uint8Array, transform: TransformStream): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * 上传前把值压掉。压不动或运行时不支持时原样返回 —— 这个函数永远不该让同步失败，
 * 云端那份 fire_pack 是角色到点时唯一的上下文来源，为了省流量把它弄丢是本末倒置。
 */
export const packStateValue = async (json: string): Promise<string> => {
  if (!canCompress()) return json;
  try {
    const rawBytes = new TextEncoder().encode(json);
    const gz = await streamThrough(rawBytes, new CompressionStream('gzip'));
    const packed = `${GZIP_VALUE_PREFIX}${bytesToBase64(gz)}`;
    // 划算不划算按**字节**比，不能用 .length。fire_pack 几乎全是中文，一个字符占 3 个
    // UTF-8 字节，而压完的 base64 全是 ASCII（1 字符 = 1 字节）——拿字符数比的话，
    // 明明省掉一半流量的结果会被判成「压完更大」，于是一份都压不动。
    return packed.length < rawBytes.length ? packed : json;
  } catch {
    return json;
  }
};

/**
 * 读回来的值还原成 JSON 字符串。没有前缀的就是没压过的，原样返回。
 * 解压失败抛出去 —— 那说明数据真损坏了，不能当成正常内容往下走。
 */
export const unpackStateValue = async (value: string): Promise<string> => {
  if (!value.startsWith(GZIP_VALUE_PREFIX)) return value;
  const gz = base64ToBytes(value.slice(GZIP_VALUE_PREFIX.length));
  const raw = await streamThrough(gz, new DecompressionStream('gzip'));
  return new TextDecoder().decode(raw);
};

/**
 * 最近一次到点没发的是哪次触发（每角色一份，新的盖旧的）。
 *
 * 没发是静默的：worker 这次不发就直接收场，一条 push 都不出。
 * 对用户来说，「这次没发」和「发出去但没收到」「功能坏了」长得一模一样——远端那行任务
 * 两种情况下都会被消费掉，客户端事后无从分辨。
 *
 * 所以让 worker 在跳过时留一句话，客户端读回来照实说明。只留最近一次：这是给人看的
 * 「刚才为什么没响」，不是审计流水，攒着只会越积越多。
 */
export const AMSG_LAST_SKIP_KEY = 'last_skip';

/** last_skip 的原因枚举（新增值时 describeLastSkip 的人话文案要一起补）。 */
export const LAST_SKIP_REASONS = [
  'declined',
  'empty-generation',
  'side-effects-only',
  'stale',
  'unanswered-limit',
  'schedule-off',
  'min-gap',
  'recurring-unanswered',
  'daily-limit',
] as const;

export interface AmsgLastSkip {
  v: 1;
  /** 被跳过的那条任务（uuid，拿不到时为 null）。 */
  taskUuid: string | null;
  /** 本该触发的时刻。 */
  occurrenceMs: number;
  /**
   * declined              角色到点看了最新的对话，自己决定这次不说（输出了 AMSG_SILENT_MARK）
   * empty-generation      模型这次没写出任何能发的正文（空输出 / 纯拒答）
   * side-effects-only     模型这次只做了副作用（点赞、写日记之类）却没说话，整条不发
   * stale                 到点时已经过期太久（服务停摆后恢复），不再补发
   * unanswered-limit      角色自排的任务到点时，用户未回复期间的连发次数已到用户设的上限
   * schedule-off          角色自排的任务到点时，用户已经不让它排这类消息了（关了 2.0，或关了「可以排重复的」）
   * min-gap               角色自排的任务到点时，离它上一条主动消息还没隔够用户设的间隔
   * recurring-unanswered  重复的任务到点时，用户已经连续几次没回它了（回话后恢复）
   * daily-limit           今天主动发的次数已到用户设的每日上限
   */
  reason: (typeof LAST_SKIP_REASONS)[number];
  skippedAt: number;
  /**
   * reason 为 stale 时补充这条任务的去向：
   *   expired        一次性任务，这一次永远不会补发了
   *   fast_forwarded 循环任务，攒下的这几次都跳过，排期已快进到 nextSendAtMs
   */
  staleAction?: 'expired' | 'fast_forwarded';
  /** 一并跳过了几次（含名义那一次）。 */
  skippedCount?: number;
  /** 循环任务快进到的下一次触发时刻；一次性任务没有下一次，为 null。 */
  nextSendAtMs?: number | null;
}

export const parseLastSkip = (value: string): AmsgLastSkip | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && typeof parsed === 'object' && parsed.v === 1
      && typeof parsed.occurrenceMs === 'number'
      && (LAST_SKIP_REASONS as readonly string[]).includes(parsed.reason)
    ) {
      return parsed as AmsgLastSkip;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

/** 给人看的一句话：为什么那一次没响。 */
export const describeLastSkip = (skip: AmsgLastSkip, formatTime: (ms: number) => string): string => {
  const when = formatTime(skip.occurrenceMs);
  switch (skip.reason) {
    case 'declined':
      return `${when} 那次主动消息没发——ta 到点看了看你们的对话，觉得这会儿不用再说了。`;
    case 'empty-generation':
      return `${when} 那次主动消息没发出来——ta 到点想了想，这次没写出要说的话。`;
    case 'side-effects-only':
      return `${when} 那次主动消息没发出来——ta 到点只顾着做事，一句话都没说，就没打扰你。`;
    case 'stale': {
      // 循环任务只是跳过了攒下的这几次，下一次照常响；一次性任务是真的没了。
      // 两句话分开说，不然用户会以为每日提醒已经死了。
      const times = skip.skippedCount && skip.skippedCount > 1 ? `连着 ${skip.skippedCount} 次` : '那次';
      if (skip.staleAction === 'fast_forwarded') {
        const next = skip.nextSendAtMs ? `，下一次 ${formatTime(skip.nextSendAtMs)} 照常` : '，下一次照常';
        return `${when} 起${times}主动消息没发——中间服务中断过，过期的就不补了${next}。`;
      }
      return `${when} 那次主动消息没发——到点时已经过去太久（服务中断过），过期的话就不补发了。`;
    }
    case 'unanswered-limit':
      // 照 stale 那支的口径说实话：被闸拦下的那一次是**跳过**，不是排队等着补发。
      // 上游把跳过当成功消费——一次性任务的行当场就删了，循环任务只是快进到下一次。
      // 写成「等你回复后恢复」的话，用户会一直等一条永远不会来的消息。
      return `${when} 那次主动消息没发——你没回的这段时间 ta 连着找你的次数已到你设的连发上限，`
        + `跳过的这次不会补发；等你回话之后，ta 自己排的后续才会重新开始发。`;
    case 'schedule-off':
      // 两种来由共用这一句：关了主动消息 2.0（这时你自己排的也不发），或者 ta 自己排了
      // 重复的消息、而你没让 ta 排。
      return `${when} 那次主动消息没发——这类消息你已经关掉了（关了主动消息 2.0，或者没让 ta 排重复的），就不发了。`;
    case 'min-gap':
      return `${when} 那次主动消息没发——离 ta 上一条主动消息太近，没隔够你设的间隔，跳过的这次不会补发。`;
    case 'recurring-unanswered':
      // 跟上面几条不一样：这条会自己回来，得说清楚，不然用户以为每天的问候被删了。
      return `${when} 那条重复消息这次没发——你已经连续几次没回它了，先停一停；你回一句话，它就照常恢复。`;
    case 'daily-limit':
      return `${when} 那次主动消息没发——今天 ta 主动找你的次数已经到了你设的每日上限，跳过的这次不会补发，明天重新计数。`;
  }
};

export const AMSG_SLOT_CURRENT_TIME = '{{AMSG_CURRENT_TIME}}';
export const AMSG_SLOT_TIME_SINCE_USER = '{{AMSG_TIME_SINCE_USER}}';
export const AMSG_SLOT_AWAY_HINT = '{{AMSG_AWAY_HINT}}';
export const AMSG_SLOT_TASK_INSTRUCTION = '{{AMSG_TASK_INSTRUCTION}}';
/**
 * 「对方那边现在几点」的落点，紧跟在角色自己的当前时间后面。
 *
 * 角色的钟按 tzId 走，用户的钟按 userTzId 走——异国恋角色排消息时只看得到自己那边的
 * 时间，很容易把「晚上九点聊两句」排到用户的凌晨三点。这一行给它一个参照。
 *
 * 两个时区一样时 worker 填空串（绝大多数角色都是这种），槽位连带消失：同一个钟报两遍
 * 只会让模型以为 prompt 里有两个打架的时间。
 */
export const AMSG_SLOT_USER_CLOCK = '{{AMSG_USER_CLOCK}}';
/**
 * 「这份上下文之后，角色自己又发过什么」的落点，紧跟在【最近对话上下文】后面。
 *
 * 槽位而不是把这段拼在整份 prompt 尾巴上：接在对话记录后面读起来才是一条时间线，
 * 挂在最后（本次任务指令之后）的话，角色多半会把它当成新指令的一部分。
 */
export const AMSG_SLOT_SELF_LOG = '{{AMSG_SELF_LOG}}';
/**
 * 「你现在还挂着哪些排程」的落点。
 *
 * 平时聊天时角色每轮都能看到这份清单（见 amsg2TaskContext 的排程现状块），到点生成时
 * 反而看不到——它因此不知道自己已经排了什么，容易把同一件事再排一遍，也没法在说话时
 * 避开「等下再跟你说 X」而 X 其实早就排在半小时后。这个槽位把同一份信息补到 fire 这边。
 */
export const AMSG_SLOT_TASK_LIST = '{{AMSG_TASK_LIST}}';
/**
 * 「你此刻在做什么」的落点：日程当前时段 + 由日程推出来的此刻在听的歌。
 *
 * 这两块以前跟着角色设定一起烤进模板，说的是打包那一刻的事——凌晨三点触发时角色
 * 会说「我在健身房呢」。改成随包带整天的作息表，worker 到点按角色时区现挑时段。
 */
export const AMSG_SLOT_SCENE = '{{AMSG_SCENE}}';
/**
 * 「外面的世界此刻什么样」的落点：今日节日 + 实时天气 + 热搜。
 *
 * 这一段前台每轮都有（见 realtimeWorldCore 的 renderRealtimeWorldBlock），到点生成
 * 也该有，但绝不能跟着模板一起烤进来——它抬头就写着「以下信息来自真实世界」，
 * 措辞比任何免责声明都硬，照着打包那一刻的读数说话就是大晴天叫人带伞、第二天还在
 * 祝七夕快乐。所以留成槽位，worker 到点现拉现填；拉不到就填空串，这一段整个消失。
 *
 * 注意这段里不带「当前时间」那一行：时间由 AMSG_SLOT_CURRENT_TIME 给，
 * 两处都出的话一份 prompt 里就有了两个钟。
 */
export const AMSG_SLOT_REALTIME_WORLD = '{{AMSG_REALTIME_WORLD}}';
/**
 * 「你们此刻正聊着」的落点，在【开口之前】那一段里。
 *
 * 到点时对方是不是刚说过话，只有 worker 在触发那一刻知道。正聊着时这里填一行事实，
 * 角色据此把要说的话顺着眼下的话头说、或者判断这会儿不该插进来；没在聊就填空串，
 * 这一行连带消失。
 */
export const AMSG_SLOT_LIVE_CHAT = '{{AMSG_LIVE_CHAT}}';

/**
 * 角色决定这次不说时输出的标记（整段输出只有它）。
 *
 * 用一个明确的标记而不是「什么都不输出」：空输出还可能是中转站截断、模型拒答、正文全在
 * 思考块里，这些都该算「没写出来」；有了标记，「看了对话决定不说」才能单独记一笔。
 */
export const AMSG_SILENT_MARK = '[[SILENT]]';

/**
 * 模板里【开口之前】那一段：到点说不说由角色自己判。
 *
 * 它看得到完整的最新对话，代码看不到语义。worker 到点只补一行事实
 * （AMSG_SLOT_LIVE_CHAT：对方是不是刚说过话），没在聊时那一行连带消失。
 * 默认是说。判据写成两件能对照上下文查证的事——这件事发生过没有、插进来会不会打断——
 * 并且点名「怕打扰」这类笼统顾虑不算数：不点名的话，模型会拿它们当理由沉默，
 * 主动消息就整体哑掉了。
 * 不说 → 只输出 AMSG_SILENT_MARK，worker 认这个标记走 skip-push 出口：不推送、
 * 不占连发额度，面板和角色下一轮聊天都会照实知道这条没发。
 */
export const BEFORE_SPEAK_LINES: readonly string[] = [
  '【开口之前】',
  `先对照上面的【最近对话上下文】（连同后面你自己发过、回过的那几句）。${AMSG_SLOT_LIVE_CHAT}`,
  '默认是照常说你要说的话。只有两种情况这次不说：',
  '1. 这条任务要说的事，已经在你们的对话里发生过、或者已经聊完了。',
  '2. 你们正聊着别的，这条插进来明显会打断正在说的事，而且晚点再说也不耽误。',
  '正聊着不等于不说：对方正等着这条、或者它跟眼下聊的接得上，就顺着话头把它说出来，像聊天里自然接上的一句，别像另起一段的通知。',
  '拿不准就说。「怕打扰」「时机好像不太对」这种笼统的顾虑不算理由。',
  `决定不说 → 整段输出只写 ${AMSG_SILENT_MARK} 这一个标记，别的一个字都不要写，也不要解释。`,
];

/** 对方最后一次开口在这么久之内，就算「你们此刻正聊着」。 */
export const LIVE_CHAT_WINDOW_MS = 10 * 60_000;

/**
 * 「即时对话」这一轮要发给模型的对话消息。
 *
 * 和 template 是两条路，不混用：template 是「到点主动找人说话」的提示词，
 * 这一份是「用户刚说完话、等回复」时本地生成会原样 POST 出去的 fullMessages。
 * 即时对话的 fire 直接拿它当请求消息，只在末尾追加一块时效内容（当前时间、
 * 实时世界等），不走 renderFirePack 的模板渲染。
 */
/**
 * 一条对话消息的正文：要么是纯文本，要么是 chat API 那套结构化分段
 * （带图片的消息本地就长这样：`[{type:'text',…},{type:'image_url',…}]`）。
 *
 * 分段里除了 `type` 之外什么样，这一层不管也不该管——那是 chat API 的方言，
 * worker 只负责原样搬到请求体里。写死字段的话，哪天多模态多出一种分段类型，
 * 卡住的会是这份「只负责搬运」的代码。
 */
export type AmsgFirePackChatContent =
  | string
  | Array<{ type: string; [key: string]: unknown }>;

export interface AmsgFirePackChat {
  /** 本地生成会 POST 给 /chat/completions 的 fullMessages，原样带上来。 */
  messages: { role: string; content: AmsgFirePackChatContent }[];
  /** 这份对话消息打包的时刻（epoch ms）。 */
  builtAt: number;
}

export interface AmsgFirePack {
  /** 模板是否含用户指定的内心独白协议；旧包缺省不回传原始推理。 */
  thinkingChainEnabled?: boolean;
  v: typeof FIRE_PACK_VERSION;
  /** 完整 prompt 模板，时间性内容与本次任务指令留 AMSG_SLOT_* 槽位。 */
  template: string;
  /** 用户上次真实主动发消息的时间（epoch ms）；没有聊天记录时为 null。 */
  lastUserMessageAt: number | null;
  /**
   * 角色的 IANA 时区 id（角色开了自定义时区用角色的，没开用打包设备的）。
   * worker 渲染一切给角色看的时间都以它为参照系（Intl 处理夏令时）。必填：
   * 缺了整包按格式不对打回（parseFirePack → null，worker 抛 fire-state 错）。
   */
  tzId: string;
  /**
   * 打包这台设备的 IANA 时区 id，也就是「用户那边」的钟。
   *
   * 只用来渲染 AMSG_SLOT_USER_CLOCK 那一行参考——角色自己的一切时间仍按 tzId 走，
   * 这两个绝不能混着用。必填：缺了整包按格式不对打回（跟 tzId 同一条规矩）。
   */
  userTzId: string;
  /** 用户称呼（userProfile.name || '对方'），awayHint 文案用。 */
  targetName: string;
  /**
   * 这份模板打包的时刻（epoch ms）。basePackAt 记下当前快照版本，但换代本身
   * 不能证明任务已被客户端认领；tasks 按 pendingTasks 里的 UUID 逐项去重。
   * 连发记录只认用户有没有开口（见 reconcileSelfLogWithPack）。
   */
  builtAt: number;
  /**
   * 打包时该角色还挂着的排程（客户端清单里的原始记录）。worker 到点渲染成
   * AMSG_SLOT_TASK_LIST 那一段，并把「正在发的这一条」摘掉。
   *
   * 和模板其余部分一样是「最后一次聊天时」的快照：用户中途在面板上取消了任务，这份要等
   * 下次同步才更新。角色到点自己排下的那些不在这里，由 worker 从 self_log 补上。
   */
  pendingTasks: ActiveMsg2TaskRecord[];
  /**
   * 「此刻在做什么」的原始素材（作息表 + 歌单抽样池），worker 到点渲染进
   * AMSG_SLOT_SCENE。没日程的角色为 null，那个槽位被抹平。
   */
  scene: AmsgFireScene | null;
  /**
   * 即时对话用的对话消息（见 AmsgFirePackChat）。只有开了即时对话的角色才带，
   * 定时任务那条路不读它。标了 `amsgInstantChat` 的任务缺这一份 = 按失败处理，
   * 绝不退回主动消息模板去答聊天。
   */
  chat?: AmsgFirePackChat;
  /**
   * 角色级「主动消息 2.0」开关（打包时取 isAmsg2EnabledForChar）。false 时云端 fire
   * 不注入排程说明块 / 排程工具 / 任务清单——本地路径的同名闸门是 useChatAI 的
   * amsg2ToolsInjected（角色级开关关掉的不注入，否则被用户显式关掉的功能会被角色
   * 一次工具调用重新打开），云端不看这个字段的话正好把那道闸绕穿：全局即时对话开着、
   * 角色 2.0 关着，角色照样能在云端聊天轮里排出真会触发的任务。
   * 必填：v7 的唯一生产者（buildFirePack）无条件写它。这是一道用户主权闸，缺省放行
   * 的容错方向是 fail-open（字段一丢开关就被静默重新打开），宁可整包打回。
   */
  selfScheduleEnabled: boolean;
}

// ─── 按角色参照系渲染时间（②：worker 给角色看的一切时间只此一份） ───

/** 「角色活在哪个参照系」：fire_pack 的 tzId（IANA 时区 id，Intl 管夏令时）。 */
export interface AmsgTzRef {
  tzId: string;
}

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  /** 0=周日 … 6=周六。 */
  weekday: number;
  hour: number;
  minute: number;
}

/**
 * nowMs 在 tz 参照系下的墙钟读数。全程 Intl（Workers 运行时带完整 ICU，
 * 严禁手搓时差加减——项目时区文档的红线）。tzId 非法直接抛错：parseFirePack 已经
 * 保证它非空，还解析不了就是数据坏了，走 fire 失败路径留痕，不静默给一个错的时间。
 */
export const wallClockPartsInZone = (nowMs: number, tz: AmsgTzRef): WallClockParts => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz.tzId,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date(nowMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const weekdayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday);
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0; // 个别环境用 24:00 表示午夜
  return {
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
    weekday: weekdayIdx >= 0 ? weekdayIdx : 0,
    hour,
    minute: parseInt(map.minute, 10),
  };
};

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 时段词分桶照抄 buildTimeAwarenessBlock（utils/context.ts），两边说同一套话。 */
const timeOfDayWord = (h: number): string =>
  h < 5 ? '凌晨' : h < 9 ? '早晨' : h < 12 ? '上午' : h < 14 ? '中午'
  : h < 17 ? '下午' : h < 19 ? '傍晚' : h < 22 ? '晚上' : '深夜';

const pad2 = (n: number) => n.toString().padStart(2, '0');

/** 当前时间槽用的自然中文全格式：`2026年8月1日 周六 早晨 08:00`（与 buildCoreContext 同款）。 */
export const formatFireTimeFull = (nowMs: number, tz: AmsgTzRef): string => {
  const p = wallClockPartsInZone(nowMs, tz);
  return `${p.year}年${p.month}月${p.day}日 ${WEEKDAY_NAMES[p.weekday]} ${timeOfDayWord(p.hour)} ${pad2(p.hour)}:${pad2(p.minute)}`;
};

/** self_log 时间戳 / 排程清单用的短格式：`8月1日 08:00`（同一参照系，只是省地方）。 */
export const formatFireTimeShort = (nowMs: number, tz: AmsgTzRef): string => {
  const p = wallClockPartsInZone(nowMs, tz);
  return `${p.month}月${p.day}日 ${pad2(p.hour)}:${pad2(p.minute)}`;
};

/**
 * 「对方那边现在几点」那一行（填进 AMSG_SLOT_USER_CLOCK）。
 *
 * 一份 prompt 里出现两个时间是很危险的，所以这一行把主语写死：上面那行是角色自己的
 * 当前时间，这一行明说是对方那边的。两个时区相同时返回空串——同一个钟报两遍，模型
 * 只会觉得这两个时间在打架。
 */
export const buildUserClockHint = (
  nowMs: number,
  charTz: AmsgTzRef,
  userTz: AmsgTzRef,
  targetName: string,
): string => {
  if (!userTz.tzId || userTz.tzId === charTz.tzId) return '';
  const p = wallClockPartsInZone(nowMs, userTz);
  const target = targetName || '对方';
  return `\n（对方所在时区参考：${target}那边现在是 ${p.month}月${p.day}日 ${timeOfDayWord(p.hour)} ${pad2(p.hour)}:${pad2(p.minute)}。`
    + `你们之间有时差，别拿自己这边的钟去推断 ${target} 此刻醒着还是睡着。）`;
};

/** 「距离用户上次主动发消息……」三档文案；diffMinutes 为 null 表示没有聊天记录。 */
export const formatTimeSinceUser = (diffMinutes: number | null): string => {
  if (diffMinutes == null) {
    return '你们最近没有新的聊天记录。';
  }
  const minutesTotal = Math.max(0, diffMinutes);
  if (minutesTotal < 60) {
    return `距离用户上次主动发消息大约 ${minutesTotal} 分钟。`;
  }
  if (minutesTotal < 1440) {
    const hours = Math.floor(minutesTotal / 60);
    const minutes = minutesTotal % 60;
    return `距离用户上次主动发消息大约 ${hours} 小时${minutes ? ` ${minutes} 分钟` : ''}。`;
  }
  const days = Math.floor(minutesTotal / 1440);
  const hours = Math.floor((minutesTotal % 1440) / 60);
  return `距离用户上次主动发消息大约 ${days} 天${hours ? ` ${hours} 小时` : ''}。`;
};

/** legacyHint 里的「对方已经多久没来」变体，从 timeSinceUser 文案变换而来。 */
export const buildAwayHint = (targetName: string, timeSinceUser: string): string => {
  const target = targetName || '对方';
  if (timeSinceUser.includes('没有新的聊天记录')) return `${target}最近没有主动来找你说话。`;
  // 只借用里面那段时长，句子重新拼——照搬原句换个开头会读成「小明同学已经上次主动发消息大约 9 小时」。
  const span = timeSinceUser.match(/大约 (.+?)。?$/)?.[1];
  return span
    ? `${target}已经大约 ${span} 没主动来找你了。`
    : `${target}最近没有主动来找你说话。`;
};

// ─── self_log：角色自己发出去的那几条 ───

export interface AmsgSelfLogEntry {
  /** 云端即时回复轮次，用于停止后校正已说出口的正文。 */
  taskUuid?: string;
  /**
   * 这条正文属于哪一次触发（`<clientTaskId>@<触发时刻>`）。
   *
   * 有它才能区分「同一次触发重跑」和「真的又发了一条」：fire 抛错会整条重跑
   * （worker 那边重试三次），追加式记录会把同一条消息记好几遍，角色下次读回来
   * 以为自己连发了三条。同 id 覆盖，重跑多少次都只留一条。
   */
  id: string;
  /** 发出去的时刻（epoch ms）。 */
  at: number;
  /**
   * 这一条开始生成的时刻（epoch ms）。两条之间的间隔拿它当锚：排程时比的就是开始时刻，
   * 用发完的时刻比会平白差出一整次生成的时长（接了工具的一次能跑好几分钟）。
   * 老日志里没有它，读的地方退回 at。
   */
  startedAt?: number;
  /** 正文（多段消息拼成一条记，超长截断）。 */
  text: string;
  /**
   * 即时对话的回复（用户刚说了话、这条是在答它）。列进自述块保持连续性，
   * 但不算「主动连发」——带这个标记的条目不会让 unansweredSends 加一。
   */
  reply?: boolean;
}

export interface AmsgSelfLog {
  v: 4;
  /** 写这份日志时云端 fire_pack 的 builtAt，见 AmsgFirePack.builtAt。 */
  basePackAt: number;
  /**
   * 连发记录的锚：entries 与 unansweredSends 记的都是「用户这次开口之后」的事。
   * fire 时发现 lastUserMessageAt 比它新 → 用户开口过 → 两样一起清、锚前进
   * （见 reconcileSelfLogWithPack）。刻意不跟 basePackAt 挂钩：客户端每认领一条
   * 推送就会重传 fire_pack，挂那上面的话计数会被角色自己发的消息洗回零，
   * 连发提醒和上限在用户在线时全部失效——2026-08 炸屏事故的成因之一。
   */
  anchorUserMsgAt: number | null;
  entries: AmsgSelfLogEntry[];
  /**
   * 用户未回复期间角色主动发出的条数（即时对话的回复不算）。
   *
   * 独立成字段，不从 entries 数着数：entries 是给 prompt 看的上下文，只留最近
   * SELF_LOG_MAX_ENTRIES 条，拿它当计数器的话计数永远不会超过那个上限——用户把
   * 连发上限设成 9 或 10 时，「到点兜底闸」的 `计数 >= 上限` 恒为 false，那道专门
   * 为自排链炸屏加的硬闸整个失效。两件事分开记，各自的上限互不干扰。
   */
  unansweredSends: number;
  /**
   * 每天/每周重复的那些任务，在用户没回期间各自响了几次（按任务的 clientTaskId 记）。
   *
   * 「重复的消息连续几次没回就先停」按任务单独算：用户同时排着早安和晚安，一天没回
   * 不该让两条互相消耗额度。跟 unansweredSends 同生同死——用户一开口一起清零。
   * 可选字段：写这份日志的老 worker 没有它，读到时当作全是 0。
   */
  recurringSends?: Record<string, number>;
  /**
   * 角色在这几次 fire 里给自己排下的任务（客户端还不知道它们存在）。
   *
   * 用途是让下一次 fire 的排程清单完整：fire_pack.pendingTasks 是打包那一刻的快照，
   * 之后角色自己排的都不在里面。没有这份的话，角色排完一条、下次到点又看不见它，
   * 很容易把同一件事再排一遍。
   *
   * 客户端上线重放 directive 之后，这些任务会进它的本地清单，下次同步就随
   * fire_pack.pendingTasks 一起上来——只有已经出现的同 UUID 条目才从备账移除，
   * 未认领的仍保留（见 reconcileSelfLogWithPack）。
   */
  tasks: ActiveMsg2TaskRecord[];
}

/**
 * entries 最多留几条。再往前的对角色接话没帮助，只是白占 prompt。
 *
 * 这个上限**只管 prompt 上下文**：连发条数记在 unansweredSends 上，不受它压。
 */
export const SELF_LOG_MAX_ENTRIES = 8;
/** 单条正文留多长。主动消息本来就一两句，超出的部分基本是标签和长引用。 */
export const SELF_LOG_TEXT_MAX = 200;
/**
 * 即时对话的回复留多长。回复可以是好几段长话，而下一条定时消息到点时，客户端多半还没把
 * 带着这条回复的聊天记录传上来——角色只能从这里读到自己刚说过什么，截短了就接不上话。
 */
export const SELF_LOG_REPLY_TEXT_MAX = 1500;

export const createSelfLog = (basePackAt: number, anchorUserMsgAt: number | null = null): AmsgSelfLog => ({
  v: 4,
  basePackAt,
  anchorUserMsgAt,
  entries: [],
  unansweredSends: 0,
  recurringSends: {},
  tasks: [],
});

/**
 * 连发计数：用户未回复期间角色主动发出的条数（即时对话的回复不算）。
 *
 * 读的是 unansweredSends 这个独立计数器，不数 entries——entries 只留最近 8 条，
 * 数它的话计数封顶在 8，用户设的 9 / 10 两档就等于「不限」（见 AmsgSelfLog）。
 */
export const countUnansweredSends = (log: AmsgSelfLog | null): number =>
  log ? log.unansweredSends : 0;

/**
 * fire 开场把云端存的自述日志对齐到本次的 fire_pack 与用户发言状态。两段各管各的生死：
 *
 * - entries + unansweredSends（连发记录）只认「用户开口了」：lastUserMessageAt 比锚新
 *   就一起清零、锚前进。fire_pack 换代**不**清它们——换代多半只是客户端认领了角色自己
 *   发的推送（打脏重传），计数要是跟着清，连发提醒和上限在用户在线时就永远不会生效。
 * - tasks（自排任务备账）按 pack.pendingTasks 中的 UUID 逐项去重；单纯换代
 *   不代表客户端已收下排程结果，不能清空尚未认领的任务。
 */
export const reconcileSelfLogWithPack = (
  stored: AmsgSelfLog | null,
  pack: AmsgFirePack,
  lastUserMessageAt: number | null,
): AmsgSelfLog => {
  let log = stored ?? createSelfLog(pack.builtAt, lastUserMessageAt);
  if (lastUserMessageAt != null
    && (log.anchorUserMsgAt == null || lastUserMessageAt > log.anchorUserMsgAt)) {
    log = { ...log, anchorUserMsgAt: lastUserMessageAt, entries: [], unansweredSends: 0, recurringSends: {} };
  }
  if (log.basePackAt !== pack.builtAt) {
    // 只有快照里明确带回的 uuid 才代表客户端已认领；打包时间本身不是回执。
    const adopted = new Set(pack.pendingTasks.map(task => task.taskUuid));
    log = { ...log, basePackAt: pack.builtAt, tasks: log.tasks.filter(task => !adopted.has(task.taskUuid)) };
  }
  return log;
};

/** 某条重复任务在用户没回期间已经响了几次。 */
export const countRecurringSends = (log: AmsgSelfLog | null, clientTaskId: string): number =>
  (clientTaskId && log?.recurringSends?.[clientTaskId]) || 0;

/** 重复任务这一次真发出去了：给它的计数加一。 */
export const bumpRecurringSend = (log: AmsgSelfLog, clientTaskId: string): AmsgSelfLog => {
  if (!clientTaskId) return log;
  const counts = log.recurringSends ?? {};
  return { ...log, recurringSends: { ...counts, [clientTaskId]: (counts[clientTaskId] ?? 0) + 1 } };
};

/** 记下角色刚给自己排的任务（同 uuid 覆盖，fire 重跑不会记重）。 */
export const appendSelfLogTask = (log: AmsgSelfLog, task: ActiveMsg2TaskRecord): AmsgSelfLog => ({
  ...log,
  tasks: [...log.tasks.filter((t) => t.taskUuid !== task.taskUuid), task],
});

/**
 * 追加一条（同 id 覆盖、正文截断、entries 只留最近 SELF_LOG_MAX_ENTRIES 条）。
 * 空正文原样返回。
 *
 * 连发计数在这里 +1，但两种情况不算：即时对话的回复（reply，是在答用户刚说的话），
 * 以及同 id 的重复追加（fire 抛错整条重跑时同一条消息会再记一次，不能算成又发了一条）。
 */
export const appendSelfLogEntry = (log: AmsgSelfLog, entry: AmsgSelfLogEntry): AmsgSelfLog => {
  const text = entry.text.trim().slice(0, entry.reply ? SELF_LOG_REPLY_TEXT_MAX : SELF_LOG_TEXT_MAX);
  if (!text) return log;
  const alreadyLogged = log.entries.some((e) => e.id === entry.id);
  const kept = log.entries.filter((e) => e.id !== entry.id);
  return {
    ...log,
    entries: [...kept, { ...entry, text }].slice(-SELF_LOG_MAX_ENTRIES),
    unansweredSends: log.unansweredSends + (entry.reply || alreadyLogged ? 0 : 1),
  };
};

export const parseSelfLog = (value: string): AmsgSelfLog | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && typeof parsed === 'object' && parsed.v === 4
      && typeof parsed.basePackAt === 'number'
      && (parsed.anchorUserMsgAt === null || typeof parsed.anchorUserMsgAt === 'number')
      && typeof parsed.unansweredSends === 'number'
      && (parsed.recurringSends === undefined
        || (!!parsed.recurringSends && typeof parsed.recurringSends === 'object'))
      && Array.isArray(parsed.tasks)
      && Array.isArray(parsed.entries)
      && parsed.entries.every((e: unknown) => {
        const entry = e as Partial<AmsgSelfLogEntry> | null;
        return !!entry && typeof entry.id === 'string'
          && typeof entry.at === 'number' && typeof entry.text === 'string';
      })
    ) {
      return parsed as AmsgSelfLog;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

/**
 * 「多久之前」的自然写法。一天之内用相对口径——「3分钟前」比「13:05」更能让模型
 * 看见发送频率本身（连发提醒的主要信息量就在这）；更久的退回按角色时区的绝对时刻。
 */
const formatAgo = (atMs: number, nowMs: number, tz: AmsgTzRef): string => {
  const diff = nowMs - atMs;
  if (diff < 60_000) return '刚刚';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}小时前`;
  return formatFireTimeShort(atMs, tz);
};

/**
 * 渲染进 AMSG_SLOT_SELF_LOG 的那一段。没有可写的就返回空串（槽位被抹掉，模板跟没这回事一样）。
 *
 * 开头两个空行是刻意的：槽位紧接在对话记录最后一行后面，不空开的话这段会黏成聊天记录的续行。
 *
 * 结尾那行连发计数是软提醒的主体：把「已连发几条 / 上限几条」摆在几条相对时间戳的正下方，
 * 模型看到的是频率事实而不是一句抽象劝告。硬拦不在这（见 worker 的排程工具闸与到点兜底闸）。
 */
export const renderSelfLogBlock = (
  log: AmsgSelfLog | null,
  nowMs: number,
  tz: AmsgTzRef,
  maxUnanswered: number = DEFAULT_MAX_UNANSWERED_SENDS,
): string => {
  if (!log || log.entries.length === 0) return '';
  // 正文只渲染还没进【最近对话上下文】的那些（发出时刻晚于本次 fire_pack 打包时刻）；
  // 更早的条目客户端已经写进聊天记录、随新转写回来了，这里再抄一遍就是同一段话出现两次。
  // 计数不跟着过滤——连发额度问的是「用户没回期间总共发了几条」，跟正文在哪无关。
  const fresh = log.entries.filter((e) => e.at > log.basePackAt);
  const sends = countUnansweredSends(log);
  // 说实话：到上限之后自排的那几条到点是**跳过**，不补发（一次性的当场就没了）。
  // 写成「暂停、回复后恢复」的话，角色会以为排着的话迟早会说出去，照样许诺。
  const limitHalf = Number.isFinite(maxUnanswered)
    ? `，上限 ${maxUnanswered} 次，到上限后你自己排的后续到点会直接跳过、不补发，等对方回复才重新计数`
    : '';
  if (fresh.length === 0) {
    if (sends === 0) return '';
    // 正文都在转写里了，这里只补频率事实。
    return [
      '',
      '',
      `（对方未回应期间你已连着主动找了对方 ${sends} 次${limitHalf}。别把已经说过的话换个说法再讲一遍。）`,
    ].join('\n');
  }
  // 回复和主动发的分开写：回复是在答对方刚说的话，对方看到了；主动发的那几条才是
  // 「对方还没回」。混在一个标题下，角色会把刚答完的话当成没人理的独白。
  const replies = fresh.filter((e) => e.reply);
  const proactive = fresh.filter((e) => !e.reply);
  const line = (e: AmsgSelfLogEntry) => `- ${formatAgo(e.at, nowMs, tz)}　${e.text}`;
  const out: string[] = ['', ''];
  if (replies.length > 0) {
    out.push(
      '【这之后你回了对方】',
      ...replies.map(line),
      '（这是你对上面对话里对方最后那几句的回复，对方已经看到了。往下说的时候接着它，别重复。）',
    );
  }
  if (proactive.length > 0) {
    if (replies.length > 0) out.push('');
    out.push(
      '【这之后你又发过（对方还没回）】',
      ...proactive.map(line),
      sends >= 1
        ? `（对方一直没回应，你已连着主动找了对方 ${sends} 次${limitHalf}。往下接着说，别把已经说过的话换个说法再讲一遍，也别假装这些没发生过。）`
        : '（这几条是你发出去的，对方还没回应。往下接着说，别把已经说过的话换个说法再讲一遍，也别假装这些没发生过。）',
    );
  } else if (sends >= 1) {
    // 主动发的那几条正文都在转写里了，这里只补频率事实。
    out.push(`（对方未回应期间你已连着主动找了对方 ${sends} 次${limitHalf}。别把已经说过的话换个说法再讲一遍。）`);
  }
  return out.join('\n');
};

/**
 * 填进 AMSG_SLOT_LIVE_CHAT 的那一行。对方最后一次开口在 LIVE_CHAT_WINDOW_MS 之内才有，
 * 自带前导换行；否则是空串。只说相对的「多久前」，不报钟点——关了时间感知的角色也照给。
 */
export const renderLiveChatLine = (
  targetName: string,
  lastUserMessageAt: number | null,
  nowMs: number,
): string => {
  if (lastUserMessageAt == null) return '';
  const diff = nowMs - lastUserMessageAt;
  if (diff < 0 || diff >= LIVE_CHAT_WINDOW_MS) return '';
  const ago = diff < 60_000 ? '刚刚' : `${Math.floor(diff / 60_000)} 分钟前`;
  return `\n你们此刻正聊着：${targetName || '对方'}${ago}还在跟你说话。`;
};

const fillSlot = (text: string, slot: string, value: string) => text.split(slot).join(value);

/**
 * 用 nowMs 时刻的时间信息填掉模板里的全部槽位，得到最终可发给 LLM 的 prompt。
 * taskInstruction 由排程时写进任务 metadata（见 activeMsgClient.buildTaskInstruction），
 * worker 读不到就先抛错，所以这里按必填收。
 *
 * 另外两块由调用方现算好传进来（都不传时对应槽位被抹平，输出与没有这回事时一致）：
 *   selfLog       这份上下文之后角色自己发过什么，先用 reconcileSelfLogWithPack 对齐过；
 *   taskListBlock 「你现在还挂着哪些排程」那一段，见 amsg2Tasks.buildFireTaskListBlock。
 *   文案住在 amsg2Tasks 而不是这里：那边已经有一整套给人看的任务描述（面板、
 *   排程现状块、list 工具共用），同一件事不该有第二套说法。
 *   realtimeWorldBlock 到点现拉的节日 / 天气 / 热搜，见 realtimeWorldCore.renderRealtimeWorldBlock。
 *
 * extras.includeClock 不是一块内容而是个渲染开关：角色的「时间感知」关掉时传 false，
 * 「此刻在做什么」那段就不报钟点（见 renderFireSceneBlock）。取值与今日节日同源，
 * 都来自 tool_pack.timeAwarenessEnabled。
 *
 * 连发提醒长在自述块里（renderSelfLogBlock 的计数行），上限由调用方按用户设置解析好传进来
 * （extras.maxUnansweredSends，见 amsgLimits；不传用默认值）。
 */
export const renderFirePack = (
  pack: AmsgFirePack,
  nowMs: number,
  taskInstruction: string,
  extras?: {
    selfLog?: AmsgSelfLog | null;
    taskListBlock?: string;
    realtimeWorldBlock?: string;
    includeClock?: boolean;
    /** 已解析的连发上限（Infinity = 不限）。 */
    maxUnansweredSends?: number;
    /**
     * 到点时已知的对方最后一次开口。打包之后对方又说过话（在场记录比包新）时由调用方
     * 传进来；不传用包里那份。
     */
    lastUserMessageAt?: number | null;
  },
): string => {
  const tz: AmsgTzRef = { tzId: pack.tzId };
  const currentTime = formatFireTimeFull(nowMs, tz);
  const lastUserMessageAt = extras?.lastUserMessageAt !== undefined
    ? extras.lastUserMessageAt
    : pack.lastUserMessageAt ?? null;
  const diffMinutes = lastUserMessageAt == null
    ? null
    : Math.max(0, Math.floor((nowMs - lastUserMessageAt) / 60_000));
  const timeSinceUser = formatTimeSinceUser(diffMinutes);
  const awayHint = buildAwayHint(pack.targetName, timeSinceUser);

  let out = pack.template;
  out = fillSlot(out, AMSG_SLOT_CURRENT_TIME, currentTime);
  // 对方那边的钟：跟上面那行是两个主体各自的时间，文案里各自写清主语（见 buildUserClockHint）。
  out = fillSlot(out, AMSG_SLOT_USER_CLOCK, buildUserClockHint(nowMs, tz, { tzId: pack.userTzId }, pack.targetName));
  out = fillSlot(out, AMSG_SLOT_TIME_SINCE_USER, timeSinceUser);
  out = fillSlot(out, AMSG_SLOT_AWAY_HINT, awayHint);
  out = fillSlot(out, AMSG_SLOT_TASK_INSTRUCTION, taskInstruction);
  out = fillSlot(out, AMSG_SLOT_SELF_LOG, renderSelfLogBlock(
    extras?.selfLog ?? null, nowMs, tz, extras?.maxUnansweredSends ?? DEFAULT_MAX_UNANSWERED_SENDS,
  ));
  out = fillSlot(out, AMSG_SLOT_LIVE_CHAT, renderLiveChatLine(pack.targetName, lastUserMessageAt, nowMs));
  out = fillSlot(out, AMSG_SLOT_TASK_LIST, extras?.taskListBlock ?? '');
  out = fillSlot(out, AMSG_SLOT_SCENE, renderFireSceneBlock(pack.scene, nowMs, tz, {
    includeClock: extras?.includeClock !== false,
  }));
  // 实时世界那一段是独立的一整块，前导空行在这里补：拉到东西才隔开成段，
  // 没拉到（或功能没开）填空串，输出跟没有这个槽位时一模一样。
  const realtimeWorld = extras?.realtimeWorldBlock?.trim();
  out = fillSlot(out, AMSG_SLOT_REALTIME_WORLD, realtimeWorld ? `\n\n${realtimeWorld}` : '');
  return out;
};

/**
 * 当前 fire_pack 的版本号。前端打包写它，worker 只认它。
 *
 * 版本不匹配一律整包打回，不做任何形状兼容——两边永远同一次发布上线。
 * 唯一的例外是「说清楚为什么」：见 describeFirePackVersion，worker 拿它拼失败原因，
 * 面板的 lastError 才能直接告诉用户该重贴 bundle 还是该刷新前端。
 */
export const FIRE_PACK_VERSION = 7;

/**
 * 即时对话任务行的 messageSubtype 标签。上游只当自由文本原样透传；客户端两处都认它：
 * 排程时写（activeMsgClient.sendInstantChat）、面板对账时滤（amsg2Tasks 的
 * reconcileTasksWithRemote——即时对话的行不补进任务清单，不然用户正等着的一轮会显示
 * 成「待触发」，还可能被「取消全部」顺手掐掉）。写读两侧靠这一个常量绑死：它是
 * GET /messages 明文投影里唯一可查的即时对话标记，producer 改个说法 filter 就瞎了。
 */
export const AMSG_INSTANT_CHAT_SUBTYPE = 'instant-chat';

/**
 * 解析失败时给人看的一句原因。
 *
 * 存在的理由：升 fire_pack 版本需要 worker bundle 和前端一起动，而设置页的版本门槛读的是
 * **上游 amsg-server 库**的版本号——只改 SullyOS 自己的 worker 代码时那个号不动，门槛不会亮。
 * 没有这句话的话，用户忘了重贴 bundle 时看到的只有「格式不对或数据损坏」，完全不知道该做什么。
 */
export const describeFirePackVersion = (value: string): string => {
  let v: unknown;
  try { v = JSON.parse(value)?.v; } catch { return '不是合法 JSON（数据损坏）'; }
  if (v === FIRE_PACK_VERSION) return '版本号对得上，是别的字段不合格式（数据损坏）';
  if (typeof v === 'number' && v < FIRE_PACK_VERSION) {
    return `包是 v${v}、worker 要 v${FIRE_PACK_VERSION} —— 前端比 worker 旧，打开一次网页让它重新上传`;
  }
  if (typeof v === 'number') {
    return `包是 v${v}、worker 只认 v${FIRE_PACK_VERSION} —— worker bundle 是旧的，去设置页重新粘贴部署`;
  }
  return '包里没有版本号（数据损坏）';
};

/**
 * 一条消息的正文合不合格：纯文本，或者非空的分段数组、每段带一个字符串 `type`。
 *
 * 只查到 `type` 为止：再往里查就是在这边复刻 chat API 的方言，而这份代码对分段
 * 的内容没有任何主张——它只保证「搬过去的东西还是个消息」。
 */
const chatContentOk = (content: unknown): boolean => {
  if (typeof content === 'string') return true;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((part) => !!part && typeof part === 'object' && !Array.isArray(part)
    && typeof (part as { type?: unknown }).type === 'string');
};

/** chat 字段：不带就是没开即时对话（合法）；带了就必须是完整形状。 */
const chatFieldOk = (chat: unknown): boolean => {
  if (chat === undefined) return true;
  if (!chat || typeof chat !== 'object' || Array.isArray(chat)) return false;
  const { messages, builtAt } = chat as Partial<AmsgFirePackChat>;
  return typeof builtAt === 'number'
    && Array.isArray(messages) && messages.length > 0
    && messages.every((m) => !!m && typeof m === 'object'
      && typeof (m as { role?: unknown }).role === 'string'
      && chatContentOk((m as { content?: unknown }).content));
};

/** worker 侧从 client_state 读回的 value 解析成 fire_pack；形状不对返回 null（调用方抛错）。 */
export const parseFirePack = (value: string): AmsgFirePack | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && typeof parsed === 'object' &&
      parsed.v === FIRE_PACK_VERSION &&
      chatFieldOk(parsed.chat) &&
      typeof parsed.template === 'string' && parsed.template.length > 0 &&
      (parsed.lastUserMessageAt === null || typeof parsed.lastUserMessageAt === 'number') &&
      typeof parsed.tzId === 'string' && parsed.tzId.length > 0 &&
      typeof parsed.userTzId === 'string' && parsed.userTzId.length > 0 &&
      typeof parsed.targetName === 'string' &&
      typeof parsed.builtAt === 'number' &&
      Array.isArray(parsed.pendingTasks) &&
      (parsed.scene === null || typeof parsed.scene === 'object') &&
      typeof parsed.selfScheduleEnabled === 'boolean'
    ) {
      return parsed as AmsgFirePack;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};
