import AnniversaryGiftPopup from './os/AnniversaryGiftPopup';
import { shouldShowAnniversaryGift, markAnniversaryGiftSeen } from '../utils/anniversaryGifts';



import React, { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { IMPORT_IN_PROGRESS_KEY, useOS } from '../context/OSContext';
import StatusBar from './os/StatusBar';
import { SARModuleMonitor } from './sar/SARModuleMonitor';
import Launcher from '../apps/Launcher';
import CompanionLockChrome from './os/CompanionLockChrome';
import { loadCompanionFrameStyle } from './os/companionFrameStyles';
import { createPreloadableLazy, type PreloadableLazy } from './os/preloadableLazy';

// 按需懒加载各 App —— 切到对应 App 时才下载/解析其代码块，首屏只加载 Launcher 与外壳，
// 大体积 App（MemoryPalace / VRWorld / Songwriting 等）不再压在主包里。
// 默认导出直接 lazy；命名导出（SpecialMomentsApp）用 .then 适配成 { default }。
// Launcher 保持静态导入：桌面常驻、需要秒开，不走懒加载。
//
// App 在用户打开/按下图标时立即加载；性能与网络条件合适时，桌面稳定后也会低优先级串行预热。
// 绝不能在冷启动阶段并发扫完整个列表：低端设备会同时下载、解压和解析几十个 chunk，
// 反而拖死用户此刻真正要打开的那个 App。
const lazyApp = createPreloadableLazy;

const Settings = lazyApp(() => import('../apps/Settings'));
const Character = lazyApp(() => import('../apps/Character'));
const Chat = lazyApp(() => import('../apps/Chat'));
const GroupChat = lazyApp(() => import('../apps/GroupChat'));
const ThemeMaker = lazyApp(() => import('../apps/ThemeMaker'));
const Appearance = lazyApp(() => import('../apps/Appearance'));
const Gallery = lazyApp(() => import('../apps/Gallery'));
const DateApp = lazyApp(() => import('../apps/DateApp'));
const UserApp = lazyApp(() => import('../apps/UserApp'));
const JournalApp = lazyApp(() => import('../apps/JournalApp'));
const ScheduleApp = lazyApp(() => import('../apps/ScheduleApp'));
const RoomApp = lazyApp(() => import('../apps/RoomApp'));
const CheckPhone = lazyApp(() => import('../apps/CheckPhone'));
const SocialApp = lazyApp(() => import('../apps/SocialApp'));
const StudyApp = lazyApp(() => import('../apps/StudyApp'));
const FAQApp = lazyApp(() => import('../apps/FAQApp'));
const GameApp = lazyApp(() => import('../apps/GameApp'));
const WorldbookApp = lazyApp(() => import('../apps/WorldbookApp'));
const NovelApp = lazyApp(() => import('../apps/NovelApp'));
const BankApp = lazyApp(() => import('../apps/BankApp'));
const XhsStockApp = lazyApp(() => import('../apps/XhsStockApp'));
const XhsFreeRoamApp = lazyApp(() => import('../apps/XhsFreeRoamApp'));
const BrowserApp = lazyApp(() => import('../apps/BrowserApp'));
const SongwritingApp = lazyApp(() => import('../apps/SongwritingApp'));
const MusicApp = lazyApp(() => import('../apps/MusicApp'));
const CallApp = lazyApp(() => import('../apps/CallApp'));
const VoiceDesignerApp = lazyApp(() => import('../apps/VoiceDesignerApp'));
const GuidebookApp = lazyApp(() => import('../apps/GuidebookApp'));
const LifeSimApp = lazyApp(() => import('../apps/LifeSimApp'));
const MemoryPalaceApp = lazyApp(() => import('../apps/MemoryPalaceApp'));
const HandbookApp = lazyApp(() => import('../apps/HandbookApp'));
const QQBridge = lazyApp(() => import('../apps/QQBridge'));
const HotNewsApp = lazyApp(() => import('../apps/HotNewsApp'));
const VRWorldApp = lazyApp(() => import('../apps/VRWorldApp'));
const WorldHomeApp = lazyApp(() => import('../apps/WorldHomeApp'));
const CharCreatorDevApp = lazyApp(() => import('../apps/CharCreatorDevApp'));
const SpecialMomentsApp = lazyApp(() => import('./ValentineEvent').then(m => ({ default: m.SpecialMomentsApp })));

// 仅供「桌面稳定后的空闲串行预热」。严格 await 前一个再取下一个，且任何用户操作都会停止队列。
// 高频 App 在前；低端设备/省流量/2G 由 shouldUseIdleAppPreload 整体跳过。
const APP_IDLE_PRELOAD_ORDER: PreloadableLazy[] = [
  Chat, Character, Settings, Appearance, GroupChat, RoomApp, CheckPhone,
  JournalApp, ScheduleApp, SocialApp, MusicApp, CallApp, Gallery, DateApp, UserApp,
  StudyApp, GameApp, NovelApp, BankApp, WorldbookApp, MemoryPalaceApp, HandbookApp,
  VRWorldApp, WorldHomeApp, LifeSimApp, SongwritingApp, GuidebookApp, FAQApp, HotNewsApp,
  XhsStockApp, XhsFreeRoamApp, BrowserApp, VoiceDesignerApp, ThemeMaker, QQBridge,
  SpecialMomentsApp, CharCreatorDevApp,
];

const IDLE_PRELOAD_START_MS = 600;
const IDLE_PRELOAD_GAP_MS = 250;
let idlePreloadCursor = 0;

// AppID → 懒加载组件，供「按下即预取」复用同一个模块 Promise。
// AppID 由下方 import 引入，ES 模块提升后全模块可用。
const APP_BY_ID: Partial<Record<AppID, PreloadableLazy>> = {
  [AppID.Settings]: Settings, [AppID.Character]: Character, [AppID.Chat]: Chat,
  [AppID.GroupChat]: GroupChat, [AppID.ThemeMaker]: ThemeMaker, [AppID.Appearance]: Appearance,
  [AppID.Gallery]: Gallery, [AppID.Date]: DateApp, [AppID.User]: UserApp,
  [AppID.Journal]: JournalApp, [AppID.Schedule]: ScheduleApp, [AppID.Room]: RoomApp,
  [AppID.CheckPhone]: CheckPhone, [AppID.Social]: SocialApp, [AppID.Study]: StudyApp,
  [AppID.FAQ]: FAQApp, [AppID.Game]: GameApp, [AppID.Worldbook]: WorldbookApp,
  [AppID.Novel]: NovelApp, [AppID.Bank]: BankApp, [AppID.XhsStock]: XhsStockApp,
  [AppID.XhsFreeRoam]: XhsFreeRoamApp, [AppID.Browser]: BrowserApp, [AppID.Songwriting]: SongwritingApp,
  [AppID.Music]: MusicApp, [AppID.Call]: CallApp, [AppID.VoiceDesigner]: VoiceDesignerApp,
  [AppID.Guidebook]: GuidebookApp, [AppID.LifeSim]: LifeSimApp, [AppID.MemoryPalace]: MemoryPalaceApp,
  [AppID.Handbook]: HandbookApp, [AppID.QQBridge]: QQBridge, [AppID.HotNews]: HotNewsApp,
  [AppID.VRWorld]: VRWorldApp, [AppID.CharCreatorDev]: CharCreatorDevApp, [AppID.SpecialMoments]: SpecialMomentsApp,
  [AppID.WorldHome]: WorldHomeApp,
};
// AppIcon 的 pointerdown 只预取用户正在点的 App；失败时由 preloadableLazy 清缓存，点击可正常重试。
setAppPayloadWarmer((id: AppID) => APP_BY_ID[id]?.preload());

import { Like520Controller, shouldShowLike520Popup } from './Like520Event';
import { QixiLaunchPopup } from './QixiLaunchPopup';
import { shouldShowQixiLaunchPopup } from '../utils/qixiLaunchPopup';
import { UpdateNotificationController, shouldShowUpdateNotification } from './UpdateNotificationEvent';
import { WorkerUpdateReminderController, shouldShowWorkerUpdateReminder, rearmWorkerUpdateReminder } from './WorkerUpdateReminderEvent';
import { InstantPushSunsetController, shouldShowInstantPushSunsetNotice } from './InstantPushSunsetEvent';
import { loadInstantConfig, probeInstantWorkerVersion } from '../utils/instantPushClient';
import { BackupReminderController } from './BackupReminderEvent';
import { shouldShowBackupReminder, markBackupReminderShown, daysSinceLastBackup } from '../utils/backupReminder';
import { formatBytes } from '../utils/format';
import { trackEvent } from '../utils/analytics';
import { AppID } from '../types';
import { shellHandlesSafeArea } from '../utils/safeAreaApps';
import { App as CapApp } from '@capacitor/app';
import { StatusBar as CapStatusBar, Style as StatusBarStyle } from '@capacitor/status-bar';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { isIOSStandaloneWebApp, resolveStatusBarMode } from '../utils/iosStandalone';
import AppErrorBoundary from './os/AppErrorBoundary';
import GlobalMiniPlayer from './os/GlobalMiniPlayer';
import PersonaSimIndicator from './os/PersonaSimIndicator';
import DreamSimIndicator from './os/DreamSimIndicator';
import ErrorDialog from './os/ErrorDialog';
import BootSequence from './os/BootSequence';
import { setAppPayloadWarmer, shouldUseIdleAppPreload } from './os/appPreload';
import { isBrowserBackGuardState, makeBrowserBackGuardState } from '../utils/browserBackGuard';

/*
// Internal Error Boundary Component
class AppErrorBoundary extends Component<{ children: React.ReactNode, onCloseApp: () => void, resetKey: string }, { hasError: boolean, error: Error | null, copyLabel: string }> {
    private copyLabelTimer: number | null = null;

    constructor(props: { children: React.ReactNode, onCloseApp: () => void, resetKey: string }) {
        super(props);
        this.state = { hasError: false, error: null, copyLabel: '复制报错信息' };
    }

    static getDerivedStateFromError(error: Error) {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error("App Crash:", error, errorInfo);
    }

    // Reset error state only when the active app changes.
    componentDidUpdate(prevProps: { children: React.ReactNode, onCloseApp: () => void, resetKey: string }) {
        if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
            this.setState({ hasError: false, error: null, copyLabel: '复制报错信息' });
        }
    }

    componentWillUnmount() {
        if (this.copyLabelTimer) window.clearTimeout(this.copyLabelTimer);
    }

    private updateCopyLabel = (label: string) => {
        if (this.copyLabelTimer) window.clearTimeout(this.copyLabelTimer);
        this.setState({ copyLabel: label });
        this.copyLabelTimer = window.setTimeout(() => {
            this.setState({ copyLabel: '复制报错信息' });
            this.copyLabelTimer = null;
        }, 1800);
    };

    private handleCopy = async () => {
        const errText = this.state.error?.stack || this.state.error?.message || 'Unknown Error';

        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(errText);
                this.updateCopyLabel('已复制');
                return;
            }
        } catch {
            // Fall through to legacy copy path.
        }

        try {
            const textarea = document.createElement('textarea');
            textarea.value = errText;
            textarea.setAttribute('readonly', 'true');
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            textarea.style.pointerEvents = 'none';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const copied = document.execCommand('copy');
            document.body.removeChild(textarea);
            if (copied) {
                this.updateCopyLabel('已复制');
                return;
            }
        } catch {
            // Fall through to prompt fallback.
        }

        window.prompt('请手动复制报错信息', errText);
        this.updateCopyLabel('请手动复制');
    };

    render() {
        if (this.state.hasError) {
            return (
                <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900 text-white p-6 text-center space-y-4">
                    <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f635.png" alt="error" className="w-10 h-10" />
                    <h2 className="text-lg font-bold">应用运行错误</h2>
                    <p className="text-xs text-slate-400 font-mono bg-black/30 p-3 rounded max-w-full overflow-auto max-h-40 select-text break-all whitespace-pre-wrap">
                        {this.state.error?.message || 'Unknown Error'}
                    </p>
                    <button
                        onClick={() => {
                            const errText = this.state.error?.message || 'Unknown Error';
                            navigator.clipboard?.writeText(errText).then(() => {}).catch(() => {});
                        }}
                        className="px-4 py-2 bg-slate-700 rounded-full text-xs active:scale-95 transition-transform"
                    >
                        复制错误信息
                    </button>
                    <button
                        onClick={() => { this.setState({ hasError: false }); this.props.onCloseApp(); }}
                        className="px-6 py-3 bg-red-600 rounded-full font-bold text-sm shadow-lg active:scale-95 transition-transform"
                    >
                        返回桌面
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
*/

const DISCLAIMER_KEY = 'sullyos_disclaimer_accepted';

type ImportRecoveryMarker = {
  startedAt?: number;
  updatedAt?: number;
  phase?: string;
  source?: string;
  sourceSize?: number;
  current?: string;
  currentFile?: string;
  currentFileSize?: number;
  assetDone?: number;
  assetTotal?: number;
  itemDone?: number;
  itemTotal?: number;
  error?: string;
};

const getPendingImportMarker = (): ImportRecoveryMarker | null => {
  try {
    const raw = localStorage.getItem(IMPORT_IN_PROGRESS_KEY);
    return raw ? (JSON.parse(raw) as ImportRecoveryMarker) : null;
  } catch {
    return null;
  }
};

const getImportPhaseLabel = (phase?: string) => {
  switch (phase) {
    case 'parsing': return '解析备份文件';
    case 'assets': return '恢复备份素材';
    case 'database': return '写入数据库';
    case 'settings': return '恢复系统设置';
    case 'error': return '导入报错';
    default: return '导入流程';
  }
};



const DisclaimerPopup: React.FC<{ onAccept: () => void }> = ({ onAccept }) => (
  <div className="fixed inset-0 z-[9999] flex items-center justify-center p-5 animate-fade-in">
    <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />
    <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden animate-slide-up">
      {/* Header */}
      <div className="pt-7 pb-3 px-6 text-center">
        <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4e2.png" alt="announcement" className="w-8 h-8 mb-2" />
        <h2 className="text-lg font-extrabold text-slate-800">免责声明</h2>
        <p className="text-[11px] text-slate-400 mt-1">Disclaimer · SullyOS·糯米机</p>
      </div>

      {/* Content */}
      <div className="px-6 pb-4 max-h-[55vh] overflow-y-auto no-scrollbar space-y-3">
        <p className="text-[13px] text-slate-600 leading-relaxed">
          本项目「SullyOS·糯米机」是一个<strong className="text-slate-800">完全开源、免费</strong>的软件，仅供个人学习、研究与技术交流使用。
        </p>
        <ul className="text-[12px] text-slate-500 leading-relaxed space-y-1.5 list-none">
          <li className="flex gap-2"><span className="shrink-0">•</span><span>本软件不提供任何明示或暗示的担保，作者不对使用本软件产生的任何后果承担责任。</span></li>
          <li className="flex gap-2"><span className="shrink-0">•</span><span>用户应自行承担使用本软件的一切风险，包括但不限于数据丢失、设备损坏等。</span></li>
          <li className="flex gap-2"><span className="shrink-0">•</span><span>本软件生成的任何 AI 内容均不代表作者立场，用户需自行判断内容的准确性与合规性。</span></li>
          <li className="flex gap-2"><span className="shrink-0">•</span><span>禁止将本软件用于任何违反当地法律法规的用途。</span></li>
        </ul>

        {/* Highlighted warning */}
        <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-4 mt-3">
          <p className="text-[13px] font-bold text-red-600 text-center leading-relaxed">
            本程序完全免费！<br />
            如果您是通过<span className="underline decoration-2 decoration-red-400">付费购买</span>获得此程序的，说明您已被倒卖欺骗。<br />
            请向售卖者维权追责！
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="px-6 pb-7 pt-2">
        <button
          onClick={onAccept}
          className="w-full py-3.5 bg-gradient-to-r from-indigo-500 to-purple-500 text-white font-bold rounded-2xl shadow-lg shadow-indigo-200 active:scale-95 transition-transform text-sm"
        >
          我已知悉，继续使用
        </button>
      </div>
    </div>
  </div>
);

const ImportRecoveryPopup: React.FC<{
  marker: ImportRecoveryMarker | null;
  onLater: () => void;
  onReimport: () => void;
}> = ({ marker, onLater, onReimport }) => {
  if (!marker) return null;

  const phaseLabel = getImportPhaseLabel(marker.phase);
  const startedAt = marker.startedAt
    ? new Date(marker.startedAt).toLocaleString('zh-CN')
    : '';
  const updatedAt = marker.updatedAt
    ? new Date(marker.updatedAt).toLocaleString('zh-CN')
    : '';
  const sourceSize = formatBytes(marker.sourceSize);
  const currentFileSize = formatBytes(marker.currentFileSize);
  const hasAssetProgress = typeof marker.assetTotal === 'number' && marker.assetTotal > 0;
  const hasItemProgress = typeof marker.itemTotal === 'number' && marker.itemTotal > 0;
  const hasError = !!marker.error;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-5 animate-fade-in">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />
      <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden animate-slide-up">
        <div className="pt-7 pb-3 px-6 text-center">
          <h2 className="text-lg font-extrabold text-slate-800">{hasError ? '上次导入失败了' : '上次导入被中断了'}</h2>
          <p className="text-[11px] text-slate-400 mt-1">{hasError ? '错误信息已记录在本机' : '数据还没有完整恢复'}</p>
        </div>

        <div className="px-6 pb-4 space-y-3 max-h-[58vh] overflow-y-auto no-scrollbar">
          <p className="text-[13px] text-slate-600 leading-relaxed">
            {hasError
              ? '系统检测到上一次导入过程中发生了错误。请重新导入同一个备份文件，避免数据只恢复了一半。'
              : '系统检测到上一次导入没有走到完成步骤，可能是浏览器或系统在导入过程中强制重启了。请重新导入同一个备份文件，避免数据只恢复了一半。'}
          </p>
          {hasError && (
            <div className="bg-red-50 border border-red-200 rounded-2xl p-3 text-[12px] text-red-700 leading-relaxed whitespace-pre-wrap break-words select-text">
              {marker.error}
            </div>
          )}
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 text-[12px] text-amber-700 leading-relaxed">
            <div>中断阶段：{phaseLabel}</div>
            {marker.current && <div>当前部分：{marker.current}</div>}
            {hasItemProgress && <div>条目进度：{marker.itemDone || 0}/{marker.itemTotal}</div>}
            {hasAssetProgress && <div>素材进度：{marker.assetDone || 0}/{marker.assetTotal}</div>}
            {marker.currentFile && (
              <div className="break-all">当前文件：{marker.currentFile}{currentFileSize ? ` · ${currentFileSize}` : ''}</div>
            )}
            {startedAt && <div>开始时间：{startedAt}</div>}
            {updatedAt && <div>最后进度：{updatedAt}</div>}
            {marker.source && <div className="break-all">备份文件：{marker.source}{sourceSize ? ` · ${sourceSize}` : ''}</div>}
          </div>
        </div>

        <div className="px-6 pb-7 pt-2 grid grid-cols-2 gap-3">
          <button
            onClick={onLater}
            className="py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform text-sm"
          >
            稍后再说
          </button>
          <button
            onClick={onReimport}
            className="py-3 bg-gradient-to-r from-emerald-500 to-teal-500 text-white font-bold rounded-2xl shadow-lg shadow-emerald-200 active:scale-95 transition-transform text-sm"
          >
            去重新导入
          </button>
        </div>
      </div>
    </div>
  );
};

