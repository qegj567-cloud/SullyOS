import { deriveUserEncryptionKey, decryptPayload, encryptPayload } from '@rei-standard/amsg-server/cloudflare';
import { INSTANT_INPUT_NAMESPACE } from './instantInput';
/**
 * 即时对话（instant chat）：把「用户按下发送」这一轮聊天当成一条立刻执行的任务。
 *
 * 客户端只发一个请求就自由了——切后台、杀进程都行，生成在这台 worker 里跑完，
 * 结果走 Web Push 回去。这份模块管三件事：
 *   1. `POST /instant-chat` 这条包装层路由（鉴权 → 内部转发 → 202 → 立刻起一跳）
 *   2. 即时对话那条 fire 用的「时效信息」块（当前时间 / 实时世界 / 排程说明拼一起）
 *   3. 推送的通知策略（前台可见时不弹横幅）
 *
 * 为什么要在包装层做而不是让客户端直接调上游的两个端点：两步有严格的先后和
 * 「前面失败就不能落任务」的语义（云端状态没传上去，到点的 fire 读到的还是上一轮的
 * 上下文，角色会对着旧对话回话）。放在客户端串两个请求的话，中间断网就会留下一条
 * 注定答错的任务；放在这里，客户端只有一次「成了 / 没成」。
 *
 * 客户端先加密，包装层用同一租户密钥解开并将输入绑定到唯一记录，再重新加密转发。
 * 上游照常解密、鉴权和校验容量；凭据行仍走独立引用。
 *
 * 零浏览器依赖（这份代码会被打进 worker bundle）。
 */

import {
  AMSG_FIRE_PACK_KEY,
  parseFirePack,
  unpackStateValue,
  amsgStateNamespace,
  buildUserClockHint,
  formatFireTimeFull,
  type AmsgTzRef,
} from '../../../utils/amsgFirePack';
import { TIME_FRAMING_CONVERSATIONAL } from '../../../utils/timeFramingNote';

// ─── 时间参数 ───

/**
 * 即时对话这条 fire 的总时长上限（毫秒），由 onBeforeFire 单条返回、只对即时对话生效。
 *
 * 定时任务那条路仍用库默认的 240s：它到点没跑完还有下一分钟的 cron 接着来，
 * 而用户正盯着「正在输入…」等回复，多给点时间跑完工具循环比让他重发一遍强。
 * 上限压在执行它的那次 invocation 的墙钟预算（DO alarm 和 cron 都是 15 分钟）之内。
 */
export const INSTANT_TOTAL_TIMEOUT_MS = 600_000;

// ─── 任务身份 ───

/** 任务 metadata 里标即时对话的那个键（客户端排任务时写、worker 到点读）。 */
export const AMSG_INSTANT_CHAT_FLAG = 'amsgInstantChat';

/** 这条任务是不是即时对话（客户端刚发完消息在等回复）。 */
export const isInstantChatTask = (metadata: Record<string, unknown> | undefined | null): boolean =>
  !!metadata && metadata[AMSG_INSTANT_CHAT_FLAG] === true;

// ─── fire 时追加的「时效信息」块 ───

/**
 * 即时对话的请求消息 = 客户端打包的那串对话原样 + 末尾追加这一块。
 *
 * 追加而不是重渲染模板：这一轮要答的是用户刚说的话，本地生成那条路发出去的是什么，
 * 云端就该发一模一样的，不然同一句话在两条路上会得到两种口吻。时效内容（现在几点、
 * 外面在下雨、还挂着哪些排程）只有到点才知道，所以留到这里补。
 *
 * blocks 里的每一块自带前导空行 / 分隔线（各自的渲染函数已经处理），空串直接跳过。
 */
