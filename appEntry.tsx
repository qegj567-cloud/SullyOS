import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DatabaseGuard from './components/DatabaseGuard';
import { openDB } from './utils/db';
import { restoreSpaceCatalog } from './utils/userSpaceData';
import { cancelUserSpaceTransition } from './utils/userSpaceTransition';
import { checkDatabaseReadable } from './utils/databaseHealth';
import { startDatabaseOpenDiagnostics, releaseDatabaseDiagnosticPersistence, recordDatabaseOpen } from './utils/databaseOpenDiagnostics';
import { installTranslateCrashGuard } from './utils/translateCrashGuard';
import { ActiveMsgRuntime } from './utils/activeMsgRuntime';
import { KeepAlive } from './utils/keepAlive';
import { VRScheduler } from './utils/vrWorld/scheduler';
import { installIOSStandaloneWorkaround } from './utils/iosStandalone';
import { installIOSStatusBarEdge } from './utils/iosStatusBarEdge';
import { installReducedBlurPolicy } from './utils/blurPolicy';
import { initAnalytics } from './utils/analytics';
import { Capacitor } from '@capacitor/core';
import { RELEASE_CHANNEL, watchCanaryBootHealth } from './utils/releaseChannel';

// Prepare storage and the SW in parallel. Only background writers wait for both;
// DatabaseGuard shares this read check and never waits for the SW/offline downloads.
startDatabaseOpenDiagnostics();
const databaseReady = checkDatabaseReadable(openDB).then(async result => { await restoreSpaceCatalog(); return result; });
void databaseReady.catch(cancelUserSpaceTransition);
void databaseReady.then(releaseDatabaseDiagnosticPersistence, releaseDatabaseDiagnosticPersistence);
// 等本地库和空间目录恢复再收件，不依赖浏览器 SW，也不误消费其他空间的结果。
if (import.meta.env.VITE_AMSG_NATIVE_PUSH === 'true' && Capacitor.isNativePlatform()) {
  void databaseReady.then(async () => {
    if (Capacitor.getPlatform() === 'android') {
      const { initUnifiedPushRuntime } = await import('./utils/unifiedPushRuntime');
      await initUnifiedPushRuntime();
    } else {
      const { initNativeAmsgPush } = await import('./utils/nativeAmsgPush');
      await initNativeAmsgPush();
    }
  }).catch(() => console.warn('原生推送暂未启动：本地存储或原生桥未就绪'));
}
const keepAliveReady = KeepAlive.init();
Promise.all([databaseReady, keepAliveReady]).then(() => {
  recordDatabaseOpen('background-ready');
  // Resume 「彼方」 autonomous-login schedules
  VRScheduler.resume();
  void ActiveMsgRuntime.init();
}).catch(error => console.error('后台任务暂未启动：本地数据或保活服务未就绪', error));

const disposeIOSStatusBarEdge = installIOSStatusBarEdge();
const disposeReducedBlurPolicy = installReducedBlurPolicy();
installIOSStandaloneWorkaround();
if (import.meta.hot) {
  import.meta.hot.dispose(disposeIOSStatusBarEdge);
  import.meta.hot.dispose(disposeReducedBlurPolicy);
}

// 使用统计。构建时没配 VITE_UMAMI_* 就整个不生效，自部署实例默认如此。
// 用户关掉开关、或浏览器开了 DNT，同样在这里就返回，连脚本都不会挂上去。
initAnalytics();

// 浏览器自动翻译 (Chrome/Edge 等) 会改动 React 托管的 DOM，导致 reconcile 时
// insertBefore/removeChild 抛 NotFoundError 白屏。挂载前先打护栏。详见该 util 注释。
installTranslateCrashGuard();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

// 全局样式按通道切换配色（index.html 里的 canary 金黄主题）。
document.documentElement.dataset.releaseChannel = RELEASE_CHANNEL;
const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <DatabaseGuard readiness={databaseReady}><App /></DatabaseGuard>
  </React.StrictMode>
);
// canary 挂载稳住了就清掉启动计数，否则正式版会以为它打不开而自动退回（docs/canary-channel.md）。
watchCanaryBootHealth(rootElement);
