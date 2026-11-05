import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { CloudDataError } from './amsgCloudData';
import { diffCloudOwners, findCloudOwnerConflicts } from './amsgOwnerReconcile';

afterEach(() => { vi.restoreAllMocks(); });

const owner = (id: string, retired: boolean, generation: number, type = 'character') =>
  ({ owner: { type, id }, retired, generation });
const chars = [{ id: 'a', name: '小明' }, { id: 'b', name: '小红' }, { id: 'c', name: '小刚' }];

describe('diffCloudOwners', () => {
  it('本地有、云端已停用 → 提示可继续使用或删除本机', () => {
    expect(diffCloudOwners(chars, [owner('a', true, 1)], () => 0))
      .toEqual([{ id: 'a', name: '小明', retired: true }]);
  });

  it('云端启用但本机代次对不上（别处恢复过 / 本机清过数据）→ 只需在本机接入', () => {
    expect(diffCloudOwners(chars, [owner('b', false, 2)], () => 0))
      .toEqual([{ id: 'b', name: '小红', retired: false }]);
  });

  it('代次一致、云端没有登记、本地没有的角色、非角色登记都不提示', () => {
    const owners = [owner('c', false, 2), owner('gone', true, 1), owner('a', true, 1, 'group')];
    expect(diffCloudOwners(chars, owners, id => (id === 'c' ? 2 : 0))).toEqual([]);
  });

  it('正在走删除流程的角色交给删除流程，不重复提示', () => {
    expect(diffCloudOwners(chars, [owner('a', true, 1)], () => 0, new Set(['a']))).toEqual([]);
  });
});

describe('findCloudOwnerConflicts', () => {
  it('没配 Worker → 一个请求都不发', async () => {
    vi.spyOn(ActiveMsgStore, 'getGlobalConfig').mockResolvedValue({ workerUrl: '' } as any);
    const open = vi.spyOn(ActiveMsgClient, 'openCloudDataSession');
    await expect(findCloudOwnerConflicts(chars)).resolves.toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it('旧 Worker 不支持云端数据管理 → 没有可对的账，安静返回空', async () => {
    vi.spyOn(ActiveMsgStore, 'getGlobalConfig').mockResolvedValue({ workerUrl: 'https://w.test' } as any);
    vi.spyOn(ActiveMsgClient, 'openCloudDataSession')
      .mockRejectedValue(new CloudDataError('CLOUD_DATA_UNSUPPORTED', 'old'));
    await expect(findCloudOwnerConflicts(chars)).resolves.toEqual([]);
  });

  it('按云端登记和本机记住的代次找出冲突', async () => {
    vi.spyOn(ActiveMsgStore, 'getGlobalConfig').mockResolvedValue({ workerUrl: 'https://w.test' } as any);
    vi.spyOn(ActiveMsgClient, 'openCloudDataSession').mockResolvedValue({
      workerUrl: 'https://w.test',
      userId: 'u',
      listOwners: async () => ({ owners: [owner('a', true, 1), owner('b', false, 0)], complete: true, gaps: [] }),
    } as any);
    await expect(findCloudOwnerConflicts(chars)).resolves.toEqual([{ id: 'a', name: '小明', retired: true }]);
  });
});
