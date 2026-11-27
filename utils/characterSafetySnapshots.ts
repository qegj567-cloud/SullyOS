import type { CharacterProfile } from '../types';

/**
 * 角色档案多槽错峰安全快照（独立 IndexedDB 库 `SullyOS_CharacterSafety`）。
 *
 * 背景与取舍（详见 docs/backup-pipeline.md「角色档案防断电多槽快照」）：
 * - Chromium 对单条超过约 64KB 的 IndexedDB 记录不再内联进 LevelDB，而是拆成独立的外部磁盘文件，
 *   主库只留文件指针。CharacterProfile 聚合了人设、装扮、记忆、小屋与查手机记录，很容易跨过 64KB 且在对话/互动中频繁整卡重写。
 * - 设备电量耗尽硬断电或异常清理时，正在改写的外部文件可能未刷入闪存或被系统清理，只剩悬空指针，
 *   再次读取抛 `NotReadableError: Data lost due to missing file`，导致整表 `getAll()` 失败锁死在故障页。
 * - 同一次事务里双写无法防断电（两个新外部文件可能同时未落盘）；单双槽在连续高频聊天时也可能都处在系统页缓存写回窗口（约 30s）内。
 * - 因此这里采用 3 个环形槽位（0 / 1 / 2），每满 1 分钟才切换到下一个槽位：
 *   首次写入落 0 号槽并立刻把活动槽切到 1 号槽；后续每分钟轮换一格。任意时刻即使当前槽正在写盘断电、上一槽刚提交不久，
 *   再早一格的槽位也已在闪存上静置超过 60 秒且期间零改动。
 * - 独立成库而不升 `AetherOS_Data` 的 `DB_VERSION`：已经出现单条损坏的老包用户覆盖安装后，打开主库做抢救导出时不会触发主库 schema 升级事务。
 */

export const CHARACTER_SAFETY_DB_NAME = 'SullyOS_CharacterSafety';
const DB_VERSION = 1;
const STORE_META = 'meta';
const STORE_SNAPSHOTS = 'snapshots';

export const SAFETY_SLOT_COUNT = 3;
export const SAFETY_ROTATION_WINDOW_MS = 60_000;
const DEFAULT_DEBOUNCE_MS = 1_200;

export type SafetySlot = 0 | 1 | 2;

interface SafetyMetaRow {
  key: string;
  spaceId: string;
  charId: string;
  activeSlot: SafetySlot;
  slotOpenedAt: number;
  savedAtBySlot: Partial<Record<SafetySlot, number>>;
}

interface SafetySnapshotRow {
  key: string;
  spaceId: string;
  charId: string;
  slot: SafetySlot;
  savedAt: number;
  character: CharacterProfile;
}

const metaKey = (spaceId: string, charId: string) => `${spaceId}:${charId}`;
const snapshotKey = (spaceId: string, charId: string, slot: SafetySlot) => `${spaceId}:${charId}:${slot}`;

/** Chromium 外部文件缺失 / 大记录读取不可恢复错误的统一判定。 */
export function isUnreadableRecordError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const rec = error as { name?: unknown; message?: unknown };
  if (rec.name === 'NotReadableError') return true;
  const msg = typeof rec.message === 'string' ? rec.message : '';
  return /missing file|Affected record should be considered irrecoverable|Failed to read large IndexedDB value/i.test(msg);
}

let safetyDbPromise: Promise<IDBDatabase> | null = null;

