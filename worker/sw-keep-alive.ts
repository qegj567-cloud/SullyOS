/// <reference lib="WebWorker" />

import { installReiSW } from '@rei-standard/amsg-sw';
import { createStaticCache, type StaticManifest } from './staticCache';

declare const __STATIC_CACHE_MANIFEST__: StaticManifest | undefined;
const staticManifest = typeof __STATIC_CACHE_MANIFEST__ === 'undefined' ? undefined : __STATIC_CACHE_MANIFEST__;

/**
 * SW_VERSION: 改 SW 实质行为时（push handler / message protocol / 通知策略 / IDB 升级）
 * 手工 bump。前端 BuildBadge 通过 GET_SW_VERSION postMessage 协议读取并显示，
 * 也作为 source-bytes-changed 的 cache buster 让浏览器 24h SW 缓存绕过去。
 *
 * 历史：
 *  - 1.0.0: 初版 ActiveMsg 2.0 push + keep-alive
 *  - 1.1.0: 加 BuildBadge SW 版本协议 + 文案通用化
 *  - 1.2.0: iOS 前台跳过 showNotification
 *  - 1.3.0: 测试推送 metadata.test 强制弹通知
 *  - 1.4.0: Phase 2 Round 1 — ActiveMsg IDB v1→v2 (加 outbound_sessions /
 *           pending_tool_calls / reasoning_buffer 三个 store), 上线后老 SW 不升级
 *           会因为 VersionError 丢推送, 必须 bump 触发字节比较 + 重装。
 *  - 1.5.0: Phase 2 Round 2 — push handler 按 messageKind 分轨
 *           (content / reasoning / tool_request / error), 处理 _blob envelope,
 *           tool_request 按 visibility 决定 postMessage 或 showNotification。
 *  - 1.5.1: saveContentToInbox 兼容 directive-only push (body 空但 metadata.directives
 *           非空, e.g. LLM 只输出 [[ACTION:POKE]] 时), 不再 early-return 漏掉副作用.
 *  - 1.5.2: saveContentToInbox gate 化简到只看 charId — directive-only / 空 payload
 *           都信任 worker 契约, 不在 SW 二次验证, 行为更可预测.
 *  - 1.6.0: amsg-instant 升 0.8.0-next.2, ReasoningPush 自动按字节切多 push.
 *           saveReasoningToBuffer 改累积式 (chunks[] 数组, read-modify-write),
 *           按 (messageIndex, chunkIndex) 保留每个分片, 主线程 claimReasoning
 *           取出时排序拼接. savePendingToolCall 之前清空同 sessionId 的 reasoning
 *           buffer — 镜像主应用 `data = newResponse` 的"只保留最后一轮 reasoning"
 *           行为, 避免 agentic loop 跨轮污染.
 *  - 1.7.0: content push 在没有可见 client 时补一条系统通知（当时由应用层实现）。
 *           之前只有 tool_request 弹通知, content (含写日记的 directive 回复) 关浏览器 /
 *           后台冻结时零通知 — 用户不知道要回前台, inbox 不 flush, 客户端副作用 (写 Notion)
 *           永远不跑. 与 tool_request 同策略: 有可见 client 交给 in-app UI, 否则系统通知.
 *  - 1.9.0: 升级 amsg-sw 2.1.0-next.2，由插件接管 _multipart 透明重组。
 *           删除了应用层的 reasoning chunking 逻辑，现收到完整 reasoningContent。
 *           content 通知兜底也交给 amsg-sw，应用层只负责写 inbox / tool / emotion。
 *           修复了在应用关闭期间收到分片推送丢失的问题（通过 notificationclick 恢复及前台拦截 REI_AMSG_PUSH）。
 *  - 1.9.1: 升级 amsg-sw 2.1.1，沿用插件侧 multipart 同 id 串行锁和标准通知标题 fallback。
 *  - 1.10.0: saveReasoningToBuffer 写完后 notifyClients('active-msg-reasoning')，让主线程在
 *           "content 抢先于 reasoning 落库" 的竞态下把思维链回填到已存的首条回复上，
 *           修复 instant 模式弱网/移动端思维链(心象)间歇丢失。
 *  - 1.10.1: 合并 1.10.0 思维链回填修复与 ReiStandard amsg-sw 2.1.1 升级。
 *  - 1.11.0: 加 process-sse-payload message 协议，SSE 直达 payload 也复用同一套
 *           ActiveMsg inbox / tool / emotion 路由。
 *  - 1.12.0: SSE 直达 payload 经 MessageChannel 回 ack，前台据此确认 SW 是否
 *           收下（含去重命中）。
 *  - 1.13.0: 接入 amsg-sw 通用 REI_AMSG_DELIVER + delivery dedupe。SSE bridge
 *           和 WebPush backup 统一在包层 showNotification 前去重。
 *  - 1.14.0: 升级 amsg-sw dedupe 语义：去重记录区分业务处理与通知展示，
 *           SSE-first 且前台未展示通知时，WebPush backup 可在隐藏态只补通知。
 *  - 1.15.0: IndexedDB 连接韧性整治（修 Instant Push 确认超时）。
 *           1) openInboxDb 改单例复用 + onversionchange/onclose 失效自愈 —— 之前每条 push
 *              都新开一条 ActiveMsg 连接且从不 close，与主库 (utils/db.ts) 的连接风暴一起
 *              撑爆 Chromium backing store，导致写 inbox 失败、永不 active-msg-received、超时。
 *           2) openInboxDb 的所有事务过 withInboxTx：onclose 清缓存是异步的，强关到回调之间
 *              命中 fast-path 会拿到将死连接、db.transaction() 同步抛 InvalidStateError，事务层
 *              兜一次「清缓存重开重试」(同 amsg-sw 2.3.0 的 withDedupeStore)。
 *           3) openInboxDb 修 blocked-then-unblocked 连接泄漏：onblocked 先 reject 但底层 open
 *              还活着，占用方关闭后 onsuccess 仍触发、留下能 block 升级/删库的孤儿连接；加
 *              settled 标记让迟到的 onsuccess 直接 close。
 *           4) 升级 amsg-sw 2.2.0 → 2.3.0：包侧 dedupe/queue/multipart 连接补 onclose + 事务级
 *              InvalidStateError 重开兜底；DELIVER ack 新增 businessError，落库失败 ok:true 仍带
 *              错误，前台据此把超时文案精确化。
 *  - 1.15.1: 临时加 instant push trace，定位 iOS PWA 后台导致的 SSE Load failed / backup push
 *            / SW inbox 落库时序。
 *  - 1.16.0: 加 pushsubscriptionchange 监听：浏览器换掉订阅时 best-effort 用旧公钥重订，
 *            并往 ActiveMsg 库 kv store 写「订阅已变化」标记（主线程据此把新订阅逐条
 *            写回已排程的远端任务，见 utils/activeMsgRuntime.ts）。onupgradeneeded 补建
 *            kv store（SW-first 安装时主线程 schema 还没建过）。
 *  - 1.17.0: 升级 amsg-sw，通知的 silent 认 'when-visible' 这一档：静不静音改由 SW 按
 *            收到推送那一刻的窗口可见性算，用户看着页面时安静、切后台照常响铃震动。
 *            老 SW 把这个字符串当真值，会一律静音。
 *  - 1.18.0: SW 侧 trace 落到独立的 ActiveMsgSwTrace 库（原来只写 console.log，远端用户
 *            手上等于没有），并把 notifyClients 记细：找到几个页面、各自可见性、
 *            postMessage 成没成。排「推送到了、通知也弹了、界面半天不动」这类故障时，
 *            SW 到底有没有喊到页面是第一个要回答的问题。
 *  - 1.19.0: push handler 只分 content / emotion_update / error / result 四轨；
 *            _blob 信封、reasoning、tool_request 三条路线移除。
 */
