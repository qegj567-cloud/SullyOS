/**
 * 代跑任务的契约（环境无关叶子模块）
 *
 * 「本机拼、云端代跑」：浏览器照原样拼好这次要发给模型的完整请求，不自己发，而是把消息和
 * 参数交给用户自己的 CF Worker；Worker 只负责调模型、把原始结果存成附件送回来，不理解
 * 任何业务。结果回到浏览器后由各功能原来的解析和落库代码处理（见 utils/cloudGen/）。
 *
 * 这份文件是 Worker 和浏览器共用的那张契约：任务种类、一次性输入放在哪、输入和结果长什么样。
 *
 * 往这里加代码前先确认：不 import 任何带浏览器依赖的模块（db / safeApi / context 等）。
 * `pnpm build:workers` 会把这份打进 amsg worker bundle。
 */

// ─── 种类与存放位置 ───────────────────────────────────

/** 任务的业务种类（metadata.amsgKind），Worker 按它分派到代跑 handler。 */
export const CLOUD_GEN_KIND = 'cloud-gen';

/** 结果的名字（emitResult 的 resultKind），客户端按它分流。 */
export const CLOUD_GEN_RESULT_KIND = 'cloud-gen';

/**
 * 代跑输入的 client_state 命名空间。
 *
 * 不和门牌整理共用 `amsg:job`：代跑输入装的是整份上下文（人格模拟一份就几十 KB），而
 * beforeFire 每次都要把整个命名空间读出来解密（上游没有按 key 点名的接口），挤在一起会
 * 让每次门牌整理都替它付解密的钱。Worker 给它配 clientStateTtl，跑完即删，TTL 兜底。
 */
export const CLOUD_GEN_NAMESPACE = 'amsg:cloud-gen';

/** 代跑输入在云端最多留几天（跑完就删，这只是删除失败时的兜底）。 */
export const CLOUD_GEN_TTL_DAYS = 3;

/** 代跑输入在命名空间里的 key。 */
export const cloudGenJobKey = (jobId: string): string => `gen:${jobId}`;

/** 任务 metadata 上标用途的键（Worker 的分组串行键要带上它）。 */
export const CLOUD_GEN_PURPOSE_META_KEY = 'amsgCloudGenPurpose';

/**
 * 单次代跑的总时长上限，与即时对话同一档。上游单轮模型调用另有 5 分钟的硬上限，
 * 这个值只决定租约和整条 fire 的耐心。
 */
export const CLOUD_GEN_TOTAL_TIMEOUT_MS = 600_000;

/** 接入代跑的功能。新增一项要同步 Worker bundle（结果和凭据行都按它认）。 */
export const CLOUD_GEN_PURPOSES = ['schedule', 'persona-sim', 'dream'] as const;
export type CloudGenPurpose = typeof CLOUD_GEN_PURPOSES[number];

export const isCloudGenPurpose = (value: unknown): value is CloudGenPurpose =>
  typeof value === 'string' && (CLOUD_GEN_PURPOSES as readonly string[]).includes(value);

/**
 * 分组串行键：同一角色同一用途一组。不同用途分开排，一次 24000 token 的人格模拟就挡不住
 * 日程；同组同时只该有一份在飞（客户端在飞登记表把关），否则后一份会被租约挡下、等 cron。
 */
export const cloudGenSerializeKey = (charId: string, purpose: string): string =>
  `${charId}#${CLOUD_GEN_KIND}#${purpose}`;

// ─── 输入（客户端写、Worker 读） ─────────────────────

export interface CloudGenMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CloudGenJobInput {
  v: 1;
  jobId: string;
  purpose: CloudGenPurpose;
  charId: string;
  /** 只用于云端数据管理里显示归属，Worker 不读。 */
  charName?: string;
  /** 本机那次请求的 messages，原样。只收纯文本。 */
  messages: CloudGenMessage[];
  /** 完成时的通知文案；null = 不通知，只进收件箱。 */
  notify: { title: string; body: string } | null;
}

export function buildCloudGenJobInput(args: Omit<CloudGenJobInput, 'v'>): CloudGenJobInput {
  return { v: 1, ...args };
}

const isRole = (value: unknown): value is CloudGenMessage['role'] =>
  value === 'system' || value === 'user' || value === 'assistant';

/** 读回输入。形状对不上返回 null：Worker 据此判这份输入坏了，不拿半份去生成。 */
export function parseCloudGenJobInput(raw: unknown): CloudGenJobInput | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (o.v !== 1 || typeof o.jobId !== 'string' || !o.jobId) return null;
  if (!isCloudGenPurpose(o.purpose) || typeof o.charId !== 'string' || !o.charId) return null;
  if (!Array.isArray(o.messages) || o.messages.length === 0) return null;
  const messages: CloudGenMessage[] = [];
  for (const m of o.messages) {
    const row = m as Record<string, unknown> | null;
    if (!row || !isRole(row.role) || typeof row.content !== 'string') return null;
    messages.push({ role: row.role, content: row.content });
  }
  let notify: CloudGenJobInput['notify'] = null;
  if (o.notify !== null) {
    const n = o.notify as Record<string, unknown> | undefined;
    if (!n || typeof n.title !== 'string' || typeof n.body !== 'string') return null;
    notify = { title: n.title, body: n.body };
  }
  return {
    v: 1, jobId: o.jobId, purpose: o.purpose, charId: o.charId, messages, notify,
    ...(typeof o.charName === 'string' ? { charName: o.charName } : {}),
  };
}

