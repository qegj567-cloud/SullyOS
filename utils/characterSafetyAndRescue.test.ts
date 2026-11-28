import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile } from '../types';
import { DB, openSpaceDB } from './db';
import {
  CHARACTER_SAFETY_DB_NAME,
  isUnreadableRecordError,
  SAFETY_ROTATION_WINDOW_MS,
  deleteCharacterSafetySnapshots,
  recoverCharacterFromSafetySnapshot,
  resetAllCharacterSafetySnapshots,
  writeCharacterSafetySnapshotNow,
} from './characterSafetySnapshots';
import { exportDamagedDatabaseRescue } from './databaseRescueExport';
import { exportUserSpaces, importUserSpaces } from './userSpaceBackup';
import { commitSpaceRows, readSpaceStore, resetAllUserSpaces } from './userSpaceData';
import { openBackupZip } from './backupZipReader';
import { putSharedImage } from './spaceAssets';

const makeChar = (id: string, name: string, systemPrompt = '温柔毒舌的青梅竹马'): CharacterProfile => ({
  id,
  name,
  avatar: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
  description: `${name}的备注`,
  systemPrompt,
  memories: [],
});

const missingFileError = () =>
  new DOMException('Data lost due to missing file. Affected record should be considered irrecoverable', 'NotReadableError');

/**
 * 模拟 Chromium 底层外部大文件丢失：
 * LevelDB 主键索引（getAllKeys / openKeyCursor）仍完好可见，但读取目标主键的值（get / getAll / openCursor 走到该行）
 * 触发异步 error 事件并报 NotReadableError。
 */
function simulateMissingExternalFiles(targets: ReadonlyArray<{ storeName: string; brokenKey: IDBValidKey; dbName?: string }>) {
  const matches = (store: IDBObjectStore, key?: IDBValidKey) =>
    targets.some(t => store.name === t.storeName && (!t.dbName || store.transaction.db.name === t.dbName) && (key === undefined || indexedDB.cmp(key, t.brokenKey) === 0));

  const fireAsyncNotReadable = (tx: IDBTransaction) => {
    const err = missingFileError();
    const fakeReq: any = {
      result: undefined,
      error: err,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => {
      let prevented = false;
      const event = {
        type: 'error',
        target: fakeReq,
        preventDefault: () => { prevented = true; },
        stopPropagation: vi.fn(),
      };
      fakeReq.onerror?.(event);
      if (!prevented) {
        try { tx.abort(); } catch { /* already finished */ }
      }
    });
    return fakeReq as IDBRequest;
  };

  const origGet = IDBObjectStore.prototype.get;
  const origGetAll = IDBObjectStore.prototype.getAll;
  const origOpenCursor = IDBObjectStore.prototype.openCursor;

  const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, query: any) {
    if (query !== undefined && !(query instanceof IDBKeyRange) && matches(this, query)) {
      return fireAsyncNotReadable(this.transaction);
    }
    return origGet.call(this, query);
  });

  const getAllSpy = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, query?: any, count?: number) {
    if (targets.some(t => this.name === t.storeName && (!t.dbName || this.transaction.db.name === t.dbName))) {
      return fireAsyncNotReadable(this.transaction);
    }
    return origGetAll.call(this, query, count);
  });

  const cursorSpy = vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, query?: any, direction?: IDBCursorDirection) {
    if (targets.some(t => this.name === t.storeName && (!t.dbName || this.transaction.db.name === t.dbName))) {
      return fireAsyncNotReadable(this.transaction) as any;
    }
    return origOpenCursor.call(this, query, direction);
  });

  return () => {
    getSpy.mockRestore();
    getAllSpy.mockRestore();
    cursorSpy.mockRestore();
  };
}

