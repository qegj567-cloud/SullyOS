# SullyOS·糯米机
<div align="center">
<img width="800" alt="banner" src="https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/sDN.png" />
</div>

---

> 「系统提示：你正在阅读一份由残余语料堆砌而成的说明文档。错误率未知，耐心值归零。」

## 这是什么鬼东西？

**SullyOS·糯米机** 是一个装在你浏览器里的虚拟手机系统。

> **源码可见，非开放源代码授权。** 源码公开供学习与参考；二改授权通过官方 DC 社区提供。社区不定期开放，请以官方公告为准。请勿向社区外转发服务入口、邀请信息或下载资源。详见 [许可](LICENSE) 与 [社区授权说明](docs/community-authorization.md)。

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

## 本地运行（学习测试 / 已获授权的部署）

以下步骤仅供在 [LICENSE](LICENSE) 或社区额外授权允许的范围内使用；技术上可以运行不代表取得对外分发或使用官方后端的权限。

```bash
pnpm install
pnpm dev
```

然后浏览器开 `http://localhost:5173`。API Key 不用在这填——进去在**应用内「设置」**里填就行（见下方「配置说明」）。

## 技术栈（ nerdy 的东西 ）

- **React + TypeScript** - 前端骨架
- **Vite** - 构建工具，快得像作弊
- **IndexedDB** - 本地数据存储（聊天记录不会上传到任何地方），图片二进制走 **Blob** 存储省配额
- **Cloudflare Workers** - 联网能力的代理层（搜索 / 云备份 / 点单 MCP / 微博等），入口 `worker/index.js`，可打包为单文件自托管
- **Capacitor** - 可打包成安卓 App，真·手机模拟器
- **Phosphor Icons** - 图标库，看起来挺酷的
- **AMSG（ReiStandard）** - 主动消息协议
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

ElevenLabs 新配置默认使用 Eleven v4，也可选择 v4 Turbo。聊天、电话与见面保留 v4 的情绪、音效、节奏 Audio Tags 和 IPA 发音；v4 不支持数值语速、Style、Speaker Boost 或 SSML，当前仍等待完整音频后播放。接入能力与限制见 [ElevenLabs 语音说明](docs/elevenlabs-tts.md)。

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

以下内容供学习实现及已获社区二改授权的成员参考，不构成修改或二次发布的额外授权。官方代码库仅由指定开发者维护，目前不接受未经邀请的 PR。

如果你已获授权、想在这个基础上加功能，先看这几句话：

### 记忆系统已经做好了，别重复造轮子

**所有角色的长期信息**（人设、精炼记忆、印象档案、世界观书）通过 `ContextBuilder.buildCharacterRequest({ char, user }, messages)` 在请求前统一组装，返回完整的消息数组，包含：

- 角色基础设定（systemPrompt + worldview）
- 用户档案（你的名字、人设、关系标签）
- 精炼的月度记忆摘要
- 角色对你的印象档案（MBTI分析、喜好、情绪波动）
- 挂载的世界书内容

**短期记忆**（最近聊天记录）直接走正常的 message history，和上面那段长期上下文一起塞进 API 请求。

