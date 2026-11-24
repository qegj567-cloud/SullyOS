import { recordDatabaseRead } from './databaseOpenDiagnostics';

// No database imports: db.ts can report failures without introducing a cycle.
export type DatabaseFailure = { name: string; message: string };
const listeners = new Set<(failure: DatabaseFailure) => void>();

export function databaseFailure(error: unknown): DatabaseFailure {
  try {
    if (error == null) return { name: 'AbortError', message: 'IndexedDB transaction aborted' };
    if (typeof error === 'string') return { name: 'Error', message: error || '未知数据库错误' };
    if (typeof error === 'object') {
      const rec = error as { name?: unknown; message?: unknown; code?: unknown; type?: unknown };
      const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'Error';
      if (typeof rec.message === 'string' && rec.message.trim()) {
        return { name, message: rec.message.trim() };
      }
      if (typeof Event !== 'undefined' && error instanceof Event) {
        return { name: error.type || name, message: `浏览器存储事件异常 (${error.type || 'error'})` };
      }
      if (typeof rec.code === 'string' || typeof rec.code === 'number') {
        return { name, message: `code=${String(rec.code)}` };
      }
      return { name, message: name !== 'Error' ? name : '未知数据库错误' };
    }
    return { name: 'Error', message: String(error) };
  } catch {
    return { name: 'Error', message: '未知数据库错误' };
  }
}

export function reportDatabaseFailure(error: unknown) {
  const failure = databaseFailure(error);
  for (const listener of listeners) listener(failure);
}

export function subscribeDatabaseFailure(listener: (failure: DatabaseFailure) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Read actual storage before mounting providers that seed defaults or start sync. */
export async function checkDatabaseReadable(open: () => Promise<IDBDatabase>): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['characters', 'messages', 'assets'], 'readonly');
      for (const name of ['characters', 'messages', 'assets']) tx.objectStore(name).count();
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('本地数据读取失败'));
    });
  }
  catch (error) { recordDatabaseRead(db, error); throw error; }
  recordDatabaseRead(db);
}
