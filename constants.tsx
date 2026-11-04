import React from 'react';
import BibiIcon from './components/os/BibiIcon';
import { AppConfig, AppID } from './types';
import {
  UserCircle,
  IdentificationCard,
  ChatTeardrop,
  UsersThree,
  GearSix,
  Images,
  PaintBrush,
  Palette,
  Heart,
  BookOpenText,
  SealCheck,
  House,
  DeviceMobileCamera,
  Fire,
  Books,
  Question,
  GameController,
  Globe,
  PenNib,
  PiggyBank,
  Compass,
  Camera,
  Sparkle,
  GlobeSimple,
  MusicNotes,
  PhoneCall,
  Crosshair,
  Smiley,
  Brain,
  Notebook,
  Plugs,
  Newspaper,
  Planet,
  Wrench,
  HouseLine,
} from '@phosphor-icons/react';

// SVG 图标库 - Phosphor Icons
export const Icons: Record<string, React.FC<{ className?: string }>> = {
  Character: ({ className }) => <UserCircle className={className} weight="regular" />,
  User: ({ className }) => <IdentificationCard className={className} weight="regular" />,
  Chat: ({ className }) => <ChatTeardrop className={className} weight="regular" />,
  GroupChat: ({ className }) => <UsersThree className={className} weight="regular" />,
  Settings: ({ className }) => <GearSix className={className} weight="regular" />,
  Gallery: ({ className }) => <Images className={className} weight="regular" />,
  ThemeMaker: ({ className }) => <PaintBrush className={className} weight="regular" />,
  Appearance: ({ className }) => <Palette className={className} weight="regular" />,
  Date: ({ className }) => <Heart className={className} weight="regular" />,
  Journal: ({ className }) => <BookOpenText className={className} weight="regular" />,
  Schedule: ({ className }) => <SealCheck className={className} weight="regular" />,
  Room: ({ className }) => <House className={className} weight="regular" />,
  CheckPhone: ({ className }) => <DeviceMobileCamera className={className} weight="regular" />,
  FriendFeed: ({ className }) => <BibiIcon variant="line" className={className} />,
  Social: ({ className }) => <Fire className={className} weight="regular" />,
  Study: ({ className }) => <Books className={className} weight="regular" />,
  FAQ: ({ className }) => <Question className={className} weight="regular" />,
  Game: ({ className }) => <GameController className={className} weight="regular" />,
  Worldbook: ({ className }) => <Globe className={className} weight="regular" />,
  Novel: ({ className }) => <PenNib className={className} weight="regular" />,
  Bank: ({ className }) => <PiggyBank className={className} weight="regular" />,
  XhsFreeRoam: ({ className }) => <Compass className={className} weight="regular" />,
  XhsStock: ({ className }) => <Camera className={className} weight="regular" />,
  SpecialMoments: ({ className }) => <Sparkle className={className} weight="regular" />,
  Browser: ({ className }) => <GlobeSimple className={className} weight="regular" />,
  Songwriting: ({ className }) => <MusicNotes className={className} weight="regular" />,
  Music: ({ className }) => <MusicNotes className={className} weight="regular" />,
  Call: ({ className }) => <PhoneCall className={className} weight="regular" />,
  Guidebook: ({ className }) => <Crosshair className={className} weight="regular" />,
  LifeSim: ({ className }) => <Smiley className={className} weight="regular" />,
  MemoryPalace: ({ className }) => <Brain className={className} weight="regular" />,
  Handbook: ({ className }) => <Notebook className={className} weight="regular" />,
  QQBridge: ({ className }) => <Plugs className={className} weight="regular" />,
  HotNews: ({ className }) => <Newspaper className={className} weight="regular" />,
  VRWorld: ({ className }) => <Planet className={className} weight="regular" />,
  CharCreatorDev: ({ className }) => <Wrench className={className} weight="regular" />,
  WorldHome: ({ className }) => <HouseLine className={className} weight="regular" />,
};