describe('角色档案三槽错峰安全快照与启动自愈', () => {
  beforeEach(async () => {
    localStorage.clear();
    await resetAllUserSpaces();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetAllCharacterSafetySnapshots();
  });

  it('按分钟轮换 0/1/2 三槽：即使主库记录与最新活动槽同时因断电损坏，仍能从静置的上一槽自动自愈', async () => {
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, {
      characters: [
        makeChar('c1', '阿澈', '断电瞬间正在写的版本'),
        makeChar('c2', '小夏', '完好无损的角色'),
      ],
    }, true);
    await resetAllCharacterSafetySnapshots();

    const t0 = 1_700_000_000_000;
    // 首次保存落 0 号槽，随后活动槽拨到 1 号槽
    expect(await writeCharacterSafetySnapshotNow('default', makeChar('c1', '阿澈', '初版人设'), t0)).toBe(0);
    // 15 秒后连续编辑写进 1 号槽（0 号槽保持不动）
    expect(await writeCharacterSafetySnapshotNow('default', makeChar('c1', '阿澈', '一分钟内稳定版人设'), t0 + 15_000)).toBe(1);
    // 跨过 60 秒窗口后切到 2 号槽（此时 1 号槽已静置落盘）
    const slot2Time = t0 + 15_000 + SAFETY_ROTATION_WINDOW_MS + 5_000;
    expect(await writeCharacterSafetySnapshotNow('default', makeChar('c1', '阿澈', '断电瞬间正在写的版本'), slot2Time)).toBe(2);

    // 模拟最坏断电现场：主库的 c1 与安全快照库最新的 2 号槽同时丢了底层文件！
    const restoreFault = simulateMissingExternalFiles([
      { dbName: 'AetherOS_Data', storeName: 'characters', brokenKey: 'c1' },
      { dbName: CHARACTER_SAFETY_DB_NAME, storeName: 'snapshots', brokenKey: 'default:c1:2' },
    ]);

    let healedChars: CharacterProfile[];
    try {
      healedChars = await DB.getAllCharacters();
    } finally {
      restoreFault();
    }

    expect(healedChars.map(c => c.id)).toEqual(['c1', 'c2']);
    expect(healedChars.find(c => c.id === 'c1')?.systemPrompt).toBe('一分钟内稳定版人设');
    expect(healedChars.find(c => c.id === 'c2')?.systemPrompt).toBe('完好无损的角色');

    // 验证自愈结果已经写回主库，后续正常 getAll 直接读到修复后的完整角色卡
    const persisted = await DB.getAllCharacters();
    expect(persisted.find(c => c.id === 'c1')?.systemPrompt).toBe('一分钟内稳定版人设');
  });

  it('老版本已坏库尚无任何安全快照时原样抛出 NotReadableError，绝不把损坏当空库覆盖默认数据', async () => {
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { characters: [makeChar('legacy_broken', '旧版角色')] }, true);
    await resetAllCharacterSafetySnapshots();

    const restoreFault = simulateMissingExternalFiles([
      { dbName: 'AetherOS_Data', storeName: 'characters', brokenKey: 'legacy_broken' },
    ]);
    try {
      await expect(DB.getAllCharacters()).rejects.toMatchObject({ name: 'NotReadableError' });
    } finally {
      restoreFault();
    }
  });

  it('删除角色与重置空间时同步清掉安全快照，不留孤儿副本', async () => {
    await writeCharacterSafetySnapshotNow('default', makeChar('c_del', '待删角色'), 1_000);
    expect((await recoverCharacterFromSafetySnapshot('default', 'c_del'))?.name).toBe('待删角色');

    await deleteCharacterSafetySnapshots('default', 'c_del');
    expect(await recoverCharacterFromSafetySnapshot('default', 'c_del')).toBeNull();
  });
});