export const buildInstantTimelyBlock = (args: {
  nowMs: number;
  tz: AmsgTzRef;
  userTzId: string;
  targetName: string;
  /**
   * 角色的「时间感知」开关（tool_pack.timeAwarenessEnabled）。关掉的角色在前台连今天
   * 几号都读不到，云端这条路也一个钟都不给——两条路是同一个开关，不能各行其是。
   * 主动消息那条路的做法一样（打包时时间行整段不进模板，见 activeMsgClient 的 timeAware）。
   */
  timeAwarenessEnabled: boolean;
  /** 其余按顺序拼上去的块：实时世界、自述日志、排程清单、MCP、给自己排下一条。 */
  blocks: string[];
}): string => {
  const blocks = args.blocks.filter((block) => block.trim());
  // 关了时间感知、其余几块又都是空的（没日程没排程没 MCP、实时世界也没拉到）——
  // 这一块就没有任何内容可说了，整块不要。空块整块跳过是这里一贯的做法，只剩一行
  // 光秃秃的标题挂在对话末尾，模型只会当成没说完的乱码。
  if (!args.timeAwarenessEnabled && blocks.length === 0) return '';
  const head = args.timeAwarenessEnabled
    ? [
        '【此刻的系统信息·仅你可见】',
        `现在是 ${formatFireTimeFull(args.nowMs, args.tz)}。`,
        // 报时后面跟那句语境框定，跟前台聊天引的是同一份常量。这一轮是用户刚按下发送、
        // 正等着回复，所以「对方还在跟你说话」是真的；少了它，深夜的那行钟就够让角色
        // 每轮都往「快睡吧、明天见」上收——本地那条路修好了、云端没修的话，同一个角色
        // 在两条路上的分寸会不一样。
        TIME_FRAMING_CONVERSATIONAL,
        // buildUserClockHint 自带前导换行，没时差时返回空串。
        buildUserClockHint(args.nowMs, args.tz, { tzId: args.userTzId }, args.targetName),
      ].join('\n')
    : '【此刻的系统信息·仅你可见】';
  return [head, ...blocks].join('\n');
};

// ─── 通知策略 ───

/**
 * 推了就一定弹（SW 的 shouldRenderNotification 认这个值）。
 *
 * 订阅是按 `userVisibleOnly: true` 建的，等于跟浏览器约好每条 push 都给用户一次可见
 * 反馈；收了 push 却不弹是违约，Firefox 按配额把订阅退掉，iOS 过了新订阅那几天宽限期
 * 一条就吊销，而且两边都是静默发生的——服务端只看得到后续推送返回 410。所以口径只有
 * 两档：要推就一定弹，不想弹就压根别推（内容落服务端收件箱，等客户端上线补拉）。
 * 即时对话是用户按下发送、正盯着「正在输入…」等的那一轮，必须推，于是选「一定弹」。
 */
const NOTIFICATION_ALWAYS = 'always';

/**
 * 静音只在用户看得见页面的那一刻生效（SW 的 resolveNotificationSilent 认这个值）。
 *
 * 用户正盯着聊天窗口时页面自己会把回复画上屏，横幅再响一声纯属打扰；切后台、锁屏、
 * 关了标签页的那一刻则必须响，不然没人来叫他。判定得等到 SW 收到这条 push 才做——
 * worker 在发推那一刻并不知道用户此刻在不在前台，写死 `silent: true` 的结果是切后台
 * 也不响。
 *
 * 老 SW 不认这个字符串，会按 `Boolean('when-visible')` 算成恒静音，也就是退回这档
 * 能力上线之前的行为，不会弹错也不会漏弹。
 */
export const NOTIFICATION_SILENT_WHEN_VISIBLE = 'when-visible';

/**
 * 通知栏折叠用的 tag：同一个角色永远只留最新那一条。
 *
 * 一次回复常常分成好几段推，逐条弹会把通知栏刷满；同 tag 的通知互相覆盖，看到的就只有
 * 最新一条。即时对话的失败通知也用这个 tag（见 index.ts 的 sendInstantErrorPush）：
 * 同一个角色的最新状态本来就只该留一条，成功的回复把之前那条「没能生成」盖掉正合适。
 */
export const instantNotificationTag = (charId: string) => `amsg-instant-${charId}`;

