import { INSTALLED_APPS } from '../constants';
import { AppID } from '../types';

export const NAVIGATION_SLOT_APPS = INSTALLED_APPS.filter(app => app.id !== AppID.CharCreatorDev);
export const ROOM_SHORTCUT_MODES = [
  { id: 'room', name: '小小窝', detail: '角色的 2D 房间' },
  { id: 'worldHome', name: '家园', detail: '进入共同生活的世界' },
  { id: 'home3D', name: '拜访 3D', detail: '进入角色的 3D 家园（测试版）' },
] as const;
type Entry = { id: string; name: string; detail: string; target?: 'characters' | 'resources' };
const pages = (...items: [string, string, Entry['target']?][]): Entry[] => items.map(([id, name, target]) => ({ id, name, detail: target === 'characters' ? '继续选择角色' : target === 'resources' ? '继续选择具体内容' : '直接打开这个页面', target }));
/** Only destinations with a matching App receiver belong here. No App modules are imported. */
export const APP_SHORTCUT_ENTRIES: Partial<Record<AppID, Entry[]>> = {
  [AppID.Character]: pages(['identity', '角色设定', 'characters'], ['memory', '记忆', 'characters'], ['impression', '印象', 'characters'], ['plates', '门牌', 'characters'], ['chibi', '手办柜', 'characters'], ['stats', '角色统计', 'characters']),
  [AppID.Date]: pages(['entry', '见面准备', 'characters'], ['settings', '见面设置', 'characters'], ['history', '见面记录', 'characters'], ['story', '剧情剧场']),
  [AppID.Call]: pages(['role-select', '通话准备', 'characters'], ['history', '通话记录']),
  [AppID.CheckPhone]: pages(['home', '手机桌面', 'characters'], ['chat', '聊天记录', 'characters'], ['contacts', '通讯录', 'characters'], ['call', '通话记录', 'characters'], ['taobao', '购物', 'characters'], ['waimai', '外卖', 'characters'], ['social', '朋友圈', 'characters'], ['aiagent', '智能体', 'characters'], ['persona', '人生模拟', 'characters'], ['lifelog', '生活记录', 'characters']),
  [AppID.MemoryPalace]: pages(['palace', '记忆房间', 'characters'], ['pixelHome', '像素家园', 'characters'], ['all', '全部记忆', 'characters'], ['boxes', '记忆盒', 'characters'], ['settings', '角色记忆设置', 'characters'], ['globalSettings', '全局记忆设置']),
  [AppID.Music]: pages(['profile', '我的音乐'], ['search', '搜索音乐'], ['player', '正在播放'], ['visit_char', '角色音乐角落', 'characters'], ['settings', '音乐设置']),
  [AppID.Novel]: pages(['shelf', '书稿', 'resources'], ['library', '角色创作档案', 'characters'], ['create', '新建书稿']),
  [AppID.Songwriting]: pages(['shelf', '乐谱', 'resources'], ['create', '新建乐谱', 'characters']),
  [AppID.Appearance]: pages(['theme', '系统主题'], ['icons', '应用图标'], ['presets', '外观预设'], ['sharing', '外观装扮']),
  [AppID.Bank]: pages(['game', '存钱小屋'], ['manage', '收支管理'], ['report', '统计报告']),
  [AppID.Social]: pages(['home', '动态首页'], ['me', '我的主页']),
  [AppID.Schedule]: pages(['quest', '任务契约'], ['server_events', '纪念日']),
  [AppID.VRWorld]: pages(['world', '世界大厅'], ['library', '图书馆'], ['music', '听歌房'], ['guestbook', '留言簿'], ['gym', '娱乐室'], ['postoffice', '邮局'], ['theater', '剧院'], ['signal', '信号坠落处'], ['sar', 'SAR 活动空间'], ['settings', '接入设置'], ['api', 'API 设置']),
};
export const CHARACTER_SHORTCUT_APPS = [AppID.Chat, AppID.Journal, AppID.Study, AppID.XhsFreeRoam, AppID.Guidebook, AppID.Gallery];
export const RESOURCE_SHORTCUT_APPS = [AppID.GroupChat, AppID.Worldbook];
export const hasShortcutChildren = (appId: AppID) => appId === AppID.Room || !!APP_SHORTCUT_ENTRIES[appId] || CHARACTER_SHORTCUT_APPS.includes(appId) || RESOURCE_SHORTCUT_APPS.includes(appId);
export const getShortcutEntry = (appId: AppID, entryId?: string) => APP_SHORTCUT_ENTRIES[appId]?.find(entry => entry.id === entryId);
export type NavigationShortcut = {
  appId: AppID;
  roomTab?: 'room' | 'worldHome' | 'home3D';
  characterId?: string;
  worldId?: string;
  entryId?: string;
  resourceId?: string;
  /** Display hint only; routing always uses the stable ID. */
  targetName?: string;
};
export type ShortcutCharacter = { id: string; name: string };
export type ShortcutWorld = { id: string; name: string };
export type ShortcutResources = Partial<Record<AppID, readonly ShortcutWorld[]>>;
export const normalizeShortcutSearchText = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
export const shortcutSearchTerms = (query: string) => normalizeShortcutSearchText(query).split(/\s+/).filter(Boolean);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
export function normalizeNavigationShortcut(value: unknown): NavigationShortcut | null {
  const raw: Record<string, unknown> | null = typeof value === 'string' ? { appId: value } : value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const app = NAVIGATION_SLOT_APPS.find(item => item.id === raw?.appId);
  if (!raw || !app) return null;
  const shortcut: NavigationShortcut = { appId: app.id };
  const entry = getShortcutEntry(app.id, typeof raw.entryId === 'string' ? raw.entryId : undefined);
  if (entry) shortcut.entryId = entry.id;
  const mode = ROOM_SHORTCUT_MODES.find(item => item.id === raw.roomTab);
  if (raw.appId === AppID.Room && mode) shortcut.roomTab = mode.id;
  if (raw.appId === AppID.Room && shortcut.roomTab === 'worldHome') {
    if (validId(raw.worldId)) shortcut.worldId = raw.worldId;
  } else if ((raw.appId === AppID.Room && shortcut.roomTab) || CHARACTER_SHORTCUT_APPS.includes(app.id) || entry?.target === 'characters' || (app.id === AppID.Character && !entry)) {
    if (validId(raw.characterId)) shortcut.characterId = raw.characterId;
  }
  if ((RESOURCE_SHORTCUT_APPS.includes(app.id) || entry?.target === 'resources') && validId(raw.resourceId)) shortcut.resourceId = raw.resourceId;
  if ((shortcut.characterId || shortcut.worldId || shortcut.resourceId) && typeof raw.targetName === 'string') shortcut.targetName = raw.targetName.trim().slice(0, 80);
  return shortcut;
}
export function describeNavigationShortcut(shortcut: NavigationShortcut | null, characters: readonly ShortcutCharacter[] = []) {
  const app = NAVIGATION_SLOT_APPS.find(item => item.id === shortcut?.appId);
  if (!shortcut || !app) return { name: '未设置', detail: '选择 App 或具体入口' };
  const mode = ROOM_SHORTCUT_MODES.find(item => item.id === shortcut.roomTab);
  const entry = getShortcutEntry(shortcut.appId, shortcut.entryId);
  const target = shortcut.characterId ? characters.find(item => item.id === shortcut.characterId)?.name || shortcut.targetName || '指定角色'
    : shortcut.worldId || shortcut.resourceId ? shortcut.targetName || '指定内容' : '';
  return { name: target || mode?.name || entry?.name || app.name, detail: [app.name, mode?.name || entry?.name, target].filter(Boolean).filter((part, index, list) => index === 0 || part !== list[index - 1]).join(' › ') };
}
export function matchesShortcutSearch(text: string, query: string) {
  const haystack = normalizeShortcutSearchText(text);
  return shortcutSearchTerms(query).every(part => haystack.includes(part));
}
