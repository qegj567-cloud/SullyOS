import { BUILD_LABEL } from './buildInfo';

const LEGACY_KEY = 'sully_db_open_diagnostics_v1';
const PREFIX = 'sully_db_open_diagnostics_v2_';
const CHECKPOINT_PREFIX = 'sully_db_open_checkpoint_v2_';
const LIMIT = 16, SESSION_LIMIT = 8;
const phases = ['page-start', 'page-hidden', 'page-visible', 'page-hide', 'page-show', 'sw-requested', 'sw-ready', 'sw-error', 'background-ready', 'read-ready', 'read-error', 'open-requested', 'versionless-fallback', 'upgrade-started', 'upgrade-committed', 'upgrade-aborted', 'open-ready', 'open-error', 'open-blocked', 'open-timeout', 'connection-closed', 'version-change'] as const;
const categories = ['duplicate-index-id', 'blocked', 'timeout', 'version', 'abort', 'invalid-state', 'other'] as const;
const checkpointPhases = ['open-ready', 'read-ready', 'upgrade-committed'] as const;
type Phase = typeof phases[number];
type CheckpointPhase = typeof checkpointPhases[number];
type Details = { requestedVersion?: number; fromVersion?: number; actualVersion?: number; requestId?: number; persisted?: boolean };
type Entry = Details & { phase: Phase; at: number; build: string; buildId?: string; session?: string; seq?: number; elapsedMs?: number; mode?: 'standalone' | 'browser'; errorCategory?: typeof categories[number] };
const buildId = typeof __APP_BUILD_ID__ === 'undefined' ? 'development' : __APP_BUILD_ID__;
const session = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const connections = new WeakMap<IDBDatabase, Details>();
let entries: Entry[] = [], checkpoints: Partial<Record<CheckpointPhase, Entry>> = {};
let seq = 0, requestId = 0, started = false, held = false, scheduled = false, dirty = false, pruned = false;

function mode(): 'standalone' | 'browser' {
  return typeof navigator !== 'undefined' && ((navigator as Navigator & { standalone?: boolean }).standalone ||
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)) ? 'standalone' : 'browser';
}

function category(error: unknown): typeof categories[number] {
  const value = error as { name?: unknown; message?: unknown } | null;
  if (typeof value?.message === 'string' && value.message.includes('Index with the same ID already exists')) return 'duplicate-index-id';
  switch (value?.name) {
    case 'VersionError': return 'version';
    case 'AbortError': return 'abort';
    case 'InvalidStateError': return 'invalid-state';
    default: return 'other';
  }
}

/** Whitelist saved fields; never carry record contents or arbitrary exception text. */
function decode(item: any): Entry | undefined {
  if (!item || !phases.includes(item.phase) || !Number.isFinite(item.at) || Math.abs(item.at) > 8.64e15 ||
    typeof item.build !== 'string' || item.build.length > 160) return;
  const entry: Entry = { phase: item.phase, at: item.at, build: item.build };
  for (const field of ['requestedVersion', 'fromVersion', 'actualVersion', 'requestId', 'seq', 'elapsedMs'] as const) {
    if (Number.isSafeInteger(item[field]) && item[field] >= 0) entry[field] = item[field];
  }
  if (typeof item.buildId === 'string' && item.buildId.length <= 160) entry.buildId = item.buildId;
  if (typeof item.session === 'string' && /^[a-z0-9-]{1,80}$/i.test(item.session)) entry.session = item.session;
  if (item.mode === 'browser' || item.mode === 'standalone') entry.mode = item.mode;
  if (typeof item.persisted === 'boolean') entry.persisted = item.persisted;
  if (categories.includes(item.errorCategory)) entry.errorCategory = item.errorCategory;
  return entry;
}

function stored(key: string): unknown {
  const raw = localStorage.getItem(key);
  return raw && raw.length <= 65536 ? JSON.parse(raw) : undefined;
}
function savedEntries(key: string): Entry[] {
  try {
    const saved = stored(key);
    return Array.isArray(saved) ? saved.slice(-LIMIT).map(decode).filter((entry): entry is Entry => !!entry) : [];
  } catch { return []; }
}
function sessionKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  return keys;
}

/** Called at idle / pagehide, never awaited by database opening or rendering. */
export function flushDatabaseOpenDiagnostics(): void {
  if (!dirty) return;
  dirty = false;
  try {
    // Each page owns its key: concurrent pages cannot overwrite each other's event ring.
    localStorage.setItem(PREFIX + session, JSON.stringify(entries));
    for (const phase of checkpointPhases) {
      const entry = checkpoints[phase];
      if (!entry) continue;
      let previous: Entry | undefined;
      try { previous = decode(stored(CHECKPOINT_PREFIX + phase)); } catch { /* Replace malformed diagnostics only. */ }
      if (!previous || previous.at <= entry.at) localStorage.setItem(CHECKPOINT_PREFIX + phase, JSON.stringify(entry));
    }
    if (!pruned) {
      pruned = true;
      const history = sessionKeys().filter(key => key !== PREFIX + session).map(key => ({ key, at: savedEntries(key).at(-1)?.at || 0 }))
        .sort((a, b) => b.at - a.at);
      // Only diagnostics keys are eligible; no application data or caches are touched.
      for (const { key } of history.slice(SESSION_LIMIT - 1)) localStorage.removeItem(key);
    }
  } catch { /* Keep this page's in-memory trace when storage is denied/full. */ }
}

