import type { CharacterProfile } from '../types';
import { PAGE_BYTE_BUDGET, PAGE_ROW_LIMIT, approxRecordBytes, readStorePage, type StorePage } from './backupPageReader';
import { exportUserSpacesForRescue, type RescueExportHooks } from './userSpaceBackup';
import type { BackupMissingAsset } from './backupMissingAssets';
import { recoverCharacterFromSafetySnapshot } from './characterSafetySnapshots';
import { generateAvatar } from './defaultAvatar';
import { listUserSpaces, spaceDatabaseName, type UserSpace } from './userSpaces';

/**
 * 数据库故障页「紧急抢救导出」。
 *
 * 针对断电/文件缺失导致部分 IndexedDB 记录抛 `NotReadableError`、或者个别库/表无法整页读取的场景：
 * 1. 正常页继续走 `readStorePage` 高速分页游标；
 * 2. 一旦某页读取报错，立刻退回 `openKeyCursor`（仅扫描 LevelDB 键索引，不触碰外部大文件）+ 逐键独立只读事务 `get(key)`，
 *    把完好的记录全部抢救进备份包，仅跳过物理丢失的那一条记录；
 * 3. 若损坏记录位于 `characters` 表，优先从 `SullyOS_CharacterSafety` 多槽快照恢复完整角色卡；
 *    若老版本尚未建立安全快照，则按原角色主键自动生成占位角色壳（并尽力从动态/群聊/攻略本等幸存表找回角色名字与头像），
 *    保证重装或迁入独立用户后，幸存的全部聊天记录与记忆宫殿仍能挂回该角色名下。
 */

export interface RescueSkippedRecord {
  spaceId: string;
  spaceName: string;
  store: string;
  key: string;
  error: string;
}

export interface RescueCharacterRecovery {
  spaceId: string;
  spaceName: string;
  charId: string;
  name: string;
  mode: 'safety_snapshot' | 'placeholder';
}

export interface DatabaseRescueResult {
  blob: Blob;
  fileName: string;
  healedCharacters: RescueCharacterRecovery[];
  placeholderCharacters: RescueCharacterRecovery[];
  skippedRecords: RescueSkippedRecord[];
  unreadableBlobIds: string[];
  missingAssets: BackupMissingAsset[];
  failedSections: string[];
  summaryText: string;
  reportText: string;
}

const KEY_BATCH_LIMIT = 200;

function formatErrorBrief(error: unknown): string {
  if (!error) return '未知读取错误';
  if (typeof error === 'string') return error.slice(0, 160);
  const rec = error as { name?: unknown; message?: unknown };
  const name = typeof rec.name === 'string' && rec.name ? rec.name : 'Error';
  const msg = typeof rec.message === 'string' && rec.message ? rec.message : '';
  return (msg ? `${name}: ${msg}` : name).slice(0, 200);
}

/** 不带版本号只读打开已存在的数据库，避免在故障库上触发升级事务，也不凭空新建空库。 */
function openExistingDatabaseRaw(dbName: string, timeoutMs = 10_000): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let settled = false;
    let created = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) {
        try { db?.close(); } catch { /* ignore */ }
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(dbName);
    } catch {
      finish(null);
      return;
    }
    req.onupgradeneeded = () => {
      created = true;
      try { req.transaction?.abort(); } catch { /* ignore */ }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (created) {
        db.close();
        try { indexedDB.deleteDatabase(dbName); } catch { /* ignore */ }
        finish(null);
        return;
      }
      finish(db);
    };
    req.onerror = () => finish(null);
    req.onblocked = () => finish(null);
  });
}

function readSingleRecordIsolated(db: IDBDatabase, table: string, key: IDBValidKey): Promise<{ ok: true; value: any } | { ok: false; error: unknown }> {
  return new Promise(resolve => {
    try {
      const tx = db.transaction(table, 'readonly');
      const req = tx.objectStore(table).get(key);
      req.onsuccess = () => resolve({ ok: true, value: req.result });
      req.onerror = event => {
        event.preventDefault();
        resolve({ ok: false, error: req.error });
      };
      tx.onabort = () => resolve({ ok: false, error: tx.error || req.error });
    } catch (error) {
      resolve({ ok: false, error });
    }
  });
}

