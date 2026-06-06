import { InstantPushConfig, APIConfig, type InstantOversizeTransport } from '../types';
import { loadPushVapid, isPushVapidReady } from './pushVapid';
import { ActiveMsgStore } from './activeMsgStore';
import { appendDevDebugInstantPushLog, appendDevDebugLog, makeDebugLogger } from './devDebug';
import {
  SUBSCRIBE_SETTLE_MS,
  bytesToB64u,
  isDeadPushEndpoint,
  subscribeWithRetry,
} from './pushSubscribeShared';
import { ReiClient } from '@rei-standard/amsg-client';
import { INSTANT_WORKER_VERSION } from './instantWorkerVersion';

const log = makeDebugLogger('instant-push', 'InstantPush');

export const INSTANT_PUSH_CONFIG_KEY = 'instant_push_config_v1';

// ── Diagnostics ────────────────────────────────────────────────────────────
//
// 错误诊断快照, 给 ErrorDialog 用. 设计原则:
//   - 弹窗里完全不出现 apiKey / apiUrl / workerUrl / push endpoint, 这些走
//     console.error 留给本地 devtools, 用户复制弹窗内容反馈时不漏密.
//   - response snippet 里如果回显了 worker / api host (CF 错误页常见),
//     主动在文本里 mask 掉.

export interface InstantDiagnostics {
  env: {
    ua: string;             // 简化版, 不是原始 UA 串
    online: boolean;
    notif: NotificationPermission | 'unsupported';
    sw: string;             // 'scope=/ active' / 'not-registered' / 'unsupported'
    time: string;
  };
  context?: {
    char?: string;
    model?: string;
    msgCount?: number;
    msgBytes?: number;
  };
  config?: {
    enabled: boolean;
    workerUrlFilled: boolean;
    vapid: 'ready' | '缺公钥' | '缺私钥' | '缺公钥+私钥';
  };
  subscription?: {
    reason?: string;
    notifPermission?: NotificationPermission | 'unsupported';
    swRegistered?: boolean;
    cleanedDeadEndpoint?: boolean;
  };
  http?: {
    status: number;
    statusText?: string;
    bodyBytes: number;
    keepalive: boolean;
    keepaliveLimit: number;
    cfRay?: string;
    responseSnippet?: string;
  };
  fetchError?: {
    name?: string;
    message?: string;
  };
  timeout?: {
    waitedMs: number;
    httpStatusWhenDispatched?: number;
  };
  /**
   * 按 JSON 序列化大小排序的 payload 前 N 个字段路径, 给 413 / 大 payload 定位用.
   * 路径形如 messages[3].content, metadata.charId. 只列大小, 不列值, 路径黑名单已过滤
   * apiKey/apiUrl/endpoint 等密钥与可识别标识.
   */
  payloadTop?: Array<{ path: string; bytes: number }>;
}

function simplifyUserAgent(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) {
    const ios = ua.match(/OS (\d+)_/)?.[1] ?? '?';
    const standalone = typeof navigator !== 'undefined' && (navigator as any).standalone === true;
    return `iOS ${ios} ${standalone ? 'PWA' : 'Safari'}`;
  }
  if (/Android/.test(ua)) {
    const av = ua.match(/Android (\d+)/)?.[1] ?? '?';
    if (/Chrome\/(\d+)/.test(ua)) return `Android ${av} Chrome ${RegExp.$1}`;
    return `Android ${av}`;
  }
  if (/Mac OS X/.test(ua)) {
    if (/Edg\/(\d+)/.test(ua)) return `Mac Edge ${RegExp.$1}`;
    if (/Chrome\/(\d+)/.test(ua)) return `Mac Chrome ${RegExp.$1}`;
    if (/Firefox\/(\d+)/.test(ua)) return `Mac Firefox ${RegExp.$1}`;
    if (/Safari\/\d+/.test(ua)) return 'Mac Safari';
    return 'Mac';
  }
  if (/Windows/.test(ua)) {
    if (/Edg\/(\d+)/.test(ua)) return `Win Edge ${RegExp.$1}`;
    if (/Chrome\/(\d+)/.test(ua)) return `Win Chrome ${RegExp.$1}`;
    if (/Firefox\/(\d+)/.test(ua)) return `Win Firefox ${RegExp.$1}`;
    return 'Windows';
  }
  return ua.slice(0, 60);
}

async function collectEnvSnapshot(): Promise<InstantDiagnostics['env']> {
  const ua = typeof navigator !== 'undefined' ? simplifyUserAgent(navigator.userAgent || '') : 'n/a';
  const online = typeof navigator !== 'undefined' ? navigator.onLine : false;
  let notif: NotificationPermission | 'unsupported' = 'unsupported';
  if (typeof Notification !== 'undefined') {
    try { notif = Notification.permission; } catch { /* ignore */ }
  }
  let sw = 'unsupported';
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        sw = 'not-registered';
      } else {
        const scope = (() => {
          try { return reg.scope.replace(location.origin, '') || '/'; } catch { return reg.scope; }
        })();
        sw = `scope=${scope} ${reg.active ? 'active' : 'inactive'}`;
      }
    } catch { sw = 'error'; }
  }
  return { ua, online, notif, sw, time: new Date().toISOString() };
}

function describeVapid(): NonNullable<InstantDiagnostics['config']>['vapid'] {
  const v = loadPushVapid();
  const noPub = !v.vapidPublicKey || v.vapidPublicKey.length < 60;
  const noPriv = !v.vapidPrivateKey;
  if (noPub && noPriv) return '缺公钥+私钥';
  if (noPub) return '缺公钥';
  if (noPriv) return '缺私钥';
  return 'ready';
}

function maskHostsInText(text: string, hosts: string[]): string {
  let out = text;
  for (const h of hosts) {
    if (!h) continue;
    const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), '<host-masked>');
  }
  return out;
}

function extractHost(url: string | undefined): string {
  if (!url) return '';
  try { return new URL(url).host; } catch { return ''; }
}

const RESPONSE_SNIPPET_LIMIT = 400;
const PAYLOAD_TOP_LIMIT = 10;

