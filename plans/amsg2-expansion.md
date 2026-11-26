# 主动消息 2.0 · 云端生成：把更多 LLM 调用搬到云端

目标与红线见 [主动消息 2.0 总纲](../docs/amsg2-overview.md)。

已经跑在用户自己的 CF Worker 上的有：私聊（即时对话）、情绪评估、门牌整理、离开后消息、见面离开提醒。这份记的是：其余 LLM 调用点怎么搬、按什么顺序搬、哪些不搬，以及用户怎么知道「这次可以切出去了」。

> 调用点的位置以 2026-11-24 的 dev（`bf098706`）为准，行号会漂，动手前先 grep 一遍。

---

## 为什么要搬

在手机上，页面一离开前台，正在进行的请求基本保不住：

| 平台 | 切走之后 | 来源 |
|---|---|---|
| iOS（Safari 和主屏 App） | 请求断开，回到前台后报 `Load failed`；服务商那边多半照样生成完、照样计费，结果送不回来 | 用户报告：[vercel/ai#22083](https://github.com/vercel/ai/issues/22083)、[htmx#3634](https://github.com/bigskysoftware/htmx/issues/3634) |
| iOS 保活手段 | 没有。不支持 Background Fetch；Service Worker 在没有页面连着时很快被终止 | [caniuse](https://caniuse.com/mdn-api_serviceworkerregistration_backgroundfetch)、[WebKit](https://webkit.org/blog/8090/workers-at-your-service/) |
| Android Chrome | Chrome 139 起后台页面 1 分钟后冻结（分批灰度）；Android 15 上有一切走就中断的报告 | [chromestatus](https://chromestatus.com/feature/5386725031149568)、[SillyTavern#2690](https://github.com/SillyTavern/SillyTavern/issues/2690) |
| 电脑浏览器 | 后台标签只节流计时器，请求照常完成 | [Chrome 文档](https://developer.chrome.com/blog/timer-throttling-in-chrome-88) |

所以在本机跑、要好几秒的生成，切走就是白烧一次 API，回来还得重新点。iOS 具体在几秒后冻结没有公开数字。

页面里没有任何一个 LLM 调用点监听页面隐藏，也没有断点续跑；除了 3D 家园的自动社交回复会在页面隐藏时主动中止，其余都是被杀就丢。

### 收益怎么估

**收益 ≈ 生成时长 × 用户离开的概率。**

- 生成 3 秒的东西上云，收益接近零，成本照付。
- 生成 60 秒、且用户大概率已经切走的，收益最大。
- 用户必须当场看到结果才能继续的（通话），上云是负收益。云端只有异步一种形态，没有流式通道。

搬上云只对开了主动消息 2.0 的用户有用。2026 年 11 月的埋点里，开着 2.0 的设备约两成，开着即时对话的约 18%。没开 2.0 的用户保持现状：生成期间不能切走，这是大家已经习惯的行为，不额外提示。

---

## 两种上云方式

| | 本机拼、云端代跑 | 云端自己拼 |
|---|---|---|
| 适用 | 触发时页面开着（用户点了按钮、进了某个界面、一轮回复刚结束） | 触发时页面关着（到点主动消息、凌晨定时任务） |
| 提示词 | 本机照原样拼好完整请求，召回、世界书、上下文都在本机完成，整包交给 Worker | Worker 到点自己拼，拼提示词的代码要改成零浏览器依赖的叶子 |
| Worker 做什么 | 调模型、存结果，不理解业务 | 读云端状态、拼提示词、调模型 |
| 结果怎么落地 | 回到本机，由原来的解析和落库代码处理 | 视情况，在云端或本机 |
| 云端与本地一致 | 同一份代码拼的提示词，天然一致，不产生需要登记的差异 | 每一处差异都要登记 |
| 代价 | 每个入口：改发送口 + 写一个能在重开页面后执行的落地函数 | 依赖剥离通常占一半以上工作量，外加双路径维护 |

**能用代跑就用代跑。** 私聊的即时对话就是这种形态：本机拼好 `fullMessages` 上传，Worker 只负责生成。门牌整理和定时主动消息属于「云端自己拼」。

几乎所有调用点的提示词构建都绑着浏览器：`ContextBuilder`（`utils/context.ts`）要读日程、情绪、节日、定位，`injectMemoryPalace` 要对 IndexedDB 做向量召回和重排。这正是代跑划算的原因：这些代码一行都不用搬。

代跑有三条限制：

1. **交给云端之前切走照样会断。** 本机拼请求、上传的这段时间，页面还得开着。所以「可以切出去」的提示要等 Worker 确认收到才出现，跟私聊里「发送中」消失是同一个时刻。
2. **结果晚到时现场可能变了。** 用户可能已经手动重新生成、已经离开那场见面，或者数据被别的路径改过。每个入口的落地函数要判断这份结果还要不要。门牌整理的快照时间、在飞记号和已落地底账是现成的样板（见下文「已上云：门牌整理」）。
3. **只覆盖触发时页面开着的入口。** 凌晨自动生成日程这类，仍然只能走「云端自己拼」。

---

## 代跑任务的设计

### Worker 侧

| 改动 | 说明 |
|---|---|
| 新增代跑任务种类 | `worker/amsg/src/fireKinds.ts` 里的 `cloud-gen`：从独立命名空间 `amsg:cloud-gen` 读出本机传上来的消息，原样交给模型；结果一律存附件（`storeAttachment`），`emitResult` 只带引用，不按大小分支 |
| 推送开关 | 任务上带一个「完成时是否通知」的标记，handler 据此决定 `notification.show`。关掉的只进收件箱、不推送，符合总纲「不想弹的压根不推」 |
| 立刻开跑 | 代跑任务和即时对话一样建成 `messageType: 'instant'`，落库就回 202，起跳器马上开跑（见下文「立刻开跑：上游 instant」）。用户可以在功能总览关掉「后台任务」（即 cron），而起跳器叫不醒时任务只能等 cron，所以客户端看响应里的 `dispatch`：不是 `kicked` 就撤回任务、在本机生成（交任务时页面一定开着）。代跑种类不做生成重试，失败了交给用户或下次触发重来，也就不靠 cron 捞重试 |
| 排队分组 | 调度器的串行分组键是 `charId#kind`，代跑要再带上用途。上游的分组串行跨调用也生效：同组已有一条在跑时，起跳器那一跳领不到租约，任务原样留着等下一跳 cron。所以同一角色同一用途同时只交一份（客户端在飞登记表把关），不同用途分开排，一次 24000 token 的人格模拟就堵不住日程 |
| 消息内容类型 | `KindFirePlan` 的 `content` 现在只收纯文本，见面这类带图的入口要扩成数组 |
| 不做的 | 不改 D1 表结构，不给 `message_type` 加枚举值，不加任务生命周期 hook |

改了 `worker/amsg/src` 要重打 bundle 并推进 `utils/amsgBundleVersion.ts`；Worker 先部署，前端再用。

### 客户端侧

| 改动 | 说明 |
|---|---|
| 在飞登记表 | 本地持久化，关掉重开还在。每条记：用途、角色、交出时间、读快照的时间、落地需要的上下文 |
| 结果分发 | `utils/amsgResults.ts` 加一个 `resultKind`，按用途派给各入口的落地函数。落地函数自己锁自己那份数据（全局分发队列 60 秒超时只放行不取消，不能当数据安全的依靠）；留一本已落地底账防重放，同一份结果会到达不止一次 |
| 凭据 | 按这个入口实际使用的那套 API 整套上传（主 API、记忆副 API、见面独立 API、彼方独立线路等）。那套没配齐就不上云，不回落到别的 API 冒充 |
| 参数 | 本机请求体里的温度、输出上限、思考参数，云端原样带上（`scheduleBackgroundJob` 的 `extraBody` 进 `llmExtraBody`） |
| 调用记录 | 照门牌整理那样，在「设置 → API 调用记录」里记一条云端调用，结果回来补上 usage |
| 路由 | 2.0 总开关 + 这个功能的「云端生成」开关 + 体检接口报的 Worker 能力。想上云却转了本地的，按总纲「回退本地」那节登记、标明、留 trace |
| 联动检查 | 每接一个入口按 `AGENTS.md`「每次改动的联动检查」过一遍，尤其是使用统计 |

---

## 代跑基建

日程、人格模拟、梦境共用的那一套。接一个新入口只需要两处：在入口的发送口调 `trySubmitCloudGeneration`，再写一个落地函数。

### 一次代跑怎么走

1. 入口照原样拼好请求（`buildCharacterRequest` 的输出、温度、输出上限），调 `utils/cloudGen/submit.ts` 的 `trySubmitCloudGeneration`。
2. 过门：这套 API 配齐 → 2.0 开着 → 这个功能的「云端生成」开着 → Worker 的 `/config-check` 报 `cloudGen` 和 `instantBackground` → 这个角色这个功能没有在飞的。Worker 问不到时先看在飞（同门牌整理）。
3. 发请求之前先在在飞登记表记一条 running，并在 API 调用记录里挂一笔「云端生成中」。任务的 uuid 由客户端先定好，答复丢在路上时也查得到、取消得了。
4. 交任务：输入进 `amsg:cloud-gen`，凭据进 `char:<id>/gen-<用途>` 那一行（每次覆盖，不看本机底账），任务建成 `messageType: 'instant'`。响应的 `dispatch` 不是 `kicked` 就取消任务、撤掉输入，返回 `local`。
5. Worker（`worker/amsg/src/cloudGenFire.ts`）原样调模型，把正文、思考、结束原因存成附件，`emitResult` 送回引用和用量；完成通知开着时带客户端给的文案，关着就 `show: false`。fire 收尾时删输入；没送出成功结果的（模型报错、超时、输入不在了）补一条 `ok: false`。
6. 结果经 `utils/amsgResults.ts` 到 `utils/cloudGen/results.ts`：查底账 → 读附件 → 拼回 `{ choices: [{ message: { content, reasoning_content }, finish_reason }], usage }` → 交给落地函数 → 登记表、底账、调用记录、埋点一起收尾。读附件或落地抛错就不销账，下次上线再来。

### 文件

| 文件 | 是什么 |
|---|---|
| `utils/amsgCloudGenJob.ts` | Worker 和浏览器共用的契约：种类、命名空间、分组键、输入和结果的形状。零浏览器依赖，进 Worker bundle |
| `worker/amsg/src/cloudGenFire.ts` | Worker 侧 handler 和 fire 收尾 |
| `utils/cloudGen/types.ts` | 公共类型、每个功能的名字和通知默认值、本机存储键 |
| `utils/cloudGen/submit.ts` | 提交口 `trySubmitCloudGeneration`，返回 `cloud` / `local`（带原因）/ `busy` |
| `utils/cloudGen/registry.ts` | 在飞登记表（`list` / `get` / `subscribe` / `dismiss`）、已落地底账、点名兜底、删角色清理 |
| `utils/cloudGen/results.ts` | 结果落地 |
| `utils/cloudGen/landers/` | 每个功能一个落地函数，按用途懒加载 |
| `utils/cloudGen/settings.ts` | 每个功能的「云端生成」「完成时通知」两个开关，存在全局配置的 `cloudGen` 上 |
| `utils/cloudGen/analytics.ts` | 埋点「云端生成」 |

### 规则和理由

| 规则 | 理由 |
|---|---|
| 同一角色同一功能同时只许一份在飞，第二次返回 `busy` | 上游分组串行跨调用也生效，第二份会被租约挡下、等 cron；两份结果先后落地也会互相盖 |
| 分组键 `charId#cloud-gen#用途` | 不同功能分开排，一次 24000 token 的人格模拟挡不住日程 |
| 代跑不做生成重试，失败当场送回 | 客户端有一条 running 在等，不靠 cron 捞重试；cron 可能被用户关着 |
| `dispatch` 不是 `kicked` 就转本机 | 交任务时页面一定开着，本机生成是诚实的退路；留着它只能等 cron |
| 结果一律走附件 | 人格模拟一份就超过推送 3993 字节的上限，一条路比按大小分两条好维护 |
| 输入用独立命名空间 | beforeFire 每次都要整个命名空间读出来解密，代跑输入是整份上下文，跟门牌整理挤在一起会拖慢每一次门牌整理 |
| 凭据行按用途分开、每次覆盖 | 各功能用的 API 不同（人格模拟用查手机独立 API），`chat` 那一行是带思考后缀的对话 API，不能借用；本机底账靠不住 |
| 登记表在请求前写、确定失败才撤 | 请求到了答复丢了的那种，登记是唯一的痕迹；这时转本机就是同一件事做两遍 |
| running 超过 20 分钟去问任务状态，行没了或失败就标 failed；记录最多留一天 | 结果丢了的那份不能一直挡着这个功能 |
| 有 running、页面在前台时每 60 秒拉一次账本（交出后头一分钟不拉），超过 20 分钟的顺手点名 | 推送丢了而页面一直开着时，上线补收不会再跑，结果躺在账本上没人取，最后被点名判成失败 |
| 登记表和底账不进备份、不随迁入为新用户带走 | 描述的是这台设备上在飞的任务 |

### 给落地函数的约定

- 结果会到达不止一次，重放由底账挡住；全局分发队列超时只放行不取消，落地函数自己锁自己那份数据。
- 结果晚到时现场可能变了，由落地函数判断还要不要：要的返回 `landed`，不要的返回 `discarded`（登记表里那条随之删掉）。结果到了但不合格（截断、格式不对）返回 `{ failed }`，跟云端报失败、附件取不回、超时点名走同一个失败收尾：登记表标 failed、调 `onFailed`、埋点记失败。日程的失败记录留到下次交任务顶掉或过期，自动生成的 30 分钟退避靠它撑过刷新。
- 登记表里查不到的结果（别的设备交的、本机存储被清过）默认直接销账；落地函数声明 `acceptsOrphanResults` 才会收到，这时 `record` 为 null。
- 结果落地前要确认角色还在。

### 与本机请求一致

消息和模型名原样。本机 fetch 出口做的两项改写（Claude 温度封顶到 1、弃用采样参数的模型摘掉温度）提交时照做一遍，图片令牌同样还原；Anthropic 原生协议由 Worker 的出口转换。仍然不同的两处（云端非流式、单次模型调用最长 5 分钟）登记在总纲的有意差异表里，其中 5 分钟那条是暂时登记，见「待定」。

---

## 用户怎么知道可以切出去

只在这次确实交给云端时提示；没开 2.0、或这次在本机生成的，保持原样。

- **什么时候出现**：Worker 确认收到之后。拼请求、上传的那几秒里切走仍然会断，所以不能一点按钮就亮。
- **顶部小条**：写「云端生成 · 功能名」，贴着安全区下方弹出，停 3 秒往上收起，上滑可提前收起；只收这一次，下一份任务照样弹。几个任务同时跑时合并显示。带上功能名，用户才知道是哪件事、关的是哪个功能；日程这种进聊天自动触发的尤其需要。样式沿用人格模拟的顶部胶囊（`components/os/PersonaSimIndicator.tsx`），挂在 `PhoneShell` 上，不放状态栏：约三成设备隐藏了状态栏，单独一个云朵图标没有说明也看不懂。
- **点开是说明页**：

  > 这次请求交给了你的主动消息 2.0 后台，在云端生成。现在可以暂时退出应用，生成不会中断。生成完毕会弹出消息通知。

  这个功能的完成通知关着、或者推送订阅不正常时，最后一句换成「生成完毕后，回到应用就能看到」。说明页底部有「本功能不再提醒」，按功能记住；默认每种功能都显示。
- **结果到了**：小条变成「XX 好了 · 进入」，点一下跳到对应界面。人格模拟现在就是这样。
- 各功能的加载界面里不另加「云端生成中」的文字，跟小条重复。

### 命名

- **主动消息 2.0** 是后台的名字，也就是用户部署的那台 Worker。它提供两种能力：主动消息（角色到点来找你）和云端生成（你发起的事交给云端跑完）。
- 用户看到的统一叫 **「云端生成 / 本机生成」**，不用「即时」。云端生成通常不比本机快，它的好处是交出去就不怕断，「即时」听起来像是更快。界面里「聊天在本机生成」「回到云端生成」这些文案本来就是这对说法。
- 设置里的「即时对话」开关改名，并进一张按功能列的清单，每个功能一行，两个开关：
  - **云端生成**：默认开。云端没有边生成边出字，偏好看流式输出的可以按功能关掉。
  - **完成时通知**：用户主动发起的（人格模拟、梦境、见面、刷新哔哔、查手机生成）默认开；自动触发的（日程）默认关。记忆整理不进清单，永远不推送。
- 代码里的 `instant` 标识符不改名。
- 埋点里冷启动快照的「即时对话（开/关）」继续只代表私聊，新功能另加属性，免得同一个标签前后意思不一样、面板没法对比。

---

## 接入顺序

### 第一批：基建 + 两个入口

一个自动触发、一个用户点按钮，两种形态一起验证。

| 入口 | 位置 | 为什么先做 |
|---|---|---|
| 日程生成 | 请求 `utils/scheduleGenerator.ts:289`，触发 `apps/Chat.tsx:1243` | 37% 的设备至少有一个角色开着日程。进聊天发现今天没日程就后台生成，带记忆召回和聊天记录，8000 token，没有超时。进聊天看两眼就切走是常态，被杀就白烧，下次进聊天再生成一遍。用户看不见这个过程 |
| 人格模拟 | 请求 `apps/PersonaSim.tsx:107`，入口 `apps/CheckPhone.tsx:2009` | 一次 24000 token，用户几乎一定会切走。已有顶部指示条（`utils/personaSimStore.ts`） |
| 梦境 | `apps/DreamTheater.tsx:162` | 形态和人格模拟相同，已有指示条（`utils/dreamSimStore.ts`），顺手一起 |

落地要点：

- **日程**：结果回来时这个角色这一天已经有日程就丢弃，用户手动重新生成、换风格这类强制生成的除外。家园位置要对照当时的 `char.home3D.rooms`，串门申请走 `submitScheduleHomeVisits`，落地后照原样标记云端状态需要同步。现在的并发闸是 `Chat.tsx` 里一个所有角色共用的 React 标记，切角色时第二个角色直接跳过，改成在飞登记表之后按角色判断。
- **人格模拟**：剧本必须以 `end` 收尾才算完整，解析规则不变，成功后写入 `phoneState.simLogs`。
- **梦境**：梦要看完才写进 `dreamLogs`，所以云端结果先放进「还没看的梦」（`utils/cloudGen/pending.ts`，按角色各一份，刷新后还在），打开这个角色的梦境时借出来播，看完写进 `dreamLogs`、或用户确认放弃时才收走；中途刷新、被杀，下次打开从头再播。剧场停在「生成中」时结果一落地就会当场开播，那时人可能根本不在看，所以「打开」不能算「看过」。没通过校验的按失败收尾，打开时走原来的报错界面。

### 第二批：用得多、用户在等

| 入口 | 位置 | 说明 |
|---|---|---|
| 见面回复 | `apps/DateApp.tsx:303`（开场 `:398`、对话 `:491`、重来 `:594`） | 约 38% 的设备在用，次数仅次于私聊。8000 token，带完整上下文、记忆宫殿和识图。落库形态和私聊一样（`source: 'date'`），也已经有「挂起时回复还没回来，恢复后显示正在输入」。先确认两件事：见面有没有工具循环，有的话要走即时对话那条路；带图要先扩消息内容类型 |
| 哔哔刷新动态 / 评论接话 | `utils/friendFeedRefresh.ts:86`、`utils/friendFeedReplies.ts:66` | 约 27% 的设备在用，刷新动态 16000 token。现在刷新到一半被杀，「朋友们正在赶来」会卡到租约过期（10 分钟）。落地本来就按 `requestId` 对账；代跑由本机发起，本机知道这是替谁刷的，不受总纲里「云端分不清内容归哪个角色」的限制。但它只覆盖用户主动刷新，即时对话顺手发动态的缺口仍在 |
| 查手机生成 App 数据 | `apps/CheckPhone.tsx:877` | 没有输出上限的大 JSON，全屏加载 |

### 第三批：记忆整理链

用户看不见，但一直在浪费钱。61% 的设备开着记忆宫殿。

| 环节 | 位置 | 被杀之后 |
|---|---|---|
| 记忆提取 | `utils/memoryPalace/extraction.ts:546` | 每轮回复后自动跑，12000 token、180 秒，250 条一块串行。进度只在落库后才前进，被杀了下次整批重做 |
| 事件压缩 | `utils/memoryPalace/eventBoxCompression.ts:201`、二次压缩 `:296` | 只有那个盒子再次被碰到时才重试 |
| 认知消化 | `utils/memoryPalace/digestion.ts:363` | 轮数计数器在开跑时就清零，被杀后要再等 50 轮 |
| 门牌（本地那几条路） | `utils/memoryPalace/roomPlates.ts:77` | 压缩之后、手动回填、没有 Worker 时的兜底仍在本地 |

代价高的原因：提取和消化的输出引用的是「这次打包里的第几条」（`O2`、`A0` 这类），落地要对照打包时的编号表；提取 → 压缩 → 门牌是一条链，每一环都要处理结果晚到时数据已经变了。门牌整理上云时处理过的问题（快照时间、护住新条目、护住本地编辑、重放去重）这里都会再出现一遍。

### 第四批：基建好后逐个接

| 入口 | 位置 |
|---|---|
| 小剧场 | `utils/theaterGenerator.ts:197`（现在带记忆宫殿召回） |
| 交换日记 | `apps/JournalApp.tsx:519` |
| 进房状态 | `apps/RoomApp.tsx:826`（全屏遮罩，8000 token） |
| 都市人生 | `apps/LifeSimApp.tsx:86`（每个角色一次，串行） |
| 小红书自由活动 | `utils/xhsFreeRoam.ts:76`（中间夹着小红书 MCP 调用，先确认能不能拆） |
| 单日记忆归档 / 批量记忆总结 | `apps/Chat.tsx:2949`、`apps/Character.tsx:846`（按天串行，全部跑完才保存） |
| 强制重总结某天 / 月度精炼 | `apps/Character.tsx:661`、`:562` |
| 用户印象档案 | `apps/Character.tsx:1033` |
| 外部记忆搬家 | `utils/memoryPalace/externalMemory.ts:323`（16000 token、600 秒，分块串行） |
| 小说章节总结 / 共写 | `components/novel/NovelWriter.tsx:415`、`:247` |
| 群话题盒 | `apps/GroupChat.tsx:1390`（提示词是叶子，落地要按成员写卡片） |
| 关系对话总结 | `utils/relationshipChat.ts:322` |
| 日记归档总结 | `apps/JournalApp.tsx:638` |
| 待办完成反馈 / 纪念日感想 | `apps/ScheduleApp.tsx:179`、`:272` |
| 节日事件 | `utils/like520/prompts.ts:1005`、`components/ValentineEvent.tsx:572`、`components/WhiteDayEvent.tsx`（生成极长，但一年一次，全屏剧本流程要重做状态机） |
| 自习室大纲 / 出题 | `apps/StudyApp.tsx:600`、`:1060` |
| 相册点评 | `apps/Gallery.tsx:218`（图片要上云，吃请求体） |

### 不搬

| 调用点 | 理由 |
|---|---|
| 群聊导演与轮流发言 `apps/GroupChat.tsx:1534`、`:1653` | 约 28% 的设备在用，但云端结果按 `charId` 分发，群聊没有单一角色归属；导演还带工具循环。要改 Worker 的分发方式，单独立项 |
| 凌晨自动生成日程 | 页面关着时触发，只能走「云端自己拼」，召回、作息、家园状态都在本地。先用「进聊天时交给云端」拿到大部分收益 |
| 通话正文 `apps/CallApp.tsx:2109`、动作排练 `:2005`、视频表演人格 `:1926` | 闭环实时链路，返回值直接驱动出声 |
| 语音字幕翻译 `apps/Chat.tsx:656` | 挡在出声前的小请求 |
| 写歌 AI tag `utils/aceStepApi.ts:306` | 秒回 |
| 记忆检索侧（召回、embedding、rerank） | 查的是本地向量库；打包时在本机跑一次就够 |
| 旧记忆迁移 `utils/memoryPalace/migration.ts:140` | 每批落库后下一批要靠向量召回找到它，是硬闭环 |
| 网页编造 `apps/BrowserApp.tsx:301` | 结果不落库，异步化等于功能消失 |
| 协同工作 `features/collaboration/engine.ts:143`、SAR 推演 `utils/vrWorld/sarSimulation.ts:980` | 带工具循环或依赖逐段解析，等即时对话那条路扩展时再看 |
| 手账 `utils/handbookOrchestrator.ts:130` | 桌面入口已隐藏 |
| 各处连接测试按钮 | 秒回；但见下文「待修」里 API 测试只测直连的问题 |

死代码，评估时跳过：`utils/handbookGenerator.ts:464`、`:717`，`utils/pixelHomeDecoration.ts:95`，`utils/avatarTouch.ts:483`，`utils/companionStartup.ts:297`，`utils/scheduleGenerator.ts:435`，`utils/memoryPalace/groupExtraction.ts:136`，`utils/memoryPalace/recallRouter.ts:506`，`apps/pixelHome/memoryDiveEngine.ts:310`，`utils/homeCompanionPolicy.ts:17` 与 `utils/homeEmotionLoader.ts:14` 的 LLM 分支。

---

## 立刻开跑：上游 instant

即时对话和后台任务（门牌整理、代跑）都建成 `messageType: 'instant'` 的任务。上游 `POST /schedule-message` 落库就回 202，响应里的 `dispatch` 说明起跳器叫没叫醒：`kicked` 是已经开跑，`not_configured`（没有绑定）和 `kick_failed`（叫醒失败）都要等下一跳 cron。生成跑在上游自带的 Durable Object 起跳器的 alarm 里，一条任务一个实例，单次 15 分钟墙钟；它和 cron 走同一条投递链（占位、租约心跳、退避、`onBeforeFire` / `onLLMOutput`、收件箱），两边抢同一份租约，同一条只发一次。`supersedesUuid`、按任务关掉生成重试（`maxGenerationRetries` 按 metadata 判）都照常生效。

| 位置 | 做什么 |
|---|---|
| `worker/amsg/src/index.ts` | 工厂传 `instantTickBinding: 'INSTANT_TICK'`，把上游的 `InstantTick` 以 `InstantTickDO` 这个名字导出 |
| `worker/amsg/src/instantChat.ts` | 不自己叫醒，读上游的 `dispatch`：`not_configured` 回 503 提示更新 Worker，`kick_failed` 照常 202、等 cron |
| `worker/amsg/wrangler.toml`、`utils/cfProvision.ts`、`autoUpdate.ts`、`selfUpdate.ts` | 绑定名和类名不变，配置、迁移、「绑定缺失时重新上传」都照旧 |
| `utils/activeMsgClient.ts`、`utils/amsgRedeployGuard.ts` | 照旧按体检接口的 `instantTick` 判断这台 Worker 能不能立刻开跑 |

**类名和绑定名为什么不能改**：自动更新第一次跑的是旧代码，旧代码上传新包时会带上 `INSTANT_TICK → InstantTickDO` 绑定。新包里没有这个类名，上传就会失败，所有存量用户的自动更新都会卡住。沿用原名之后不需要任何迁移。部署那一刻正在跑的旧实例存的键名和上游不同，那几条留给 cron 接手。

---

## 已上云：门牌整理

拿来验证骨架的第一个调用点：请求体 10–15KB 且有容量上限，输出是完整新列表，合并是可测的纯函数，失败自带机械兜底，用户永远不在场。

| | 落在哪 |
|---|---|
| `kind → handler` 注册表 | `worker/amsg/src/fireKinds.ts`。分派点在聊天那四道门**之前**，所以后台任务不用传 fire_pack / tool_pack |
| 后台任务的通用约定 | `utils/amsgTaskKinds.ts`：`metadata.amsgKind` 标种类、`amsg:job` 命名空间放一次性输入、`messageSubtype: 'job'` 让它们不出现在用户的任务清单里 |
| 结果回程 | `ctx.emitResult` → 服务端收件箱 → 客户端上线补收 → `utils/amsgResults.ts` 按 `resultKind` 派活。门牌的结果带 `notification: { show: false }`，只落账本不发推送；定时主动消息到点没发时回的 `fire-skipped` 也走这条路 |
| `clientStateTtl` | `amsg:job` 和代跑输入 `amsg:cloud-gen` 保留 3 天，独立即时输入 `amsg:instant-input` 保留 7 天，不可变附件 `amsg:attachments` 保留 30 天，诊断记录按自身期限清理。角色状态命名空间不配 TTL |
| 门牌整理 | 提示词/解析/合并在零依赖叶子 `utils/memoryPalace/roomPlateCore.ts`，浏览器和 worker 共用；云端那条路在 `roomPlateCloud.ts`，worker 侧在 `worker/amsg/src/plateFire.ts` |
| 凭据 | credRefs 有 `memory` 一档（记忆宫殿副 API）。没配副 API 就不上云，不回落到主 API |

门牌的三个触发点只上了一个：**消化尾声的全量整理**（`consolidateAllPlates`）。另外两个留在本地：盒子压缩那个一轮里可能跑好几次、后一次要看到前一次的结果，异步化会让它们拿同一份快照互相覆盖；手动回填有进度条，批次之间也是串行依赖的。要上云得先做合批。

**提交到落地之间隔着一两分钟，这期间门牌可能被别的路径动过**（封盒、手动回填都在本地跑）。提交时把每块门牌的条目 id 一起带上、结果原样回传，落地时靠这份对照表处理三件事：

| | 不处理会怎样 |
|---|---|
| 标签对准（`remapBasedOnLabels`） | LLM 说的 `basedOn: "U0"` 是**快照里的第 0 条**，门牌一动它就指到另一条认知上，两条的来历（`firstLearnedAt` / `sourceCount`）被悄悄接错 |
| 护住新条目（`mergeCloudPlateEntries`） | 合并语义是「没被重新输出的条目淘汰」，而快照之后新增的条目 LLM 压根没见过。照原样合并就是把它们静默抹掉。它们也有专门的位子：整理结果占满上限时，先裁结果再塞新条目（一半封顶），不能整批扔掉——来源节点已经打过 `digestedAt`，扔了就是永久丢 |
| 护住本地编辑（`keepLocalEditsOverStaleRewrites`） | 门牌面板是人工纠错的口子。用户在等结果这几分钟里改对的那条，判据是「`updatedAt` 晚于**读快照那一刻**」——在飞记号里存的就是这个时刻，不是提交时刻。从建出来就没被改过的条目不算，否则保底并入的粗糙候选会挡住整理对它们的改写 |

同一个角色**同时只许一份整理在飞**（`roomPlateCloud` 的在飞记号，localStorage，30 分钟超时放行）。两份先后落地就是拿两份旧快照互相盖，还白烧一次 API。这时候不退回本地跑——本地那一遍同样会跟在飞那份撞车，所以判定是三态：交得出去 / 退回本地 / 这轮跳过（只做送达保证）。`plateCloudGate` 里三道门的顺序有讲究：「这台 worker 认不认识后台任务」排在「有没有在飞的」前面（路断了就该退回本地干活），但探测**问不到**时反过来先看在飞——网络抖一下不等于路断，那时候退本地就是跟云端那份撞车。用户在功能总览关掉「后台任务」（cron）也算路断：起跳器能让任务马上开跑，但失败后的重试、被同组任务挡下的那一跳都只靠 cron 捞，cron 关着就会一直躺着，恢复时晚到一小时以上的还会作废，所以闸门每轮现问 Worker 的定时触发状态（`GET /cron-trigger`），明确关着就退回本地，有在飞的也一样；问不到不算关着。

**快照时间随结果一起回来**：在飞记号只管 30 分钟，结果却允许晚到一周——下一轮整理开始时 `plateCloudGate` 会清掉过期的旧记号，之后的提交换成新 job，而旧结果仍可能落地。所以客户端把 `snapshotAt`（读取快照的绝对时间戳）放进 job，Worker 解析后原样带回结果。落地时同 job 的本地记号还在就用记号上的时间，否则用结果带回的时间；两处都没有时间时按「谁都可能被改过」保守保护，不拿另一 job 的时间或结果生成时间代替。

结果这条腿有自己的时效：账本留 28 天，重装 PWA 的用户一接上就会把老结果一次性拉回来，所以账本上记的时间随结果交给 handler，门牌那边超过一周就直接销账丢掉。同一份结果会被送到两次以上（销账那步失败会重放，推送直达那条腿收下之后不销账、补收时又来一遍），而落地不是幂等的——合并对每条保留下来的条目 `sourceCount + 1`，那就是门牌面板上的「印证 N 次」。所以本地留一本「哪些 job 已经落过地」的底账，见过的直接销账。结果落地前还要确认**角色还在**，否则会给一个已经不存在的角色重新建出四块门牌。

后台任务在调度器里的两处「别跟聊天混为一谈」：

| | 不分开会怎样 |
|---|---|
| `onStaleSkip`（`amsgStaleSkip`） | 那份 `last_skip` 留痕说的是「这条**主动消息**到点为什么没响」，主动消息面板照它给用户解释。一条挂着的门牌整理被过期跳过，用户会看到「上次主动消息没响」，而那个角色根本没排过主动消息 |
| `serializeBy` | 分组键取 `charId#kind`。一次门牌整理最长占住这个角色 120 秒，而它恰恰在一轮对话刚结束时起跑；只按 `charId` 分组的话，用户下一句话的即时对话任务会排在它后面干等。同种后台任务之间仍按角色串行，但不挡聊天 |

门牌本身是「整块对象存回去」的形状，而动它的路有四条（云端结果落地、本地整理落库、送达保证兜底并入、门牌面板手改），彼此完全不知道对方存在。队伍必须是**按门牌**的一条、所有路共用，收在 `utils/memoryPalace/db.ts` 的 `mutatePlate` 里。`amsgResults` 那条全局分发队列有 60 秒超时，而超时只是放行、不取消卡住的 handler，所以往那张表里加新 handler 时照着办：自己那份数据自己锁。

---

## 待修

接入时顺手处理，或单独修：

| 问题 | 位置 |
|---|---|
| 都市人生遇到网络错误会手动重试 2 次，绕过了「聊天请求不自动重试」 | `apps/LifeSimApp.tsx:84` |
| 自习室结课辅导日记是裸 `.then()`，失败静默丢掉 | `apps/StudyApp.tsx:932` |
| API 连通性测试只测浏览器直连。开了 2.0 之后真实请求从 Worker 发出，测过了不代表能用，测挂了也不代表不能用。改成按当前路由测对应路径，或两条都测、分别显示 | `apps/Settings.tsx:2739` |

## 待定

- 代跑单次模型调用最长 5 分钟：上限写死在上游 `agentic-fire.js`（`Math.min(300_000, …)`），即时对话同样受它约束。人格模拟一次 24000 token，慢模型或带思考的模型可能撞线。待上游核实能不能放宽（按次由 `onBeforeFire` 返回，还是整体调高），定下来后改总纲那条暂时登记。实际撞线有多常见，看埋点「云端生成」的 `原因: 超时` 和 `云端用时: 5分钟以上`（见 [使用统计](../docs/analytics.md)「主动消息 2.0 · 云端生成」）。
- 私聊即时对话第一次交给云端时，要不要也显示一次顶部小条。现在私聊只靠「发送中」消失来暗示可以离开。

---

## 硬约束

| | 数值 / 说明 |
|---|---|
| 单条 Web Push 明文 | 3993 字节。超了走附件，push 只带引用 |
| client_state 单条 value | 默认 5 MB，>200KB 自动透明分块 |
| `chat.messages` 请求体 | 2 MiB。超了先降级图片，还超就整轮明确报错 |
| 手机上行 | 大 body 走手机上行会撞 ~42s 上行超时，往往在服务端来得及判超时之前就被掐掉 |
| 单次 fire 总超时 | 默认 240s，`onBeforeFire` 返回值里可按次放宽（要同步调 `claimLeaseMs`）。即时对话放宽到 600s（`worker/amsg/src/instantChat.ts` 的 `INSTANT_TOTAL_TIMEOUT_MS`） |
| DO alarm / Cron / Queue 单次墙钟 | 15 分钟 |
| 工具循环 | 默认 5 轮 |
| `ctx.waitUntil` | 只有 30 秒，且从响应发出就倒计时。后台生成一律走 DO alarm / cron |
| 单次 fire 建任务 | 默认 2 条 |
| 流式 | 整条链没有流。回程是推送，不是长连接 |
| 群聊 | 收件箱按 charId 路由，群聊没有 charId |

**要求改 D1 表结构的方案直接否决。** 升级后老表不加列 → cron 每分钟静默失败、主动消息整个停摆，而界面上一切正常；代价是所有存量用户必须重新点一次「重新连接并验证」。

---

## 回程通道

结果送回浏览器有四条路，按新调用点的需要挑：

| 通道 | 方向 | 适用 |
|---|---|---|
| Web Push | 推 | 主通道，受 3993 字节限制 |
| outbox 账本 | 拉 | 推送丢失兜底。每条 push 发出**之前**先落一行，客户端落库后 ack |
| 不可变附件 / 旧 client_state 旁路键 | 拉 | 大数据优先用 `ctx.storeAttachment` / `getAttachment`，绑定任务与触发时刻，读取不删、30 天回收；旧引用仍兼容 |
| 任务状态点名 | 拉 | `getRemoteTaskStatus`，判「还在跑 / 已失败 / 行没了」 |

**结果可以晚到、也不需要通知的调用点不用碰推送**，只用 client_state 拉取就行。`utils/activeMsgRuntime.ts` 的 `startLateEmotionPoll` 是完整可抄的样板——含「新一轮到达时旧轮询作废」「跳数用尽按失败收尾」「取回后删云端副本」。

---

## 上游能力速查

当前依赖的 `@rei-standard/amsg-server` 版本以 `package.json` 为准。

宿主可以自由做的：

- 加自定义 HTTP 端点——在自己的 `export default.fetch` 里前置拦截，兜底转 `upstream.fetch`（`worker/amsg/src/index.ts` 里的 `/instant-chat` 路由就是范例）。新增端点要同步中转的路径白名单
- 加自己的 D1 表 / 列 / 索引——`initSchema` 不碰宿主的表，`getSchemaVersion` 只查缺不查多
- 存任意业务数据——`readState` / `writeState`（per-user、自动加密、自动分块）
- 推自定义（非聊天）消息——`pushPayloads` 里的字段原样透传，`messageSubtype` 是自由字符串
- 定义自己的任务种类——`metadata.amsgKind`，在 `onBeforeFire` 分派。要马上跑的建成 `messageType:'instant'`（落库回 202，起跳器开跑），到点跑的用 `'auto'`。调度器（cron 每分钟 + 租约 + 心跳 + 分组串行 + 重试退避 + `tzId` 感知的 daily/weekly）照常工作，它不关心任务在语义上是不是聊天
- 单独跑某一条任务——`upstream.runTask(uuid)`，到期且不在退避窗口里就交给和 cron 同一个 `deliverTasks`，任务种类分派照常生效
- 单次 fire 超 240s——`onBeforeFire` 返回 `{totalTimeoutMs}` 按次放宽

必须动上游才能做的：

- 任务生命周期 hook（建 / 改 / 删）——上游一个都没有
- 改写上游端点的响应——`onError` 只是观测，返回值被丢弃
- 新的 `message_type` 枚举值——D1 `CHECK` 约束 + `scheduleTask` 白名单双重锁，现有 `fixed` / `prompted` / `auto` / `instant` 四种
- 单条 push 超 3993 字节——协议硬限，只能走附件
