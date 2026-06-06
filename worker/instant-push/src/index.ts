/**
 * SullyOS Instant Push — Cloudflare Worker entry.
 *
 * Phase 2 Round 2 (这次):
 *  - 升 @rei-standard/amsg-instant 到 0.8.1
 *  - 配置 onLLMOutput hook: SullyOS 业务标签分类器 (见 ./classifier.ts)
 *  - 数据标签 → tool-request push (客户端跑工具, POST /continue 续跑)
 *  - 副作用标签 → finish + metadata.directives (客户端重放)
 *  - 大 payload 默认走 amsg-instant generic multipart; 显式启用时才走 D1 BlobStore envelope.
 *
 * 入口仍是 createCloudflareWorker 工厂, env 在请求级注入 (secrets 在 wrangler.toml 外配置).
 */

import { createCloudflareWorker } from '@rei-standard/amsg-instant/adapters/cloudflare';
import { createD1BlobStore } from '@rei-standard/amsg-instant/blob/d1';
import {
  buildContentPush,
  buildToolRequestPush,
  MESSAGE_TYPE,
  PUSH_SOURCE,
} from '@rei-standard/amsg-shared';

import { classifyLLMOutput } from './classifier';
import { sanitizeIntoSegments, type Segment } from '../../../utils/sanitize';
import { INSTANT_WORKER_VERSION } from '../../../utils/instantWorkerVersion';

export interface Env {
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_EMAIL?: string;
  AMSG_CLIENT_TOKEN?: string;
  /**
   * 大 payload 传输策略:
   * - unset / "multipart": 默认, 不依赖 D1, 超限时拆成 _multipart push.
   * - "d1" / "blob" / "blobstore": 显式启用 D1 BlobStore envelope.
   * - "auto": 有 DB binding 时用 D1, 否则 multipart.
   */
  AMSG_OVERSIZE_TRANSPORT?: string;
  /** Back-compat boolean alias. true/1/on/yes => D1, false/0/off/no => multipart. */
  AMSG_ENABLE_D1_BLOBSTORE?: string;
  /**
   * 可选 D1 binding. 仅在前台请求 D1, 或 AMSG_OVERSIZE_TRANSPORT=d1/blob/blobstore/auto 时启用.
   * Worker 会自动初始化表结构并定期清理过期 blob row.
   */
  DB?: D1Database;
}

type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
};

type D1PreparedStatement = {
  bind(...args: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
};

type OversizeTransportMode = 'multipart' | 'd1' | 'auto';

const MULTIPART_TRANSPORT = { enabled: true };
const UTILITY_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Token',
  'Access-Control-Max-Age': '86400',
};
const D1_BLOB_TABLE = 'amsg_transient_blobs';
const D1_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const D1_CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${D1_BLOB_TABLE} (
  key        TEXT    PRIMARY KEY,
  body       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
)`;
const D1_CREATE_EXPIRES_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_amsg_blobs_expires
  ON ${D1_BLOB_TABLE}(expires_at)`;
const D1_DELETE_EXPIRED_SQL = `DELETE FROM ${D1_BLOB_TABLE} WHERE expires_at < ?`;

let d1SchemaReadyPromise: Promise<boolean> | null = null;
let lastD1CleanupAt = 0;
let d1CleanupPromise: Promise<void> | null = null;

/** Event types worth logging at error level — shared between cfWorker and emotion-eval handlers. */
const ERROR_EVENT_TYPES = new Set([
  'hook_threw',
  'loop_exceeded',
  'llm_call_failed',
  'blob_put_failed',
  'blob_orphaned',
  'payload_too_large',
  'multipart_too_large',
  'multipart_too_many_chunks',
]);

const TRACE_EVENT_TYPES = new Set([
  'sse_stream_aborted',
  'sse_stream_canceled',
  'sse_payload_enqueued',
  'sse_payload_enqueue_failed',
  'backup_push_scheduled',
  'backup_push_sent',
  'backup_push_failed',
  'fallback_push_sent',
  'fallback_push_failed',
  'sse_error_fallback_failed',
  'wait_until_rejected',
  'wait_until_failed',
]);

