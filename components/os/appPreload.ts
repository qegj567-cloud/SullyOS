import { AppID } from '../../types';

type PreloadConnection = {
  saveData?: boolean;
  effectiveType?: string;
};

type PreloadNavigator = {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  connection?: PreloadConnection;
};

/** Low-end / constrained devices keep all bandwidth and CPU for explicit user actions. */
export const shouldUseIdleAppPreload = (
  nav: PreloadNavigator = navigator as Navigator & PreloadNavigator,
): boolean => {
  const connection = nav.connection;
  if (connection?.saveData) return false;
  if (connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g') return false;
  if (typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0 && nav.hardwareConcurrency <= 4) return false;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 && nav.deviceMemory <= 4) return false;
  return true;
};

// AppID → 该 App 代码块的 import 工厂（路径相对本文件 components/os/）。
// 与 PhoneShell 的 lazy 定义指向同一批模块；Vite 按模块 URL 去重，
// 「按下即预取」与「空闲预取/懒加载」共用同一份 chunk，绝不重复下载。
// 新增 App 时若忘记在此登记，仅会少一次按下预取优化，不影响功能（打开时照常懒加载）。
const importers: Partial<Record<AppID, () => Promise<unknown>>> = {
  [AppID.Settings]: () => import('../../apps/Settings'),
  [AppID.Character]: () => import('../../apps/Character'),
  [AppID.Chat]: () => import('../../apps/Chat'),
  [AppID.GroupChat]: () => import('../../apps/GroupChat'),
  [AppID.ThemeMaker]: () => import('../chat/LegacyBubbleMakerEntry'),
  [AppID.Appearance]: () => import('../../apps/Appearance'),
  [AppID.Gallery]: () => import('../../apps/Gallery'),
  [AppID.Date]: () => import('../../apps/DateApp'),
  [AppID.User]: () => import('../../apps/UserApp'),
  [AppID.Journal]: () => import('../../apps/JournalApp'),
  [AppID.Schedule]: () => import('../../apps/ScheduleApp'),
  [AppID.Room]: () => import('../../apps/RoomApp'),
  [AppID.CheckPhone]: () => import('../../apps/CheckPhone'),
  [AppID.FriendFeed]: () => import('../../apps/FriendFeedApp'),
  [AppID.Social]: () => import('../../apps/SocialApp'),
  [AppID.Study]: () => import('../../apps/StudyApp'),
  [AppID.FAQ]: () => import('../../apps/FAQApp'),
  [AppID.Game]: () => import('../../apps/GameApp'),
  [AppID.Worldbook]: () => import('../../apps/WorldbookApp'),
  [AppID.Novel]: () => import('../../apps/NovelApp'),
  [AppID.Bank]: () => import('../../apps/BankApp'),
  [AppID.XhsStock]: () => import('../../apps/XhsStockApp'),
  [AppID.XhsFreeRoam]: () => import('../../apps/XhsFreeRoamApp'),
  [AppID.Browser]: () => import('../../apps/BrowserApp'),
  [AppID.Songwriting]: () => import('../../apps/SongwritingApp'),
  [AppID.Music]: () => import('../../apps/MusicApp'),
  [AppID.Call]: () => import('../../apps/CallApp'),
  [AppID.VoiceDesigner]: () => import('../../apps/VoiceDesignerApp'),
  [AppID.Guidebook]: () => import('../../apps/GuidebookApp'),
  [AppID.LifeSim]: () => import('../../apps/LifeSimApp'),
  [AppID.MemoryPalace]: () => import('../../apps/MemoryPalaceApp'),
  [AppID.Handbook]: () => import('../../apps/HandbookApp'),
  [AppID.QQBridge]: () => import('../../apps/QQBridge'),
  [AppID.HotNews]: () => import('../../apps/HotNewsApp'),
  [AppID.SpecialMoments]: () => import('../ValentineEvent'),
  [AppID.VRWorld]: () => import('../../apps/VRWorldApp'),
  [AppID.CharCreatorDev]: () => import('../../apps/CharCreatorDevApp'),
};

// 已发起预取的 App（去重，避免同一图标多次 pointerdown 重复触发）。
const requested = new Set<AppID>();

// 负载预热挂钩：由 PhoneShell 注入，按 AppID 复用对应 React.lazy 的模块 Promise。
// 解耦放这里是为了让 AppIcon（pointerdown）也能触发，而无需直接依赖 PhoneShell 的 lazy 定义。
let payloadWarmer: ((id: AppID) => Promise<unknown> | undefined) | null = null;
export const setAppPayloadWarmer = (fn: (id: AppID) => Promise<unknown> | undefined): void => { payloadWarmer = fn; };

/**
 * 「按下即预取」：手指刚按到图标（pointerdown，早于 tap 完成约 100ms）即预热该 App。
 * 这里只加载用户正在按下的一个 App，不在冷启动时批量预取。优先复用 PhoneShell 的模块 Promise；
 * 未注入时退化为直接预取 Vite 模块。
 */
export const preloadApp = (id: AppID): void => {
  if (requested.has(id)) return;
  requested.add(id);
  const request = payloadWarmer ? payloadWarmer(id) : importers[id]?.();
  if (!request) {
    requested.delete(id);
    return;
  }
  void request.catch(() => { requested.delete(id); });
};