/**
 * 给即时对话的推送载荷表态通知策略：一定弹，按角色折叠，前台安静、后台叫人。
 *
 * 打扰不靠「不弹」来压，靠另外三个字段：
 *   - `tag`      同一个角色只在通知栏留最新一条；
 *   - `silent`   `when-visible`，用户看着页面时不响，切后台就照常响铃震动；
 *   - `renotify` 只给这一轮的第一段。同 tag 的通知默认是静默替换，上一轮的横幅还
 *                躺在通知栏没点掉时，新一轮的第一段就会被当成替换而不出声——那正是
 *                用户会说「有时候响有时候不响」的那种情况。一轮响一声：第一段重新
 *                提醒，后面几段安静地把内容更新掉。
 *
 * 只给即时对话用——主动消息是「到点找人说话」，那条路要响铃叫人，既不折叠也不静音。
 *
 * 载荷本来就没有 notification 时不凭空造一个：SW 拿不到 title / body 只能弹一条空白
 * 横幅，而「没有 notification」这件事本身在 SW 那边有按 messageKind 的默认行为，
 * 替它做主只会把默认行为弄坏。
 *
 * 信封的其余部分（messageId / sessionId / 时间戳 / 段号 / 任务身份）一律交给库去补——
 * 客户端补收现在读的是服务端账本，账本里的那份就是库发出去的那份，没有第二处需要
 * 逐字对齐的副本了。
 */
export const applyInstantNotificationPolicy = (
  payload: Record<string, unknown>,
  charId?: string | null,
  isFirstSegment = false,
): Record<string, unknown> => {
  const notification = payload.notification;
  const hasNotification = !!notification && typeof notification === 'object' && !Array.isArray(notification);
  if (!hasNotification) return payload;
  const meta = payload.metadata;
  const metaCharId = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).charId
    : undefined;
  const target = charId || (typeof metaCharId === 'string' ? metaCharId : '');
  return {
    ...payload,
    notification: {
      ...(notification as Record<string, unknown>),
      show: NOTIFICATION_ALWAYS,
      silent: NOTIFICATION_SILENT_WHEN_VISIBLE,
      // 认不出是哪个角色时就不折叠：通知栏里多几条只是吵，两个角色共用一个 tag 会
      // 互相顶掉，那是真的丢消息。renotify 跟着 tag 走——没有 tag 时带上它，
      // showNotification 会直接抛 TypeError。
      ...(target
        ? { tag: instantNotificationTag(target), ...(isFirstSegment ? { renotify: true } : {}) }
        : {}),
    },
  };
};

// ─── POST /instant-chat ───

/**
 * 上游 worker 里这条路用得到的入口（注入进来只为单测能替身）。
 *
 * 只有 fetch：这条路做的是「转发两个加密信封」，跑任务是 DO 那边的事
 * （`upstream.runTask`，见 index.ts 的 InstantTickDO）。
 */
export interface InstantChatUpstream {
  fetch(request: Request, env: unknown): Promise<Response>;
}

/**
 * 起跳用的 Durable Object namespace binding（`INSTANT_TICK`）。
 *
 * 只声明这里真正会调的两个方法：包装层不需要完整的 DO 类型，单测也就能拿个字面量当替身。
 */
export interface InstantTickNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { kick(uuid: string): Promise<unknown> };
}

interface InstantChatEnv {
  AMSG_SERVER_TOKEN?: string;
  AMSG_MASTER_KEY?: string;
  /** 没有它就没法起跳；老版本 Worker 上是 undefined，见 kickInstantTick。 */
  INSTANT_TICK?: InstantTickNamespace;
}

export type InstantTickKickResult =
  | { ok: true }
  | { ok: false; reason: 'missing-binding' }
  | { ok: false; reason: 'kick-failed'; error: unknown };

/**
 * 叫醒 DO，让它把刚落库的这条立刻捡走。
 *
 * 这一跳过去挂在 `ctx.waitUntil` 上，而那个只有 30 秒——响应发出（或客户端断开）
 * 之后就开始倒计时，一轮带工具循环的生成必被砍在半路，日志里只留一条
 * 「waitUntil() tasks did not complete」。DO 的 alarm 是独立 invocation，
 * 拿满 15 分钟墙钟，跟这个已经回了 202 的请求彻底脱钩，才对得上
 * INSTANT_TOTAL_TIMEOUT_MS 一直以来的设计意图。
 *
 * **一条任务一个 DO 实例**（实例名就是任务 uuid）：每个实例只跑自己那一条
 * （`upstream.runTask(uuid)`），所以几条聊天同时在跑也互不排队、更不会重复生成。
 * 这依赖上游 2.6.0-next.16 起的 runTask——在那之前只有「扫一遍所有到期任务」，
 * 多实例并发扫同一批会各生成一次，只能退回单实例串行。
 *
 * 两种失败分开报，因为要用户做的事完全不同：binding 压根不在 = Worker 是旧的，
 * 得去更新；叫醒失败 = 临时故障，任务已经在库里，下一分钟的 cron 会捡。
 */