function openSafetyDB(): Promise<IDBDatabase> {
  if (safetyDbPromise) return safetyDbPromise;
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(CHARACTER_SAFETY_DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        const meta = db.createObjectStore(STORE_META, { keyPath: 'key' });
        meta.createIndex('bySpace', 'spaceId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        const snaps = db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'key' });
        snaps.createIndex('bySpace', 'spaceId', { unique: false });
        snaps.createIndex('bySpaceChar', ['spaceId', 'charId'], { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        if (safetyDbPromise === promise) safetyDbPromise = null;
      };
      db.onclose = () => {
        if (safetyDbPromise === promise) safetyDbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      if (safetyDbPromise === promise) safetyDbPromise = null;
      reject(req.error || new Error('打开角色安全快照库失败'));
    };
    req.onblocked = () => {
      if (safetyDbPromise === promise) safetyDbPromise = null;
      reject(new Error('角色安全快照库升级被占用'));
    };
  });
  safetyDbPromise = promise;
  return promise;
}

function openWriteTx(db: IDBDatabase, stores: string | string[]): IDBTransaction {
  try {
    return db.transaction(stores, 'readwrite', { durability: 'strict' });
  } catch {
    return db.transaction(stores, 'readwrite');
  }
}

function stripRuntimeFields(character: CharacterProfile): CharacterProfile {
  if (character.memoryPalaceInjection === undefined && character.roomPlatesInjection === undefined) {
    return character;
  }
  const copy = { ...character };
  delete copy.memoryPalaceInjection;
  delete copy.roomPlatesInjection;
  return copy;
}

/** 立即把角色快照写入当前对应的环形槽位（测试可直接传 now 验证跨分钟轮换）。 */
export async function writeCharacterSafetySnapshotNow(
  spaceId: string,
  character: CharacterProfile,
  now = Date.now(),
): Promise<SafetySlot | null> {
  if (!spaceId || !character?.id) return null;
  try {
    const db = await openSafetyDB();
    const cleaned = structuredClone(stripRuntimeFields(character));
    return await new Promise<SafetySlot>((resolve, reject) => {
      const tx = openWriteTx(db, [STORE_META, STORE_SNAPSHOTS]);
      const metaStore = tx.objectStore(STORE_META);
      const snapStore = tx.objectStore(STORE_SNAPSHOTS);
      const mKey = metaKey(spaceId, cleaned.id);
      let chosenSlot: SafetySlot = 0;

      const getReq = metaStore.get(mKey);
      getReq.onsuccess = () => {
        const prev = getReq.result as SafetyMetaRow | undefined;
        let nextMeta: SafetyMetaRow;
        if (!prev) {
          // 首次落盘写 0 号槽，并把后续活动槽拨到 1 号槽：哪怕几秒后立刻再改，0 号槽也保持静置不被覆盖。
          chosenSlot = 0;
          nextMeta = {
            key: mKey,
            spaceId,
            charId: cleaned.id,
            activeSlot: 1,
            slotOpenedAt: now,
            savedAtBySlot: { 0: now },
          };
        } else {
          let activeSlot: SafetySlot = (prev.activeSlot === 0 || prev.activeSlot === 1 || prev.activeSlot === 2)
            ? prev.activeSlot
            : 0;
          let slotOpenedAt = Number.isFinite(prev.slotOpenedAt) ? prev.slotOpenedAt : now;
          if (now - slotOpenedAt >= SAFETY_ROTATION_WINDOW_MS) {
            activeSlot = ((activeSlot + 1) % SAFETY_SLOT_COUNT) as SafetySlot;
            slotOpenedAt = now;
          }
          chosenSlot = activeSlot;
          nextMeta = {
            key: mKey,
            spaceId,
            charId: cleaned.id,
            activeSlot,
            slotOpenedAt,
            savedAtBySlot: { ...prev.savedAtBySlot, [chosenSlot]: now },
          };
        }
        const snap: SafetySnapshotRow = {
          key: snapshotKey(spaceId, cleaned.id, chosenSlot),
          spaceId,
          charId: cleaned.id,
          slot: chosenSlot,
          savedAt: now,
          character: cleaned,
        };
        metaStore.put(nextMeta);
        snapStore.put(snap);
      };
      tx.oncomplete = () => resolve(chosenSlot);
      tx.onerror = () => reject(tx.error || new Error('写入角色安全快照失败'));
      tx.onabort = () => reject(tx.error || new Error('角色安全快照事务中止'));
    });
  } catch (err) {
    console.warn('[CharacterSafety] 快照写入失败（不影响主库操作）', err);
    return null;
  }
}

type PendingSnapshot = {
  spaceId: string;
  character: CharacterProfile;
  timer: ReturnType<typeof setTimeout>;
};

const pendingWrites = new Map<string, PendingSnapshot>();
let lifecycleBound = false;

function ensureLifecycleFlush() {
  if (lifecycleBound || typeof window === 'undefined' || typeof document === 'undefined') return;
  lifecycleBound = true;
  const flushOnHide = () => {
    if (document.visibilityState === 'hidden') void flushCharacterSafetySnapshots();
  };
  document.addEventListener('visibilitychange', flushOnHide);
  window.addEventListener('pagehide', () => { void flushCharacterSafetySnapshots(); });
}

/** 合并短时间内的连续保存，后台异步落盘，不阻塞主库写入。 */
export function scheduleCharacterSafetySnapshot(
  spaceId: string,
  character: CharacterProfile,
  delayMs = DEFAULT_DEBOUNCE_MS,
): void {
  if (!spaceId || !character?.id) return;
  ensureLifecycleFlush();
  const key = metaKey(spaceId, character.id);
  const existing = pendingWrites.get(key);
  if (existing) clearTimeout(existing.timer);
  const snapshot = stripRuntimeFields(character);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    void writeCharacterSafetySnapshotNow(spaceId, snapshot);
  }, delayMs);
  pendingWrites.set(key, { spaceId, character: snapshot, timer });
}

/** 冲刷所有排队中的安全快照（页面切后台或测试断言前调用）。 */
export async function flushCharacterSafetySnapshots(): Promise<void> {
  const items = [...pendingWrites.values()];
  pendingWrites.clear();
  for (const item of items) clearTimeout(item.timer);
  await Promise.all(items.map(item => writeCharacterSafetySnapshotNow(item.spaceId, item.character)));
}