function traceAmsgEvent(e: { type: string; [k: string]: unknown }): void {
  if (ERROR_EVENT_TYPES.has(e.type)) {
    console.error('[instant-push]', e);
    return;
  }
  if (TRACE_EVENT_TYPES.has(e.type)) {
    console.log('[instant-push:trace]', e);
  }
}

function parseBooleanFlag(value: string | undefined): boolean | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function parseOversizeTransportMode(raw: string): OversizeTransportMode | null {
  const norm = raw.trim().toLowerCase();
  if (norm === 'multipart') return 'multipart';
  if (norm === 'd1' || norm === 'blob' || norm === 'blobstore') return 'd1';
  if (norm === 'auto') return 'auto';
  return null;
}

function resolveOversizeTransport(env: Env): OversizeTransportMode {
  const mode = parseOversizeTransportMode(env.AMSG_OVERSIZE_TRANSPORT || '');
  if (mode) return mode;

  const d1Flag = parseBooleanFlag(env.AMSG_ENABLE_D1_BLOBSTORE);
  if (d1Flag === true) return 'd1';
  if (d1Flag === false) return 'multipart';

  if ((env.AMSG_OVERSIZE_TRANSPORT || '').trim()) {
    console.warn(`[instant-push] Unknown AMSG_OVERSIZE_TRANSPORT="${env.AMSG_OVERSIZE_TRANSPORT}", using multipart.`);
  }
  return 'multipart';
}

function shouldUseD1BlobStore(env: Env): boolean {
  const mode = resolveOversizeTransport(env);
  return mode === 'd1' || (mode === 'auto' && !!env.DB);
}

function resolveRequestOversizeTransport(body: any): OversizeTransportMode | null {
  return parseOversizeTransportMode(String(body?.oversizeTransport || body?.amsgOversizeTransport || ''));
}

function withRequestOversizeTransport(env: Env, body: any): Env {
  const requested = resolveRequestOversizeTransport(body);
  if (!requested) return env;
  return {
    ...env,
    AMSG_OVERSIZE_TRANSPORT: requested,
    AMSG_ENABLE_D1_BLOBSTORE: requested === 'd1' ? 'true' : (requested === 'multipart' ? 'false' : env.AMSG_ENABLE_D1_BLOBSTORE),
  };
}

function forceMultipartTransport(env: Env): Env {
  return {
    ...env,
    AMSG_OVERSIZE_TRANSPORT: 'multipart',
    AMSG_ENABLE_D1_BLOBSTORE: 'false',
  };
}

async function ensureD1BlobSchema(env: Env): Promise<boolean> {
  if (!shouldUseD1BlobStore(env)) return false;
  if (!env.DB) {
    console.warn('[instant-push] D1 BlobStore requested but DB binding is missing; falling back to multipart.');
    return false;
  }

  if (!d1SchemaReadyPromise) {
    d1SchemaReadyPromise = (async () => {
      await env.DB!.batch([
        env.DB!.prepare(D1_CREATE_TABLE_SQL),
        env.DB!.prepare(D1_CREATE_EXPIRES_INDEX_SQL)
      ]);
      return true;
    })().catch((e) => {
      d1SchemaReadyPromise = null;
      console.error('[instant-push] D1 BlobStore schema init failed; falling back to multipart.', e);
      return false;
    });
  }

  return d1SchemaReadyPromise;
}

async function probeD1BlobCapability(env: Env): Promise<{ available: boolean; reason?: string }> {
  if (!env.DB) {
    return { available: false, reason: 'DB binding missing' };
  }
  const ready = await ensureD1BlobSchema({
    ...env,
    AMSG_OVERSIZE_TRANSPORT: 'd1',
    AMSG_ENABLE_D1_BLOBSTORE: 'true',
  });
  return ready
    ? { available: true }
    : { available: false, reason: 'D1 schema init failed' };
}

async function prepareBlobStoreEnv(env: Env): Promise<Env> {
  if (!shouldUseD1BlobStore(env)) return env;
  const ready = await ensureD1BlobSchema(env);
  return ready ? env : forceMultipartTransport(env);
}

