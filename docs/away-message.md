# 离开后消息

目标与红线见 [主动消息 2.0 总纲](./amsg2-overview.md)。

用户超过设定的时间没说话，角色就来找用户。一次离开只找一次，用户开口后重新计时。

入口：聊天「＋」→「离开后消息」（`components/chat/AwayMessageSettingsModal.tsx`）。按角色设开关和等待时长（30 分钟到 6 小时，默认 90 分钟），存在 `CharacterProfile.awayMessage` 上，导出角色卡时剥掉。

## 两条路，按角色二选一

| 角色状态 | 走哪条 | 用户看到的 |
|---|---|---|
| 开着主动消息 2.0，且配了 Worker | 云端 | 到时间直接收到推送，一次离开只发一次 |
| 其余 | 本地 | 下次打开页面时，补上离开期间 TA 发的消息；离开得久，最多补三次 |

判定只有一处：`utils/awayMessage.ts` 的 `isAwayCloudRoute`。两条路不叠加：叠加的话云端发过一次，用户上线时本地又补一遍，同一段离开会收到两份。

## 云端

每个角色挂一条云端任务（任务记录上 `away: true`，任务 metadata 带 `amsgAwayMessage` 和 `amsgAwayDelayMinutes`）。

- **谁来维护**：每轮聊天开场（`hooks/useChatAI.ts`）以及见面、通话轮次落库时（`apps/DateApp.tsx`、`apps/CallApp.tsx`）维护云端任务，目标时刻是「最近一次在场互动 + 等待时长」（在场互动包含用户的真实发言，以及 `date`、`call`、`call-end-popup` 记录）。已有任务排得够晚（离目标不到 10 分钟）就不发请求；排早了原地改期；远端已经没有（发过了或被取消）就新建。
- **差的那点谁兜**：`fire_pack` 快照随包带上 `lastAwayAnchorAt`（最近一次用户真实发言或线下见面／通话记录时刻，含已归档记录）；worker 到点时取它、聊天在场记录与当前新鲜见面租约（`presence.scene === 'date'`）里最新的那份再算一遍，没到就 `defer` 到该来的时候。推迟不消费任务、不占重试、不留跳过记录，也不会在用户正停在见面画面时当面弹出离开后消息。推迟时任务的原定时刻跟着改到唤醒时刻（`defer` 带 `reschedule: true`），推多久都不会撞上 60 分钟的过期线（见 [频率与额度](./amsg2-pacing-limits.md#到点闸的顺序onbeforefire)）。
- **说法到点现算**：`fire_pack` 还带可选字段 `awayAnchor`，记着计时起点是哪种在场互动（线上发言、见面分开、通话挂断）。worker 到点用和本地同一份 `buildAwayFireInstruction` 现算「本次任务」：按起点类型换说法，3 小时内刚见过面时切到「刚分开」的语境。打包之后用户又在线上开过口，起点就按那次线上发言算；之后角色又发过消息，就不再算「刚分开」。角色关了聊天时间感知时不报钟，也不报隔了多少分钟。旧包没带 `awayAnchor` 时，用排程时写进 metadata 的那份通用指令（`buildAwayTaskInstruction`）。
- **到点必发**：任务是 force 策略，提示词里去掉【开口之前】那段，角色没有「这次不说」的选项。
- **计入连发上限**：它发出去算一次「没回时找你」，到点时也受「没回时最多连着找几次」拦；之后角色自排的接着往上数。每日上限也照常管它：发出去计入当天的发送次数，当天次数到了上限也会被拦。这样定的原因：它在聊天语境里生成，角色这一轮能顺手给自己排下一条，后面那条又能再排，用户不回就会一路排下去。把它和它带出来的后续放进同一个计数里，才拦得住这条链。
- **不占任务名额**：建它时不查「最多同时排几次」，名额满了也能建。
- **模型参数和情绪评估**：和定时主动消息同一套。温度、输出上限、思考参数与本地私聊相同，冻在任务行上（刷新时机见 [LLM 凭据契约](../plans/amsg2-llm-credentials-contract.md)）；角色开了情绪评估时，worker 到点和主生成一起评估，结论随推送回来。
- **关掉或改了等待时长**：取消云端那条，用户下次开口时按新设置重建。

## 本地

打开页面和切回前台时（`context/OSContext.tsx`），对开了这项、走本地路的角色逐个检查：

- 最后一次互动已经超过等待时长，并且那之后还没补过（补出来的消息 metadata 带 `awayMessage: true`，这是「这段离开补过了」的唯一依据），才补。互动起点从最近消息里倒序找：用户的真实发言（排除隐藏提示 `proactiveHint`），以及线下见面、实时通话记录（`source` 为 `date`、`call`、`call-end-popup`，不限 `role`）。线上 `assistant` 消息不计入起点，避免主动消息、见面离开提醒或手机卡片重置离开计时；见面开场白、重随回复、通话挂断记录，以及用户删掉自己的推进词后留下的角色见面正文都只在双方实时在场时产生，计入起点能让计时从实际分开的那一刻算起；
- 用户正和这个角色见面或通话（含挂起在后台的见面和通话）时不补；见面挂起后的短时提醒走 `utils/dateLeaveReminder.ts` 的独立计时，不受这里影响；
- 离开越久补的次数越多：每过一个等待时长一次，最多三次。时刻第一次落在等待时长刚满时，其余铺到现在之前。模型一次写完，用 `[[NEXT]]` 隔开各次，每次按自己的时刻落库；
- 生成期间用户回来说了话，或进入了新的见面／通话，这次补的就停下：每一轮回连请求前、每一段落库前都会再确认一次，用户回来了就中止，之后的回连和落库都不再发生。已经落库的那几段保留，中止时不弹通知、不评估情绪、不销回执；
- 失败后 10 分钟内不再试。

生成由 `runLocalProactiveTurn` 完成（见面离开提醒的本地版也用它），提示词和云端到点生成是同一套模板：`buildFirePack` 打包、`renderFirePack` 填槽，整份上下文是一条 user 消息，指令只进这次请求、不落库。worker 到点才现取的实时世界（天气、热搜、节日）和用户所在地节日，本地按同样的开关现取，取不到就整段不出现。两边只差 worker 追加在末尾的排程、MCP 和回复范围说明：走本地这条路的角色用不了 Worker 排程，这一轮也不跑 MCP 工具循环，请求里不带任何工具，用不上的就不教。只补一次时，本地发出的提示词和 worker 到点拼出来的逐字相同，由 `utils/awayMessage.parity.test.ts` 钉住。

「本次任务」的说法和云端同一份（`utils/awayMessagePrompt.ts` 的 `buildAwayFireInstruction`），按第一次发送的时刻算。整份提示词里的「现在」只有这一个：当前时间、此刻在做什么、角色那边的节日都按这一刻算。起点来自见面或通话记录时，按线下分开或通话挂断来说；最近一条真实消息是 3 小时内的见面记录时，切到分别后的语境，不要求模型编造上下文里没有的细节。时刻按角色时区表示，关闭时间感知时不报钟，也不报隔了多久。要补好几次时，在这段指令后面追加几行，交代分几次、各在什么时刻，用 `[[NEXT]]` 隔开。

采样温度、输出上限和思考参数与私聊同一套（`utils/dialogueLlmParams.ts` 的 `resolveDialogueLlmParams`）。落库走 `applyAssistantPostProcessing`，召回、搜索、读日记这类标签会真的回连模型执行，和私聊同一条回连链：每一轮把所有标签一起执行、结果一起交回，最多 5 轮，最后一轮用共用的收尾提示；回复里用到这类标签时，这一轮合成一次、落在第一个时刻，二轮请求改用只发一次的指令，免得二轮又按分次的格式写。未读、提示和系统通知沿用主动消息送达的 `active-msg-received`。回复落库后跑一次情绪评估，开关和副 API 与私聊同一份，喂给评估器的是这一轮的整份提示词。模板里带了「上次排的没发出去」回执时，这一轮发出去后把它们标成已告知，口径和云端定时消息落地时一样。

## 改这块时要一起动的地方

| 改什么 | 位置 |
|---|---|
| 判定、分时刻、切分、要不要改期 | `utils/awayMessageCore.ts`（有单测） |
| 云端维护、本地生成（`runLocalProactiveTurn`） | `utils/awayMessage.ts`；本地与云端提示词逐字对照在 `utils/awayMessage.parity.test.ts` |
| 「本次任务」说法（按起点类型、刚分开的语境，云端本地共用） | `utils/awayMessagePrompt.ts` 的 `buildAwayFireInstruction` |
| 起点类型随包上云 | `utils/activeMsgClient.ts` 的 `buildFirePack`（`awayAnchor`）；字段定义在 `utils/amsgFirePack.ts` |
| 旧包兜底的指令文案、metadata 键 | `utils/amsgFireSchedule.ts` 的 `buildAwayTaskInstruction` |
| 模型参数（与私聊同一套） | `utils/dialogueLlmParams.ts` |
| 到点推迟、计入连发、必发、现算说法 | `worker/amsg/src/index.ts` 的 `onBeforeFire`；`renderFirePack` 的 `mustSpeak` |

worker 有改动时先部署 worker，并把 `utils/amsgBundleVersion.ts` 往前推一版。