// 走 wire 时这些字段是 secret 或可识别的用户标识, 不能进弹窗
const PAYLOAD_PATH_BLACKLIST = new Set([
  'apiKey',
  'apiUrl',
  'pushSubscription.endpoint',
  'pushSubscription.keys.p256dh',
  'pushSubscription.keys.auth',
]);

/**
 * 递归收集 payload 里每个叶子 (string/number/bool) 的 JSON 大小, 按从大到小排序取前 N.
 * 大小用 JSON.stringify(...).length, 跟 sendInstantPush 里的 body.length 同度量
 * (UTF-16 code units), 加起来能跟 bodyBytes 大致对得上, 方便用户判断"是哪一项把
 * body 撑到 78KB". 不返回值本身, 只返回路径 + 大小, 避免漏密.
 */
function collectPayloadTop(payload: unknown, limit = PAYLOAD_TOP_LIMIT): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = [];
  const walk = (v: unknown, path: string) => {
    if (v === null || v === undefined) return;
    if (PAYLOAD_PATH_BLACKLIST.has(path)) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      // JSON.stringify 给 string 加引号 + 转义, 比 .length 更接近 body 实际占用
      out.push({ path: path || '<root>', bytes: JSON.stringify(v).length });
      return;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`);
      return;
    }
    if (typeof v === 'object') {
      for (const k of Object.keys(v as Record<string, unknown>)) {
        walk((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
    }
  };
  try { walk(payload, ''); } catch { /* defensive: 循环引用等 */ }
  out.sort((a, b) => b.bytes - a.bytes);
  return out.slice(0, limit);
}

/** 把 diagnostics 渲染成 ErrorDialog 用的多行文本. 字段按段分块, 缺失段自动跳过. */
export function formatDiagnostics(
  diag: InstantDiagnostics,
  opts: { outcome: InstantOutcome; reason?: string },
): string {
  const lines: string[] = [];
  lines.push(`outcome: ${opts.outcome}`);
  if (opts.reason) lines.push(`reason: ${opts.reason}`);

  if (diag.http) {
    lines.push('', '— http —');
    const st = diag.http.statusText ? ` ${diag.http.statusText}` : '';
    lines.push(`status: ${diag.http.status}${st}`);
    lines.push(`bodyBytes: ${diag.http.bodyBytes}`);
    lines.push(
      `keepalive: ${diag.http.keepalive ? 'on' : `off (>${diag.http.keepaliveLimit}B 自动降级)`}`,
    );
    if (diag.http.cfRay) lines.push(`cf-ray: ${diag.http.cfRay}`);
    if (diag.http.responseSnippet) {
      lines.push('response:');
      lines.push(diag.http.responseSnippet);
    }
  }
  if (diag.fetchError) {
    lines.push('', '— fetch error —');
    if (diag.fetchError.name) lines.push(`name: ${diag.fetchError.name}`);
    if (diag.fetchError.message) lines.push(`message: ${diag.fetchError.message}`);
  }
  if (diag.config) {
    lines.push('', '— config —');
    lines.push(`enabled: ${diag.config.enabled}`);
    lines.push(`workerUrl: ${diag.config.workerUrlFilled ? '已填' : '未填'}`);
    lines.push(`vapid: ${diag.config.vapid}`);
  }
  if (diag.subscription) {
    lines.push('', '— subscription —');
    if (diag.subscription.reason) lines.push(`reason: ${diag.subscription.reason}`);
    if (diag.subscription.notifPermission) lines.push(`notif: ${diag.subscription.notifPermission}`);
    if (diag.subscription.swRegistered !== undefined) {
      lines.push(`sw: ${diag.subscription.swRegistered ? 'registered' : 'not registered'}`);
    }
    if (diag.subscription.cleanedDeadEndpoint) lines.push('cleaned dead endpoint');
  }
  if (diag.timeout) {
    lines.push('', '— timeout —');
    lines.push(`waited: ${diag.timeout.waitedMs}ms`);
    if (diag.timeout.httpStatusWhenDispatched !== undefined) {
      lines.push(`dispatched: HTTP ${diag.timeout.httpStatusWhenDispatched} (worker 收到了, 但 push 没回来)`);
    } else {
      lines.push('dispatched: 状态未知 (fetch 还没 resolve 就超时)');
    }
  }
  if (diag.payloadTop && diag.payloadTop.length) {
    lines.push('', '— payload top —');
    // 路径太长时右对齐大小不好看, 直接 path: bytes 简单清晰
    const maxPathLen = Math.min(50, Math.max(...diag.payloadTop.map((x) => x.path.length)));
    for (const item of diag.payloadTop) {
      const p = item.path.length > maxPathLen ? item.path.slice(0, maxPathLen - 1) + '…' : item.path;
      lines.push(`${p.padEnd(maxPathLen, ' ')}  ${item.bytes}`);
    }
  }
  if (diag.context) {
    lines.push('', '— context —');
    if (diag.context.char) lines.push(`char: ${diag.context.char}`);
    if (diag.context.model) lines.push(`model: ${diag.context.model}`);
    if (diag.context.msgCount !== undefined) {
      const bytes = diag.context.msgBytes;
      const sizeStr = bytes !== undefined ? ` (~${(bytes / 1024).toFixed(1)}KB)` : '';
      lines.push(`msgs: ${diag.context.msgCount}${sizeStr}`);
    }
  }
  lines.push('', '— env —');
  lines.push(`ua: ${diag.env.ua}`);
  lines.push(`online: ${diag.env.online}`);
  lines.push(`notif: ${diag.env.notif}`);
  lines.push(`sw: ${diag.env.sw}`);
  lines.push(`time: ${diag.env.time}`);
  return lines.join('\n');
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface PushSubscriptionInfo {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface InstantPushPayload {
  contactName: string;
  apiUrl: string;
  apiKey: string;
  primaryModel: string;
  pushSubscription: PushSubscriptionInfo;
  // completePrompt 与 messages 二选一：worker 端 amsg-instant 0.5.0+ 同时认这两路。
  // avatarUrl: 0.6.0 起 worker 端强制校验, 仅接受 http(s) URL (≤2KB), data: 被拒。
  // - completePrompt：测试推送 / 简单 one-shot 路径继续用
  // - messages：与本地 chat completions 完全等价的 system/user/assistant 数组
  completePrompt?: string;
  messages?: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | unknown[];
  }>;
  avatarUrl?: string;
  maxTokens?: number;
  temperature?: number;
  messageSubtype?: string;
  metadata?: Record<string, unknown>;
  // Phase 2 Round 1: 客户端预分配 sessionId, 写入 outbound_sessions 后传给 worker.
  // amsg-instant 0.6.x worker 会忽略不识别的字段, 0.8+ 会用它作为 agentic-loop 会话标识.
  // sendInstantPushAndAwaitReply 自动注入; 直接调用 sendInstantPush 的低阶路径 (e.g. 测试推送)
  // 可省略, 此时 worker 行为退化到 v0.6 one-shot.
  sessionId?: string;
  // 副 API 情绪评估: 客户端把拼好的 eval prompt + 副 API 凭据塞这里, worker 包装层 (worker/instant-push)
  // 在主回复跑完后用它跑一次 eval LLM, 把结果作为 emotion_update push 推回. 框架本身忽略此字段,
  // 不会回显到 push, 所以 api.apiKey 不会泄露. 仅顶层传, 不放 metadata.
  emotionEval?: {
    prompt: string;
    api: { baseUrl: string; apiKey: string; model: string };
  };
  // SullyOS Worker wrapper 读取这个字段决定本次大 payload 用 multipart 还是 D1 envelope。
  // amsg-instant 本体会忽略未知字段, 所以旧包也能安全接收。
  oversizeTransport?: InstantOversizeTransport;
}

export interface InstantWorkerCapabilityResult {
  ok: boolean;
  error?: string;
  d1Available?: boolean;
  d1Reason?: string;
  multipartAvailable?: boolean;
  raw?: unknown;
}

export interface InstantWorkerVersionResult {
  /** 仅当 worker 自报版本 = 随包 INSTANT_WORKER_VERSION 时为 true。其它任何情况 (404 / 405 /
   *  网络错误 / 版本对不上) 都算 false —— 老 bundle 根本没有 /version 路由, 拉不到就当不是最新。 */
  ok: boolean;
  /** worker 自报的版本号 (仅 ok=true 时有值); 调试用, 不影响 UI 判定。 */
  version?: string;
  error?: string;
}

// ── localStorage helpers ───────────────────────────────────────────────────

const DEFAULT_CONFIG: InstantPushConfig = {
  enabled: false,
  workerUrl: '',
};

// 旧版本 (v1 之前) 把 vapidPublicKey 平铺在 InstantPushConfig 里。读取时
// 自动剥离掉，避免类型外泄；真正的 VAPID 现在统一从 pushVapid 读。
function stripLegacyVapid(parsed: Record<string, unknown>): InstantPushConfig {
  const { vapidPublicKey: _drop, ...rest } = parsed as Record<string, unknown> & { vapidPublicKey?: unknown };
  return { ...DEFAULT_CONFIG, ...(rest as Partial<InstantPushConfig>) };
}

export function loadInstantConfig(): InstantPushConfig {
  try {
    const raw = localStorage.getItem(INSTANT_PUSH_CONFIG_KEY);
    if (raw) return stripLegacyVapid(JSON.parse(raw));
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

export function saveInstantConfig(cfg: InstantPushConfig): void {
  try {
    localStorage.setItem(INSTANT_PUSH_CONFIG_KEY, JSON.stringify({ ...cfg, updatedAt: Date.now() }));
  } catch { /* ignore */ }
}

export function clearInstantConfig(): void {
  try { localStorage.removeItem(INSTANT_PUSH_CONFIG_KEY); } catch { /* ignore */ }
}

export function isInstantConfigReady(cfg?: InstantPushConfig): boolean {
  const c = cfg ?? loadInstantConfig();
  return (
    c.enabled &&
    c.workerUrl.startsWith('https://') &&
    isPushVapidReady()
  );
}

/** Normalize a worker URL: trim whitespace and strip trailing slashes. */
export function normalizeWorkerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function getInstantOversizeTransport(cfg?: InstantPushConfig): InstantOversizeTransport {
  const c = cfg ?? loadInstantConfig();
  return c.useD1BlobStore ? 'd1' : 'multipart';
}

async function resolveSafeFetchText(res: Response): Promise<{ text: string; parsed: any }> {
  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { text, parsed };
}

/**
 * GET {workerUrl}/version 拉用户部署的 worker 的自报版本, 跟随包的 INSTANT_WORKER_VERSION
 * 比对。判定是二元的: 只有"拿到合法响应且版本字符串完全相等"才算 ok, 其它通通是"不是最新"
 * (老 bundle 根本没这条路由, 拉不到 = 旧版)。
 *
 * 故意不区分 404 / 405 / 网络错误 / 版本不匹配 —— 用户视角下都是"该重新部署"。
 */
export async function probeInstantWorkerVersion(
  cfg: InstantPushConfig = loadInstantConfig(),
): Promise<InstantWorkerVersionResult> {
  const workerUrl = normalizeWorkerUrl(cfg.workerUrl || '');
  if (!workerUrl.startsWith('https://')) {
    return { ok: false, error: 'Worker URL 未配置或不是 https' };
  }
  try {
    const res = await fetch(`${workerUrl}/version`, { method: 'GET' });
    const { parsed } = await resolveSafeFetchText(res);
    if (!res.ok) {
      return { ok: false, error: parsed?.error?.message ?? `HTTP ${res.status}` };
    }
    const version = parsed?.data?.version;
    if (typeof version !== 'string' || !version) {
      return { ok: false, error: 'Worker 未返回版本号' };
    }
    if (version !== INSTANT_WORKER_VERSION) {
      return { ok: false, version, error: `Worker 自报 ${version}, 不是最新` };
    }
    return { ok: true, version };
  } catch (e) {
    const err = e as { message?: string } | null;
    return { ok: false, error: err?.message ?? String(e) };
  }
}

export async function probeInstantWorkerCapabilities(
  cfg: InstantPushConfig = loadInstantConfig(),
): Promise<InstantWorkerCapabilityResult> {
  const workerUrl = normalizeWorkerUrl(cfg.workerUrl || '');
  if (!workerUrl.startsWith('https://')) {
    return { ok: false, error: 'Worker URL 未配置或不是 https' };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.clientToken) headers['X-Client-Token'] = cfg.clientToken;

  try {
    const res = await fetch(`${workerUrl}/capabilities`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    const { text, parsed } = await resolveSafeFetchText(res);

    if (!res.ok) {
      return {
        ok: false,
        error: parsed?.error?.message ?? `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`,
        raw: parsed ?? text,
      };
    }
    if (!parsed?.success) {
      return {
        ok: false,
        error: parsed?.error?.message ?? 'Worker 未返回 capabilities',
        raw: parsed ?? text,
      };
    }

    const data = parsed.data ?? {};
    const d1 = data.d1 ?? data.oversizeTransport?.d1 ?? {};
    return {
      ok: true,
      d1Available: !!d1.available,
      d1Reason: typeof d1.reason === 'string' ? d1.reason : undefined,
      multipartAvailable: data.multipart?.available !== false,
      raw: data,
    };
  } catch (e) {
    const err = e as { message?: string } | null;
    return { ok: false, error: err?.message ?? String(e) };
  }
}

/**
 * 复制最新版 worker bundle 到剪贴板。Settings 部署区和「Worker 有更新」弹窗
 * 共用同一份逻辑, 避免两边 fetch 路径漂移。
 *
 * 抛出原始错误让调用方决定怎么显示 (toast / inline status / 不显示)。
 */
export async function copyInstantWorkerBundleToClipboard(): Promise<void> {
  const base = import.meta.env.BASE_URL || '/';
  const res = await fetch(`${base}instant-worker.bundle.js`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  await navigator.clipboard.writeText(text);
}

/**
 * 根据用户填的 workerUrl 推算 Cloudflare dashboard 编辑界面的 deep link。
 *
 * Cloudflare 接受 `?to=/:account/...` 模式, 登录后会自动用当前账号 ID 替换 :account
 * (多账号会出选择器)。这样我们不需要知道用户的 account ID, 只要从 workers.dev
 * 子域名里抠出 worker name 就能直达 /production 编辑界面。
 *
 * 非 workers.dev 域名 (自定义域 / 反代) 没法可靠反推 worker name, 退回 worker 列表页,
 * 用户自己点项目名进去 —— 这类用户清楚自己的部署结构, 不会被卡住。
 */
export function buildCloudflareDashboardUrl(workerUrl: string | undefined): string {
  const FALLBACK = 'https://dash.cloudflare.com/?to=/:account/workers/overview';
  if (!workerUrl) return FALLBACK;
  try {
    const u = new URL(workerUrl);
    if (u.hostname.endsWith('.workers.dev')) {
      const workerName = u.hostname.split('.')[0];
      if (workerName) {
        return `https://dash.cloudflare.com/?to=/:account/workers/services/view/${encodeURIComponent(workerName)}/production`;
      }
    }
  } catch { /* invalid url → fallback */ }
  return FALLBACK;
}

