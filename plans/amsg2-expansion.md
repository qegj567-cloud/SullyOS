# 主动消息 2.0 · 把更多 LLM 调用搬到云端

聊天和情绪评估已经跑在用户自己的 CF Worker 上了。这份记的是「还有哪些 LLM 调用点值得搬上去、按什么顺序搬、哪些不该搬」。

> **现状（2026-08-15，dev）**：路已经修好，第一个调用点（门牌整理）跑通了。
>
> | | 落在哪 |
> |---|---|
> | `kind → handler` 注册表 | `worker/amsg/src/fireKinds.ts`。分派点在聊天那四道门**之前**，所以后台任务不用传 fire_pack / tool_pack |
> | 后台任务的通用约定 | `utils/amsgTaskKinds.ts`：`metadata.amsgKind` 标种类、`amsg:job` 命名空间放一次性输入、`messageSubtype: 'job'` 让它们不出现在用户的任务清单里 |
> | 结果回程 | `ctx.emitResult` → 服务端收件箱 → 客户端上线补收 → `utils/amsgResults.ts` 按 `resultKind` 派活。门牌的结果带 `notification: { show: false }`，只落账本不发推送；定时主动消息到点没发时回的 `fire-skipped` 也走这条路 |
> | `clientStateTtl` | `amsg:job` 保留 3 天，独立即时输入 `amsg:instant-input` 与不可变附件 `amsg:attachments` 保留 30 天，诊断记录按自身期限清理。角色状态命名空间不配 TTL |
> | 门牌整理 | 提示词/解析/合并抽进零依赖叶子 `utils/memoryPalace/roomPlateCore.ts`，浏览器和 worker 共用；云端那条路在 `roomPlateCloud.ts`，worker 侧在 `worker/amsg/src/plateFire.ts` |
> | 凭据 | credRefs 加了 `memory` 一档（记忆宫殿副 API）。没配副 API 就不上云，不回落到主 API |
>
> 三件上游基建其实 **2.6.0-next.21 就带了**（next.22 是「不弹通知的 push 只落收件箱」那条行为变更，对 SullyOS 零影响——error push 是绕过库直发的，reasoning / tool_request 在 amsg2 链路上本来就不发）。
>
> 门牌的三个触发点只上了一个：**消化尾声的全量整理**（`consolidateAllPlates`）。另外两个留在本地——盒子压缩那个一轮里可能跑好几次、后一次要看到前一次的结果，异步化会让它们拿同一份快照互相覆盖；手动回填有进度条，批次之间也是串行依赖的。要上云得先做合批。
>
> 一个下面正文里没提到的坑，**提交到落地之间隔着一两分钟，这期间门牌可能被别的路径动过**（封盒、手动回填都在本地跑）。提交时把每块门牌的条目 id 一起带上、结果原样回传，落地时靠这份对照表处理两件事：
>
> | | 不处理会怎样 |
> |---|---|
> | 标签对准（`remapBasedOnLabels`） | LLM 说的 `basedOn: "U0"` 是**快照里的第 0 条**，门牌一动它就指到另一条认知上，两条的来历（`firstLearnedAt` / `sourceCount`）被悄悄接错 |
> | 护住新条目（`mergeCloudPlateEntries`） | 合并语义是「没被重新输出的条目淘汰」，而快照之后新增的条目 LLM 压根没见过。照原样合并就是把它们静默抹掉，用户看到刚沉淀的认知凭空消失。它们也有专门的位子：整理结果占满上限时，先裁结果再塞新条目（一半封顶），不能整批扔掉——来源节点已经打过 `digestedAt`，扔了就是永久丢 |
> | 护住本地编辑（`keepLocalEditsOverStaleRewrites`） | 门牌面板是人工纠错的口子。用户在等结果这几分钟里改对的那条，判据是「`updatedAt` 晚于**读快照那一刻**」——在飞记号里存的就是这个时刻，不是提交时刻（中间还隔着拼身份上下文、探测 worker、保底并入候选）。从建出来就没被改过的条目不算，否则保底并入的粗糙候选会挡住整理对它们的改写 |
>
> 同一个角色**同时只许一份整理在飞**（`roomPlateCloud` 的在飞记号，localStorage，30 分钟超时放行）。两份先后落地就是拿两份旧快照互相盖，还白烧一次 API。这时候不退回本地跑——本地那一遍同样会跟在飞那份撞车，所以判定是三态：交得出去 / 退回本地 / 这轮跳过（只做送达保证）。`plateCloudGate` 里三道门的顺序有讲究：「这台 worker 认不认识后台任务」排在「有没有在飞的」前面（路断了就该退回本地干活），但探测**问不到**时反过来先看在飞——网络抖一下不等于路断，那时候退本地就是跟云端那份撞车。
>
> **快照时间随结果一起回来**：在飞记号只管 30 分钟，结果却允许晚到一周——下一轮整理开始时 `plateCloudGate` 会清掉过期的旧记号，之后的提交换成新 job，而旧结果仍可能落地。所以客户端把 `snapshotAt`（读取快照的绝对时间戳）放进 job，Worker 解析后原样带回结果。落地时同 job 的本地记号还在就用记号上的时间，否则用结果带回的时间；合并靠它分清哪些条目是提交之后用户才改的（文本以本地为准），哪些是提交之前就有的（接受云端改写）。两处都没有时间时按「谁都可能被改过」保守保护，不拿另一 job 的时间或结果生成时间代替。仅关页重开、仅经过 30 分钟不会删除记号，清理发生在下一轮整理入口。`snapshotAt` 是可选字段，前端与 Worker 都带上它才生效。
>
> 结果这条腿有自己的时效：正文补收已取消两天窗口，结果仍按产物语义判断有效期；账本留 28 天，重装 PWA 的用户一接上就会把老结果一次性拉回来，所以账本上记的时间随结果交给 handler，门牌那边超过一周就直接销账丢掉。同一份结果会被送到两次以上（销账那步失败会重放，推送直达那条腿收下之后压根不销账、补收时又来一遍），而落地不是幂等的——合并对每条保留下来的条目 `sourceCount + 1`，那就是门牌面板上的「印证 N 次」。所以本地留一本「哪些 job 已经落过地」的底账，见过的直接销账。结果落地前还要确认**角色还在**：删角色清的是云端那份输入，而结果回来说明 LLM 早跑完了、输入那会儿已经被 worker 删掉，不拦的话会给一个已经不存在的角色重新建出四块门牌。
>
> 后台任务在调度器里的两处「别跟聊天混为一谈」：
>
> | | 不分开会怎样 |
> |---|---|
> | `onStaleSkip`（`amsgStaleSkip`） | 那份 `last_skip` 留痕说的是「这条**主动消息**到点为什么没响」，主动消息面板照它给用户解释。服务停摆几小时之后一条挂着的门牌整理被过期跳过，用户会看到「上次主动消息没响、已被丢弃」，而那个角色根本没排过主动消息 |
> | `serializeBy` | 分组键原先只取 `charId`。一次门牌整理最长占住这个角色 120 秒，而它恰恰是在一轮对话刚结束时起跑的——用户下一句话的即时对话任务排在它后面，人就干等着「正在输入…」。改成 `charId#kind`：同种后台任务之间仍按角色串行（两份整理并发落地就是拿两份旧快照互相盖），但不挡聊天 |
>
> 门牌本身是「整块对象存回去」的形状，而动它的路有四条（云端结果落地、本地整理落库、送达保证兜底并入、门牌面板手改），彼此完全不知道对方存在。各自在自己那条路里排队不够——队伍必须是**按门牌**的一条、所有路共用，所以收在 `utils/memoryPalace/db.ts` 的 `mutatePlate` 里。`amsgResults` 那条全局分发队列有 60 秒超时，而超时只是放行、不取消卡住的 handler，所以它不能是数据安全的唯一依靠；往那张表里加新 handler 时照着办：自己那份数据自己锁。

