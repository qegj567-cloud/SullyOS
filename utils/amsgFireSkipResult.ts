/**
 * 「这次到点没发」这条结果的形状 —— 纯函数零依赖，浏览器与 Cloudflare Worker 共用同一份。
 *
 * 定时主动消息到点没发出去（角色看了对话决定不说、被频率上限拦下、过期太久不补……）时，
 * worker 用 `ctx.emitResult` 把这件事送回客户端：落服务端收件箱、不弹通知，客户端上线
 * 必拉到。客户端据此给角色留一条回执（见 amsgFireSkipResultApply），角色下一轮聊天时
 * 就知道那条没发，可以决定带出、改期还是放下。
 *
 * 没发的原因只有云端知道，所以由云端说、本地照记。
 */

import { LAST_SKIP_REASONS, type AmsgLastSkip } from './amsgFirePack';

/** 结果的名字（`emitResult` 的 resultKind），客户端按它分流。 */
export const FIRE_SKIP_RESULT_KIND = 'fire-skipped';

export type AmsgFireSkipReason = AmsgLastSkip['reason'];

/**
 * 不给角色留回执的原因。schedule-off 是用户自己关掉的，取消那一刻面板已经留过
 * 「已被手动取消」的回执，再留一条就是同一件事说两遍。
 */
const SILENT_REASONS: ReadonlySet<AmsgFireSkipReason> = new Set(['schedule-off']);

/** 这个原因要不要送回客户端。 */
export const shouldReportFireSkip = (reason: AmsgFireSkipReason): boolean => !SILENT_REASONS.has(reason);

/** 被跳过的那条任务长什么样（云端认得就带上；认不得时客户端按 taskUuid 查本地清单）。 */
export interface AmsgFireSkipTaskBrief {
  mode: 'auto' | 'prompted' | 'fixed';
  promptHint?: string;
  recurrenceType: 'none' | 'daily' | 'weekly';
}

export type AmsgProactiveKind = 'away' | 'dateLeave' | 'self' | 'scheduled';

export interface AmsgFireSkipUsage {
  promptTokens?: number;
  completionTokens?: number;
  tokensPartial?: boolean;
}

export interface AmsgFireSkipResult {
  resultKind: typeof FIRE_SKIP_RESULT_KIND;
  v: 1;
  charId: string;
  taskUuid: string;
  /** 这次触发的名义时刻（epoch 毫秒）。 */
  occurrenceMs: number;
  reason: AmsgFireSkipReason;
  task?: AmsgFireSkipTaskBrief;
  /** 若本次跳过发生在模型生成之后（如模型判定不发、或生成期间用户开口避让），带回本轮实际消耗的用量。 */
  usage?: AmsgFireSkipUsage;
  proactiveKind?: AmsgProactiveKind;
}

const PROACTIVE_KINDS = ['away', 'dateLeave', 'self', 'scheduled'] as const;

const normalizeSkipUsage = (value: unknown): AmsgFireSkipUsage | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const u = value as Record<string, unknown>;
  const promptTokens = typeof u.promptTokens === 'number' && Number.isFinite(u.promptTokens)
    ? u.promptTokens : undefined;
  const completionTokens = typeof u.completionTokens === 'number' && Number.isFinite(u.completionTokens)
    ? u.completionTokens : undefined;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(u.tokensPartial === true ? { tokensPartial: true } : {}),
  };
};

/** 组一条结果（版本号只有这一处写，别在调用点手抄）。 */
export function buildFireSkipResult(args: {
  charId: string;
  taskUuid: string;
  occurrenceMs: number;
  reason: AmsgFireSkipReason;
  task?: AmsgFireSkipTaskBrief | null;
  usage?: AmsgFireSkipUsage;
  proactiveKind?: AmsgProactiveKind;
}): AmsgFireSkipResult {
  const usage = normalizeSkipUsage(args.usage);
  return {
    resultKind: FIRE_SKIP_RESULT_KIND,
    v: 1,
    charId: args.charId,
    taskUuid: args.taskUuid,
    occurrenceMs: args.occurrenceMs,
    reason: args.reason,
    ...(args.task
      ? {
        task: {
          mode: args.task.mode,
          ...(args.task.promptHint ? { promptHint: args.task.promptHint } : {}),
          recurrenceType: args.task.recurrenceType,
        },
      }
      : {}),
    ...(usage ? { usage } : {}),
    ...(args.proactiveKind ? { proactiveKind: args.proactiveKind } : {}),
  };
}

const MODES = ['auto', 'prompted', 'fixed'] as const;
const RECURRENCES = ['none', 'daily', 'weekly'] as const;

/** 读回一条结果；形状对不上返回 null（客户端据此销账丢弃并留日志）。 */
export function parseFireSkipResult(raw: unknown): AmsgFireSkipResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.resultKind !== FIRE_SKIP_RESULT_KIND || o.v !== 1) return null;
  if (typeof o.charId !== 'string' || !o.charId) return null;
  if (typeof o.taskUuid !== 'string' || !o.taskUuid) return null;
  if (typeof o.occurrenceMs !== 'number' || !Number.isFinite(o.occurrenceMs)) return null;
  if (!(LAST_SKIP_REASONS as readonly unknown[]).includes(o.reason)) return null;

  const t = o.task as Record<string, unknown> | undefined;
  const task = t && typeof t === 'object'
    && (MODES as readonly unknown[]).includes(t.mode)
    && (RECURRENCES as readonly unknown[]).includes(t.recurrenceType)
    ? {
      mode: t.mode as AmsgFireSkipTaskBrief['mode'],
      ...(typeof t.promptHint === 'string' && t.promptHint ? { promptHint: t.promptHint } : {}),
      recurrenceType: t.recurrenceType as AmsgFireSkipTaskBrief['recurrenceType'],
    }
    : undefined;
  const usage = normalizeSkipUsage(o.usage);
  const proactiveKind = (PROACTIVE_KINDS as readonly unknown[]).includes(o.proactiveKind)
    ? o.proactiveKind as AmsgProactiveKind
    : undefined;

  return {
    resultKind: FIRE_SKIP_RESULT_KIND,
    v: 1,
    charId: o.charId,
    taskUuid: o.taskUuid,
    occurrenceMs: o.occurrenceMs,
    reason: o.reason as AmsgFireSkipReason,
    ...(task ? { task } : {}),
    ...(usage ? { usage } : {}),
    ...(proactiveKind ? { proactiveKind } : {}),
  };
}