// ── Web Push subscription helpers ─────────────────────────────────────────
//
// 与 proactivePushConfig 共用一份 race 处理 / encoding helpers, 实现在
// pushSubscribeShared.ts.

export async function getOrCreateInstantSubscription(
  vapidPublicKey?: string,
): Promise<{ sub: PushSubscriptionInfo | null; reason?: string }> {
  // 不传则从 pushVapid 取 — Proactive / Instant 共用一份, 不再互踢订阅.
  const pub = (vapidPublicKey || loadPushVapid().vapidPublicKey || '').trim();
  if (pub.length < 60) {
    return { sub: null, reason: 'VAPID 公钥未配置, 请到 Settings → Instant Push 生成并保存' };
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { sub: null, reason: '当前浏览器不支持 Service Worker 或 Push API' };
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();

  if (sub && isDeadPushEndpoint(sub.endpoint)) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    // 等浏览器清内部 removed 标记, 否则下面 subscribe() 又拿到死哨兵
    await new Promise(r => setTimeout(r, SUBSCRIBE_SETTLE_MS));
    sub = null;
  }

  if (sub) {
    // Re-subscribe if VAPID key changed
    try {
      const existingKey = bytesToB64u(sub.options.applicationServerKey);
      if (existingKey && existingKey !== pub) {
        await sub.unsubscribe();
        await new Promise(r => setTimeout(r, SUBSCRIBE_SETTLE_MS));
        sub = null;
      }
    } catch { /* fall through */ }
  }

  if (!sub) {
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return { sub: null, reason: '通知权限未授予' };
    } else if (Notification.permission === 'denied') {
      return { sub: null, reason: '通知权限已被拒绝（请到浏览器站点设置里手动开启）' };
    }
    const fresh = await subscribeWithRetry(reg, pub, '[InstantPush]');
    if (!fresh.sub) return { sub: null, reason: fresh.reason };
    sub = fresh.sub;
  }

  const p256dh = bytesToB64u(sub.getKey('p256dh'));
  const auth = bytesToB64u(sub.getKey('auth'));
  if (!p256dh || !auth) return { sub: null, reason: '订阅缺少加密公钥（p256dh / auth）' };

  return {
    sub: {
      endpoint: sub.endpoint,
      keys: { p256dh, auth },
    },
  };
}

