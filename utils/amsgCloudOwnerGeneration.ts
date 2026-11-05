import type { CloudOwner } from '@rei-standard/amsg-client';
import { parseCharCredId } from './amsgLlmCredentials';

type Connection = { workerUrl: string; userId: string };
const storageKey = (connection: Connection) => `amsg2_cloud_generations:${JSON.stringify([connection.workerUrl.trim().replace(/\/+$/, ''), connection.userId])}`;
const ownerKey = (owner: CloudOwner) => JSON.stringify([owner.type, owner.id]);
const snapshots = new WeakMap<object, Readonly<Record<string, number>>>();

function read(connection: Connection): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(connection)) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => Number.isSafeInteger(value) && Number(value) >= 0)) as Record<string, number>;
  } catch { return {}; }
}

/** 创建连接时冻结。恢复操作换新连接，旧异步流程持有的连接仍用旧代次。 */
export function captureCloudOwnerGenerations(client: object, connection: Connection): void {
  snapshots.set(client, read(connection));
}

/** 本机记住的代次；没记过按 0（从没停用过的角色在云端也是 0）。 */
export function readCloudOwnerGeneration(connection: Connection, owner: CloudOwner): number {
  return read(connection)[ownerKey(owner)] ?? 0;
}

export function rememberCloudOwnerGeneration(connection: Connection, owner: CloudOwner, generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('云端返回的恢复代次无效');
  localStorage.setItem(storageKey(connection), JSON.stringify({ ...read(connection), [ownerKey(owner)]: generation }));
}

type Write = Record<string, any>;

/** 只识别写入信封的结构字段，不遍历 value/聊天正文，不改变原对象。 */
export function stampCloudWrite<T extends Write>(client: object, value: T): T & { ownerGeneration?: number } {
  let next: Write = { ...value };
  for (const key of ['entries', 'credentials']) {
    if (Array.isArray(next[key])) next[key] = next[key].map((row: Write) => stampCloudWrite(client, row));
  }
  let owner = value.owner as CloudOwner | undefined;
  if (!owner && typeof value.namespace === 'string' && value.namespace.startsWith('amsg:char:')) {
    const id = value.namespace.slice('amsg:char:'.length);
    if (id) owner = { type: 'character', id };
  }
  if (!owner && typeof value.credId === 'string') {
    const parsed = parseCharCredId(value.credId);
    if (parsed) owner = { type: 'character', id: parsed.charId };
  }
  if (!owner && typeof value.metadata?.charId === 'string' && value.metadata.charId) {
    owner = { type: 'character', id: value.metadata.charId, ...(typeof value.contactName === 'string' ? { label: value.contactName } : {}) };
  }
  if (owner) next = { ...next, owner, ownerGeneration: snapshots.get(client)?.[ownerKey(owner)] ?? 0 };
  return next as T & { ownerGeneration?: number };
}


// 连接初始化也会等待网络。先记住操作开始时的本机生命周期，避免旧操作
// 恰好在恢复后才拿到新连接，从而被错误地盖上新的云端 generation。
const writeEpochs = new Map<string, number>();
export function invalidateCloudOwnerWrites(owner: CloudOwner): void {
  if (owner.type === 'character') writeEpochs.set(owner.id, (writeEpochs.get(owner.id) ?? 0) + 1);
}
export function captureCloudWriteCheck(characterIds: string[]): () => void {
  const captured = characterIds.map(id => [id, writeEpochs.get(id) ?? 0] as const);
  return () => {
    if (captured.some(([id, epoch]) => (writeEpochs.get(id) ?? 0) !== epoch)) {
      throw new Error('角色的云端使用状态已发生变化，请重新发起这次操作。');
    }
  };
}
