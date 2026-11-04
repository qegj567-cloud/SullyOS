# 3D 家园：共同生活闭环交付

## 多人共同事件与独立记忆水位（2026-10-20）

多人家园按本场已加入的角色名单共享完整事件流。例如 A 说话、B 摸 A、C 浇水，三条分别写入 A/B/C 的消息历史；房间只表示地点，不按镜头、距离或同房间条件过滤。后来加入者不补收旧记录，离开者不收新记录。这里只共享家园事件，不共享各角色其他私聊。

`HomeRecord` 新增 `actorId / actorName / targetIds / sharedScene`。编辑器在新事件产生时固定参与名单，旧记录不因成员变动或编辑而扩大受众。房主日志作为原件，`homeSharedMessageBridge` 在原有角色保存事务中写入全部成员消息；访客自己的房屋布置和日志保持独立。重复保存不新增副本，任何一位写入失败全部回滚；角色被删不会被迟到保存复活。

共享事件每条使用独立消息 ID 并封存，避免新动作追加进某位角色已归档的旧消息。原单人家园的连续动作合段不变。自己说的话是自己的 assistant 历史，其他角色说的话带真实姓名作为场景输入；公共记忆格式器也保留原说话者，不把他人的话算成用户或房主说的。

请求继续走原有 `loadCharacterContextRange / buildChatRequestPayload / ChatPrompts`。各人独立使用自己的消息水位和记忆管线，保存成功后分别检查整理阈值；认知消化的回复计数只计本人模型发言。多人内容来自一次还是多次 API 不改变此落库方式；多人生成控制器本身尚未接入。

世界书无需新增去重器：群聊的 `ContextBuilder.buildGroupWorldbookRequest` 已按 ID 去重并保留角色归属；不同 ID 不按名字/正文合并，独立单角色请求不相互去重。

这层是好友圈与多人生活的底层管线。后续同日新增了好友圈独立 App 和家园手机入口，支持本地生活圈、用户发帖和评论，详见 [好友圈入口](friend-feed.md)；角色生成、推文记忆卡、概率刷帖和日程串门尚未接入。完整方案见 [好友圈与串门设计](../plans/home3d-social-visits.md)。

验证：`homeSharedEvents.integration.test.ts` 覆盖 A/B/C 完整事件投影、最终请求与记忆格式、各自水位、后来加入、重复保存、编辑删除、事务回滚、删除角色以及世界书归属；`homeMemoryPostHook.test.ts` 验证每人分别进入原有记忆处理器。

## 一些秘密（2026-10-07）

情绪评估在角色已有 3D 小屋、可读历史含已完成对话片段时，以 20% 概率附加秘密任务。命中后必须生成一条，不再由模型决定是否跳过；未命中不附加任务。提示词含 30 种角色秘密风格与 14 种宠物事件风格，后者只在数据库里的当前小屋确有宠物时加入。生成只引用本轮已获准读取的聊天，不为补素材另读隐藏历史。

情绪评估仍与主回复并行，秘密素材引用其输入中最近一段已完成的用户／角色对话，不把待回复输入或未来计划写成已发生事实。新纸条落库绑定本次生成回合全部成功提交的回复 ID，而非素材的旧回合；本轮来源缺失或已删除则放弃。锚点使用请求编号与原片段，模型不编造钟点。同一片段已有秘密或正在生成时不重复请求。模型返回的宠物 ID 同时对照请求时名单和落库时最新名单校验。

`homeSecrets.ts` 将生成请求、秘密索引和阅读状态保存在角色独立的 `assets/home_secrets_v1_<charId>` 记录中，新纸条正文以消息库为准，随完整备份保存。一次事务提交，重复结果投递不重复新增、不重置已读；秘密不依赖情绪 `changed`，不覆写角色档案或小屋布置。共用 `emotionApply` 解析保留字段，并支持 JSON 字段级抢救；漏填、非法宠物或存储失败发出现有失败提示，能够落盘的失败原文保留在请求记录，不静默吞掉。没有额外请求模型补写，不保证供应商一定遵守提示词。

