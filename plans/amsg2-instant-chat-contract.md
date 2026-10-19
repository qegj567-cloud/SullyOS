# instant chat 实施契约（给施工 agent）

设计动机与取舍见 [`amsg2-instant-chat.md`](./amsg2-instant-chat.md)，本文件是拍板后的实现契约：
端点形状、数据格式、必须先验证的上游行为、分工边界。施工前先通读两份。

## 总体架构（定案）

- 业务实现放在本仓库的 `worker/amsg/src/`（包装层）、`utils/` 和前端。
  2026-10-19 审计修复依赖上游通用能力：任务输入、任务查询、工具执行白名单、不可变附件和条件写结果。
  当前精确依赖 `amsg-client@2.10.0-next.0` 与 `amsg-server@3.1.0-next.0` 已包含这些能力，
  已移除先前的本地补丁；不要手改安装目录，升级包时须重跑真实 SDK 集成测试。
- 防双跑复用上游 `claimTask` 的 `lease_until` 条件更新；每分钟 cron 是兜底捡漏者。
- 任务行型：`message_type = 'auto'` + `messageSubtype: 'instant-chat'`
  + `metadata: { amsgMode: 'instant', amsgInstantChat: true, charId }`。
  用 'auto' 是为了确定走 hooks + LLM 的 fire 管线；push 载荷的 `messageType`
  期望取自 `metadata.amsgMode`（见 V4），这样客户端收到的是
  `messageType: 'instant'`。`messageSubtype` 上游只当自由文本标签原样透传，
  客户端拿它做面板对账的过滤判据：即时对话的行不补进任务清单（连同
  `status = 'failed'` 的行一起排除），否则用户正等着的这一轮会显示成待触发的
  排程任务、还可能被「取消全部」顺手掐掉。
- **durability 原则**：202 之前任务行必须已落 D1。`ctx.waitUntil` 只负责快，
  cron 负责稳。isolate 死了 → lease 过期 → cron 重跑，消息不丢。

## 新端点 `POST /instant-chat`（包装层路由）

- 路由位置：`worker/amsg/src/index.ts` 的 default export，和 `/config-check`、
  `/debug` 同级（后缀匹配、OPTIONS 204、CORS 头同现有约定，注意 `index.ts:1361`
  和上游 chunk `:3297` 的 CORS 允许头两处同步问题）。
- 鉴权：与上游一致——设了 `AMSG_SERVER_TOKEN` 就要求 `X-Client-Token` 常时比较；
  `X-User-Id` 必须 UUID v4。内部转发的子请求带全套头，上游会再验一次（上游是权威）。
- Body（明文 JSON 外壳，内含两个客户端预加密的信封）：

  ```jsonc
  {
    "statePayload": "<加密信封：即 PUT /client-state 的完整 body>",
    "taskPayload": "<加密信封：即 POST /schedule-message 的完整 body>",
    "credPayload": "<可选，加密信封：即 PUT /llm-credentials 的完整 body>"
  }
  ```

  credPayload 装的是这一轮任务引用的凭据行（`char:<id>/instant`，评估时再加
  `char:<id>/emotion`）。任务走 credRefs 时客户端**每一轮都带**，不看本地指纹底账：
  底账只代表这一个入口传过什么，云端那行可能已被别的入口（iOS 上 Safari 与主屏 App
  各存各的）或别的 Worker 改过。任务走内联凭据时不带。

  taskPayload（信封内）固定带 `immediate: true`（amsg-server 2.6.0-next.15 起：
  落库即到期，不带 `firstSendTime`）；顶替上一条时带 `supersedesUuid`（上游在
  建新任务的同一事务里取消旧的，原子）。外壳不再有明文 supersedesUuid。