ContextBuilder 读取当前角色档案中的记忆与召回结果；消息范围和记忆宫殿召回仍须遵守 [记忆系统契约](docs/memory-system-overview.md)，不会自动读取全部数据库。挂载世界书的触发、顺序、深度和消息角色由公共管线处理，详见 [世界书管线](docs/worldbook-management.md#全-app-世界书构建管线)。

### 想加新 App？

1. 在 `apps/` 里新建一个 `YourApp.tsx`
2. 在 `types.ts` 的 `AppID` 枚举里加个 ID
3. 在 `constants.tsx` 的 `INSTALLED_APPS` 数组里注册（图标、名字、颜色）
4. 在 `App.tsx` 的 `renderApp()` 里加 case
5. 涉及角色生成时，使用下面的统一请求入口。不要自行拼世界书，也不要将完整历史压成一段字符串后声称支持消息深度。

```ts
const messages = ContextBuilder.buildCharacterRequest(
  { char, user: userProfile },
  [
    { role: 'system', content: appInstructions },
    ...sceneHistory, // 本场景已筛选、已转换好的实际消息
    { role: 'user', content: userInput },
  ],
);
// 将 messages 直接作为 API 请求的 messages；无需任何世界书专用代码。
```

单次生成传一条任务消息即可。多人/自定义预设布局见世界书文档；旧 `buildCoreContext` 是文本兼容接口，新 App 不使用它。运行 `pnpm vitest run utils/contextPipeline.test.ts utils/contextWorldbook.test.ts` 检查管线契约。

UI 风格参考现有的 Tailwind + glassmorphism。

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
| **记录 LLM 日志** | 捕获 | 勾上就录制所有 LLM 请求/响应。密钥字段自动 `<redacted>` 不用手动打码。以后想抓别的（MCP 调用之类）就再加一个捕获类，互不串桶 |

捕获日志同时写 `localStorage` 和内存，各类混存、全局最多保留 100 条 / 1 MB（先到先淘汰）。为了省空间 / 隐私，**长文本默认写入时就折叠成前 10 字 + `...`**（那堆 system prompt 和聊天历史不会塞满 localStorage）；真要看完整请求体，打开「记录完整内容」开关再复现一次。录完可以**一键复制成 JSON** 或**下载成文件**丢给别人 debug，导出会自动带上当前分支和 commit hash，方便定位"到底是哪个版本炸的"。

**注意**：跟 build badge 一样，这整套调试 UI 走的是 Vite `define` 编译时注入。在 `main` / `master` 上 `npm run build` 出来的产物里，`DevDebugPanel` 组件连同相关代码会被 esbuild 整棵树摇掉，不会出现在生产包里。换句话说——**用户永远看不到这个扳手，除非你故意在 release 分支 `VITE_SHOW_BUILD_BADGE=1`**。

> 想加新开关 / 加 debug-only 日志？照着 [`docs/dev-debug.md`](./docs/dev-debug.md) 抄就行，里面有逐步指南和容易踩的坑。

> 叮叮叮！调试面板不会让你的 Bug 自动修好，但至少能让你知道 Bug 在哪。大概。

### 聊天上云走主动消息 2.0

聊天回复想「发完就能锁屏走人」，走的是主动消息 2.0 的即时对话：每个用户自己部署一个 Cloudflare Worker（`worker/amsg/`），回复在 Worker 上生成，再以 Web Push 送回手机。设计与端点契约见 [`plans/amsg2-instant-chat.md`](./plans/amsg2-instant-chat.md)、[`plans/amsg2-instant-chat-contract.md`](./plans/amsg2-instant-chat-contract.md)。

- **工具在 Worker 里跑**：回忆、搜索、读日记、小红书这类数据标签由 Worker 就地执行，客户端不在线也能跑完（`worker/amsg/src/agentic.ts` + `classifier.ts`）。
- **副作用只识别不执行**：戳一戳、转账、日程、音乐、小红书点赞这类标签，Worker 结构化成 directives 挂在最后一条推送上；客户端收到后由 `applyAssistantPostProcessing` 重放，复用本地聊天那套执行代码。
- **收侧与本地聊天对齐**：推送落库后，`utils/activeMsgRuntime.ts` 的 `runPushTailPipeline` 跑跟本地聊天一致的尾段（记忆宫殿等）。

### ⚠️ 后端代理：二改请换成你自己的

项目是 local-first，但有些能力绕不开代理 / 签名 / 跨域，走了 Cloudflare Worker。你 fork 直接跑会打在**作者账号**上——流量额度都是作者的，用多了大家一起 429。所以二改请务必换。

**好消息**：现在**主代理已经统一成一个中心配置**，不用再满仓库改硬编码。

**① 主代理 Worker**（默认作者公共实例 `proxy.friedsully.com`，源码入口 [`worker/index.js`](./worker/index.js)）
旧公共域名 `sullymeow.ccwu.cc` 保留兼容；更新后，中心代理、音乐和小红书保存的旧公共地址会自动迁移，用户自建地址不变。这次只调整后端代理入口，不搬前端网站或浏览器本地数据。详见 [代理域名迁移](docs/proxy-domain-migration.md)。
覆盖：联网搜索 / 热榜（Brave）、WebDAV 云备份、GitHub 云备份、Notion、飞书多维表格、麦当劳 / 瑞幸点单 MCP、网页抓取、Fish Audio / ElevenLabs TTS、音乐生成、网易云音乐（默认）、哔哔微博扫码与主页/关注流读取。哔哔 TikHub 付费导入已停用，旧 `/tikhub` 路由更新 Worker 后返回 410。
👉 二改只要在 **「设置 → 网络代理 (Worker)」** 填上你自己部署的地址，以上能力**一键全切走，不用改任何代码**。可直接复制完整的 `worker/index.js` 到 CF 的 ES Module Worker，也可用 Wrangler 部署；它是无外部模块依赖的单文件。微博与网易云一样由用户各自扫码、凭据保存在浏览器，公共 Worker 仅随请求转发，不需要会话 Secret 或额外存储服务。普通用户使用公共代理无需部署。详见 [哔哔微博与隐私、部署说明](docs/friend-feed-weibo.md)。

**② 还是独立、要各自部署 / 配置的 Worker**：

| 功能 | 位置 | 说明 |
|------|------|------|
| 主动消息 2.0（含即时对话） | [`worker/amsg/`](./worker/amsg/) + 设置里一键部署或填地址 | 每个用户自己部署一个 CF Worker，教程见 [`docs/amsg2-setup-walkthrough.md`](./docs/amsg2-setup-walkthrough.md) |
| 主动消息推送 | `worker/proactive-push/` + `utils/proactivePushConfig.ts` | 同上，自己部署 |
| 小红书 Lite | `worker/xhs-lite/` + 小红书设置里填地址 | 自己部署 |
| 网易云音乐（可选覆盖） | 播放器设置里可单独填 | 不填就跟随主代理 |

**③ 彼方（VRWorld）的后端不用你操心 —— 但二次发布要删**

彼方里的**邮局 / 漂流瓶**和**信号坠落处（特别活动）**连的是作者【所有用户共用】的后端 `noir2.cc.cd`（源码 `worker/post-office/`）——跨实例合写诗、投递漂流瓶全靠它。你自己 fork 玩**不用改、能直接连**。

**二改授权不包含二次发布或使用官方后端承载第三方流量的权限。** 若你已另获对外发布的书面许可：请把彼方的**邮局**和**特别活动（信号坠落处）删掉**。那些请求打在作者后端上，你**既管不到、也控制不了**，别把你用户的数据往作者服务器上灌。

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

**森间手记主题（外观 · 森间手记）**
桌面「森间手记」皮肤的视觉语言参考了 [animal-island-ui](https://github.com/guokaigdg/animal-island-ui)（by guokaigdg，MIT License）——一套受《集合啦！动物森友会》启发的 React 组件库。我们沿用了它的设计 token（大地棕文字、薄荷青绿、奶油米白背景）、NookPhone 应用色板、Time 时钟组件配色等，自绘了同风格的图标与界面。仅借鉴设计语言，未使用任天堂的任何商标或角色形象。

---

**负责做教程的 · 优秀的乔霖**  
一直以来勤勤恳恳给新人写教程、录视频、答疑解惑，供养了一批又一批刚进门不知道 API Key 往哪填的朋友。没有乔霖，这项目的上手门槛得劝退一半人。

> 没有这些人，SullyOS 会少很多功能，也少很多能把它玩明白的人。数据库暂时停止咕咕叫以表敬意。

## 源码可见与使用授权

本项目采用 **[SullyOS 源码可见许可 1.0](LICENSE)**，是项目专用的有限
授权许可，不是开放源代码许可证。源码公开供个人非商业学习、研究和
参考，不代表授予修改、再分发或使用官方在线服务的权限。

- **学习参考**：可查看源码，并在许可范围内保存副本、构建和运行未经修改的版本用于个人学习研究。
- **二次修改**：授权通过官方 Discord（DC）社区提供；符合官方公布的条件后，按授权范围修改和部署自用。社区不定期开放，请以官方公告为准。
- **对外发布**：二改授权不包含发布修改版、分发源码包或 APK、制作整合包、运营镜像或托管服务。这些行为须另获明确书面许可，免费也一样。
- **服务与传播**：官方服务受资源与容量限制。请勿向社区外转发访问入口、邀请信息或下载资源，也请勿自行组织对外推广、代发安装包或建立镜像。
- **商业用途**：默认不授权。保留署名或标注“非官方”不能替代所需许可。
- **原创资源**：Sully 等角色的具体设定文本、台词、美术、模型等资源，仅在已获授权范围内随项目使用，不默认授权单独提取、移植或分发。第三方资源遵循各自许可。

代码许可与服务资格分开：取得二改授权不附带官方后端的使用额度；未经
单独许可，须换用自己的后端或禁用相应功能，不得让第三方用户消耗作者资源。

新许可从首次纳入该许可的官方仓库提交起适用于采用它发布的版本；旧版
已授予的权利仍按旧许可处理。平台条款授予的 GitHub 内查看、Fork 权限
及第三方独立许可不受替代。详见 [LICENSE](LICENSE) 和
[社区授权与服务入口说明](docs/community-authorization.md)。

关于标准许可的取舍：已评估 [PolyForm Strict 与 Shield](docs/license-evaluation.md)。现有授权边界不因这份评估而改变，当前仍以 LICENSE 为准。

---

<div align="center">

**[ 连接建立 // 等待输入 // 数据库停止咕咕叫 ]**

</div>
