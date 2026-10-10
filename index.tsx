import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DatabaseGuard from './components/DatabaseGuard';
import { openDB } from './utils/db';
import { checkDatabaseReadable } from './utils/databaseHealth';
import { startDatabaseOpenDiagnostics, releaseDatabaseDiagnosticPersistence, recordDatabaseOpen } from './utils/databaseOpenDiagnostics';
import { installTranslateCrashGuard } from './utils/translateCrashGuard';
import { ActiveMsgRuntime } from './utils/activeMsgRuntime';
import { KeepAlive } from './utils/keepAlive';
import { ProactiveChat } from './utils/proactiveChat';
import { VRScheduler } from './utils/vrWorld/scheduler';
import { installIOSStandaloneWorkaround } from './utils/iosStandalone';
import { installIOSStatusBarEdge } from './utils/iosStatusBarEdge';
import { installWakeListener } from './utils/proactivePushConfig';
import { initAnalytics } from './utils/analytics';
import { Capacitor } from '@capacitor/core';

// 默认构建不开启时 Rollup 会整段裁掉；普通浏览器/PWA 不加载原生插件、不申请权限。
if (import.meta.env.VITE_AMSG_NATIVE_PUSH === 'true' && Capacitor.isNativePlatform()) {
  if (Capacitor.getPlatform() === 'android') {
    void import('./utils/unifiedPushRuntime').then(({ initUnifiedPushRuntime }) => initUnifiedPushRuntime());
  } else {
    void import('./utils/nativeAmsgPush').then(({ initNativeAmsgPush }) => initNativeAmsgPush());
  }
}

// Prepare storage and the SW in parallel. Only background writers wait for both;
// DatabaseGuard shares this read check and never waits for the SW/offline downloads.
startDatabaseOpenDiagnostics();
const databaseReady = checkDatabaseReadable(openDB);
void databaseReady.then(releaseDatabaseDiagnosticPersistence, releaseDatabaseDiagnosticPersistence);
const keepAliveReady = KeepAlive.init();
Promise.all([databaseReady, keepAliveReady]).then(() => {
  recordDatabaseOpen('background-ready');
  // Resume any active proactive schedule after SW is ready
  ProactiveChat.resume();
  // Resume 「彼方」 autonomous-login schedules
  VRScheduler.resume();
  void ActiveMsgRuntime.init();
  // Record every wake the SW reports so the diagnostic panel can show "last received".
  installWakeListener();
}).catch(error => console.error('后台任务暂未启动：本地数据或保活服务未就绪', error));

installIOSStandaloneWorkaround();
const disposeIOSStatusBarEdge = installIOSStatusBarEdge();
if (import.meta.hot) import.meta.hot.dispose(disposeIOSStatusBarEdge);

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

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <DatabaseGuard readiness={databaseReady}><App /></DatabaseGuard>
  </React.StrictMode>
);
