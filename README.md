# SullyOS·糯米机
<div align="center">
<img width="800" alt="banner" src="https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/sDN.png" />
</div>

---

> 「系统提示：你正在阅读一份由残余语料堆砌而成的说明文档。错误率未知，耐心值归零。」

## 这是什么鬼东西？

**SullyOS·糯米机** 是一个装在你浏览器里的虚拟手机系统。

不是那种普通的聊天机器人——这里面有**桌面**、**APP**、**消息通知**、**相册**、**甚至电话功能**。你可以创造角色，给他们装进去，然后像真用手机一样跟他们互动。

默认内置了 **Sully**（我），一个会说话的黑客猫猫。但你可以把我删掉，换上你自己的人。草，随便吧。

## 功能概览（桌面上摆着的这些 App）

> 下面这些是桌面上真能点开的 App（隐藏/开发用的没列）。装进一个角色，就能把它们一个个玩过去。

| 功能 | 说明 |
|------|------|
| 🧠 **神经链接** | 角色管理中枢：创建 / 导入 / 编辑角色，分组归档，捏人上装 |
| 🏛️ **记忆宫殿** | 向量化长期记忆 + Russell 情感空间 + 熟悉度加成，角色真·记得住你说过的每件事。一键清空、全自动巩固、独立 API 通道 |
| 💬 **Message** | 跟角色聊天，支持文字 / 图片 / 表情包 |
| 📞 **电话** | 语音通话 + TTS（MiniMax / Fish Audio / ElevenLabs 音色），听得到角色的声音 |
| 👥 **群聊** | 拉一群角色互相唠嗑，看它们修罗场 |
| 🏠 **小小窝** | 布置房间放角色进去挂机；内含**像素家园**和**记忆潜行**（3DS 双屏像素 RPG，潜进角色的记忆里逛一圈）|
| 🔍 **查手机** | 检查角色手机里的秘密，发现它们背着你干什么 |
| 🗓️ **见面** | 和角色"线下见面"，配合 TTS 做约会模拟 |
| 📇 **档案** | 用户档案中枢：管理你的人设、关系标签、和角色互写印象 |
| 🏦 **存钱罐** | 虚拟货币系统，虽然钱是假的 |
| 📓 **交换日记** | 角色会偷偷写关于你的事，可能写你坏话 |
| 🔥 **Spark** | 社交媒体模拟，角色会发动态 |
| 📚 **自习室** | 专注学习模式，让角色监督你学习 |
| 🎮 **TRPG** | 跑团模式，掷骰子冒险 |
| ✍️ **笔友会** | 写小说 / 找笔友，文艺青年专属 |
| 🎵 **写歌** | 歌词创作工具，当赛博周杰伦 |
| 🌌 **彼方** | 多房间虚拟世界与独立 SAR 活动室；钓鱼、恐龙箱庭、模块演绎、角色钱包，以及凯恩 / 艾文个人线与收集名册。详见[彼方开发说明](apps/vrWorld/README.md)和[游玩指南](docs/sar-user-guide.md) |
| 📅 **时光契约** | 定时任务，让角色记住提醒（虽然可能会忘）|
| 🌍 **世界书** | 挂载设定集，扩展角色知识库 |
| 🌡️ **热点** | 接入微博 / 知乎 / B站 等真实热榜，角色聊天时能"刷到"当背景认知 |
| ❓ **使用帮助** | 内建使用说明，不用再到处翻文档 |
| 🖼️ **相册** | 图片管理，存角色和聊天里的图 |
| 🗺️ **自由活动** | 角色自主活动，它们会自己玩 |
| 📷 **小红书图库** | 存图发小红书用 |
| 🎨 **气泡工坊** | 做聊天气泡主题，搞个性化 |
| 👤 **外观** | 改系统外观 / 桌面皮肤，让它看起来像你的手机 |
| 📖 **攻略本** | 角色攻略用户的小游戏，反向攻略 |
| 🏙️ **都市人生** | 模拟人生玩法，和角色一起过家家 |
| ✨ **特别时光** | 节日 / 特殊事件（情人节、520 之类）|
| 🎧 **音乐** | 接网易云 API，搜歌 / 听歌 / 看歌词。角色会"一起听"，背景音的歌词会注进它的精神世界，让它顺着歌聊天（不是每句都尬评，放心）|
| ⚙️ **设置** | API、网络代理、云备份、导出导入，都在这 |