// 1.20.0: 静态资源缓存、离线启动、用户确认更新；保留原推送注册。
// 1.22.0: amsg-sw next.8，修复并发冲刷回执与分片收尾失败的诊断。
const SW_VERSION = '1.22.0';

const PING_INTERVAL = 15_000;
const MAX_MANUAL_ALIVE_MS = 5 * 60_000;
const ACTIVE_MSG_DB_NAME = 'ActiveMsg';
// MUST be kept in sync with utils/activeMsgStore.ts:DB_VERSION. If SW pins a lower version while
// main thread is on v2, SW's open() will throw VersionError and push messages will be silently dropped.
const ACTIVE_MSG_DB_VERSION = 2;
const ACTIVE_MSG_INBOX_STORE = 'inbox';
// 下面三张表现在没人读写（主线程启动时清空过一次旧数据）。建表逻辑留着是为了不动库版本：
// 删表就得升 DB_VERSION，页面和 SW 必须同步升级，否则老的一方打开库直接 VersionError。
const ACTIVE_MSG_OUTBOUND_SESSIONS_STORE = 'outbound_sessions';
const ACTIVE_MSG_PENDING_TOOL_CALLS_STORE = 'pending_tool_calls';
const ACTIVE_MSG_REASONING_BUFFER_STORE = 'reasoning_buffer';
// 主线程 activeMsgStore.ts 的 kv store（记录形状 { id, value }）。SW 只往里写一条
// 固定 key 的「订阅已变化」标记，key 必须与 utils/activeMsgRuntime.ts 的
// PUSH_SUBSCRIPTION_CHANGED_KV_ID 保持一致。
const ACTIVE_MSG_KV_STORE = 'kv';
const PUSH_SUBSCRIPTION_CHANGED_KV_ID = 'push_subscription_changed_v1';

let pingTimer: number | null = null;
let manualKeepAliveCount = 0;
let manualKeepAliveStartedAt = 0;

const proactiveSchedules = new Map<string, { charId: string; intervalMs: number }>();
const proactiveTimers = new Map<string, number>();

const sw = self as unknown as ServiceWorkerGlobalScope;

