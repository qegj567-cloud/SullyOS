// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const KEY = 'sully_db_open_diagnostics_v1';
const PREFIX = 'sully_db_open_diagnostics_v2_';
let windowEvents: ReturnType<typeof vi.spyOn>, documentEvents: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); localStorage.clear();
  vi.stubGlobal('__APP_BUILD_ID__', 'build-A');
  windowEvents = vi.spyOn(window, 'addEventListener');
  documentEvents = vi.spyOn(document, 'addEventListener');
});
afterEach(() => {
  for (const [type, listener] of windowEvents.mock.calls) window.removeEventListener(type as string, listener as EventListener);
  for (const [type, listener] of documentEvents.mock.calls) document.removeEventListener(type as string, listener as EventListener);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear();
});
function savedSessions() {
  return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!)
    .filter(key => key.startsWith(PREFIX)).map(key => JSON.parse(localStorage.getItem(key)!));
}

it('keeps a bounded device-local trace across reloads without record contents', async () => {
  vi.resetModules();
  const { recordDatabaseOpen, flushDatabaseOpenDiagnostics } = await import('./databaseOpenDiagnostics');
  for (let i = 0; i < 20; i++) recordDatabaseOpen('open-requested', { requestedVersion: 74 });
  recordDatabaseOpen('upgrade-started', { requestedVersion: 74, fromVersion: 72, actualVersion: 74, content: 'private-chat' } as any);
  flushDatabaseOpenDiagnostics();
  expect(savedSessions()[0]).toHaveLength(16);
  vi.resetModules();
  const { databaseOpenDiagnostic } = await import('./databaseOpenDiagnostics');
  const text = databaseOpenDiagnostic();
  expect(text).toContain('upgrade-started');
  expect(text).toContain('原版本 72');
  expect(text).not.toContain('private-chat');
});

it('ignores malformed stored entries and strips fields outside the diagnostic contract', async () => {
  localStorage.setItem(KEY, JSON.stringify([
    { phase: 'open-ready', at: 1e100, build: 'test', requestedVersion: 74 },
    { phase: 'unknown', at: 0, build: 'test', requestedVersion: 74 },
    { phase: 'open-ready', at: 0, build: 'test', requestedVersion: 74, actualVersion: 74, secret: 'private-chat' },
  ]));
  vi.resetModules();
  const { databaseOpenDiagnostic } = await import('./databaseOpenDiagnostics');
  const text = databaseOpenDiagnostic();
  expect(text.match(/open-ready/g)).toHaveLength(1);
  expect(text).not.toContain('unknown');
  expect(text).not.toContain('private-chat');
});

it('retains an in-memory trace when device storage is inaccessible', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
  vi.resetModules();
  const { recordDatabaseOpen, databaseOpenDiagnostic } = await import('./databaseOpenDiagnostics');
  expect(() => recordDatabaseOpen('open-error', { requestedVersion: 74 })).not.toThrow();
  expect(databaseOpenDiagnostic()).toContain('open-error');
});