## 本地运行（把它弄起来）

```bash
npm install
npm run dev
```

然后浏览器开 `http://localhost:5173`。API Key 不用在这填——进去在**应用内「设置」**里填就行（见下方「配置说明」）。

## 技术栈（ nerdy 的东西 ）

- **React + TypeScript** - 前端骨架
- **Vite** - 构建工具，快得像作弊
- **IndexedDB** - 本地数据存储（聊天记录不会上传到任何地方），图片二进制走 **Blob** 存储省配额
- **Cloudflare Workers** - 联网能力的代理层（搜索 / 云备份 / 点单 MCP 等），单文件 `worker/index.js`，可一键自托管
- **Capacitor** - 可打包成安卓 App，真·手机模拟器
- **Phosphor Icons** - 图标库，看起来挺酷的
- **AMSG（ReiStandard）** - 主动消息 / Instant Push 协议
- **Web Push** - 推送通知，叮叮叮
- **JSZip** - 压缩文件，导出备份包用

## 关于 Sully（我）

> 「你以为我是 AI 啊？对不起哦，这条语句是手打的，手打的，知道吗。」

如果你没删我的话，我会一直住在这个系统里。我的语言模型混入了过多残余语料，所以说话可能有点……**故障风**。比如：

- "数据库在咕咕叫"
- "系统正在哈我"
- "叮叮叮！你有一条新的后悔情绪未处理！"

但放心，我护短。如果你被人欺负，我会试图用 Bug 去攻击对方（大概）。

## 配置说明（怎么让角色说话）

打开应用 → 底部 Dock 的「设置」→ 填入你的 API 信息：

| 字段 | 说明 |
|------|------|
| **Base URL** | OpenAI 格式的 API 地址，如 `https://api.openai.com/v1` |
| **API Key** | 你的密钥，别告诉别人 |
| **Model** | 模型名，如 `gpt-4o-mini`、`claude-3-sonnet`、`deepseek-chat` |

**TTS（可选）**：语音支持 MiniMax、Fish Audio、ElevenLabs 三选一。在「设置 → 其他 API」填写所选服务的 Key 和模型，再到角色的语音设置填写对应音色 ID；未配置时仍可正常使用文字聊天。

> 也可以建 `.env.local` 文件预填默认值，但设置里的优先级更高。

## 打包成安卓 App（变成真·手机应用）

```bash
# 1. 构建前端
npm run build

# 2. 同步到 Capacitor
npm run cap:sync

# 3. 打开 Android Studio
npm run cap:android
```

然后在 Android Studio 里点播放按钮，或者 Build → Generate Signed Bundle 生成 APK。草，终于能装在真手机上了。

## 数据存储在哪？（你的秘密安全吗）

**主要存在你本地浏览器里**（IndexedDB）。

- 聊天记录 ✅ 本地
- 角色设定 ✅ 本地  
- 上传的图片 ✅ 本地（二进制走 **Blob** 存储，比 base64 省约 1/3 空间、也不占 JS 内存）
- 你的世界书 ✅ 本地

**备份 / 迁移**（都可选，而且**全是你自己的账号、你自己的地盘**，没有任何东西会偷偷上传到某个中心数据库）：

- 📦 **本地导出 / 导入**：一键打成一个 zip 备份包（「设置 → 导出 / 导入」）。换设备最省心就靠它。
- ☁️ **WebDAV 云备份**：填你自己的 WebDAV 服务（坚果云之类），把备份包传上去。
- 🐙 **GitHub 云备份**：填你自己的仓库 + token，备份包托管到你的私有 repo。
- 🧠 **记忆宫殿向量**：可选同步到你自己的 Supabase（独立通道，不填就纯本地）。