export const kickInstantTick = async (env: unknown, uuid: string): Promise<InstantTickKickResult> => {
  const namespace = (env as InstantChatEnv | null | undefined)?.INSTANT_TICK;
  if (!namespace || typeof namespace.get !== 'function' || typeof namespace.idFromName !== 'function') {
    return { ok: false, reason: 'missing-binding' };
  }
  try {
    await namespace.get(namespace.idFromName(uuid)).kick(uuid);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'kick-failed', error };
  }
};

/** 上游的 UUID v4 判定（照抄它的正则，前端拿同一个 X-User-Id 跑两边）。 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 常时比较（照抄上游 constantTimeEqual 的做法）：两边各做一次随机密钥的 HMAC 再逐字节比，
 * 长度和内容都不会从耗时上漏出来。
 */
export const constantTimeEqual = async (a: string, b: string): Promise<boolean> => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const da = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(a)));
  const db = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i += 1) diff |= da[i] ^ db[i];
  return diff === 0;
};

// ─── 上游那句「服务器内部错误」背后到底出了什么事 ───

/**
 * 从上游的错误响应体里取出真实原因，拼成一行给用户看的话。
 *
 * 上游 catch 到异常后回的是一句写死的「服务器内部错误」，光凭它用户既不知道哪儿坏了、
 * 也不知道该点哪里。真因（`D1_ERROR: no such table: message_outbox`、
 * `D1 DB storage operation exceeded timeout` 之类）由 amsg-server 2.6.0-next.16 起
 * 放在 `error.cause` 里一并回来，取出来原样端到用户面前。
 *
 * 只在 5xx 上取：4xx 是「你请求不对」，上游的 message 本身就说清楚了，再缀一段
 * 内部细节只会让人更迷惑。
 *
 * 拼进 `upstreamLog` 而不是新起一个字段：这条链路的消费方（activeMsgClient 组装
 * 用户可见报错时）读的就是它。
 */
const readUpstreamCause = (status: number, body: unknown): string | null => {
  if (status < 500) return null;
  const cause = (body as { error?: { cause?: { name?: unknown; message?: unknown; code?: unknown } } } | null)
    ?.error?.cause;
  if (!cause) return null;
  const name = typeof cause.name === 'string' ? cause.name : '';
  const message = typeof cause.message === 'string' ? cause.message : '';
  const code = typeof cause.code === 'string' ? cause.code : '';
  // 前缀只在能多说明一点事情的时候才加：
  //   code 常常就是 message 的开头（`D1_ERROR: no such table …`），再缀一遍是噪音；
  //   没有 code 时退回 name，但光秃秃的 'Error' 谁都知道，不如不写。
  const head = code
    ? (message.startsWith(code) ? '' : code)
    : (name && name !== 'Error' ? name : '');
  return [head, message].filter(Boolean).join(': ') || null;
};

// ─── 云端状态那一步的重试 ───

/**
 * `PUT /client-state` 每次重试前等多久（数组长度即总尝试次数，首次不等）。
 *
 * 为什么这一步要重试：D1 偶尔会把一次写直接判超时（`D1 DB storage operation exceeded
 * timeout which caused object to be reset`），这一步又是整条链上最大的一次写（三十多 KB
 * 的 fire_pack），撞上的机会最多。用户侧的表现是好端端一句话发不出去，还得自己重发。
 *
 * 什么时候会来，2026-08-09 查过一次，没找出规律。两次失败都是「隔了几小时的第一句话」，
 * 看着像库凉了，但当时量到的两个数都不支持这个说法：
 *
 *   1. 库那会儿不凉。cron 是 `* * * * *`，每一跳都在查 D1。失败发生在 00:50:07，
 *      而 00:49:57 那一跳**刚查过库，隔了 10 秒**。
 *   2. 也不像是包太大。失败那轮的 fire_pack 是 34 KB，当天 09:13 成功那轮反而是 36 KB。
 *
 * 就这两个数看，「提前读一下把库焐热」没有着力点，所以先按瞬时错误处理、当场重试。样本只有
 * 两次，D1 那边的行为以后也可能变——要是以后又出现「隔久了必挂」的规律，照着上面两条重新
 * 量一遍（失败前最近一次 cron 隔了多久、失败与成功两轮的包各多大），结论可能就不一样了。
 *
 * **当场重试，不是等下一跳 cron**：这一步失败时任务行还没落库，cron 那边什么都捡不到
 * （「状态没落地就不落任务」是这条两步串行存在的意义）。所以只有这把梯子，走完还不成
 * 就明确告诉用户这条没发出去、让他重发。最坏多花 1.6 秒，正常一次就过、一点不等。
 *
 * 客户端本来有一模一样的一把梯子（activeMsgClient 的 CLIENT_STATE_BACKOFF_MS），
 * 但它护的是常规状态同步；即时对话这条路上客户端只 POST 一次 /instant-chat，那把梯子
 * 就够不着里面这一跳了。补在这儿，两条路才一样稳。
 *
 * 只重这一步：它是按 (namespace, key) 的 upsert，重跑一次等于把同样的值再写一遍，
 * 没有副作用。下一步的建任务不重——那一步失败重跑可能建出两条任务。
 */
