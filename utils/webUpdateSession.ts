import { APP_VERSION_TAG } from './appVersion';
import { RELEASE_CHANNEL, releaseUpdateVersion } from './releaseChannel';

export interface ResourceCacheStats {
  buildId: string;
  appVersion: string;
  offlineReady: boolean;
  shellBytes: number;
  runtimeBytes: number;
  runtimeEntries: number;
}

export function requestResourceCache(worker: ServiceWorker, type: string): Promise<ResourceCacheStats> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const close = () => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); };
    const timer = setTimeout(() => { close(); reject(new Error('缓存服务暂时没有响应，请稍后重试')); }, type === 'SULLY_CACHE_PREPARE' ? 120000 : 5000);
    channel.port1.onmessage = event => {
      close();
      const data = event.data;
      if (data?.error || typeof data?.buildId !== 'string') reject(new Error(data?.error || '缓存服务返回异常'));
      else resolve(data);
    };
    try { worker.postMessage({ type }, [channel.port2]); }
    catch (error) { close(); reject(error); }
  });
}

interface UpdateState {
  supported: boolean;
  available: boolean;
  dismissed: boolean;
  working: boolean;
  message: string;
  stats: ResourceCacheStats | null;
}
interface Dependencies {
  buildId: string;
  /** Version number of this page. Only a release with a different one is announced. */
  appVersion: string;
  container?: ServiceWorkerContainer;
  reload: () => void;
  canReload: () => boolean;
  request: (worker: ServiceWorker, type: string) => Promise<ResourceCacheStats>;
}

/** Build ids begin with the build time in base 36 (vite.config.ts), which orders releases. */
export function isNewerBuild(candidate: string, current: string): boolean {
  const time = (id: string) => parseInt(id.split('-')[0], 36);
  return time(candidate) > time(current);
}

export const UPDATE_READY_MESSAGE = '新版本已准备好，可以更新了';