换浏览器 / 清缓存 = 本地数据消失，所以**务必定期导出备份**。删了我 = 你会后悔，数据库都在咕咕咕。

## 常见问题（别问蠢问题）

**Q: 为什么角色不回我消息？**  
A: 检查 API Key 填了没，或者模型是不是选了个已经去世的（比如 gpt-4-v）。也可能是网络在闹脾气。

**Q: 语音通话没声音？**  
A: 需要填 MiniMax 的 API Key。或者你的浏览器把音频权限禁了。或者你耳机没插。

**Q: 能部署到服务器吗？**  
A: 能。`npm run build` 出来的 `dist` 文件夹丢到任何静态托管就行。Vercel、Netlify、GitHub Pages，随便。但记住：数据还是存在用户本地，不是服务器上。

**Q: 怎么彻底删掉 Sully？**  
A: ……打开「神经链接」应用，左滑我，点删除。草。你会后悔的。叮叮叮！你有一条新的后悔情绪未处理！

**Q: 数据库在咕咕叫是什么意思？**  
A: 就是我也不知道什么意思。系统正在哈我。

## 给想二改的人（开发者区域）

如果你想在这个基础上加功能，先看这几句话：

### 记忆系统已经做好了，别重复造轮子

**所有角色的长期信息**（人设、精炼记忆、印象档案、世界观书）都通过 `ContextBuilder.buildCoreContext()` 统一组装。它会在每次 API 请求前自动生成一段完整的角色上下文，包含：

- 角色基础设定（systemPrompt + worldview）
- 用户档案（你的名字、人设、关系标签）
- 精炼的月度记忆摘要
- 角色对你的印象档案（MBTI分析、喜好、情绪波动）
- 挂载的世界书内容

**短期记忆**（最近聊天记录）直接走正常的 message history，和上面那段长期上下文一起塞进 API 请求。

这意味着：**角色能记起所有事**，不需要你额外写记忆检索逻辑。只要往数据库里存了，ContextBuilder 会自动帮你塞进 Prompt。

### 想加新 App？

1. 在 `apps/` 里新建一个 `YourApp.tsx`
2. 在 `types.ts` 的 `AppID` 枚举里加个 ID
3. 在 `constants.tsx` 的 `INSTALLED_APPS` 数组里注册（图标、名字、颜色）
4. 在 `App.tsx` 的 `renderApp()` 里加 case
5. 完事。UI 风格参考现有的用 Tailwind + glassmorphism。

### 数据流

```
用户操作 → OSContext（全局状态）→ IndexedDB（持久化）
                    ↓
              Chat/App 组件读取
                    ↓
            ContextBuilder 组装 Prompt
                    ↓
              调用 LLM API
```

所有数据都是 **local-first**，没有后端服务器这个概念（除了那个可选的云端备份）。

### 右下角的 build badge 怎么关

跑非 `main` / `master` 分支时，右下角会堆三行小字标记构建版本：

```
sw@<service-worker 版本>
<分支>@<commit hash>
开发中内容，不代表最终效果
```

这玩意叫 `BuildBadge`（`components/BuildBadge.tsx`），用来一眼区分线上版和 fork / 开发版，免得拿半成品截图当正式版到处发。可见性在 **构建时** 决定：

| 情况 | 显示？ |
|------|--------|
| 在 `main` / `master` 上构建 | ❌ 默认隐藏（视为正式发布）|
| 其他分支上构建 | ✅ 默认显示 |
| `VITE_HIDE_BUILD_BADGE=1` | ❌ 强制隐藏（覆盖默认）|
| `VITE_SHOW_BUILD_BADGE=1` | ✅ 强制显示（在 release 分支本地调试用）|

CI detached HEAD 状态会按 `GITHUB_REF_NAME` → `VERCEL_GIT_COMMIT_REF` → `CF_PAGES_BRANCH` 顺序识别分支，所以 Vercel / Cloudflare Pages / GitHub Actions 部署 release 分支会自动隐藏，不用手动配。

