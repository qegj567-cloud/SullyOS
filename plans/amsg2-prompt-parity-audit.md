# 主动消息 2.0 · 云端与本地提示词差异审计

这份清单逐项对比主动消息 2.0 在 Worker 上生成时拼出的提示词和上下文，与前端本地生成同一角色时拼出的内容，列出每一处差异，供维护者逐条裁定：搬上云，还是在云端去掉以对齐本地。裁定后登进 [`docs/amsg2-overview.md`](../docs/amsg2-overview.md)「云端与本地一致」那张表。

- **审计时间**：2026-11-23，基于 dev 分支（`6f65551e`）。
- **方法**：只读代码，没有跑测试，也没有真机抓过实际请求。行号是打开文件确认过的；其中温度、双语清洗、表情识图、MCP 用户名、即时对话时区说明这几条又单独复核过。
- **处理状态**：每条疑似遗漏的最后一列按改动后的代码标注。「已对齐」指两边已改成同一份做法，「已登记」指归入总纲表里的有意差异，「待定」等维护者裁定。
- **本地基准**：私聊路径，即 `hooks/useChatAI.ts` → `utils/chatRequestPayload.ts` → `ChatPrompts.buildSystemPromptParts` / `ContextBuilder`。离开后消息和见面离开提醒另有本地版（`utils/awayMessage.ts` 的 `runLocalProactiveTurn`），这两条路径的对比以本地版为准，私聊作参照。

## 分类口径

| 分类 | 含义 |
|---|---|
| 已登记 | 总纲表里那两条：实时信息由 Worker 现取；排程能力说明 |
| 明显有意 | 代码注释或功能文档写了理由，但还没登进总纲 |
| 疑似遗漏 | 没写理由。尤其是一侧有、另一侧没有的「丢东西」 |

## 两条云端路径的结构

先看结构。很多条差异都是由这两种结构带出来的。

- **即时对话**不重新渲染模板。前端先用 `buildChatRequestPayload({ timelyByWorker: true })` 拼出本地那串消息（已经去掉时钟、实时世界和 MCP 说明），原样放进 fire_pack 的 chat 段（`hooks/useChatAI.ts:1350-1353` → `utils/activeMsgClient.ts:3341-3348`）。Worker 在 `timelyInsertAt` 位置插一块「此刻的系统信息」（`worker/amsg/src/index.ts:2653-2678`），再把用户所在地的节日写进用户资料（`index.ts:2683-2687`）。所以角色卡、世界书、记忆召回、近况、月度总结、buff、历史范围、日程、音乐、表情包、各种格式说明，以及 temperature、max_tokens、思考参数，两边天然一致。
- **定时主动消息、离开后消息、见面离开提醒**用的都是 fire_pack 模板：打包时（`utils/activeMsgClient.ts:797` 起的 `buildFirePack`）把整份角色设定、输出格式块、纯文本转写的历史烤成**一条 user 消息**，到点由 Worker 填槽（`index.ts:2734-2748`）。本地则是稳定 system、多条历史、易变 system 依次排开（`utils/chatRequestPayload.ts:483-487`）。`utils/chatPrompts.ts:150-178` 有一张注释表，列了模板里不烤的块和理由，表里各行都核对过，代码确实是那样做的。

## 疑似遗漏

编号带路径前缀：**T** 是定时类（fire_pack 模板，离开后消息和见面离开提醒也受影响），**I** 是即时对话，**A** 是离开后消息，**D** 是见面离开提醒，**L** 是离开后消息和见面离开提醒的本地版。

### 定时类（fire_pack 模板通用）