const resourceCache = staticManifest && createStaticCache({
  manifest: staticManifest, scope: sw.registration.scope, caches: sw.caches,
  fetch: request => fetch(request), waitUntil: () => {},
  digest: async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join(''),
});
if (resourceCache) {
  sw.addEventListener('fetch', event => {
    const result = resourceCache.handle(event.request, promise => event.waitUntil(promise));
    // A failed download reaches the page as the network error it is, without an unhandled rejection per request.
    if (result) event.respondWith(result.catch(() => Response.error()));
  });
}

/** Clears shells of releases no open page still runs. Pages that do not answer postpone it. */
async function tidyResourceCache(cache: NonNullable<typeof resourceCache>): Promise<void> {
  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const scope = new URL(sw.registration.scope);
  const pages = clients.filter(client => new URL(client.url).pathname.startsWith(scope.pathname));
  const builds = await Promise.all(pages.map(client => new Promise<string | null>(resolve => {
    const channel = new MessageChannel();
    const finish = (build: string | null) => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(build); };
    const timer = setTimeout(() => finish(null), 1500);
    channel.port1.onmessage = message => finish(typeof message.data?.buildId === 'string' ? message.data.buildId : null);
    try { client.postMessage({ type: 'SULLY_GET_PAGE_BUILD' }, [channel.port2]); }
    catch { finish(null); }
  })));
  await cache.activate(builds.includes(null) ? null : builds as string[]).catch(() => {});
}

function summarizeAmsgPayload(payload: any): Record<string, any> {
  return {
    messageKind: payload?.messageKind ?? 'content',
    messageType: payload?.messageType,
    messageId: payload?.messageId,
    sessionId: payload?.sessionId,
    charId: payload?.metadata?.charId,
    chunk: payload?.messageIndex,
    total: payload?.totalMessages,
  };
}

// ─── SW 侧 trace 的持久化 ───
//
// traceSw 原本只写 console.log。SW 的 console 在远端用户那儿等于不存在（手机上没有
// DevTools，装成 PWA 更没有），于是「SW 到底有没有收到推送、有没有喊到页面」这一整段
// 全是盲区——排障时只能看到页面侧的记录，而页面侧的第一条记录已经是「开始处理」了。
//
// 存在**独立的小库**里，不往 ActiveMsg 库塞：那个库一升版本就要走 onupgradeneeded，
// 主线程正开着旧版本连接的话会 blocked（openInboxDb 里就为此写了 onblocked 分支），
// 排障用的日志不值得给收件箱这条关键路径带上这种风险。
const SW_TRACE_DB_NAME = 'ActiveMsgSwTrace';
const SW_TRACE_DB_VERSION = 1;
const SW_TRACE_STORE = 'entries';
/** 留多少条。一轮多段回复能打十几条，留够翻几轮的量。 */
const SW_TRACE_LIMIT = 300;

let swTraceDbPromise: Promise<IDBDatabase> | null = null;

function openSwTraceDb(): Promise<IDBDatabase> {
  if (swTraceDbPromise) return swTraceDbPromise;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SW_TRACE_DB_NAME, SW_TRACE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SW_TRACE_STORE)) {
        db.createObjectStore(SW_TRACE_STORE, { keyPath: 'seq', autoIncrement: true });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // 跟另外两个库同款的失效自愈：被强关 / 别处升版本时清缓存，下次重开。
      db.onversionchange = () => {
        db.close();
        if (swTraceDbPromise === promise) swTraceDbPromise = null;
      };
      db.onclose = () => {
        if (swTraceDbPromise === promise) swTraceDbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      if (swTraceDbPromise === promise) swTraceDbPromise = null;
      reject(request.error);
    };
    request.onblocked = () => {
      if (swTraceDbPromise === promise) swTraceDbPromise = null;
      reject(new Error('sw trace db blocked'));
    };
  });

  swTraceDbPromise = promise;
  return promise;
}

/** 追加一条并把超出上限的最老记录删掉。整个函数的失败都被调用方吞掉。 */
async function appendSwTrace(entry: Record<string, any>): Promise<void> {
  const db = await openSwTraceDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SW_TRACE_STORE, 'readwrite');
    const store = tx.objectStore(SW_TRACE_STORE);
    store.add(entry);
    // 同一个事务里 count 能看到刚 add 的那条，多出来的从最老的一头删。
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      const excess = countRequest.result - SW_TRACE_LIMIT;
      if (excess <= 0) return;
      let removed = 0;
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || removed >= excess) return;
        cursor.delete();
        removed += 1;
        cursor.continue();
      };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function traceSw(event: string, payload?: any, extra: Record<string, any> = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    swVersion: SW_VERSION,
    ...(payload !== undefined ? summarizeAmsgPayload(payload) : {}),
    ...extra,
  };
  try {
    console.log('[InstantTrace:SW]', entry);
  } catch { /* ignore */ }
  // 不 await：trace 是旁路，写库慢了 / 挂了都不能拖住推送处理本身。
  void appendSwTrace(entry).catch(() => { /* trace 写不进去就算了 */ });
}