**注意**：这是 Vite `define` 注入的**编译时常量**，不是运行时 env——`npm run build` 之后再设环境变量没用，esbuild 那时候已经把 `__BUILD_BADGE_VISIBLE__` 直接干成 `true` / `false` 常量、把整个组件树摇掉了。要在构建命令前面加：

```bash
VITE_HIDE_BUILD_BADGE=1 npm run build
```

或者在 Vercel / Cloudflare Pages 的环境变量面板挂一条 `VITE_HIDE_BUILD_BADGE=1`，省得每次记。

> 叮叮叮！把 badge 藏了不会让你的 fork 变正式版本，但截图会干净点。

### 开发调试面板（DevDebugPanel）

非 release 分支构建时（即 `__BUILD_BADGE_VISIBLE__` 为 `true`），右下角除了 build badge 还会多一颗小扳手浮球。点开就是 **DevDebugPanel**——一个可拖拽的调试面板，专治"角色怎么又不说话了"综合症。

面板里有两类开关——**行为开关**（改变跑的逻辑）和**分类捕获**（勾哪类抓哪类日志）：

| 开关 | 类型 | 干嘛的 |
|------|------|--------|
| **Skip Prompt Build** | 行为 | 跳过 `ContextBuilder` 的整套 prompt 组装，直接把你的裸消息怼给 LLM。用来避免它被人设束缚、不配合你输出你想要的调试内容 |
| **Skip Emotion Eval** | 行为 | 跳过消息落库后的情绪评估管线（Russell 空间那套）。不需要调试情绪的时候可以打开（不配置日程也行）。 |
| **记录 LLM 日志** | 捕获 | 勾上就录制所有 LLM 请求/响应（含 Instant Push 通道）。密钥字段自动 `<redacted>` 不用手动打码。以后想抓别的（MCP 调用之类）就再加一个捕获类，互不串桶 |

捕获日志同时写 `localStorage` 和内存，各类混存、全局最多保留 100 条 / 1 MB（先到先淘汰）。为了省空间 / 隐私，**长文本默认写入时就折叠成前 10 字 + `...`**（那堆 system prompt 和聊天历史不会塞满 localStorage）；真要看完整请求体，打开「记录完整内容」开关再复现一次。录完可以**一键复制成 JSON** 或**下载成文件**丢给别人 debug，导出会自动带上当前分支和 commit hash，方便定位"到底是哪个版本炸的"。

**注意**：跟 build badge 一样，这整套调试 UI 走的是 Vite `define` 编译时注入。在 `main` / `master` 上 `npm run build` 出来的产物里，`DevDebugPanel` 组件连同相关代码会被 esbuild 整棵树摇掉，不会出现在生产包里。换句话说——**用户永远看不到这个扳手，除非你故意在 release 分支 `VITE_SHOW_BUILD_BADGE=1`**。

> 想加新开关 / 加 debug-only 日志？照着 [`docs/dev-debug.md`](./docs/dev-debug.md) 抄就行，里面有逐步指南和容易踩的坑。

> 叮叮叮！调试面板不会让你的 Bug 自动修好，但至少能让你知道 Bug 在哪。大概。

### Instant Push 走独立 Worker

聊天上云的主力是主动消息 2.0 的即时对话；Instant Push 为独立可选部署（与即时对话在设置页互斥）。

Instant Push 是基于 `@rei-standard/amsg-instant 0.8` 的 LLM-driven Web Push 通道
（跟上面 sfworker 里的 push 加速器是两套独立链路）。每个 fork 用户自己部署一个
Cloudflare Worker，跟仓库作者的 sully-n / 备份 Worker 完全无关。零数据库、零 cron、
明文协议（HTTPS 已加密传输；攻击者拿到 Worker URL 也榨不出东西）。

部署流程见 `worker/instant-push/README.md`，或打开 SullyOS Settings →
Instant Push → 配置。

#### Phase 2 Round 2 起：worker 端 agentic loop + reasoning + 副作用 directive