上云带来的是**页面关着也能跑完**：请求交出去那一刻客户端就自由了，切后台、锁屏、杀进程都不影响云端把结果跑完送回来。所以值不值得搬，看的不是技术上能不能，而是这个调用点的用户在不在场。

---

## 一把尺子

**收益 ≈ 生成时长 × 用户离开的概率。**

- 生成 3 秒的东西上云，收益接近零，成本照付。
- 生成 60 秒、且用户大概率已经切走的，收益最大。
- 用户必须当场看到下一句才能继续的（通话），上云是负收益。
- 云端只有异步一种形态（没有同步流式通道），所以先看结果能不能晚点到——必须当场拿到的，直接不考虑上云。

成本那头有三项，按大小排：

| 成本项 | 说明 |
|---|---|
| 依赖剥离 | 要在云端跑的那段逻辑必须变成零浏览器依赖的叶子（不碰 IndexedDB / localStorage / window / React）。这一步通常占整个工作量一半以上 |
| 失败兜底 | 本地跑挂了当场报错就完了；上云挂了可能是「任务还在云上跑着，客户端不知道」。要写「这条没回来怎么办、怎么让用户看懂、怎么区分还会重试和彻底没了」 |
| 双路径维护 | 本地路径删不掉（用户没配 Worker 就得能用），所以每接一个点就多一份分流判断和留痕 |