- 处理步骤（严格顺序，任一步失败即返回明确错误，不落新任务）：
  1. 包装层用租户密钥解开 state/task 信封，校验本角色 `fire_pack.chat`，将原来的压缩值
     写成独立输入：命名空间 `amsg:instant-input`、服务器生成的 UUID key，值为
     `{v:1,charId,packedFirePack}`。任务只绑定
     `taskInput:{firePackRef:{namespace,key},firePackUpdatedAt}`，不重复塞完整上下文。
     同时从这次共享状态写入中移除原来的 `fire_pack`，两份信封重新加密后才内部转发。
     旧客户端的信封也经过这个转换，因此失败的新请求不会覆盖旧任务要回复的那句话。
  2. 内部转发 `PUT /client-state`。HTTP 失败、`success:false`、本轮输入出现在
     `data.rejected` 或 `data.skippedEntries` 中，均不能继续建任务。其他共享状态仍按自身版本判定。
  3. 带了 credPayload 时，转发 `PUT /llm-credentials`，失败回
     `INSTANT_CHAT_CREDENTIALS_FAILED`。凭据仍在执行时按 credRefs 现取，不冻结在输入里。
  4. 转发 `POST /schedule-message`，成功拿到 uuid 才返回
     `202 {status:'accepted',uuid}`；顶替旧任务由上游事务完成。凭据成功覆盖时再带
     `credentialsSynced:true`。之前落下但没有任务引用的输入由 TTL 清理。
  5. 唤醒按租户分组的 `InstantTickDO`，alarm 点名执行已落库的 uuid；每分钟 cron 继续兜底。

  独立输入保留 30 天，按角色归属参与云端清理。大值继续走 client_state 的 5 MiB 分块能力，
  不受任务行约 996 KB 明文容量限制，现有 `chat.messages` 2 MiB 预算保持不变。
  Worker 使用 `readState(namespace,{key})` 定点读取，不能扫描同命名空间下的全部历史输入。
- `export default` 的 `fetch` / `scheduled` 签名补上第三个参数 `ctx`
  （上游签名只收两个参数，多传无害；`index.ts:1509-1510` 的注释要同步改）。
- `/config-check` 的返回里加包装层能力标志（如 `instantChat: true`），设置页
  用它做唯一版本门槛（开发期规矩：门槛只留一处，不做逐调用 capability 预检）。

## 必须先验证的上游行为（读 chunk-RRWCPPOY.mjs，结论写进报告）

| # | 验证什么 | 影响 |
|---|---------|------|
| V1 | `MIN_SCHEDULE_LEAD_MS`（chunk `:805`）是否约束 `/schedule-message` 的 `next_send_at`，即「立刻执行」的行能不能建 | 若约束 → 改为包装层直插 D1（需查 `createTask` 对 `encrypted_payload` 的实际存储格式，转发方案作废） |
| V2 | `message_type='auto'` 的行被 tick 捡起后 hooks（`onBeforeFire`/`runAgenticFire`）是否照常运行（`taskNeedsLlm` chunk `:819`） | 若不走 → 换行型或换触发方式 |
| V3 | `upstream.scheduled(event, env)` 合成 event 需要哪些字段 | waitUntil 里怎么造 event |
| V4 | `buildScheduledPush`（`agentic.ts:381`）的 `messageType` 是否直接取 `metadata.amsgMode`，能否透出 `'instant'` | 客户端按 messageType 分轨 |
| V5 | 前端 `encryptPayload`（`utils/activeMsgClient.ts:890`）产出的信封是否与 SDK 内部一致、可被上游解开 | 不行 → 退化为两请求方案：SDK `putClientState` 先行 + `/instant-chat` 只带 taskPayload（可接受，报告里注明） |
| V6 | fire 链总超时（默认 5 轮/240s，chunk `:1070-1196`）能否经 `buildWorkerConfig` 配置，能否对 instant 任务单独调大 | 目标 ≥600s（cron 墙钟 15 分钟内）；只能全局调就全局调到 600s，并把 lease 变长（totalTimeoutMs + 2min）的影响写进报告 |

## fire_pack v7：`chat` 字段

- `AmsgFirePack`（`utils/amsgFirePack.ts`）增可选字段：

  ```ts
  chat?: {
    // 这一轮的 fullMessages（结构与本地生成走 /chat/completions 那份一致）。
    // chat.messages 不含前端时效段（时钟/节日/天气/热搜/MCP 说明），这些由 worker
    // 在 fire 时刻的时效块独家供给。
    // content 允许结构化片段数组（图片消息的 text + image_url），worker 只搬运不解释；
    // 超出 client_state 单条预算时从最旧的消息开始把 image_url 降回文字段，
    // 最新一条用户消息的图片永不降级，仍超预算则整轮明确报错。
    messages: { role: string; content: string | Array<{ type: string; [key: string]: unknown }> }[];
    builtAt: number;
  }
  ```