installReiSW(sw, {
  defaultIcon: './icons/icon-192.png',
  defaultBadge: './icons/icon-192.png',
  multipart: { enabled: true },
  onBusinessPayload: async (payload: any) => {
    traceSw('business-payload-start', payload);
    try {
      await saveIncomingActiveMessage(payload);
      traceSw('business-payload-done', payload);
    } catch (e) {
      traceSw('business-payload-error', payload, {
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },
});

function hasActiveProactiveSchedules() {
  return proactiveTimers.size > 0;
}

function shouldKeepAlive() {
  return manualKeepAliveCount > 0 || hasActiveProactiveSchedules();
}

function stopPingLoop() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function ensurePingLoop() {
  if (pingTimer) return;

  pingTimer = setInterval(() => {
    if (manualKeepAliveCount > 0 && Date.now() - manualKeepAliveStartedAt > MAX_MANUAL_ALIVE_MS) {
      manualKeepAliveCount = 0;
      manualKeepAliveStartedAt = 0;
    }

    if (!shouldKeepAlive()) {
      stopPingLoop();
      return;
    }

    sw.registration.active?.postMessage({ type: 'ping' });
  }, PING_INTERVAL) as unknown as number;
}

function refreshKeepAlive() {
  if (shouldKeepAlive()) ensurePingLoop();
  else stopPingLoop();
}

function startKeepAlive() {
  manualKeepAliveCount += 1;
  if (!manualKeepAliveStartedAt) manualKeepAliveStartedAt = Date.now();
  refreshKeepAlive();
}

function stopKeepAlive() {
  if (manualKeepAliveCount > 0) manualKeepAliveCount -= 1;
  if (manualKeepAliveCount === 0) manualKeepAliveStartedAt = 0;
  refreshKeepAlive();
}

/**
 * 页面地址里只留路径，不带查询串和 hash——排障要认的是「这是哪个页面」，
 * 而查询串/hash 上可能挂着不该进日志的东西。
 */
function tracePathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '?';
  }
}

/**
 * 把消息喊给所有打开着的页面。
 *
 * 这里的 trace 记得比别处细，因为「推送到了、通知也弹了，页面却毫无反应」这类故障
 * 全卡在这一步，而它三种坏法长得一模一样（都是页面那边什么都没发生）：
 *   1. matchAll 压根没找到页面 → count 为 0
 *   2. 找到了但 postMessage 抛错 → posted 少于 count，failures 里有原因
 *   3. 都成了，是页面自己没处理 → 这里全绿，页面侧却没有对应的收到记录
 * 不把这三样分开记，就只能靠猜。
 */
async function notifyClients(data: Record<string, any>) {
  let clients: readonly Client[] = [];
  let matchError: string | undefined;
  try {
    clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  } catch (e) {
    matchError = e instanceof Error ? e.name : String(e);
  }

  let posted = 0;
  const failures: string[] = [];
  for (const client of clients) {
    try {
      client.postMessage(data);
      posted += 1;
    } catch (e) {
      failures.push(e instanceof Error ? e.name : String(e));
    }
  }

  traceSw('notify-clients', undefined, {
    type: data.type,
    charId: data.charId,
    sessionId: data.sessionId,
    count: clients.length,
    posted,
    targets: clients.map((client) => ({
      path: tracePathOf(client.url),
      visibility: (client as WindowClient).visibilityState,
      focused: (client as WindowClient).focused,
      // 冻结的页面收得下 postMessage，但要等解冻才会处理——只有部分浏览器报这个字段。
      frozen: (client as any).frozen,
    })),
    ...(failures.length > 0 ? { failures } : {}),
    ...(matchError ? { matchError } : {}),
  });
}

function fireProactiveTrigger(charId: string) {
  void notifyClients({ type: 'proactive-trigger', charId });
}

function stopProactive(charId: string) {
  const timer = proactiveTimers.get(charId);
  if (timer) {
    clearInterval(timer);
    proactiveTimers.delete(charId);
  }
  proactiveSchedules.delete(charId);
}

const MIN_PROACTIVE_INTERVAL_MS = 30 * 60 * 1000;

function upsertProactive(config: { charId: string; intervalMs: number }) {
  const safeIntervalMs = Math.max(MIN_PROACTIVE_INTERVAL_MS, Math.round(config.intervalMs));
  const safeConfig = { charId: config.charId, intervalMs: safeIntervalMs };
  const prev = proactiveSchedules.get(safeConfig.charId);
  const unchanged = prev && prev.intervalMs === safeConfig.intervalMs;
  if (unchanged && proactiveTimers.has(safeConfig.charId)) return;

  stopProactive(safeConfig.charId);
  proactiveSchedules.set(safeConfig.charId, safeConfig);

  const timer = setInterval(() => fireProactiveTrigger(safeConfig.charId), safeConfig.intervalMs) as unknown as number;
  proactiveTimers.set(safeConfig.charId, timer);
}

function syncProactive(configs: Array<{ charId: string; intervalMs: number }>) {
  const nextIds = new Set((configs || []).map((config) => config.charId));

  for (const charId of Array.from(proactiveSchedules.keys())) {
    if (!nextIds.has(charId)) stopProactive(charId);
  }

  for (const config of configs || []) {
    if (config && config.charId && config.intervalMs > 0) {
      upsertProactive(config);
    }
  }

  refreshKeepAlive();
}

function readPushPayload(event: PushEvent): any | null {
  if (!event.data) return null;

  try {
    return event.data.json();
  } catch {
    try {
      return { message: event.data?.text() };
    } catch {
      return null;
    }
  }
}

// 单例连接缓存。每条 push 都新开一条 ActiveMsg 连接且从不 close 的话, 会跟主库
// (utils/db.ts) 的连接一起撑爆 Chromium backing store, 这里 open 失败 →
// saveContentToInbox 抛错 → 永不 notifyClients('active-msg-received') → 页面迟迟等不到
// 落库。复用同一条连接, 失效 (版本升级 / 浏览器强制关闭) 时清缓存自愈, 下条 push 自动重开。
let inboxDbPromise: Promise<IDBDatabase> | null = null;

function openInboxDb(): Promise<IDBDatabase> {
  if (inboxDbPromise) return inboxDbPromise;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ACTIVE_MSG_DB_NAME, ACTIVE_MSG_DB_VERSION);
    // onblocked 不是终态: 先 reject, 但底层 open request 还活着, 占用方关闭后仍会触发
    // onsuccess。用 settled 标记 promise 已 settle, 让迟到的连接被 close 而非泄漏成
    // 一条没人持有、却能 block 后续升级 / 删库的孤儿连接。
    // 清缓存一律先比对 inboxDbPromise === promise: onclose/onerror 都是异步回调 —— 尤其
    // withInboxTx 强关后会清缓存并重开新 promise, 此时陈旧连接的迟到 onclose 不能把新单例
    // 误清 (否则又凭空多开一条连接, 正是本次要消灭的 churn; 见 amsg-sw 2.3.0 同款守卫)。
    let settled = false;

    request.onerror = () => {
      if (inboxDbPromise === promise) inboxDbPromise = null; // 打开失败别缓存 rejected promise
      settled = true;
      reject(request.error);
    };
    request.onblocked = () => {
      // Main thread or another SW connection holds the DB at a lower version and isn't closing.
      // Push will fail to persist; reject rather than hang forever so event.waitUntil unblocks.
      if (inboxDbPromise === promise) inboxDbPromise = null;
      settled = true;
      reject(new Error('IndexedDB open blocked (older version still open elsewhere)'));
    };
    request.onsuccess = () => {
      const db = request.result;
      // 已经 reject 过 (onblocked / onerror): 迟到的连接没人接收, 直接 close, 否则它开着
      // 会 block 后续升级 / deleteDatabase。
      if (settled) {
        try { db.close(); } catch { /* ignore */ }
        return;
      }
      // 主线程升级版本时 close 让位 + 清缓存; 浏览器强制关闭连接时也清缓存自愈。
      db.onversionchange = () => {
        db.close();
        if (inboxDbPromise === promise) inboxDbPromise = null;
      };
      db.onclose = () => {
        if (inboxDbPromise === promise) inboxDbPromise = null;
      };
      resolve(db);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ACTIVE_MSG_INBOX_STORE)) {
        db.createObjectStore(ACTIVE_MSG_INBOX_STORE, { keyPath: 'messageId' });
      }
      // 这三张表没人读写，只为让 SW-first 安装建出来的库跟主线程 v2 schema 一致（见常量处注释）。
      if (!db.objectStoreNames.contains(ACTIVE_MSG_OUTBOUND_SESSIONS_STORE)) {
        db.createObjectStore(ACTIVE_MSG_OUTBOUND_SESSIONS_STORE, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(ACTIVE_MSG_PENDING_TOOL_CALLS_STORE)) {
        db.createObjectStore(ACTIVE_MSG_PENDING_TOOL_CALLS_STORE, { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains(ACTIVE_MSG_REASONING_BUFFER_STORE)) {
        db.createObjectStore(ACTIVE_MSG_REASONING_BUFFER_STORE, { keyPath: 'sessionId' });
      }
      // kv 平时由主线程 activeMsgStore.ts 建；SW-first 安装（主线程还没开过库就先
      // 收到 push / pushsubscriptionchange）时这里补建，否则订阅变化标记没地方写，
      // 主线程后续 transaction('kv') 也会 NotFoundError。
      if (!db.objectStoreNames.contains(ACTIVE_MSG_KV_STORE)) {
        db.createObjectStore(ACTIVE_MSG_KV_STORE, { keyPath: 'id' });
      }
    };
  });

  inboxDbPromise = promise;
  return promise;
}

function isInboxConnectionClosingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; message?: string };
  return e.name === 'InvalidStateError' || /connection is closing/i.test(String(e.message || ''));
}

// 事务级一次重开兜底。单例的 onclose 清缓存是异步的: 连接被浏览器强关到 onclose 回调
// 跑之间, 命中 fast-path 的调用方会拿到一条将死的连接, db.transaction() 同步抛
// InvalidStateError —— 此时 saveContentToInbox 会在写 inbox / fire active-msg-received 前
// 就挂掉, push 静默丢、主线程超时。这里捕获该错误后清缓存、重开一次、重试一次
// (镜像 amsg-sw 2.3.0 的 withDedupeStore), 守住这条关键路径。重试上限 1 次; 失败的
// 事务不会 commit, 故 run() 重跑是幂等的 (含 read-modify-write)。
async function withInboxTx(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await openInboxDb();
    try {
      return await new Promise<void>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction(storeName, mode);
        } catch (e) {
          reject(e); // 连接 closing 时 db.transaction() 同步抛, 交给下面的重试判定
          return;
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error(`inbox tx error (${storeName})`));
        tx.onabort = () => reject(tx.error || new Error(`inbox tx aborted (${storeName})`));
        run(tx.objectStore(storeName));
      });
    } catch (e) {
      if (attempt === 0 && isInboxConnectionClosingError(e)) {
        inboxDbPromise = null; // 丢掉将死的缓存连接, 下一轮 openInboxDb 重开
        continue;
      }
      throw e;
    }
  }
}