function schedulePersistence() {
  if (held || scheduled) return;
  scheduled = true;
  const save = () => { scheduled = false; if (!held) flushDatabaseOpenDiagnostics(); };
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') window.requestIdleCallback(save, { timeout: 2000 });
  else setTimeout(save, 1000);
}

/** Cheap in-memory breadcrumbs. No storage access on the open/upgrade critical path. */
export function recordDatabaseOpen(phase: Phase, details: Details = {}, error?: unknown): void {
  const entry: Entry = { phase, at: Date.now(), build: BUILD_LABEL, buildId, session, seq: ++seq,
    elapsedMs: Math.round(performance.now()), mode: mode() };
  for (const field of ['requestedVersion', 'fromVersion', 'actualVersion', 'requestId', 'persisted'] as const) {
    if (details[field] !== undefined) (entry as any)[field] = details[field];
  }
  if (error != null) entry.errorCategory = category(error);
  else if (phase === 'open-blocked') entry.errorCategory = 'blocked';
  else if (phase === 'open-timeout') entry.errorCategory = 'timeout';
  else if (phase === 'upgrade-aborted') entry.errorCategory = 'abort';
  entries = [...entries, entry].slice(-LIMIT);
  if ((checkpointPhases as readonly Phase[]).includes(phase)) checkpoints[phase as CheckpointPhase] = entry;
  dirty = true;
  schedulePersistence();
}

export function beginDatabaseOpen(requestedVersion: number): number {
  const id = ++requestId;
  recordDatabaseOpen('open-requested', { requestedVersion, requestId: id });
  return id;
}
export function associateDatabaseOpen(db: IDBDatabase, id: number, requestedVersion: number) {
  connections.set(db, { requestId: id, requestedVersion, actualVersion: db.version });
}
export function recordDatabaseRead(db: IDBDatabase, error?: unknown) {
  recordDatabaseOpen(error === undefined ? 'read-ready' : 'read-error', connections.get(db) || { actualVersion: db.version }, error);
}

export function startDatabaseOpenDiagnostics() {
  if (started) return;
  started = true;
  held = true;
  recordDatabaseOpen('page-start');
  if (typeof window === 'undefined') return;
  window.addEventListener('pagehide', event => {
    recordDatabaseOpen('page-hide', { persisted: event.persisted });
    flushDatabaseOpenDiagnostics();
  });
  window.addEventListener('pageshow', event => recordDatabaseOpen('page-show', { persisted: event.persisted }));
  document.addEventListener('visibilitychange', () => {
    recordDatabaseOpen(document.visibilityState === 'hidden' ? 'page-hidden' : 'page-visible');
    if (document.visibilityState === 'hidden') flushDatabaseOpenDiagnostics();
  });
}
export function releaseDatabaseDiagnosticPersistence() {
  held = false;
  schedulePersistence();
}

function line(entry: Entry): string {
  const details = [entry.buildId && `build ${entry.buildId}`, entry.session && `页面 ${entry.session}`,
    entry.seq !== undefined && `事件 ${entry.seq}`, entry.requestId !== undefined && `打开 ${entry.requestId}`,
    entry.mode, entry.elapsedMs !== undefined && `启动后 ${entry.elapsedMs}ms`,
    entry.requestedVersion !== undefined && `目标 ${entry.requestedVersion}`,
    entry.fromVersion !== undefined && `原版本 ${entry.fromVersion}`,
    entry.actualVersion !== undefined && `实际版本 ${entry.actualVersion}`,
    entry.errorCategory, entry.persisted !== undefined && `bfcache ${entry.persisted}`].filter(value => value !== undefined && value !== false);
  return `${new Date(entry.at).toISOString()} ${entry.build} ${entry.phase}（${details.join('，')}）`;
}

/** History is loaded only at idle persistence or an explicit diagnostic view/copy. */
export function databaseOpenDiagnostic(): string {
  let history = savedEntries(LEGACY_KEY);
  const pinned: Partial<Record<CheckpointPhase, Entry>> = {};
  try {
    for (const key of sessionKeys()) history.push(...savedEntries(key));
    for (const phase of checkpointPhases) pinned[phase] = decode(stored(CHECKPOINT_PREFIX + phase));
  } catch { /* The pending in-memory events remain available. */ }
  history.push(...entries);
  for (const phase of checkpointPhases) {
    const entry = checkpoints[phase];
    if (entry && (!pinned[phase] || pinned[phase]!.at <= entry.at)) pinned[phase] = entry;
  }
  const unique = new Map(history.map(entry => [`${entry.session || 'legacy'}:${entry.seq ?? entry.at}:${entry.phase}`, entry]));
  history = [...unique.values()].sort((a, b) => a.at - b.at || (a.seq || 0) - (b.seq || 0));
  const success = checkpointPhases.flatMap(phase => pinned[phase] ? [line(pinned[phase]!)] : []);
  return [history.length && `数据库打开记录（本机时间，UTC）：\n${history.map(line).join('\n')}`,
    success.length && `最近成功检查点（独立保留）：\n${success.join('\n')}`].filter(Boolean).join('\n');
}

export function databaseDiagnosticReport(failure?: { name: string; message: string }): string {
  return ['SullyOS 本地数据库诊断', `构建：${BUILD_LABEL}`, `构建 ID：${buildId}`, `本次页面：${session}（${mode()}）`,
    typeof location !== 'undefined' && `页面：${location.origin}${location.pathname}`,
    typeof navigator !== 'undefined' && `浏览器：${navigator.userAgent}`,
    failure && `错误：${failure.name}: ${failure.message}`, databaseOpenDiagnostic()].filter(Boolean).join('\n');
}