- `FIRE_PACK_VERSION` 6 → 7。开发期规矩：**不做旧格式兼容**，v6 包 parse 直接拒
  （现有定时任务的 fire_pack 会在下一轮 dirty-sync 时以 v7 重传，无需迁移代码）。
- `onBeforeFire`（`index.ts:791`）新增 instant 分支：`metadata.amsgInstantChat`
  为真时——
  - 用 `pack.chat.messages` 组请求消息（不走 `renderFirePack` 模板渲染），
    在末尾追加 system 块注入时效内容：当前时间（沿用角色时区约定）、
    实时世界块（`buildRealtimeWorldBlock`）。
  - **跳过**：presence gate、expire guard（`shouldExpireFire`）、
    task-instruction 检查——这些是「主动消息到点还该不该发」的语义，对
    「用户刚发消息等回复」不适用。
  - **照常**：工具循环、表情包、后台 MCP、self_log、任务列表块（角色平时聊天
    也能排未来消息，这个能力对话里同样要有）。
  - `pack.chat` 缺失而 metadata 标了 instant → 按失败处理（防止拿主动消息模板
    错答聊天）。

### 输入隔离与定时上下文

新即时任务只使用自己的输入引用；引用缺失、损坏或角色不匹配时明确失败，不能偷偷改用共享
`fire_pack.chat`。没有绑定输入的历史任务仍兼容共享 chat；共享快照损坏时，有效的绑定输入仍可执行。

即时 fire 开始后，可以把绑定包里的定时模板发布到共享 `fire_pack`，但保留既有 legacy chat，
并沿用输入原本的 `firePackUpdatedAt` 做条件写。较旧任务后执行，不能盖回较新的模板，也不能靠
旧包重新打开最新 `limits` 已关闭的权限。定时任务优先读共享快照；首次离线自排的子任务另绑
一份去掉 chat 的压缩输入引用。已有共享快照时不再读取这份兜底，输入 TTL 不限制长期循环任务寿命。

### 定时提示词与聊天设置

`buildFirePack` 每次从本地门牌库构建新的房间注入，不沿用角色对象上的旧缓存，也不要求配置
Embedding API。双语、HTML 和内心独白提示词由 `chatOutputStylePrompt` 供聊天和定时模板共用。
`thinkingChainEnabled` 明确标记模板已经包含内心独白协议；旧包缺省时不回传原始推理。

## push metadata 扩展字段

即时对话往返用到的 metadata 键，一并记在这（发侧走加密信封，回程随 push 明文 metadata）：

- 发侧（任务 metadata，走加密信封）：`amsgEmotionEval`（评估模板 + 副 API 凭据；worker
  在 `onBeforeFire` 捕获后就地删除，喂给 push 构建前再剥一层——凭据绝不进任何 push/outbox）。
- 回程（push metadata）：`amsgEmotionUpdate` / `amsgEmotionDone` / `amsgEmotionError`
  （评估结果 / 熄灯信号 / 脱敏后的失败原因）、`amsgReasoning`（思考链，只挂第一条 push、
  即时对话或开启内心独白的定时轮）、`amsgToolTrace`（`[{name,count}]`，只数真跑过的调用、只挂末条 push、
  只在即时对话轮）、`amsgUsage`（`{promptTokens, completionTokens}`，同样只挂末条 push、
  只在即时对话轮）。
- `amsgUsage` 的去处：客户端把它补进「设置 → API 调用记录」里那笔云端调用（发出时先落
  一笔 pending，收到末条推送时回填 Token）。它是**最后一次**模型调用的用量——带工具的
  一轮会连着调好几次模型，中间几次的数云端没留，所以跑过工具时那笔记录会标「只算末轮」。
- 超限旁路：新 Worker 用 `ctx.storeAttachment` 写入 `amsg:attachments`，metadata 携带
  `amsgEmotionAttachment`、`amsgReasoningAttachment`、`xhsSessionAttachment` 等对象引用。
  引用含 `version:1`、随机 key、`taskUuid`、`occurrenceMs`、`expiresAt`，写入时绑定角色 owner。
  客户端用 `getAttachment` 定点读取并校验绑定；读取成功也不删除，重试和另一台设备仍能取到，
  最长 30 天后回收。旧 `*Ref` 字符串仍可读；缺少 SDK 附件能力时，旧键增加
  `@<occurrenceMs>`，避免同一个重复任务的下一次触发覆盖上一次。