export function createWebUpdateSession(deps: Dependencies) {
  let state: UpdateState = { supported: false, available: false, dismissed: false, working: false, message: '', stats: null };
  let registration: ServiceWorkerRegistration | undefined;
  let approvedWorker: ServiceWorker | null = null;
  let activationTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCheck = 0;
  let blocked = false;
  let checking = false;
  let autoPrepared = false;
  let userAsked = false;
  let followingUntil = 0;
  const listeners = new Set<() => void>();
  const watched = new WeakSet<ServiceWorker>();
  const update = (patch: Partial<UpdateState>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
  // A notice the user postponed stays postponed until they check again themselves.
  const available = () => update({ available: true, working: false, message: UPDATE_READY_MESSAGE, ...(state.available ? {} : { dismissed: false }) });
  // Sends the consent that lets a waiting worker take over; the page reloads once it controls it.
  const activate = (worker: ServiceWorker) => {
    approvedWorker = worker;
    update({ working: true, message: '正在更新，即将刷新…' });
    activationTimer = setTimeout(() => {
      approvedWorker = null;
      update({ working: false, message: '更新暂未接管，请稍后重试' });
    }, 15000);
    try { worker.postMessage({ type: 'SULLY_ACTIVATE_UPDATE' }); }
    catch {
      clearTimeout(activationTimer);
      approvedWorker = null;
      update({ working: false, message: '更新暂未接管，请重新检查更新后再试' });
    }
  };
  // Only a release with a new version number interrupts the user, unless they asked in settings.
  // For any other downloaded release the worker in charge sends page loads to the network, so the
  // next refresh is that release; its page then lets the waiting worker follow, with nothing to
  // reload. A worker that cannot name its release is announced.
  const offer = async (worker: ServiceWorker) => {
    const release = userAsked ? null : await deps.request(worker, 'SULLY_CACHE_STATUS').catch(() => null);
    if (worker.state === 'redundant') return;
    if (release?.appVersion !== deps.appVersion) available();
    else if (release.buildId !== deps.buildId || blocked || !deps.canReload()) {
      update({ working: false, message: '新版本已下载，下次打开或刷新时生效' });
    } else {
      // While the takeover is under way the old worker must stay idle: a message to it would make
      // the browser hold the new one back.
      followingUntil = Date.now() + 15000;
      try { worker.postMessage({ type: 'SULLY_ACTIVATE_UPDATE' }); } catch { followingUntil = 0; }
    }
  };
  const inspect = async () => {
    const worker = deps.container?.controller || registration?.active;
    if (registration?.waiting) await offer(registration.waiting);
    if (!worker || Date.now() < followingUntil) return;
    try {
      const stats = await deps.request(worker, 'SULLY_CACHE_STATUS');
      update({ stats });
      // A newer worker already controls this page (another tab applied it): a reload picks up its
      // shell, which is worth announcing for a new version number. An older worker means the page
      // came from the network ahead of it; its replacement is handled through `waiting` once
      // downloaded, and reloading before that changes nothing.
      if (isNewerBuild(stats.buildId, deps.buildId)) { if (userAsked || stats.appVersion !== deps.appVersion) available(); }
      else if (stats.buildId === deps.buildId && !stats.offlineReady) {
        // A first installation becomes active before its offline shell exists: fetch it once in the background.
        if (!autoPrepared && !state.working) { autoPrepared = true; void prepareOffline(); }
        else update({ message: '离线资源尚未准备完成，可在设置里重新下载' });
      }
    } catch { /* Older push-only workers do not implement this protocol. */ }
  };
  const watch = (worker: ServiceWorker | null) => {
    if (!worker || watched.has(worker)) return;
    watched.add(worker);
    // Only a worker discarded while still installing failed to download; one that is replaced later did not.
    let downloading = worker.state === 'installing';
    const changed = () => {
      if (worker.state === 'installed') {
        if (deps.container?.controller) void offer(worker);
        else update({ working: false });
      } else if (worker.state === 'redundant' && downloading) {
        update({ working: false, message: '新版本下载未完成，当前版本可以继续使用；联网后再检查更新' });
      }
      downloading = worker.state === 'installing';
    };
    worker.addEventListener('statechange', changed);
    changed();
  };
  const attach = async (value: ServiceWorkerRegistration) => {
    const first = registration !== value;
    if (first) {
      registration = value;
      value.addEventListener('updatefound', () => {
        update({ working: true, message: '正在准备更新资源…' });
        watch(value.installing);
      });
      update({ supported: true });
      watch(value.installing);
    }
    await inspect();
    // The worker of this release clears shells of releases no page runs any more. It is asked
    // here, once the app is up, because doing that while it activates would hold up the page load.
    if (first && state.stats?.buildId === deps.buildId) deps.container?.controller?.postMessage({ type: 'SULLY_CACHE_TIDY' });
  };

  deps.container?.addEventListener('controllerchange', () => {
    const approved = approvedWorker && deps.container?.controller === approvedWorker;
    approvedWorker = null;
    followingUntil = 0;
    clearTimeout(activationTimer);
    if (approved && !blocked && deps.canReload()) { deps.reload(); return; }
    update({ working: false });
    void inspect();
  });
  deps.container?.addEventListener('message', event => {
    if (event.data?.type === 'SULLY_GET_PAGE_BUILD') event.ports[0]?.postMessage({ buildId: deps.buildId });
  });

  const check = async (manual = true) => {
    if (!registration || checking || state.working || (!manual && Date.now() - lastCheck < 60 * 60 * 1000)) return;
    lastCheck = Date.now();
    checking = true;
    // Background checks stay silent: they must not disable buttons or replace what the user is reading.
    if (manual) { userAsked = true; update({ working: true, message: '正在检查更新…', dismissed: false }); }
    try {
      await registration.update();
      if (registration.installing) { watch(registration.installing); return; }
      await inspect();
      if (manual) update({ working: false, message: state.available ? UPDATE_READY_MESSAGE : '当前已是最新版本' });
    } catch {
      if (manual) update({ working: false, message: '暂时无法检查更新，联网后再试；已缓存的内容仍可使用' });
    } finally { checking = false; }
  };

  const apply = async () => {
    if (!state.available || state.working) return;
    if (blocked || !deps.canReload()) { update({ message: '请等当前回复、通话或数据操作完成后再更新' }); return; }
    if (!registration?.waiting) {
      const controller = deps.container?.controller;
      const stats = controller ? await deps.request(controller, 'SULLY_CACHE_STATUS').catch(() => null) : null;
      if (stats && isNewerBuild(stats.buildId, deps.buildId)) {
        if (!blocked && deps.canReload()) deps.reload();
        else update({ message: '请等当前回复、通话或数据操作完成后再更新' });
      }
      else { update({ available: false }); await check(); }
      return;
    }
    activate(registration.waiting);
  };

  const refreshStats = async () => {
    const worker = deps.container?.controller;
    if (!worker) return;
    try { update({ stats: await deps.request(worker, 'SULLY_CACHE_STATUS') }); }
    catch (error) { update({ message: error instanceof Error ? error.message : '暂时无法读取缓存' }); }
  };
  const clearRuntime = async () => {
    const worker = deps.container?.controller;
    if (!worker || state.working) return;
    update({ working: true });
    try { update({ stats: await deps.request(worker, 'SULLY_CACHE_CLEAR'), message: '已清理按需资源，下次使用时会重新下载' }); }
    catch { update({ message: '缓存暂时无法清理，请稍后再试' }); }
    finally { update({ working: false }); }
  };

  const prepareOffline = async () => {
    const worker = deps.container?.controller;
    if (!worker || state.working) return;
    update({ working: true, message: '正在准备离线资源…' });
    try { update({ stats: await deps.request(worker, 'SULLY_CACHE_PREPARE'), message: '离线启动资源已准备好' }); }
    catch { update({ message: '离线资源未准备完成，请检查网络和可用空间后重试' }); }
    finally { update({ working: false }); }
  };

  return {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    attach, check, apply, refreshStats, clearRuntime, prepareOffline,
    dismiss: () => update({ dismissed: true }),
    setBlocked: (value: boolean) => { blocked = value; },
  };
}

// Keep the session across Settings mounts. Registration remains owned by KeepAlive.
let runningRequests = 0;
export function changeWebUpdateActivity(delta: number) { runningRequests = Math.max(0, runningRequests + delta); }
// Reading the container throws where storage access is denied (sandboxed frames, blocked site data).
function serviceWorkerContainer(): ServiceWorkerContainer | undefined {
  try { return typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined; }
  catch { return undefined; }
}
const pageBuildId = typeof __APP_BUILD_ID__ === 'undefined' ? 'development' : __APP_BUILD_ID__;
export const webUpdateSession = createWebUpdateSession({
  buildId: pageBuildId,
  // 与 vite.config.ts 写进 SW 清单的同一个式子：canary 每个构建都算新版本，会弹更新提示。
  appVersion: releaseUpdateVersion(APP_VERSION_TAG, RELEASE_CHANNEL, pageBuildId),
  container: serviceWorkerContainer(),
  reload: () => window.location.reload(), canReload: () => runningRequests === 0, request: requestResourceCache,
});

export function watchWebUpdates(registration: ServiceWorkerRegistration) {
  // The dev server and the native app (built with `--mode capacitor`) run the push-only worker.
  if (import.meta.env.DEV || import.meta.env.MODE === 'capacitor') return;
  void webUpdateSession.attach(registration);
  if (watchingUpdates) return;
  watchingUpdates = true;
  const check = () => { if (document.visibilityState === 'visible' && navigator.onLine) void webUpdateSession.check(false); };
  document.addEventListener('visibilitychange', check);
  window.addEventListener('online', check);
  setInterval(check, 60 * 60 * 1000);
}
let watchingUpdates = false;