| # | 维度 | 差异 | 哪侧有 | 本地位置 | 云端位置 | 处理 |
|---|---|---|---|---|---|---|
| T1 | 模型参数 | 定时任务不传 temperature，上游遇到消息数组也不补默认值，等于用服务商默认温度；本地用 `effectiveApi.temperature ?? apiConfig.temperature ?? 0.85` | 仅本地 | `hooks/useChatAI.ts:1150-1158` | `utils/activeMsgClient.ts:2968-2994`；`node_modules/@rei-standard/amsg-shared/dist/index.mjs:223-227` | 已对齐：温度与本地私聊同一套，冻在任务行上 |
| T2 | 心象 / 思考 | 本地开了心象时，请求带 `thinking`、`reasoning_effort`、`extra_body.thinking`（有的中转还要给模型名加 `-thinking`）；定时任务一项都不带，靠请求参数开思考的渠道就没有心象。即时对话会专门把这几项传上去 | 仅本地 | `hooks/useChatAI.ts:1174-1194` | `utils/activeMsgClient.ts:2926-2995`；即时对话对照 `useChatAI.ts:1361-1374` | 已对齐：思考参数冻在任务行上，判定与私聊同一套，`-thinking` 后缀写在模型名里 |
| T3 | 模型参数 | max_tokens 读的不是同一个设置：本地读 API 设置里的 `dialogueMaxTokens`（默认 8000），定时任务读 2.0 设置里的 `config.maxTokens`，没填就不传 | 两侧不同 | `hooks/useChatAI.ts:1156` | `utils/activeMsgClient.ts:2992-2994` | 已对齐：输出上限与私聊同读 API 设置，2.0 设置里不再单设 |
| T4 | 聊天历史 | 本地会剥掉历史里的 `%%BILINGUAL%%` 译文和 `<翻译>` 标签；云端转写没有清洗，开过翻译的角色，云端看到的历史里带着译文和标签 | 仅本地清洗 | `utils/chatRequestPayload.ts:377`；`utils/promptMessageCleanup.ts:5-19` | `utils/activeMsgClient.ts:926-938` | 已对齐：转写与私聊同一份排版，剥掉双语译文 |
| T5 | 聊天历史 | 本地角色开了表情识图（`stickerVision`）时，用户发的表情会带识图描述或原图；云端转写不传这个选项，只剩表情名 | 仅本地 | `utils/chatRequestPayload.ts:373` | `utils/activeMsgClient.ts:935` | 已对齐：转写带上表情识图描述 |
| T6 | 世界书 | 关键词扫描的文本不同：本地扫格式化后的历史（带时间前缀、表情名、卡片转写），云端扫数据库里的原始消息，扫描深度数到的消息也可能不同。另外，概率条目在打包时抽一次签，到下次重新打包前每次到点都用这一次的结果 | 两侧不同 | `utils/chatRequestPayload.ts:389` | `utils/chatPrompts.ts:293-296`；`utils/context.ts:782-790`；`utils/worldbook.ts:141-145` | 已对齐：扫描文本相同；概率条目到点现抽（`fire_pack.worldbookRolls`，需新版 Worker） |
| T7 | 情绪 / buff | 本地每轮回复后都跑情绪评估，更新 buff 和内心想法。Worker 只在即时对话里跑；定时消息落地时，客户端也不补跑。`activeMsgRuntime.ts:1071` 的注释写着「在 worker 跑」，这话只对即时对话成立 | 仅本地 | `hooks/useChatAI.ts:1030-1052` | `worker/amsg/src/index.ts:2698-2722`（只在即时分支）；`utils/activeMsgRuntime.ts:1071-1072` | 已对齐：Worker 到点评估（`fire_pack.emotionEval`） |
| T8 | 工具说明 | MCP 说明块：Worker 调用时没传 `userName`，开头写成「用户 在设置里给你连了 MCP 工具服务器」；也没有本地那条末尾提醒 `MCP_TAIL_REMINDER`。即时对话同样受影响，见 I6 | 两侧不同 | `utils/chatRequestPayload.ts:449-455`、`:496-498`；`utils/mcpToolBridge.ts:81-111` | `worker/amsg/src/index.ts:2577`；`utils/mcpFireCore.ts:897-902` | 已对齐：带用户名，原生工具时末尾带提醒 |
| T9 | 排程 | 本地会注入「上次排的那条没发出去」的回执，定时触发时不带，只有清单和额度。属于已登记第二条的范围，回执本身没登记 | 仅本地 | `hooks/useChatAI.ts:1255-1257`、`:1333-1335`；`utils/amsg2TaskContext.ts:134-146` | `worker/amsg/src/index.ts:2544-2555` | 已对齐：回执随模板带上（`fire_pack.noticeIds`），落地时销账 |