### SAR 临时模块（信封）

角色或用户身上有 SAR 临时模块时，模型回复是一个 `<SAR_MODULE_OUTPUT>` 信封：
`<CHAR_TRUE>` 是真意，`<CHAR_SURFACE>` 是角色台词被模块扭曲后的外显，`<USER_SURFACE>`
是用户本轮输入的外显。信封的解析和逐泡对齐用的是前后端共用的
`utils/vrWorld/sarEnvelopeCore.ts`，worker 侧的拆分与对齐在 `worker/amsg/src/sarEnvelope.ts`。

- 发侧 `amsgSar`（任务 metadata，形状 `AmsgSarModuleSnapshot`，`v: 1`）：请求发出那一刻冻结
  的模块快照。只在角色或用户身上有模块（active 或 afterglow）时存在。形状不对（不是对象 /
  `v` 不是 1）时 worker 当它不存在。
- 回程 `amsgSar`：发侧那份原样挂回，**只挂末条 push**，其余各条都不带。只要发侧带了合法快照
  就挂回，不看模型守没守信封、也不看是不是只剩余韵的轮次——客户端靠它写模块事件、推进回合。
- 回程 `amsgSarSurface`（形状 `SARModuleSurfaceMeta`，`surface` 只放这一条对应的那段外显）：
  角色模块 active、模型给了 CHAR_SURFACE 时，按 push 分段逐段对齐，对上的那条挂，对不上的不挂。
  挂了的那条 `notification.body` 用这段外显的横幅文本（界面默认显示外显，锁屏也一样）；
  `message` 仍是真意，落库为 content。
  横幅截到 100 个字符（超出时末尾是「…」）；metadata 里的外显不截。普通回合的横幅不受影响。
- 回程 `amsgSarUserSurface`：用户模块 active、模型给了 USER_SURFACE 时挂在末条 push，
  值是 USER_SURFACE 原文，worker 不做任何解析。

一条 push 装不下时，优先写不可变附件；旧 SDK 仍可走字符串旁路键：

| 字段 | 新附件字段 | 旧引用字段 | 旧 client_state 键 |
|---|---|---|---|
| `amsgSar` | `amsgSarAttachment` | `amsgSarRef` | `sar_snapshot:<clientTaskId>@<occurrenceMs>` |
| `amsgSarUserSurface` | `amsgSarUserSurfaceAttachment` | `amsgSarUserSurfaceRef` | `sar_user_surface:<clientTaskId>@<occurrenceMs>` |
| `amsgSarSurface` | `amsgSarSurfaceAttachment` | `amsgSarSurfaceRef` | `sar_surface:<clientTaskId>@<occurrenceMs>:<段序号>` |

段序号是这条 push 在本轮里的下标（0 起），同一轮几条 push 各存各的。挪的顺序：思考链 →
情绪评估 → `amsgSar` → `amsgSarUserSurface` → 本条 `amsgSarSurface` → XHS 会话数据，
每挪一样就重新量一次，装得下就停。

fire 时的处理规则：

- 需要信封（有模块 active）时，worker 在 finish、分段之前拆信封。分段、
  directives、self_log 只认 CHAR_TRUE（情绪评估与主生成并行、读的是请求消息，不读这一轮的
  回复）；CHAR_SURFACE / USER_SURFACE 不参与标签识别，里面写的标签（工具、排程、副作用）
  一律不执行。
- 逐轮拆：工具循环跑了几轮，就把每一轮的输出（补上没写完的闭合标签后）分别交给
  `parseSARModuleReply`，每一轮自己决定降级：
  - 这一轮守了信封 → 真意取它的 CHAR_TRUE，外显取它的 CHAR_SURFACE，只对齐这一轮的真意段；
  - 这一轮没守（拆不出非空的 CHAR_TRUE）→ 这一轮原文照发、不带外显，只剥掉散落的信封标签；
  - 各轮真意按顺序拼接；USER_SURFACE 取最后一个给了它的那一轮。
  没写外层 `<SAR_MODULE_OUTPUT>`、或 CHAR_SURFACE 写在 CHAR_TRUE 前面，都照样认。