function createBlobStore(env: Env) {
  if (!shouldUseD1BlobStore(env)) return undefined;
  if (!env.DB) {
    console.warn('[instant-push] D1 BlobStore requested but DB binding is missing; falling back to multipart.');
    return undefined;
  }
  return {
    adapter: createD1BlobStore(env.DB, { table: D1_BLOB_TABLE }),
    // 用默认 2600 B / 60 s; 见 amsg-instant README §BlobStore.
  };
}

async function cleanupExpiredD1Blobs(env: Env): Promise<void> {
  if (!shouldUseD1BlobStore(env) || !env.DB) return;

  if (d1CleanupPromise) return d1CleanupPromise;
  d1CleanupPromise = (async () => {
    const ready = await ensureD1BlobSchema(env);
    if (!ready) return;

    await env.DB!.prepare(D1_DELETE_EXPIRED_SQL)
      .bind(Date.now())
      .run();
  })()
    .catch((e) => {
      console.error('[instant-push] blob sweeper failed', e);
    })
    .finally(() => {
      d1CleanupPromise = null;
    });

  return d1CleanupPromise;
}

function scheduleD1BlobCleanup(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): void {
  if (!shouldUseD1BlobStore(env) || !env.DB) return;
  const now = Date.now();
  if (now - lastD1CleanupAt < D1_CLEANUP_INTERVAL_MS) return;
  lastD1CleanupAt = now;
  ctx.waitUntil(cleanupExpiredD1Blobs(env));
}

function utilityJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...UTILITY_CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function verifyUtilityClientToken(request: Request, env: Env): Response | null {
  const expected = (env.AMSG_CLIENT_TOKEN || '').trim();
  if (!expected) return null;
  const received = (request.headers.get('X-Client-Token') || '').trim();
  if (!received) {
    return utilityJson(401, {
      success: false,
      error: { code: 'CLIENT_TOKEN_REQUIRED', message: 'X-Client-Token required' },
    });
  }
  if (received !== expected) {
    return utilityJson(403, {
      success: false,
      error: { code: 'CLIENT_TOKEN_INVALID', message: 'X-Client-Token invalid' },
    });
  }
  return null;
}

// /version: 用户部署的 worker 自报版本日期。前端拿这个跟内置 INSTANT_WORKER_VERSION
// 比对, 不一致就提示重新部署。不要求 client token (这只是个静态查询, 不暴露任何
// secret), 也不接受 POST — 没有副作用就用 GET。
function handleVersionRequest(request: Request): Response {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: UTILITY_CORS_HEADERS });
  }
  if (request.method !== 'GET') {
    return utilityJson(405, {
      success: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET' },
    });
  }
  return utilityJson(200, {
    success: true,
    data: { version: INSTANT_WORKER_VERSION },
  });
}

async function handleCapabilitiesRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: UTILITY_CORS_HEADERS });
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    return utilityJson(405, {
      success: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST' },
    });
  }
  const tokenError = verifyUtilityClientToken(request, env);
  if (tokenError) return tokenError;

  const d1 = await probeD1BlobCapability(env);
  return utilityJson(200, {
    success: true,
    data: {
      multipart: { available: true },
      d1,
      defaultOversizeTransport: resolveOversizeTransport(env),
    },
  });
}

function buildAmsgOptions(env: Env) {
  return {
    vapid: {
      email: env.VAPID_EMAIL || 'mailto:noreply@example.com',
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    },
    blobStore: createBlobStore(env),
    multipart: MULTIPART_TRANSPORT,
    onEvent: (e: { type: string; [k: string]: unknown }) => {
      traceAmsgEvent(e);
    },
  };
}

