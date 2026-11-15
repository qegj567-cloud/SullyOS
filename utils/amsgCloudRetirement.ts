import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { CloudDataError, describeCloudOperation, type CloudCleanupPlan, type CloudCleanupOperation } from './amsgCloudData';
import { isAmsg2GloballyEnabled, isAmsg2WorkerActive } from './amsgGlobalGate';

type Connection = { workerUrl: string; userId: string };
type Character = { id: string; name: string };
type Attempt = { character: Character; plan: CloudCleanupPlan | null; idempotencyKey: string; ownerGeneration?: number };
export type CloudRetirementResult =
  | { status: 'skipped' | 'unsupported' }
  | { status: 'accepted'; operationId: string; completed: boolean }
  | { status: 'failed'; detail: string };
const keyFor = (connection: Connection) => `amsg2_cloud_retirements:${JSON.stringify([connection.workerUrl.trim().replace(/\/+$/, ''), connection.userId])}`;
function readAttempts(connection: Connection): Attempt[] {
  const value = JSON.parse(localStorage.getItem(keyFor(connection)) || '[]');
  if (!Array.isArray(value)) throw new Error('本机清理请求记录损坏，请先检查浏览器存储。');
  return value;
}
export function pendingCloudRetirements(connection: Connection): Character[] {
  return readAttempts(connection).map(attempt => attempt.character);
}
function saveAttempt(connection: Connection, characterId: string, attempt?: Attempt): void {
  const remaining = readAttempts(connection).filter(item => item.character.id !== characterId);
  if (attempt) remaining.push(attempt);
  localStorage.setItem(keyFor(connection), JSON.stringify(remaining));
}

/** 本地仅保存未确认请求的身份和幂等键，不把本地任务列表当成云端清理范围。 */
export async function retireCloudCharacter(character: Character, expectedConnection?: Connection): Promise<CloudRetirementResult> {
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    if (!config.workerUrl?.trim()) return { status: 'skipped' };
    const connection = { workerUrl: config.workerUrl, userId: config.userId };
    if (expectedConnection && keyFor(connection) !== keyFor(expectedConnection)) {
      throw new Error('Worker 连接已切换，请重新打开云端数据管理。');
    }
    // 全局总开关暂停期间删除本地角色或用户空间时（无论是否传入 expectedConnection），
    // 都不主动打云端请求，先把待停用角色记入本地底账，等总开关恢复后再自动收尾。
    if (!isAmsg2GloballyEnabled(config)) {
      if (config.userId) {
        const existing = readAttempts(connection).find(item => item.character.id === character.id);
        if (!existing) {
          saveAttempt(connection, character.id, { character, plan: null, idempotencyKey: crypto.randomUUID() });
        }
      }
      return { status: 'skipped' };
    }
    let attempt = readAttempts(connection).find(item => item.character.id === character.id);
    if (!attempt) {
      attempt = { character, plan: null, idempotencyKey: crypto.randomUUID() };
      saveAttempt(connection, character.id, attempt);
    }
    const session = await ActiveMsgClient.openCloudDataSession();
    if (session.workerUrl !== connection.workerUrl || session.userId !== connection.userId) {
      throw new Error('Worker 连接已切换，请重新发起删除。');
    }
    if (!attempt.plan) {
      const state = await session.getOwner({ type: 'character', id: character.id });
      if (!state.complete || state.gaps.length) throw new Error('云端角色状态尚未确认，请重试。');
      const plan = await session.prepare({ mode: 'retire-owner', owner: { type: 'character', id: character.id, label: character.name } });
      // 不在浏览器重复存一份云端资源清单。
      attempt = { ...attempt, ownerGeneration: state.generation, plan: { ...plan, resources: [] } };
      saveAttempt(connection, character.id, attempt);
    }
    let operation: CloudCleanupOperation;
    if (attempt.plan!.expiresAt <= Date.now()) {
      const history = await session.listOperations();
      const previous = history.operations.find(item => item.planId === attempt!.plan!.id);
      if (previous) {
        if (previous.status === 'pending' || previous.status === 'running') throw new Error('上次请求已在云端留下记录，清理仍待确认，请到云端数据管理查看。');
        operation = previous;
      }
      else {
        if (history.complete && !history.gaps.length) saveAttempt(connection, character.id, { character, plan: null, idempotencyKey: crypto.randomUUID() });
        throw new Error('上次预览已过期，未确认清理结果。请重新预览后重试。');
      }
    } else {
      try { operation = await session.start(attempt.plan!, attempt.idempotencyKey); }
      catch (failure) {
        if (failure instanceof CloudDataError && ['CLOUD_PLAN_CHANGED', 'CLOUD_PLAN_EXPIRED', 'CLOUD_RECORD_NOT_FOUND'].includes(failure.code)) {
          saveAttempt(connection, character.id, { character, plan: null, idempotencyKey: crypto.randomUUID() });
        }
        throw failure;
      }
    }
    if (operation.status === 'failed' || operation.errors.length || operation.counts.some(row => row.failed > 0)) {
      if (operation.status === 'failed') saveAttempt(connection, character.id, { character, plan: null, idempotencyKey: crypto.randomUUID() });
      throw new Error(operation.errors[0]?.message || '云端清理尚未成功，请在云端数据管理中查看。');
    }
    if (operation.status === 'completed') {
      const state = await session.getOwner({ type: 'character', id: character.id });
      if (!state.complete || state.gaps.length) throw new Error('无法确认角色当前停用状态，请重试。');
      if (!state.retired || attempt.ownerGeneration == null || state.generation !== attempt.ownerGeneration + 1) {
        saveAttempt(connection, character.id, { character, plan: null, idempotencyKey: crypto.randomUUID() });
        throw new Error('云端角色在上次清理后发生变化，请重新确认删除。');
      }
    }
    saveAttempt(connection, character.id);
    return { status: 'accepted', operationId: operation.id, completed: describeCloudOperation(operation).complete };
  } catch (failure) {
    if (failure instanceof CloudDataError && failure.code === 'CLOUD_DATA_UNSUPPORTED') return { status: 'unsupported' };
    return { status: 'failed', detail: failure instanceof Error ? failure.message : String(failure) };
  }
}

/** 总开关重新启用后，尽力把暂停期间攒下的待停用角色补送到云端。 */
export async function flushPendingCloudRetirements(): Promise<void> {
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    if (!isAmsg2WorkerActive(config) || !config.userId) return;
    const queued = pendingCloudRetirements({ workerUrl: config.workerUrl, userId: config.userId });
    for (const character of queued) {
      await retireCloudCharacter(character);
    }
  } catch {
    // 尽力而为；仍未确认的条目保留在本地底账里，用户可在「云端数据管理」查看或重试。
  }
}