- 只剩余韵（afterglow，不要求信封）时不拆，原文照旧分段。
- 对齐口径与客户端落库一致：只有台词占外显槽位。表情段（`[[SEND_EMOJI:…]]`）、`[html]` 段
  不占；纯括号动作段按共用的 `consumeSARChatSurfaceChunk` 处理；内置翻译 `<翻译>` 块、
  `<语音>` + `<字幕>` 块各占一格。外显那一侧先剔掉 `[[...]]` 指令和 `[html]` 块再分段。

## outbox（push 丢失的拉取兜底）

- 服务端 `message_outbox` 表（按用户存，不分角色也不分消息类型）。每条 push 发出去
  **之前**先落一行，客户端落库之后 `POST /outbox/ack` 销账，所以「哪些还没收下」是
  查得出来的事实，不用拿本地聊天记录去猜。行的保留期跟着 Web Push TTL 上限（四周）走。
- 写入点在库层的 push 发送路径上，定时主动消息和即时对话的产物都记。
- 客户端拉账本分两类时机，别混：
  - **上线补收**（`catchUpMissedPushes`）：冷启动、回到前台各一次，带 60s 节流，
    **不看有没有在等回复**。定时主动消息由云端到点自己发，客户端不产生任何「我在等它」
    的本地状态——只在等回复时才拉的话，这类消息的推送丢了就永远没人去捞。
  - **等回复时的点名**（`runInstantChatStatusCheck`）：每 60s 一跳，下结论前必拉一次
    最新的，不受节流管（拿旧账本去判「回复取不回」会误杀还在路上的回复）。
- 首次、自动和手动补收使用同一条落库流程；服务端仍保留的正文不按48小时时限丢弃，
  也不根据旧的 localStorage 接管标记整批 ACK。
- 补收前按角色扫描完整私聊历史，只收集本批 `messageId` 的匹配结果（包括已归档消息，
  不限最近200条，也不把整段历史载入内存）。已落库的只补 ACK；未收到的先存入 inbox，
  再经原有冲刷管线落库后 ACK。本地历史核对失败或 inbox 写入失败时保留云端记录。
- `result` 仍由对应处理器决定是否过期，成功处理后才 ACK；其原始 `createdAt` 必须传递。
  旧 `staleDropped` 返回字段保留为0，普通正文不会再因为年龄而被应用主动放弃。

### 已发送消息与生成前收件

- 定时消息发不发只在 Worker 定。到点时有一轮回复正在生成就等它结束：云端生成的即时回复和定时任务同在一个串行分组（`serialize_group = charId`），回复结束前定时任务认领不到；页面本地生成的那种靠在场记录 `chat_presence`（15 秒续一次、45 秒过期），记录新鲜时 `onBeforeFire` 返回 `{ defer }`，下一跳 cron 再来。等完之后角色看着最新对话自己决定说不说。
- 进入客户端 inbox 的消息一律接收，通知中的正文正常进入聊天；去重、分段保序、停止回复 UUID 守卫与失败重试照常生效。
- 没发的那次由 Worker 用 `ctx.emitResult` 回一条 `fire-skipped` 结果（`notification: { show: false }`，只落服务端收件箱），带任务 uuid、名义触发时刻和原因。客户端收到后记进回执台账，排程现状块下一轮告诉角色。客户端不对着聊天记录推断哪次没发。
- 即时回复的正文记在云端 self_log 里（带 `reply` 标记，最长 `SELF_LOG_REPLY_TEXT_MAX`）。紧跟着到点的定时消息在【这之后你回了对方】一段读到它，客户端还没把聊天记录传上来也接得上话。
- 用户发送的文字照常立即显示。`useChatAI` 在读取本轮历史前调用 `prepareInboxBeforeChat(charId)`：通过原有串行管线只认领当前角色的本地 inbox。有生成停在这一步等的期间，整条串行链跳过打字动画（包括别的角色正在慢放的消息），等的人走了就恢复。当前角色没有可收的消息、也没有消息正在处理时直接返回，不认领、不排队、不留 trace——收件箱里别的角色的消息不算。正等重试或等前段的消息留给各自的定时器，这一步不重跑它们。
- 结果：`completed`（已到本机的都落库了）、`pending`（还有消息留在 inbox：多段没到齐被扣住，或处理失败等重试）、`timeout`（等满 30 秒）、`stalled`（同一趟收件已让上一次生成等到超时、至今没跑完，这次不等）。`pending` / `timeout` 提示「消息接收较慢」，`stalled` 不重复提示；三种都用当时已落库的历史继续生成，原收件处理继续。同一角色同时只跑一趟。
- 等待超过 300ms 显示「正在接收刚到的消息…」。停止回复可立即退出等待。
- 这一步不拉云端 outbox，也不等待 1/5/30 秒的完整失败重试周期。附带数据取回、落库等实际处理仍可能需要等待；30 秒是本轮生成的等待上限，不是取消消息的期限。
- 收进来的消息落在用户刚发的那句之后，历史会以角色发言结尾。末尾那几条全是定时主动消息时，请求末尾补的提示是「回应用户刚说的话」（`hasUnansweredUserTurn`），区别于没按发送就让角色继续时的续说提示。

