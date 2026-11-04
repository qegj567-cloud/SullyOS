// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

const watch = vi.hoisted(() => vi.fn());
vi.mock('./webUpdateSession', () => ({ watchWebUpdates: watch, changeWebUpdateActivity: vi.fn() }));
vi.mock('./databaseOpenDiagnostics', () => ({ recordDatabaseOpen: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); watch.mockReset(); });

it('shares one pending registration with the first reply and does not await cache preparation', async () => {
  vi.resetModules();
  let registered!: (reg: any) => void, ready!: () => void;
  const reg = { scope: '/SullyOS/' };
  const register = vi.fn(() => new Promise(resolve => { registered = resolve; }));
  const controller = { postMessage: vi.fn() };
  vi.stubGlobal('navigator', { serviceWorker: { register, ready: new Promise<void>(resolve => { ready = resolve; }), controller } });
  // Cache attachment can remain pending indefinitely without becoming a readiness gate.
  watch.mockReturnValue(new Promise(() => {}));
  const { KeepAlive } = await import('./keepAlive');
  const init = KeepAlive.init(), first = KeepAlive.start();
  expect(register).toHaveBeenCalledOnce();
  registered(reg); await Promise.resolve();
  expect(watch).toHaveBeenCalledWith(reg);
  expect(controller.postMessage).not.toHaveBeenCalled();
  ready(); await Promise.all([init, first]);
  expect(controller.postMessage).toHaveBeenCalledWith({ type: 'keepalive-start' });
  await KeepAlive.start();
  expect(register).toHaveBeenCalledOnce();
});

it('allows another registration attempt after failure without leaving a rejected readiness promise', async () => {
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const register = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ scope: '/' });
  vi.stubGlobal('navigator', { serviceWorker: { register, ready: Promise.resolve(), controller: null } });
  const { KeepAlive } = await import('./keepAlive');
  await KeepAlive.init(); await KeepAlive.init();
  expect(register).toHaveBeenCalledTimes(2);
});