// App 懒加载占位：关键是「延迟出现」。chunk 命中缓存/快速加载只需几十毫秒，这种时长用户
// 本就无感——但 Suspense fallback 会立刻渲染，占位一闪反而把无感瞬切变成能被看见的打断
// （loading spinner 闪烁反模式）。所以前 ~220ms 一律渲染空（无感），只有真的慢才浮现。
// 刻意「零动画开销」：之前那套呼吸/涟漪/上升微尘的持续动画在 iOS 上会引起卡顿，且预热命中后
// 这屏几乎不出现 —— 收益小、代价大。现在只一次性淡入一个静态柔光点（无 infinite 动画），
// 透明底让外壳虚化壁纸透出来。真卡住（>15s）才换成可点的刷新/返回兜底，避免低端设备
// 仍在正常解析单个大模块时被 7 秒阈值过早判死。
const AppLoadingFallback: React.FC<{ onReturn?: () => void; animationEnabled?: boolean }> = ({ onReturn, animationEnabled = true }) => {
  const [show, setShow] = useState(false);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const t = animationEnabled ? setTimeout(() => setShow(true), 220) : null;
    // 卡死逃生口：iOS standalone PWA 从后台恢复 / 弱网时，动态 import 可能既不 resolve 也不 reject，
    // Suspense 会永远停在这一屏（不报错 → 错误边界不触发 → 不会自动刷新），用户狂点中心光点却毫无反应。
    // 超过 STALL_MS 仍未加载完 → 把「看着像按钮其实不是」的光点换成真正可点的「刷新/返回」按钮，
    // 既明确告诉用户该点哪里，又把静默卡死变成一键可恢复。只动占位 UI，不碰 import 逻辑。
    const stall = setTimeout(() => { setStalled(true); trackEvent('App 加载卡死超时'); }, 15_000);
    return () => { if (t) clearTimeout(t); clearTimeout(stall); };
  }, [animationEnabled]);
  if (stalled) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900/95 text-white p-6 text-center space-y-4" style={{ animation: 'appLoadIn 320ms ease-out both' }}>
        <style>{`@keyframes appLoadIn{from{opacity:0}to{opacity:1}}`}</style>
        <h2 className="text-base font-bold">加载有点慢…</h2>
        <p className="text-xs text-slate-300 max-w-xs leading-relaxed">
          首次打开会下载并解析功能代码；网络波动或设备性能较低都可能变慢。页面仍在继续加载，若长时间没有恢复再刷新。
        </p>
        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button
            type="button"
            onClick={() => { trackEvent('卡死页点刷新恢复'); window.location.reload(); }}
            className="w-full px-6 py-3 bg-red-600 rounded-full font-bold text-sm shadow-lg active:scale-95 transition-transform"
          >
            刷新恢复
          </button>
          {onReturn && (
            <button
              type="button"
              onClick={() => { onReturn(); trackEvent('从卡死页返回桌面'); }}
              className="w-full px-4 py-2 bg-slate-700 rounded-full text-xs font-bold active:scale-95 transition-transform"
            >
              返回桌面
            </button>
          )}
        </div>
      </div>
    );
  }
  if (!show) return null;
  // 静态柔光点：仅一次性淡入，之后无任何持续动画（零运行时开销），透明底透出壁纸。
  return (
    <div className="w-full h-full flex items-center justify-center bg-transparent" style={{ animation: 'appLoadIn 280ms ease-out both' }}>
      <style>{`@keyframes appLoadIn{from{opacity:0}to{opacity:1}}`}</style>
      <div className="relative" style={{ width: 72, height: 72 }}>
        {/* 静态柔光 */}
        <div className="absolute inset-0" style={{ borderRadius: '9999px', filter: 'blur(8px)', background: 'radial-gradient(circle, hsla(var(--primary-hue),75%,72%,0.42) 0%, hsla(var(--primary-hue),70%,60%,0.10) 50%, transparent 70%)' }} />
        {/* 静态内核 */}
        <div className="absolute" style={{ left: '50%', top: '50%', width: 10, height: 10, transform: 'translate(-50%,-50%)', borderRadius: '9999px', background: 'radial-gradient(circle, #fff, hsla(var(--primary-hue),80%,75%,0.6) 60%, transparent)', boxShadow: '0 0 10px hsla(var(--primary-hue),80%,75%,0.6)' }} />
      </div>
    </div>
  );
};