function readNextPrimaryKeys(db: IDBDatabase, table: string, after: IDBValidKey | undefined, limit: number): Promise<{ keys: IDBValidKey[]; done: boolean }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, 'readonly');
    const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true);
    const req = tx.objectStore(table).openKeyCursor(range);
    const keys: IDBValidKey[] = [];
    let done = false;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        done = true;
        return;
      }
      keys.push(cursor.primaryKey);
      if (keys.length >= limit) return;
      cursor.continue();
    };
    tx.oncomplete = () => resolve({ keys, done });
    tx.onerror = tx.onabort = () => reject(tx.error || req.error || new Error(`无法读取 ${table} 的主键索引`));
  });
}

/** 从幸存的周边表里尽力捞回损坏角色的显示名与头像，失败静默忽略。 */
async function collectBrokenCharacterHints(
  db: IDBDatabase,
  targetIds: ReadonlySet<string>,
): Promise<Map<string, { name?: string; avatar?: string }>> {
  const hints = new Map<string, { name?: string; avatar?: string }>();
  if (!targetIds.size) return hints;
  const note = (id: unknown, name?: unknown, avatar?: unknown) => {
    if (typeof id !== 'string' || !targetIds.has(id)) return;
    const prev = hints.get(id) || {};
    if (!prev.name && typeof name === 'string' && name.trim()) prev.name = name.trim();
    if (!prev.avatar && typeof avatar === 'string' && avatar.trim()) prev.avatar = avatar.trim();
    hints.set(id, prev);
  };

  const scanBounded = (table: string, limit: number, inspect: (row: any) => void) => new Promise<void>(resolve => {
    if (!db.objectStoreNames.contains(table)) {
      resolve();
      return;
    }
    try {
      const tx = db.transaction(table, 'readonly');
      const req = tx.objectStore(table).openCursor();
      let seen = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || seen >= limit) return;
        seen++;
        try { inspect(cursor.value); } catch { /* ignore */ }
        cursor.continue();
      };
      req.onerror = event => {
        event.preventDefault();
        resolve();
      };
      tx.oncomplete = tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });

  await scanBounded('social_posts', 400, row => {
    note(row?.authorId, row?.authorName, row?.authorAvatar);
    if (Array.isArray(row?.comments)) {
      for (const c of row.comments) note(c?.authorId, c?.authorName, c?.authorAvatar);
    }
  });
  await scanBounded('guidebook', 200, row => note(row?.charId, row?.charName, row?.charAvatar));
  await scanBounded('diaries', 200, row => note(row?.charId, row?.charName));
  await scanBounded('story_theaters', 200, row => note(row?.charId, row?.charName));
  return hints;
}

function buildPlaceholderCharacter(charId: string, hint?: { name?: string; avatar?: string }): CharacterProfile {
  const shortId = charId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'char';
  const name = hint?.name || (charId === 'preset-sully-v2' ? 'Sully' : `抢救恢复角色 (${shortId})`);
  const avatar = hint?.avatar || generateAvatar(name);
  return {
    id: charId,
    name,
    avatar,
    description: '原角色档案因设备断电或存储文件缺失无法读取，抢救导出时已按原编号保留占位档案；聊天记录与记忆均已挂回该角色名下，请在此补回人设。',
    systemPrompt: '',
    memories: [],
  };
}

async function discoverAllSpaces(): Promise<UserSpace[]> {
  const byId = new Map<string, UserSpace>();
  for (const space of listUserSpaces()) {
    if (space?.id) byId.set(space.id, { id: space.id, name: space.name || space.id });
  }
  if (!byId.has('default')) byId.set('default', { id: 'default', name: '默认用户' });

  // 若 localStorage 目录也丢了，尝试从默认库的镜像行与浏览器库名列表补齐所有空间。
  const defaultDb = await openExistingDatabaseRaw('AetherOS_Data');
  if (defaultDb && defaultDb.objectStoreNames.contains('assets')) {
    const catalogRow = await readSingleRecordIsolated(defaultDb, 'assets', 'user_spaces_catalog_v1');
    if (catalogRow.ok && typeof catalogRow.value?.data === 'string') {
      try {
        const parsed = JSON.parse(catalogRow.value.data);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item?.id === 'string' && !byId.has(item.id)) {
              byId.set(item.id, { id: item.id, name: typeof item.name === 'string' && item.name.trim() ? item.name : item.id });
            }
          }
        }
      } catch { /* ignore malformed mirror */ }
    }
  }

  defaultDb?.close();

  const anyIdb = typeof indexedDB !== 'undefined' ? (indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }) : undefined;
  if (typeof anyIdb?.databases === 'function') {
    try {
      const list = await anyIdb.databases();
      for (const entry of list) {
        const match = /^AetherOS_Data__(u_[a-zA-Z0-9_-]+)$/.exec(entry.name || '');
        if (match && !byId.has(match[1])) {
          byId.set(match[1], { id: match[1], name: `恢复用户 (${match[1].slice(0, 8)})` });
        }
      }
    } catch { /* ignore */ }
  }
  return [...byId.values()];
}