### 即时对话

| # | 维度 | 差异 | 哪侧有 | 本地位置 | 云端位置 | 处理 |
|---|---|---|---|---|---|---|
| I1 | 时间 / 时区 | 角色设了自定义时区时，本地会加一句「你身处 X 时区……对方可能在不同的时区」；Worker 补的时效块里没有这句。定时模板专门把它烤进去了，即时对话没补 | 仅本地 | `utils/context.ts:246-247` | `worker/amsg/src/instantChat.ts:79-94`；定时路径对照 `utils/activeMsgClient.ts:889-895` | 已对齐：时区说明由前端烤在实时状态段开头 |
| I2 | 时间 | 本地报时后跟一句「请据此自然地拥有真实的时间观念……不要凭空假设时间」，云端时效块里没有 | 仅本地 | `utils/context.ts:239` | `worker/amsg/src/instantChat.ts:89-92` | 已对齐：时效块报时后带同一句 |
| I3 | 时间 / 时区 | 用户和角色时区不同时，云端多一行「对方那边现在是……」。本地私聊从来不报用户那边的钟。这句的注释是为定时排程写的 | 仅云端 | `utils/context.ts:226-251`（无对应内容） | `worker/amsg/src/instantChat.ts:93`；`utils/amsgFirePack.ts:685-697` | 已对齐：两边都带「对方那边几点」，本地私聊也加了这一行 |
| I4 | 时间 | 时钟移走以后，「实时状态」那条 system 消息的开头还写着「以下是此刻的实时状态——当前时间、……」，实际已经不含当前时间 | 两侧不同 | `utils/chatPrompts.ts:384`、`:394` | `worker/amsg/src/index.ts:2669-2678` | 已对齐：没有钟时开头不再提当前时间 |
| I5 | 用户资料 | 用户所在地的节日：本地放在「互动对象」段 bio 之后；云端插在标题下面、名字之前。找不到这个标题时，云端会在整串**末尾**追加一条「互动对象信息补充」，排到「回到你自己」那句之后。改到云端现取属于已登记第一条；插入位置和末尾兜底没有理由 | 两侧不同 | `utils/context.ts:643-646` | `worker/amsg/src/index.ts:2683-2687`；`utils/userHolidays.ts:117-123` | 已对齐：按 `fire_pack.userBioLength` 插到 bio 之后 |
| I6 | 工具说明 | 除了 T8 说的缺用户名，抬头还写着「**主动消息里也可以用**」，而这一轮其实是用户在等回复 | 两侧不同 | `utils/mcpToolBridge.ts:81-111` | `utils/mcpFireCore.ts:924` | 已对齐：即时对话抬头不提主动消息，带用户名 |
| I7 | 工具说明 | 小红书：发送前，本地不检查 Worker 能不能连到小红书服务器，提示词照教小红书标签；上云的工具配置却把连不到的小红书整个去掉，Worker 那边这些工具必然失败。MCP 有一道「连不到就留在本机跑」的否决，小红书没有 | 本地教，云端没有 | `utils/chatPrompts.ts:673-677`；否决名单 `hooks/useChatAI.ts:853`、`:874-878` | `utils/amsgToolPack.ts:160-173` | 已对齐：连不到时转本地（`xhs-worker-unreachable`） |
| I8 | 排程工具 | 本地只要角色开着 2.0，就以原生工具的形式给 schedule、cancel、renew，用户关了「原生 tools」开关也照给；云端只在原生模式下才给取消和改期，中转拒绝 tools 时改教正文协议。云端写了理由，本地不跟开关走没有理由 | 两侧不同 | `hooks/useChatAI.ts:1173`、`:1246-1251` | `worker/amsg/src/index.ts:2536-2542`、`:2610-2624` | 已对齐：本地也跟「原生 tools」开关走，关着时改教正文协议 |

### 离开后消息、见面离开提醒

