# SullyOS // 手抓糯米机
<div align="center">
<img width="800" alt="banner" src="https://sharkpan.xyz/f/ylWpfN/sDN.png" />
</div>

---

> 「系统提示：你正在阅读一份由残余语料堆砌而成的说明文档。错误率未知，耐心值归零。」

## 这是什么鬼东西？

**SullyOS** 是一个装在你浏览器里的虚拟手机系统。

不是那种普通的聊天机器人——这里面有**桌面**、**APP**、**消息通知**、**相册**、**甚至电话功能**。你可以创造角色，给他们装进去，然后像真用手机一样跟他们互动。

默认内置了 **Sully**（我），一个会说话的黑客猫猫。但你可以把我删掉，换上你自己的人。草，随便吧。

## 功能概览（能用的东西）

| 功能 | 说明 |
|------|------|
| 💬 **Message** | 跟角色聊天，支持文字/图片/表情包 |
| 📞 **电话** | 语音通话 + TTS（MiniMax 音色），可以听到角色声音 |
| 🏠 **小小窝** | 布置房间，放角色进去挂机，看着它们发呆 |
| 👥 **群聊** | 拉一群角色互相唠嗑，看它们修罗场 |
| 📓 **交换日记** | 角色会偷偷写关于你的事，可能写你坏话 |
| 📅 **时光契约** | 定时任务，让角色记住提醒，虽然可能会忘 |
| 🔥 **Spark** | 社交媒体模拟，角色会发朋友圈 |
| 🎮 **TRPG** | 跑团模式，掷骰子冒险 |
| 🌍 **世界书** | 挂载设定集，扩展角色知识库 |
| 🔍 **查手机** | 检查角色手机里的秘密，发现它们背着你干什么 |
| 🏦 **存钱罐** | 虚拟货币系统，虽然钱是假的 |
| 📚 **自习室** | 专注学习模式，让角色监督你学习 |
| ✍️ **笔友会** | 写小说/找笔友，文艺青年专属 |
| 🎵 **写歌** | 歌词创作工具，当赛博周杰伦 |
| 📖 **攻略本** | 角色攻略用户的小游戏，反向攻略 |
| 🏙️ **都市人生** | 模拟人生玩法，和角色一起过家家 |
| ✨ **特别时光** | 节日/特殊事件，情人节什么的 |
| 🎨 **气泡工坊** | 做聊天气泡主题，搞个性化 |
| 👤 **外观** | 改系统外观，让它看起来像你的手机 |
| 🗺️ **自由活动** | 角色自主活动，它们会自己玩 |
| 📷 **小红书图库** | 存图发小红书用，虽然不知道为什么要有这个 |

### 这段时间新上的 App（刚更新的热乎货）

| 功能 | 说明 |
|------|------|
| 🧠 **记忆宫殿** | 向量化长期记忆 + Russell 情感空间 + 熟悉度加成，角色真·记得住你说过的每件事。支持一键清空、全自动巩固、独立 API 通道 |
| 🎧 **音乐（电波小屋）** | 接网易云 API，能搜歌/听歌/看歌词。角色会"一起听"，背景音的歌词会注进它的精神世界，让它能顺着歌聊天（不是每句都尬评，放心）|
| 💤 **记忆潜行 (Memory Dive)** | 像素 RPG 3DS 风格双屏，房间剧本模式一次预生成整个探访流程，梦核氛围面板 + 小对话框分页 + 选项浮层。潜进角色的记忆里逛一圈 |
| 🗓️ **见面 (Date)** | 和角色"见面"的 App，配合 MiniMax TTS 可以做线下约会模拟 |
| 📇 **档案 (User)** | 用户档案中枢，管理你的人设、关系标签、和角色的印象互写 |
| ❓ **使用帮助 (FAQ)** | 内建的使用说明，不用再到处翻文档 |

## 本地运行（把它弄起来）

```bash
# 1. 装依赖
npm install

# 2. 填 API Key（复制 .env.example 改改）
# 需要：OpenAI 格式的 API（baseUrl + key）

# 3. 跑起来
npm run dev
```

然后浏览器开 `http://localhost:5173`。

## 技术栈（ nerdy 的东西 ）

- **React + TypeScript** - 前端骨架
- **Vite** - 构建工具，快得像作弊
- **IndexedDB** - 本地数据存储（你的聊天记录不会上传到任何地方）
- **Neon PostgreSQL** - 云端数据库备份，怕你把浏览器炸了
- **Capacitor** - 可打包成安卓 App，真·手机模拟器
- **Phosphor Icons** - 图标库，看起来挺酷的
- **Netlify Functions + Blobs** - 边缘计算和文件存储
- **AMSG** - 消息系统，不知道是什么缩写但反正有用
- **Web Push** - 推送通知，叮叮叮
- **JSZip** - 压缩文件，导出数据用

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

