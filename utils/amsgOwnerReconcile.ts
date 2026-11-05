/**
 * 本地角色和云端「角色停用登记」对账。
 *
 * 云端不是本地的副本：聊天、记忆、角色资料只在本地，快照和凭据都从本地算出来。
 * 唯一由云端说了算、又可能跟本地对不上的，是角色的停用状态和代次：
 * - 在另一台设备删了角色 / 导入了包含已删角色的旧备份 → 本地有，云端已停用；
 * - 在另一台设备恢复过 / 本机清过浏览器数据 → 云端启用，但本机记的代次对不上。
 * 这两种状态下该角色的云端写入都会被拒（CLOUD_OWNER_RETIRED）。
 *
 * 恢复必须由用户亲手点（云端数据管理契约的硬规定），所以这里只负责找出来，
 * 由提示弹窗让用户选「继续使用」或「删除本机」。
 */
import type { CloudOwnerState } from '@rei-standard/amsg-client';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { CloudDataError } from './amsgCloudData';
import { pendingCloudRetirements } from './amsgCloudRetirement';
import { readCloudOwnerGeneration } from './amsgCloudOwnerGeneration';

export type CloudOwnerConflict = {
  id: string;
  name: string;
  /** true = 云端已停用；false = 云端启用但本机代次对不上，只需在本机接入。 */
  retired: boolean;
};

/** 上传时撞上停用角色，通知提示弹窗重新对账。 */
export const AMSG_OWNER_CONFLICT_EVENT = 'amsg2-owner-conflict';
/** 导入备份后页面会重启，留个标记让重启后的检查用「来自备份」的口径提示。 */
export const AMSG_OWNER_CHECK_AFTER_IMPORT_LS_KEY = 'amsg2_owner_check_after_import';

type Character = { id: string; name: string };

export function diffCloudOwners(
  characters: ReadonlyArray<Character>,
  owners: ReadonlyArray<Pick<CloudOwnerState, 'owner' | 'retired' | 'generation'>>,
  localGeneration: (charId: string) => number,
  skipIds: ReadonlySet<string> = new Set(),
): CloudOwnerConflict[] {
  const byId = new Map(owners.filter(state => state.owner.type === 'character').map(state => [state.owner.id, state]));
  return characters.flatMap((char): CloudOwnerConflict[] => {
    const state = byId.get(char.id);
    if (!state || skipIds.has(char.id)) return [];
    if (state.retired) return [{ id: char.id, name: char.name, retired: true }];
    if (state.generation !== localGeneration(char.id)) return [{ id: char.id, name: char.name, retired: false }];
    return [];
  });
}

/** 没配 Worker、或 Worker 太旧不支持云端数据管理时返回空：没有可对的账。 */
export async function findCloudOwnerConflicts(characters: ReadonlyArray<Character>): Promise<CloudOwnerConflict[]> {
  if (characters.length === 0) return [];
  if (!(await ActiveMsgStore.getGlobalConfig()).workerUrl?.trim()) return [];
  let session: Awaited<ReturnType<typeof ActiveMsgClient.openCloudDataSession>>;
  try {
    session = await ActiveMsgClient.openCloudDataSession();
  } catch (error) {
    if (error instanceof CloudDataError && error.code === 'CLOUD_DATA_UNSUPPORTED') return [];
    throw error;
  }
  const { owners } = await session.listOwners();
  const connection = { workerUrl: session.workerUrl, userId: session.userId };
  // 正在走删除流程的角色由删除流程自己收尾，不在这里重复提示。
  const deleting = new Set(pendingCloudRetirements(connection).map(char => char.id));
  return diffCloudOwners(
    characters,
    owners,
    id => readCloudOwnerGeneration(connection, { type: 'character', id }),
    deleting,
  );
}

/** 「继续使用」：云端停用的恢复，代次对不上的在本机接入当前代次。逐个处理，失败的带原因返回。 */
export async function keepUsingCloudOwners(conflicts: ReadonlyArray<CloudOwnerConflict>): Promise<{
  restored: string[];
  failed: Array<{ id: string; detail: string }>;
}> {
  const session = await ActiveMsgClient.openCloudDataSession();
  const restored: string[] = [];
  const failed: Array<{ id: string; detail: string }> = [];
  for (const conflict of conflicts) {
    try {
      await session.restoreOwner({ type: 'character', id: conflict.id, label: conflict.name });
      restored.push(conflict.id);
    } catch (error) {
      failed.push({ id: conflict.id, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { restored, failed };
}
