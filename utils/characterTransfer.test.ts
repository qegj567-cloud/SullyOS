import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ copy: vi.fn(), retire: vi.fn(), remove: vi.fn(), clear: vi.fn() }));
vi.mock('./userSpaceData', () => ({ inheritSpaceCharacters: fixture.copy, readSpaceStore: async (db: string) => db === 'source' ? [{ id: 'old', name: 'Role' }] : [] }));
vi.mock('./userSpaces', () => ({ listUserSpaces: () => [{ id: 'source' }, { id: 'target' }], userSpaceSessionLock: (id: string) => id }));
vi.mock('./sharedAssetLock', () => ({ withSharedAssetLock: (_: string, run: () => any) => run() }));
vi.mock('./amsgCloudRetirement', () => ({ retireCloudCharacter: fixture.retire }));
vi.mock('./activeMsgStore', () => ({ ActiveMsgStore: { clearCharacters: fixture.clear } }));
vi.mock('./db', () => ({ openSpaceDB: async (id: string) => id }));
import { transferSpaceCharacters } from './characterTransfer';
beforeEach(() => {
    vi.clearAllMocks(); fixture.copy.mockResolvedValue([{ id: 'new' }]);
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, _options: any, run: any) => run({}) } });
});
it('never retires or deletes sources when copying fails', async () => {
    fixture.copy.mockRejectedValueOnce(new Error('quota'));
    await expect(transferSpaceCharacters('source', ['old'], { remove: true })).rejects.toThrow('quota');
    expect(fixture.retire).not.toHaveBeenCalled(); expect(fixture.clear).not.toHaveBeenCalled();
});
it('keeps the successful copy and reports retained source when cloud deletion fails', async () => {
    fixture.retire.mockResolvedValue({ status: 'failed' });
    const result = await transferSpaceCharacters('source', ['old'], { remove: true });
    expect(result.copies).toEqual([{ id: 'new' }]); expect(result.retained).toBe(true);
    expect(fixture.retire).toHaveBeenCalledOnce(); expect(fixture.clear).not.toHaveBeenCalled();
});
it('does not start copying while the source user is open elsewhere', async () => {
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, _options: any, run: any) => run(null) } });
    await expect(transferSpaceCharacters('source', ['old'], { remove: true })).rejects.toThrow('其他页面');
    expect(fixture.copy).not.toHaveBeenCalled();
});