| # | 维度 | 差异 | 哪侧有 | 本地位置 | 云端位置 | 处理 |
|---|---|---|---|---|---|---|
| A1 | 任务指令 | 本地区分最后一次在场互动是线上发言、见面分开还是通话挂断，用的说法不同；最近一条是 3 小时内的见面时，还会切到「刚分开」的语境（回味见面、问到家没、别像很久没联系、不编细节）。云端只有一份通用指令「对方已经超过 N 分钟没跟你说话了」，fire_pack 里也没带起点是哪种互动。`chatPrompts.ts:160` 那行理由只说明打包时不能写死这一句，没覆盖到点现算 | 仅本地 | `utils/awayMessagePrompt.ts:11-33`、`:46-54` | `utils/amsgFireSchedule.ts:291-295`；`utils/activeMsgClient.ts:770-780`、`:986-991` | 已对齐：`fire_pack.awayAnchor`，Worker 到点用同一份 `buildAwayFireInstruction` 现算 |
| A2 | 时间 | 关掉聊天时间感知后，本地不报钟也不报时长；云端去掉了钟，但任务指令里仍然写着「超过 N 分钟没跟你说话」 | 仅云端 | `utils/awayMessagePrompt.ts:16-22` | `utils/amsgFireSchedule.ts:292`；`utils/activeMsgClient.ts:986` | 已对齐：关了时间感知时不报分钟数 |
| D1 | 任务指令 | 本地离开提醒只有 `buildDateLeaveInstruction` 那段（问对方去哪了、说你还在等）。云端外面还包着通用的「1.0 风格主动消息提示」：「这不是对方正在和你聊天，而是你突然想起了对方」「不催问对方在干嘛、怎么还不回」，再加【重要规则】里「语气更像真人突然想起对方」。这和任务方向正面冲突。`amsgFireSchedule.ts:308` 的注释说两条路共用同一段，没算上外面这层 | 仅云端 | `utils/dateLeaveReminder.ts:190` | `utils/activeMsgClient.ts:770-780`、`:952`、`:988`；`utils/amsgFireSchedule.ts:309-313` | 已对齐：两条路共用 `buildDateLeaveInstruction`，渲染时拿掉通用提示 |
| D2 | 排程 | 云端这一轮不给排程工具，有文档理由；本地版照教 `[schedule_message]`，角色还能排后续 | 仅本地 | `utils/chatPrompts.ts:689-690`、`:731` | `worker/amsg/src/index.ts:2035-2037`；理由见 `docs/date-leave-reminder.md` | 已登记：没开 2.0 时不教 `[schedule_message]` |

下面 L1 到 L7 是本地版 `runLocalProactiveTurn` 少带或多带的东西，离开后消息和见面离开提醒都受影响。方向和上面相反：这里通常是云端模板有、本地版没有。