// ── Send helpers ───────────────────────────────────────────────────────────
//
// 直接走原生 fetch（曾经走 ReiClient，0.5.0 起 amsg 客户端只是 fetch 薄壳，
// 我们改裸 fetch 是为了暴露 `keepalive: true` 选项 —— 浏览器进程被杀（iOS PWA
// swipe-up 是典型场景）时浏览器仍会努力把已 dispatch 的请求送达，避免 worker
// 收不到导致没推送回来。

// `keepalive: true` 限制 body ≤ 64KB。超过则降级为普通 fetch（杀进程会丢包），
// 给点 margin 避免边界 case。
const KEEPALIVE_MAX_BODY = 60 * 1024;

/**
 * 计算字符串的 UTF-8 字节长度. 浏览器 keepalive 64KiB 上限是按字节算的, 用
 * `body.length` (UTF-16 code units) 会让中文 / emoji 这种多字节字符的实际请求
 * 大小被低估 ~3x, 守卫放行后浏览器直接拒, fetch 抛 TypeError: Failed to fetch.
 * 也给诊断面板的 bodyBytes / msgBytes 用同一份, 排错时显示的 KB 才跟实际一致.
 */
export function byteLengthOf(body: string): number {
  // TextEncoder 在 Worker / iOS Safari 15.4+ / Chrome 38+ 全平台可用; SSR 中性,
  // 该路径只跑在浏览器 fetch 之前.
  return new TextEncoder().encode(body).length;
}