function buildRescueReportText(
  healedCharacters: readonly RescueCharacterRecovery[],
  placeholderCharacters: readonly RescueCharacterRecovery[],
  skippedRecords: readonly RescueSkippedRecord[],
  unreadableBlobIds: readonly string[],
  failedSections: readonly string[],
): string {
  const lines = [
    'SullyOS 数据库紧急抢救导出报告',
    `导出时间：${new Date().toISOString()}`,
    '',
    `从本地多槽安全快照自动恢复的角色档案：${healedCharacters.length} 个`,
    `因原档案损坏自动生成同编号占位的角色：${placeholderCharacters.length} 个`,
    `因底层文件缺失/损坏跳过的表记录：${skippedRecords.length} 条`,
    `因底层文件缺失/损坏跳过的二进制素材：${unreadableBlobIds.length} 个`,
  ];
  if (healedCharacters.length) {
    lines.push('', '【已从安全快照恢复完整设定的角色】');
    for (const c of healedCharacters) lines.push(`- 用户「${c.spaceName}」→ ${c.name} (${c.charId})`);
  }
  if (placeholderCharacters.length) {
    lines.push('', '【已生成同编号占位壳的角色（恢复后聊天记录与记忆仍归在其名下，请手动补回人设）】');
    for (const c of placeholderCharacters) lines.push(`- 用户「${c.spaceName}」→ ${c.name} (${c.charId})`);
  }
  if (skippedRecords.length) {
    lines.push('', '【跳过的损坏记录明细（仅列出键名与错误类型，不含隐私正文）】');
    for (const r of skippedRecords) lines.push(`- 用户「${r.spaceName}」· ${r.store} · 主键 ${r.key}：${r.error}`);
  }
  if (unreadableBlobIds.length) {
    lines.push('', '【跳过的不可读素材编号】');
    for (const id of unreadableBlobIds) lines.push(`- ${id}`);
  }
  if (failedSections.length) {
    lines.push('', '【未能读取的附加区域】');
    for (const sec of failedSections) lines.push(`- ${sec}`);
  }
  return lines.join('\n');
}

function buildSummaryBanner(
  healedCount: number,
  placeholderCount: number,
  skippedCount: number,
  unreadableBlobCount: number,
): string {
  const parts: string[] = ['已将本机可读取的全部存档打包完成。'];
  if (healedCount > 0) parts.push(`其中 ${healedCount} 个损坏的角色档案已从本机安全快照完整找回。`);
  if (placeholderCount > 0) {
    parts.push(`有 ${placeholderCount} 个角色档案因原文件丢失已自动生成同编号占位档案，导回后聊天记录与记忆仍归在该角色名下，补回人设即可继续对话。`);
  }
  const otherSkipped = Math.max(0, skippedCount - placeholderCount) + unreadableBlobCount;
  if (otherSkipped > 0) {
    parts.push(`另有 ${otherSkipped} 项已损坏无法读取的记录或素材已自动跳过（详见包内「抢救导出报告.txt」）。`);
  }
  return parts.join('');
}