const STATE_FORWARD_BACKOFF_MS = [0, 400, 1200];

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** gzip 流的头两个字节（RFC 1952）。压没压过看这个，不看那个头。 */
const GZIP_MAGIC = [0x1f, 0x8b];

/**
 * 把请求正文读成字符串，`Content-Encoding: gzip` 的在这一步还原。
 *
 * 跟上游 `readRequestBody` 认同一个头（客户端只有一个请求出口，两边端点得收同一种
 * 东西），但这份是自己写的：上游那个函数住在 `@rei-standard/amsg-server` 包根，而包根
 * 顶层 import 了 Node 的 `crypto`，这个 worker 是明确不开 `nodejs_compat` 的。
 *
 * 判据是**魔数不是头**。`Content-Encoding` 是标准头，链路上的边缘节点会替你把请求体
 * 解开却把头留着（SullyOS 实测遇到过）——只看头的话，这种时候会拿明文去喂解压器，报出来是一句让人找不着北的
 * 「请求体不是合法的 JSON」。看魔数则三种情形都对：没解过的解开、替我们解过的原样读、
 * 压根没压的原样读。
 */
const readMaybeGzippedBody = async (request: Request): Promise<string> => {
  if ((request.headers.get('content-encoding') ?? '').toLowerCase() !== 'gzip') {
    return request.text();
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length < 2 || raw[0] !== GZIP_MAGIC[0] || raw[1] !== GZIP_MAGIC[1]) {
    return new TextDecoder().decode(raw);
  }
  const stream = new Response(raw).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
};

/** 客户端预加密的信封形状（上游 parseEncryptedBody 认的就是这三个字段）。 */
const isEncryptedEnvelope = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const env = value as Record<string, unknown>;
  return typeof env.iv === 'string'
    && typeof env.authTag === 'string'
    && typeof env.encryptedData === 'string';
};

/**
 * `POST /instant-chat` 的处理：鉴权 → 严格顺序转发 → 202 → 立刻起一跳。
 *
 * 顺序不能换：云端状态先落地，任务才允许存在。反过来的话，状态那一步失败时 D1 里
 * 已经躺着一条注定拿旧上下文答话的任务，而且没人拦得住它。带了 credPayload 的话，
 * 凭据行同样要在建任务之前覆盖好。
 *
 * 任务体带 `immediate: true`（客户端 sendInstantChat 固定写）：上游落库即到期，
 * 202 之后的那一跳直接就能捡走；顶替上一条也在任务体里（`supersedesUuid`，
 * 上游在建新任务的同一事务里取消旧的），包装层不再有第二条取消请求。
 */