// ─── content / inbox (kind=content) ───────────────────────────────────────────

async function saveContentToInbox(payload: any) {
  const charId = payload?.metadata?.charId;
  const charName = payload?.contactName || payload?.metadata?.charName || '主动消息';
  const body = String(payload?.message || payload?.body || '').trim();
  const notificationBody = typeof payload?.notification?.body === 'string'
    ? payload.notification.body.trim()
    : '';
  const previewBody = notificationBody || body;
  const messageId = String(payload?.messageId || `${charId || 'unknown'}-${Date.now()}`);
  const payloadTimestamp = payload?.timestamp;
  const parsedSentAt = payloadTimestamp ? new Date(payloadTimestamp).getTime() : NaN;
  const sentAt = Number.isFinite(parsedSentAt) ? parsedSentAt : Date.now();

  // 唯一不可恢复的是没 charId — 没法路由, 直接丢. 其它形态都接受:
  //   - body 非空 + directives 空 = 普通 content push (老路径)
  //   - body 非空 + directives 非空 = content + 副作用混合 push
  //   - body 空 + directives 非空 = directive-only push (LLM 只输 [[ACTION:POKE]] 等)
  //   - body 空 + directives 空 = worker bug 推白条 → 写一条空 entry, flushInbox 跑空管线无害,
  //     最多让 OSContext 弹一句默认 toast. 这种 case 应该在 worker 端修, SW 不二次验证契约.
  if (!charId) {
    traceSw('content-drop-no-char', payload);
    return;
  }

  await withInboxTx(ACTIVE_MSG_INBOX_STORE, 'readwrite', (store) => {
    store.put({
      messageId,
      charId,
      charName,
      body,
      previewBody,
      avatarUrl: payload?.avatarUrl,
      source: payload?.source,
      messageType: payload?.messageType,
      messageSubtype: payload?.messageSubtype,
      // 任务身份由库盖在 push 顶层 (taskId / taskUuid / recurrenceType / occurrenceMs),
      // 客户端端的防穿帮闸与任务认领都读这几个——两条排程路径 (用户排 / 角色自排) 走的
      // 是同一份, 不会像各自往 metadata 抄那样抄漏一个就判错。
      taskId: payload?.taskId ?? null,
      taskUuid: payload?.taskUuid ?? null,
      recurrenceType: payload?.recurrenceType ?? null,
      occurrenceMs: payload?.occurrenceMs ?? null,
      // sessionId / messageIndex 放到 metadata 里, 主线程 flushInboxToChat 据此标记是第几条
      // (第 1 条才挂 metadata.thinkingChain).
      metadata: {
        ...(payload?.metadata || {}),
        sessionId: payload?.sessionId,
        messageIndex: payload?.messageIndex,
        totalMessages: payload?.totalMessages,
      },
      sentAt,
      receivedAt: Date.now(),
    });
  });
  traceSw('inbox-content-saved', payload, { bodyChars: body.length });

  await notifyClients({
    type: 'active-msg-received',
    charId,
    charName,
    body: previewBody,
    avatarUrl: payload?.avatarUrl,
    sentAt,
  });
}

// emotion_update push: worker 跑完副 API 情绪评估后推回的 buff 结果. 静默写进 inbox (不弹通知、
// 不计未读), 客户端 flushInboxToChat 看到 messageType==='emotion_update' 时调 applyEmotionEvalRaw
// 落 buff + 广播 innerState, 不渲染成聊天消息. notifyClients 仅用来触发一次 flush (前台时立即落 buff;
// 后台时 postMessage 排队/丢弃, 回前台 visibilitychange flush 兜底).
async function saveEmotionUpdateToInbox(payload: any) {
  const charId = payload?.metadata?.charId;
  // emotionRaw 允许为空: worker 评估失败/返回空时也会推一条 "done" 信号 (emotionRaw=''),
  // 仍需写 inbox + notify, 让客户端 flush 时 fire 'instant-emotion-done' 熄灭 "情绪分析中" 徽章.
  const emotionRaw = payload?.metadata?.emotionRaw || '';
  if (!charId) {
    traceSw('emotion-drop-no-char', payload);
    return;
  }
  const messageId = String(payload?.messageId || `${charId}-emotion-${Date.now()}`);

  await withInboxTx(ACTIVE_MSG_INBOX_STORE, 'readwrite', (store) => {
    store.put({
      messageId,
      charId,
      charName: payload?.contactName || '',
      body: '',
      messageType: 'emotion_update',
      metadata: { charId, emotionRaw },
      sentAt: Date.now(),
      receivedAt: Date.now(),
    });
  });
  traceSw('inbox-emotion-saved', payload, { emotionChars: String(emotionRaw).length });

  // 触发客户端 flush (不带真实内容, 客户端 flush 时按 messageType 静默处理). 不 showNotification.
  await notifyClients({ type: 'active-msg-received', charId, charName: payload?.contactName || '', body: '', emotionUpdate: true });
}