| # | 维度 | 差异 | 哪侧有 | 本地位置 | 云端位置 | 处理 |
|---|---|---|---|---|---|---|
| L1 | 格式说明 | 本地版不传 `translationConfig`，开了双语的角色发出来也没有译文；云端模板和私聊都带 | 仅云端 | `utils/awayMessage.ts:263-272` | `utils/activeMsgClient.ts:922` | 已对齐：同一套模板 |
| L2 | 心象 / 思考 | 本地版不传 `thinkingChain`，没有思考链提示，请求里也不带思考参数；云端模板带思考链提示，但同样不带思考参数（见 T2） | 仅云端 | `utils/awayMessage.ts:263-272`、`:284` | `utils/activeMsgClient.ts:924` | 已对齐：思考链提示随模板，思考参数与私聊同一套 |
| L3 | 工具 | 本地版后处理用 `skipSecondPassLLM: true`，`[[RECALL]]`、`SEARCH`、`READ_DIARY` 会被直接剥掉不执行，小红书副作用也关掉了；云端会真的跑，模板里还列了哪些月份查得到。模型整条只输出一个标签时，本地这一轮就成了空回复 | 仅云端执行 | `utils/awayMessage.ts:306`；`utils/applyAssistantPostProcessing.ts:670-690` | `utils/activeMsgClient.ts:940-958`；`worker/amsg/src/index.ts:2637` | 已对齐：标签真的执行；回连按轮批量、最多 5 轮，最后一轮带共用收尾提示 |
| L4 | 工具 | 本地版的系统提示里有 MCP 说明和末尾提醒，请求里却不带 tools，也没有工具循环，等于叫角色去调一个调不了的工具；云端给真工具，也会执行 | 两侧不同 | `utils/awayMessage.ts:282-285`；`utils/chatRequestPayload.ts:450`、`:496` | `worker/amsg/src/index.ts:2577`、`:2618-2620` | 已登记：本地版不带 MCP，也不教 |
| L5 | 智能语境 | 本地版入口是 `proactive_chat`，不算私聊入口，所以没有智能语境分析；云端模板带 | 仅云端 | `utils/chatRequestPayload.ts:460-461` | `utils/activeMsgClient.ts:970` | 已对齐：同一套模板 |
| L6 | 模型参数 | 本地版温度取 `api.temperature ?? 0.85`，不传 max_tokens；云端不传温度（T1），max_tokens 读 2.0 设置（T3）；私聊两样都传 | 三方各不相同 | `utils/awayMessage.ts:284` | 见 T1、T3 | 已对齐：与私聊同一套 |
| L7 | 多带的块 | 本地版照样带着云端注释表里写明「不该带」的块：生活记录代记工具说明、协同功能「系统另给已有文件标题」那句（本地版不拼文件柜清单，正是那句理由说的会让角色编文件）、彼方称号、串门申请。那几条理由对本地版同样成立 | 仅本地 | `utils/chatPrompts.ts:548`、`:631`、`:1003`；`utils/chatRequestPayload.ts:540-543` | `utils/chatPrompts.ts:163-166`、`:174`（理由） | 已对齐：同一套模板，不带这些块 |
| L8 | 用户定位 | 角色有定位权限时，云端模板带一句「位置暂不可用」；本地版什么都不带，因为定位只给私聊入口 | 仅云端 | `utils/chatRequestPayload.ts:391` | `utils/chatPrompts.ts:364-365` | 已对齐：同一套模板 |

### 待定

疑似遗漏里没有待定项了。云端还没补上的两处缺陷（好友圈动态和评论、工具循环最后一轮仍带工具）记在总纲「已知的云端缺陷」表里。

## 明显有意（有理由，未登记）

下表大部分已经并入总纲「已登记的有意差异」，以总纲为准。

这些差异代码或功能文档里写了理由，只缺一个登记，或者需要维护者确认这个理由也覆盖了对应路径。