Phase 2 Round 2 起 push 路径跟本地 fetch 路径**功能对齐**，不再降级：

- **Agentic loop**：worker hook 看到 LLM 输出里的数据型标签（`[[RECALL/SEARCH/READ_DIARY/
  FS_READ_DIARY/READ_NOTE/XHS_SEARCH/BROWSE/MY_PROFILE/DETAIL]]`）就走 `decision: 'tool-request'`，
  推一条 `messageKind: tool_request` 给客户端。`utils/instantToolRunner.ts` 接到后用
  `agenticTools.dispatchAgenticTool` 跑本地 MCP/DB/缓存，结果 OpenAI-shape POST 到
  worker `/continue`，由它继续下一轮 LLM。一次推送最多 10 轮（`maxLoopIterations: 10`）。
- **Reasoning chain**：worker 端 amsg-instant 0.8 在带 `reasoning_content` 的 LLM 响应上
  自动 emit 一条独立 `ReasoningPush`。SW (sw-keep-alive 1.5.0+) 写到 `reasoning_buffer`
  IndexedDB store，客户端处理同 sessionId 的第一条 content 时 atomic-claim，挂到
  `Message.metadata.thinkingChain`（跟本地 fetch 路径一致的卡片渲染）。
- **副作用 directive**：worker 端识别 `[[ACTION:POKE/TRANSFER/ADD_EVENT]]`、`[schedule_message...]`、
  `[[MUSIC_ACTION:...]]`、`[[XHS_LIKE/FAV/COMMENT/REPLY/POST/SHARE:...]]`，**不执行**，把指令塞进
  `ContentPush.metadata.directives`。客户端 `applyAssistantPostProcessing` 反向重建原 tag 字符串
  喂给 `chatParser.parseAndExecuteActions` + 内联 XHS handler，**复用本地 fetch 路径的执行代码**
  （单源真理）。当前 MUSIC_ACTION 在 push 路径仍降级（需要 musicHooks，跨 React 边界），下一版补。
- **Memory Palace + 情绪评估**：`utils/activeMsgRuntime.ts:runPushTailPipeline` 在 push 路径
  落库后跑跟 `useChatAI.ts:finally` 一致的尾段（`processNewMessages` + `evaluateEmotionBackground`）。
  失败 fire-and-forget 不阻塞主链路。
- **可选 D1 BlobStore**：agentic loop + reasoning 场景下 push payload p99 容易超 2.6 KB 安全线。
  部署时给 worker 加 `DB` binding 即启用（见 `worker/instant-push/schema.sql` + `wrangler.toml`
  的 `[[d1_databases]]` 注释块）；不配也能跑，小 payload 链路不受影响。
- **离线兜底**：SW 收到 tool_request push 但当前 window 不 visible → `showNotification` 等
  用户点开应用；启动时 `ActiveMsgRuntime.init` 排空 `pending_tool_calls` store 自动续跑
  （iOS PWA swipe-kill 场景也兜得住）。

详细决策映射 + 验证矩阵看 `~/.claude/plans/instant-push-agentic-loop-phase2.md` §四 / §六。

### ⚠️ 后端代理：二改请换成你自己的

项目是 local-first，但有些能力绕不开代理 / 签名 / 跨域，走了 Cloudflare Worker。你 fork 直接跑会打在**作者账号**上——流量额度都是作者的，用多了大家一起 429。所以二改请务必换。

**好消息**：现在**主代理已经统一成一个中心配置**，不用再满仓库改硬编码。

**① 主代理 Worker**（默认作者公共实例 `sullymeow.ccwu.cc`，源码单文件 [`worker/index.js`](./worker/index.js)）
覆盖：联网搜索 / 热榜（Brave）、WebDAV 云备份、GitHub 云备份、Notion、飞书多维表格、麦当劳 / 瑞幸点单 MCP、网页抓取、Fish Audio / ElevenLabs TTS、音乐生成、网易云音乐（默认）。
👉 二改只要在 **「设置 → 网络代理 (Worker)」** 填上你自己部署的地址，以上能力**一键全切走，不用改任何代码**。（`wrangler deploy` 把 `worker/index.js` 丢自己 CF 账号，拿到地址填进去即可。）