新秘密的正文保存为所属生成回合的一条 `secret_note`，通过普通历史范围进入上下文，每张占一条，随归档与水位线代谢，不常驻注入单独的 `memory`。普通聊天与小屋小记不展示；历史管理操作提供纸条标识和正文。已读只决定进屋是否再次揭晓，不删除历史记录；用户看过弹窗不等于角色知道秘密已被用户发现。生命周期与保守删除规则见 [秘密小纸条](room3d.md#秘密小纸条跟随所属回合与水位线)。

普通家园与居家桌面共用 `HomeSecretsReveal`：进入时读取未读快照，最多展示两张「一些秘密……」。奶油纸色的信封弹窗需主动拆开，逐张读完并收好，只确认当前纸条的阅读状态；遮罩误触、Esc 与原生返回取消均不能关闭。没有追问或揭穿选项。在屋内新生成的秘密留到下一次进入，积压或未确认的纸条保留到以后访问。

本地私聊与小屋回复在明确取得本轮完整父消息 ID 后落库。当前云端即时对话的评估回调没有完整回合归属，因此暂不发起新秘密任务，正常情绪评估保留；不能按文字猜测来源。加密评估配置及 Worker 回程的 `homeSecretRequestId` 兼容解析仍保留，但编号本身不替代完整来源校验。

验证：`homeSecrets.test.ts`（真实 IndexedDB、解析→保存→共享上下文、宠物校验、并发与重投）、`homeSecretsEval.test.ts`（真实本地评估入口、概率与流式重试）、`homeSecretsReveal.test.ts`（进屋快照、关闭、保存失败）、`activeMsgClient.credRefs.test.ts`（加密配置保留请求编号）。

### 秘密生成容错

情绪 JSON 的截断补全不能补造秘密正文或记忆，只接纳已经完整闭合的秘密数组；若仅后续情绪字段被截断，完整秘密仍可抢救。返回的请求编号若存在，必须与本轮一致，落库时再次确认小屋存在。

本地空回复、网络失败、取消均释放未完成占位，下次符合条件的评估仍按 20% 抽签，不额外调用模型。断页或云端未送达的占位使用 24 小时绝对时长租约；旧版没有时间戳的占位在下一次命中时释放，保留请求与失败原文。迟到结果仍按原片段事务去重，不覆盖既有秘密或已读状态。秘密任务准备失败只提示该任务失败，不中断正常聊天／情绪请求。

## 居家桌面（2026-10-06）

外观 → 桌面风格 →「居家」（`theme.skin = homely`）。桌面直接挂载同一个 `Home3DSetupEntry`，使用当前角色的家园定义、房屋、3D 形象、日程与 `home3D.records`。新用户仍走定义、角色形象、房屋配色和日程检查；第一人称不要求用户手办，不创建或隐藏一份用户模型来冒充第一人称。

`Home3DView.presentation = homely` / 编辑器 `firstPerson` 使用固定平视镜头，关闭旋转、平移和缩放，跟随房主所在房间。宽屏与横屏聊天放右侧；窄屏竖屏改为下方全宽聊天区，顶部保留住客、日程与互动入口，可收起。镜头只平移构图：右栏时让角色偏左，下方聊天时抬高脸部构图，收起后角色居中；不移动模型或家具。站姿空闲与交谈看向镜头，坐姿只转头，睡眠、行走、家具活动保留原姿态。相机仅作为本地陪伴的观察者目标，不进入居民列表、双人动作或碰撞体；已有家具活动和日程继续由原执行器处理。此模式不改普通家园的镜头偏好、布置或配色。

聊天区是 `HomeLifePanel` 的非模态展示，复用原当面交流、上下文、动作白名单、记录、停止、重试与重新回复；收起保留草稿和进行中的回复。角色外出时隐藏形象并禁用当面发送，不自动召回。角色名下展示 `useHomeSchedule` 已读取的当前日程（起始时间与活动），随角色时区、时段、前台恢复更新，没有时段则明确显示无安排。底栏可切换角色、进入普通 3D 小屋、打开全部应用，并提供电话、查手机、见面三个应用入口；入口只打开应用，不自动拨号或发起生成。形象入口只打开当前角色的手办柜。离开桌面释放场景和未完成的本地请求。

「和谁一起待着」可把当前角色 ID 存入 `theme.homelyLockedCharacterId`。锁定时居家角色、当面聊天和家园小手机都使用该角色，不随其他 App 的 `activeCharacterId` 改变；解除锁定后恢复跟随，锁定角色被删除则安全回退。锁定状态下重新选择住客会更新锁定对象。详见 `homelyResident.test.ts`。

居家复用小屋的组件和纸感，默认奶油杏橙；桌面底栏「配色」直接展开五色色卡，提供云朵雾蓝、牛奶藕粉、轻雾淡紫、燕麦拿铁，点击立即生效，背景不模糊以便比较，无需进入外观 App。`theme.homelyPalette` 随主题保存，缺失或未知值回退杏橙，色板统一定义在 `components/os/homelyPalette.ts`。作用域限定在居家桌面，包含主按钮、当面聊天、小手机与秘密纸条；小纸条在普通家园默认使用杏橙，不使用叶子或绿色。五套配色的次要文字与实色主按钮文字均保持至少 4.5:1 对比度。底栏高度统一为 100px，并共用安全区与面板间距；不改用户的家具配色或其他主题。底部正中四点圆形按钮打开系统应用抽屉，保留「打开全部应用」无障碍名称；桌面小手机直接使用 `HomePhone`，保留原私聊、未读、回复动作与拍照。打开手机暂时收起当面聊天，关闭后恢复；拍照期间让合影相机接管，退出后恢复锁定平视。

应用抽屉支持按应用名搜索，关闭后清空查询；键盘焦点循环包含搜索框。隐藏原生滚动条，保留触屏、滚轮和键盘滚动；抽屉遮罩取消背景模糊，减少叠在 3D 场景上的全屏合成开销。居家气泡根据实际头发最高点投影定位，为思考小圆点和说话尾巴留出间隔；说话时暂隐思考气泡，避免叠在一起。点击按当前骨骼地标识别头顶、脸颊、身体、手臂，分别缩头、偏头、轻颤、抬手回应；双手忙碌时手臂反馈退为转头。约 0.85 秒的局部叠加动画结束后恢复基础姿态，不展开聊天、不改变坐位或打断自主活动；减弱动画设置下只显示文字反馈。部位识别和恢复规则见 `homelyTouch.test.ts`。

自主活动继续使用同一个 `useHomeCompanion`、`useHomeSchedule` 和角色的 autonomy / activityFrequency 设置；不因桌面模式禁止入座。无实体用户时在角色附近选座，相机不占座、不改变日程房间或把角色召回。「招呼」使用已选动作 `vrma-8bd33d84e90c0243`，温暖回复使用 `vrma-788371d87156b583`，保留坐姿，不再调用旧 `wave-calm`；动作加载失败回退点头，不记虚假的挥手。

全局音乐有当前曲目时，日程下显示迷你播放器，直接复用 `MusicContext` 的封面、歌名、进度和播放控制；点击曲目进入音乐 App，暂停后保留继续播放入口。播放中的空闲角色轻摆、点头，坐着时减小幅度；忙碌、睡觉、行走、拍照和减弱动画时停止。当前律动使用播放进度作时钟，不是音频频谱或逐拍识别，不创建第二个音频源。

居家桌面已移除聊天闲置后的自动探头行为，不再安装空闲计时器或监听输入来触发靠近。角色继续按家园自主活动设置行动，音乐轻摆不受影响。`homelyForeground.js` 仅保留供测试工具手动验收的透明合成能力，正式桌面不再自动调用。

预览：`test/fixtures/homely.html` 使用正式 `HomelyHome`，QA 角色、有效日程、自主活动和本地模拟回复；主题调整仅在预览内存中生效，不改写真实用户主题或 API 配置。加 `?qa=1` 才显示测试工具（含测试秘密纸条、本地合成试听与安全条件下测试探头）。验证包括手机与宽屏构图、聊天展开/收起及草稿、模拟收发、外出/回家、共享日常、单居民与锁定镜头、全部应用、小手机与拍照返回。专项回归见 `homelyView.test.ts`、`homelyHome.test.ts`、`homelyPalette.test.ts`、`homeLifePanel.test.ts`、`homeOnboarding.test.ts`，并沿用家园上下文与生命周期测试。

## 家园与 ChatApp 共用上下文管线（2026-10-05，当前约定）

- 正式入口将 OSContext 的 groups/realtimeConfig 和发送时的音乐播放快照交给家园；表情与分类从共用 DB 读取。每轮调用同一个 buildChatRequestPayload，数据与开关的含义与 ChatApp 相同。
- 两边统一使用稳定 system → 历史（含世界书深度插入）→ 实时 system 的结构。人设、用户资料、世界书、记忆/门牌、情绪、日程、天气热搜、群聊、日记笔记、生活档案、音乐及协同文件柜复用同一段代码。主动消息已开启且 Worker 已配置时，额外使用 ChatApp 同一排程/回执收集与格式化器，在实时尾段前注入，成功回复后确认回执；SAR 共用临时模块状态，只省略私聊外显输出容器。家园仅以现场动作/JSON 协议替换 ChatApp 的气泡、语音、翻译、HTML、SAR 输出容器和工具执行提示词。
- 私聊与家园的召回、关键词扫描、识图和历史格式化消费完整可见范围，不使用 ChatApp 隐藏跨应用消息后的 UI 近窗。home_3d 与 chat_app 共用交互召回增强；world_home 仍是另一入口。
- 范围与归档仍按消息 ID 水位和断点约束；范围确定后统一按原 timestamp 排序，相同时间再按 ID 排序。旧家园日志补入 messages 后不会因新 ID 被当作最近发生；重生成也按这条可见时间线截断。
- 每轮使用独立角色副本，清空旧临时召回；门牌读取移入共用召回管线的 embedding 检查之前，未配向量时两边仍读取门牌。
- homeChatPipelineParity.test.ts 比较两边真实最终载荷（只剔除各自 App 提示词），覆盖完整共用块、界面隐藏记录、深度世界书、双语历史清洗、旧记录时间顺序和重生成；使用测试 DB 与外部服务桩，不调用用户模型。

2026-10-06 复核：ChatApp 的音乐状态也交给共享快照解析器，前奏尚未进入首句歌词时仍保留歌名、歌手和共听状态。旧整轮家园记录在范围筛选、识图之后展开为真实角色与时间线，记忆召回、实时上下文和协同文件读取与发送历史保持一致。`homeChatEntryParity.test.ts` 进一步捕获真实 `useChatAI` 与 `generateHomeReply` 的网络请求，对照手动/自适应范围、跨 App 顺序和前奏共听；只替换外部传输，不调用付费模型。

## 家园记录分段与统一存储（v3，当前约定）

- 家园聊天采用 ChatApp 相同的 buildChatRequestPayload、统一范围读取、图片描述准备和 ChatPrompts.buildMessageHistory 格式化；历史中的私聊、通话、见面、家园都保留，不再另取最近 24 条私聊、最近 30 条经历摘要和最近 20 条家园对话。场景系统提示只补家园定义、当前现场、动作白名单及回复协议。
- 用户发言与角色回复各占一条 user / assistant 消息；连续短动作合为场景记录，发言、其他 App 私聊、主动开口触发及归档边界切段。例如“摸 C → 坐下 → 照镜子 → 问你在干嘛 → C 回答 → 走近”，形成动作段、用户发言、角色回复、新动作段四条消息。
- 原始事件保留 turnId / replyTo 表示逻辑关联，contextSegmentId 决定上下文分段；新角色回复不会追加到旧问题的消息 ID。旧 v1 / v2 投射保留原 ID 和归档边界，附加可还原的事件，在请求范围筛选后展开并按事件时间与其他 App 记录交错排列；无法还原的旧正文不猜测拆分或删除。
- 当前待回复输入从现场快照补齐一次，其余历史来自统一范围。重生成只读目标输入及以前的可见历史，去除原回答和未来事件；已落库且不在范围内的旧输入不能换临时 ID 绕过断点或归档水位。

## 统一存储接入（沿用）

- 对照 DateApp：见面对话写入 messages 并标记 source=date；家园现在同样写入 messages，标记 source=home。私聊、见面与通话从统一原文范围读取，不再在核心/实时背景段重复拼接家园日志。家园定义仍保留在核心背景。
- 房屋日常 records 与对应消息在同一个 IndexedDB 事务内保存；按 homeTurnId 更新/删除，重复保存不产生重复消息，编辑保持消息 ID。只投射真实记录，不把日程计划写为经历；动作标明操作者、来源及房间，并注明开始不等于完成。
- 首次读取上下文时，旧家园日志从数据库中的角色迁移一次，保留原事件时间。旧日志补录会获得新的消息 ID；以后与见面一样受统一上下文范围、水位和断点约束。私聊气泡及桌面预览不展示家园正文。
- 家园自身对话读取统一消息历史，当前现场只补齐这一回合，避免重复与重生成读入未来记录。编辑删除影响原文，已经生成的长期记忆摘要不会自动改写（与其他消息相同）。
- 回归测试使用实际 IndexedDB 接口及 buildChatRequestPayload 的最终载荷，验证家园/见面同路、单次注入、编辑删除、重复保存、旧记录迁移、范围隔离和事务回滚；未调用真实用户模型。


## 家园交谈与实时经历（2026-10-03，经历注入位置的早期方案已被上节替代）

- 模型现场快照包含当前房间家具名称、可执行家具动作和角色互动，明确操作者为角色及目标对象。只有返回白名单 actionId 才执行；角色互动复用原走近/空地流程，成功记录为模型行为。
- 调用模型期间与纯文字回复展示期间，从三段已接入的聊天手势中随机轮换。只在空闲站姿/普通坐姿叠加，不移动人物，不覆盖走路、床上、家具活动或双人互动；失败、取消、卸载、换房及后续手动操作使本次手势失效。历史重生成不播放动作。轻量手势不逐次写入经历。
- 聊聊同时展示对话与实际动作记录。私聊的家园经历从稳定背景段移到 `buildVolatileCoreState` 每轮实时段；通话/见面继续由 `buildCoreContext` 注入。家园自身生成即使角色尚无 home3D，也使用本次现场 records。
- 独立本地模拟页已验证“坐下聊聊”→角色坐下→模型行为记录→私聊实时/通话见面上下文均含对话与具体沙发动作。未调用真实供应商；用户正式入口报告的漏记尚未复现，不能据此宣称所有正式入口的历史丢失已定位。

## 2026-10-03 体验整理

- 入场在房主房间拉近镜头，房主朝镜头挥手并使用已有开心表情；外出不制造在场招呼。用户开始操作会中断招呼。
- 墙面三种形式收进一个循环切换按钮；地图折叠成小入口，星号标记房主。返回按钮按面板、装修、总览的层级返回。
- 锁定只锁旋转，保留平移和缩放；双击人物拉近并锁定，单击延迟区分双击后打开互动。
- `residentRoomId` 独立于用户浏览的 `activeRoomId`；切房间不带走房主。点自己选择“把 XX 叫过来”直接召唤到当前房间，记录实际到场，不播放跨房行走。
- 日常按时间从旧到新显示，最新在底部，更早记录入口在上方。动作写实际操作者、双人目标或家具名称；双人动作只记一条。
- 双人动作在当前房间寻找可达空地再行走就位；无足够连续空间仍会明确失败，不穿家具、不跨房寻找。亲近新增项目自制拥抱，双方靠近后手臂环向肩背，结束原地面对面。
- 正式家园移除“一起玩”菜单项，以及装修中的小人、扩建、建造和测试恢复入口；保留当前房间命名、装扮、分享和家具收纳。房间名称按 ID 同步给日程提示词，无固定客厅名称假设。
- 家具抽屉增加名称／动作关键词模糊搜索、缩略图三列、横向分类，顶部改为紧凑返回／标题／完成。参考 [Apple 搜索栏](https://developer.apple.com/design/human-interface-guidelines/search-fields) 与 [工具栏](https://developer.apple.com/design/human-interface-guidelines/toolbars) 的导航和操作分工。

验收页：`/test/fixtures/home-review.html`（独立内存数据，不改用户存档），提供拥抱定格、动作结束、召唤及可读状态。拥抱以现有体型和服装实测；不同自绘发型、极端身高及宽大服装仍需按素材继续检查接触，不能保证所有自定义组合无穿插。

2026-10-03。正式入口为 RoomApp → 拜访（测试版）3D → 角色。独立预览为 `/test/fixtures/home-life.html`；该预览明确使用本地模拟回复，不调用用户 API。正式入口使用系统配置的聊天 API。

## 九项清单

| 项目 | 状态 | 已落地的行为 |
| --- | --- | --- |
| 1 定义家园 | 完成 | 首次三选一：现实中的家、连接两个世界的家、AI 的虚拟家园。补充设定折叠为选填；我的家中可修改；共同 ContextBuilder 注入，保存本身不调用模型。 |
| 2 双方手办柜 | 完成 | 角色保存家园 3D 形象；用户档案保存自己的 Chibi 与家园 3D 形象。家园内可选择打开双方手办柜。支持以已有手办为底稿，原手办不被覆盖。 |
| 3 首次入住 | 完成 | 定义 → 双方形象检查 → 无房屋时选配色并创建六间房 → 日程检查 → 入住。缺一位就展示对应形象卡；不要求读大段说明才找到选择。已完成的步骤不重复要求。 |
| 4 日程与房间 | 完成 | 日程每条存 `homePosition`，在家绑定实际房间 ID，外出隐藏角色并回客厅提示。按角色时区取当日日程；地图浏览不会把角色一起传送。旧日程提醒补全，失败保留旧日程，可本次先进入。 |
| 5 本地自主活动 | 完成 | 本地匹配当前日程与现有家具能力：休息、睡觉、直播、电脑/游戏、用餐、浇水、洗澡、镜子、厨房活动等。只执行已支持的动作，没有合适能力就安静待着。每个时段每次访问只尝试一次；手动操作优先，可在我的家关闭。 |
| 6 经历上下文 | 完成 | 手动、模型和本地自主行为，以及家园对话，保存至角色 `home3D.records`，并在同一事务投射到 `messages`（source=home）。私聊、通话、见面按统一原文范围读取；编辑删除同步。只记实际开始，不把日程计划写成经历。 |
| 7 家园直接交流 | 完成 | 底部“聊聊”使用角色设定、家园定义、现场房间/活动、家园历史及允许读取的近期私聊生成回复。模型只能请求当前家具提供的动作 ID，执行前再次校验。支持停止、超时、错误提示、重试，失败不丢用户消息。 |
| 8 日常查看器 | 完成 | 查看双方动作与对话；筛选手动/自主/模型；编辑、删除、单次撤销删除、补回失败回复、重新生成回复。重新回复只重写文字，不重放动作；失败保留原回复，历史重生成不会读入之后的家园消息。 |
| 9 手游式整理 | 完成本轮 | 常驻仅地图、返回/总览、聊聊/日常/我的家。点人物打开互动，点家具显示已有动作；装修、形象、设定、画质归入二级面板。首屏短句与图案优先，手办/服装用缩略图；手机抽屉、滚动、触控目标和键盘焦点一并整理。 |

## 房屋与配色

前视图按以下顺序堆叠，数字同时用于可点击的小地图：

```text
    6
  4   5
1   2   3
```

1 客厅、2 卫生间、3 厨房、4 卧室、5 书房、6 空房。初次问“家里应该是……？”，选色后创建房屋；设置里可改配色。小地图区分“你在这里”和角色所在位置。已有存档不强制重排或重新配色。

## 对原界面的处理

- 原来把入住说明、配置与真正的选择挤在一屏；现在拆成逐步入住，补充说明收起，直接看到可选卡片。
- 原来生活界面常驻装修、镜头、楼层和调试式参数；现在生活与布置分开，主要交互回到人物和家具。
- 原来衣橱加载与持续服装姿势修正可能争抢主线程；沿用可取消换装准备、过期请求丢弃和昂贵试穿暂停动画；家园人物对昂贵服装修正限频，骨骼动作继续。打开手办柜暂停后台房屋渲染。这里没有承诺所有设备或所有复杂自绘素材固定帧率。
- 原来只存部分动作的短日志；现在统一为可编辑的生活记录，动作到实际开始节点才写入。未走到家具、路径受阻或材料加载失败，不补造成功经历。
- 原来失败回复和历史回复没有完整操作闭环；现在保留输入、重试不重复发消息、历史重写不重放动作，迟到的模型动作不会覆盖更新的手动操作。

设计参考：[Nintendo 的 Animal Crossing: Pocket Camp Complete 官方介绍](https://www.nintendo.com/us/whatsnew/mobilenews-animal-crossing-pocket-camp-complete-is-now-available/) 中的家具、服装和角色生活组织方式；以及 [EA 的 The Sims 4 玩家指南](https://cdn-assets-ts4.pulse.ea.com/Guide/TheSims4_Players_Guide.pdf) 所介绍的生活/建造操作分工。采用的是入口分工和以人物/物件为中心的交互原则，没有搬用游戏美术资产。

## 数据与执行约定

- `HomeRecord` 区分 `source: user | local | model`、`actor: user | character`、`kind: message | action | presence`，带时间、房间及可选 `replyTo`。`presence` 预留类型，当前不制造离线进出记录。
- 旧 `activityLog` 只在没有 `records` 时迁移；明确的空 `records` 不恢复旧日志。装修撤销与房间导入不会回滚生活记录。
- 查看器保留记录，按批显示；家园与跨应用上下文遵守统一消息范围，按上述 v3 分段计数。保存成功后由 `homeMemoryPostHook` 复用共用记忆整理阈值；未开启记忆宫殿或未达阈值时不调用整理模型，并非每次把全部生活日志发送给模型。
- 动作白名单来自当前房间与家具；模型不能借此创建家具、装修或跨房传送。执行路径、座位和家具条件仍由原引擎校验；不可达时保持原有失败提示，不记动作成功。
- 本地自主活动只在家园打开且可见时运行，不依赖 API、不模拟离线行动。页面隐藏暂停，恢复重新检查日程；一次访问内不因手动打断立即重启同一时段动作。新时段到来会结束前一个自主动作；用户已接管的动作不会被当作旧自主动作取消。
- 用户手办存用户档案，家园与角色手办存各自角色；私人家园字段不随角色卡公开分享。
- “共同生活”的三种定义影响上下文解释，不强制所有关系成为现实伴侣，也不向跨世界角色强加 AI 身份。

## 验证

- 专项测试涵盖定义/上下文、入住门禁、双方形象来源、自绘部件和手势、衣橱切换、六房布局/地图、日程生成与定位、自主活动优先级、对话失败重试/历史重生成/迟到动作、记录编辑删除。首次整组 50 项通过，后补的迟到动作和日程时段交接测试及受影响测试也通过，共 52 项。
- Vite 生产构建通过。全仓 TypeScript 检查仍有既存错误（例如 MemoryPalaceApp 的可空角色及其他模块），不能宣称全仓类型检查通过；本轮家园生活新增文件未发现类型诊断。
- 浏览器在 390×844 下实际操作：入住定义及色板、地图、聊天收发、日常编辑及同步上下文、卧室自主上床、书房走到座椅开始直播、外出回客厅并隐藏角色、二级菜单。验收过程中未读写真实用户角色，控制台没有新增运行错误。
- 请求成功/断网/重试/重生成协议用本地模拟与单元测试验证，未替用户消费真实 API 额度。真实供应商是否遵循动作 JSON 仍受供应商影响；纯文本可正常显示，非法动作不会执行。

## 主要代码入口

`Home3DSetupEntry` / `Home3DEntry` / `HomeDefinitionForm`：入住与定义；`HomeFigureStudio` / `HomeFigureEditor`：双方手办；`useHomeSchedule` / `homeAutonomy`：日程与本地动作；`editor.js`：真实动作与记录；`HomeLifePanel`：交流、日常和菜单；`homeConversation`：模型协议；`homeRecords` / `homeActivityContext`：统一经历管线。

### 人物弧形互动菜单

点人物或「我的家 → 一起玩」打开跟随人物投影位置的弧形菜单。先选分类，再选已有动作；每页最多五项，矮屏三项，边缘自动向内展开。原成员邀请、双方选择、统一体型和表情保留在「成员」二级面板。点击空白收起，Escape 先返回分类再退出。动作成功后收起，失败保留原因；使用原有记录管线。互动轨迹与日常走路共用 navMap，避免合法站位被另一套严格矩形头部范围误判为空地不足，仍检查全程障碍和其他居民。

人物菜单的操作方固定为用户（user）。点角色选对 ta 的互动，菜单锚定被点角色；点用户形象只显示单人动作。缺少用户形象时不回退控制角色，而是引导邀请用户形象。已取消主动方／回应方手动选择。外观采用独立圆形图标、细点线环和短标签，合并底部工具栏，展开时隐藏原底栏。参考动森工具环的留空与图标层次、模拟人生互动分类；不使用其素材。

界面色彩统一为中性黑白灰（含平面图、底栏、设置、经历/聊天、成员及首次定义面板）。房间/人物/家具和选色预览保留实际颜色。人物菜单以骨骼头部的世界坐标投影为环心，经典体型使用头部局部坐标；常规半径 96px，每页四项，矮屏三项，关闭/返回放在底部，不遮住脸。

### Animal Island UI theme (2026-10-03)

The home shell uses [Animal Island UI](https://github.com/guokaigdg/animal-island-ui) 2.1.0 (MIT): real Button, Card, Title and Switch components for the home menu and interaction footer. Public design tokens style the existing imperative room HUD and radial menu through scoped ".home-island" rules in islandTheme.css. Scene assets and social action semantics are unchanged.

Use islandComponents.ts for runtime imports: the package root imports an unused Drawer with an invalid Node-side react-dom path. The facade uses public ESM subpaths and preserves the root type declarations. Vitest inlines the package to transform its CSS modules; it tests the actual components, not mocks.

### Manual control and contextual actions (2026-10-03)

In the home, floor taps and furniture actions default to the user avatar. If the user avatar is unavailable, show a prompt instead of falling back to the character. The resident menu provides an explicit control action for the character and for returning to the user. The furniture animation slot can temporarily host the user; picking, expression identity and journal attribution follow the occupant. Character room/schedule logic retains its own identity, and lifecycle changes restore the character slot. Manual user activity pauses local autonomous actions.

The seated startle reaction is offered only while the user is seated; it blends the upper body on top of the existing seat pose without changing the seat or translating to a social staging area. Paging sits below the radial choices. The map header toggles its room grid; the separate overview button remains available.

### Paired approach (2026-10-03)

Paired social actions plan both residents' routes through the room walking map before starting. The approach uses distance-based duration and walk animation; both reach their staging positions before the shared clip timeline begins. Failed paths reject the action without moving residents. Seated residents must stand first. Cancellation/completion keeps current positions, including suppressing the idle placement search for those validated positions in the same room. Reset in the standalone motion preview still explicitly restores initial positions.

### Resident heading correction (2026-10-03)

User/character slot exchange copies quaternions. XYZ Euler decomposition can represent a yaw beyond 90 degrees as pitch/roll half-turns; changing only rotation.y then reverses subsequent headings. Resident groups now use YXZ, and every editor heading assignment goes through setResidentHeading, which resets pitch and roll explicitly. Paired social release blends each resident toward the other and keeps those final headings. Regression checks cover prior +/-135 and 180 degree headings followed by all four furniture orientations and mutual facing after completion.

### Home wall modes (2026-10-03)

The main HUD exposes 无墙 / 两面墙 / 玩具屋. Two-wall mode hides front/right shared walls as well as external walls. Overview always uses the dollhouse wall mode and a whole-building camera fit, independent of the room wall preference or locked camera mode; returning restores the room's wall preference.

## 本地陪伴与头顶气泡（2026-10-03）

- Home3DView 挂载 useHomeCompanion：每 3 秒低频判断，隐藏页面/挂起/关闭自主活动不决策；主动靠近与看向之间至少 45 秒。手动操控角色、睡觉、坐着、家具动作、互动、模型交谈优先。
- editor 暴露 getCompanionSnapshot / performCompanionAction，实际执行看向用户、互动后转身回应（关系允许时微笑）、同房间寻路靠近/跟随、附近空座坐下。不会跨房间传送或创造动作。路径避开用户，靠近到达后才记录到达；无路就放弃。本版不让角色抢占用户正在使用的家具动作槽，因此用户坐着/睡着时暂不发起这些主动移动。
- homeCompanionPolicy 从 memory palace 的 user_room 与 bedroom 门牌提取 approach/follow/sit/warmth 四个 0–1 倾向。开启记忆宫殿且有资料才使用当前聊天 API；按角色缓存精确资料版本，门牌事件防抖后重算，无变化不调用。失败使用保守默认，禁止循环重试；不修改门牌、不生成台词。无记忆默认不跟随。
- 实际行为仍通过 makeHomeRecord → persist → 既有 home turn/message bridge 保存，未执行的候选不进入上下文。
- 说话气泡由实际发送/收到的文本驱动，长文本按 54 个 Unicode 字符分页，每页 6.5 秒，完整对话保留在原聊天记录；历史编辑/重生成不重播。随头顶投影移动，切房、人物不可见时隐藏；非语言回应仅显示音符。
- 验收入口 test/fixtures/home-review.html：测试说话气泡、测试自主靠近、附近坐下、互动回应；使用本地测试角色，不调用真实 API。

## 情绪 buff → 家园行为（2026-10-03）

仅增加三个内部参数 energy / approach / interaction（-1～1，0 无影响），不增加用户设置滑杆。情绪评估 prompt 要求每个 buff 顺带输出 homeBehavior；共用 emotionApply 落点校验并写入本地 homeBehaviorAt，因此本地与云端 raw 回程都可复用，无额外评估请求。旧纯文本由 homeEmotionLoader 按情绪副 API（未配置则聊天 API）解释一次，按角色和原文精确缓存；失败不猜词、不循环重试。

useHomeEmotion 监听原 emotion-updated 事件及角色属性更新，过日程/情绪总开关；清空或禁用立即回到关系基线。当前参数调节陪伴靠近概率、跟随倾向、附近坐下倾向、动作间隔，并抑制不合适的笑脸；不能抢占手动/模型动作，也不会强制角色睡觉或跨房间移动。行为影响在 30 分钟内线性回归关系基线，不修改或清除 buff 原文，不宣称情绪已解决。强度用于多 buff 加权；混合新旧文本须整体解释。

### 2026-10-04 站桩修复（覆盖前述用户占用家具槽的限制）
普通菜单/视角不再续期90秒自主锁；用户移动、家具指令仅保留6秒短暂让行，实际动作完成条件另行保护。用户家具槽交换后按身份解析双方，角色可使用独立走路过程接近用户，不抢占用户动画；明确操控角色仍禁用自主。新互动回应不被游逛冷却压住，失败路线3秒后重评。行走核心碰撞半径改为0.34（原头宽最低约0.64），头发外沿不封死窄过道；实体家具、墙体与地板边界仍保留。

### 2026-10-04 靠近后的空闲与坐姿交谈
陪伴决策补充低频环顾与同房短途走动，无可达路线时留在原地环顾；坐着只能做空闲上身动作，不自动起身。交谈按角色真实身份播放，用户占家具槽时也不把聊天动画交给用户；保留 parkedSeat / parkedPose，交谈结束恢复原坐姿。普通坐姿对话复用 applySelectedFrame 的上半身遮罩，不覆盖腿和坐位。日程家具动作的双人并行槽仍未扩展，不声称用户占家具时角色可同时执行任意家具动作。

### 2026-10-04 实际自主活动替代环顾
环顾退出自动候选，不记家园经历。新增复用已审核 VRMA 的看手机与手持道具，坐姿只叠上身；支持独立于用户家具槽播放，交谈开始收起手机。普通坐姿休息至少60秒后允许平滑起身，交谈/睡眠/手动操控仍优先。踱步执行白名单补齐，失败不降级为环顾冒充成功。空闲家具候选限现有浇水、镜前整理、电脑、赛车、咖啡；相邻两轮避免同类家具/手机重复。浇水先寻路再执行并避让用户，电脑等循环活动限时结束。日程原有优先级不变，用户占家具槽时仍不开放另一家具动作槽；独立手机、起身、踱步可运行。

### 持续家具活动

直播与使用电脑不再按默认 12 秒自动结束；保持活动状态与忙碌判定，直到显式停止、起身或既有日程/交互切换流程结束。随机自主家具活动也不再在 45 秒截断这两种活动。吃饭、浇水、镜前活动等仍沿用原有有限流程。用户操作其他小人时，场景上下文继续报告角色保留的家具活动。

家具活动工作阶段按种类计时：赛车/音游/煮饭/泡澡 30 秒，吃饭/洗澡 25 秒，洗碗/做咖啡/洗衣/如厕 20 秒；接近、坐下、喝咖啡与收尾动画另算。直播/电脑仍为常态，暂不实现被打断后的自动恢复。时长集中在 furnitureActivityLifetime.ts；镜前穿搭、浇水等完整动作流程保留原节奏。

### 家园小手机

右下角新增独立绘制的手机入口：首页只有信息、拍照。信息直接嵌入 apps/Chat.tsx 的 homePhone 模式，不复写聊天引擎，不建立另一份消息历史。固定当前家园角色，复用 ChatInputArea、ChatModals、useChatAI、buildChatRequestPayload 与原有存储/召回/归档/情绪处理；功能菜单仅转账、戳一戳、相册、重新生成、记忆链接、收藏。记忆链接与收藏在手机容器内呈现，长按消息只留收藏入口。

家园背景通过请求级 homePhoneContext 追加到实时状态段；主请求和副 API 情绪评估都读取，客户端与即时对话 worker 路径共用，关闭手机后正式私聊不携带此字段。家园角色不在当前房间时不宣称双方同房。此入口是私聊，不使用家园当面 JSON 动作协议。

拍照主动渲染当前 WebGL 画面后导出 PNG，不包含 UI、不启用常驻 preserveDrawingBuffer。预览支持重拍、保存；沿用 shareOrDownloadBlob 的网页下载与原生分享能力。开发隔离验收页 test/fixtures/home-phone.html 带独立 QA 角色和模拟 API，仅在隔离浏览器使用。

小手机使用独立 homePhoneAppearance 与气泡主题，隔离原私聊壁纸、气泡自定义 CSS、白框 CSS、布局微调和提示音，不修改用户原设置。监听当前角色 replyStart/replyEnd/replyArrived 与 active-msg-received：回复期间触发站姿/坐姿手机动作，成功到达触发视觉轻震与可用设备触感；收起时显示新消息点。其他角色、隐藏页面不触发震动；离开家园清理动作与计时器。家具活动、躺姿、入场与双人动作优先，不因回复强行改变姿势。

不再显示常驻『点人互动·点家具使用』提示，仅家园交流或当前角色手机回复生成期间显示『角色正在回应…』。手机未读时每 2.4 秒轻震一轮，打开手机首页不消除未读，进入信息后停止；信息已打开且页面可见时收到消息不再重复提醒。页面隐藏暂停震动，离开家园清理计时器；减少动态效果偏好使用柔和提示动画。

### 合影模式
小手机「拍照」进入 HomePhotoMode，替代直接截图。编辑器 photoSession 暂停现场时间推进，暂存可见居民的骨骼/位置/朝向与相机；支持临时并排、间距、单人原动作/待机/选定库招手/挥手回应/舞步/生气定格、动作时间与转向。镜头提供左右环绕、俯仰、缩放、取景高度。退出恢复快照，不写日常记录或房屋布局；自主决策在拍照时不可启动，日程房间变更延后应用。
photoEffects 的原片/霓虹失眠/粉蓝梦游/末班余光预设及光晕、色差、暗角、曝光统一绘制到取景 canvas，快门导出同一画布 PNG，UI 不入镜。仅参数改变时重绘；光晕是屏幕后期，不增加灯光或 LLM 调用。当前不含自由骨骼编辑、独立摄影灯或完整游戏 GPose 系统。

家园手机与 AMSG2：信息复用即时对话路由，家园背景经 fullMessages → fire_pack.chat.messages 上云，定时任务仍走 renderFirePack。手机回应状态合并本地生成与 AMSG_INSTANT_CHAT_PENDING（含 storage 跨标签变动），202 后 replyEnd 不提前熄灭。信息页注册 embedded chat view，外层通知/未读与生成横幅承认该阅读面；手机首页、拍照、关闭与页面隐藏不算阅读。已受理的即时对话不会因收起小手机而取消云端任务。

拍照招手使用 selectedMotionCatalog 中 vrma-8bd33d84e90c0243 与 vrma-788371d87156b583，不使用旧 wave/wave-cute；异步加载按角色版本校验，退出或重新摆位后不再应用旧结果。辉光范围 0–3，按最大颜色通道提取亮部，低分辨率提取后叠加三档模糊扩散，彩色亮部也参与泛光，预览与导出共用。

拍照动作栏按静态姿势 / 单人动作 / 双人互动分类，接全部 42 个正式 selectedMotionCatalog 动作及 home-approved-selection 中确认的 14 个 poses01/poses03 静态姿势。静态源与 SHA256 从 home-source-catalog 校验，转换脚本 art/chibi/build-photo-poses.mjs 输出独立 photo 目录，不污染正式互动目录；没有新增 poses02/04 或双人组合示意。双人定格复用 createSocialScene 的动作轨、接触求解和道具，切换前恢复暂存摆位以免位置累积漂移。新增夏日手绘与晴空物语屏幕调色预设；它们不是替换场景材质的完整动画渲染器。
用户取消了小手机回复执行动作：没有追加家园动作 prompt/directive，也没有更改共享聊天/Worker 动作后处理；只保留原有拿手机表现。

### 3D 家园测试版更新介绍（2026-10-07）

- `HomeUpdatePopup` 排在全局更新队列最前，使用独立已读 key。切页、放大不标已读；明确关闭、进入家园或完整说明后保存。旧公告各自的已读状态不变。
- 五页说明覆盖家园实景、共享上下文、小手机在线聊天、头顶「…」邀请和「我的家 → 角色自动开口」。条件以 `homeInitiative` 为准，不承诺离线自动聊天或无限读取历史。
- `public/assets/updates/home3d-beta/` 为真实组件的演示数据截图。`home-release-scenes.html` 限定独立本地 5190 端口，不使用用户聊天或真实 API。
- 「使用帮助」可重看完整图文；立即体验通过 `roomLaunch` 打开 3D 拜访选人页。公告预览：`test/fixtures/home-release.html`。


### 拍照横幅与按需渲染（2026-10-29）

正式拍照页默认 16:9，提供电影 2.39:1、竖幅、方形和左右留白；手机支持旋转整个取景界面与手势坐标，辅助线不进入照片。缓存场景原片，调滤镜不重复绘制 3D；移动/静止/导出长边分别为 768/1280/2560。实现、参考与验收见 [拍照工作记录](../art/photo-mode-2026/README.md)。