const PhoneShell: React.FC = () => {
  const { theme, isLocked, unlock, activeApp, closeApp, openApp, virtualTime, isDataLoaded, toasts, unreadMessages, characters, handleBack, suspendedCall, resumeCall, activeCharacterId, errorDialog, dismissError } = useOS();
  const useIOSStandaloneLayout = isIOSStandaloneWebApp();

  // 三档顶部状态栏：安全显示 / 紧凑显示 / 隐藏。旧存档仍由 hideStatusBar 兼容解析。
  // compact 把时间放进 safe-area，本体顶栏只让出 max(safe-area, 1.5rem)，避免顶部再多一整行。
  const statusBarMode = resolveStatusBarMode(theme.statusBarMode, theme.hideStatusBar);
  useEffect(() => {
    document.documentElement.classList.toggle('sully-statusbar-hidden', statusBarMode === 'hidden');
    document.documentElement.classList.toggle('sully-statusbar-compact', statusBarMode === 'compact');
  }, [statusBarMode]);

  // 冷启动「世界入场」是否已结束。结束前由 BootSequence 接管整屏（同时取代旧的黑屏 spinner）。
  const [bootDone, setBootDone] = useState(false);
  const bootAnimationEnabled = theme.bootAnimationEnabled !== false;
  useEffect(() => {
    // 本次启动一旦选择跳过，就记为已经完成；用户稍后重新打开开关时不在桌面中途补播。
    if (!bootAnimationEnabled) setBootDone(true);
  }, [bootAnimationEnabled]);

  // 折中预热策略：首屏/开机完全让路；桌面稳定约 600ms 后，能力足够的设备就逐个预热。
  // 每次严格等待当前 chunk 下载 + 解析完成，再空一拍取下一个。用户一按屏幕或进入 App，
  // 立刻取消所有尚未开始的任务；已经在飞的一个 import 无法中止，但最多只会与目标 App 并行一个。
  useEffect(() => {
    if (!bootDone || !isDataLoaded || activeApp !== AppID.Launcher) return;
    if (!shouldUseIdleAppPreload() || idlePreloadCursor >= APP_IDLE_PRELOAD_ORDER.length) return;

    let stoppedByInteraction = false;
    let startTimer: number | null = null;
    let gapTimer: number | null = null;
    let idleHandle: number | null = null;
    const requestIdle = (callback: () => void): number => {
      if (typeof (window as any).requestIdleCallback === 'function') {
        return (window as any).requestIdleCallback(callback, { timeout: 2_000 });
      }
      return window.setTimeout(callback, 250);
    };
    const cancelScheduled = () => {
      if (startTimer !== null) window.clearTimeout(startTimer);
      if (gapTimer !== null) window.clearTimeout(gapTimer);
      if (idleHandle !== null) {
        if (typeof (window as any).cancelIdleCallback === 'function') {
          (window as any).cancelIdleCallback(idleHandle);
        } else {
          window.clearTimeout(idleHandle);
        }
      }
      startTimer = null;
      gapTimer = null;
      idleHandle = null;
    };
    const scheduleStep = (delay: number) => {
      if (stoppedByInteraction || document.visibilityState !== 'visible') return;
      gapTimer = window.setTimeout(() => {
        gapTimer = null;
        idleHandle = requestIdle(() => {
          idleHandle = null;
          void runStep();
        });
      }, delay);
    };
    const runStep = async () => {
      if (stoppedByInteraction || document.visibilityState !== 'visible') return;
      const next = APP_IDLE_PRELOAD_ORDER[idlePreloadCursor++];
      if (!next) return;
      try {
        await next.preload();
      } catch {
        // 空闲预热失败不打扰用户；真正点开时由 retryable preload 再试。
      }
      if (!stoppedByInteraction && idlePreloadCursor < APP_IDLE_PRELOAD_ORDER.length) {
        scheduleStep(IDLE_PRELOAD_GAP_MS);
      }
    };
    const stopForInteraction = () => {
      stoppedByInteraction = true;
      cancelScheduled();
    };
    const handleVisibilityChange = () => {
      cancelScheduled();
      if (document.visibilityState === 'visible' && !stoppedByInteraction) {
        startTimer = window.setTimeout(() => scheduleStep(0), IDLE_PRELOAD_START_MS);
      }
    };

    window.addEventListener('pointerdown', stopForInteraction, { capture: true, once: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    startTimer = window.setTimeout(() => scheduleStep(0), IDLE_PRELOAD_START_MS);

    return () => {
      stoppedByInteraction = true;
      cancelScheduled();
      window.removeEventListener('pointerdown', stopForInteraction, { capture: true });
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeApp, bootDone, isDataLoaded]);

  // Disclaimer popup for first-time users
  const [showDisclaimer, setShowDisclaimer] = useState(() => {
    try {
      return !localStorage.getItem(DISCLAIMER_KEY);
    } catch {
      return true;
    }
  });

  const handleAcceptDisclaimer = () => {
    try {
      localStorage.setItem(DISCLAIMER_KEY, Date.now().toString());
    } catch { /* ignore */ }
    setShowDisclaimer(false);
  };

  const [importRecoveryMarker, setImportRecoveryMarker] = useState<ImportRecoveryMarker | null>(() => {
    try {
      if (!localStorage.getItem(DISCLAIMER_KEY)) return null;
      return getPendingImportMarker();
    } catch {
      return null;
    }
  });
  const [importRecoveryDismissed, setImportRecoveryDismissed] = useState(false);
  const showImportRecoveryPrompt = !!importRecoveryMarker;

  useEffect(() => {
    if (showDisclaimer || importRecoveryDismissed || importRecoveryMarker) return;
    const marker = getPendingImportMarker();
    if (marker) setImportRecoveryMarker(marker);
  }, [showDisclaimer, importRecoveryDismissed, importRecoveryMarker]);

  // 使用统计：导入中断提醒弹出来时报一次。只带「失败/中断」和阶段这两个固定枚举，
  // marker 里的报错正文、备份文件名、当前文件名、各种进度数字一概不带。
  useEffect(() => {
    if (showDisclaimer || !showImportRecoveryPrompt) return;
    const phase = importRecoveryMarker?.phase;
    // phase 是 marker 里的字符串，只认这五个已知值，其余一律归 other，避免把未知原文发出去。
    const stage = phase === 'parsing' || phase === 'assets' || phase === 'database' || phase === 'settings' || phase === 'error'
      ? phase
      : 'other';
    const hasError = !!importRecoveryMarker?.error;
    trackEvent('弹出上次导入未完成提醒', { kind: hasError ? '失败' : '中断', stage });
    trackEvent('弹出导入中断恢复提醒', {
      中断类型: hasError ? '导入失败' : '导入被中断',
      中断阶段: getImportPhaseLabel(phase),
    });
  }, [showDisclaimer, showImportRecoveryPrompt, importRecoveryMarker]);

  const handleReimportFromRecovery = () => {
    setImportRecoveryDismissed(true);
    setImportRecoveryMarker(null);
    openApp(AppID.Settings);
    trackEvent('点去重新导入', { kind: importRecoveryMarker?.error ? '失败' : '中断' });
  };

  // 「致用户的一封信」已下线：常量置 false，保留变量让下面弹窗链的条件继续成立（恒真/恒不显示）。
  const showAuthorLetter = false;

  // Ta-da 周年赠礼先于更新公告，等基础启动提示、开机动画与解锁完成。
  const [showAnniversaryGift, setShowAnniversaryGift] = useState(false);
  const anniversaryAsked = useRef(false);
  const anniversaryBlocked = showDisclaimer || showImportRecoveryPrompt || showAuthorLetter;
  // 待展示也占住顺序，避免同一轮 effects 同时开启赠礼和更新公告。
  const anniversaryHasPriority = showAnniversaryGift || (!anniversaryAsked.current && shouldShowAnniversaryGift());
  useEffect(() => {
    if (anniversaryAsked.current || anniversaryBlocked || !isDataLoaded || isLocked || (!bootDone && bootAnimationEnabled)) return;
    if (shouldShowAnniversaryGift()) {
      anniversaryAsked.current = true;
      setShowAnniversaryGift(true);
    }
  }, [anniversaryBlocked, isDataLoaded, isLocked, bootDone, bootAnimationEnabled]);

  // 本次版本首映：数据就绪且解锁后出现一次，避免按钮打开的 App 被锁屏挡在背后。
  const [showUpdateNotification, setShowUpdateNotification] = useState(false);
  /**
   * 这次开机已经问过一轮了。
   *
   * 更新提醒可能不止一条（见 UpdateNotificationController 的队列），用户点「立刻体验」
   * 跳去别的 App 时，剩下那几条是故意不标已读、留到下次启动的。少了这道闸，弹窗一关
   * 下面的 effect 就会立刻再问一次「还有没有没看的」，然后把下一条糊在刚打开的页面上。
   */
  const updateNoticeAsked = useRef(false);

  useEffect(() => {
    if (updateNoticeAsked.current) return;
    if (anniversaryHasPriority || showDisclaimer || showImportRecoveryPrompt || showAuthorLetter || showUpdateNotification) return;
    if (!isDataLoaded || isLocked) return;
    if (shouldShowUpdateNotification()) {
      updateNoticeAsked.current = true;
      setShowUpdateNotification(true);
    }
  }, [anniversaryHasPriority, showDisclaimer, showImportRecoveryPrompt, showAuthorLetter, showUpdateNotification, isDataLoaded, isLocked]);

  // 七夕特别活动推送：严格按北京时间 2026-08-19 判断，用户处理后永久不再弹。
  // 排在版本更新之后、日常维护提醒之前；按钮只带到「特别时光」，不替用户选择角色。
  const [showQixiLaunchPopup, setShowQixiLaunchPopup] = useState(false);
  const qixiLaunchAsked = useRef(false);
  useEffect(() => {
    if (qixiLaunchAsked.current) return;
    if (anniversaryHasPriority || showDisclaimer || showImportRecoveryPrompt || showAuthorLetter || showUpdateNotification) return;
    if (!isDataLoaded || isLocked) return;
    if (shouldShowQixiLaunchPopup()) {
      qixiLaunchAsked.current = true;
      setShowQixiLaunchPopup(true);
    }
  }, [anniversaryHasPriority, showDisclaimer, showImportRecoveryPrompt, showAuthorLetter, showUpdateNotification, isDataLoaded, isLocked]);

  // 520 特别活动弹窗（2026-05-20 当天，且没被 dismiss / completed）
  // 一次性：用户点过任何按钮就标记 dismissed，下次刷新不再出现；
  // API 配置改成弹窗内嵌，配完直接进活动，不再需要把弹窗暂存让位给 Settings。
  const [showLike520Popup, setShowLike520Popup] = useState(false);
  useEffect(() => {
    if (anniversaryHasPriority || showDisclaimer || showImportRecoveryPrompt || showAuthorLetter || showUpdateNotification || showQixiLaunchPopup) return;
    if (!isDataLoaded) return;
    if (shouldShowLike520Popup()) setShowLike520Popup(true);
  }, [anniversaryHasPriority, showDisclaimer, showImportRecoveryPrompt, showAuthorLetter, showUpdateNotification, showQixiLaunchPopup, isDataLoaded]);

  // Instant Push 下线通知 — 只对现在开着它的人弹，每天最多一次。
  // 排在 Worker 更新提醒前面：这两条都只找同一批人，而「这功能要没了」比
  // 「去把它更新到最新版」重要，同一天里先说前者。
  const [showInstantPushSunset, setShowInstantPushSunset] = useState(false);
  useEffect(() => {
    if (anniversaryHasPriority || showDisclaimer || showImportRecoveryPrompt || showAuthorLetter || showUpdateNotification || showQixiLaunchPopup || showLike520Popup) return;
    if (!isDataLoaded) return;
    if (shouldShowInstantPushSunsetNotice()) setShowInstantPushSunset(true);
  }, [anniversaryHasPriority, showDisclaimer, showImportRecoveryPrompt, showAuthorLetter, showUpdateNotification, showQixiLaunchPopup, showLike520Popup, isDataLoaded]);

  // Worker 后端更新提醒 — 只对启用了 Instant Push 的用户弹，且当前 worker 版本未确认过
  const [showWorkerUpdateReminder, setShowWorkerUpdateReminder] = useState(false);
  useEffect(() => {
    if (anniversaryHasPriority || showDisclaimer || showImportRecoveryPrompt || showAuthorLetter || showUpdateNotification || showQixiLaunchPopup || showLike520Popup || showInstantPushSunset) return;
    if (!isDataLoaded) return;
    if (shouldShowWorkerUpdateReminder()) setShowWorkerUpdateReminder(true);
  }, [anniversaryHasPriority, showDisclaimer, showImportRecoveryPrompt, showAuthorLetter, showUpdateNotification, showQixiLaunchPopup, showLike520Popup, showInstantPushSunset, isDataLoaded]);

  // 部署漂移自检：启动后异步 GET {workerUrl}/version（每 24h 最多一次）。
  // 常量比对只能发现「前端更新了」，发现不了「用户 seen 过但实际没部署 / 部署的是更老的包」——
  // 前端托管自动更新、worker 停在用户上次贴代码那天，这种漂移正是 instant 各类
  // 「时灵时不灵」反馈的温床。确认 worker 有应答且版本不对（reachable && !ok）才重新
  // 武装提醒；网络不通/没配不算数，贪睡窗口照常生效，不会轰炸。
  useEffect(() => {
    if (!isDataLoaded) return;
    const cfg = loadInstantConfig();
    if (!cfg.enabled || !cfg.workerUrl) return;
    const PROBE_AT_KEY = 'sullyos_worker_version_probe_at';
    try {
      const last = Number(localStorage.getItem(PROBE_AT_KEY) || 0);
      if (Date.now() - last < 86_400_000) return;
    } catch { /* ignore */ }
    void probeInstantWorkerVersion(cfg).then((r) => {
      try { localStorage.setItem(PROBE_AT_KEY, String(Date.now())); } catch { /* ignore */ }
      if (!r.ok && r.reachable) {
        rearmWorkerUpdateReminder();
        if (shouldShowWorkerUpdateReminder()) setShowWorkerUpdateReminder(true);
      }
    }).catch(() => { /* 探测失败不打扰 */ });
  }, [isDataLoaded]);

  // 「该备份啦」提醒 — local-first 数据只在本机，隔 N 天（默认 7，可在设置里改）没导出就弹一次
  const [showBackupReminder, setShowBackupReminder] = useState(false);
  useEffect(() => {
    if (anniversaryHasPriority || showDisclaimer || showImportRecoveryPrompt || showAuthorLetter || showUpdateNotification || showQixiLaunchPopup || showLike520Popup || showInstantPushSunset || showWorkerUpdateReminder) return;
    if (!isDataLoaded || isLocked) return;
    if (shouldShowBackupReminder()) {
      setShowBackupReminder(true);
      // 只报「从未备份 / 已过期」这一个二选一，不报具体天数、也不报用户设的提醒间隔。
      trackEvent('弹出该备份啦提醒', { state: daysSinceLastBackup() == null ? '从未备份' : '已过期' });
    }
  }, [anniversaryHasPriority, showDisclaimer, showImportRecoveryPrompt, showAuthorLetter, showUpdateNotification, showQixiLaunchPopup, showLike520Popup, showInstantPushSunset, showWorkerUpdateReminder, isDataLoaded, isLocked]);

  const dismissBackupReminder = () => {
    markBackupReminderShown();
    setShowBackupReminder(false);
    trackEvent('点知道了稍后再说');
  };
  const goBackupFromReminder = () => {
    markBackupReminderShown();
    setShowBackupReminder(false);
    openApp(AppID.Settings);
    trackEvent('点立即备份');
  };

  // Web browsers normally interpret an edge-swipe/back shortcut as leaving SullyOS.
  // While an app is open, keep one same-page history entry and translate that pop
  // into the same layered back action used by the native Android button. Nested
  // views may push their own entries above this one; landing back on our guard must
  // therefore not consume a second in-app layer.
  useEffect(() => {
    if (typeof window === 'undefined' || Capacitor.isNativePlatform()) return;

    const guardIsCurrent = isBrowserBackGuardState(window.history.state);
    if (activeApp === AppID.Launcher) {
      if (!guardIsCurrent) return;

      // A nested view can inherit our marker. Unwind every marked same-page entry
      // and stop as soon as the original browser entry is current again.
      let disposed = false;
      const releaseGuardEntries = () => {
        if (disposed || !isBrowserBackGuardState(window.history.state)) return;
        try { window.history.back(); } catch { /* leave browser history untouched */ }
      };
      window.addEventListener('popstate', releaseGuardEntries);
      releaseGuardEntries();
      return () => {
        disposed = true;
        window.removeEventListener('popstate', releaseGuardEntries);
      };
    }

    const armGuard = () => {
      try {
        window.history.pushState(
          makeBrowserBackGuardState(window.history.state),
          '',
          window.location.href,
        );
        return true;
      } catch {
        return false;
      }
    };

    if (!guardIsCurrent && !armGuard()) return;

    const onPopState = (event: PopStateEvent) => {
      // A nested panel was above the SullyOS guard and handled this back itself.
      if (isBrowserBackGuardState(event.state)) return;

      // Re-arm before navigating inside the OS so another quick swipe is safe too.
      armGuard();
      handleBack();
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [activeApp, handleBack]);

  // Capacitor Native Handling
  useEffect(() => {
    const initNative = async () => {
        if (Capacitor.isNativePlatform()) {
            try {
                await CapStatusBar.setOverlaysWebView({ overlay: true });
                await CapStatusBar.hide();
                await CapStatusBar.setStyle({ style: StatusBarStyle.Dark });

                const permStatus = await LocalNotifications.checkPermissions();
                if (permStatus.display !== 'granted') {
                    await LocalNotifications.requestPermissions();
                }
            } catch (e) {
                console.error("Native init failed", e);
            }
        }
    };
    initNative();

    // Handle Android Hardware Back Button
    const setupBackButton = async () => {
        if (Capacitor.isNativePlatform()) {
            try {
                await CapApp.removeAllListeners();
                CapApp.addListener('backButton', ({ canGoBack }) => {
                    if (isLocked) {
                        CapApp.exitApp();
                    } else {
                        handleBack(); // Delegate to OSContext logic
                    }
                });
            } catch (e) { console.log('Back button listener setup failed'); }
        }
    };

    setupBackButton();

    return () => {
        if (Capacitor.isNativePlatform()) {
            CapApp.removeAllListeners().catch(() => {});
        }
    };
  }, [activeApp, isLocked, closeApp, handleBack]);

  // Force scroll to top when app changes to prevent "push up" glitches on iOS
  useEffect(() => {
      window.scrollTo(0, 0);
  }, [activeApp]);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const wallpaper = theme.wallpaper;
    const backgroundValue = !wallpaper
      ? '#0f1115'
      : (wallpaper.startsWith('http') || wallpaper.startsWith('data:') || wallpaper.startsWith('blob:') || wallpaper.startsWith('./') || wallpaper.startsWith('/'))
        ? `url(${wallpaper})`
        : wallpaper;

    [document.documentElement, document.body].forEach((element) => {
      element.style.background = backgroundValue;
      element.style.backgroundPosition = 'center';
      element.style.backgroundSize = 'cover';
      element.style.backgroundRepeat = 'no-repeat';
    });
  }, [theme.wallpaper]);

  // 冷启动：先放「世界入场」cinematic（数据没就绪时它持续呼吸等待，绝不出现 spinner）。
  // BootSequence 在「数据就绪 + 停留够时长」后推进退场，再交还控制权给下方的锁屏/桌面。
  if (!bootDone && bootAnimationEnabled) {
    return <BootSequence dataReady={isDataLoaded} wallpaper={theme.wallpaper} style={theme.bootAnimationStyle} onDone={() => setBootDone(true)} />;
  }

  // 兜底：理论上 bootDone 时数据已就绪；万一未就绪（极端慢）退化为最简静态深色屏，不闪 spinner。
  if (!isDataLoaded) {
    return <div className="w-full h-full" style={{ background: '#05060f' }} />;
  }

  const getBgStyle = (wp: string) => {
      const isUrl = wp.startsWith('http') || wp.startsWith('data:') || wp.startsWith('blob:') || wp.startsWith('./') || wp.startsWith('/');
      return isUrl ? `url(${wp})` : wp;
  };

  const bgImageValue = getBgStyle(theme.wallpaper);
  const lockBgImageValue = getBgStyle(theme.lockWallpaper || theme.wallpaper);
  const contentColor = theme.contentColor || '#ffffff';
  const acnhSkin = theme.skin === 'animalcrossing'; // 动森彩蛋：锁屏换暖色草地点缀
  const storedCompanionFrame = theme.skin === 'companion' ? loadCompanionFrameStyle() : null;
  const companionLockFrame = storedCompanionFrame;

  if (isLocked) {
    const unreadCount = Object.values(unreadMessages).reduce((a,b) => a+b, 0);
    const unreadCharId = Object.keys(unreadMessages)[0];
    const unreadChar = unreadCharId ? characters.find(c => c.id === unreadCharId) : null;
    const lockCharacter = characters.find(c => c.id === activeCharacterId) || characters[0] || null;

        return (
      <div 
        onClick={() => {
            // Only ask once when permission is still undecided; don't keep poking blocked/denied browsers.
            if ('Notification' in window && Notification.permission === 'default') {
                Notification.requestPermission();
            }
            unlock();
        }}
        className="relative w-full h-full bg-cover bg-center cursor-pointer overflow-hidden group font-light select-none overscroll-none"
        style={{ backgroundImage: lockBgImageValue, color: contentColor, animation: 'lockReveal 600ms ease-out both' }}
      >
        {/* 锁屏柔和淡入：与开机「世界入场」退场衔接；body 背景本就是壁纸，故是无缝融入而非硬切。 */}
        <style>{`@keyframes lockReveal{from{opacity:0}to{opacity:1}}`}</style>
        {acnhSkin ? (
            <div className="absolute inset-0 transition-all duration-700 group-hover:opacity-0"
                 style={{ background: 'linear-gradient(180deg, rgba(188,231,245,0.25) 0%, rgba(255,247,176,0.15) 45%, rgba(124,186,76,0.28) 100%)' }} />
        ) : (
            <div className="absolute inset-0 bg-black/5 backdrop-blur-sm transition-all group-hover:backdrop-blur-none group-hover:bg-transparent duration-700" />
        )}

        {/* 动森彩蛋：锁屏飘叶 */}
        {acnhSkin && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                <svg viewBox="0 0 100 100" className="absolute w-14 h-14 opacity-80 -rotate-[25deg]" style={{ left: '10%', top: '12%' }}><path d="M50 8 C78 20 88 50 78 82 C74 92 60 96 50 92 C40 96 26 92 22 82 C12 50 22 20 50 8Z" fill="#9ED25F"/><path d="M50 14 L50 88" stroke="#5c8a30" strokeWidth="3" fill="none" opacity="0.5"/></svg>
                <svg viewBox="0 0 100 100" className="absolute w-12 h-12 opacity-75 rotate-[30deg] scale-x-[-1]" style={{ right: '12%', top: '20%' }}><path d="M50 8 C78 20 88 50 78 82 C74 92 60 96 50 92 C40 96 26 92 22 82 C12 50 22 20 50 8Z" fill="#7CBA4C"/><path d="M50 14 L50 88" stroke="#4d7a2a" strokeWidth="3" fill="none" opacity="0.5"/></svg>
                <svg viewBox="0 0 100 100" className="absolute w-16 h-16 opacity-70 rotate-[12deg]" style={{ left: '16%', bottom: '14%' }}><path d="M50 8 C78 20 88 50 78 82 C74 92 60 96 50 92 C40 96 26 92 22 82 C12 50 22 20 50 8Z" fill="#5FAE6E"/><path d="M50 14 L50 88" stroke="#356b3f" strokeWidth="3" fill="none" opacity="0.5"/></svg>
            </div>
        )}

        {companionLockFrame && (
          <CompanionLockChrome
            variant={companionLockFrame}
            hours={virtualTime.hours}
            minutes={virtualTime.minutes}
            activeCharacter={lockCharacter}
            unreadCharacter={unreadChar}
            unreadCount={unreadCount}
            preserveWallpaper={Boolean(theme.lockWallpaper)}
          />
        )}

        {!companionLockFrame && <div className="absolute top-24 w-full text-center drop-shadow-[0_2px_4px_rgba(0,0,0,0.3)]">
           <div className="text-8xl tracking-tighter opacity-95 font-bold">
             {virtualTime.hours.toString().padStart(2,'0')}<span className="animate-pulse">:</span>{virtualTime.minutes.toString().padStart(2,'0')}
           </div>
           {acnhSkin ? (
               <div className="text-lg tracking-widest opacity-90 mt-2 text-xs font-bold flex items-center justify-center gap-1.5">
                   <span>🍃</span><span>无人岛生活</span><span>🍃</span>
               </div>
           ) : (
               <div className="text-lg tracking-widest opacity-90 mt-2 uppercase text-xs font-bold">SullyOS·糯米机 Simulation</div>
           )}
        </div>}

        {!companionLockFrame && unreadCount > 0 && (
            <div className="absolute top-[40%] left-4 right-4 animate-slide-up">
                <div className="bg-white/20 backdrop-blur-md rounded-2xl p-4 shadow-lg border border-white/10 flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-green-500 flex items-center justify-center text-white shrink-0 shadow-sm">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6"><path fillRule="evenodd" d="M4.804 21.644A6.707 6.707 0 0 0 6 21.75a6.721 6.721 0 0 0 3.583-1.029c.774.182 1.584.279 2.417.279 5.322 0 9.75-3.97 9.75-9 0-5.03-4.428-9-9.75-9s-9.75 3.97-9.75 9c0 2.409 1.025 4.587 2.674 6.192.232.226.277.428.254.543a3.73 3.73 0 0 1-.814 1.686.75.75 0 0 0 .44 1.223ZM8.25 10.875a1.125 1.125 0 1 0 0 2.25 1.125 1.125 0 0 0 0-2.25ZM10.875 12a1.125 1.125 0 1 1 2.25 0 1.125 1.125 0 0 1-2.25 0Zm4.875-1.125a1.125 1.125 0 1 0 0 2.25 1.125 1.125 0 0 0 0-2.25Z" clipRule="evenodd" /></svg>
                    </div>
                    <div className="flex-1 min-w-0 text-white text-left">
                        <div className="font-bold text-sm flex justify-between">
                            <span>{unreadChar ? unreadChar.name : 'Message'}</span>
                            <span className="text-[10px] opacity-70">刚刚</span>
                        </div>
                        <div className="text-xs opacity-90 truncate">
                            {unreadCount > 1 ? `收到 ${unreadCount} 条新消息` : '发来了一条新消息'}
                        </div>
                    </div>
                </div>
            </div>
        )}

        {!companionLockFrame && <div className="absolute bottom-12 w-full flex flex-col items-center gap-3 animate-pulse opacity-80 drop-shadow-md">
          <div className="w-1 h-8 rounded-full bg-gradient-to-b from-transparent to-current"></div>
          <span className="text-[10px] tracking-widest uppercase font-semibold">Tap to Unlock</span>
        </div>}
      </div>
    );
  }

  const renderApp = () => {
    switch (activeApp) {
      case AppID.Settings: return <Settings />;
      case AppID.Character: return <Character />;
      case AppID.Chat: return <Chat />;
      case AppID.GroupChat: return <GroupChat />; 
      case AppID.ThemeMaker: return <ThemeMaker />;
      case AppID.Appearance: return <Appearance />;
      case AppID.Gallery: return <Gallery />;
      case AppID.Date: return <DateApp />; 
      case AppID.User: return <UserApp />;
      case AppID.Journal: return <JournalApp />; 
      case AppID.Schedule: return <ScheduleApp />;
      case AppID.Room: return <RoomApp />; 
      case AppID.CheckPhone: return <CheckPhone />;
      case AppID.Social: return <SocialApp />;
      case AppID.Study: return <StudyApp />; 
      case AppID.FAQ: return <FAQApp />; 
      case AppID.Game: return <GameApp />; 
      case AppID.Worldbook: return <WorldbookApp />;
      case AppID.Novel: return <NovelApp />; 
      case AppID.Bank: return <BankApp />;
      case AppID.XhsStock: return <XhsStockApp />;
      case AppID.XhsFreeRoam: return <XhsFreeRoamApp />;
      case AppID.Browser: return <BrowserApp />;
      case AppID.Songwriting: return <SongwritingApp />;
      case AppID.Music: return <MusicApp />;
      case AppID.Call: return <CallApp />;
      case AppID.VoiceDesigner: return <VoiceDesignerApp />;
      case AppID.Guidebook: return <GuidebookApp />;
      case AppID.LifeSim: return <LifeSimApp />;
      case AppID.MemoryPalace: return <MemoryPalaceApp />;
      case AppID.Handbook: return <HandbookApp />;
      case AppID.QQBridge: return <QQBridge />;
      case AppID.HotNews: return <HotNewsApp />;
      case AppID.SpecialMoments: return <SpecialMomentsApp />;
      case AppID.VRWorld: return <VRWorldApp />;
      case AppID.WorldHome: return <WorldHomeApp />;
      case AppID.CharCreatorDev: return <CharCreatorDevApp />;
      case AppID.Launcher:
      default: return <Launcher />;
    }
  };

  // 安全区策略（方案 B）：自理名单里的 App 已全屏铺底、自己给控件让位，外壳不再加 padding；
  // 其余尚未迁移、靠外壳兜底的 App，仍由外壳用单一来源变量 --safe-* 统一让出安全区，避免顶栏怼进状态栏。
  // 自理名单见 utils/safeAreaApps.ts（迁移一个 App = 把它加进名单 + 顶栏用 --chrome-top 自己让位）。
  // TODO(safe-area-A): 把剩余「未迁移」App 逐个改为自理安全区后，移除外壳这层兜底，实现全屏无色条。
  const shellPadsSafeArea = shellHandlesSafeArea(activeApp);

  return (
    <div className="relative w-full h-full overflow-hidden bg-gradient-to-br from-pink-200 via-purple-200 to-indigo-200 text-slate-900 font-sans select-none overscroll-none">
       {/* Optimized Background Layer */}
       {/* 壁纸底层：进 App 时只柔和虚化/压暗作背景，不再做缩放「过场」——
          进 App 的过渡感统一交给 App 容器的淡入（见下方 animate-fade-in 包裹层）。 */}
       <div
         className="absolute inset-0 bg-cover bg-center transition-all duration-500 ease-[cubic-bezier(0.25,0.1,0.25,1)]"
         style={{
             backgroundImage: bgImageValue,
             filter: activeApp !== AppID.Launcher ? 'blur(10px)' : 'none',
             opacity: activeApp !== AppID.Launcher ? 0.6 : 1,
             backfaceVisibility: 'hidden',
             contain: useIOSStandaloneLayout ? undefined : 'strict'
         }}
       />
       
       <div className={`absolute inset-0 transition-all duration-500 ${activeApp === AppID.Launcher ? 'bg-transparent' : 'bg-white/50 backdrop-blur-3xl'}`} />
       
       {/* 外壳安全区两种策略：
          - 未迁移 App：外壳铺满 body（含 --app-height 多出的 +safe-bottom 溢出区），用 padding 让位安全区，
            内容只画到可见 viewport 内，home 条上方留出 safe-bottom 视觉间隙。
          - 已迁移 App（彼方/聊天/群聊/桌面）：自理安全区。外壳直接把底边收回到可见 viewport
            （bottom = --standalone-safe-area-bottom），不让那多出来的 34px 把 App 底部控件压到 home 条上。 */}
      <div
        className="sully-shell-content absolute top-0 left-0 right-0 z-10 overflow-hidden bg-transparent overscroll-none flex flex-col"
        style={
          shellPadsSafeArea
            ? { bottom: 0, paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }
            : { bottom: 'var(--standalone-safe-area-bottom, 0px)' }
        }
      >
          {/* App Container */}
          <div className="flex-1 relative overflow-hidden" style={{ contain: useIOSStandaloneLayout ? undefined : 'layout style paint' }}>
            <AppErrorBoundary onCloseApp={closeApp} resetKey={`${activeApp}:${activeCharacterId || 'none'}`}>
              <Suspense fallback={<AppLoadingFallback onReturn={closeApp} animationEnabled={theme.appLoadingAnimationEnabled !== false} />}>
                {/* 统一「淡入」过渡：每次切换 App 时 key 变化 → 重新挂载并淡入，
                    让所有 App 都像个人档案那样「渐变进去」，而非瞬间咚一下。
                    关键：只动 opacity、不做 scale/translate —— 否则会把整棵（常含大量头像图片的）
                    App 子树栅格化进 transform 图层，角色列表类 App 首帧会卡顿一下（停顿一秒）。
                    时长也压短，进重 App 时不至于多等。 */}
                <div key={activeApp} className="w-full h-full" style={{ animation: 'appEnterFade 200ms ease-out both' }}>
                  <style>{`@keyframes appEnterFade{from{opacity:0}to{opacity:1}}`}</style>
                  {renderApp()}
                </div>
              </Suspense>
            </AppErrorBoundary>
          </div>

          {/* Overlays: Status Bar (Top) —— 常驻渲染：时钟/电量条由开关+平台默认决定显隐（StatusBar 内部 isStatusBarHidden），
              错误指示器、系统调试终端与开关无关、始终在。 */}
          <StatusBar />
          
          {/* Overlays: Suspended Call Bar */}
          {suspendedCall && activeApp !== AppID.Call && (
            <button
              onClick={resumeCall}
              className="absolute top-7 left-0 w-full z-[55] flex items-center justify-center gap-2 bg-emerald-500 text-white text-xs font-bold py-1.5 animate-pulse cursor-pointer active:bg-emerald-600 transition-colors"
            >
              <span className="w-2 h-2 rounded-full bg-white animate-ping" />
              <span>通话中 · {suspendedCall.charName}</span>
              <span className="opacity-70">点击返回</span>
            </button>
          )}

          {/* Overlays: Global Mini Player (when music is playing in background) */}
          <GlobalMiniPlayer />
          {!isLocked && <SARModuleMonitor />}

          {/* Overlays: 人格模拟生成全局指示条 */}
          <PersonaSimIndicator />

          {/* Overlays: 梦境生成全局指示条 */}
          <DreamSimIndicator />

          {/* Overlays: Toasts (Top) */}
          <div className="absolute top-12 left-0 w-full flex flex-col items-center gap-2 pointer-events-none z-[60]">
              {toasts.map(toast => (
                 <div key={toast.id} className="animate-fade-in bg-white/95 backdrop-blur-xl px-4 py-3 rounded-2xl shadow-xl border border-black/5 flex items-start gap-3 max-w-[85%] ring-1 ring-white/20">
                     {toast.type === 'success' && <div className="w-2.5 h-2.5 rounded-full bg-green-500 shrink-0"></div>}
                     {toast.type === 'error' && <div className="w-2.5 h-2.5 rounded-full bg-red-500 shrink-0"></div>}
                     {toast.type === 'info' && <div className="w-2.5 h-2.5 rounded-full bg-primary shrink-0"></div>}
                     <span className="min-w-0 text-left text-xs font-bold text-slate-800 whitespace-normal break-words [overflow-wrap:anywhere] leading-5">{toast.message}</span>
                 </div>
              ))}
           </div>
       </div>

       {/* Global error dialog (长报错走它, 替代单行 toast) */}
       <ErrorDialog
         isOpen={!!errorDialog}
         title={errorDialog?.title ?? ''}
         details={errorDialog?.details ?? ''}
         onClose={dismissError}
       />

       {/* First-time disclaimer popup */}
       {!anniversaryBlocked && !isLocked && showAnniversaryGift && (
         <AnniversaryGiftPopup onClose={() => {
           markAnniversaryGiftSeen();
           setShowAnniversaryGift(false);
         }} />
       )}
       {showDisclaimer && <DisclaimerPopup onAccept={handleAcceptDisclaimer} />}

       {/* Interrupted import recovery reminder */}
       {!showDisclaimer && showImportRecoveryPrompt && (
         <ImportRecoveryPopup
           marker={importRecoveryMarker}
           onLater={() => {
             setImportRecoveryDismissed(true);
             setImportRecoveryMarker(null);
             trackEvent('点稍后再说放着不管', { kind: importRecoveryMarker?.error ? '失败' : '中断' });
             trackEvent('导入恢复提醒选稍后再说', { 中断阶段: getImportPhaseLabel(importRecoveryMarker?.phase) });
           }}
           onReimport={handleReimportFromRecovery}
         />
       )}

       {/* 见面 · 剧情首映：解锁后一次性出现 */}
       {!anniversaryHasPriority && !showDisclaimer && !showImportRecoveryPrompt && !showAuthorLetter && showUpdateNotification && (
         <UpdateNotificationController onClose={() => setShowUpdateNotification(false)} />
       )}

       {/* 七夕特别活动推送（北京时间 2026-08-19，当天至多出现一次） */}
       {!anniversaryHasPriority && !showDisclaimer && !showImportRecoveryPrompt && !showAuthorLetter && !showUpdateNotification && showQixiLaunchPopup && (
         <QixiLaunchPopup onClose={() => setShowQixiLaunchPopup(false)} />
       )}

       {/* 520 特别活动弹窗（2026-05-20 当天，一次性） */}
       {!anniversaryHasPriority && !showDisclaimer && !showImportRecoveryPrompt && !showAuthorLetter && !showUpdateNotification && !showQixiLaunchPopup && showLike520Popup && (
         <Like520Controller
           onClose={() => setShowLike520Popup(false)}
         />
       )}

       {/* Instant Push 下线通知（仅现在开着它的用户，每天最多一次） */}
       {!anniversaryHasPriority && !showDisclaimer && !showImportRecoveryPrompt && !showAuthorLetter && !showUpdateNotification && !showQixiLaunchPopup && !showLike520Popup && showInstantPushSunset && (
         <InstantPushSunsetController
           onClose={() => setShowInstantPushSunset(false)}
         />
       )}

       {/* Worker 后端更新提醒（仅启用 Instant Push 的用户，每个 worker 版本一次） */}
       {!anniversaryHasPriority && !showDisclaimer && !showImportRecoveryPrompt && !showAuthorLetter && !showUpdateNotification && !showQixiLaunchPopup && !showLike520Popup && !showInstantPushSunset && showWorkerUpdateReminder && (
         <WorkerUpdateReminderController
           onClose={() => setShowWorkerUpdateReminder(false)}
         />
       )}

       {/* 「该备份啦」提醒（local-first 数据只在本机，隔 N 天没导出弹一次） */}
       {!anniversaryHasPriority && !showDisclaimer && !showImportRecoveryPrompt && !showAuthorLetter && !showUpdateNotification && !showQixiLaunchPopup && !showLike520Popup && !showInstantPushSunset && !showWorkerUpdateReminder && showBackupReminder && (
         <BackupReminderController
           onDismiss={dismissBackupReminder}
           onGoBackup={goBackupFromReminder}
         />
       )}
    </div>
  );
};

export default PhoneShell;