describe('数据库故障页紧急抢救导出（exportDamagedDatabaseRescue）', () => {
  beforeEach(async () => {
    localStorage.clear();
    await resetAllUserSpaces();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetAllCharacterSafetySnapshots();
  });

  it('角色表、素材表、图片池同时存在丢失外部文件的坏记录时：普通导出挂、抢救导出成功且保住孤儿聊天记录归属（原位恢复 + 迁入新用户均通过）', async () => {
    const goodAvatarRef = await putSharedImage(new Blob(['good-image-bytes'], { type: 'image/png' }));
    const badImageId = 'broken_shared_blob';
    await DB.putBlobAsset(badImageId, new Blob(['will-vanish'], { type: 'image/png' }));

    const db = await openSpaceDB('default');
    await commitSpaceRows(db, {
      characters: [
        { ...makeChar('char_ok', '完好角色', '完好无损的人设'), avatar: goodAvatarRef },
        makeChar('char_lost', '阿澈', '断电丢失的原人设'),
      ],
      messages: [
        { id: 1, charId: 'char_ok', role: 'user', content: '你好完好角色', timestamp: 1000 },
        { id: 2, charId: 'char_lost', role: 'user', content: '阿澈，还在吗？', timestamp: 2000 },
        { id: 3, charId: 'char_lost', role: 'assistant', content: '我一直在呀，这条聊天记录还在主库里！', timestamp: 2005 },
        { id: 4, charId: 'char_lost', role: 'user', type: 'image', content: `blobref:${badImageId}`, timestamp: 2010 },
      ],
      memory_nodes: [{id:'rescue_memory',charId:'char_lost',content:'仍可读取的记忆',createdAt:2000}],
      social_posts: [
        { id: 'post_1', authorId: 'char_lost', authorName: '阿澈', authorAvatar: '', content: '今天天气真好', timestamp: 1500, likes: 1, isLiked: false, comments: [] },
      ],
      assets: [
        { id: 'voice_msg_good', data: 'ok-voice' },
        { id: 'voice_msg_broken', data: 'missing-external-voice-file' },
      ],
    }, true);
    // 模拟老版本升级前尚无安全快照的真实受损现场
    await resetAllCharacterSafetySnapshots();

    const restoreFault = simulateMissingExternalFiles([
      { dbName: 'AetherOS_Data', storeName: 'characters', brokenKey: 'char_lost' },
      { dbName: 'AetherOS_Data', storeName: 'assets', brokenKey: 'voice_msg_broken' },
      { dbName: 'AetherOS_Data', storeName: 'blob_assets', brokenKey: badImageId },
    ]);

    let rescueResult!: Awaited<ReturnType<typeof exportDamagedDatabaseRescue>>;
    try {
      // 对照守卫：普通整页导出在旧逻辑下遇到缺失文件必定报 NotReadableError 中断
      await expect(exportUserSpaces('full', 'all')).rejects.toMatchObject({ name: 'NotReadableError' });

      // 抢救导出跳过坏记录并为 char_lost 生成同编号占位角色壳（还从 social_posts 找回了名字「阿澈」）
      rescueResult = await exportDamagedDatabaseRescue();
    } finally {
      restoreFault();
    }

    expect(rescueResult.blob.size).toBeGreaterThan(0);
    expect(rescueResult.placeholderCharacters).toEqual([
      expect.objectContaining({ spaceId: 'default', charId: 'char_lost', name: '阿澈', mode: 'placeholder' }),
    ]);
    expect(rescueResult.skippedRecords.map(r => `${r.store}:${r.key}`).sort()).toEqual([
      'assets:voice_msg_broken',
      'characters:char_lost',
    ]);
    expect(rescueResult.unreadableBlobIds).toEqual([badImageId]);
    expect(rescueResult.reportText).toContain('阿澈 (char_lost)');

    // 检查包内结构与抢救报告文件
    const zip = await openBackupZip(rescueResult.blob);
    expect(await zip.file('抢救导出报告.txt')!.async('string')).toContain('char_lost');
    const reportJson = JSON.parse(await zip.file('diagnostics/rescue-report.json')!.async('string'));
    expect(reportJson.placeholderCharacters).toHaveLength(1);

    // 验证 1：清空损坏库后原位导入抢救包，所有完好消息、完好图片与阿澈的同编号占位档案全部恢复！
    await resetAllUserSpaces();
    await importUserSpaces(zip, false);
    const restoredDb = await openSpaceDB('default');
    const restoredChars = await readSpaceStore<CharacterProfile>(restoredDb, 'characters');
    expect(restoredChars.map(c => c.id).sort()).toEqual(['char_lost', 'char_ok']);
    expect(restoredChars.find(c => c.id === 'char_lost')?.name).toBe('阿澈');
    expect(restoredChars.find(c => c.id === 'char_ok')?.systemPrompt).toBe('完好无损的人设');

    expect((await readSpaceStore<any>(restoredDb, 'memory_nodes'))[0]).toMatchObject({charId:'char_lost',content:'仍可读取的记忆'});
    const restoredMsgs = await readSpaceStore<any>(restoredDb, 'messages');
    const lostCharMsgs = restoredMsgs.filter(m => m.charId === 'char_lost');
    expect(lostCharMsgs.map(m => m.content)).toEqual([
      '阿澈，还在吗？',
      '我一直在呀，这条聊天记录还在主库里！',
      `blobref:${badImageId}`,
    ]);
    expect(await (await DB.getBlobAsset(goodAvatarRef.slice('blobref:'.length)))!.text()).toBe('good-image-bytes');

    // 验证 2：使用「迁入独立用户」（asNewUsers）同样校验通过，阿澈的新角色编号自动接走全部聊天记录！
    const migratedSpaces = await importUserSpaces(zip, false, { asNewUsers: true });
    expect(migratedSpaces).toHaveLength(1);
    const migratedDb = await openSpaceDB(migratedSpaces[0].id);
    const migratedChars = await readSpaceStore<CharacterProfile>(migratedDb, 'characters');
    const migratedAche = migratedChars.find(c => c.name === '阿澈')!;
    expect(migratedAche).toBeDefined();
    expect(migratedAche.id).not.toBe('char_lost');
    expect((await readSpaceStore<any>(migratedDb, 'memory_nodes'))[0]).toMatchObject({charId:migratedAche.id,content:'仍可读取的记忆'});
    const migratedMsgs = await readSpaceStore<any>(migratedDb, 'messages');
    expect(migratedMsgs.filter(m => m.charId === migratedAche.id)).toHaveLength(3);
    await zip.close();
  });
});