---

## 先修路

在接任何新调用点之前要铺的东西。铺完之后下面那批基本是填表。

### SullyOS 这边

**`kind → handler` 注册表。** 上游只给 `onBeforeFire` 一个入口，所有 LLM 类任务都从这里进。先立一张 `kind → handler` 的表按 `metadata.kind` 分派，别让它长成大 switch。

这是业务分派，不该放上游 —— 上游只需要知道「有个 hook」，不需要知道「有种任务叫日程生成」。

### 上游（ReiStandard / `@rei-standard/amsg-server`）

三件通用基础设施，建议攒成一次发版一起推。改动都不大，但每推一次所有用户都要重新部署 Worker，分三回不划算。

| | 做什么 | 为什么放上游 |
|---|---|---|
| client_state 的 TTL | run-tick 顺手清过期 key，按 `updatedAt` 判、按 namespace 配保留天数 | 库现在明说不做 TTL 也不回收，每天一份日程一年就是 365 个 key 躺着。run-tick 里已经在清 outbox（已 ack 留 7 天、全部留 28 天），加一个清 client_state 完全同构 |
| 请求体 gzip 自动解压 | `parseBodyAsObject` 前面加 `Content-Encoding: gzip` 判断，用 `DecompressionStream` | 宿主自己做不干净：能拦的只有自己前置的端点，而大 body 恰恰走上游的 `PUT /client-state`。上游做一次所有端点全通 |
| `ctx.emitResult(payload)` | 把「往 outbox 塞一条自定义结果」变成正式能力 | 现在 `appendPushesToOutbox` 没导出，宿主要塞非聊天的结果只能拿 `db.appendOutboxMessages` + `encryptForStorage` 手工拼，无文档无测试。收编之后客户端直接吃现成的 `GET /outbox?since=` 补收，不用为每个 kind 写一套轮询 |

**TTL 那条别加列。** `client_state` 表已经有 `updatedAt`，按它判就行。加列会撞上「升级后老表不加列 → cron 每分钟静默挂、界面一切正常」那条最贵的坑。

**两件建议别顺手做：**

- 给 `message_type` 加新枚举值。D1 上是 `CHECK` 约束，改约束等于改表，同样撞上面那条坑。用 `metadata.kind` 区分业务类型完全够。
- 给建 / 改 / 删任务加生命周期 hook。这轮上云一个都用不上。

---

## 接入顺序

### 第一个：门牌整理

`utils/memoryPalace/roomPlates.ts:185`

拿来验证骨架的。全项目成本最低的真实调用点：

- 请求体 10–15KB 且有硬容量上限
- 输出是完整新列表，不是相对编号，不需要回本地做 ID 还原
- 合并逻辑 `mergePlateEntries` 已经是可测的纯函数
- 失败还自带 `fallbackMergeSubmissions` 机械兜底
- 用户永远不在场

收益不大，但它是唯一一个能在不碰任何难点的前提下把整条路跑通的。

### 补断层（收益最高）

提取 → 压缩 → 门牌是一条链，全程用户不在场。

| 调用点 | 生成时长 | 卡点 |
|---|---|---|
| 记忆提取 `utils/memoryPalace/extraction.ts:350` | 长（180s 超时） | 请求体满载 ~450KB；输出的 `relatedTo:"O2"` / `unpin:"P0"` 是相对本次打包顺序的编号，还原必须对着本地节点表 |
| 认知消化 `utils/memoryPalace/digestion.ts:240` | 长 | 输出 `A0/W0/E3` 索引动作，`executeActions` 全是本地状态机（搬房间、建节点、打 `digestedAt`） |
| EventBox 压缩 `utils/memoryPalace/eventBoxCompression.ts:123` | 中 × N 个盒 | 后半段（summary 重新 embedding、live 节点批量标 archived、box 状态机）全在本地 |

**为什么值得吃这个成本**：现在角色能在页面关着的时候发消息，但这些消息产生的记忆要等页面打开才整理 —— 云端生成、本地消化，中间断了一截。`extraction` 的触发点里已经有一个是「主动消息推送回来之后」，这条链本来就该在云端连上。

这批是唯一补已有缺口的，其余都是锦上添花。

**前置**：请求体先解决，不然一个都做不了。

### 慢生成 + 用户大概率切走