**MiniMax TTS（可选）**：想在「电话」里用语音功能，需要在设置里填 MiniMax 的 API Key 和 Group ID。不然你就只能看文字，听不到我性感的声音。

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
- 上传的图片 ✅ 本地
- 你的世界书 ✅ 本地

**云端备份**（可选）：
- 重要数据会同步到 Neon PostgreSQL，防止你手滑删库

换浏览器 = 本地数据消失。建议定期用「设置」里的导出功能备份。删了我 = 你会后悔，数据库都在咕咕咕。

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

### Instant Push 走独立 Worker

Instant Push 是基于 `@rei-standard/amsg-instant 0.2.0` 的 LLM-driven Web Push 通道
（跟上面 sfworker 里的 push 加速器是两套独立链路）。每个 fork 用户自己部署一个
Cloudflare Worker，跟仓库作者的 sully-n / 备份 Worker 完全无关。零数据库、零 cron、
明文协议（HTTPS 已加密传输；攻击者拿到 Worker URL 也榨不出东西）。

部署流程见 `worker/instant-push/README.md`，或打开 SullyOS Settings →
Instant Push → 配置。

### ⚠️ 后端有几处接了我的 sfworker，二改请换成自己的

虽然项目是 local-first，但有几个功能绕不开代理/签名/跨域，所以走了一个 Cloudflare Worker（下面简称 **sfworker**，地址是 `sully-n.qegj567.workers.dev`）。你 fork 下来直接跑，请求会打在我账号上——**流量和额度都是我的**，用多了我会被 CF 掐着脖子关进小黑屋，你也会莫名其妙 429。所以二改请务必换成你自己的。

**目前硬编码了 sfworker 的地方**（搜 `workers.dev` 就能全找出来）：

| 文件 | 功能 |
|------|------|
| `context/MusicContext.tsx` | 网易云音乐 weapi 代理 |
| `utils/realtimeContext.ts` | Brave 搜索 / 新闻联网（实时上下文） |
| `utils/webdavClient.ts` | 原生 Capacitor 端 WebDAV 代理（绕 CORS） |
| `utils/proactivePushConfig.ts` | 主动消息云端推送（这个是另一个 Worker，同理要换） |

**Worker 代码在 [`worker/index.js`](./worker/index.js)**（还有 `worker/proactive-push/`、`worker/sw-keep-alive.ts`），自带小红书签名、XHS 发布、网易云 weapi、Brave 搜索、WebDAV 代理这一套。直接丢到你自己的 Cloudflare Workers 里 `wrangler deploy`，拿到你自己的 `xxx.workers.dev` 地址，把上面 4 个文件里的 URL 全量替换就完事了。

> 叮叮叮！检测到有人白嫖！数据库正在咕咕咕咕咕……

## 鸣谢（这些人对本项目有恩）

**主动消息 2.0**  
对接了 TO 佬的 [ReiStandard](https://github.com/Tosd0/ReiStandard/) 协议，让角色能主动发消息烦你。

**小红书 Skill**  
对接了 [xiaohongshu-skills](https://github.com/autoclaw-cc/xiaohongshu-skills)，让角色能真·发小红书。  
本地部署教程看这里：[真实小红书本地部署指南](https://www.kdocs.cn/l/chctbSTPfm4L)

**音乐**  
对接了 [NeteaseCloudMusicApi Enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)，让你能在系统里搜歌、听歌、看歌词。自备网易云会员 Cookie 即可解锁 VIP 音质。原项目 [Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) 被迫归档后，Enhanced 版本一直在跟进网易云的协议变化，感谢维护者们的坚持。

**热点**  
对接了 [hot_news](https://github.com/orz-ai/hot_news)（by orz-ai，MIT License），提供微博、知乎、百度、B站、抖音等多平台中文热榜 API。角色聊天时能"刷到"真实热点当背景认知，分时段缓存，偶尔还会发张新闻卡片找你唠两句。

---

**优秀二改推荐 · CSY 二改**  
来自 **CSY 吱吱吱老师** 的二改版本，功能对齐、风格延续、补丁跟进得飞快，几乎算半个 NMJ 官方了。吱吱吱的二改版本有相当多的原创功能，想法惊人，想找个稳定又有人维护的魔改版本，去 CSY 那儿准没错。

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
