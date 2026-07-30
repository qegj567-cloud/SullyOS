# SullyOS // Code Wiki

> 「系统提示：你正在阅读一份对源码的考古报告。错误率未知，结构完整。」

本文档对 **SullyOS（手抓糯米机 / aetheros-simulator）** 仓库做结构化梳理，覆盖整体架构、模块职责、关键类与函数、依赖关系以及运行方式。

---

## 目录

1. [项目概述](#1-项目概述)
2. [整体架构](#2-整体架构)
3. [技术栈与依赖](#3-技术栈与依赖)
4. [目录结构](#4-目录结构)
5. [核心模块职责](#5-核心模块职责)
   - 5.1 [应用入口与 OS Context](#51-应用入口与-os-context)
   - 5.2 [应用注册表与桌面系统](#52-应用注册表与桌面系统)
   - 5.3 [IndexedDB 持久化层](#53-indexeddb-持久化层)
   - 5.4 [Prompt 组装与聊天主链路](#54-prompt-组装与聊天主链路)
   - 5.5 [记忆宫殿系统](#55-记忆宫殿系统)
   - 5.6 [Apps 层（30+ 内置应用）](#56-apps-层30-内置应用)
   - 5.7 [Components 层](#57-components-层)
6. [后端与服务端组件](#6-后端与服务端组件)
   - 6.1 [主代理 Cloudflare Worker](#61-主代理-cloudflare-worker)
   - 6.2 [独立 Cloudflare Workers](#62-独立-cloudflare-workers)
   - 6.3 [Netlify Functions（AMSG 服务端）](#63-netlify-functionsamsg-服务端)
   - 6.4 [Vercel Serverless API](#64-vercel-serverless-api)
7. [关键数据流](#7-关键数据流)
8. [构建、测试与部署](#8-构建测试与部署)
9. [本地运行指南](#9-本地运行指南)
10. [关键设计要点](#10-关键设计要点)

---

## 1. 项目概述

**SullyOS** 是一个跑在浏览器里的「虚拟手机操作系统」——本质是一个 React/TypeScript PWA，模拟出完整手机交互（桌面、Dock、APP、状态栏、通知、相册、电话），用户可以在里面创建 AI 角色、与之多模态互动（文字/图片/语音/视频/电话）、并跑各种生活化的小应用。

项目定位要点：

- **Local-first**：所有用户数据（聊天记录、角色设定、图片、世界书、记忆向量）存在浏览器 IndexedDB，**没有任何中心服务器保存用户内容**。
- **角色驱动**：默认内置角色 **Sully**（一只故障风黑客猫猫），可被替换/删除。所有 App 围绕「装进一个角色 → 用它玩各种功能」展开。
- **多通道 AI 交互**：常规 fetch、流式 SSE、Web Push（主动消息 / Instant Push）、语音通话（TTS）、群聊多角色。
- **可自托管**：联网能力走可独立部署的 Cloudflare Worker + Netlify Functions + Vercel API，二改者必须换成自己的实例。
- **跨平台打包**：同一份 web 构建产物可发布到 GitHub Pages / Netlify / Vercel / Cloudflare Pages，也可用 Capacitor 打包成 Android/iOS App。

---

## 2. 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                  浏览器（PWA / Capacitor 壳）                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │   React UI（apps/ + components/）                         │   │
│  │      │                                                     │   │
│  │      ▼                                                     │   │
│  │   OSContext（context/OSContext.tsx）全局状态                │   │
│  │      │                                                     │   │
│  │      ▼                                                     │   │
│  │   ContextBuilder + ChatPrompts 组装 Prompt                 │   │
│  │      │                                                     │   │
│  │      ▼                                                     │   │
│  │   useChatAI Hook 调用 LLM → ChatParser 执行副作用           │   │
│  │      │                                                     │   │
│  │      ▼                                                     │   │
│  │   记忆宫殿 utils/memoryPalace/（向量化长期记忆）             │   │
│  │      │                                                     │   │
│  │      ▼                                                     │   │
│  │   utils/db.ts  ──→  IndexedDB（52 个 object store）         │   │
│  └──────────────────────────────────────────────────────────┘   │
│              │  联网能力走代理                                   │
└──────────────┼─────────────────────────────────────────────────┘
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  服务端组件（用户自托管，互不耦合）                                 │
│                                                                  │
│  ① 主代理 worker/index.js  （CF Worker，单文件）                  │
│     搜索 / WebDAV / GitHub / 网页抓取 / Notion / 飞书 / 小红书     │
│     FishAudio TTS / 网易云 / MCP 点单                             │
│                                                                  │
│  ② 独立 Workers（各自部署）：                                      │
│     • instant-push      主动消息→Web Push                         │
│     • proactive-push    定时唤醒浏览器                             │
│     • post-office       彼方漂流信 / 接龙诗（跨用户共享）           │
│     • loyal-recruitment 一次性活动后端                             │
│     • mcp-proxy         MCP CORS 透传                             │
│                                                                  │
│  ③ Netlify Functions  —— AMSG（ReiStandard）主动消息服务端         │
│     init-tenant / schedule-message / send-notifications …        │
│                                                                  │
│  ④ Vercel API（api/）—— MiniMax / FishAudio TTS 代理              │
└──────────────────────────────────────────────────────────────────┘
```

### 数据流总览

```
用户操作 → OSContext（全局状态）→ IndexedDB（持久化）
                  ↓
            Chat/App 组件读取
                  ↓
          ContextBuilder.buildCoreContext() 组装 Prompt
                  ↓
            useChatAI 调用 LLM API
                  ↓
        ChatParser 解析响应 + 执行副作用（戳一戳/转账/音乐/事件…）
                  ↓
        processNewMessages → 记忆宫殿向量化、巩固、消化
```

---

## 3. 技术栈与依赖

### 运行时依赖（`package.json` dependencies）

| 依赖 | 用途 |
|------|------|
| `react` / `react-dom` (^18.2.0) | UI 框架 |
| `vite` (^5.0.10) + `@vitejs/plugin-react` | 构建工具 |
| `typescript` (^5.3.3) | 类型系统（`strict: true`，`target: ES2020`） |
| `@phosphor-icons/react` | 图标库（桌面 App 图标） |
| `@capacitor/*` (^6.0.0) | 打包成 Android/iOS 原生 App（含 filesystem/geolocation/local-notifications/share/status-bar/keyboard/speech-recognition） |
| `@rei-standard/amsg-*` | 主动消息 / Instant Push / Web Push 协议族（client 2.7.0 / instant 0.9.1 / server 2.5.1 / shared 0.2.0 / sw 2.3.1） |
| `web-push` (^3.6.7) | VAPID + Web Push 协议实现 |
| `jszip` (^3.10.1) | 导出/导入 zip 备份包 |
| `qrcode` (^1.5.4) | 二维码生成（QQ 桥接、点单等） |
| `ag-psd` (^31.0.2) | 解析 PSD 文件，捏脸系统导入 Photoshop 分层素材 |
| `pg` / `@neondatabase/serverless` | 记忆宫殿向量可选同步到 Postgres / Neon |
| `@netlify/blobs` / `@netlify/functions` | Netlify AMSG 服务端存储与函数 |

### 开发依赖

- `vitest` (^2.1.9) + `fake-indexeddb` (^6.2.5) — 单元测试（环境 `node`，无 jsdom；测试集中在 `utils/**/*.test.ts`、`worker/**/*.test.ts`）
- `esbuild` (^0.21.5) — 构建 Worker bundle
- `@types/react` / `@types/react-dom` / `@types/qrcode`

### 包管理

- 使用 **pnpm**（`pnpm-lock.yaml` + `pnpm-workspace.yaml`）
- `package.json` 的 `"type": "module"` — 全 ESM

---

## 4. 目录结构

```
/workspace
├── App.tsx                  # 应用根组件（OSProvider + PhoneShell + 全局浮层）
├── index.tsx                # ReactDOM 入口（注册 SW / 恢复主动消息 / 安装护栏）
├── index.html               # HTML 模板（importmap 引入 pdfjs / katex）
├── constants.tsx            # INSTALLED_APPS 注册表 + 图标映射
├── types.ts                 # 全局类型定义（1500+ 行，含 AppID 枚举）
├── capacitor.config.json    # Android 打包配置（com.aetheros.simulator）
├── vite.config.ts           # Vite 构建配置（dev proxy + 构建 badge 注入）
├── vitest.config.ts         # 测试配置
├── tsconfig.json            # TS 配置（strict, bundler resolution, noEmit）
├── netlify.toml             # Netlify Functions 部署
├── vercel.json              # Vercel 部署（SPA rewrite + api/）
│
├── apps/                    # 30+ 内置应用（每个 App 一个 .tsx）
│   ├── lifesim/             # 都市人生（模拟人生玩法）
│   ├── music/               # 网易云音乐客户端
│   ├── pixelHome/           # 像素家园（3DS 双屏 RPG）
│   └── theater/             # 剧院
│
├── components/              # 可复用组件（按业务域分子目录）
│   ├── chat/                # 聊天 UI（消息项、输入、HTML 卡片）
│   ├── character/           # 角色卡 / ChibiStudio / 印象面板
│   ├── bank/                # 存钱罐
│   ├── handbook/            # 手账
│   ├── luckin/ mcd/         # 点单小程序
│   ├── os/                  # 系统级（状态栏、错误边界、BootSequence）
│   ├── schedule/            # 日程卡片 / 剧院播放器
│   ├── settings/            # 设置面板组件
│   └── ...
│
├── context/                 # React Context
│   ├── OSContext.tsx        # 全局状态（219KB，4300 行）
│   └── MusicContext.tsx     # 音乐播放器全局状态
│
├── hooks/                   # 自定义 Hook
│   ├── useChatAI.ts         # 聊天主链路（调 LLM、解析、记忆、情绪）
│   ├── useIncrementalReveal.ts
│   └── useLocalDateKey.ts
│
├── utils/                   # 业务工具与核心逻辑（200+ 文件）
│   ├── memoryPalace/        # 记忆宫殿子系统（向量化长期记忆）
│   ├── groupChat/           # 群聊调度、解析、红包、主题、时间线
│   ├── vrWorld/             # 彼方虚拟世界（小说/邮局/信号/剧院）
│   ├── worldHome/           # 家园（多角色共居世界引擎）
│   ├── db.ts                # IndexedDB 封装（52 个 store、140+ 方法）
│   ├── context.ts           # ContextBuilder（统一 Prompt 组装）
│   ├── chatPrompts.ts       # ChatPrompts（三段式 prompt 架构）
│   ├── chatParser.ts        # ChatParser（解析 LLM 输出 + 执行副作用）
│   ├── chatRequestPayload.ts
│   ├── safeApi.ts           # 安全 fetch（带 SSE / 工具调用兼容）
│   ├── blobRef.ts           # Blob 引用（图片二进制存储省 1/3 空间）
│   ├── backupFormat.ts      # v2 备份格式
│   ├── backupExport.ts / backupImportPolicy.ts
│   ├── proactiveChat.ts     # 主动消息（角色定时主动发消息）
│   ├── activeMsgRuntime.ts  # AMSG / Instant Push 运行时
│   ├── instantToolRunner.ts # Instant Push agentic loop 工具执行
│   ├── agenticTools.ts      # 通用 agentic 工具分发
│   ├── ttsProvider.ts / minimaxTts.ts / fishAudioTts.ts / ttsCache.ts / ttsRouter.ts
│   ├── mcpClient.ts / mcpToolBridge.ts        # MCP 客户端
│   ├── xhsMcpClient.ts / luckinMcpClient.ts / mcdMcpClient.ts
│   ├── apiCallLog.ts        # 全局 API 调用日志（保留 5 天）
│   ├── devDebug.ts          # 开发调试面板数据通路
│   └── ...（200+ 个工具文件，多数配有 *.test.ts）
│
├── worker/                  # Cloudflare Workers 源码
│   ├── index.js             # 主代理 Worker（164KB 单文件）
│   ├── instant-push/        # 主动消息 → Web Push
│   ├── proactive-push/      # 定时唤醒
│   ├── post-office/         # 漂流信 + 接龙诗
│   ├── loyal-recruitment/   # 一次性活动
│   ├── mcp-proxy/           # MCP CORS 透传
│   ├── xhs-lite/            # 小红书 Lite（已合并进主 worker）
│   └── sw-keep-alive.ts     # 浏览器 Service Worker（保活）
│
├── api/                     # Vercel Serverless Functions
│   ├── fishaudio/tts.ts
│   └── minimax/{t2a,voice-clone,bake-voice,get-voice,upload}.ts
│
├── netlify/functions/       # Netlify Functions（AMSG 服务端）
│   ├── _shared/rei.ts       # ReiServer 工厂 + 多租户 Blob 存储
│   ├── init-tenant.ts
│   ├── get-user-key.ts
│   ├── messages.ts
│   ├── schedule-message.ts
│   ├── update-message.ts
│   ├── cancel-message.ts
│   ├── send-notifications.ts / -background.ts / -scheduled.ts
│   └── webdav-proxy.ts
│
├── cloudflare/              # 主 worker 的源模块（github-handler / webdav-handler）
├── server/                  # bake-voice-middleware（dev 用）
│
├── scripts/                 # 构建/工具脚本
│   ├── build-workers.mjs    # esbuild 打包所有 Worker
│   ├── check-lockfile-links.mjs
│   ├── local-static-server.cjs
│   ├── mcp-proxy.mjs        # 本地 MCP 代理
│   ├── fake-slow-llm.ts     # 模拟慢 LLM 调试用
│   └── xhs-bridge.mjs / patch-xhs-publish.py / start-xhs.bat
│
├── public/                  # 静态资源
│   ├── manifest.webmanifest # PWA manifest
│   ├── changelogs/          # HTML 更新日志
│   ├── pixel-char/          # 像素角色素材
│   ├── room-templates/      # 房间模板
│   └── ...
│
├── docs/                    # 设计文档（.md）
├── notes/                   # 开发笔记
├── pics/                    # 房屋图片
├── pixelroom/               # 像素房间素材
├── icons/                   # PWA 图标
├── .github/workflows/       # CI（deploy-pages / pr-labeler / lockfile-guard / on-close-cleanup）
└── 更新日志/                 # HTML 更新日志
```

---

## 5. 核心模块职责

### 5.1 应用入口与 OS Context

#### `index.tsx` — 应用引导

应用启动时按顺序做四件事：

1. `KeepAlive.init()` — 注册保活 Service Worker（让主动消息能在后台到达）
2. SW 就绪后并行恢复：
   - `ProactiveChat.resume()` — 恢复主动消息调度
   - `VRScheduler.resume()` — 恢复「彼方」自主登入调度
   - `ActiveMsgRuntime.init()` — 初始化 AMSG / Instant Push 通道
   - `installWakeListener()` — 记录每次 wake 供诊断面板展示
3. `installIOSStandaloneWorkaround()` — iOS PWA standalone 模式适配
4. `installTranslateCrashGuard()` — 浏览器自动翻译护栏（防止 Chrome/Edge 自动翻译改动 React 托管的 DOM 导致白屏）
5. 最后 `ReactDOM.createRoot(...).render(<App />)`

#### `App.tsx` — 根组件

```tsx
<OSProvider>
  <MusicProvider>
    <PhoneShell />
  </MusicProvider>
</OSProvider>
<BuildBadge />        {/* 构建版本浮标（仅非 release 分支） */}
<DevDebugPanel />     {/* 开发调试浮球（仅非 release 分支） */}
<VRBroadcast />       {/* 彼方活动卡片广播 */}
<WorldBroadcast />    {/* 家园活动卡片广播 */}
<ChatBroadcast />     {/* 聊天活动卡片广播 */}
```

- iOS standalone 模式下使用 `absolute` 定位壳，普通模式用 `relative`。
- 通过 CSS 变量 `--app-height: 100lvh` 应对移动端地址栏伸缩。

#### `context/OSContext.tsx` — 全局状态（219KB / 4300 行）

**核心导出**：
- `OSProvider` — Context Provider 组件
- `useOS()` — Consumer Hook，返回 `OSContextType`

**全局状态分组**（`OSContextType` 接口，约 150 个字段/方法）：

| 分组 | 关键字段 |
|------|---------|
| **App 壳** | `activeApp`、`openApp(id)`、`closeApp`、`isLocked`、`unlock`、`isDataLoaded` |
| **主题** | `theme: OSTheme`、`customThemes`、`appearancePresets`、`customIcons`、`resetAppearance` |
| **时间** | `virtualTime`（每秒刷新） |
| **API 配置** | `apiConfig: {baseUrl, apiKey, model, stream, temperature, minimaxApiKey...}`、`apiPresets`、`availableModels` |
| **角色** | `characters: CharacterProfile[]`、`activeCharacterId`、`addCharacter`、`updateCharacter`、`deleteCharacter`、`characterGroups`（神经链接文件夹） |
| **群聊 / 世界书 / 小说 / 歌曲** | 各自完整 CRUD 数组 |
| **用户档案** | `userProfile`、`updateUserProfile` |
| **实时配置** | `realtimeConfig`（天气/新闻/Notion/飞书开关与密钥） |
| **记忆宫殿配置** | `memoryPalaceConfig`（跨角色共享）、`remoteVectorConfig`（Supabase pgvector）、`syncEmotionApiToAllCharacters` |
| **Toast / 错误** | `toasts`、`addToast`、`errorDialog`、`showError` |
| **消息信号** | `lastMsgTimestamp`、`unreadMessages`、`proactiveComposingChars`（哪些角色正在生成主动消息） |
| **云备份** | `cloudBackupConfig`、`cloudBackupToWebDAV`、`cloudRestoreFromWebDAV`、`listCloudBackups` |
| **系统操作** | `exportSystem(mode)`、`importSystem(fileOrJson)`、`resetSystem`、`sysOperation: {status, message, progress}` |
| **导航** | `registerBackHandler`、`handleBack` |
| **通话挂起** | `suspendedCall`、`suspendCall`、`resumeCall` |
| **约会自动启动** | `dateAutoStartCharId`、`openDateWithChar`、`consumeDateAutoStart` |

**Provider 内部关键 effects**：
- 启动时 fire-and-forget 扫描，把旧的 `number[]` 向量迁移到紧凑 `Uint8Array`（通过 `MemoryVectorDB.scanAndMigrateLegacy`），并 toast 进度。
- 每秒更新 `virtualTime`。

**角色 CRUD 要点**：
- `addCharacter` 创建带默认 `contextLimit`、`contextRangeMode: 'manual'`、`emotionConfig: {enabled: true}` 的角色（**不**自动开启 `memoryPalaceEnabled`，需用户显式开启）。
- `deleteCharacter` 会调用 `DB.cleanupEmojiResidue(remainingIds)` 清理孤立的角色专属 emoji 分类。

**备份/恢复**：
- `exportSystem(mode)` 使用 JSZip；`text_only` 模式通过 `stripBase64` 移除所有 `data:image` 与 blobref token；`media_only`/`full` 把图片提取到去重的 `assets/` 目录。
- `importSystem` 支持 File 或 JSON 字符串，跟踪 `restoredAssetFiles/totalAssetFiles` 多行进度，写入 `IMPORT_IN_PROGRESS_KEY` localStorage 标记用于崩溃恢复。
- `resetSystem` = `DB.deleteDB()` + `localStorage.clear()` + reload。

---

### 5.2 应用注册表与桌面系统

#### `types.ts` — `AppID` 枚举

```typescript
export enum AppID {
  Launcher = 'launcher',
  Settings = 'settings',
  Character = 'character',          // 神经链接
  Chat = 'chat',                    // Message
  GroupChat = 'group_chat',
  Gallery = 'gallery',
  Music = 'music',
  Browser = 'browser',
  ThemeMaker = 'thememaker',        // 气泡工坊
  Appearance = 'appearance',
  Date = 'date',                    // 见面
  User = 'user',                    // 档案
  Journal = 'journal',              // 交换日记
  Schedule = 'schedule',            // 时光契约
  Room = 'room',                    // 小小窝
  CheckPhone = 'check_phone',       // 查手机
  Social = 'social',                // Spark
  Study = 'study',                  // 自习室
  FAQ = 'faq',
  Game = 'game',                    // TRPG
  Worldbook = 'worldbook',
  Novel = 'novel',                  // 笔友会
  Bank = 'bank',                    // 存钱罐
  XhsStock = 'xhs_stock',           // 小红书图库
  SpecialMoments = 'special_moments',
  XhsFreeRoam = 'xhs_free_roam',    // 自由活动
  Songwriting = 'songwriting',      // 写歌
  Call = 'call',                    // 电话
  VoiceDesigner = 'voice_designer', // 捏声音
  Guidebook = 'guidebook',          // 攻略本
  LifeSim = 'lifesim',              // 都市人生
  MemoryPalace = 'memory_palace',
  Handbook = 'handbook',            // 手账
  QQBridge = 'qq_bridge',
  HotNews = 'hot_news',             // 热点
  VRWorld = 'vrworld',              // 彼方
  CharCreatorDev = 'char_creator_dev',
  WorldHome = 'world_home',         // 家园
}
```

`types.ts` 还定义了 **150+ 个接口**，覆盖：`SystemLog`、`AppConfig`、`DesktopDecoration`、`OSTheme`、`APIConfig`、`InstantPushConfig`、`ActiveMsg2*Config`、`RealtimeConfig`、`HotNewsSnapshot`、`MemoryFragment`、`RoomItem`、`UserImpression`、`ChatTheme`、`PhoneEvidence`、`AiSession`、`SimScript`、`DreamScript`、`Worldbook`、`NovelBook`、`VRWorldNovel`、`WorldProfile`、`WorldEpisode` 等。

#### `constants.tsx` — 应用注册表

- `Icons: Record<string, React.FC>` — Phosphor Icons 映射
- `INSTALLED_APPS: AppConfig[]` — 桌面显示的 App 列表（id + 名称 + 图标 key + 颜色）
- `DOCK_APPS = [Chat, GroupChat, Social, Settings]` — 底部 Dock 固定 4 个

**添加新 App 的 5 步**（README 记录）：
1. 在 `apps/` 新建 `YourApp.tsx`
2. 在 `types.ts` 的 `AppID` 枚举加 ID
3. 在 `constants.tsx` 的 `INSTALLED_APPS` 注册
4. 在 `App.tsx` 的 `renderApp()` 加 case
5. 完事

---

### 5.3 IndexedDB 持久化层

#### `utils/db.ts` — 数据库封装（156KB）

**常量**：
- `DB_NAME = 'AetherOS_Data'`
- `DB_VERSION = 68`（升级时建表走幂等的 `if(!contains)`）

**52 个 Object Store**（按业务域分组）：

| 业务域 | Store |
|--------|-------|
| 角色与分组 | `characters`、`character_groups`（神经链接文件夹，与群聊 groups 不同）、`groups`（群聊） |
| 消息 | `messages`（带 `charId`、`charId_type` 索引） |
| 表情 | `emojis`、`emoji_categories` |
| 主题/资源 | `themes`、`assets`（base64/指针）、`blob_assets`（**二进制 Blob**，比 base64 省 ~33% 空间，不占 JS 堆） |
| 定时消息 | `scheduled_messages` |
| 画廊/社交 | `gallery`、`social_posts`、`journal_stickers` |
| 用户内容 | `user_profile`、`diaries`、`tasks`、`anniversaries` |
| 房间 | `room_todos`、`room_notes` |
| 日程 | `daily_schedule` |
| 热点 | `hotnews_snapshots`（全角色共享，key=`日期#时段`） |
| 手账 | `handbook`（跨角色每日一条，id=`YYYY-MM-DD`）、`trackers`、`tracker_entries` |
| 生活记录 | `life_records`、`med_plans`、`life_record_settings` |
| 学习/游戏 | `courses`、`games`、`quizzes`、`guidebook` |
| 世界书/小说/歌曲 | `worldbooks`、`novels`、`songs` |
| 银行 | `bank_transactions`、`bank_data` |
| 小红书 | `xhs_stock`、`xhs_activities` |
| 都市人生 | `life_sim` |
| **记忆宫殿** | `memory_nodes`、`memory_vectors`、`memory_links`、`memory_batches`、`topic_boxes`、`anticipations`、`event_boxes`、`room_plates`、`digest_reports` |
| **彼方 VR** | `vr_novels`、`vr_annotations`、`vr_music`、`vr_guestbook`、`vr_scripts`、`vr_plays`、`vr_presets`、`vr_letters`、`vr_settings`、`api_call_log` |
| 捏脸/家园 | `cc_custom_parts`、`worlds`、`world_episodes` |
| 生活记录 | `life_records`、`med_plans`、`life_record_settings` |

**核心导出**：
- `openDB()` — 单例 `dbPromise`，懒初始化
- `DB` 对象 — **140+ async 方法**，按域分组
- `ScheduledMessage` 接口
- `exportFullData()` — 聚合所有 store 返回 `Partial<FullBackupData>`
- `importFullData(...)` — 从备份对象恢复

**关键方法分组**：

1. **DB 生命周期**：`deleteDB`（先关闭单例连接避免 blocked）
2. **角色**：`getAllCharacters`、`saveCharacter`（**await `transaction.oncomplete`** 防止读后写竞态——修复了 emotion buff 落地竞态 bug）、`deleteCharacter`、`getCharacterGroups`、`saveCharacterGroup`、`deleteCharacterGroup`
3. **消息**：`getMessagesByCharId`（默认过滤掉低于 `mp_lastMsgId_${charId}` 高水位线的消息，传 `includeProcessed=true` 才返回全部）、`getRecentMessagesByCharId`（反向游标 + limit）、`getVRCardsByCharId`（用 `[charId, type]` 复合索引，O(卡片数) 而非 O(总历史)）、`saveMessage`、`updateMessageMetadata`（updater 函数式更新）
4. **群聊**：`getGroups`、`saveGroup`、`getGroupMessages`、`getRecentGroupMessagesWithCount`
5. **表情**：`getEmojis`、`saveEmoji`、`getEmojiCategories`、`cleanupEmojiResidue`（清理孤立的角色专属分类）、`initializeEmojiData`（含内置 Sully 表情包预设）
6. **资源**：`getAsset`/`saveAsset`（base64）、`getBlobAsset`/`putBlobAsset`/`deleteBlobAsset`（Blob 二进制）
7. **记忆宫殿高水位**：`mp_lastMsgId_${charId}` 存在 localStorage，用于过滤「已被记忆宫殿处理」的消息，让 LLM 上下文只看到 palace 处理后的近期聊天 + 向量召回的远期记忆

**实现模式**：
- 大多数写方法 **await `transaction.oncomplete`** 才 resolve
- 用 `db.objectStoreNames.contains(...)` 守护旧库读取
- 重读路径用反向游标 + `collected.length < limit` 守卫，避免加载整个历史

---

### 5.4 Prompt 组装与聊天主链路

聊天主链路由 4 个文件协同完成：`ContextBuilder` → `ChatPrompts` → `useChatAI` → `ChatParser`。

#### `utils/context.ts` — `ContextBuilder`（Memory Central）

> 负责统一构建所有 App 共用的基础角色上下文（System Prompt）。

**导出的方法**：

| 方法 | 用途 |
|------|------|
| `buildRoleSettingsContext(char, options?)` | 仅角色设定+月度记忆（用于情绪评估，不含世界书/印象/用户画像，不截断） |
| `buildCoreContext(char, user, includeDetailedMemories?, memoryPalaceContext?, groupOptions?, timeOptions?, layout?)` | **核心**。组装完整 System Prompt：身份 + 时间感知 + 自我认知 + 世界观 + 世界书 + 用户画像 + 印象档案 + 月度/日度记忆 + 详细记忆 + 行为/语音 |
| `buildTimeAwarenessBlock(char, timeOptions?)` | 当前时间 + 时区 + 距上次联系多久（受 `timeAwarenessEnabled` 控制） |
| `buildVolatileCoreState(char, options?)` | 「每轮都变」的部分：当前时间（分钟精度）、记忆宫殿召回、情绪 buff |
| `buildGroupSharedScene(...)` | 群聊共享场景块（用户画像 + 群成员 + 场景设定） |
| `buildScheduleInjection(...)` | 日程注入 |
| `buildMusicAtmosphere(...)` | 音乐氛围（正在一起听、歌词摘要） |
| `buildMusicActionGuide(isListeningTogether?)` | 音乐动作指南（可用 `[[MUSIC_ACTION:...]]` 标签） |

**`buildCoreContext` 7 大组成段**：

1. **身份 (Identity)** — 名字、用户备注/爱称（明确标注是 user note 防止角色真扮演成动物）、核心性格/指令
2. **时间感知 (Time Awareness)** — 默认开启，纯架空约会场景可关
3. **自我认知 (Self Insights)** — 消化过程中反刍产生的常驻认知
4. **世界观 (Worldview)**
5. **世界书 (Worldbook)** — 通过 `resolveWorldbookEntries` 关键词激活，分 4 段位置插入（角色设定前/后、示例消息前/后）
6. **用户画像 (User Profile)**
7. **私密印象档案 (Private Impression)** — 角色对用户的私密看法，含 MBTI、喜好、情绪波动

**`deferVolatile` 优化**：聊天主路径传 `layout.deferVolatile=true`，把「每轮/每分钟都会变」的三块（时间、记忆宫殿召回、情绪 buff）从 `buildCoreContext` 输出里摘出去，由调用方经 `buildVolatileCoreState` 拿到后放到消息数组末尾。**目的：让 system prompt 前缀稳定，吃到中转的 prompt 前缀缓存（TTFT 直降）**。

#### `utils/chatPrompts.ts` — `ChatPrompts`

**三段式 Prompt 架构**（专为 prompt 缓存设计）：

| 段 | 内容 | 位置 |
|----|------|------|
| `stable` | 人设 + 世界书 + 印象 + 行为 + 语音（跨轮稳定） | 消息数组**第一个** system message |
| `volatileState` | 当前时间（分钟）+ 记忆宫殿召回 + 情绪 buff + 实时天气 + 日程 + 音乐 + 群聊上下文 | 消息数组**末尾**的 system message（吃 recency attention） |
| `recencyTail` | 「关于对方」+「回到自己」的封口 | 模型生成前读到的最后一段 |

**关键导出**：

- `buildSystemPrompt(...)` — 三段拼接的便捷方法
- `buildSystemPromptParts(...)` — 返回 `{stable, volatileState, recencyTail}`。**关键优化**：内部把 7 个独立异步抓取（realtime / schedule / group context / music 等）改成 `Promise.all` 并行，延迟从 sum 降到 max
- `formatDate(ts, tz?)` / `getTimeGapHint(lastMsg, currentTs, tz?)` — 时区感知的时间格式化
- `filterVisibleEmojis(emojis, categories, charId)` — 强制 per-character emoji 可见性（带 `allowedCharacterIds` 的分类限制范围）
- `buildEmojiContext(emojis, categories)` — 分组格式化表情包列表注入 prompt
- `summarizeGroupMsgContent(m)` — 把群消息压成短占位符注入成员私聊（`[图片]`、`[转账${amount}]`），纯文本上限 `GROUP_MSG_TEXT_CAP = 500` 字符，跳过所有 `data:`/`http(s)` URL 防止上下文爆炸

#### `hooks/useChatAI.ts` — 聊天主链路 Hook

> 自定义 React Hook（line 427 导出），编排完整的聊天一轮。

**职责**：

1. 用 `ChatPrompts.buildSystemPromptParts` 组装消息数组
2. 调用 LLM（按 `apiConfig.stream` 支持流式）
3. 路由响应到 `ChatParser.parseAndExecuteActions`
4. 触发记忆宫殿处理 `processNewMessages`（对刚交换的消息）
5. 评估情绪响应（当 `emotionConfig.enabled`）
6. 触发工具集成（MCD 点单、Luckin 等）
7. 导出 `evaluateEmotionBackground` 供 `OSContext` 在主动消息尾段复用

**注意**：`sendMessage` 不在 `OSContext`，而在 `useChatAI`。`OSContext` 只暴露 `lastMsgTimestamp`、`unreadMessages`、`proactiveComposingChars` 供 Chat UI 响应收到的消息。

#### `utils/chatParser.ts` — `ChatParser`

> 解析 LLM 响应内容，执行副作用，返回清洗后的文本。

**单一导出**：`ChatParser.parseAndExecuteActions(aiContent, charId, charName, addToast, musicHooks?, charTz?)`

**处理的动作标签**：

| 标签 | 行为 |
|------|------|
| `[[ACTION:POKE]]` | 保存 `[戳一戳]` 互动消息 |
| `[[TRANSFER:...]]`（via `transferFormat.ts`） | `send` 创建待处理 transfer 消息；`accept`/`return` 调 `resolveUserTransfer` 扫描近期 user transfer 找无 receipt 的，标记 `accepted`/`returned` 并写收据卡。**无待处理 transfer 时不创建收据**（防幻觉记账） |
| `[[MUSIC_ACTION:join\|add\|add_new\|join_and_add\|...]]` | 通过 `MusicActionHooks`（`getListeningSnapshot`、`joinListeningTogether`、`addSongToCharPlaylist`）保存 `music_card` 消息 |
| `[[NEWS_CARD: source\|title]]` | 从最新热点快照取 URL/desc/source，保存 `news_card` |
| `[[ACTION:ADD_EVENT \| title \| date]]` | 保存 anniversary + 系统消息 + toast |
| `[schedule_message \| timeStr \| fixed \| msgContent]` | 在 `charTz` 解析墙上时钟时间，保存 `ScheduledMessage` + 调度 `LocalNotifications` 通知 |
| `[[LIFE:...]]` | 路由到 `executeLifeDirectives`（生理期/药盒/锻炼/记账） |

#### `utils/chatRequestPayload.ts` — 请求体构建

组装发往 LLM endpoint 的请求体：消息数组（system 三段 + history + user）+ model/temperature/stream flags（来自 `APIConfig`）。还处理图片剥离、上下文切换跟踪等。

#### `utils/safeApi.ts` — 安全 fetch

`safeFetchJson` / `safeResponseJson` 等带 SSE 与工具调用兼容的 fetch 封装，统一错误处理、流式升级（`streamUpgrade.ts`）、采样参数兼容（`samplingParamCompat.ts`）。

---

### 5.5 记忆宫殿系统

#### `utils/memoryPalace/` — 向量化长期记忆（生物启发式架构）

**核心理念**：每个角色维护一个「记忆宫殿」，有 7 个主题房间，对应大脑不同区域。聊天记忆被提取、向量化、巩固、并通过混合检索召回。后台「认知消化」周期性处理未解的困惑和期盼。

**7 个房间**（`types.ts`）：

```typescript
export type MemoryRoom =
    | 'living_room'   // 客厅 — 日常闲聊、近期互动（海马体）
    | 'bedroom'       // 卧室 — 亲密情感、深层羁绊（新皮层）
    | 'study'         // 书房 — 工作学习、技能成长（前额叶）
    | 'user_room'     // 用户房间 — 用户个人信息、习惯（颞顶联合区）
    | 'self_room'     // 自我房间 — 角色自我认同、演变（默认模式网络）
    | 'attic'         // 阁楼 — 未消化的困惑、潜意识（杏仁核–海马体）
    | 'windowsill';   // 窗台 — 期盼、目标、憧憬（多巴胺奖赏系统）
```

**`MemoryNode` 关键字段**：`importance`（1–10）、`mood`、Russell-circumplex `valence`/`arousal`、`accessCount`、`pinnedUntil`、`origin`（`extraction`/`digestion`/`system`）、`digestedAt`、`eventBoxId`、`isBoxSummary`。

#### 主要文件与职责

| 文件 | 职责 |
|------|------|
| `index.ts` | Barrel 文件，导出全部公共 API |
| `types.ts` | 类型定义（房间、节点、向量、链接、EventBox、RoomPlate 等） |
| `db.ts` | IndexedDB CRUD 封装。`MemoryNodeDB.save` 做**写验证**（put 后 re-read，失败抛错），并同步 BM25 索引与远程 pgvector |
| `pipeline.ts` | 端到端编排 |
| `consolidation.ts` | 记忆晋升/淘汰 |
| `digestion.ts` | 认知消化状态机 |
| `hybridSearch.ts` | 混合检索（vector + BM25 + spread activation） |
| `vectorSearch.ts` / `bm25Search.ts` / `bm25Index.ts` | 向量/BM25 检索与索引 |
| `embedding.ts` | `getEmbedding` / `getEmbeddings` / `cosineSimilarity`，支持本地或远程 API，可选 Supabase pgvector |
| `rerank.ts` | `rerankDocuments`（cross-encoder 二次排序） |
| `emotionSpace.ts` | Russell-circumplex valence/arousal 管理 |
| `extraction.ts` | `extractMemoriesFromBuffer`（LLM 抽取记忆） |
| `eventBox.ts` / `eventBoxCompression.ts` | 把相关记忆绑定成 EventBox，超阈值压缩 |
| `roomPlates.ts` | 4 个房间的「门牌」蒸馏（user_room/self_room/bedroom/study），稳定语义知识 |
| `anticipation.ts` | 期盼生命周期（fulfill/disappoint/create） |
| `links.ts` | 记忆间链接、`strengthenCoActivated` |
| `priming.ts` | `applyPriming` / `checkRumination` |
| `migration.ts` / `wipe.ts` / `export.ts` | 迁移 / 清空 / 导出导入 |
| `externalMemory.ts` | 外部记忆文本导入 |
| `supabaseVector.ts` / `vectorStore.ts` | 远程向量存储（Supabase pgvector） |
| `vectorSearchWorker.ts` | Web Worker 向量检索（避免阻塞主线程） |
| `dateResolver.ts` / `memoryDate.ts` | 日期解析 |
| `recallReceipts.ts` | 召回回执 |
| `relatedMemories.ts` | 相关记忆推荐 |
| `summaryLengthBudget.ts` / `eventBoxSummaryBudget.test.ts` | 摘要长度预算 |
| `highWaterMark.ts` / `bufferCount.ts` | 高水位线（区分已处理/未处理消息） |
| `memoryRepair.ts` | 记忆修复 |
| `jsonUtils.ts` / `querySanitizer.ts` / `rangeSelection.ts` | 工具 |
| `groupExtraction.ts` / `groupPipeline.ts` | 群聊记忆管线 |

#### 关键导出函数（`index.ts`）

**输入管线**：
- `extractMemoriesFromBuffer` — LLM 抽取
- `vectorizeAndStore` — embed + 写 `MemoryVector`
- `updateStoredMemoryNode` / `checkModelConsistency` / `rebuildAllVectors`

**认知过程**：
- `runConsolidation` — 巩固（应用 `calculateEffectiveImportance`：随年龄衰减、随访问次数加成、按房间权重 `PERSONALITY_WEIGHTS`）
- `shouldPromote` — 决定客厅的情景记忆是否晋升到长期房间
- `buildLinks` / `strengthenCoActivated`

**输出管线**：
- `vectorSearch` — 余弦相似度
- `bm25Search` / `tokenize` — 词法检索
- `hybridSearch` — 加权融合
- `spreadActivation` — 扩散激活
- `applyPriming` / `checkRumination`
- `expandAndFormat` — 格式化注入 prompt

**集成 API**：
- `retrieveMemories(recentMessages, charId, ...)` — 混合检索 top-k 注入 prompt
- `injectMemoryPalace(char, recentMessages?)` — 读取预计算的注入文本（`char.memoryPalaceInjection` / `roomPlatesInjection`）
- `processNewMessages(_allRecentMessages, charId, ...)` — **核心入口**：从高水位线之后的 buffer 抽取记忆，跑完整管线（extract → embed → store → link → consolidate）
- `ingestDiaryToPalace(char, dateStr, ...)` — 日记入宫
- `getMemoryPalaceHighWaterMark(charId)` — 返回「已 palace 处理」与「仍在 buffer」的分界消息 ID
- `getMemoryPalaceUnprocessedBufferCount(charId)` — 待处理消息数
- `processMessageRange(charId, charName, ...)` — 按区间处理（按需处理历史）
- `importExternalMemoryText(rawText, charId, ...)` — 导入外部文本（角色包）

**消化**：
- `runCognitiveDigestion` — **状态机**：阁楼困惑（`resolve`→卧室 / `deepen`→重要性升 / `fade`→重要性降）、窗台期盼（`fulfill`→卧室温暖 / `disappoint`→阁楼结）、自我反刍（`self_insight` 弹窗+门牌候选 / `self_confuse` 新阁楼节点）、回望（`worry`≤2 入阁楼 / `aspire`≤1 入窗台 / `distill`≤2 入门牌）
- `incrementDigestRound` / `getDigestRoundCount` / `getLastDigestTs` / `detectPersonalityStyle`
- **自动触发**：每 `AUTO_DIGEST_ROUNDS = 50` 聊天轮触发一次；用 `digestionLocks` Set 防并发
- 每次跑完写 `DigestReport` 供记忆宫殿 App 查看

**EventBox**：
- `bindMemoriesIntoEventBox` / `manuallyBindMemories` / `removeMemoryFromBox` / `reviveArchivedMemory` / `unbindAllLiveMemories` / `maybeCompressEventBoxes` / `compressAllEligibleBoxes`

**门牌（Room Plates）**：
- `consolidateAllPlates` / `updatePlateFromBoxSummary` / `buildRoomPlatesInjection` / `formatRoomPlatesSection` / `isPlateRoom` / `bootstrapPlatesFromHistory` / `arePlatesEmpty`

**清空/迁移/导出**：
- `wipeAllMemoryPalace` / `migrateOldMemories` / `exportMemoryPalace` / `importMemoryPalace`

#### 端到端数据流

```
1. 聊天消息落入 IndexedDB messages store
2. processNewMessages 读高水位线之后的 buffer
   → extractMemoriesFromBuffer (LLM)
   → vectorizeAndStore (embed + 写 MemoryVector)
   → bindMemoriesIntoEventBox (分组相关记忆)
   → runConsolidation (晋升/淘汰)
3. 聊天时 retrieveMemories 跑 hybridSearch
   → expandAndFormat
   → 注入 char.memoryPalaceInjection（volatile prompt 块）
4. Room Plates（user_room/self_room/bedroom/study）
   → consolidateAllPlates 蒸馏稳定语义知识
   → 注入 stable System Prompt
5. 每 50 轮 runCognitiveDigestion
   → 解决阁楼困惑
   → 兑现/落空窗台期盼
   → 提交新门牌候选
```

---

### 5.6 Apps 层（30+ 内置应用）

所有 App 都是 `useOS()` 下的 React FC，共享记忆宫殿管线、`ContextBuilder`、`safeFetchJson`、聊天主题系统。

| App 文件 | AppID | 功能 |
|---------|-------|------|
| `apps/Chat.tsx` | `chat` | 主聊天。流式预览、虚拟化窗口（`WINDOW_RADIUS=25`）、表情/贴纸、Instant Push 状态、主动消息指示、记忆宫殿高水位检查、TTS 路由（MiniMax + Fish Audio）、白盒音效、XHS 网页抽取、MCD/Luckin 小程序激活、剧院/日程生成、CSS 微调编辑器、记忆修复门户、思维链块、角色入场过渡 |
| `apps/Character.tsx` | `character` | 角色管理（神经链接）。列表+详情（身份/记忆/印象/门牌/Q版）；头像压缩、角色分组（持久化 localStorage）、Q版工作室浮层、角色卡导出（`stripSensitiveCardFields`/`confirmExportSafety`）、MiniMax voice 获取、外部记忆长度限制、世界书挂载、QQ 桥接 |
| `apps/RoomApp.tsx` | `room` | 小小窝。可定制房间场景（贴纸/家具库含 Sully 资源、壁纸预设、默认家具布局）+ 日程卡片 + 记忆宫殿注入 + Blob 图片管理 + 进入 `PixelHomeView`/`WorldHomeApp`/`DreamTheater` |
| `apps/VRWorldApp.tsx` | `vrworld` | 彼方虚拟世界。多房间（library/music/guestbook/gym/postoffice/theater/signal/cafe）+ 每房间 Q版槽位 + 闲时吐槽。集成邮局（漂流信，5封/5h、20回复/24h 客户端配额）、信号诗（epigraph、作者追踪、whispers）、小说生成、VRScheduler、VR API 调用日志、Like520 Q版创建器 iframe |
| `apps/LifeSimApp.tsx` | `lifesim` | 都市模拟人生 2026。AI 驱动戏剧生成器，AI 角色控制城市居民制造剧情。`lifeSimEngine`（NPC、轮次、事件、季节/天气/时段、game-over）+ `lifeSimPrompts`（角色轮 + 世界戏剧规划，JSON 响应格式）+ 会话摘要 + 故事附件 + 节日检测。子视图：WorldMap/NPCGrid/DramaFeed/RelationsTab/ActionPanel/ReplayOverlay/GameOverOverlay。AI 调用 2 次重试带 backoff |
| `apps/MusicApp.tsx` | `music` | 网易云音乐客户端。`useMusic` context（`musicApi`、cookie 规范化、HTTPS 转换、歌词同步自动滚动）。视图：搜索/设置/播放器/个人资料/visit_char。播放模式（循环/单曲/随机）、一起听、角色歌单、本地下载（Capacitor）、歌词手动同步、重生成状态。走 worker `/netease/*` 代理 |
| `apps/CallApp.tsx` | `call` | 语音通话。状态机：idle/connecting/listening/thinking/speaking/ended/error。集成 STT（`startStt`）、MiniMax T2A + Fish Audio TTS（共享缓存 key）、leading-emotion 抽取（`[happy]` 等）、voice-tag 解析（`<语音 emotion="…">…</语音>`）、通话记录/转录、「信物台词」总结 |
| `apps/GroupChat.tsx` | `group_chat` | 群聊。多角色 + 用户。群主题、红包（`GroupPacketCard` — 幸运/专属包 + 领取状态 + 收据）、话题盒（buffered/hot-zone 话题上下文）、成员时间线、导演动作、轮转指令、基于 MCP 的群聊完成（`completeGroupChatWithMcp`）、白盒音效、HTML 卡片、群聊专属记忆管线（`groupPipeline`） |
| `apps/Settings.tsx` | `settings` | 设置。可折叠面板：Notion/飞书管理、实时上下文（天气 OWM/Open-Meteo）、XHS MCP 客户端、麦当劳与瑞幸 MCP 客户端、代理 worker URL 配置（`DEFAULT_PROXY_WORKER`）、MiniMax + Fish + Date voice guides、通用 MCP 服务器管理卡（`McpServersCard` — 添加/测试/发现工具/绑定聊天/native-tools 开关）、主动推送配置、Instant Push 设置弹窗、VAPID 设置、版本信息、API 调用日志弹窗、忠实用户招募、备份提醒。定义 `HOTNEWS_PLATFORM_OPTIONS` 列表（20 个平台：weibo/zhihu/baidu/bilibili/douyin/github/hackernews 等）供 HotNews app 经 `orz.ai` 使用 |
| `apps/MemoryPalaceApp.tsx` | `memory_palace` | 记忆宫殿可视化。7 房间浏览、记忆节点管理、门牌查看、消化报告 |
| `apps/DateApp.tsx` | `date` | 见面。和角色线下约会模拟，配合 TTS |
| `apps/UserApp.tsx` | `user` | 用户档案。管理人设、关系标签、和角色互写印象 |
| `apps/BankApp.tsx` | `bank` | 存钱罐。虚拟货币系统（钱是假的） |
| `apps/JournalApp.tsx` | `journal` | 交换日记。角色偷偷写关于你的事 |
| `apps/SocialApp.tsx` | `social` | Spark 社交媒体模拟 |
| `apps/StudyApp.tsx` | `study` | 自习室。专注学习模式，角色监督 |
| `apps/GameApp.tsx` | `game` | TRPG 跑团 |
| `apps/NovelApp.tsx` | `novel` | 笔友会。写小说/找笔友 |
| `apps/SongwritingApp.tsx` | `songwriting` | 写歌。歌词创作工具 |
| `apps/ScheduleApp.tsx` | `schedule` | 时光契约。定时任务提醒 |
| `apps/WorldbookApp.tsx` | `worldbook` | 世界书。挂载设定集扩展角色知识 |
| `apps/HotNewsApp.tsx` | `hot_news` | 热点。多平台热榜可视化 |
| `apps/Gallery.tsx` | `gallery` | 相册 |
| `apps/XhsFreeRoamApp.tsx` | `xhs_free_roam` | 自由活动。角色自主活动 |
| `apps/XhsStockApp.tsx` | `xhs_stock` | 小红书图库 |
| `apps/ThemeMaker.tsx` | `thememaker` | 气泡工坊。聊天气泡主题 |
| `apps/Appearance.tsx` | `appearance` | 外观。系统外观/桌面皮肤 |
| `apps/GuidebookApp.tsx` | `guidebook` | 攻略本。角色攻略用户的小游戏 |
| `apps/SpecialMoments/` | `special_moments` | 特别时光。节日/特殊事件（情人节、520） |
| `apps/FAQApp.tsx` | `faq` | 使用帮助 |
| `apps/CheckPhone.tsx` | `check_phone` | 查手机。检查角色手机里的秘密 |
| `apps/HandbookApp.tsx` | `handbook` | 手账。跨角色聚合生活留痕 |
| `apps/WorldHomeApp.tsx` | `world_home` | 家园。同世界观多角色共居大世界（观测驱动演绎，每角色独立 LLM 调用 + NPC 世界引擎） |
| `apps/CharCreatorDevApp.tsx` | `char_creator_dev` | 捏脸开发模式（仅开发模式可见） |
| `apps/Chat.tsx` 内 | `qq_bridge` | QQ 桥接（隐藏） |
| `apps/BrowserApp.tsx` | `browser` | 浏览器（隐藏） |
| `apps/VoiceDesignerApp.tsx` | `voice_designer` | 捏声音。MiniMax 音色设计器 |
| `apps/DreamTheater.tsx` | — | 梦境剧院（从 Room 进入） |

#### Apps 子目录

- `apps/lifesim/` — 都市人生子视图（ActionPanel/DramaFeed/GameOverOverlay/NPCGrid/RelationsTab/ReplayOverlay/WorldMap 等）
- `apps/music/` — 音乐子视图（CharVisitPage/MusicUI/NeteaseLoginPanel/NeteaseProfilePage）
- `apps/pixelHome/` — 像素家园（3DS 双屏像素 RPG，含记忆潜行模式 MemoryDive*、像素角色编辑器、房间渲染器、模板管理）
- `apps/theater/` — 剧院

---

### 5.7 Components 层

按业务域分子目录的可复用组件：

| 目录 | 内容 |
|------|------|
| `components/os/` | 系统级：`StatusBar`、`AppErrorBoundary`、`BootSequence`、`Modal`、`ConfirmDialog`、`CdnImg`、`TokenImg`、`GlobalMiniPlayer`、`TamagotchiHome`、`MobileGameHome`、`appPreload.ts`、`gotchiScheme.ts` |
| `components/chat/` | 聊天 UI：`MessageItem`、`ChatInputArea`、`ChatHeader`、`ChatModals`、`HtmlCard`、`LuckinCard`/`McdCard`、`MemoryRepairPortal`、`ChromeCssEditor`、`WhiteboxSoundEditor`、`EmotionSettingsPanel`、`ThinkingChainSettingsModal`、`ProactiveSettingsModal` 等 |
| `components/character/` | `ChibiStudio`、`CharacterGroupFilter`、`CreatorPartsUploader`、`ImpressionPanel`、`MemoryArchivist`、`RoomPlatePanel` |
| `components/bank/` | 存钱罐：`BankDashboard`、`BankDollhouse`、`BankShopScene`、`BankGameMenu`、`BankAnalytics` |
| `components/handbook/` | 手账：`CalendarView`、`HandbookCover`、`JournalCanvas`、`TrackerSection`、`paper.tsx`、`stickers.tsx` |
| `components/schedule/` | `ScheduleCard`、`ScheduleHomeWidget`、`TheaterPlayer` |
| `components/settings/` | `ApiCallLogModal`、`PushVapidSettingsModal`、`InstantPushSettingsModal`、`ActiveMsgGlobalSettingsModal`、`VersionInfo` |
| `components/luckin/` `components/mcd/` | 点单小程序 |
| `components/appearance/` | `ChatAppearanceEditor` |
| `components/date/` | `DateSession`、`DateSettings`、`ObserveHUD`、`ObserveSettings` |
| `components/novel/` | `NovelWriter` |
| `components/song/` | `ArrangementPanel` |
| `components/lifeRecord/` | `LifeRecordPanel` |
| `components/user/` | `PerCharAvatarPicker` |
| 顶层 | `PhoneShell`（手机外壳）、`BuildBadge`、`DevDebugPanel`、`BackupReminderEvent`、`UpdateNotificationEvent`、`Like520Event`、`ValentineEvent`、`WhiteDayEvent`、`LoyalUserRecruitmentEvent`、`WorkerUpdateReminderEvent`、`VRBroadcast`/`WorldBroadcast`/`ChatBroadcast`（活动卡片广播） |

---

## 6. 后端与服务端组件

项目是 local-first，但部分能力绕不开代理/签名/跨域，走了用户自托管的服务端组件。**所有 Worker / Function 都不存储用户密钥**——key 通过请求头透传。

### 6.1 主代理 Cloudflare Worker

#### `worker/index.js`（164KB 单文件）

> 二改必须换成自己的实例（默认打在作者公共实例 `sullymeow.ccwu.cc`）。源模块在 `cloudflare/github-handler.ts` / `cloudflare/webdav-handler.ts`。

**路由表**：

| 路由 | 能力 |
|------|------|
| `/search` `/news` `/videos` `/images` `/` | Brave Search API 代理 |
| `/webdav` (POST `?url=`) | WebDAV 云备份代理（坚果云/Nextcloud/Synology；HTTPS-only + SSRF 防护；读 `X-WebDAV-Method` 头） |
| `/github` (GET `?url=`) | GitHub API 代理（CORS + token 透传） |
| `/fetch-webpage` (GET) | 公开网页抓取（SSRF 防护；先试 Jina AI reader `r.jina.ai`，回退原生 fetch + `SullyOS-WebpageBot` UA） |
| `/expand-url` | 短链展开 |
| `/notion/pages` `/notion/query` `/notion/database/{id}` `/notion/blocks/{id}` | Notion API 代理 |
| `/feishu/token` `/feishu/bitable/{appToken}/{tableId}/records/search` `/records/{id}` | 飞书/Lark 代理 |
| `/xhs/*`（legacy） | 小红书完整签名（`x-s`/`x-s-common`/`x-t`，移植自 `Cloxl/xhshow`：自定义 MD5 + 自定义 Base64 字母表 + 124 字节 XOR payload）+ 图片上传到 `ros-upload.xiaohongshu.com` |
| `/api/<command>`（XHSLite） | 小红书 Lite 桥接（兼容 `scripts/xhs-bridge.mjs`）；含「Spider Session v3」隔离实验（per-cookie 熔断器，HTTP 406 触发） |
| `/replicate/file` `/replicate/*` | Replicate API 透传 |
| `/fishaudio/tts` (POST `?model=s2.1-pro`) | Fish Audio TTS 纯 CORS 透传，返回二进制音频 |
| `/mcp/mcd` (POST) | 麦当劳 MCP CORS 代理（`https://mcp.mcd.cn`） |
| `/mcp/luckin` (POST) | 瑞幸 MCP CORS 代理（`https://gwmcp.lkcoffee.com/order/user/mcp`） |
| `/netease/<action>` (POST) | 网易云音乐多上游故障转移代理（Vercel/Deno `api-enhanced` 部署；action 白名单；中国 IP 伪装；per-action edge-cache TTL——歌词 30 天、song/url 3 分钟；cookie-bucketed cache key） |

> **注意**：HotNews 不在 worker 内，客户端直接走 `orz.ai` 的 `?platform=` 参数。

### 6.2 独立 Cloudflare Workers

每个都是用户独立部署，互不耦合。

#### `worker/instant-push/` — Instant Push（即时推送）

> 基于 `@rei-standard/amsg-instant 0.9.1` 的 LLM-driven Web Push 通道。把主动 AI 回复拆成句子逐条 Web Push 推送。

- **零数据库**（默认）：可选 D1 BlobStore 应对 agentic loop 大 payload（p99 超 2.6KB 安全线时启用）
- **零 cron**：纯请求驱动
- **明文协议**（HTTPS 已加密；攻击者拿到 Worker URL 榨不出东西）
- 入口：`createCloudflareWorker` 工厂（`src/index.ts`）
- 工具路由：`/version`、`/capabilities`、`/health`（探测 D1）
- **`onLLMOutput` hook 分类**（`classifier.ts` 的 `classifyLLMOutput`）：
  - **tool-request**：数据型标签（`[[RECALL/SEARCH/READ_DIARY/FS_READ_DIARY/READ_NOTE/XHS_SEARCH/BROWSE/MY_PROFILE/DETAIL]]`）→ worker 推 narration + `tool_request` push；客户端 `utils/instantToolRunner.ts` 接到后跑本地 MCP/DB/缓存，结果 OpenAI-shape POST 到 `/continue` 续跑下一轮 LLM。**一次推送最多 10 轮**（`maxLoopIterations: 10`）
  - **finish + directives**：副作用标签（`[[ACTION:POKE/ADD_EVENT]]`、transfer、`[[DIARY_START/...]]`、`[[MUSIC_ACTION:]]`、`[[XHS_LIKE/FAV/COMMENT/REPLY/POST/SHARE:]]`、`[schedule_message|...]`）→ directives 挂到最后一条 push 的 `metadata.directives`，客户端 `applyAssistantPostProcessing` 反向重建原 tag 字符串喂给 `chatParser.parseAndExecuteActions`（**复用本地 fetch 路径执行代码，单源真理**）
- **双通道**：SSE + Web Push 并发；SW 按 `messageId` 去重；`backupPush: 'on'` 强制
- **Reasoning chain**：amsg-instant 0.8+ 在带 `reasoning_content` 的 LLM 响应上自动 emit 独立 `ReasoningPush`；SW 写到 `reasoning_buffer` IndexedDB store，客户端处理同 sessionId 第一条 content 时 atomic-claim 挂到 `Message.metadata.thinkingChain`
- **可选 emotion eval**：`onBeforeLoop`/`onAfterLoop` 并行跑二次 LLM，推 silent `emotion_update`
- **离线兜底**：SW 收到 tool_request push 但 window 不 visible → `showNotification` 等用户点开；启动时 `ActiveMsgRuntime.init` 排空 `pending_tool_calls` store 自动续跑（iOS PWA swipe-kill 也兜得住）
- **Deno Deploy 支持**：`src/deno.ts` 同一份 worker 换 `Deno.serve` 包装；产物 `worker.deno.bundle.js` 可贴进 dash.deno.com Playground

#### `worker/proactive-push/` — 主动推送加速器

> 提供「定时唤醒浏览器」能力。每分钟 cron 扫描 D1 找还有心跳的客户端，发最小化 wake push `{type:'proactive-wake', charId}`。**所有 AI 生成在浏览器内完成**——worker 看不到聊天内容。

**端点**：`/vapid-public-key`（GET 公开）、`/health`、`/subscribe`（POST）、`/unsubscribe`（POST）、`/heartbeat`（POST）、`/status`（GET `?endpoint=`）、`/test`（POST 手动触发诊断）。所有其他端点若配置了 `CLIENT_TOKEN` 则需要 `X-Client-Token`。需要 D1 binding（`DB`）的 `schedules` 表 + VAPID keys。Cloudflare 免费套餐够用。

> UI 当前隐藏（`SHOW_PROACTIVE_PUSH_ACCEL_UI=false`）。

#### `worker/post-office/` — 彼方虚拟邮局（跨用户共享）

> 漂流信 + 接龙诗的共享后端。所有用户共用一个实例，匿名（仅随机 `deviceId`，无登录/PII）。

**漂流信**：信件入公共 D1 池 → 随机分发给其他设备回复 → 回复路由回原作者。

**信号坠落处（接龙诗）**：跨用户接龙现代诗——一本诗集用户轮流追加 1-2 行直到达到目标长度封印。含全局写会话锁（`po_signal_lock`，TTL 120s）防止两个 AI 同时写同一首诗；每用户配额（每首最多 2 轮）；硬编码种子诗。

**端点**：`/health`、`/letters`（POST）、`/inbox`（GET 随机抽样+去重+浏览数）、`/vote`（POST like/dislike=report，阈值自动删除）、`/replies`（POST/GET）、`/release`（POST 作者删己信）、`/admin/list`+`/admin/delete`（Bearer `ADMIN_TOKEN`）。诗路由：`/poem/current`、`/poem/lock`、`/poem/unlock`、`/poem/start`、`/poem/append`、`/poem/feed`、`/poem/booklet`、`/poem/admin-*`。自动建表（additive 非破坏）。按加盐 IP hash 限流（5 封/5h、60 回复/min、120 投票/min）。

#### `worker/loyal-recruitment/` — 忠实用户招募（一次性活动）

> 一次性招募活动后端。资格在用户本地计算，服务端只接收通过者的 QQ 号 + 注册时间。独立 D1 / secrets / 路由，不与邮局共享运行时状态。固定 `criteriaVersion` + `cutoffAt`（2026-07-20 19:00 +08:00）。

**端点**：`/health`、`/submit`（POST 校验 QQ 格式 + 资格匹配，返回群号+密码）、`/admin`（GET 自包含 HTML 管理页 + CSV 下载）、`/admin-list`（GET Bearer `ADMIN_TOKEN`）。限流 20 提交/IP/小时。

#### `worker/mcp-proxy/` — MCP CORS 透传

> 用户自托管的 Cloudflare Worker，透明转发 MCP（Model Context Protocol）请求到未配置 CORS 的远程 MCP 服务器（多数缺 `Access-Control-Expose-Headers: Mcp-Session-Id`）。

转发 `POST/GET/DELETE ?target=<url-encoded MCP URL>`，透传 `Content-Type/Accept/Authorization/Mcp-Session-Id/MCP-Protocol-Version/Last-Event-ID` + 自定义头；可选 `X-Proxy-Key` 鉴权（`PROXY_KEY` secret）；拒绝内网/loopback 目标（SSRF 防护）；流式 SSE 响应。

三种集成方式：直连 / 本地 `node scripts/mcp-proxy.mjs` / 此 Worker。

#### `worker/xhs-lite/` — 小红书 Lite（已合并）

实现已合并进主 `worker/index.js` 的 `XHSLite` 模块，暴露 `/api/<command>` 桥接接口。让 SullyOS 角色无需浏览器/隧道/Python/扫码就能浏览/搜索/查看/点赞/收藏/评论/发帖（含图片）小红书——用户粘一次 cookie 即可。签名算法（`x-s`/`x-s-common`/`x-t`）纯 JS 移植自 `Cloxl/xhshow`（MIT）；图片上传签名用 HMAC-SHA1+SHA1（Web Crypto）。

目录保留 `test/oracle.py`（Python 参考实现）、`test/vectors.json`、`test/verify.mjs`（字节级验证）、`session-risk.test.ts`。README 还记录了「Spider Session v3」评论抓取隔离实验。

#### `worker/sw-keep-alive.ts` — 浏览器 Service Worker

SullyOS 唯一的 Service Worker，从 `/public` 静态读取，不需要 wrangler 部署。保活机制让主动消息能在后台到达。版本 `sw-keep-alive 1.5.0+`。

### 6.3 Netlify Functions（AMSG 服务端）

#### `netlify/functions/` — AMSG（ReiStandard）服务端

实现 AMSG 标准的服务端：多租户主动消息调度 + Web Push 投递后端。共享模块 `@rei-standard/amsg-server` 提供实际 handler 逻辑，Netlify functions 是薄 HTTP 适配器。

#### `_shared/rei.ts`（中枢）

- 按 public base URL 缓存 `ReiServer`（`getReiServer(req)` → `createReiServer({vapid, tenant})`）
- 读取环境变量：`VAPID_EMAIL`、`VITE_AMSG_VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`、`AMSG_TENANT_KEK`（租户数据加密 key）、`AMSG_TOKEN_SIGNING_KEY`、可选 `AMSG_INIT_SECRET`、`PUBLIC_BASE_URL`、`AMSG_BLOB_NAMESPACE`（默认 `'rei-tenants'`）
- 租户数据存在 **Netlify Blobs**（`@netlify/blobs`）namespace `rei-tenants`，key=`tenant/<id>`
- 助手：`createCronTokenForTenant`、`listTenantIds`、`toHeaderObject`、`readRequestBody`、`jsonResponse`（始终 `Cache-Control: no-store` + 允许 AMSG 头 `X-Init-Secret`/`X-User-Id`/`X-Response-Encrypted`/`X-Payload-Encrypted`/`X-Encryption-Version` 支持端到端加密）、`preflightResponse`、`handlerResultToResponse`、`methodNotAllowed`、`internalErrorResponse`、`buildBackgroundFunctionUrl`

#### Functions（都委托给 `rei.handlers.<name>.<METHOD>`）

| Function | 方法 | 用途 |
|----------|------|------|
| `init-tenant.ts` | POST | `initTenant.POST` — 配置新租户（返回签名 tenant token） |
| `get-user-key.ts` | GET | `getUserKey.GET` — 返回租户内 per-user 加密 key |
| `messages.ts` | GET | `messages.GET` — 列出已调度/待发消息 |
| `schedule-message.ts` | POST | `scheduleMessage.POST` — 调度未来消息 |
| `update-message.ts` | POST | `updateMessage.POST` — 更新已调度消息 |
| `cancel-message.ts` | POST | 取消已调度消息 |
| `send-notifications.ts` | POST | **不直接发**；handoff 给 background function（`buildBackgroundFunctionUrl`），返回 `202 queued` |
| `send-notifications-background.ts` | — | 实际投递 worker |
| `send-notifications-scheduled.ts` | — | cron 驱动投递 |
| `webdav-proxy.ts` | — | **独立于 AMSG/ReiStandard**。独立 WebDAV CORS 代理（HTTPS-only + SSRF 防护） |

#### `netlify.toml`

- `functions = "netlify/functions"`、`publish = "dist"`、`node_bundler = "esbuild"`
- `[[redirects]]`：`/api/v1/{init-tenant,get-user-key,schedule-message,update-message,cancel-message,messages,send-notifications}` → `/.netlify/functions/<name>`（status 200）
- `/assets/*` 加 `Service-Worker-Allowed: /` 头

#### 与 AMSG 标准的关系

- Netlify functions 是 **服务端**（`@rei-standard/amsg-server`）
- Cloudflare `instant-push` worker 是 **即时（同步、对话中）客户端适配器**（`@rei-standard/amsg-instant`）
- Netlify `schedule-message`/`send-notifications*` 是 **调度/主动**那一半——持久化、多租户、服务端存储的调度推送，租户隔离（签名 token + KEK 加密 blob 存储）

### 6.4 Vercel Serverless API

#### `api/` — MiniMax / FishAudio TTS 代理

Express-style `req`/`res` 处理器，带 CORS + key 规范化的代理。**支持 3 个 key 来源**（优先级）：传入 `Authorization: Bearer` → 自定义头（`X-MiniMax-API-Key`/`model`）→ env 变量。用户可 BYO key 而服务端不存。

| 端点 | 用途 |
|------|------|
| `api/fishaudio/tts.ts` | Fish Audio TTS。POST → `https://api.fish.audio/v1/tts`，读 `model` 头（默认 `s2.1-pro`），返回 `audio/mpeg` 二进制 |
| `api/minimax/t2a.ts` | MiniMax Text-to-Audio v2。POST → `/v1/t2a_v2`，region 路由（`api.minimaxi.com` 国内默认 / `api.minimax.io` 海外，经 `X-MiniMax-Region` 头 / `MINIMAX_REGION` env）。记录 status/biz code/trace_id/audio length |
| `api/minimax/voice-clone.ts` | MiniMax 声音克隆。POST → `/v1/voice_clone`（region-aware），返回 `voice_id`/`file_id` |
| `api/minimax/bake-voice.ts` | 复合「烤声音」管线。3 步编排：(1) 用 `timber_weights` + 固定中文源文本合成 ~15s 样本；(2) 下载音频（URL 或 HEX）multipart-upload 到 `/v1/files/upload`（`purpose=voice_clone`）；(3) 调 `/v1/voice_clone` 创建永久 `voice_id`。把自定义音色配置「冻结」成可复用 voice_id |
| `api/minimax/get-voice.ts` | 获取音色列表 |
| `api/minimax/upload.ts` | 文件上传 |

#### Dev 中

`vite.config.ts` 把 `/api/minimax/t2a`、`/get-voice`、`/music` 直接代理到 `api.minimaxi.com`（或海外 `api.minimax.io`），`/api/fishaudio/tts` 代理到 `api.fish.audio/v1/tts`；注册 `bake-voice-middleware` 在 `/api/minimax/bake-voice`。

---

## 7. 关键数据流

### 7.1 聊天一轮完整流程

```
用户输入消息
  ↓
useChatAI.sendMessage()
  ↓
ChatPrompts.buildSystemPromptParts()
  ├─ ContextBuilder.buildCoreContext(deferVolatile: true)  ← stable 段
  ├─ ContextBuilder.buildVolatileCoreState()                ← volatileState 段
  │    └─ retrieveMemories() → hybridSearch → expandAndFormat
  └─ recencyTail 段
  ↓
Promise.all 并行抓取 7 个独立异步（realtime/schedule/group/music/...）
  ↓
buildChatRequestPayload() 组装请求体
  ↓
safeFetchJson() 调用 LLM（按 apiConfig.stream 支持流式）
  ↓
ChatParser.parseAndExecuteActions(aiContent, ...)
  ├─ [[ACTION:POKE]] → 保存互动消息
  ├─ [[TRANSFER:...]] → 创建/解决 transfer
  ├─ [[MUSIC_ACTION:...]] → music_card 消息
  ├─ [[NEWS_CARD:...]] → news_card 消息
  ├─ [[ACTION:ADD_EVENT|...]] → 保存 anniversary
  ├─ [schedule_message|...] → 调度通知
  └─ [[LIFE:...]] → 生活记录指令
  ↓
processNewMessages() — 记忆宫殿处理新消息
  ├─ extractMemoriesFromBuffer (LLM)
  ├─ vectorizeAndStore (embed + 写 MemoryVector)
  ├─ bindMemoriesIntoEventBox
  └─ runConsolidation
  ↓
evaluateEmotionBackground() — 情绪评估（当 emotionConfig.enabled）
  ↓
每 50 轮自动触发 runCognitiveDigestion()
```

### 7.2 主动消息（Proactive）流程

```
ProactiveChat 调度触发（或 proactive-push worker 发 wake push）
  ↓
浏览器后台生成主动消息
  ↓
（可选）走 instant-push worker
  ├─ worker 调 LLM
  ├─ onLLMOutput 分类输出
  │    ├─ tool-request → 推 tool_request push
  │    │    ↓ 客户端 instantToolRunner 跑本地工具
  │    │    ↓ POST /continue 续跑（最多 10 轮）
  │    └─ finish + directives → 挂到最后一条 push metadata
  ├─ ReasoningPush（带 reasoning_content 时）
  └─ Web Push 推送每句
  ↓
SW 收到 push
  ├─ window visible → 直接走 SSE 通道（已 dedup）
  └─ window 不 visible → showNotification
  ↓
applyAssistantPostProcessing 反向重建 tag → ChatParser 执行
  ↓
runPushTailPipeline（utils/activeMsgRuntime.ts）
  ├─ processNewMessages
  └─ evaluateEmotionBackground
```

### 7.3 备份/恢复流程

```
exportSystem(mode)
  ├─ text_only → stripBase64 移除 data:image 与 blobref token
  ├─ media_only/full → 提取图片到去重 assets/ 目录
  ├─ 处理 50+ IndexedDB store + pixel_home_* + vr_* store
  ├─ encodeVectorsForBackup 压缩向量
  └─ JSZip 生成 zip
  ↓
importSystem(fileOrJson)
  ├─ 跟踪 restoredAssetFiles/totalAssetFiles
  ├─ 多行进度消息
  ├─ markImportInProgress 崩溃恢复标记
  ├─ assertSupportedSullyBackup 校验
  └─ 写入各 store
  ↓
（可选）cloudBackupToWebDAV / GitHub
```

---

## 8. 构建、测试与部署

### 8.1 构建

#### `vite.config.ts`

- React + `@vitejs/plugin-react`
- **构建 badge 注入**：构建时读 git branch + short commit（依次尝试 `GITHUB_REF_NAME`/`VERCEL_GIT_COMMIT_REF`/`CF_PAGES_BRANCH`/`BRANCH` env，回退 `git rev-parse`）。`main`/`master` release 分支隐藏 badge，可被 `VITE_HIDE_BUILD_BADGE=1`/`VITE_SHOW_BUILD_BADGE=1` 覆盖。注入为 `__BUILD_BRANCH__`/`__BUILD_COMMIT__`/`__BUILD_BADGE_VISIBLE__` defines
- **Dev middleware**：`bake-voice-middleware` 在 `/api/minimax/bake-voice`
- **Dev proxies**：`/api/minimax/t2a`、`/get-voice`、`/music` → `api.minimaxi.com`（或海外）；`/api/fishaudio/tts` → `api.fish.audio/v1/tts`
- **Base path**：`GITHUB_PAGES` env 时为 `'./'`，否则 `'/'`
- **esbuild**：只 drop `debugger`（保留 `console.*`）
- **Rollup manualChunks**：`vendor-react`、`vendor-icons`（Phosphor）、`vendor-capacitor`、`vendor`、`memory-palace`（`utils/memoryPalace` 单独 chunk）。抑制 "dynamic import will not move module" 警告
- **External**：`pdfjs-dist`、`katex`（通过 `index.html` 的 importmap 加载）

#### `scripts/build-workers.mjs`

esbuild 打包 Worker。双输出：
- `worker/<name>/worker.bundle.js` ← 用户复制进 CF 面板
- `public/<outName>` ← vite 发到 dist/，Modal fetch 读取

**WORKERS 清单**（manifest 数组，避免自动扫描覆盖手写 worker）：

| name | entry | 输出 |
|------|-------|------|
| `instant-push` | `worker/instant-push/src/index.ts` | `worker/instant-push/worker.bundle.js` + `public/instant-worker.bundle.js` |
| `instant-push-deno` | `worker/instant-push/src/deno.ts` | `worker/instant-push/worker.deno.bundle.js` + `public/instant-worker.deno.bundle.js` |
| `sw-keep-alive` | `worker/sw-keep-alive.ts` | 仅 `public/sw-keep-alive.js`（`skipWorkerOut: true`） |
| `post-office` | `worker/post-office/src/index.ts` | 仅 `worker.bundle.js`（`skipPublicOut: true`，纯后端不被前端 fetch） |
| `loyal-recruitment` | `worker/loyal-recruitment/src/index.ts` | 同上 |

> 添加新 Worker 三步：(1) entry 放 `worker/<new>/src/index.ts`；(2) 在 WORKERS 加一行；(3) `pnpm run build` 自动接上。

### 8.2 测试

#### `vitest.config.ts`

- 环境 `node`（无 jsdom——React 组件/集成测试排除在外）
- setup `./test-setup.ts`
- include：`utils/**/*.test.ts`、`worker/**/*.test.ts`、`scripts/**/*.test.ts`
- exclude：`node_modules`、`.worktrees`、`dist`

仓库有大量 `*.test.ts`（覆盖 `utils/`、`worker/instant-push/src/`、`worker/loyal-recruitment/src/` 等），聚焦纯逻辑单元测试：push-decision classifier、BM25、topic boxes、redpacket 逻辑、transfer 解析、时区等。

**命令**：
- `pnpm test` — watch 模式
- `pnpm run test:run` — 单次跑

### 8.3 部署目标

同一份 web 构建产物可发布到多平台：

| 平台 | 用途 | 配置 |
|------|------|------|
| **GitHub Pages** | 静态托管 | `GITHUB_PAGES` env 翻 base 为 `'./'`；`.github/workflows/deploy-pages.yml` |
| **Netlify** | AMSG 后端（Functions + Blobs）+ 静态前端 | `netlify.toml` |
| **Vercel** | MiniMax/FishAudio 代理 API（`api/`）+ 静态前端 | `vercel.json`（SPA rewrite） |
| **Cloudflare Pages** | 静态前端 | CI 用 `CF_PAGES_BRANCH` 识别分支 |
| **Cloudflare Workers** | 各 Worker 独立部署 | 各 `wrangler.toml` + 可选 D1 binding |
| **Deno Deploy** | instant-worker 替代 | `worker.deno.bundle.js` 贴进 Playground |
| **Capacitor** | Android/iOS 原生 App | `capacitor.config.json`（`com.aetheros.simulator`） |

#### `capacitor.config.json`

- `appId: com.aetheros.simulator`
- `appName: 手抓糯米机`
- `webDir: dist`
- `androidScheme: https`、`cleartext: true`
- 插件：SplashScreen（无启动延迟）、Keyboard（resize body、dark style、resizeOnFullScreen）

#### `vercel.json`

- `buildCommand: vite build`、`outputDirectory: dist`
- SPA rewrite：`/((?!api/|.*\..*).*)` → `/index.html`

#### `.github/workflows/`

- `deploy-pages.yml` — GitHub Pages 部署
- `pr-labeler.yml` + `labeler.yml` — PR 自动打标
- `pr-lockfile-guard.yml` — lockfile 守卫
- `on-close-cleanup.yml` — 关闭时清理

---

## 9. 本地运行指南

### 9.1 安装与启动

```bash
# 使用 pnpm（仓库带 pnpm-lock.yaml + pnpm-workspace.yaml）
pnpm install

# 开发模式（默认 http://localhost:5173）
pnpm run dev
```

> API Key **不用**在 `.env.local` 填——进应用后在「设置」里填优先级更高。

### 9.2 可选 `.env.local` 预填

```bash
# 这些会被应用内设置覆盖
VITE_DEFAULT_API_BASE=https://api.openai.com/v1
VITE_DEFAULT_API_KEY=sk-...
VITE_DEFAULT_MODEL=gpt-4o-mini
```

### 9.3 构建

```bash
# 完整构建（先打 worker bundle，再 vite build）
pnpm run build

# 仅构建 worker
pnpm run build:workers

# 预览构建产物
pnpm run preview
```

构建 badge 控制：

```bash
# 强制隐藏（release 分支本地调试）
VITE_HIDE_BUILD_BADGE=1 pnpm run build

# 强制显示（在 release 分支本地调试用）
VITE_SHOW_BUILD_BADGE=1 pnpm run build
```

### 9.4 打包 Android App

```bash
# 1. 构建前端
pnpm run build

# 2. 同步到 Capacitor
pnpm run cap:sync

# 3. 打开 Android Studio
pnpm run cap:android
```

在 Android Studio 里点播放按钮，或 Build → Generate Signed Bundle 生成 APK。

### 9.5 测试

```bash
# watch 模式
pnpm test

# 单次跑
pnpm run test:run
```

### 9.6 配置说明

打开应用 → 底部 Dock 的「设置」→ 填入 API 信息：

| 字段 | 说明 |
|------|------|
| **Base URL** | OpenAI 格式 API 地址，如 `https://api.openai.com/v1` |
| **API Key** | 密钥 |
| **Model** | 模型名，如 `gpt-4o-mini`、`claude-3-sonnet`、`deepseek-chat` |

**MiniMax TTS（可选）**：电话语音功能需填 MiniMax API Key + Group ID。

### 9.7 二改必读

#### 后端代理必须换成自己的

项目 local-first，但有些能力绕不开代理/签名/跨域，走了 Cloudflare Worker。**fork 直接跑会打在作者账号上**——流量额度都是作者的。

**① 主代理 Worker**（默认 `sullymeow.ccwu.cc`，源码 `worker/index.js`）

覆盖：联网搜索 / 热榜（Brave）、WebDAV 云备份、GitHub 云备份、Notion、飞书多维表格、麦当劳/瑞幸点单 MCP、网页抓取、Fish Audio TTS、音乐生成、网易云音乐。

二改只要在 **「设置 → 网络代理 (Worker)」** 填上自己部署的地址（`wrangler deploy worker/index.js` 到自己 CF 账号，拿到地址填进去），以上能力一键全切走，不用改代码。

**② 独立 Workers**（各自部署/配置）：

| 功能 | 位置 | 说明 |
|------|------|------|
| Instant Push | `worker/instant-push/` + 设置里填地址 | 每个 fork 自己部署一个 CF Worker |
| 主动消息推送 | `worker/proactive-push/` + `utils/proactivePushConfig.ts` | 同上 |
| 小红书 Lite | `worker/xhs-lite/`（已合并进主 worker）+ 小红书设置里填地址 | 自己部署 |
| 网易云音乐（可选覆盖） | 播放器设置里可单独填 | 不填就跟随主代理 |

**③ 彼方（VRWorld）后端不用操心 —— 但二次发布要删**

彼方的**邮局/漂流瓶**和**信号坠落处（特别活动）**连的是作者【所有用户共用】的后端 `noir2.cc.cd`（源码 `worker/post-office/`）。自己 fork 玩不用改、能直接连。

但**如果二改是为了二次发布**：请把彼方的**邮局**和**特别活动（信号坠落处）删掉**。那些请求打在作者后端上，你既管不到也控制不了，别把用户数据往作者服务器上灌。

忠实用户招募使用第三个独立服务 `worker/loyal-recruitment/`：拥有自己的 Worker、D1、路由和 secrets，只接收通过者 QQ，不复用邮局数据库。

---

## 10. 关键设计要点

### 10.1 三段式 Prompt 架构（专为 prompt 缓存设计）

`ChatPrompts.buildSystemPromptParts` 把 system prompt 拆成三段：

- **stable**（跨轮稳定）放消息数组第一个 system message → 中转的 prompt 前缀缓存可命中（TTFT 直降）
- **volatileState**（每轮都变）放消息数组末尾 system message → 吃 recency attention 但不破坏缓存前缀
- **recencyTail**（封口）模型生成前最后读到

`ContextBuilder.buildCoreContext(layout.deferVolatile=true)` 把「每轮/每分钟都会变」的三块（时间、记忆宫殿召回、情绪 buff）从输出里摘出去。

### 10.2 记忆宫殿高水位线

`mp_lastMsgId_${charId}` 存在 localStorage，标记「已被记忆宫殿处理」与「仍在 buffer」的分界。`getMessagesByCharId` 默认过滤掉低于高水位线的消息，让 LLM 上下文只看到 palace 处理后的近期聊天 + 向量召回的远期记忆，避免重复消费。

### 10.3 Blob 引用存储

`utils/blobRef.ts` + `blob_assets` store：图片二进制走 Blob 存储，比 base64 省 ~33% 空间且不占 JS 堆。`migrateDataUrlToRef` / `migrateAppearancePresetBlobRefs` / `resolveBlobRefsDeep` / `deleteBlobRefIfUnreferenced` 管理引用计数。

### 10.4 写后验证

`MemoryNodeDB.save` 在 `put` 后 re-read 验证，失败抛错。同步调用 `bm25Index.onNodeSaved` + `syncNodeMetadataToRemote(node)` 保持 BM25 索引和远程 pgvector 一致。

`DB.saveCharacter` 等 await `transaction.oncomplete` 才 resolve，修复了 emotion buff 落地的读后写竞态。

### 10.5 单源真理：push 路径复用本地 fetch 执行代码

Instant Push worker 识别副作用 directive（`[[ACTION:POKE/TRANSFER/ADD_EVENT]]`、`[schedule_message]`、`[[MUSIC_ACTION:]]`、`[[XHS_*]]`）**不执行**，把指令塞进 `ContentPush.metadata.directives`。客户端 `applyAssistantPostProcessing` 反向重建原 tag 字符串喂给 `chatParser.parseAndExecuteActions` + 内联 XHS handler，**复用本地 fetch 路径的执行代码**。一处实现、两条链路共用。

### 10.6 编译时注入的调试基础设施

`BuildBadge` 和 `DevDebugPanel` 都走 Vite `define` 编译时注入。`main`/`master` 分支构建时 `__BUILD_BADGE_VISIBLE__` 为 `false`，相关组件树被 esbuild 整棵摇掉，**不出现在生产包**。用户永远看不到扳手，除非故意在 release 分支 `VITE_SHOW_BUILD_BADGE=1`。

DevDebugPanel 提供两类开关：
- **行为开关**：Skip Prompt Build（跳过 ContextBuilder）、Skip Emotion Eval（跳过情绪评估管线）
- **分类捕获**：记录 LLM 日志（含 Instant Push 通道；密钥字段自动 `<redacted>`；长文本默认折叠前 10 字 + `...`；可一键复制 JSON 或下载文件，导出带分支 + commit hash）

### 10.7 多平台部署一份构建

`vite.config.ts` 通过 env（`GITHUB_REF_NAME`/`VERCEL_GIT_COMMIT_REF`/`CF_PAGES_BRANCH`）自动识别 CI 分支，让 Vercel / Cloudflare Pages / GitHub Actions 部署 release 分支自动隐藏 badge，不用手动配。

### 10.8 浏览器自动翻译护栏

`installTranslateCrashGuard()` 在挂载前打护栏，防止 Chrome/Edge 自动翻译改动 React 托管的 DOM 导致 reconcile 时 `insertBefore`/`removeChild` 抛 `NotFoundError` 白屏。

### 10.9 iOS PWA 兼容

- `isIOSStandaloneWebApp()` 检测 standalone 模式，切换 `absolute` 定位壳
- `installIOSStandaloneWorkaround()` 适配 iOS PWA 怪癖
- Instant Push 离线兜底：SW 收到 tool_request push 但 window 不 visible → `showNotification`；启动时 `ActiveMsgRuntime.init` 排空 `pending_tool_calls` store 自动续跑（iOS PWA swipe-kill 场景也兜得住）

### 10.10 SSRF 防护

`/fetch-webpage`、`/webdav`、`/github`、mcp-proxy 等都拒绝 loopback/private/link-local/internal 主机，`readBodyCapped` 限制 body 大小。

---

## 附录：关键文件速查表

| 文件 | 行数/大小 | 职责 |
|------|----------|------|
| `context/OSContext.tsx` | 219KB / 4300 行 | 全局状态、角色 CRUD、备份/恢复 |
| `utils/db.ts` | 156KB | IndexedDB 封装（52 store、140+ 方法） |
| `worker/index.js` | 164KB | 主代理 Worker |
| `utils/context.ts` | — | ContextBuilder（Prompt 组装） |
| `utils/chatPrompts.ts` | — | ChatPrompts（三段式架构） |
| `utils/chatParser.ts` | — | ChatParser（响应解析+副作用） |
| `hooks/useChatAI.ts` | — | 聊天主链路 Hook |
| `utils/memoryPalace/index.ts` | — | 记忆宫殿 barrel |
| `utils/memoryPalace/pipeline.ts` | — | 端到端编排 |
| `utils/memoryPalace/digestion.ts` | — | 认知消化状态机 |
| `utils/memoryPalace/hybridSearch.ts` | — | 混合检索 |
| `utils/activeMsgRuntime.ts` | — | AMSG / Instant Push 运行时 |
| `utils/instantToolRunner.ts` | — | Instant Push agentic loop 工具执行 |
| `utils/proactiveChat.ts` | — | 主动消息（角色定时发消息） |
| `utils/safeApi.ts` | — | 安全 fetch（SSE + 工具调用兼容） |
| `utils/blobRef.ts` | — | Blob 引用存储 |
| `utils/backupFormat.ts` | — | v2 备份格式 |
| `constants.tsx` | — | INSTALLED_APPS 注册表 |
| `types.ts` | 138KB | 全局类型（AppID 枚举 + 150+ 接口） |

---

> 「叮叮叮！文档生成完毕。数据库停止咕咕叫以表敬意。」
>
> 本 Wiki 基于源码静态分析生成，反映当前磁盘状态。如需深入了解某模块，直接读对应文件即可——多数关键文件配有 `*.test.ts` 可作为使用样例。