// ─── 路由总入口 ──────────────────────────────────────────────────────────────

async function saveIncomingActiveMessage(payload: any) {
  // 按 messageKind 分轨; 没带 messageKind 字段的当 content 处理.
  const messageKind: string = payload?.messageKind ?? 'content';
  traceSw('route-payload', payload, { route: messageKind });

  switch (messageKind) {
    case 'content':
      await saveContentToInbox(payload);
      return;

    case 'emotion_update':
      await saveEmotionUpdateToInbox(payload);
      return;

    case 'error':
      // 失败告知 push: 不写 inbox（不是聊天内容）。通知横幅由包层按 notification.show
      // 决定（即时对话的终态失败带 show:'always' + 折叠 + 静音，前后台都弹）。这里把
      // metadata 整份带给页面: 即时对话靠里面的 taskUuid/reason 当场收尾那一轮
      // （落系统消息、熄灯），见 activeMsgRuntime 的 active-msg-error 分支。
      console.error('[amsg] error push', payload?.code, payload?.message, payload?.metadata?.reason);
      await notifyClients({
        type: 'active-msg-error',
        code: payload?.code,
        message: payload?.message,
        charId: payload?.metadata?.charId,
        metadata: payload?.metadata,
      });
      return;

    case 'result':
      // 宿主自定义结果（worker 的 ctx.emitResult），不是聊天内容: 不写 inbox, 原样
      // 转给页面按 resultKind 分流。落进 content 分支的话, 结果里那些不是正文的字段
      // 会被当角色说的一句话渲染成气泡。
      await notifyClients({ type: 'active-msg-result', payload });
      return;

    default:
      console.warn('[amsg] unknown messageKind, falling back to content', messageKind);
      await saveContentToInbox(payload);
  }
}

// 之前我们自己写 sw.addEventListener('push')，现在全量交由 amsg-sw 的 installReiSW
// 在 onBusinessPayload 里回调，所以这里不再需要手写 push 监听。

// ─── pushsubscriptionchange：浏览器换掉了推送订阅 ────────────────────────────
// 已排程任务体里的 pushSubscription 是排程那一刻冻结的，订阅一换端点，到点推送
// 全打到作废端点上（静默失联）。这里做两件事，都是 best-effort：
//   1. 用旧订阅的 applicationServerKey 立刻重订，尽量别让订阅断档；
//   2. 无论重订成败都往 kv store 写一条固定 key 的「订阅已变化」标记——就算重订
//      成功，新订阅的端点也和任务体里冻结的不一样，远端任务必须逐条刷新才能继续
//      送达。主线程 ActiveMsgRuntime 启动 / 收到下面的通知时消费标记（见
//      utils/activeMsgRuntime.ts 的 refreshPushSubscriptionIfMarked），全部写回
//      成功才清。
// TS lib 的 ServiceWorkerGlobalScopeEventMap 还没收这个事件名，监听器手动收敛类型。
sw.addEventListener('pushsubscriptionchange', (event: Event) => {
  const e = event as Event & {
    waitUntil: (promise: Promise<unknown>) => void;
    oldSubscription?: PushSubscription | null;
  };
  traceSw('push-subscription-change', undefined, {
    hadOldSubscription: Boolean(e.oldSubscription),
  });

  e.waitUntil((async () => {
    let resubscribed = false;
    try {
      const applicationServerKey = e.oldSubscription?.options?.applicationServerKey;
      if (applicationServerKey) {
        await sw.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        resubscribed = true;
      }
    } catch (err) {
      console.warn('[amsg] pushsubscriptionchange 重订失败（主线程稍后会走完整订阅流程）', err);
    }

    try {
      await withInboxTx(ACTIVE_MSG_KV_STORE, 'readwrite', (store) => {
        store.put({
          id: PUSH_SUBSCRIPTION_CHANGED_KV_ID,
          value: { changedAt: Date.now(), resubscribed },
        });
      });
    } catch (err) {
      // 标记写不进去只能靠日志留痕：下一次订阅相关操作（重开面板 / 重新排程）会
      // 走 ensurePushSubscription 的自检把订阅本身修好，但远端旧任务要等用户重存。
      console.warn('[amsg] 写订阅变化标记失败', err);
    }

    // 页面开着的话立刻处理，不用等下次启动。
    await notifyClients({ type: 'active-msg-subscription-change', resubscribed });
  })());
});