/** 启动空闲时为尚无安全快照的存量角色补齐首份基线，老用户升级后无需手动改角色即受保护。 */
export async function seedMissingCharacterSafetySnapshots(
  spaceId: string,
  characters: readonly CharacterProfile[],
): Promise<number> {
  if (!spaceId || !characters.length) return 0;
  try {
    const db = await openSafetyDB();
    const existingKeys = await new Promise<Set<string>>((resolve, reject) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const req = tx.objectStore(STORE_META).index('bySpace').getAllKeys(IDBKeyRange.only(spaceId));
      req.onsuccess = () => resolve(new Set((req.result || []).map(String)));
      req.onerror = () => reject(req.error);
    });
    let seeded = 0;
    for (const char of characters) {
      if (!char?.id || existingKeys.has(metaKey(spaceId, char.id))) continue;
      const slot = await writeCharacterSafetySnapshotNow(spaceId, char);
      if (slot !== null) seeded++;
    }
    return seeded;
  } catch {
    return 0;
  }
}

function readSingleSlotIsolated(db: IDBDatabase, key: string): Promise<SafetySnapshotRow | null> {
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE_SNAPSHOTS, 'readonly');
      const req = tx.objectStore(STORE_SNAPSHOTS).get(key);
      req.onsuccess = () => resolve((req.result as SafetySnapshotRow | undefined) ?? null);
      req.onerror = event => {
        event.preventDefault();
        resolve(null);
      };
      tx.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * 主库某张角色卡报 `NotReadableError` 时，逐槽独立读取（每槽单独只读事务，单槽也坏时不波及其余槽），
 * 挑出完好且保存时间最新的一份返回。
 */
export async function recoverCharacterFromSafetySnapshot(
  spaceId: string,
  charId: string,
): Promise<CharacterProfile | null> {
  if (!spaceId || !charId) return null;
  // 取消尚在防抖队列里的旧写，避免覆盖或干扰恢复
  const pendingKey = metaKey(spaceId, charId);
  const pending = pendingWrites.get(pendingKey);
  if (pending) {
    clearTimeout(pending.timer);
    pendingWrites.delete(pendingKey);
  }
  try {
    const db = await openSafetyDB();
    const candidates: SafetySnapshotRow[] = [];
    for (const slot of [0, 1, 2] as const) {
      const row = await readSingleSlotIsolated(db, snapshotKey(spaceId, charId, slot));
      if (row?.character && row.character.id === charId && typeof row.character.name === 'string') {
        candidates.push(row);
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    return stripRuntimeFields(candidates[0].character);
  } catch {
    return null;
  }
}

/** 删除单个角色时同步清理其全部安全快照槽位。 */
export async function deleteCharacterSafetySnapshots(spaceId: string, charId: string): Promise<void> {
  if (!spaceId || !charId) return;
  const pKey = metaKey(spaceId, charId);
  const pending = pendingWrites.get(pKey);
  if (pending) {
    clearTimeout(pending.timer);
    pendingWrites.delete(pKey);
  }
  try {
    const db = await openSafetyDB();
    await new Promise<void>(resolve => {
      const tx = db.transaction([STORE_META, STORE_SNAPSHOTS], 'readwrite');
      tx.objectStore(STORE_META).delete(pKey);
      const snapStore = tx.objectStore(STORE_SNAPSHOTS);
      for (const slot of [0, 1, 2] as const) snapStore.delete(snapshotKey(spaceId, charId, slot));
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => resolve();
    });
  } catch { /* best effort */ }
}

/** 删除或整表覆盖某个用户空间的角色表时，清理该空间旧的安全快照。 */
export async function deleteSpaceSafetySnapshots(spaceId: string): Promise<void> {
  if (!spaceId) return;
  for (const [key, item] of pendingWrites.entries()) {
    if (item.spaceId === spaceId) {
      clearTimeout(item.timer);
      pendingWrites.delete(key);
    }
  }
  try {
    const db = await openSafetyDB();
    await new Promise<void>(resolve => {
      const tx = db.transaction([STORE_META, STORE_SNAPSHOTS], 'readwrite');
      for (const storeName of [STORE_META, STORE_SNAPSHOTS]) {
        const store = tx.objectStore(storeName);
        const cursorReq = store.index('bySpace').openKeyCursor(IDBKeyRange.only(spaceId));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => resolve();
    });
  } catch { /* best effort */ }
}

/** 重置全部本地数据时一并删除安全快照库。 */
export async function resetAllCharacterSafetySnapshots(): Promise<void> {
  for (const item of pendingWrites.values()) clearTimeout(item.timer);
  pendingWrites.clear();
  if (safetyDbPromise) {
    try { (await safetyDbPromise).close(); } catch { /* ignore */ }
    safetyDbPromise = null;
  }
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>(resolve => {
    try {
      const req = indexedDB.deleteDatabase(CHARACTER_SAFETY_DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
