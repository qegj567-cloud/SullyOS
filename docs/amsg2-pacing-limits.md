# 主动消息 · 频率与额度

用户给每个角色定的主动消息上限。角色在这些上限之内自己挑时机：什么时候接着说、要不要给自己排下一条。上限本身由代码硬拦，排程时直接打回，到点时直接跳过，不靠提示词去劝。提示词只负责把「还剩多少额度」告诉角色。

面板入口：聊天设置 →「主动消息 2.0」→「主动频率」卡片上的「调整」（`components/chat/ActiveMsg2PacingModal.tsx`）。

## 七项设置

都挂在 `ActiveMsg2CharacterConfig` 上，按角色分别设。没设就用 `utils/amsgLimits.ts` 里的默认值。

| 设置（字段） | 默认 | 设成 0 | 管哪些消息 | 在哪拦 |
|---|---|---|---|---|
| 没回时最多连着找几次（`maxUnansweredSends`） | 3 次 | 不限 | 角色自排的 | 排程时 + 到点时 |
| 两次之间至少隔多久（`minSendGapMinutes`） | 10 分钟 | 不额外限制 | 角色自排的 | 排程时 + 到点时 |
| 每天最多主动找几次（`dailySendCap`） | 不限 | 不限 | 全部定时消息（用户手动排的也算） | 到点时 |
| 重复的消息连续几次没回就停（`recurringStopAfter`） | 3 次 | 不停 | 全部每天/每周重复的 | 到点时 |
| 最多同时排好几次（`maxActiveTasks`） | 5 次 | 取值 1~10，没有「不限」 | 用户和角色共用 | 排程时 |
| 角色能不能排重复的（`allowSelfRecurring`） | 不能 | — | 角色自排的 | 排程时 + 到点时 |
| 角色能不能排「到点必发」（`allowSelfForce`） | 不能 | — | 角色自排的 | 排程时降级 + 到点时降级 |

几条共同的口径：

- 数的是「次」，不是「条」：角色主动找你一次，可能分成好几段气泡，只算一次。面板、提示、给角色看的提示词里，凡是数主动消息的地方一律按「次」说——上限、名额、「TA 排过几次重复消息」都一样；「条」只留给「一次发了几条气泡」，别混用。每天/每周重复的只占一个名额。

- 即时对话的回复一律不算。那是正常聊天。
- 固定内容的任务不调模型，也不经过到点那几道闸，所以「每天最多几次」和「重复的连续没回就停」都管不到它。面板文案里写明了「写好固定内容的那种不算」。
- 「角色自排」看任务 metadata 上的 `amsgSelfScheduled`。前台工具桥和到点生成里的排程工具都会打上这个标记。
- 「到点必发」没放开时，角色的 force 不会被打回，而是按 expire 来排；已经排下的 force 任务到点时也按 expire 判。用户自己排的 force 不受这项影响。前台改期（renew 一次性任务）沿用原任务的策略，不降级。
- 跳过是真的跳过：一次性任务当场被删，不补发；重复任务只是推到下一次。
- 角色改期（renew）一条用户自己排的一次性任务，改完还是用户的任务：不打自排标记，策略沿用原来的。补当次（给重复任务补一条一次性的）算角色新排的。
- 「可以排重复的」没开、角色名下却还挂着重复消息时（比如这项设置出现之前排的），面板的「主动频率」卡片上会提示这些不会再发，让用户自己选打开还是取消，不替用户删。

## 数据怎么流

- **上限**：保存在本地 config 上。云端单独存一份 `limits` 记录（命名空间 `amsg:char:<id>`，key `limits`，形状见 `AmsgLimitsRecord`）。有两条上传路：
  - 面板保存时立刻单独传（`ActiveMsgClient.putCharLimits`）；
  - 每次传 fire_pack 时顺手带一份（`buildCharStateEntries`）。
  worker 每次到点都读这份记录。记录缺失或读不出来时按默认值处理，默认值本身是偏严的那一侧。
- **关 2.0**：面板会先把 `limits.selfScheduleEnabled` 写成 false，再去取消任务。取消扫完之后才冒出来的自排任务（正在跑的那一轮顺手排的），到点时会被 `schedule-off` 跳过。即时对话也关着的话，关闭时会把这个角色的云端上下文整个清掉（limits 跟着一起没了），这时残留任务到点是读不到上下文、直接失败，同样不会调模型。
- **升级窗口**：worker 换了新版、前端还没刷新时，云端没有 limits 那份。这时连发上限退回读老 fire_pack 上的 `maxUnansweredSends`，其余几项按默认值。前端第一次上传上下文就会带上 limits。
- **每日计数**：`daily_sends` 记录，在同一个命名空间里。worker 在 fire 收尾时累加，只记定时触发，按**用户那边的日期**（fire_pack 的 `userTzId`）。里面两个数：
  - `sends`：发出去几次，多段气泡只算一次；
  - `llmCalls`：调了几次模型，失败和判空的也算。这个数要上游 amsg-server 在收尾 hook 上报 `llmCalls` 才有，老版本上游没有这一项。
  面板上「今天 TA 已主动找你 N 次」读的就是这份。推送失败、但整批已经落进服务端收件箱的（收尾 hook 上 `outboxed` 为真），按「发出去了」记：上游重试时只补推原文，不会重新生成，而且补推那一跳不再调任何 hook。