sw.addEventListener('notificationclick', (event: NotificationEvent) => {
  const payload = event.notification.data?.payload || event.notification.data || {};
  const charId = payload?.metadata?.charId || payload?.charId || '';
  event.notification.close();

  event.waitUntil((async () => {
    const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length > 0) {
      const client = clients[0];
      await client.focus();
      client.postMessage({ type: 'active-msg-open', charId });
      return;
    }

    const openUrl = new URL(sw.registration.scope || sw.location.origin);
    openUrl.searchParams.set('openApp', 'chat');
    if (charId) openUrl.searchParams.set('activeMsgCharId', charId);
    await sw.clients.openWindow(openUrl.toString());
  })());
});

sw.addEventListener('message', (event: ExtendableMessageEvent) => {
  const { type } = event.data || {};

  switch (type) {
    case 'SULLY_CACHE_STATUS':
    case 'SULLY_CACHE_PREPARE':
    case 'SULLY_CACHE_CLEAR': {
      if (!resourceCache) { event.ports[0]?.postMessage({ error: '资源缓存尚未启用' }); break; }
      event.waitUntil((async () => {
        try {
          if (type === 'SULLY_CACHE_CLEAR') await resourceCache.clearRuntime();
          if (type === 'SULLY_CACHE_PREPARE') await resourceCache.install();
          event.ports[0]?.postMessage(await resourceCache.stats());
        } catch { event.ports[0]?.postMessage({ error: '暂时无法读取资源缓存' }); }
      })());
      break;
    }
    case 'SULLY_ACTIVATE_UPDATE':
      event.waitUntil(sw.skipWaiting());
      break;
    case 'SULLY_RELEASE_READY':
      // The next release is downloaded. With the same version number it needs no consent, so page
      // loads go to the network from now on and the next refresh is already the new release; the
      // page then lets the waiting worker take over. A new version number waits for the user.
      if (resourceCache && event.data.appVersion === staticManifest!.appVersion) event.waitUntil(resourceCache.markReplaced());
      break;
    case 'SULLY_CACHE_TIDY':
      if (resourceCache) event.waitUntil(tidyResourceCache(resourceCache));
      break;
    case 'GET_SW_VERSION':
      // BuildBadge 通过 MessageChannel + port 协议查询；不响应时 BuildBadge 显示 sw@?
      event.ports[0]?.postMessage({ version: SW_VERSION });
      break;
    case 'SW_CHANNEL_PROBE': {
      // 页面主动探一次「SW 还能不能喊到我」。两条路各回一次，为的是把故障分开：
      //   - port 这条是「谁问谁答」，页面把回信地址一起递过来（BuildBadge 查版本走它）；
      //   - clients 这条要 SW 自己去把页面找出来，**推送通知页面走的正是它**。
      // 只有后者不通，说明 SW 活得好好的、只是找不到页面——这两种坏法在用户那儿
      // 长得一模一样（界面就是不动），不分开测就只能靠猜。
      const nonce = event.data?.nonce;
      traceSw('channel-probe-received', undefined, { nonce });
      event.ports[0]?.postMessage({ type: 'sw-channel-probe-port-ack', nonce, swVersion: SW_VERSION });
      // 故意复用 notifyClients：探测必须跟真实推送走同一条路才作数，
      // 顺带还留下一条 notify-clients 记录（找到几个页面、各自什么状态）。
      event.waitUntil(notifyClients({ type: 'sw-channel-probe-ack', nonce, swVersion: SW_VERSION }));
      break;
    }
    case 'keepalive-start':
      startKeepAlive();
      break;
    case 'keepalive-stop':
      stopKeepAlive();
      break;
    case 'proactive-start':
      if (event.data.config) {
        syncProactive([...proactiveSchedules.values(), event.data.config]);
      }
      break;
    case 'proactive-stop':
      if (event.data.charId) {
        stopProactive(event.data.charId);
        refreshKeepAlive();
      } else {
        syncProactive([]);
      }
      break;
    case 'proactive-sync':
      syncProactive(event.data.configs || []);
      break;
  }
});

sw.addEventListener('install', (event: ExtendableEvent) => {
  // Without a manifest (dev server, native app) this is the push-only worker, replaced at once.
  if (!resourceCache) { void sw.skipWaiting(); return; }
  // A first installation activates right away so push and keep-alive are ready; the page then
  // asks for the offline shell. Upgrades download the shell first and wait. A failed download
  // does not hold the worker back, so push fixes always arrive: that version loads its page from
  // the network until the page gets the shell stored.
  const previous = sw.registration.active;
  if (previous) event.waitUntil(resourceCache.install().catch(error => {
    console.warn('[StaticCache] Offline shell not stored; the page will retry after the update', error);
  }).then(() => {
    // The worker in charge decides what this means for the pages it serves (SULLY_RELEASE_READY).
    try { previous.postMessage({ type: 'SULLY_RELEASE_READY', appVersion: staticManifest!.appVersion }); }
    catch { /* it finds out when the page next asks */ }
  }));
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  // Requests of the page that is about to load are held until this finishes, so it only takes
  // control. Older shells are cleared later, when a started page asks (SULLY_CACHE_TIDY).
  event.waitUntil(sw.clients.claim());
});