it('does no storage IO during startup/upgrade and defers persistence after the read check settles', async () => {
  const read = vi.spyOn(Storage.prototype, 'getItem'), write = vi.spyOn(Storage.prototype, 'setItem');
  const diagnostics = await import('./databaseOpenDiagnostics');
  // An imported module can request the DB before the entry point sets its hold.
  diagnostics.beginDatabaseOpen(74);
  diagnostics.startDatabaseOpenDiagnostics();
  diagnostics.recordDatabaseOpen('upgrade-started', { requestedVersion: 74, fromVersion: 72 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  diagnostics.releaseDatabaseDiagnosticPersistence();
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(savedSessions()[0].map((entry: any) => entry.phase)).toEqual(['open-requested', 'page-start', 'upgrade-started']);
});

it('keeps successful upgrade/read checkpoints after the ring rolls over and after reload', async () => {
  const diagnostics = await import('./databaseOpenDiagnostics');
  diagnostics.recordDatabaseOpen('upgrade-committed', { requestedVersion: 74, fromVersion: 72, actualVersion: 74, requestId: 1 });
  diagnostics.recordDatabaseOpen('read-ready', { actualVersion: 74, requestId: 1 });
  for (let i = 0; i < 20; i++) diagnostics.recordDatabaseOpen('page-visible');
  diagnostics.flushDatabaseOpenDiagnostics();
  expect(savedSessions()[0].some((entry: any) => entry.phase === 'upgrade-committed')).toBe(false);
  vi.resetModules();
  const { databaseOpenDiagnostic } = await import('./databaseOpenDiagnostics');
  expect(databaseOpenDiagnostic()).toContain('upgrade-committed');
  expect(databaseOpenDiagnostic()).toContain('read-ready');
  expect(databaseOpenDiagnostic()).toContain('实际版本 74');
});

it.each([['build-A', 'build-A'], ['build-A', 'build-B']])('distinguishes failure on %s and recovery on %s without persisting exception contents', async (failedBuild, recoveredBuild) => {
  vi.stubGlobal('__APP_BUILD_ID__', failedBuild);
  const failed = await import('./databaseOpenDiagnostics');
  const first = failed.beginDatabaseOpen(74);
  failed.recordDatabaseOpen('open-error', { requestedVersion: 74, requestId: first }, new DOMException('Index with the same ID already exists private-chat', 'UnknownError'));
  failed.flushDatabaseOpenDiagnostics();
  vi.resetModules(); vi.stubGlobal('__APP_BUILD_ID__', recoveredBuild);
  const recovered = await import('./databaseOpenDiagnostics');
  const second = recovered.beginDatabaseOpen(74);
  recovered.recordDatabaseOpen('open-ready', { requestedVersion: 74, actualVersion: 74, requestId: second });
  recovered.flushDatabaseOpenDiagnostics();
  const sessions = savedSessions();
  expect(sessions).toHaveLength(2);
  expect(sessions[0][0].session).not.toBe(sessions[1][0].session);
  expect(sessions.flat().filter((entry: any) => entry.phase === 'open-error')).toMatchObject([{ buildId: failedBuild, errorCategory: 'duplicate-index-id' }]);
  expect(sessions.flat().filter((entry: any) => entry.phase === 'open-ready')).toMatchObject([{ buildId: recoveredBuild, actualVersion: 74 }]);
  expect(recovered.databaseOpenDiagnostic()).not.toContain('private-chat');
});

it('separates overlapping requests and captures a successful connection followed by a failed core read', async () => {
  const diagnostics = await import('./databaseOpenDiagnostics');
  const first = diagnostics.beginDatabaseOpen(74), second = diagnostics.beginDatabaseOpen(74);
  const db = { version: 74 } as IDBDatabase;
  diagnostics.associateDatabaseOpen(db, second, 74);
  diagnostics.recordDatabaseOpen('upgrade-aborted', { requestId: first, fromVersion: 72, requestedVersion: 74 });
  diagnostics.recordDatabaseOpen('open-ready', { requestId: second, actualVersion: 74 });
  diagnostics.recordDatabaseRead(db, new DOMException('sensitive details', 'InvalidStateError'));
  diagnostics.flushDatabaseOpenDiagnostics();
  expect(savedSessions()[0].filter((entry: any) => entry.phase === 'read-error')).toMatchObject([{ requestId: second, errorCategory: 'invalid-state' }]);
  expect(savedSessions()[0].some((entry: any) => entry.phase === 'read-ready')).toBe(false);
});

it('does not overwrite another still-running page and retains at most eight recent sessions', async () => {
  const earlier = await import('./databaseOpenDiagnostics');
  earlier.recordDatabaseOpen('open-error', { requestedVersion: 74 }); earlier.flushDatabaseOpenDiagnostics();
  vi.resetModules();
  const later = await import('./databaseOpenDiagnostics');
  later.recordDatabaseOpen('open-ready', { actualVersion: 74 }); later.flushDatabaseOpenDiagnostics();
  earlier.recordDatabaseOpen('open-blocked'); earlier.flushDatabaseOpenDiagnostics();
  expect(later.databaseOpenDiagnostic()).toContain('open-blocked');
  expect(later.databaseOpenDiagnostic()).toContain('open-ready');
  localStorage.setItem('os_api_config', 'preserve');
  for (let i = 0; i < 10; i++) {
    vi.resetModules(); const next = await import('./databaseOpenDiagnostics');
    next.recordDatabaseOpen('open-requested', { requestedVersion: 74 }); next.flushDatabaseOpenDiagnostics();
  }
  expect(savedSessions()).toHaveLength(8);
  expect(localStorage.getItem('os_api_config')).toBe('preserve');
});

it('saves failure breadcrumbs on pagehide even before startup settles and records standalone mode', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const diagnostics = await import('./databaseOpenDiagnostics');
  diagnostics.startDatabaseOpenDiagnostics();
  diagnostics.recordDatabaseOpen('open-error', { requestedVersion: 74 });
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  expect(savedSessions()[0].at(-1)).toMatchObject({ phase: 'page-hide', persisted: true, mode: 'standalone' });
  expect(diagnostics.databaseDiagnosticReport()).toContain('standalone');
});
