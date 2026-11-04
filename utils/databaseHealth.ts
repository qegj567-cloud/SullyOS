import { recordDatabaseRead } from './databaseOpenDiagnostics';

// No database imports: db.ts can report failures without introducing a cycle.
export type DatabaseFailure = { name: string; message: string };
const listeners = new Set<(failure: DatabaseFailure) => void>();

export function databaseFailure(error: unknown): DatabaseFailure {
  return {
    name: error && typeof error === 'object' && 'name' in error ? String(error.name) : 'Error',
    message: error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error),
  };
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