| 调用点 | 时长 | 离开概率 | 成本 |
|---|---|---|---|
| 手账 `utils/handbookOrchestrator.ts:573` | 极长（1+N 串行，最多 7 次） | 高 | 中 —— 进度条要改成靠推送回传 |
| 见面 `apps/DateApp.tsx:214` | 长（8000 tokens，上下文重） | 中 | **低** —— 见下 |
| 日程 `utils/scheduleGenerator.ts:226` | 长（8000 tokens） | 高 | 中 —— 召回照 fire_pack 那套留在本地做 |
| 月度精炼 `apps/Character.tsx:443` | 长（整月日度总结不截断） | 高 | 极低，但卡请求体 |
| 小说章节总结 `components/novel/NovelWriter.tsx:392` | 长（200k 字符截断） | 高 | 低 |
| 强制重总结某天 `apps/Character.tsx:530` | 极长 | 高 | 低，但请求体 ~600KB，全仓库最大 |

**见面可以提前做**，它是唯一能复用现有 instant-chat 那条路的：

- 落库形态跟聊天完全一样 —— `apps/DateApp.tsx:443` 就是 `DB.saveMessage({ charId, role, type:'text', content, metadata:{ source:'date' } })`，只差一个 `source` 字段
- 上下文构建也是同一套 —— `utils/datePrompts.ts:732` 用的是 `injectMemoryPalace` + `ContextBuilder.buildCoreContext`，跟聊天一模一样

差异只有三处：回灌落库要带上 `source:'date'` 别落进聊天流；fire_pack 要能装 datePrompts 版的 system prompt（还带个 `skipTimeAwareness`，见面可以脱离现实时间线）；`savedDateState` 会话状态怎么跟云端对齐。

至于逐句播放、TTS、观测 HUD、立绘 —— 都是收到文本之后的浏览器后处理，跟请求从哪儿发出去无关。

**日程的触发方式要先定**：现在是「进聊天界面发现没有当日日程就后台生成」。上云后建议改成建一条 `recurrenceType:'daily'` + `tzId` 的循环任务，凌晨按角色时区自己跑（上游的时区推进、夏令时收敛都是现成的）。还挂在「进界面时」的话，「页面关着也能跑完」这个收益就没了。

### 顺手批

骨架建好后基本是填表。全部离开概率 100%、函数已经是纯的：

| 调用点 | 备注 |
|---|---|
| 群话题盒 `apps/GroupChat.tsx:1114` | 已经是每轮生成后后台自动跑 |
| 世界结卷 `utils/worldHome/chapters.ts:128` | 全纯，api / episodes / members 全从参数进 |
| 关系对话总结 `utils/relationshipChat.ts:250` | 全纯，字符串进字符串出 |
| 教学记忆 `apps/StudyApp.tsx:876` | 顺手把漏掉的 catch 补上（现在是裸 `.then()`，失败是个静默丢掉的 rejection） |
| 日记归档总结 `apps/JournalApp.tsx:594` | |
| 小剧场 `utils/theaterGenerator.ts:168` | 只吃 char / user / schedule 三个可序列化对象，不读消息历史 |
| 外部记忆搬家 `utils/memoryPalace/externalMemory.ts:297` | 函数内零 DB，10000 字/批天然分片友好 |

### API 连通性测试

`apps/Settings.tsx:2316`

这个要改成**测实际会走的那条路**。开了主动消息 2.0 之后真实请求从 CF Worker 发出，而这个按钮测的是浏览器直连 —— 测过了不代表能用，测挂了也不代表不能用。用户看到绿灯然后消息发不出来，是最难查的一类。

做法二选一：按当前路由测对应路径；或者两条都测、分别显示结果。

### 能上但不急

| 调用点 | 为什么排后面 |
|---|---|
| 节日事件（520 / 情人节 / 白色情人节） | 生成极慢（`max_tokens` 到 32000），但一年一次，且是全屏 loading 的线性剧本流程，异步化要重做整个 phase 状态机 |
| 课程大纲 `apps/StudyApp.tsx:578`、出题 `:997` | 单次纯 JSON，收益中等 |
| 交换日记 `apps/JournalApp.tsx:483` | 一天一篇，晚点看完全成立；输出是 JSON + 贴纸结构，要新的回灌形态 |
| 相册点评 `apps/Gallery.tsx:162` | 要传图片 base64 上云，吃请求体预算 |
| 群聊导演 `apps/GroupChat.tsx:1248` | 用户在等，且带 MCP 工具循环 |
| 小屋 `utils/worldHome/engine.ts:274`、彼方 `utils/vrWorld/runSession.ts:141` | 已经是全局定时器后台跑，离开概率 100%；但它们是带共享可变状态的多轮编排（每个角色一拍要读到前面角色刚写进 `world.threads` 的东西），外加十几张表读写和多处 `window.dispatchEvent` 驱动 UI。接之前先确认这个判断 |