- **重复任务连续没回**：self_log 上的 `recurringSends`，按任务的 `clientTaskId` 各记各的，用户一开口就和连发计数一起清零。

## 排程许可与任务清单

`selfScheduleEnabled` 是执行许可：声明工具、识别文字兼容调用和真正执行 schedule/cancel/renew
都要过这道检查。Markdown 代码块和行内代码里的调用示例不执行。客户端收下历史自排任务时，
缺失配置默认仍为关闭，不能顺手替用户打开 2.0。

任务名额和排程清单优先使用 `ctx.listTasks` 分页返回的服务端 pending 行，排除即时聊天和后台
作业，并按 UUID 去重。已过期但服务端仍待处理的任务继续计数；快照里有而服务端已不存在的
幽灵任务不占名额。旧 SDK 没有查询能力时，才合并 `pendingTasks` 与 `self_log.tasks`，过滤掉
已经结束的一次性快照任务。`fire_pack.builtAt` 更新只表示模板变了，不能清空未认领的自排记录；
同 UUID 真正出现在客户端 `pendingTasks` 中，才逐项移除备账。

一次性任务改期与新建共用间隔检查，计算相邻时间时排除目标自己的旧时间。改期成功会立即更新
同一轮的内存清单，下一次工具调用看到新时间。已经跳过并删除的一次性任务不能 renew；回执会
引导角色用 `schedule_active_message` 新建一次联系。

## 到点闸的顺序（onBeforeFire）

只列跟这份文档有关的几道，按出现的先后排。

最前面一道不是拦，是等：页面正在本地生成一轮回复（在场记录 `chat_presence` 还新鲜）时，这次触发推迟 45 秒、下一跳 cron 再来（`onBeforeFire` 返回 `{ defer }`），任务不消费、不留记录。policy 为 expire 时才生效，没放开的角色 force 在这里已按 expire 算。云端生成的即时回复不用这道门：它和定时任务排在同一个串行分组里，回复结束前定时任务认领不到。

后面每道拦下都会写 `last_skip`，面板用 `describeLastSkip` 照实说明原因：

1. 2.0 关了，或者角色自排了重复任务但用户没放开 → `schedule-off`
2. 角色自排的，连发已到上限 → `unanswered-limit`
3. 角色自排的，离上一条主动消息还没隔够。「上一条」按它开始生成的时刻算（日志条目的 `startedAt`），跟排程时比的是同一个时刻；另有 3 分钟宽限（`FIRE_GAP_TOLERANCE_MS`）兜住没有 `startedAt` 的老条目 → `min-gap`
4. 重复任务连续没回够次数 → `recurring-unanswered`
5. 今天已发满 → `daily-limit`

过了这几道就生成。到点时用户在不在聊天不拦发送：角色看着最新的对话自己决定说不说（提示词里的【开口之前】），决定不说时输出 `AMSG_SILENT_MARK`，记成 `declined`。

除了 `schedule-off`，每次没发还会用 `ctx.emitResult` 回一条 `fire-skipped` 结果（不弹通知）。客户端收到后记进回执台账，角色下一轮聊天时在排程现状块里看到这条没发和原因（`utils/amsgFireSkipResult.ts`、`utils/amsgFireSkipResultApply.ts`）。

## 告诉角色的那一段

`buildLimitsBrief` 负责拼「用户给你定的规矩」这一段，只列真在起作用的几条，写成事实。它出现在两个地方：

- 到点生成时，接在「你可以给自己排下一条」说明块的末尾，带上还能排几次、最早排到几点、今天还剩几次；
- 前台聊天时，放进排程现状块（`buildAmsg2TaskContextText`）。

排程工具的签名也跟着设置走：没放开的能力，对应的参数（`recurrence` / `expire_policy`）直接不出现。

平时聊天的自主联系说明由 `utils/amsgFireSchedule.ts` 的 `buildAmsg2ChatScheduleBrief` 统一提供：本地聊天放进排程现状块，即时对话由 Worker 放进时效块，即使没有待触发任务也要带上。两边都教角色因惦记、分享自己的生活、兑现承诺而排未来的联系，不只响应用户的明确要求。即时对话的排程工具也使用聊天语境；只有定时主动消息触发时才教「这条发完，再接着说」。角色关掉 2.0 或 Worker 不支持排程时，不注入这份能力说明。

## 改这块时要一起动的地方

| 改什么 | 位置 |
|---|---|
| 默认值、判定、给角色看的那段话 | `utils/amsgLimits.ts` |
| 到点那几道闸、收尾计数 | `worker/amsg/src/index.ts` 的 `onBeforeFire`、`amsgFireSettled` |
| 到点排程工具的打回 | 同文件的 `runFireScheduleTool` |
| 前台工具签名与打回 | `utils/amsg2ToolBridge.ts` |
| 面板 | `components/chat/ActiveMsg2PacingModal.tsx`、`ActiveMsg2SettingsModal.tsx` |
| 跳过原因的人话 | `utils/amsgFirePack.ts` 的 `describeLastSkip` |

worker 和前端都改了的话，**先部署 worker**，并把 `utils/amsgBundleVersion.ts` 往前推一版，让设置页提示用户更新自己那台 Worker。