const cfWorker = createCloudflareWorker((env: Env) => {
  return {
    ...buildAmsgOptions(env),
    clientToken: env.AMSG_CLIENT_TOKEN,
    maxLoopIterations: 10,
    sse: {
      backupPush: 'on',
      keepaliveMs: 1_000,
      immediateKeepalive: true,
    },
    onLLMOutput,
    onBeforeLoop: ({ requestBody }: any) => {
      if (!requestBody?.emotionEval) return undefined;
      // Start emotion eval in parallel (returns promise)
      return { emotionEval: runEmotionEval(requestBody) };
    },
    onAfterLoop: async ({ deliver, pending, requestBody, sessionId }: any) => {
      if (!pending?.emotionEval) return;

      try {
        const emotionRaw = await pending.emotionEval;
        // 无论成功 / 失败 / 空结果都推一条 emotion_update (emotionRaw 可能为空字符串):
        // 客户端据此熄灭 "情绪分析中" 徽章, 否则只能等本地安全超时, 体验上像卡死.
        const charId = requestBody?.charId || requestBody?.metadata?.charId || '';
        await deliver({
          messageKind: 'emotion_update',
          messageId: `msg_${sessionId}_emotion`,
          sessionId,
          metadata: {
            ...(requestBody?.metadata || {}),
            charId,
            emotionRaw,
          },
          notification: {
            show: 'when-hidden',
            silent: true,
            title: requestBody?.contactName ? `来自 ${requestBody.contactName}` : '主动消息',
            tag: `chat-message-${charId}`,
            body: '对方的情绪产生了波动...',
          }
        });
      } catch (err) {
        console.warn('[instant] emotion eval failed in onAfterLoop:', err);
      }
    },
  };
});

/**
 * 副 API 情绪评估 (worker 端). 框架的 onLLMOutput hook 故意不暴露 apiKey、也不允许自己发 LLM/push
 * (见 amsg-instant SessionContext 文档), 所以情绪评估的第二次 LLM 调用
 * 在 onBeforeLoop 并行启动，在 onAfterLoop 里用 deliver (SSE/Push) 追加推送.
 *
 * 失败全吞 (情绪评估失败不该影响主回复); emotion_update 携带静默 notification 属性防系统拉黑，客户端仍静默入 inbox。.
 */