---

## 不接

| 调用点 | 理由 |
|---|---|
| 通话正文 `apps/CallApp.tsx:2032` | 唯一的硬否决。返回值直接驱动 `thinking → speaking` 并立刻喂 TTS 出声，前面接着浏览器原生 ASR，是个闭环实时链路，中间插一个「等推送」就断了 |
| 通话动作导演 `apps/CallApp.tsx:1929` | 串在正文和播音之间，纯延迟成本，且已有本地降级 |
| 见面台词翻译 `components/date/DateSession.tsx:224` | 挡在出声前的小请求，上云只让语音更慢 |
| 写歌 AI tag `utils/aceStepApi.ts:192` | 输出一行字符串，秒回 |
| 出歌 `utils/aceStepApi.ts:494` | 不是 LLM，是 Replicate 长轮询，而且已经走 `workerBase()` 代理了 |
| 记忆检索侧（`pipeline.ts:321` / embedding / rerank） | 打的是本地 IndexedDB 向量库 + BM25 + 链接图，云端无库可查；而且它不需要上云 —— 产出已经随 fire_pack 烘进 system prompt 送上去了 |
| 旧记忆迁移 `utils/memoryPalace/migration.ts:321` | 每批落库后下一批要向量召回搜到它才能建跨 chunk 关联，是硬闭环 |
| 网页编造 `apps/BrowserApp.tsx:301` | 结果不落库、刷新即丢，用户点了链接就是要立刻看到，异步化等于功能消失 |

死代码，评估时直接跳过：`utils/handbookGenerator.ts:377` / `:521`、`utils/pixelHomeDecoration.ts:24`、`utils/avatarTouch.ts:427`、`utils/companionStartup.ts:251`、`utils/scheduleGenerator.ts:367`。

---

## 硬约束

| | 数值 / 说明 |
|---|---|
| 单条 Web Push 明文 | 3993 字节。超了走 client_state 旁路，push 只带引用键 |
| client_state 单条 value | 默认 5 MB，>200KB 自动透明分块 |
| `chat.messages` 请求体 | 2 MiB。超了先降级图片，还超就整轮明确报错 |
| 手机上行 | 大 body 走手机上行会撞 ~42s 上行超时，往往在服务端来得及判超时之前就被掐掉 |
| 单次 fire 总超时 | 默认 240s，`onBeforeFire` 返回值里可按次放宽（要同步调 `claimLeaseMs`） |
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
| 任务状态点名 | 拉 | 判「还在跑 / 已失败 / 行没了」 |

**结果可以晚到的调用点根本不用碰推送**，只用 client_state 拉取就行，代码量减半。`utils/activeMsgRuntime.ts:309` 的 `startLateEmotionPoll` 是完整可抄的样板 —— 含「新一轮到达时旧轮询作废」「跳数用尽按失败收尾」「取回后删云端副本」。

---

## 上游能力速查

调研的是 `@rei-standard/amsg-server` 2.6.0-next.20。结论：**当前需求现成能力全覆盖，不动上游也能做**，上面列的三件是为了让 SullyOS 这边逻辑更少。

宿主可以自由做的：

- 加自定义 HTTP 端点 —— 在自己的 `export default.fetch` 里前置拦截，兜底转 `upstream.fetch`（`worker/amsg/src/index.ts:2861` 的 `/instant-chat` 就是范例）
- 加自己的 D1 表 / 列 / 索引 —— `initSchema` 不碰宿主的表，`getSchemaVersion` 只查缺不查多
- 存任意业务数据 —— `readState` / `writeState`（per-user、自动加密、自动分块）
- 推自定义（非聊天）消息 —— `pushPayloads` 里的字段原样透传，`messageSubtype` 是自由字符串
- 定义自己的任务种类 —— `messageType:'auto'` + `metadata.kind`，在 `onBeforeFire` 分派。调度器（cron 每分钟 + 租约 + 心跳 + 分组串行 + 重试退避 + `tzId` 感知的 daily/weekly）照常工作，它不关心任务在语义上是不是聊天
- 单次 fire 超 240s —— `onBeforeFire` 返回 `{totalTimeoutMs}` 按次放宽

必须动上游才能做的：

- 任务生命周期 hook（建 / 改 / 删）—— 上游一个都没有
- 改写上游端点的响应 —— `onError` 只是观测，返回值被丢弃
- 新的 `message_type` 枚举值 —— D1 `CHECK` 约束 + `scheduleTask` 白名单双重锁
- 单条 push 超 3993 字节 —— 协议硬限，只能走 client_state 旁路