export async function exportDamagedDatabaseRescue(
  onProgress?: (text: string) => void,
): Promise<DatabaseRescueResult> {
  const healedCharacters: RescueCharacterRecovery[] = [];
  const placeholderCharacters: RescueCharacterRecovery[] = [];
  const skippedRecords: RescueSkippedRecord[] = [];
  const unreadableBlobIds = new Set<string>();
  const failedSections: string[] = [];
  let missingAssets: BackupMissingAsset[] = [];
  // 同一空间在预扫描与正式写页都会过一遍 characters，缓存快照恢复与占位结果避免重复处理。
  const healedCache = new Map<string, CharacterProfile>();
  const reportedHealed = new Set<string>();
  const openedDatabases: IDBDatabase[] = [];
  const openRaw = async (name: string) => {
    const db = await openExistingDatabaseRaw(name);
    if (db) openedDatabases.push(db);
    return db;
  };

  let blobDbPromise: Promise<IDBDatabase | null> | undefined;
  const hooks: RescueExportHooks = {
    readBlob: async id => {
      const db = await (blobDbPromise ??= openRaw('AetherOS_Data'));
      if (!db?.objectStoreNames.contains('blob_assets')) return null;
      const result = await readSingleRecordIsolated(db, 'blob_assets', id);
      if (!result.ok) throw result.error;
      const row = result.value;
      if (!row?.sharedBlobId) return row?.blob || null;
      const shared = await readSingleRecordIsolated(db, 'blob_assets', row.sharedBlobId);
      if (!shared.ok) throw shared.error;
      const blob = shared.value?.blob as Blob | undefined;
      return blob && typeof row.type === 'string' && blob.type !== row.type ? blob.slice(0, blob.size, row.type) : blob || null;
    },
    discoverSpaces: discoverAllSpaces,
    openMainDB: async space => {
      const raw = await openRaw(spaceDatabaseName('AetherOS_Data', space.id));
      if (!raw) failedSections.push('用户「' + space.name + '」主数据库无法打开');
      return raw;
    },
    openCollabDB: space => openRaw(spaceDatabaseName('SullyOS_Collaboration', space.id)),
    forEachPage: async (space, store, database, tableName, visit, options) => {
      const preScan = options?.preScan === true;
      let after: IDBValidKey | undefined;
      let pageIndex = 0;
      const brokenCharIds = new Set<string>();
      const survivedCharIds = new Set<string>();

      const emitPage = async (page: StorePage) => {
        if (store === 'characters') {
          for (const row of page.rows) if (row?.id) survivedCharIds.add(String(row.id));
        }
        await visit(page.rows, pageIndex++, page);
      };

      for (;;) {
        let fastPage: StorePage | null = null;
        try {
          fastPage = await readStorePage(database, tableName, after);
          if (fastPage && !fastPage.done && fastPage.rows.length === 0) fastPage = null;
        } catch {
          fastPage = null;
        }
        if (fastPage) {
          await emitPage(fastPage);
          if (fastPage.done) break;
          after = fastPage.lastKey;
          continue;
        }

        // 整页游标遇到损坏记录：切到主键索引 + 单键隔离读取，把这一段里完好的记录逐条救出。
        onProgress?.(`检测到 ${space.name} · ${store} 存在损坏记录，正在逐条抢救…`);
        let keyBatch: { keys: IDBValidKey[]; done: boolean };
        try {
          keyBatch = await readNextPrimaryKeys(database, tableName, after, KEY_BATCH_LIMIT);
        } catch (keyError) {
          if (!preScan) failedSections.push(`用户「${space.name}」· ${store} 索引无法读取（${formatErrorBrief(keyError)}）`);
          break;
        }
        if (!keyBatch.keys.length) break;

        let currentRows: any[] = [];
        let currentBytes = 0;
        let maxRowBytes = 0;
        let firstKey: IDBValidKey | undefined;
        let lastKey: IDBValidKey | undefined;

        const flushAccumulated = async (done: boolean) => {
          if (!currentRows.length && !done) return;
          await emitPage({
            rows: currentRows,
            done,
            firstKey,
            lastKey,
            bytes: currentBytes,
            maxRowBytes,
          });
          currentRows = [];
          currentBytes = 0;
          maxRowBytes = 0;
          firstKey = undefined;
        };

        for (const key of keyBatch.keys) {
          after = key;
          lastKey = key;
          const cacheKey = `${space.id}:${String(key)}`;
          let row: any | undefined;
          let readable = false;

          if (store === 'characters' && healedCache.has(cacheKey)) {
            row = healedCache.get(cacheKey);
            readable = true;
          } else {
            const single = await readSingleRecordIsolated(database, tableName, key);
            if (single.ok) {
              row = single.value;
              readable = row !== undefined;
            } else if (store === 'characters') {
              const recovered = await recoverCharacterFromSafetySnapshot(space.id, String(key));
              if (recovered) {
                healedCache.set(cacheKey, recovered);
                row = recovered;
                readable = true;

              } else {
                brokenCharIds.add(String(key));
                if (!preScan) {
                  skippedRecords.push({
                    spaceId: space.id,
                    spaceName: space.name,
                    store,
                    key: String(key),
                    error: formatErrorBrief(single.error),
                  });
                }
              }
            } else if (!preScan) {
              skippedRecords.push({
                spaceId: space.id,
                spaceName: space.name,
                store,
                key: String(key),
                error: formatErrorBrief(single.error),
              });
            }
          }

          if (!readable) continue;
          if (!preScan && store === 'characters' && healedCache.has(cacheKey) && !reportedHealed.has(cacheKey)) {
            reportedHealed.add(cacheKey);
            healedCharacters.push({ spaceId: space.id, spaceName: space.name, charId: row.id, name: row.name || row.id, mode: 'safety_snapshot' });
          }
          const size = approxRecordBytes(row);
          if (currentRows.length > 0 && (currentRows.length >= PAGE_ROW_LIMIT || currentBytes + size > PAGE_BYTE_BUDGET)) {
            await flushAccumulated(false);
          }
          if (!currentRows.length) firstKey = key;
          currentRows.push(row);
          currentBytes += size;
          if (size > maxRowBytes) maxRowBytes = size;
        }

        await flushAccumulated(keyBatch.done);
        if (keyBatch.done) break;
      }

      // 正式导出角色表时，为无法恢复原卡的角色补入同编号占位壳，保住聊天记录与记忆归属。
      if (!preScan && store === 'characters' && brokenCharIds.size > 0) {
        const missingIds = new Set([...brokenCharIds].filter(id => !survivedCharIds.has(id)));
        if (missingIds.size > 0) {
          const hints = await collectBrokenCharacterHints(database, missingIds);
          const placeholders: CharacterProfile[] = [];
          for (const charId of missingIds) {
            const shell = buildPlaceholderCharacter(charId, hints.get(charId));
            placeholders.push(shell);
            placeholderCharacters.push({
              spaceId: space.id,
              spaceName: space.name,
              charId,
              name: shell.name,
              mode: 'placeholder',
            });
          }
          const bytes = approxRecordBytes(placeholders);
          await visit(placeholders, pageIndex++, {
            rows: placeholders,
            done: true,
            bytes,
            maxRowBytes: Math.max(...placeholders.map(approxRecordBytes)),
          });
        }
      }
    },
    onUnreadableRow: (space, store, row, error) => {
      const key = row?.id ?? row?.name ?? 'unknown';
      skippedRecords.push({
        spaceId: space.id,
        spaceName: space.name,
        store,
        key: String(key),
        error: formatErrorBrief(error),
      });
    },
    onUnreadableBlob: id => {
      unreadableBlobIds.add(id);
    },
    onAuxiliaryError: (section, error) => {
      failedSections.push(`${section}（${formatErrorBrief(error)}）`);
    },
    extraFiles: () => {
      const blobs = [...unreadableBlobIds];
      if (!healedCharacters.length && !placeholderCharacters.length && !skippedRecords.length && !blobs.length && !failedSections.length) {
        return [];
      }
      const reportText = buildRescueReportText(healedCharacters, placeholderCharacters, skippedRecords, blobs, failedSections);
      return [
        ['抢救导出报告.txt', reportText],
        ['diagnostics/rescue-report.json', JSON.stringify({
          version: 1,
          exportedAt: new Date().toISOString(),
          healedCharacters,
          placeholderCharacters,
          skippedRecords,
          unreadableBlobIds: blobs,
          failedSections,
        }, null, 2)],
      ];
    },
  };

  const runTask = () => exportUserSpacesForRescue(hooks, onProgress, items => { missingAssets = items; });
  let blob: Blob;
  try {
    const { withScreenWakeLock } = await import('./backupTempFile');
    blob = await withScreenWakeLock(runTask);
  } finally {
    for (const db of openedDatabases) db.close();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `Sully_Rescue_Backup_${stamp}.zip`;
  const blobs = [...unreadableBlobIds];
  const reportText = buildRescueReportText(healedCharacters, placeholderCharacters, skippedRecords, blobs, failedSections);
  const summaryText = buildSummaryBanner(
    healedCharacters.length,
    placeholderCharacters.length,
    skippedRecords.length,
    blobs.length,
  ) + (failedSections.length ? '另有 ' + failedSections.length + ' 个区域无法完整导出，请查看包内抢救报告。' : '');

  return {
    blob,
    fileName,
    healedCharacters,
    placeholderCharacters,
    skippedRecords,
    unreadableBlobIds: blobs,
    missingAssets,
    failedSections,
    summaryText,
    reportText,
  };
}