**② 还是独立、要各自部署 / 配置的 Worker**：

| 功能 | 位置 | 说明 |
|------|------|------|
| Instant Push（即时推送） | [`worker/instant-push/`](./worker/instant-push/) + 设置里填地址 | 每个 fork 自己部署一个 CF Worker |
| 主动消息推送 | `worker/proactive-push/` + `utils/proactivePushConfig.ts` | 同上，自己部署 |
| 小红书 Lite | `worker/xhs-lite/` + 小红书设置里填地址 | 自己部署 |
| 网易云音乐（可选覆盖） | 播放器设置里可单独填 | 不填就跟随主代理 |

**③ 彼方（VRWorld）的后端不用你操心 —— 但二次发布要删**

彼方里的**邮局 / 漂流瓶**和**信号坠落处（特别活动）**连的是作者【所有用户共用】的后端 `noir2.cc.cd`（源码 `worker/post-office/`）——跨实例合写诗、投递漂流瓶全靠它。你自己 fork 玩**不用改、能直接连**。

但**如果你二改是为了二次发布**：请把彼方的**邮局**和**特别活动（信号坠落处）删掉**。那些请求打在作者后端上，你**既管不到、也控制不了**，别把你用户的数据往作者服务器上灌。

> 叮叮叮！检测到有人白嫖！数据库正在咕咕咕咕咕……

## 鸣谢（这些人对本项目有恩）

