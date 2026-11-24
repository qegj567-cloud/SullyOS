/**
 * 代跑的使用统计：一个事件「云端生成」，属性全是写死的枚举（见 docs/analytics.md）。
 *
 * 只记用户想上云时发生了什么。没开 2.0、这个功能的云端生成关着、API 没配齐，这三种是
 * 配置状态不是结局，不记：否则没开 2.0 的八成设备每次进聊天都会冒一条「转本机」。
 */

import { trackEvent } from '../analytics';
import { CLOUD_GEN_PURPOSE_META, type CloudGenLocalReason, type CloudGenPurpose } from './types';

export type CloudGenOutcome = 'submitted' | 'local' | 'landed' | 'discarded' | 'failed';

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

/** 组属性。返回 null = 这次不报。只认表里的键，值一律重新取字面量。 */
export const buildCloudGenAnalytics = (
  purpose: CloudGenPurpose,
  outcome: CloudGenOutcome,
  reason?: CloudGenLocalReason,
): Record<string, string> | null => {
  const feature = CLOUD_GEN_PURPOSE_META[purpose]?.label;
  const result = OUTCOME_LABELS[outcome];
  if (!feature || !result) return null;
  if (outcome !== 'local') return { 功能: feature, 结果: result };
  const why = reason ? LOCAL_REASON_LABELS[reason] : undefined;
  return why ? { 功能: feature, 结果: result, 原因: why } : null;
};

export const trackCloudGenOutcome = (
  purpose: CloudGenPurpose,
  outcome: CloudGenOutcome,
  reason?: CloudGenLocalReason,
): void => {
  const data = buildCloudGenAnalytics(purpose, outcome, reason);
  if (data) trackEvent('云端生成', data);
};