async function runEmotionEval(body: any): Promise<string> {
  const ee = body?.emotionEval;
  if (!ee?.prompt || !ee?.api?.baseUrl || !ee?.api?.apiKey || !ee?.api?.model) {
    return '';
  }

  const charId = (body?.metadata && typeof body.metadata === 'object') ? body.metadata.charId : '';
  // 情绪评估 = 单条 user 消息, 与本地 buildEmotionEvalPrompt 输出**逐字对齐**. 客户端把 prompt 里
  // 两段大文本 (system prompt、对话历史) 留成占位符, 这里用本次请求已有的 messages 还原后替换回原位:
  //   - body.messages[0] (role=system) = 本地的 mainSystemPrompt
  //   - body.messages[1..]             = 本地的 cleanedApiMessages → 同格式拼成 recentLines
  // 这样上下文不必在请求体里重复发 (keepalive 不被降级), 评估质量/顺序与本地完全一致.
  const priorMessages = Array.isArray(body?.messages) ? body.messages : [];
  const contactName = body?.contactName || '角色';
  const flattenContent = (content: any): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((p: any) => (p?.type === 'text' ? (p.text || '') : (p?.type === 'image_url' ? '[图片]' : '')))
        .filter(Boolean)
        .join(' ');
    }
    return '';
  };
  let systemPromptText = '';
  let conversation = priorMessages;
  if (priorMessages.length > 0 && priorMessages[0]?.role === 'system') {
    systemPromptText = flattenContent(priorMessages[0].content);
    conversation = priorMessages.slice(1);
  }
  // 与本地 recentLines 完全同格式: `[用户]: ...` / `[角色名]: ...` / `[系统]: ...`, 用 \n 连接.
  const recentLines = conversation
    .map((m: any) => {
      const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? contactName : '系统');
      return `[${role}]: ${flattenContent(m.content)}`;
    })
    .join('\n');
  // 用函数式 replacer: 避免 systemPrompt / 对话里出现 $&、$1 等被 String.replace 当成替换模式解析.
  const evalContent = String(ee.prompt)
    .replace('__EMOTION_EVAL_SYSTEM_PROMPT__', () => systemPromptText)
    .replace('__EMOTION_EVAL_HISTORY__', () => recentLines);
  const evalMessages = [{ role: 'user', content: evalContent }];
  try {
    const baseUrl = String(ee.api.baseUrl).replace(/\/+$/, '');
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ee.api.apiKey || 'sk-none'}`,
      },
      body: JSON.stringify({
        model: ee.api.model,
        messages: evalMessages,
        temperature: 0.85,
        stream: false,
      }),
    });
    let raw = '';
    if (res.ok) {
      const data: any = await res.json();
      raw = data?.choices?.[0]?.message?.content || '';
    } else {
      console.error('[emotion-eval] LLM call failed', res.status);
    }

    return raw;
  } catch (e) {
    console.error('[emotion-eval] failed', e);
    return '';
  }
}

/**
 * 双导出: fetch + scheduled. D1 BlobStore 启用时 fetch 会自动初始化表结构,
 * 并顺手定期清理过期 blob row; scheduled 保留为可选的额外清理入口.
 *
 * fetch 在框架处理之外包了一层: 先把请求体克隆出来 (拿 emotionEval / pushSubscription),
 * 并行调度副 API 情绪评估 + 推 emotion_update. 主回复的 LLM 生成 + 切段 + 推送
 * 由 amsg-instant Cloudflare adapter 接收 ctx 后自己挂进 waitUntil.
 */
export default {
  fetch: async (request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) => {
    const url = new URL(request.url);
    if (url.pathname === '/version') {
      return handleVersionRequest(request);
    }
    if (url.pathname === '/capabilities' || url.pathname === '/health') {
      return handleCapabilitiesRequest(request, env);
    }

    let body: any = null;
    try {
      body = await request.clone().json();
    } catch {
      body = null; // 非 JSON / 解析失败: 不影响主路径
    }
    const requestedEnv = withRequestOversizeTransport({ ...env }, body);
    const workerEnv = await prepareBlobStoreEnv(requestedEnv);
    scheduleD1BlobCleanup(workerEnv, ctx);

    // 主回复由 amsg-instant 内部的 onBeforeLoop / waitUntil 驱动。
    return await (cfWorker as any).fetch(request, workerEnv, ctx);
  },
  async scheduled(_event: unknown, env: Env) {
    const workerEnv = await prepareBlobStoreEnv(env);
    await cleanupExpiredD1Blobs(workerEnv);
  },
};

/**
 * onLLMOutput hook — 每轮 LLM 输出后调一次, 返 decision payload.
 *
 * Thin shim: 从 amsg-instant SessionContext 读字段 + normalize, 再委托给纯函数
 * buildPushDecision. 业务逻辑 + 边界处理都在 buildPushDecision 里 (方便单测).
 *
 * @param ctx 见 amsg-instant SessionContext: { sessionId, messages, llmOutputText,
 *            iteration, metadata, contactName, avatarUrl, llmResponse, ... }
 */
async function onLLMOutput(ctx: any) {
  const decision = buildPushDecision({
    llmOutputText: String(ctx.llmOutputText ?? ''),
    sessionId: ctx.sessionId,
    iteration: Number(ctx.iteration ?? 0),
    contactName: ctx.contactName ?? '',
    avatarUrl: ctx.avatarUrl ?? null,
    // metadata 透传: 客户端 sendInstantPush 时塞了 charId; SW 路由要它分发到具体角色
    callerMetadata: (ctx.metadata && typeof ctx.metadata === 'object') ? ctx.metadata : {},
  });
  return decision;
}

// ─── Pure logic: 抽出来给单测 ──────────────────────────────────────────────

export interface PushDecisionInput {
  llmOutputText: string;
  sessionId: string;
  iteration: number;
  contactName: string;
  avatarUrl: string | null;
  callerMetadata: Record<string, unknown>;
}

export interface PushDecisionDeps {
  /** 自定义 size warn 回调; 默认走 console.warn. 测试用来 spy. */
  onSizeWarn?: (bytes: number) => void;
}

export type PushDecision =
  | { decision: 'tool-request'; pushPayloads: unknown[] }
  | { decision: 'finish'; pushPayloads: unknown[] }
  | { decision: 'skip-push' };

/**
 * 纯函数: 给 normalize 过的 ctx 字段, 出 { decision, pushPayloads }.
 *
 * amsg-instant 0.8+ hook 返回 pushPayloads 数组, lib 不做 split, hook
 * 自己负责把内容切成 N 个独立 push. 我们用 sanitizeIntoSegments 把 LLM 输出
 * 切成 segments (按换行 + CJK 空格切, 跟客户端 chatParser.chunkText 一致),
 * 每个 segment 一条 push, banner 显示 sanitized 版本, message 保留 raw 让客户端
 * Step 9/5/8 渲染.
 *
 * 空输入 / sanitize 全 strip 完没剩内容时返 skip-push (没东西可发, lib 跳过这一轮).
 *
 * Tool-request: classifier 提取的 prefix 切 segments 当 content push, 再 append
 * 一条 tool_request push 在末尾 (toolCalls 在那条上). decision 跟 push 内容
 * messageKind 分布解耦, lib 不检查.
 *
 * Directives (副作用标签): finish 路径只在**最后一条** push 的 metadata 上挂,
 * 防止客户端 N 条 inbox entry 都跑一次 replay (applyAssistantPostProcessing
 * 这边也加了 messageIndex==totalMessages 守卫双保险).
 */
export function buildPushDecision(
  input: PushDecisionInput,
  deps?: PushDecisionDeps,
): PushDecision {
  const { llmOutputText, sessionId, iteration, contactName, avatarUrl, callerMetadata } = input;

  const result = classifyLLMOutput(llmOutputText);
  const baseCommon = {
    messageType: MESSAGE_TYPE.INSTANT,
    source: PUSH_SOURCE.INSTANT,
    sessionId,
    contactName,
    avatarUrl,
  };

  const trimmedContactName = (contactName || '').trim();
  const notificationTitle = `来自 ${trimmedContactName || '主动消息'}`;

  if (result.kind === 'tool-request') {
    // 把 prefix narration 切 segments. classifier 已经剥 DATA tag, prefix 里只
    // 剩 narration 文字 (可能含 SEND_EMOJI / [html] 业务标签).
    const narrationSegments = sanitizeIntoSegments(result.prefix);
    const narrationPushes = narrationSegments.map((seg, i) =>
      buildSegmentPush({ seg, baseCommon, notificationTitle, callerMetadata, iteration, chunkIdx: i, sessionId }),
    );
    // tool_request push 在末尾, message 空 (narration 已经独立成 push), toolCalls 在
    // 这条上, 不带 notification → SW tool_request 分轨不弹 banner.
    const toolPush = {
      ...buildToolRequestPush({
        ...baseCommon,
        messageId: `msg_${sessionId}_${iteration}_toolreq`,
        message: '',
        toolCalls: result.toolCalls,
        metadata: {
          ...callerMetadata,
          iteration,
        },
      }),
    };
    const pushPayloads = [...narrationPushes, toolPush];
    pushPayloads.forEach((p) => warnIfPayloadLarge(p, deps?.onSizeWarn));
    return { decision: 'tool-request', pushPayloads };
  }

  // finish
  const segments = sanitizeIntoSegments(result.cleanedText);
  if (segments.length === 0) {
    // 整段没用户可见正文 (e.g. LLM 只吐 [[DIARY_START]]...[[DIARY_END]] / [[XHS_POST: ...]] /
    // [[ACTION:POKE]] 无 narration) 时:
    //   - 没 directives → 真的无事可做, skip-push
    //   - 有 directives → 发一条 directive-only push: message:'', 不带 notification (SW 不弹 banner),
    //     directives 挂 metadata. 客户端 applyAssistantPostProcessing 看到 directives 非空照常 replay,
    //     副作用 (写日记 / XHS_POST / POKE) 在重放中自己产 system message (e.g. `📔 X写了日记「…」`),
    //     用户在 chat 里看得到反馈, 不需要再弹 banner.
    if (result.directives.length === 0) {
      return { decision: 'skip-push' };
    }
    const directiveOnlyPush = buildDirectiveOnlyPush({
      baseCommon,
      callerMetadata,
      iteration,
      sessionId,
      directives: result.directives,
    });
    warnIfPayloadLarge(directiveOnlyPush, deps?.onSizeWarn);
    return { decision: 'finish', pushPayloads: [directiveOnlyPush] };
  }
  const lastIdx = segments.length - 1;
  const pushPayloads = segments.map((seg, i) =>
    buildSegmentPush({
      seg,
      baseCommon,
      notificationTitle,
      callerMetadata,
      iteration,
      chunkIdx: i,
      sessionId,
      // directives 只挂在最后一条 push 上, 客户端按 messageIndex==totalMessages 守卫
      directives: i === lastIdx ? result.directives : undefined,
    }),
  );
  pushPayloads.forEach((p) => warnIfPayloadLarge(p, deps?.onSizeWarn));
  return { decision: 'finish', pushPayloads };
}

/**
 * directive-only push — 当 LLM 输出整段全是副作用标签 (无 narration) 时用.
 *
 * 跟 buildSegmentPush 的区别:
 *  - message: ''        (客户端 applyAssistantPostProcessing 看 rawAiContent='' + replayedTagPrefix
 *                        重建副作用标签, 不会产生气泡: chunking 0 chunks → 0 bubble)
 *  - 不带 notification  (SW 不弹 banner — 副作用 handler 自己产 system message 给用户看)
 *  - chunkIdx 用 'directive' 占位字符串避免跟 segment 0 撞 messageId
 *
 * amsg-shared buildContentPush 允许 message:'', 只对 ReasoningPush 要求 non-empty (已查 next.5 schema).
 */
function buildDirectiveOnlyPush(args: {
  baseCommon: {
    messageType: typeof MESSAGE_TYPE.INSTANT;
    source: typeof PUSH_SOURCE.INSTANT;
    sessionId: string;
    contactName: string;
    avatarUrl: string | null;
  };
  callerMetadata: Record<string, unknown>;
  iteration: number;
  sessionId: string;
  directives: unknown[];
}): unknown {
  const { baseCommon, callerMetadata, iteration, sessionId, directives } = args;
  return buildContentPush({
    ...baseCommon,
    messageId: `msg_${sessionId}_${iteration}_directive`,
    message: '',
    metadata: {
      ...callerMetadata,
      iteration,
      directives,
    },
  });
}

/**
 * 单 segment → 单 ContentPush. messageId 显式给唯一值 ( amsg-shared typedef
 * 要求, 不能 undefined ). 0.8+ lib runtime 看到 hook 已设 messageId 就不动,
 * 只对未设的自动补 _chunk_${i} 后缀.
 */
function buildSegmentPush(args: {
  seg: Segment;
  baseCommon: {
    messageType: typeof MESSAGE_TYPE.INSTANT;
    source: typeof PUSH_SOURCE.INSTANT;
    sessionId: string;
    contactName: string;
    avatarUrl: string | null;
  };
  notificationTitle: string;
  callerMetadata: Record<string, unknown>;
  iteration: number;
  chunkIdx: number;
  sessionId: string;
  directives?: unknown[];
}): unknown {
  const { seg, baseCommon, notificationTitle, callerMetadata, iteration, chunkIdx, sessionId, directives } = args;
  // notification.body 跟 message 显示文本可以不一样 (SEND_EMOJI 在 banner 上是
  // [表情：x], 在 message 里是 [[SEND_EMOJI: x]] 让客户端 Step 9 渲染 sticker).
  // 即使 sanitized === raw 也照样塞 — 0.8+ lib 不再 clone notification 跨 chunk,
  // 每条独立, 不会重复占 size.
  return {
    ...buildContentPush({
      ...baseCommon,
      messageId: `msg_${sessionId}_${iteration}_chunk_${chunkIdx}`,
      message: seg.raw,
      metadata: {
        ...callerMetadata,
        iteration,
        ...(directives !== undefined ? { directives } : {}),
      },
    }),
    notification: { show: 'when-hidden', title: notificationTitle, body: seg.sanitized },
  };
}

/**
 * 早警告水位 — amsg-instant next.2 默认 maxInlineBytes=2600, 超了就 500
 * PAYLOAD_TOO_LARGE. 2300 留 ~300B margin 给 amsg-instant wrapping 字段
 * (kind/messageKind/_blob envelope 等). 默认 console.warn, 测试可注入
 * onSizeWarn 抓 bytes 参数.
 */
function warnIfPayloadLarge(
  payload: unknown,
  onSizeWarn?: (bytes: number) => void,
): void {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    if (bytes > 2300) {
      if (onSizeWarn) {
        onSizeWarn(bytes);
      } else {
        console.warn('[instant-push] payload close to limit', { bytes });
      }
    }
  } catch {
    // JSON.stringify 抛 (循环引用?) 时不阻塞主流程
  }
}