export interface SendInstantPushResult {
  ok: boolean;
  error?: string;
  data?: unknown;
  /** 失败时 (HTTP 非 2xx 或 worker 返回 success:false) 的 http 段诊断 */
  http?: InstantDiagnostics['http'];
  /** fetch throw 时 (网络层 / CORS / AbortError) 的诊断 */
  fetchError?: InstantDiagnostics['fetchError'];
  /** 失败时附 payload top10 字段路径 + 大小, 给 413 / 超大 body 定位用 */
  payloadTop?: InstantDiagnostics['payloadTop'];
}

export async function sendInstantPush(
  payload: InstantPushPayload,
  options: { keepalive?: boolean; onDispatched?: () => void } = {},
): Promise<SendInstantPushResult> {
  const cfg = loadInstantConfig();
  if (!isInstantConfigReady(cfg)) {
    return { ok: false, error: '请先在 Settings → Instant Push 里配置并保存' };
  }
  const url = `${normalizeWorkerUrl(cfg.workerUrl || '')}/instant`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (cfg.clientToken) headers['X-Client-Token'] = cfg.clientToken;
  // amsg-instant 0.8+ 删了 splitPattern 字段, lib 不再做 split, hook
  // 自己返 pushPayloads 数组. caller 这边不用再兜底注入。
  // oversizeTransport 是 SullyOS Worker wrapper 字段, 用前台开关决定本次大包走 multipart / D1。
  const wirePayload: InstantPushPayload = {
    ...payload,
    oversizeTransport: getInstantOversizeTransport(cfg),
  };
  const body = JSON.stringify(wirePayload);
  const bodyBytes = byteLengthOf(body);
  const useKeepalive = !!options.keepalive && bodyBytes <= KEEPALIVE_MAX_BODY;
  const maskedHosts = [
    extractHost(cfg.workerUrl),
    extractHost(payload.apiUrl),
    extractHost(payload.pushSubscription?.endpoint),
  ].filter(Boolean);
  try {
    // fetch() 同步 return Promise 时，浏览器已把请求排进网络栈，keepalive:true
    // 让浏览器在进程被杀后仍努力送达。这一刻就是"安全可杀"，立刻通知 UI；不能
    // 等 await resolve —— worker 端 LLM + push 全跑完才回 200，那时 push 可能
    // 比 response 更早到达浏览器，UI 会出现"AI 回复都到了气泡还半透明"。
    const fetchPromise = fetch(url, { method: 'POST', headers, body, keepalive: useKeepalive });
    options.onDispatched?.();
    const res = await fetchPromise;
    // res.text() 只能调一次 —— 拿原文后再 try parse JSON, 比先 json() 后 text() 灵活,
    // 而且 CF 边缘错误页是 HTML, json() 会 throw 丢掉原文.
    const { text: rawText, parsed } = await resolveSafeFetchText(res);
    if (!res.ok) {
      const snippet = rawText
        ? maskHostsInText(rawText.slice(0, RESPONSE_SNIPPET_LIMIT), maskedHosts)
        : undefined;
      const cfRay = res.headers.get('cf-ray') || undefined;
      const errMsg = parsed?.error?.message ?? `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`;
      // 完整 URL 等敏感字段不进弹窗, 但写到 console 给本地开发者
      log.error('HTTP failure', { url, status: res.status, statusText: res.statusText, body: rawText });
      return {
        ok: false,
        error: errMsg,
        http: {
          status: res.status,
          statusText: res.statusText || undefined,
          bodyBytes,
          keepalive: useKeepalive,
          keepaliveLimit: KEEPALIVE_MAX_BODY,
          cfRay,
          responseSnippet: snippet,
        },
        payloadTop: collectPayloadTop(wirePayload),
      };
    }
    if (parsed?.success) return { ok: true, data: parsed.data };
    return {
      ok: false,
      error: parsed?.error?.message ?? '发送失败',
      http: {
        status: res.status,
        statusText: res.statusText || undefined,
        bodyBytes,
        keepalive: useKeepalive,
        keepaliveLimit: KEEPALIVE_MAX_BODY,
        cfRay: res.headers.get('cf-ray') || undefined,
        responseSnippet: rawText
          ? maskHostsInText(rawText.slice(0, RESPONSE_SNIPPET_LIMIT), maskedHosts)
          : undefined,
      },
      payloadTop: collectPayloadTop(wirePayload),
    };
  } catch (e) {
    const err = e as { name?: string; message?: string } | null;
    log.error('fetch threw', { url, err });
    return {
      ok: false,
      error: err?.message ?? String(e),
      fetchError: { name: err?.name, message: err?.message ?? String(e) },
      payloadTop: collectPayloadTop(wirePayload),
    };
  }
}

// ── 高阶：发 + 等 push 落库 ───────────────────────────────────────────────
//
// 与 safeFetchJson 对称的"发起 + 等回复"单一入口：
// - 内部拿 push subscription、注册 'active-msg-received' 监听、超时兜底
// - 调用方只关心业务 payload (不含 pushSubscription)
// - outcome 区分不同失败成因，方便上层做 toast / 重试策略
//
// 用法：与本地路径 `await safeFetchJson(url, opts)` 完全对称。

export type InstantBusinessPayload = Omit<InstantPushPayload, 'pushSubscription'>;

export type InstantOutcome =
  | 'received'
  | 'timeout'
  | 'config-missing'
  | 'subscription-failed'
  | 'send-failed';

export interface InstantAwaitResult {
  ok: boolean;
  error?: string;
  outcome: InstantOutcome;
  /** 失败时附完整诊断, 给 ErrorDialog 经 formatDiagnostics() 渲染 */
  diagnostics?: InstantDiagnostics;
}

