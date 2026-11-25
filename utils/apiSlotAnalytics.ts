/**
 * API 槽位自动保存、连接测试与预设引用的效果统计（Canary 效果埋点清单收敛层）。
 *
 * 严格遵守 docs/analytics.md 铁律：
 * - 所有上报属性均通过源码写死的字面量白名单映射；
 * - 严禁传入或透传任何 URL、密钥、模型名、预设名、角色名、角色 ID 或报错原文。
 */

import { trackEvent } from './analytics';

export const API_SLOT_NAMES = [
  '主对话',
  '独立识图',
  '记忆副API',
  '情绪副API',
  '心象翻译',
  '角色独立',
  '哔哔',
  '彼方',
  '查手机',
  '家园',
  '自习室',
  '模拟人生',
  '协同工作',
  '节日活动',
] as const;

export type ApiSlotAnalyticsName = (typeof API_SLOT_NAMES)[number];

const ALLOWED_SLOTS = new Set<string>(API_SLOT_NAMES);

export type ApiSlotCommitMode = '绑定预设' | '单独填写' | '恢复跟随' | '关闭独立API';
const ALLOWED_MODES = new Set<string>(['绑定预设', '单独填写', '恢复跟随', '关闭独立API']);

export type ApiSlotDiscardReason = '缺地址' | '地址不合法' | '缺模型';
const ALLOWED_DISCARD_REASONS = new Set<string>(['缺地址', '地址不合法', '缺模型']);

export function trackApiSlotCommit(params: {
  slot: ApiSlotAnalyticsName;
  mode: ApiSlotCommitMode;
  result: '已生效' | '未填完丢弃';
  discardReason?: ApiSlotDiscardReason;
}): void {
  if (!ALLOWED_SLOTS.has(params.slot) || !ALLOWED_MODES.has(params.mode)) return;
  if (params.result !== '已生效' && params.result !== '未填完丢弃') return;
  const payload: Record<string, string> = {
    槽位: params.slot,
    方式: params.mode,
    结果: params.result,
  };
  if (params.result === '未填完丢弃' && params.discardReason && ALLOWED_DISCARD_REASONS.has(params.discardReason)) {
    payload.原因 = params.discardReason;
  }
  trackEvent('提交API槽位', payload);
}

export type ApiTestFailureCategory =
  | '鉴权失败'
  | '地址不存在'
  | '频率或额度限制'
  | '服务端错误'
  | '返回内容为空'
  | '请求超时'
  | '网络或跨域'
  | '其他';

export function classifyApiTestError(status?: number, isTimeout?: boolean, isEmptyReply?: boolean): ApiTestFailureCategory {
  if (isTimeout) return '请求超时';
  if (isEmptyReply) return '返回内容为空';
  if (status === 401 || status === 403) return '鉴权失败';
  if (status === 404 || status === 405) return '地址不存在';
  if (status === 429 || status === 402) return '频率或额度限制';
  if (typeof status === 'number' && status >= 500) return '服务端错误';
  if (status === undefined) return '网络或跨域';
  return '其他';
}

export function trackApiConnectionTest(params: {
  slot: ApiSlotAnalyticsName;
  ok: boolean;
  failureCategory?: ApiTestFailureCategory;
}): void {
  if (!ALLOWED_SLOTS.has(params.slot)) return;
  const payload: Record<string, string> = {
    槽位: params.slot,
    结果: params.ok ? '成功' : '失败',
  };
  if (!params.ok) {
    const allowedCategories: readonly ApiTestFailureCategory[] = [
      '鉴权失败', '地址不存在', '频率或额度限制', '服务端错误', '返回内容为空', '请求超时', '网络或跨域', '其他',
    ];
    payload.原因 = params.failureCategory && allowedCategories.includes(params.failureCategory)
      ? params.failureCategory
      : '其他';
  }
  trackEvent('测试API连接', payload);
}

export function trackApiPresetAction(params: {
  source: '设置页' | '业务面板';
  action: '新建' | '修改同步' | '复制副本' | '转为单独填写' | '删除';
}): void {
  const allowedSources = ['设置页', '业务面板'] as const;
  const allowedActions = ['新建', '修改同步', '复制副本', '转为单独填写', '删除'] as const;
  if (!allowedSources.includes(params.source) || !allowedActions.includes(params.action)) return;
  trackEvent('管理API预设', {
    入口: params.source,
    动作: params.action,
  });
}