## 失败路径

- 即时对话的生成失败**不自动重试**，不按 API 的 HTTP 状态或供应商错误码枚举。
  Worker 通过 `amsg-server 2.6.0-next.31+` 的正式配置 `maxGenerationRetries(task)` 对 instant 返回 `0`，
  其他任务返回 `undefined` 沿用默认值。上游在 `onBeforeFire` 前解析策略，因此
  读取上下文失败也会直接结束本轮。`amsgFireSettled` 只在上游报告 `willRetry: false`
  且内容未入箱时写失败原因、发 error push，状态轮询负责兜底，不再修改错误对象。
  该行为由真实 `amsg-server.runTask` 集成测试约束，升级依赖时必须继续验证。
  整批已入 outbox 的推送失败仍可补推原文，不重新生成；定时消息的重试策略不变。
  此规则针对有明确失败结局的 fire；执行环境中断、没有机会收尾时，租约恢复仍保留。

- 客户端「正在输入」的主判定是**云端任务状态**：还欠着回复时每 60s 查一次
  `GET /message?id=<uuid>`，`pending` 就继续等，行已失败 / 行没了才收尾；
  查询本身失败不立刻下结论，等下一跳。下结论前先拉一次 outbox。
  **只在前台查**：页面不可见时既不查也不排下一跳，回前台立刻点一次名把周期接上。
  **失联判死线**：联网状态（`navigator.onLine !== false`）下同一轮连续 5 次查询
  失败 → worker 多半已不在（被删 / 密钥换了），明确收尾并提示去设置页重新连接
  验证；离线时的失败不计数。「不按时长宣判」只对云端还答得上话的等待成立。
- worker 留痕 `chat_fail`（char namespace 的 client_state，认 uuid）：fire 收尾
  失败、过期跳过（reason `stale`）、以及没有可交付正文或动作的 skip-push（如
  `empty-generation`）时写。只有动作的成功结果不写失败留痕。客户端 completed 与 gone 两个分支都点名读回翻成人话，别把
  「没生成出来」说成「回复没能取回」。
- worker 侧若现有 hook（如 `onFireSettled`）拿得到失败结局且拿得到 push 发送
  能力 → 尽力补发一条 `messageKind: 'error'`（SW 已有该分轨）。拿不到就算了，
  别为此改上游。
- POST `/instant-chat` 任何一步 await 失败 → 客户端收到明确错误 → 界面报
  发送失败可重试。**绝不静默转回本地生成**。

## 只有动作的回复

转账、戳一戳、日记或小红书操作等没有正文时，Worker 仍通过 `ctx.emitResult` 提交
`resultKind:'assistant-actions'` 的可靠结果，携带 directives、必要的 XHS 会话和排程变更，
`notification.show:false`，不发送空白聊天横幅。写结果失败就报错，不把动作当成已经完成。