const DEFAULT_INSTANT_TIMEOUT_MS = 90_000;

// SSE 流结束后, 再给「SW 派发 → 客户端 flushInboxToChat 写完 DB」这一跳的宽限时长。
// 流跑完 (stream_done) 只代表 payload 都交给了 SW, 不代表已落库; 真正的成功信号是
// active-msg-received。这一跳正常 <1s, 给 8s 容错 (含 applyAssistantPostProcessing)。
const SSE_FLUSH_GRACE_MS = 8_000;
const INSTANT_TRACE_LOG_KEY = 'instant_push_trace_log_v1';
const INSTANT_TRACE_LOG_LIMIT = 200;

// 三写说明（故意不用 makeDebugLogger，因为 trace 跟普通 logger 的语义不一样）：
//   1) console.info → F12 看实时通道事件
//   2) localStorage ring buffer (instant_push_trace_log_v1, 200 条上限)
//      → 无条件抓的"通道自带 debug ring"，开发者随时可 localStorage.getItem 查
//   3) appendDevDebugLog → 用户勾了 IP 才录的"可控录制"，进复制 / 下载导出
// ring 跟 devDebug 的区别就是「无条件 vs 用户可控」，两套并存是有意的。
function instantTrace(
  sessionId: string,
  event: string,
  details: Record<string, unknown> = {},
): void {
  const entry = {
    ts: new Date().toISOString(),
    sessionId,
    event,
    visibility: typeof document !== 'undefined' ? document.visibilityState : 'n/a',
    online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
    ...details,
  };
  try {
    console.info('[InstantTrace]', entry);
  } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(INSTANT_TRACE_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const next = Array.isArray(list) ? [...list, entry].slice(-INSTANT_TRACE_LOG_LIMIT) : [entry];
    localStorage.setItem(INSTANT_TRACE_LOG_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  // gate 由 isCaptureEnabled('instant-push') 在 appendDevDebugLog 内部自动管，未勾时零成本。
  appendDevDebugLog('instant-push', { label: `trace:${event}`, data: entry });
}

// /instant 与 /continue 都把预分配的 sessionId 作为 SW 投递的 requestId; 优先取
// payload 自带的 instantTraceId (老格式兼容), 否则回落 sessionId / messageId。
function resolveInstantTraceId(payload: any, fallback?: string): string {
  const candidate =
    payload?.metadata?.instantTraceId ||
    payload?.sessionId ||
    payload?.messageId ||
    fallback ||
    'no-trace';
  return String(candidate);
}

export interface SsePostResult {
  /** SW 收下并分发了 payload (含去重命中); 超时 / 无 controller / 通道异常时为 false。 */
  ok: boolean;
  /**
   * amsg-sw 2.3.0+: SW 收下并分发了, 但业务回调 (写 inbox) 抛错时带上错误信息;
   * 此时 ok 仍为 true (ack 语义 = 已收下并分发, 非已落库)。上层据此把超时文案
   * 从笼统的「未确认写入」升级成精确的「SW 写库失败: <原因>」。
   */
  businessError?: string;
}

export async function postSsePayloadToServiceWorker(
  payload: any,
  traceId?: string,
  timeoutMs = 5_000,
): Promise<SsePostResult> {
  const resolvedTraceId = resolveInstantTraceId(payload, traceId);
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return { ok: false };
  }

  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    return { ok: false };
  }

  // 把 SSE 直达 payload 交给 SW 走通用 REI_AMSG_DELIVER 路由 (inbox/tool/emotion + dedupe)。
  // 用 MessageChannel 等 SW 回 ack: ok=true 表示 SW 收下 (可能是去重命中), 超时/异常按未达处理。
  // amsg-sw 2.3.0+ 的 ack 在落库失败时仍 ok:true 但带 businessError, 一并透传给上层。
  return await new Promise<SsePostResult>((resolve) => {
    const channel = new MessageChannel();
    let settled = false;

    const finish = (result: SsePostResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { channel.port1.close(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = window.setTimeout(() => finish({ ok: false }), timeoutMs);

    channel.port1.onmessage = (event) => {
      const data = (event.data || {}) as { ok?: unknown; businessError?: unknown };
      finish({
        ok: !!data.ok,
        businessError: typeof data.businessError === 'string' ? data.businessError : undefined,
      });
    };

    try {
      controller.postMessage({
        type: 'REI_AMSG_DELIVER',
        payload,
        source: 'sse',
        requestId: resolvedTraceId,
      }, [channel.port2]);
    } catch {
      finish({ ok: false });
    }
  });
}

function buildContextDiag(business: InstantBusinessPayload): InstantDiagnostics['context'] {
  let msgBytes: number | undefined;
  try {
    // 同 sendInstantPush 里的 bodyBytes: 用 UTF-8 真实字节, 中文每字 3 字节, 才能
    // 跟浏览器 64KiB keepalive 上限对上号; 旧版用 .length (UTF-16 单元) 中文会被低估.
    if (business.messages) msgBytes = byteLengthOf(JSON.stringify(business.messages));
    else if (business.completePrompt) msgBytes = byteLengthOf(business.completePrompt);
  } catch { /* ignore */ }
  return {
    char: business.contactName || undefined,
    model: business.primaryModel || undefined,
    msgCount: business.messages?.length ?? (business.completePrompt ? 1 : undefined),
    msgBytes,
  };
}

export async function sendInstantPushAndAwaitReply(
  business: InstantBusinessPayload,
  charId: string,
  timeoutMs: number = DEFAULT_INSTANT_TIMEOUT_MS,
  onPosted?: () => void,
): Promise<InstantAwaitResult> {
  // Phase 2 Round 1: 预分配 sessionId, 把 outbound session (messages + apiCredentials) 写到
  // IndexedDB 后传给 worker. amsg-instant 0.6.x 忽略该字段, 0.8+ 用作 agentic-loop /continue
  // 续跑标识.
  const sessionId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const env = await collectEnvSnapshot();
  const context = buildContextDiag(business);
  instantTrace(sessionId, 'send-start', {
    charId,
    contactName: business.contactName,
    model: business.primaryModel,
    msgCount: context?.msgCount,
    msgBytes: context?.msgBytes,
  });

  const cfg = loadInstantConfig();
  if (!isInstantConfigReady(cfg)) {
    instantTrace(sessionId, 'config-missing');
    return {
      ok: false,
      outcome: 'config-missing',
      error: '请先在 Settings → Instant Push 里配置并保存',
      diagnostics: {
        env, context,
        config: {
          enabled: !!cfg.enabled,
          workerUrlFilled: !!cfg.workerUrl && cfg.workerUrl.startsWith('https://'),
          vapid: describeVapid(),
        },
      },
    };
  }

  const { sub, reason } = await getOrCreateInstantSubscription();
  if (!sub) {
    instantTrace(sessionId, 'subscription-failed', { reason });
    let swRegistered: boolean | undefined;
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      try { swRegistered = !!(await navigator.serviceWorker.getRegistration()); } catch { /* ignore */ }
    }
    return {
      ok: false,
      outcome: 'subscription-failed',
      error: reason || '无法获取推送订阅',
      diagnostics: {
        env, context,
        subscription: {
          reason,
          notifPermission: env.notif,
          swRegistered,
        },
      },
    };
  }
  // 必须先挂监听再 send，否则极快的 push 可能漏掉
  let pushResolver: () => void = () => {};
  let receivedPushDetail: any = null;
  const pushArrived = new Promise<void>((resolve) => { pushResolver = resolve; });
  const pushHandler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.charId === charId) {
      receivedPushDetail = detail;
      instantTrace(sessionId, 'active-msg-received', {
        detailCharId: detail?.charId,
        bodyChars: typeof detail?.body === 'string' ? detail.body.length : undefined,
        emotionUpdate: !!detail?.emotionUpdate,
      });
      pushResolver();
    }
  };
  window.addEventListener('active-msg-received', pushHandler);

  try {
    await ActiveMsgStore.saveOutboundSession({
      sessionId,
      charId,
      messages: business.messages
        ? [...business.messages]
        : (business.completePrompt ? [{ role: 'user' as const, content: business.completePrompt }] : []),
      apiCredentials: {
        baseUrl: business.apiUrl,
        apiKey: business.apiKey,
        model: business.primaryModel,
      },
      createdAt: Date.now(),
    });
  } catch (e) {
    // outbound 写入失败不阻塞 push 主路径; Round 2 worker 升级前这条数据没人读
    log.warn('saveOutboundSession failed (non-fatal)', { sessionId, error: e });
  }

  const sendStartedAt = Date.now();
  const abortController = new AbortController();
  const abortOnPageHide = (event: PageTransitionEvent) => {
    instantTrace(sessionId, 'pagehide', { persisted: !!event.persisted });
    if (event.persisted) return;
    abortController.abort();
  };
  const traceVisibilityChange = () => {
    instantTrace(sessionId, 'visibilitychange');
  };
  let pageHideListenerAttached = false;
  let visibilityListenerAttached = false;
  try {
    const wirePayload: InstantPushPayload = {
      ...business,
      pushSubscription: sub,
      sessionId,
      oversizeTransport: getInstantOversizeTransport(cfg),
    };

    window.addEventListener('pagehide', abortOnPageHide, { once: true });
    pageHideListenerAttached = true;
    document.addEventListener('visibilitychange', traceVisibilityChange);
    visibilityListenerAttached = true;

    const reiClient = new ReiClient({
      baseUrl: normalizeWorkerUrl(cfg.workerUrl || ''),
      instantEncryption: false,
      instantClientToken: cfg.clientToken || '',
    });

    // postSsePayloadToServiceWorker 投递失败时返回 { ok:false } 而非 throw, 单看 stream
    // 是否跑完识别不出失败。这里记下投递结果, 供下面 stream_done 分支判定 / 诊断用。
    // amsg-sw 2.3.0+: ack 落库失败时 ok:true 但带 businessError —— 记下来好把超时文案
    // 从笼统的「未确认写入」升级成精确的「SW 写库失败: <原因>」。
    let sseDeliveredOk = false;
    let sseDeliveryFailed = false;
    let sseBusinessError: string | undefined;
    instantTrace(sessionId, 'sse-start', {
      oversizeTransport: wirePayload.oversizeTransport,
    });
    const streamPromise = reiClient.consumeInstantStream(wirePayload, '/instant', {
      signal: abortController.signal,
      onPayload: async (p: any) => {
        instantTrace(sessionId, 'sse-payload', {
          messageKind: p?.messageKind,
          messageId: p?.messageId,
          payloadSessionId: p?.sessionId,
          chunk: p?.messageIndex,
          total: p?.totalMessages,
          hasBlob: p?._blob === true,
        });
        const ack = await postSsePayloadToServiceWorker(p);
        if (ack.ok) sseDeliveredOk = true;
        else sseDeliveryFailed = true;
        if (ack.businessError) sseBusinessError = ack.businessError;
        instantTrace(sessionId, 'sse-payload-ack', {
          ok: ack.ok,
          businessError: ack.businessError,
        });
      },
    });
    // `consumeInstantStream()` calls fetch() synchronously before its first await,
    // so the request is now queued in the browser network stack.
    onPosted?.();
    instantTrace(sessionId, 'sse-dispatched');

    const result = await Promise.race([
      pushArrived.then(() => 'arrived' as const),
      streamPromise.then(() => 'stream_done' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs)),
    ]);
    instantTrace(sessionId, 'race-result', { result });

    if (result === 'timeout') {
      abortController.abort();
      instantTrace(sessionId, 'timeout', { waitedMs: Date.now() - sendStartedAt });
      appendDevDebugInstantPushLog({
        url: cfg.workerUrl,
        method: 'POST',
        status: 200,
        requestBody: {
          transport: 'instant-push-sse',
          sessionId,
          ...business,
          apiKey: business.apiKey ? '<redacted>' : '',
        },
        response: {
          outcome: 'timeout',
          waitedMs: Date.now() - sendStartedAt,
        },
      });
      return {
        ok: false,
        outcome: 'timeout',
        error: `AI 回复超时（${Math.round(timeoutMs / 1000)}s 未收到推送，检查 worker 或通知通道）`,
        diagnostics: {
          env, context,
          timeout: {
            waitedMs: Date.now() - sendStartedAt,
            httpStatusWhenDispatched: 200,
          },
        },
      };
    }

    // result === 'arrived' 才是确定成功 (active-msg-received 已 fire = 消息落库)。
    // result === 'stream_done' 只代表 worker 流结束 + payload 交给了 SW, 此时再给落库
    // 这一跳一个短宽限: 等到 pushArrived 才算成功; 等不到按未达处理, 杜绝「流跑完就报
    // 成功」的误报 (含 SW 投递失败只 resolve(false) 不抛、worker 因 SSE「成功」不再补
    // Web Push 兜底 → 消息静默丢失却报 received 的情形)。
    if (result === 'stream_done') {
      const flushed = await Promise.race([
        pushArrived.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), SSE_FLUSH_GRACE_MS)),
      ]);
      instantTrace(sessionId, 'stream-done-grace', {
        flushed,
        sseDeliveredOk,
        sseDeliveryFailed,
        sseBusinessError,
      });
      if (!flushed) {
        abortController.abort();
        const waitedMs = Date.now() - sendStartedAt;
        instantTrace(sessionId, 'flush-not-confirmed', { waitedMs });
        appendDevDebugInstantPushLog({
          url: cfg.workerUrl,
          method: 'POST',
          status: 200,
          requestBody: {
            transport: 'instant-push-sse',
            sessionId,
            ...business,
            apiKey: business.apiKey ? '<redacted>' : '',
          },
          response: {
            outcome: 'timeout',
            reason: sseBusinessError
              ? 'business-error'
              : (sseDeliveryFailed ? 'sse-delivery-failed' : 'flush-not-confirmed'),
            sseDeliveredOk,
            sseBusinessError,
            waitedMs,
          },
        });
        return {
          ok: false,
          outcome: 'timeout',
          error: sseBusinessError
            ? `AI 回复已生成，但本机 Service Worker 写入本地库失败（${sseBusinessError}），消息未落库 —— 刷新页面后重试`
            : sseDeliveryFailed
              ? 'AI 回复已生成，但本机 Service Worker 未确认收下（无 controller / 通道异常），消息可能未落库 —— 刷新页面后重试'
              : `AI 回复已生成，但 ${Math.round(SSE_FLUSH_GRACE_MS / 1000)}s 内未确认写入本地 —— 刷新页面后重试`,
          diagnostics: {
            env, context,
            timeout: {
              waitedMs,
              httpStatusWhenDispatched: 200,
            },
          },
        };
      }
    }

    appendDevDebugInstantPushLog({
      url: cfg.workerUrl,
      method: 'POST',
      status: 200,
      requestBody: {
        transport: 'instant-push-sse',
        sessionId,
        ...business,
        apiKey: business.apiKey ? '<redacted>' : '',
      },
      response: {
        outcome: 'received',
        push: receivedPushDetail,
      },
    });
    instantTrace(sessionId, 'received', {
      waitedMs: Date.now() - sendStartedAt,
      push: !!receivedPushDetail,
    });
    return { ok: true, outcome: 'received' };
  } catch (err: any) {
    instantTrace(sessionId, 'sse-catch', {
      name: err?.name,
      message: err?.message || String(err),
      waitedMs: Date.now() - sendStartedAt,
    });
    appendDevDebugInstantPushLog({
      url: cfg.workerUrl,
      method: 'POST',
      status: 500,
      requestBody: {
        transport: 'instant-push-sse',
        sessionId,
        ...business,
        apiKey: business.apiKey ? '<redacted>' : '',
      },
      response: {
        outcome: 'send-failed',
        error: String(err),
      },
    });
    return {
      ok: false,
      outcome: 'send-failed',
      error: err?.message || String(err),
      diagnostics: {
        env, context,
        fetchError: { message: err?.message || String(err) },
      },
    };
  } finally {
    if (pageHideListenerAttached) {
      try { window.removeEventListener('pagehide', abortOnPageHide); } catch { /* ignore */ }
    }
    if (visibilityListenerAttached) {
      try { document.removeEventListener('visibilitychange', traceVisibilityChange); } catch { /* ignore */ }
    }
    window.removeEventListener('active-msg-received', pushHandler);
    instantTrace(sessionId, 'cleanup');
  }
}

