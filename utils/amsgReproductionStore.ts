/** 页面和 SW 共用独立诊断库；不进入聊天、备份或记忆处理。 */
import { diagnosticRunId, DIAGNOSTIC_RETENTION_DAYS, type DiagnosticEvent } from './amsgReproduction';

export interface DiagnosticRun {
  runId: string;
  createdAt: number;
  dueAt: number;
  api: { host: string; model: string };
  status: 'preparing' | 'scheduled' | 'uncertain' | 'failed' | 'cancelled';
  taskUuid?: string;
  observation?: 'unanswered' | 'banner' | 'center-only' | 'none';
  scenario?: 'background' | 'locked' | 'closed' | 'foreground';
  before?: unknown;
  after?: unknown;
  messages?: Array<{ messageId: string; text: string; receivedAt: number }>;
}

async function openDiagnosticDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('AmsgReproduction', 1);
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error('诊断记录库响应超时')); }, 2000);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('runs', { keyPath: 'runId' });
      const events = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
      events.createIndex('runId', 'runId');
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (settled) { request.result.close(); return; }
      settled = true; request.result.onversionchange = () => request.result.close(); resolve(request.result);
    };
    request.onerror = () => { settled = true; clearTimeout(timer); reject(request.error); };
    request.onblocked = () => { settled = true; clearTimeout(timer); reject(new Error('诊断记录库被占用')); };
  });
}

async function transact<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction, done: (value: T) => void) => void): Promise<T> {
  const db = await openDiagnosticDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value: T;
      const timer = setTimeout(() => { try { tx.abort(); } catch { /* 已结束 */ } reject(new Error('诊断记录事务超时')); }, 2000);
      tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
      tx.onerror = () => { clearTimeout(timer); reject(tx.error); };
      tx.onabort = () => { clearTimeout(timer); reject(tx.error ?? new Error('诊断记录未保存')); };
      body(tx, result => { value = result; });
    });
  } finally { db.close(); }
}

export async function saveDiagnosticRun(run: DiagnosticRun): Promise<void> {
  await transact<void>(['runs'], 'readwrite', tx => { tx.objectStore('runs').put(run); });
}

export async function updateDiagnosticRun(runId: string, patch: Partial<DiagnosticRun>): Promise<void> {
  await transact<void>(['runs'], 'readwrite', tx => {
    const store = tx.objectStore('runs');
    const request = store.get(runId);
    request.onsuccess = () => { if (request.result) store.put({ ...request.result, ...patch, runId }); };
  });
}

export async function listDiagnosticRuns(): Promise<DiagnosticRun[]> {
  return transact(['runs'], 'readonly', (tx, done) => {
    const request = tx.objectStore('runs').getAll();
    request.onsuccess = () => done((request.result as DiagnosticRun[]).sort((a, b) => b.createdAt - a.createdAt));
  });
}

export async function listDiagnosticEvents(runId: string): Promise<DiagnosticEvent[]> {
  return transact(['events'], 'readonly', (tx, done) => {
    const request = tx.objectStore('events').index('runId').getAll(runId);
    request.onsuccess = () => done(request.result);
  });
}

export async function appendDiagnosticEvent(entry: DiagnosticEvent): Promise<void> {
  if (!diagnosticRunId({ amsgDiagnosticRunId: entry.runId })) return;
  await transact<void>(['events'], 'readwrite', tx => {
    const store = tx.objectStore('events');
    store.add(entry);
    const keys = store.index('runId').getAllKeys(entry.runId);
    keys.onsuccess = () => { for (const key of keys.result.slice(0, -300)) store.delete(key); };
  });
}

/** 开始一轮前清理过期记录，保留最近十轮；不影响任何应用存档。 */
export async function pruneDiagnosticRuns(): Promise<void> {
  const runs = await listDiagnosticRuns();
  const cutoff = Date.now() - DIAGNOSTIC_RETENTION_DAYS * 86400000;
  const remove = new Set(runs.filter((run, index) => index >= 9 || run.createdAt < cutoff).map(run => run.runId));
  await transact<void>(['runs', 'events'], 'readwrite', tx => {
    for (const runId of remove) tx.objectStore('runs').delete(runId);
    const cursor = tx.objectStore('events').openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      if (remove.has(row.value.runId) || Date.parse(row.value.ts) < cutoff) row.delete();
      row.continue();
    };
  });
}

export async function recordDiagnosticInbox(message: {
  metadata?: unknown; messageId?: string; body?: string; receivedAt?: number;
}, trigger: string): Promise<boolean> {
  const runId = diagnosticRunId(message.metadata);
  if (!runId) return false;
  await transact<void>(['runs', 'events'], 'readwrite', tx => {
    const runs = tx.objectStore('runs');
    const request = runs.get(runId);
    request.onsuccess = () => {
      // 在另一台设备收到测试消息也不能漏进正常聊天；没有本机 run 就只留收件证据。
      const run = request.result as DiagnosticRun | undefined;
      if (run && !run.messages?.some(item => item.messageId === message.messageId)) {
        runs.put({ ...run, messages: [...(run.messages ?? []), {
          messageId: message.messageId ?? '', text: (message.body ?? '').slice(0, 4000), receivedAt: message.receivedAt ?? Date.now(),
        }].slice(-30) });
      }
    };
    tx.objectStore('events').add({ runId, side: 'page', event: 'page-received', ts: new Date().toISOString(), messageId: message.messageId, trigger, receivedAt: message.receivedAt });
  });
  return true;
}
