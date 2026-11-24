/**
 * 代跑的使用统计，属性全是写死的枚举（见 docs/analytics.md）：
 *   云端生成       每个结局一次（交出、转本机、落地、丢弃、失败）
 *   云端生成提示   小条和说明页上的点按
 *   切换云端生成   设置里按功能的「云端生成」「完成时通知」开关
 *
 * 只记用户想上云时发生了什么。没开 2.0、这个功能的云端生成关着、API 没配齐，这三种是
 * 配置状态不是结局，不记：否则没开 2.0 的八成设备每次进聊天都会冒一条「转本机」。
 */

import { trackEvent } from '../analytics';
import type { CloudGenFeatureSwitches } from './settings';
import { CLOUD_GEN_PURPOSE_META, type CloudGenLocalReason, type CloudGenPurpose } from './types';

export type CloudGenOutcome = 'submitted' | 'local' | 'landed' | 'discarded' | 'failed';

/** 丢弃的原因：stale = 落地函数判现场已经变了；unregistered = 登记表里查不到这一条。 */
export type CloudGenDiscardReason = 'stale' | 'unregistered';

/** 结果收尾时的原料。调用方给原始值，这里只挑写死的字面量往外报。 */
export interface CloudGenSettleDetail {
  /** 交出到云端生成完的毫秒数；不知道就不给，报「未知」。 */
  elapsedMs?: number;
  /** 交出之后页面进没进过后台；查不到登记时不给，这一项不报。 */
  leftPage?: boolean;
  /** 失败时的错误，只用来挑「原因」，原文不进上报。 */
  error?: { code: string; message: string };
  discardReason?: CloudGenDiscardReason;
}

export type CloudGenHintAction = 'open' | 'mute' | 'enter';

const OUTCOME_LABELS: Record<CloudGenOutcome, string> = {
  submitted: '已交云端', local: '转本机', landed: '已落地', discarded: '已丢弃', failed: '失败',
};

/** 转本机时上报的原因；不在表里的原因整条不报。 */
const LOCAL_REASON_LABELS: Partial<Record<CloudGenLocalReason, string>> = {
  'worker-unsupported': 'Worker太旧',
  'worker-unreachable': '连不上Worker',
  'unsupported-content': '内容不支持',
  'submit-failed': '提交失败',
  'kick-failed': '没能开跑',
};

const DISCARD_REASON_LABELS: Record<CloudGenDiscardReason, string> = {
  stale: '现场变了',
  unregistered: '查不到登记',
};

/** 失败码 → 原因。码来自上游 amsg-server、Worker 的收尾和本机落地函数，认不出的报「其他」。 */
const FAIL_CODE_LABELS: Record<string, string> = {
  AGENTIC_TOTAL_TIMEOUT: '超时',
  'llm-timeout': '超时',
  LLM_CALL_FAILED: '模型报错',
  'invalid-output': '结果不合格',
  'attachment-missing': '结果取不回',
  lost: '任务丢失',
  'input-missing': '输入丢失',
};

const HINT_ACTION_LABELS: Record<CloudGenHintAction, string> = { open: '点开说明', mute: '不再提醒', enter: '进入' };

const SWITCH_LABELS: Record<keyof CloudGenFeatureSwitches, string> = { enabled: '云端生成', notify: '完成时通知' };

/** 只认表自己的键：`constructor` 这类原型链上的名字不能算命中。 */
const own = <V>(table: Readonly<Record<string, V>>, key: unknown): V | undefined =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

const featureOf = (purpose: unknown) => own(CLOUD_GEN_PURPOSE_META, purpose)?.label;

/** 交出到生成完的用时档位。 */
export const bucketCloudGenElapsed = (ms?: number): string => {
  // 负数多半是 Worker 和本机的钟没对齐，按不知道算。
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '未知';
  if (ms < 60_000) return '1分钟内';
  if (ms < 180_000) return '1-3分钟';
  if (ms < 300_000) return '3-5分钟';
  return '5分钟以上';
};

// 单次模型调用撞上上游 5 分钟上限时，Worker 收尾记成 llm-timeout；点名兜底那条路拿不到这个码，
// 只有上游任务行里的 generation-failed 加报错文字，所以再看一眼文字。文字只进这个布尔判断。
const isTimeoutMessage = (message: unknown): boolean =>
  typeof message === 'string' && /\btime(?:d)?\s?out\b/i.test(message);

const failReasonOf = (error?: { code: unknown; message: unknown }): string =>
  own(FAIL_CODE_LABELS, error?.code)
  ?? (error?.code === 'generation-failed' && isTimeoutMessage(error.message) ? '超时' : '其他');

/**
 * 组「云端生成」的属性。返回 null = 这次不报。只认表里的键，值一律重新取字面量。
 * `detail`：转本机时是原因；落地 / 丢弃 / 失败时是收尾原料。
 */
export const buildCloudGenAnalytics = (
  purpose: CloudGenPurpose,
  outcome: CloudGenOutcome,
  detail?: CloudGenLocalReason | CloudGenSettleDetail,
): Record<string, string> | null => {
  const feature = featureOf(purpose);
  const result = own(OUTCOME_LABELS, outcome);
  if (!feature || !result) return null;
  if (outcome === 'submitted') return { 功能: feature, 结果: result };
  if (outcome === 'local') {
    const why = own(LOCAL_REASON_LABELS, detail);
    return why ? { 功能: feature, 结果: result, 原因: why } : null;
  }
  const settle: CloudGenSettleDetail = typeof detail === 'object' && detail ? detail : {};
  const data: Record<string, string> = { 功能: feature, 结果: result, 云端用时: bucketCloudGenElapsed(settle.elapsedMs) };
  if (typeof settle.leftPage === 'boolean') data.期间离开过 = settle.leftPage ? '是' : '否';
  if (outcome === 'failed') data.原因 = failReasonOf(settle.error);
  const discard = outcome === 'discarded' ? own(DISCARD_REASON_LABELS, settle.discardReason) : undefined;
  if (discard) data.原因 = discard;
  return data;
};

export const trackCloudGenOutcome = (
  purpose: CloudGenPurpose,
  outcome: CloudGenOutcome,
  detail?: CloudGenLocalReason | CloudGenSettleDetail,
): void => {
  const data = buildCloudGenAnalytics(purpose, outcome, detail);
  if (data) trackEvent('云端生成', data);
};

/** 小条和说明页上的点按：点开说明、本功能不再提醒、日程「好了 · 进入」。 */
export const trackCloudGenHint = (purpose: CloudGenPurpose, action: CloudGenHintAction): void => {
  const feature = featureOf(purpose);
  const act = own(HINT_ACTION_LABELS, action);
  if (feature && act) trackEvent('云端生成提示', { 功能: feature, 动作: act });
};

/** 设置里按功能的两个开关，改了哪个报哪个。 */
export const trackCloudGenSwitch = (purpose: CloudGenPurpose, patch: Partial<CloudGenFeatureSwitches>): void => {
  const feature = featureOf(purpose);
  if (!feature) return;
  for (const key of Object.keys(SWITCH_LABELS) as Array<keyof CloudGenFeatureSwitches>) {
    const on = patch[key];
    if (typeof on === 'boolean') trackEvent('切换云端生成', { 功能: feature, 开关: SWITCH_LABELS[key], 动作: on ? '开' : '关' });
  }
};