export async function sendTestInstantPush(
  apiConfig: APIConfig,
): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  if (!apiConfig.baseUrl) {
    return { ok: false, error: '请先在 Settings → API 里配置 Chat API' };
  }

  const cfg = loadInstantConfig();
  if (!isInstantConfigReady(cfg)) {
    return { ok: false, error: '请先配置并保存 Instant Push 设置' };
  }

  const { sub, reason } = await getOrCreateInstantSubscription();
  if (!sub) {
    return { ok: false, error: reason ?? '无法获取推送订阅' };
  }

  // amsg-instant 0.4.0+ runs normalizeAiApiUrl Worker-side; we can forward
  // apiConfig.baseUrl as-is (root / /v1 / full /chat/completions all accepted).
  //
  // metadata.test = true 让 SW push handler 绕过"前台跳过 showNotification"
  // 逻辑 — 测试就是要看到通知, 不能被前台静默吃掉.
  //
  // Phase 2 Round 2 (worker 升 0.8 + onLLMOutput hook): hook 路径**不接受** completePrompt
  // (worker 返 COMPLETE_PROMPT_NOT_SUPPORTED_ON_HOOK_PATH 400). 测试推送改用 messages 数组
  // 包一条 user 消息, 行为跟 0.6 路径下 worker 内部自动把 completePrompt 包成 single user msg 等价.
  return sendInstantPush({
    contactName: 'Instant Push 测试',
    messages: [{ role: 'user', content: '用一句话简短地和用户说一声 hi，确认 Instant Push 工作正常' }],
    apiUrl: apiConfig.baseUrl,
    apiKey: apiConfig.apiKey,
    primaryModel: apiConfig.model,
    pushSubscription: sub,
    metadata: { test: true },
  });
}