export const handleInstantChat = async (args: {
  request: Request;
  env: InstantChatEnv;
  upstream: InstantChatUpstream;
  /** 带 CORS 头的 JSON 响应器（CORS 头只在 index.ts 存一份）。 */
  json: (status: number, body: unknown) => Response;
  /** 云端状态那步的重试梯子（单测传全零，别真等）。 */
  stateBackoffMs?: number[];
}): Promise<Response> => {
  const { request, env, upstream, json } = args;
  const stateBackoffMs = args.stateBackoffMs ?? STATE_FORWARD_BACKOFF_MS;

  const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>) =>
    json(status, { success: false, error: { code, message, ...(extra ?? {}) } });

  // ── 鉴权：跟上游同一套判据。上游转发时还会再验一次（它才是权威），
  //    这里先挡一道是为了「口令不对」时一个字节的云端状态都别写进去。
  const token = (env.AMSG_SERVER_TOKEN ?? '').trim();
  const clientToken = request.headers.get('X-Client-Token') ?? '';
  if (token) {
    if (!clientToken || !(await constantTimeEqual(clientToken, token))) {
      return fail(401, 'INVALID_CLIENT_TOKEN', '共享密钥无效或缺失');
    }
  }
  const userId = request.headers.get('X-User-Id') ?? '';
  if (!userId) return fail(400, 'USER_ID_REQUIRED', '缺少用户标识符');
  if (!UUID_V4_RE.test(userId)) return fail(400, 'INVALID_USER_ID_FORMAT', 'X-User-Id 必须是 UUID v4 格式');

  // ── 外壳是明文 JSON，里头两个信封是客户端加密好的。
  //    body 超阈值时客户端会先 gzip 再发（这条路上的正文是整轮聊天，最大的一份），
  //    所以读之前先过一道解压。
  let body: Record<string, unknown>;
  try {
    const text = await readMaybeGzippedBody(request);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, 'INVALID_JSON', '请求体不是合法的 JSON 对象');
  }
  if (!isEncryptedEnvelope(body.statePayload)) {
    return fail(400, 'INVALID_STATE_PAYLOAD', 'statePayload 必须是加密信封（iv / authTag / encryptedData）');
  }
  if (!isEncryptedEnvelope(body.taskPayload)) {
    return fail(400, 'INVALID_TASK_PAYLOAD', 'taskPayload 必须是加密信封（iv / authTag / encryptedData）');
  }
  if (body.credPayload !== undefined && !isEncryptedEnvelope(body.credPayload)) {
    return fail(400, 'INVALID_CRED_PAYLOAD', 'credPayload 必须是加密信封（iv / authTag / encryptedData）');
  }

  // 绑定不可变输入后再写任何共享状态。旧客户端也走这条转换，凭据仍独立热更新。
  let inputKey = '';
  try {
    if (!env.AMSG_MASTER_KEY) throw new Error('Worker 缺少 AMSG_MASTER_KEY');
    const key = await deriveUserEncryptionKey(userId, env.AMSG_MASTER_KEY);
    const [state, task] = await Promise.all([
      decryptPayload(body.statePayload as any, key), decryptPayload(body.taskPayload as any, key),
    ]);
    const charId = task?.metadata?.charId;
    if (typeof charId !== 'string' || !charId || !Array.isArray(state?.entries)) throw new Error('缺少角色状态');
    const inputEntry = state.entries.find((entry: any) => entry.namespace === amsgStateNamespace(charId) && entry.key === AMSG_FIRE_PACK_KEY);
    const firePack = inputEntry && typeof inputEntry.value === 'string'
      ? parseFirePack(await unpackStateValue(inputEntry.value)) : null;
    if (!firePack?.chat) throw new Error('即时输入缺少有效 fire_pack.chat');
    inputKey = crypto.randomUUID();
    task.taskInput = {
      firePackRef: { namespace: INSTANT_INPUT_NAMESPACE, key: inputKey },
      firePackUpdatedAt: inputEntry.updatedAt,
    };
    // 完整输入仍走 5 MiB 大值分块，不塞进不到 1 MiB 的任务行。每次受理独立 key，
    // 凭据或排任务失败只留下可过期清理的孤儿，不会改掉旧任务或旧客户端读的 shared chat。
    state.entries = state.entries.filter((entry: any) => entry !== inputEntry);
    state.entries.push({
      ...inputEntry, namespace: INSTANT_INPUT_NAMESPACE, key: inputKey,
      value: JSON.stringify({ v: 1, charId, packedFirePack: inputEntry.value }),
      owner: { type: 'character', id: charId },
      kind: 'instant-input',
      updatedAt: Date.now(),
    });
    [body.statePayload, body.taskPayload] = await Promise.all([
      encryptPayload(state, key), encryptPayload(task, key),
    ]);
  } catch (error) {
    return fail(400, 'INVALID_INSTANT_INPUT', error instanceof Error ? error.message : '即时输入无法解密');
  }

  // ── 内部转发：路径跟着本次请求的挂载点走（上游按后缀匹配，worker 可能挂在子路径下）。
  const requestUrl = new URL(request.url);
  const mountPath = requestUrl.pathname.replace(/\/+$/, '').replace(/\/instant-chat$/, '');
  const internalUrl = (path: string): string => {
    const url = new URL(request.url);
    url.pathname = `${mountPath}${path}`;
    url.search = '';
    return url.toString();
  };
  // 上游自己的头约定原样带上（含客户端给的口令），它会再验一遍。
  const encryptedHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-Id': userId,
    'X-Payload-Encrypted': 'true',
    'X-Encryption-Version': '1',
    ...(clientToken ? { 'X-Client-Token': clientToken } : {}),
  };

  const readBody = async (response: Response): Promise<unknown> => {
    try { return await response.json(); } catch { return null; }
  };

  /**
   * 转发一个幂等的 upsert，5xx 按梯子重试（见 STATE_FORWARD_BACKOFF_MS）。
   * 4xx 是上游判出来的业务错（体积超限、时间戳不合法……），重试多少次都是同一个答案，立刻打回。
   * 响应体只能读一次，这里读完一起交回：失败分支要拿它报原因，成功分支还要查里面的字段。
   */
  const forwardIdempotentPut = async (path: string, envelope: unknown, label: string) => {
    let response!: Response;
    let responseBody: unknown = null;
    let cause: string | null = null;
    for (let attempt = 0; attempt < stateBackoffMs.length; attempt += 1) {
      if (attempt > 0) {
        console.warn(`[amsg:instant-chat] ${label}第 ${attempt} 次没写进去（${cause ?? response.status}），重试`);
        await sleep(stateBackoffMs[attempt]);
      }
      response = await upstream.fetch(
        new Request(internalUrl(path), {
          method: 'PUT',
          headers: encryptedHeaders,
          body: JSON.stringify(envelope),
        }),
        env,
      );
      responseBody = await readBody(response);
      cause = readUpstreamCause(response.status, responseBody);
      if (response.status < 500) break;
    }
    return { response, body: responseBody, cause };
  };

  // ① 云端状态必须先落地：这一步失败就绝不落任务（否则任务到点会拿旧上下文答话）。
  const {
    response: stateResponse,
    body: stateBody,
    cause: stateCause,
  } = await forwardIdempotentPut('/client-state', body.statePayload, '云端状态');
  if (!stateResponse.ok || (stateBody as { success?: unknown } | null)?.success === false) {
    return json(stateResponse.ok ? 502 : stateResponse.status, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_STATE_FAILED',
        message: '云端状态没传上去，这条没发出去',
        step: 'client-state',
        upstream: stateBody,
        ...(stateCause ? { upstreamLog: stateCause } : {}),
      },
    });
  }
  const rejectedEntries = (stateBody as {
    data?: { rejected?: Array<{ namespace?: unknown; key?: unknown }> };
  } | null)?.data?.rejected;
  if (Array.isArray(rejectedEntries) && rejectedEntries.some(entry =>
    entry.namespace === INSTANT_INPUT_NAMESPACE && entry.key === inputKey)) {
    return fail(409, 'INSTANT_CHAT_STATE_FAILED', '这一轮的输入未能保存，任务没有创建', { step: 'client-state', upstream: stateBody });
  }
  // 本轮输入必须落地。只有它自己的条件写被拒才拦下；其他共享状态仍以各自版本为准。
  const skippedEntries = (stateBody as {
    data?: { skippedEntries?: Array<{ namespace?: unknown; key?: unknown }> };
  } | null)?.data?.skippedEntries;
  if (Array.isArray(skippedEntries) && skippedEntries.some((entry) => entry?.namespace === INSTANT_INPUT_NAMESPACE && entry.key === inputKey)) {
    return json(409, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_STATE_STALE',
        message: '云端拒收了这轮的最新状态（云端已有更新的一份）——设备时钟可能被回拨过，检查系统时间后再发一次',
        step: 'client-state',
      },
    });
  }

  // ② 这一轮的凭据行（credPayload，可选）：每一轮都照客户端给的覆盖一遍，再建任务。
  //    客户端本来靠一份本地「上次传过什么」的底账决定传不传，可那份底账只代表这台设备、
  //    这个浏览器——另一个入口（比如 iOS 上 Safari 和主屏 App 各存各的）或另一台 Worker
  //    改过云端那行时，底账还写着「传过了」，任务就一直拿着别人留下的凭据跑，本地怎么
  //    切 API 都没用。在这里跟任务同一个请求覆盖，云端那行就永远等于这一轮本地用的那份。
  //    写失败同样不落任务：拿着旧凭据答话正是要堵的那种错。
  const credPayload = body.credPayload;
  if (credPayload !== undefined) {
    const {
      response: credResponse,
      body: credBody,
      cause: credCause,
    } = await forwardIdempotentPut('/llm-credentials', credPayload, 'LLM 凭据');
    // 上游有 200 包 success:false 的历史写法，两样一起看。
    if (!credResponse.ok || (credBody as { success?: unknown } | null)?.success === false) {
      return json(credResponse.ok ? 502 : credResponse.status, {
        success: false,
        error: {
          code: 'INSTANT_CHAT_CREDENTIALS_FAILED',
          message: '这一轮的 API 凭据没传上去，这条没发出去',
          step: 'llm-credentials',
          upstream: credBody,
          ...(credCause ? { upstreamLog: credCause } : {}),
        },
      });
    }
  }

  // ③ 任务落库 = 受理（顶替上一条也在这一步里：任务体的 supersedesUuid 由上游在
  //    同一事务里处理）。到这一步返回 202 之前，行已经在 D1 里了，
  //    下面那一跳只是让它快点跑起来，跑不成还有每分钟的 cron。
  const taskResponse = await upstream.fetch(
    new Request(internalUrl('/schedule-message'), {
      method: 'POST',
      headers: encryptedHeaders,
      body: JSON.stringify(body.taskPayload),
    }),
    env,
  );
  const taskBody = await readBody(taskResponse);
  if (!taskResponse.ok) {
    const taskCause = readUpstreamCause(taskResponse.status, taskBody);
    return json(taskResponse.status, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_TASK_FAILED',
        message: '任务没建起来，这条没发出去',
        step: 'schedule-message',
        upstream: taskBody,
        ...(taskCause ? { upstreamLog: taskCause } : {}),
      },
    });
  }
  const uuid = (taskBody as { data?: { uuid?: unknown } } | null)?.data?.uuid;
  if (typeof uuid !== 'string' || !uuid) {
    return fail(502, 'INSTANT_CHAT_TASK_UUID_MISSING', '上游没有回任务 uuid，无法跟踪这一轮', {
      step: 'schedule-message',
    });
  }

  // ④ 叫醒 DO，让它立刻把这条捡走（immediate 任务落库即到期）。
  //    生成跑在它的 alarm 里 —— 独立 invocation、15 分钟墙钟，见 kickInstantTick。
  const kicked = await kickInstantTick(env, uuid);
  if (!kicked.ok && kicked.reason === 'missing-binding') {
    // 任务已经在库里了，所以这不是「没发出去」，而是「这台 Worker 跑不动它」：
    // 每分钟的 cron 仍会把它捡走，但那条路上没有为即时对话放宽的超时，用户会等很久
    // 甚至等不到。与其让他对着「正在输入」干等，不如现在就说清楚该去点哪里。
    console.error('[amsg:instant-chat] 没有 INSTANT_TICK 绑定：这台 Worker 是旧版本，需要更新');
    return json(503, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_WORKER_OUTDATED',
        message: '即时对话需要更新 Worker：打开「系统设置 → 主动消息 2.0 → 配置」，点「更新 Worker」。',
        step: 'instant-tick',
        uuid,
      },
    });
  }
  if (!kicked.ok) {
    // 叫醒失败但绑定在 = 临时故障。任务已落库，下一分钟的 cron 会捡起来，
    // 不该把已经受理的这一轮报成失败。
    console.warn('[amsg:instant-chat] 叫醒 DO 失败（等 cron 兜底）', kicked.error);
  }

  // credentialsSynced：告诉客户端「这一轮的凭据行已经照你给的覆盖过了」，它据此把本地
  // 底账对齐。旧 bundle 不认 credPayload、也就不会带这个键——客户端见不到它就不记账。
  return json(202, {
    status: 'accepted',
    uuid,
    ...(credPayload !== undefined ? { credentialsSynced: true } : {}),
  });
};