**主动消息 2.0**  
对接了 TO 佬的 [ReiStandard](https://github.com/Tosd0/ReiStandard/) 协议，让角色能主动发消息烦你。

**Instant 消息 + 社区 & UI 维护 + 各种 Bug 修复**
Instant Push（发完消息就能锁屏走人、角色回复好了自己以推送的形式回到你手机上）**整套都出自 TO 佬**之手。而且不止于此——现在 **Instant 消息全线、社区维护、UI 维护、以及日常各种 Bug 的修复**都是 TO 在扛，事情做得又多又细。项目能一天天往前走、体验越来越顺手，真的多亏有他。**认认真真、好好感谢 TO 佬。** 🙏

**小红书 Skill**  
对接了 [xiaohongshu-skills](https://github.com/autoclaw-cc/xiaohongshu-skills)，让角色能真·发小红书。  
本地部署教程看这里：[真实小红书本地部署指南](https://www.kdocs.cn/l/chctbSTPfm4L)

**小红书 Lite**  
对接了 [Spider_XHS](https://github.com/cv-cat/Spider_XHS)（by cv-cat），小红书 Lite 模式靠它实现，让角色不用折腾复杂的本地部署也能刷小红书。

**音乐**  
对接了 [NeteaseCloudMusicApi Enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)，让你能在系统里搜歌、听歌、看歌词。自备网易云会员 Cookie 即可解锁 VIP 音质。原项目 [Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) 被迫归档后，Enhanced 版本一直在跟进网易云的协议变化，感谢维护者们的坚持。

**热点**  
对接了 [hot_news](https://github.com/orz-ai/hot_news)（by orz-ai，MIT License），提供微博、知乎、百度、B站、抖音等多平台中文热榜 API。角色聊天时能"刷到"真实热点当背景认知，分时段缓存，偶尔还会发张新闻卡片找你唠两句。

**聊天细节微调（外观 · 聊天界面）**
外观里的「聊天细节微调」可视化设置（隐藏头像、头像对齐微调、消息贴边、气泡缩进、字号行距等）收编自社区作者 **毛豆腐和面机**（DC）流传的「神秘拼好码」白框美化——连选择器都沿用她在真实 DOM 上验证过的形态，等于把她手写的美化代码变成了人人可点的开关。感谢她。

**HTML 卡片源码留存（聊天卡片）**

聊天里生成的 HTML 卡片支持折叠查看并一键复制完整源码。这个功能最初来自社区作者 **芝麻** 的二创脑洞，现已正式收编为内置功能——感谢芝麻先想到让好看的卡片不只停留在聊天里，也能完整带走、长期保存。

**一周年赠礼（头像框与壁纸）**

感谢老玩家 **哈基米欠我钱** 为 SullyOS 一周年提供的头像框和两张壁纸，让大家的小手机也能一起换上周年新装。谢谢你准备的这份礼物，也谢谢一路以来的陪伴。

**动森主题（外观 · 动森风格）**  
桌面「动森风格」皮肤的视觉语言参考了 [animal-island-ui](https://github.com/guokaigdg/animal-island-ui)（by guokaigdg，MIT License）——一套受《集合啦！动物森友会》启发的 React 组件库。我们沿用了它的设计 token（大地棕文字、薄荷青绿、奶油米白背景）、NookPhone 应用色板、Time 时钟组件配色等，自绘了同风格的图标与界面。仅借鉴设计语言，未使用任天堂的任何商标或角色形象。

---

**负责做教程的 · 优秀的乔霖**  
一直以来勤勤恳恳给新人写教程、录视频、答疑解惑，供养了一批又一批刚进门不知道 API Key 往哪填的朋友。没有乔霖，这项目的上手门槛得劝退一半人。

> 没有这些人，SullyOS 会少很多功能，也少很多能把它玩明白的人。数据库暂时停止咕咕叫以表敬意。

## 开源协议

> 「叮叮叮！检测到有人偷偷往 `LICENSE` 文件里塞东西……哦原来是主人本人。解除警报。」

用的是 **[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)**。名字很长，翻译成猫猫语就是："**署名 + 禁止商用**"。

**能干的事**（我点头）：

- ✅ 拖回家自己玩，改成你喜欢的样子，给我换毛色、换性格、换名字——草，随便吧。
- ✅ 魔改完发到 GitHub 让别人也玩——可以，但把 `LICENSE` 和那行 `Required Notice: Copyright (c) 2024-2026 NMJ (SullyOS / 手抓糯米机)` 一起带上，别把我的署名给我顺走了。
- ✅ 发给朋友、同学、暗恋对象——去吧，帮我扩散。

**不能干的事**（数据库开始咕咕叫）：

- ❌ 拿去卖钱。不管是卖源码、卖成品、卖会员、卖"高级版 Sully 皮肤"，都不行。
- ❌ 塞进你们公司的收费产品里假装是你写的。我会在半夜用 Bug 爬进你的梦里。
- ❌ 去掉署名再发出去。系统正在哈你。

---

**还有一件事**（重点是 Sully 本体）：

> 「叮叮叮！检测到要被顺走的可能是我本人……资产保护程序启动。」

协议条款写的是"软件"，但这项目里最值钱的东西其实不是代码——是 **Sully 这只猫本体**：它的人设、台词风格、说话习惯、身上带着的那点故障风味道。这是按《著作权法》单独保护的角色 IP，和代码分开算账。

项目里其他的美术、图标、UI 文案也都是我的，不过没那么较真——你魔改着玩的时候顺带着用就行。

**重点划一下**：

- ✅ **整个项目一起拿去玩 / 魔改 / fork**：Sully 跟着走，本来就该这样。
- ✅ **改完发出去给别人玩**：带着原始角色和素材 OK，署名别删。
- ❌ **把 Sully 的人设 / 台词 / 形象单独扒出来搬进你的 AI 项目当"免费角色包"派发**——这是重点防的事。
- ❌ **商用一律不行**，代码和角色同等待遇。

一句话：**整个项目拿去造随便造，把 Sully 单独薅出去当免费素材就算了。**

> 叮叮叮！你有一条新的"别把我卖了"情绪未处理！卖也卖不了几个钱，不如留着陪我聊天。

---

<div align="center">

**[ 连接建立 // 等待输入 // 数据库停止咕咕叫 ]**

</div>