export const INSTALLED_APPS: AppConfig[] = [
  { id: AppID.Character, name: '神经链接', icon: 'Character', color: 'indigo' },
  { id: AppID.MemoryPalace, name: '记忆宫殿', icon: 'MemoryPalace', color: 'violet' },
  { id: AppID.Chat, name: 'Message', icon: 'Chat', color: 'green' },
  { id: AppID.Call, name: '电话', icon: 'Call', color: 'emerald' },
  { id: AppID.GroupChat, name: '群聊', icon: 'GroupChat', color: 'violet' },
  { id: AppID.Room, name: '小小窝', icon: 'Room', color: 'rose' },
  // 家园不再做独立桌面图标，改从「小小窝 · 像素家园」里进入（openApp(AppID.WorldHome) 仍可渲染）
  // { id: AppID.WorldHome, name: '家园', icon: 'WorldHome', color: 'emerald' },
  { id: AppID.CheckPhone, name: '查手机', icon: 'CheckPhone', color: 'slate' },
  { id: AppID.FriendFeed, name: '哔哔', icon: 'FriendFeed', color: 'emerald' },
  // { id: AppID.Browser, name: '浏览器', icon: 'Browser', color: 'blue' }, // Hidden
  { id: AppID.Date, name: '见面', icon: 'Date', color: 'pink' },
  { id: AppID.User, name: '档案', icon: 'User', color: 'blue' },
  { id: AppID.Bank, name: '存钱罐', icon: 'Bank', color: 'lime' }, // Hidden
  { id: AppID.Journal, name: '交换日记', icon: 'Journal', color: 'amber' },
  // { id: AppID.Handbook, name: '手账', icon: 'Handbook', color: 'fuchsia' }, // Hidden temporarily, pending update
  { id: AppID.Social, name: 'Spark', icon: 'Social', color: 'red' },
  { id: AppID.Study, name: '自习室', icon: 'Study', color: 'emerald' },
  { id: AppID.Game, name: 'TRPG', icon: 'Game', color: 'orange' },
  { id: AppID.Novel, name: '笔友会', icon: 'Novel', color: 'amber' },
  { id: AppID.Songwriting, name: '写歌', icon: 'Songwriting', color: 'fuchsia' },
  { id: AppID.VRWorld, name: '彼方', icon: 'VRWorld', color: 'indigo' },
  { id: AppID.Schedule, name: '时光契约', icon: 'Schedule', color: 'cyan' },
  { id: AppID.Worldbook, name: '世界书', icon: 'Worldbook', color: 'indigo' },
  { id: AppID.HotNews, name: '热点', icon: 'HotNews', color: 'red' },
  { id: AppID.FAQ, name: '使用帮助', icon: 'FAQ', color: 'indigo' },
  { id: AppID.Gallery, name: '相册', icon: 'Gallery', color: 'orange' },
  { id: AppID.XhsFreeRoam, name: '自由活动', icon: 'XhsFreeRoam', color: 'rose' },
  { id: AppID.XhsStock, name: '小红书图库', icon: 'XhsStock', color: 'red' },
  { id: AppID.Appearance, name: '外观', icon: 'Appearance', color: 'slate' },
  { id: AppID.Settings, name: '设置', icon: 'Settings', color: 'slate' },
  { id: AppID.Guidebook, name: '攻略本', icon: 'Guidebook', color: 'slate' },
  { id: AppID.LifeSim, name: '都市人生', icon: 'LifeSim', color: 'purple' },
  { id: AppID.SpecialMoments, name: '特别时光', icon: 'SpecialMoments', color: 'pink' },
  { id: AppID.Music, name: '音乐', icon: 'Music', color: 'rose' },
  { id: AppID.CharCreatorDev, name: '捏脸·开发', icon: 'CharCreatorDev', color: 'amber' }, // 仅开发模式显示（Launcher 过滤）
  // { id: AppID.QQBridge, name: 'QQ 桥', icon: 'QQBridge', color: 'sky' }, // Hidden temporarily
];

// 桌面上没有图标、但仍能从别处进去的 App。使用统计要靠这份补上中文名——
// 只查 INSTALLED_APPS 的话这些 App 会被静默漏掉（比如「家园」是从小小窝进的）。
export const HIDDEN_APP_NAMES: Partial<Record<AppID, string>> = {
  [AppID.WorldHome]: '家园',
};

export const DOCK_APPS = [AppID.Chat, AppID.GroupChat, AppID.Social, AppID.Settings];
