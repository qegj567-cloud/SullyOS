import type {
  ReiClient, CloudResource, CloudResourceType, CloudDataResponse, CloudCleanupPlan,
  CloudCleanupOperation, CloudCleanupSelection, CloudOwner, CloudOwnerState,
  CloudDataPage, CloudDataSummary,
} from '@rei-standard/amsg-client';

export type {
  CloudResource, CloudResourceType, CloudDataGap, CloudDataPage, CloudDataSummary,
  CloudCleanupPlan, CloudCleanupOperation, CloudOwner, CloudOwnerState,
} from '@rei-standard/amsg-client';

export const CLOUD_DATA_FEATURE = 'cloud-data-management';
export const CLOUD_RESOURCE_LABELS: Record<CloudResourceType, string> = {
  task: '任务', state: '上下文与状态', credential: 'API 凭据', outbox: '消息与结果', subscription: '推送订阅',
};

export class CloudDataError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'CloudDataError'; }
}

async function unwrap<T>(response: Promise<CloudDataResponse<T>>): Promise<T> {
  const result = await response;
  if (!result?.success || result.data == null) {
    throw new CloudDataError(result?.error?.code ?? 'CLOUD_DATA_FAILED', result?.error?.message ?? '云端没有返回有效结果，请重试。');
  }
  return result.data;
}

/** 预览和执行绑定同一连接，用户切换 Worker 后不能把旧计划发往新 Worker。 */
export async function createCloudDataSession(client: ReiClient, connection: { workerUrl: string; userId: string }, callbacks: {
  onRestored?: (state: CloudOwnerState) => void | Promise<void>;
  onCleanupStarted?: (operation: CloudCleanupOperation) => void | Promise<void>;
} = {}) {
  const capabilities = await client.getCapabilities();
  if (!capabilities) throw new CloudDataError('CLOUD_DATA_UNKNOWN', '暂时无法确认云端管理能力，请检查连接后重试。');
  if (!capabilities.features?.includes(CLOUD_DATA_FEATURE)) {
    throw new CloudDataError('CLOUD_DATA_UNSUPPORTED', '这台 Worker 尚不支持完整云端管理。请先在主动消息 2.0 配置里更新 Worker，再重新打开。');
  }
  return {
    workerUrl: connection.workerUrl,
    userId: connection.userId,
    summary: () => unwrap(client.getCloudDataSummary()),
    listOwners: () => unwrap(client.listCloudDataOwners()),
    listResources: (options: { cursor?: string; limit?: number; owner?: CloudOwner; type?: CloudResourceType } = {}) =>
      unwrap(client.listCloudDataResources(options)),
    prepare: async (selection: CloudCleanupSelection) => {
      if (selection.mode === 'retire-owner' ? !selection.owner?.id : !selection.resourceIds?.length && !selection.owner?.id) {
        throw new CloudDataError('EMPTY_SELECTION', '请先选择要清理的数据。');
      }
      return unwrap(client.createCloudDataCleanupPlan(selection));
    },
    start: async (plan: CloudCleanupPlan, idempotencyKey: string) => {
      if (!plan.complete || plan.gaps.length) throw new CloudDataError('INCOMPLETE_PLAN', '清理范围尚未完整确认，请解决清单缺口后重新预览。');
      if (plan.expiresAt <= Date.now()) throw new CloudDataError('PLAN_EXPIRED', '预览已过期，请重新预览。');
      if (!idempotencyKey) throw new CloudDataError('REQUEST_ID_REQUIRED', '清理请求缺少标识，请重新预览。');
      const operation = await unwrap(client.startCloudDataCleanup({ planId: plan.id, idempotencyKey }));
      await callbacks.onCleanupStarted?.(operation);
      return operation;
    },
    listOperations: () => unwrap(client.listCloudDataCleanupOperations()),
    getOperation: (id: string) => unwrap(client.getCloudDataCleanupOperation(id)),
    getOwner: (owner: CloudOwner) => unwrap(client.getCloudDataOwner(owner)),
    restoreOwner: async (owner: CloudOwner) => {
      const state = await unwrap(client.restoreCloudDataOwner(owner));
      if (!state.complete || state.gaps.length || state.retired) throw new CloudDataError('RESTORE_UNCONFIRMED', '云端还未确认恢复，请重试。');
      await callbacks.onRestored?.(state);
      return state;
    },
  };
}

export type CloudDataSession = Awaited<ReturnType<typeof createCloudDataSession>>;

/** 新 Worker 随清单返回同一快照的摘要；旧部署仍使用原摘要接口。 */
export async function readCloudPageSummary(session: Pick<CloudDataSession, 'summary'>, page: CloudDataPage): Promise<CloudDataSummary> {
  return page.summary ?? session.summary();
}

/** 名字来自云端；本地只能补充识别，不能把“本机没有”改写为“已删除”。 */
export function cloudResourceIdentity(resource: CloudResource, characters: ReadonlyArray<{ id: string; name: string }>) {
  const owner = resource.owner;
  if (!owner) return { name: resource.kind === 'global-state' || resource.kind === 'global-subscription' ? '全局共享' : '归属未知', detail: resource.id, local: false };
  const local = owner.type === 'character' ? characters.find(char => char.id === owner.id) : undefined;
  return {
    name: owner.label || local?.name || (owner.type === 'character' ? '未命名角色' : owner.type === 'global' ? '全局共享' : owner.type),
    detail: owner.id,
    local: Boolean(local),
  };
}

export function mergeCloudResourcePage(existing: CloudResource[], incoming: CloudResource[]): CloudResource[] {
  return [...new Map([...existing, ...incoming].map(row => [row.id, row])).values()];
}

export function describeCloudOperation(operation: CloudCleanupOperation) {
  const deleted = operation.counts.reduce((sum, row) => sum + row.deleted, 0);
  const remaining = operation.counts.reduce((sum, row) => sum + row.remaining, 0);
  const failed = operation.counts.reduce((sum, row) => sum + row.failed, 0);
  const complete = operation.status === 'completed' && remaining === 0 && failed === 0 && operation.errors.length === 0;
  const label = complete ? '清理完成' : operation.status === 'pending' ? '等待云端处理'
    : operation.status === 'running' ? '云端清理中' : '尚未清理干净';
  return { complete, label, deleted, remaining, failed };
}