| 路径 | 差异 | 理由所在 |
|---|---|---|
| 定时类 | 整份上下文压成一条 user 消息、历史转成纯文本 | `utils/activeMsgClient.ts:783-784`（模板架构）；为什么用 user 角色、易变段为什么放在历史前面，没有单独写 |
| 定时类 | 时间块到点由 Worker 填，不带本地那句「对方还在跟你说话」的语境框定 | `utils/chatPrompts.ts:157`；`utils/timeFramingNote.ts:13-16` |
| 定时类 | 日程只带作息原表，到点现挑时段，不带整天日程，跨天的包整段不用 | `utils/chatPrompts.ts:159`；`utils/scheduleInjection.ts:24`；`utils/amsgFireScene.ts:110` |
| 定时类 | 音乐只剩「你此刻在听：《X》」，没有用户在听什么、一起听、歌词、换歌察觉、MUSIC_ACTION 教学 | `utils/chatPrompts.ts:575-579`；`utils/amsgFireScene.ts:15-18` |
| 定时类 | 不带「刚挂电话 / 刚见完面」的模式切换提示（离开后消息的后果见 A1） | `utils/chatPrompts.ts:160`、`:1011-1012` |
| 定时类 | 不带「用户此刻也在彼方」和彼方称号 | `utils/chatPrompts.ts:161`、`:166`、`:637-643` |
| 定时类 | 群聊背景去掉「约 X 分钟前」，保留绝对时间 | `utils/chatPrompts.ts:162`、`:478-481` |
| 定时类 | 生活记录去掉代记工具说明，不消费否决反馈，日期改成绝对日期 | `utils/lifeRecords.ts:375-379` |
| 定时类 | 协同文件标题那句和文件柜清单都不带 | `utils/chatPrompts.ts:165` |
| 定时类 | 小程序 / 瑞一杯快照、串门申请、SAR 说明和输出容器不带 | `utils/chatPrompts.ts:173-175` |
| 定时类 | 小红书教学只在 Worker 连得到那台服务器时才给 | `utils/chatPrompts.ts:671-672` |
| 定时类 | 智能语境多一段框定，范围回退到最后一条真实用户发言 | `utils/chatPrompts.ts:171-172`；`utils/memoryPalace/pipeline.ts:1215` |
| 定时类 | 记忆召回在打包时跑（即时对话复用本轮刚算好的），去掉「今天 / 距今约 N 天」 | `utils/activeMsgClient.ts:741-745`、`:849-850`；`utils/chatPrompts.ts:168-169` |
| 定时类 | 用户定位固定渲染为「拿不到位置」 | `utils/userLocation.ts:199` |
| 定时类 | 图片只用识图描述，没有描述时明说别猜（已对齐，由 `utils/activeMsgClient.parity.test.ts` 钉住） | `utils/activeMsgClient.ts` 的 `buildFirePack` |
| 定时类 | 「隐藏调取记忆提示」开关：云端模板跟随这个开关，开启隐藏时不教那一行、不列查得到的月份（已对齐，由 `utils/activeMsgClient.parity.test.ts` 钉住） | `utils/activeMsgClient.ts` 的 `buildFirePack`；`docs/memory-system-overview.md` |
| 定时类 | 世界书深度条目放进 system 文本的「深度条目」节，不插进历史 | `utils/chatPrompts.ts:294` |
| 定时类 | 不带好友圈主任务 | `docs/friend-feed.md:117`（只在文档里有） |
| 定时类 | 双语、HTML、思考链格式块接在钢印之后，靠末尾人声锚拉回 | `utils/activeMsgClient.ts:996-999` |
| 定时类 | 打包之后到触发之前的新消息只在重新打包时进来，角色自己的发言靠自述日志、用户最后开口时间靠在场租约补 | `utils/activeMsgClient.ts:784`；`worker/amsg/src/index.ts:2207-2211` |
| 定时类 | 续说补丁和家园手机上下文不带 | 只在正在对话或嵌入家园手机时才有意义；代码里没写 |
| 定时类 | 只在云端出现的任务内容：「1 到 2 句、最多 3 句」、1.0 风格提示、【开口之前】和 `[[SILENT]]`、距离上次主动发消息、对方那边的钟、自述日志、本次任务指令、末尾人声锚、scheduled 回复范围规则 | `utils/activeMsgClient.ts:948-1000`；`utils/amsgFirePack.ts:502-511`、`:685-696`、`:942-1011` |
| 即时 | 定位文字从天气块旁边挪到实时状态段 | `utils/chatPrompts.ts:568-570` |
| 即时 | 角色开着 2.0 时不教 `[schedule_message]`，只留 Worker 排程工具 | `utils/chatPrompts.ts:678-688` |
| 即时 | 时效块里多一段自述日志（之后回过 / 又发过 / 连着找了 N 次）；理由是为定时路径写的 | `utils/amsgFirePack.ts:935-941` |
| 即时 | 带 destructiveHint 的 MCP 工具上云时被滤掉；理由是为无人值守的后台写的，没明说也覆盖即时对话 | `utils/mcpClient.ts:163-168` |
| 即时 | chat 段超过 2 MB 时，从最老的消息开始把图片降成文字 | `utils/activeMsgClient.ts:1135-1142` |
| 即时 | 情绪评估不生成家园秘密任务 | `hooks/useChatAI.ts:1055-1056` |
| 即时 | 情绪评估吃的是主生成的整串（多了时效块、MCP、排程块） | `worker/amsg/src/index.ts:2694-2697` |
| 即时 | 数据类标签交给 Worker 工具循环执行，副作用标签转成指令，客户端带 `skipSecondPassLLM` 重放 | `worker/amsg/src/classifier.ts` 文件头 |
| 离开后消息 | 本地按离开时长最多补 3 次，时间戳铺在离开那段时间里；云端到点只发 1 次 | `docs/away-message.md`「两条路」 |
| 离开后消息 | 云端去掉【开口之前】，必发 | `docs/away-message.md`「到点必发」 |
| 见面离开提醒 | 云端提醒本身不受连发和每日上限拦、必发、按见面租约推迟、生成中途人回来就作废；这一轮可以排后续，子任务不继承豁免；本地用计时器做等价判断 | `docs/date-leave-reminder.md` |