describe('抢救移植的只读与错误边界', () => {
  beforeEach(async () => { localStorage.clear(); await resetAllUserSpaces(); });
  afterEach(async () => { vi.restoreAllMocks(); await resetAllCharacterSafetySnapshots(); });

  it('瞬时 UnknownError 不得被当作不可恢复文件丢失而回写旧快照', () => {
    expect(isUnreadableRecordError(new DOMException('Failed to read large IndexedDB value', 'UnknownError'))).toBe(false);
    expect(isUnreadableRecordError(missingFileError())).toBe(true);
  });

  it('预扫描恢复的快照也计入正式报告，抢救不回写主库', async () => {
    const db = await openSpaceDB('default');
    await commitSpaceRows(db, { characters: [makeChar('c_report', '原始卡', '当前版本')] }, true);
    await resetAllCharacterSafetySnapshots();
    await writeCharacterSafetySnapshotNow('default', makeChar('c_report', '安全副本', '历史快照'));
    const restoreFault = simulateMissingExternalFiles([{ dbName: db.name, storeName: 'characters', brokenKey: 'c_report' }]);
    let result!: Awaited<ReturnType<typeof exportDamagedDatabaseRescue>>;
    try { result = await exportDamagedDatabaseRescue(); } finally { restoreFault(); }
    expect(result.healedCharacters).toEqual([expect.objectContaining({ charId: 'c_report', name: '安全副本' })]);
    const zip = await openBackupZip(result.blob);
    expect(JSON.parse(await zip.file('diagnostics/rescue-report.json')!.async('string')).healedCharacters).toHaveLength(1);
    expect((await readSpaceStore<CharacterProfile>(db, 'characters'))[0].systemPrompt).toBe('当前版本');
  });

  it('扫描旧版空间不升级 schema，并保留可恢复的旧版聊天', async () => {
    await openSpaceDB('default');
    const name = 'AetherOS_Data__u_rescue_legacy';
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('characters', {keyPath:'id'}); req.result.createObjectStore('messages', {keyPath:'id'}); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    try {
      await commitSpaceRows(legacy, { characters: [makeChar('legacy_c', '旧版本角色')], messages: [{id: 1, charId: 'legacy_c', content: '仍然可读', timestamp: 1, role: 'user'}] });
      const openSpy = vi.spyOn(indexedDB, 'open');
      const result = await exportDamagedDatabaseRescue();
      expect(openSpy.mock.calls.filter(call => call[0] === name).every(call => call[1] === undefined)).toBe(true);
      expect(legacy.version).toBe(1);
      expect(Array.from(legacy.objectStoreNames)).toEqual(['characters','messages']);
      const zip = await openBackupZip(result.blob);
      const manifest = JSON.parse(await zip.file('user-spaces.json')!.async('string'));
      const space = manifest.spaces.find((item: any) => item.id === 'u_rescue_legacy');
      expect(JSON.parse(await zip.file(space.stores.messages[0])!.async('string'))[0].content).toBe('仍然可读');
    } finally {
      legacy.close();
      await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(name); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); });
    }
  });
});


it('抢救写入归档失败只执行一次，不把磁盘写满伪装成缺失素材', async () => {
  await resetAllUserSpaces();
  const db = await openSpaceDB('default');
  await commitSpaceRows(db, {characters: [makeChar('quota-c', '写满测试')]}, true);
  const module = await import('./backupArchiveWriter');
  const original = module.openBackupArchiveWriter;
  const spy = vi.spyOn(module, 'openBackupArchiveWriter').mockImplementation(async options => {
    const writer = await original(options);
    return {...writer, add: async (name, data, options) => {
      if (name.startsWith('shared/')) throw new DOMException('disk full', 'QuotaExceededError');
      return writer.add(name, data, options);
    }};
  });
  try {
    await DB.putBlobAsset('quota_image', new Blob(['test-image'], {type:'image/png'}));
    await commitSpaceRows(db, {characters: [{...makeChar('quota-c','写满测试'),avatar:'blobref:quota_image'}]});
    await expect(exportDamagedDatabaseRescue()).rejects.toMatchObject({name:'QuotaExceededError'});
    expect(spy).toHaveBeenCalledOnce();
  } finally { spy.mockRestore(); await resetAllCharacterSafetySnapshots(); }
});

it('空闲补基线在删除角色之后执行，不复活已删除角色的安全副本', async () => {
  await resetAllUserSpaces();
  await DB.saveCharacter(makeChar('idle-delete', '待删除'));
  let idle: (() => void) | undefined;
  vi.stubGlobal('window', {requestIdleCallback: (callback: () => void) => { idle = callback; return 1; }});
  try {
    await DB.getAllCharacters();
    expect(idle).toBeDefined();
    await DB.deleteCharacter('idle-delete');
    idle!();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await recoverCharacterFromSafetySnapshot('default', 'idle-delete')).toBeNull();
  } finally { vi.unstubAllGlobals(); await resetAllCharacterSafetySnapshots(); }
});