客户端 `amsgActionResult` 将结果转入本地收件箱，立即调用同一套后处理并确认落库，之后才 ACK。
只含 result 的 outbox 批次也必须触发这一步；它不会增加普通正文的 `written` 计数。
重复结果按持久化 messageId、独立 IDB 完成回执与收件箱处理记录去重；同一个结果的并发请求
共用一次处理。完成回执在 ACK 之前落盘，无聊天产物的动作也有去重依据。外部动作已经执行、
本地回执尚未写成功时仍存在重试窗口，这套回执不等于外部服务的 exactly-once 保证。成功的纯动作轮不写
`last_skip` 或 `chat_fail`，收尾账目按已交付结果处理。

## 已拍板的行为语义

- 连发两条：第二条 POST 用 `supersedesUuid` 顶掉未认领的上一条（合并成一起回）。
  上一条已认领（正在生成）→ 让它跑完，新任务靠 `serialize_group`（= charId）
  排队，接受小概率两条相近回复。
- push 成功后、行删除前 isolate 死掉 → cron 重跑 → 重复回复。窗口极小，
  与现有定时任务同类，接受。
- 群聊不动（收件箱按 charId 路由，群聊没有 charId）。
- presence / dirty-sync 机制**保留不退役**（开关关闭的用户仍走本地路径需要它们，
  打脏后微任务内立即上传，同一轮的连环打脏合并成一次）；instant 分支天然绕开：
  不起 presence 心跳，POST 即上传所以不 markDirty。

## 分工与边界

**Agent 1（worker 侧）只准动**：`worker/amsg/src/index.ts`、
`worker/amsg/src/` 下新文件（如 `instantChat.ts`）、`utils/amsgFirePack.ts`
（v7 类型与 parse）、对应 `*.test.ts`。

**Agent 2（前端侧）只准动**：`hooks/useChatAI.ts`、`apps/Chat.tsx`（最小接线）、
`utils/activeMsgClient.ts`、`utils/activeMsgRuntime.ts`、`types.ts`
（`ActiveMsg2GlobalConfig` 加字段）、
`components/settings/ActiveMsgGlobalSettingsModal.tsx`、`worker/sw-keep-alive.ts`
（仅 when-hidden 调查结论落地）、对应测试。接缝在 `useChatAI.ts:1076`
现有 instant-push 分支旁，同样排除 mcd/luckin/mcp 本地工具循环场景。

**共同纪律**：
- 禁跑任何改状态的 git 命令；禁碰边界外文件。
- `pnpm vitest run` 全绿；`pnpm build:workers` 通过（叶子模块不得引入浏览器依赖，
  worker 侧新 import 一律过一遍这条）。
- 新行为配回归守卫测试（旧行为下会挂、修好后过）。
- 测试 fixture 里的用户名用「小明」，不写真实姓名。
- UTF-8；注释密度与风格跟随周边代码。

## 停止契约（2026-10-01）

- `/instant-chat` 加密任务体允许传 `uuid`，由客户端在发请求之前生成。202 仍以服务端回传 UUID 为准。
- 使用既有 `DELETE /cancel-message?id=<uuid>`。客户端立即停止接收；云端通过 1 秒租约心跳感知取消，实际耗时还受网络影响。早于建行的 DELETE 不能阻止未来建行，因此 POST 收尾仍需再取消一次。
- `onBeforeFire` / `onLLMOutput` / `executeToolCalls` 的 `ctx.signal` 和 `ctx.throwIfCancelled()` 来自上游。LLM、可取消工具请求共享取消信号；工具 catch 必须先检查取消，禁止误吞。
- `onFireSettled` 的 `cancelled` 是独立结束原因，不触发 instant 失败消息或生成重试。已完成的副作用不回滚。
- `amsg:char:<charId>` 新增独立键 `chat_stop:<uuid>`，值为裸 JSON `{ "text": "已显示的正文" }`，空串表示没有正文上屏。客户端停止记录与回执持久化；下一次状态上传会带上回执。Worker 开始 instant 前遇到对应键直接 skip，读取 self_log 时用回执替换/移除对应 `taskUuid` 条目。
- 聊天气泡 `metadata.activeMsg2.taskUuid` 记录轮次归属，用于停止后的落库清理。停止不新增消息类型，不生成“已停止”气泡。
- 收件箱遇到已停止的 UUID：丢弃并 ACK，禁止原稿降级、重试与副作用重放。若迟到末段带用量，可补记 API 用量，但不会恢复正文或把停止改成成功。