两条路径的离开提醒都不用见面自己的提示词（VN 格式、OBSERVE、见面期间的时间感知开关），用的是私聊上下文，这一点两边一致。

## 已登记

| 路径 | 差异 | 备注 |
|---|---|---|
| 即时、定时 | 天气、热搜、节日由 Worker 现取（`worker/amsg/src/index.ts:2570-2572`），本地模板不烤（`utils/chatPrompts.ts:404-420`） | 第一条 |
| 即时、定时 | 用户所在地的节日改到云端现取（`worker/amsg/src/realtimeWorld.ts:216-219`） | 第一条；即时对话里的插入位置另见 I5 |
| 定时、离开后消息 | 不教 `[schedule_message]`，改由 Worker 追加排程说明和额度（`worker/amsg/src/index.ts:2602-2607`） | 第二条 |
| 即时 | 排程清单和额度说明的措辞、刷新方式，以及云端额度说明多出的两项（「这次最早排到几点」「今天还剩几次」）（`worker/amsg/src/index.ts:2544-2556`、`:2585-2608`；本地 `utils/amsg2TaskContext.ts:149-200`） | 第二条；请确认措辞分叉和多出的字段都算在内 |

## 没查清的地方

- 工具结果的格式：本地二轮请求喂回的召回、搜索、日记内容，和 Worker 工具循环喂回的结果（`utils/agenticTools.ts`），措辞、长度、位置是否一致，没有逐项比。工具循环的轮数上限也没对。
- 标签覆盖：本地 `applyAssistantPostProcessing` 认的标签是否都被 Worker 分类器转成了指令或原样保留，没有逐个核对。
- 即时对话的时效块在工具循环中途会不会重拼：推断不会，没读上游 amsg-server 源码确认。
- Anthropic 原生端点：本地 Messages 转换（缓存断点等）和 Worker 那边是否等价，没查。
- 云端离开后消息落库时有没有打 `awayMessage` / `dateLeaveReminder` 标记：会影响切回本地后 `findAwayGapStart` 的判断，没核对 `activeMsgRuntime`。
- 表情列表：本地来自聊天页面的 props，云端来自数据库全表，过滤后是否完全一样，没核实。双语配置两侧是否读同一组 localStorage 键，也没核实。
- T6 世界书扫描文本不同，实际会不会命中不同条目，没有拿真实数据跑过。

## 附：静态检查的覆盖

`utils/contextPipeline.test.ts` 的召回检查按「直接调了上下文构建函数」来找入口。即时对话走的是 `buildChatRequestPayload`，天然算「已自备召回」；但这份检查管不到 Worker 补的时效块，也管不到 fire_pack 模板少带了哪些块。已对齐的几条由下面几份测试钉住：`utils/awayMessage.parity.test.ts`（本地版与 Worker 到点拼出的提示词逐字相同）、`utils/activeMsgClient.parity.test.ts`（T4、T5、T6 扫描文本、T7、T9、图片别猜、月份清单跟随开关）、`worker/amsg/src/fireParity.test.ts`（A1、A2、D1、离开提醒的子任务照常计入上限、定时类情绪评估、T8、I6、回执销账）。D2、L4 两条按有意差异登记，理由写在总纲表里，没有单独的测试。