// ─── 附件里的原始结果 ─────────────────────────────────

/** 模型这一次回了什么。存成附件，不进推送正文（人格模拟一份就超过推送上限）。 */
export interface CloudGenOutput {
  v: 1;
  content: string;
  reasoning: string;
  finishReason: string | null;
}

export function parseCloudGenOutput(raw: unknown): CloudGenOutput | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  const o = obj as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || o.v !== 1) return null;
  if (typeof o.content !== 'string' || typeof o.reasoning !== 'string') return null;
  if (o.finishReason !== null && typeof o.finishReason !== 'string') return null;
  return { v: 1, content: o.content, reasoning: o.reasoning, finishReason: o.finishReason };
}

// ─── 结果（Worker 写、客户端读） ─────────────────────

export interface CloudGenAttachmentRef {
  version: 1;
  namespace: string;
  key: string;
  taskUuid: string;
  occurrenceMs: number;
  expiresAt: number;
}

/** 供应商回报的用量，只有数字和服务商自报的模型名。 */
export interface CloudGenUsage {
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  backendModel?: string;
}

interface CloudGenResultBase {
  resultKind: typeof CLOUD_GEN_RESULT_KIND;
  v: 1;
  jobId: string;
  purpose: CloudGenPurpose;
  charId: string;
  usage?: CloudGenUsage;
}

export type CloudGenResult =
  | (CloudGenResultBase & { ok: true; attachment: CloudGenAttachmentRef })
  | (CloudGenResultBase & { ok: false; error: { code: string; message: string } });

const finiteCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export const normalizeCloudGenUsage = (value: unknown): CloudGenUsage | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const u = value as Record<string, unknown>;
  const out: CloudGenUsage = {};
  for (const key of ['promptTokens', 'completionTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    const n = finiteCount(u[key]);
    if (n !== undefined) out[key] = n;
  }
  if (typeof u.backendModel === 'string' && u.backendModel) out.backendModel = u.backendModel.slice(0, 200);
  return Object.keys(out).length > 0 ? out : undefined;
};

const parseAttachmentRef = (value: unknown): CloudGenAttachmentRef | null => {
  const r = value as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || r.version !== 1) return null;
  if (typeof r.namespace !== 'string' || typeof r.key !== 'string' || typeof r.taskUuid !== 'string') return null;
  if (typeof r.occurrenceMs !== 'number' || typeof r.expiresAt !== 'number') return null;
  return {
    version: 1, namespace: r.namespace, key: r.key, taskUuid: r.taskUuid,
    occurrenceMs: r.occurrenceMs, expiresAt: r.expiresAt,
  };
};

/** 错误文案截短：它要进收件箱和界面，不该把上游整段报文带过来。 */
const ERROR_MESSAGE_MAX_CHARS = 300;

export function buildCloudGenResult(
  args: { jobId: string; purpose: CloudGenPurpose; charId: string; usage?: CloudGenUsage }
    & ({ ok: true; attachment: CloudGenAttachmentRef } | { ok: false; error: { code: string; message: string } }),
): CloudGenResult {
  const usage = normalizeCloudGenUsage(args.usage);
  const base = {
    resultKind: CLOUD_GEN_RESULT_KIND as typeof CLOUD_GEN_RESULT_KIND, v: 1 as const,
    jobId: args.jobId, purpose: args.purpose, charId: args.charId,
    ...(usage ? { usage } : {}),
  };
  return args.ok
    ? { ...base, ok: true, attachment: args.attachment }
    : {
      ...base, ok: false,
      error: { code: args.error.code.slice(0, 64), message: args.error.message.slice(0, ERROR_MESSAGE_MAX_CHARS) },
    };
}

/** 读回一条结果；形状对不上返回 null（客户端据此销账丢弃）。 */
export function parseCloudGenResult(raw: unknown): CloudGenResult | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.resultKind !== CLOUD_GEN_RESULT_KIND || o.v !== 1) return null;
  if (typeof o.jobId !== 'string' || !o.jobId || typeof o.charId !== 'string' || !o.charId) return null;
  if (!isCloudGenPurpose(o.purpose)) return null;
  const usage = normalizeCloudGenUsage(o.usage);
  const base = {
    resultKind: CLOUD_GEN_RESULT_KIND as typeof CLOUD_GEN_RESULT_KIND, v: 1 as const,
    jobId: o.jobId, purpose: o.purpose, charId: o.charId,
    ...(usage ? { usage } : {}),
  };
  if (o.ok === true) {
    const attachment = parseAttachmentRef(o.attachment);
    return attachment ? { ...base, ok: true, attachment } : null;
  }
  if (o.ok === false) {
    const e = o.error as Record<string, unknown> | null;
    const code = typeof e?.code === 'string' && e.code ? e.code : 'unknown';
    const message = typeof e?.message === 'string' ? e.message : '';
    return { ...base, ok: false, error: { code, message } };
  }
  return null;
}
