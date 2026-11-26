# AGENTS.md

给 AI 编程助手（Claude Code 等）的项目导航。SullyOS 是装在浏览器里的虚拟手机系统（React + TS + Vite，local-first，IndexedDB 存储）。详细介绍见 [`README.md`](./README.md)。

这份文件只做一件事：**告诉你遇到某类问题该去翻哪份文档**，别在代码里瞎逛。

> 包管理器统一用 **pnpm**：装依赖 `pnpm install`、跑测试 `pnpm vitest run`、跑脚本 `pnpm <script>`。别用 npm / yarn（仓库里是 `pnpm-lock.yaml`）。

## 每次改动的联动检查

按以下顺序检查改动影响。已有机制覆盖时复用原路径，收尾说明实际改动与验证结果。

1. **Umami 使用统计**。核对新入口、实际完成的动作与失败信号，先查已有事件，按同一口径计数。设置使用率进冷启动快照。属性只用显式白名单里的固定值，同时更新事件清单和隐私回归。要进 canary 的新功能，在同一批提交里按清单补齐结局、失败原因、分母、立项假设、用户操作、对照组和静默丢弃。[使用统计](./docs/analytics.md) · [canary 效果埋点](./docs/analytics.md#canary-功能的效果埋点)
2. **导入、导出与迁移**。逐项确认新增数据归属、文字／媒体／整合范围、单用户／全部用户、迁入为独立用户、云备份、旧文件和单项分享。用实际导出的数据恢复一次；媒体补图仅更新匹配记录。App 内的文件导出统一经 `shareOrDownloadBlob` 或 `shareOrDownloadFile` 拉起系统文件分享，大文件启用分块，网页「下载」可直接保存。区分成功、取消和失败。[用户空间](./docs/user-spaces.md) · [分享实现](./utils/shareExport.ts)
3. **Sully-11**。入口、按键、可调范围、存储边界或失败处理有变化时，更新对应手册区；涉及用户实际配置时核对设置摘要。[十一号手册](./docs/sully-11-handbook.md)
4. **协同工作制作提示词**。美化改动核对复制给 AI 的说明、选择器、预览和安装器。世界书等可制作格式改动同时检查制作提示词示例、校验、预览、安装、导出和旧作品加载；用新示例沿实际路径验收。[制作器](./features/collaboration/makers.ts) · [美化契约](./docs/chat-decoration.md)

## 文档地图

使用帮助里的 Sully-11 使用[操作手册](./docs/sully-11-handbook.md)和[Discord 社区规则](./docs/sully-11-discord.md)。改用户操作时同步对应功能区：二级标题列 App / 系统与别名，首行「能力」供检索，「核对」链接到实现，三级标题直接构成可查阅目录。社区规则每个二级标题为一区。每轮提供短目录，按需读区；应用和系统的实时设置由 `utils/sullyHelpSettings.ts` 投影。本机按用户空间保留完整咨询记录，每段仅最近 200 条可参与本轮上下文。20 分钟无互动或手动新建后归档，历史可续聊。

有改动绕过 canary 直接合进 master（外部 PR、热修）后，顺手把 master 同步到 canary：照 [`docs/canary-channel.md`](./docs/canary-channel.md#master-改动同步到-canary) 走完，直到 `deploy-canary.yml` 部署成功、`origin/canary..origin/master` 为空。说「同步 canary」也是走这一套。

静态资源、Service Worker 缓存、离线启动或网页更新：先读 [`docs/static-resource-cache.md`](./docs/static-resource-cache.md)。不得注销推送 SW、清应用数据库或按整个 `/assets/` 目录设置 immutable。

| 主题 | 文档 | 什么时候看 |
|------|------|-----------|
| **用户空间 / 角色继承 / 共享素材** | [`docs/user-spaces.md`](./docs/user-spaces.md) | 改用户切换、角色专属用户资料、跨空间继承、备份范围或素材删除前必读；会话固定所属空间、配置独立文件共用、继承不带经历；定位设置随个人备份，实时坐标不备份 |
| **备份与恢复 · 内存有界链路** | [`docs/backup-pipeline.md`](./docs/backup-pipeline.md) | 改备份导出/恢复、云端上传下载、备份格式，或往数据库加新表、新增 localStorage 键前必读；整份备份只以磁盘文件存在，内存只放一片（按字节封页），读包按需随机读，恢复逐页写库，上传一律分片加完成清单并以远端实际大小为准；新表默认进备份、新设置键默认不进，两张分类表都有覆盖测试；新加会跑很久的任务照「中断留痕」接 `utils/taskTrace.ts` |
| **悬浮球、全局返回与聊天输入栏收起** | [`docs/navigation.md`](./docs/navigation.md) | 改快捷导航开关、拖动安全区、浏览器／Android 返回、美化子页退出、聊天工具栏外部收起或选图挂载前必读 |
| **iOS 27 主屏幕顶部白雾 / 状态栏底色** | [`docs/ios-status-bar-edge.md`](./docs/ios-status-bar-edge.md) | 改顶部取色、viewport 或 iOS 门禁前必读；manifest standalone 使用 contain，零安全区不回退 44px，异步高度收缩要重建基线；纯色接合不等于壁纸贯穿 |
| **3D 小屋 · 布局与功能分区** | [`docs/room3d-layout.md`](./docs/room3d-layout.md) | 设计或重排任何房间/样板房、自动摆家具前必读；先划功能区，再按家具组合摆放，保留连续动线，不能逐件随机找空位；本轮统一黑 × 绿 × 白 |
| **美化分享码与人工审核** | [`docs/beauty-share.md`](./docs/beauty-share.md) | 改美化投稿、作者身份、分享码领取或 `worker/beauty-share` 前必读；未审文件保持私有，更新通过后才替换已发布指针，仅作者明确授权且已审作品进入公开静态装扮库，未授权旧作不公开 |
| **ChatApp 装扮、白框与深浅色对比度边界** | [`docs/chat-decoration.md`](./docs/chat-decoration.md) | 改 `.sully-chat-root` 挂载范围、消息时间位置/选择器、白框选择器、心象/装扮弹窗或深浅色表单控件前必读；弹窗与迷你应用挂载在 `.sully-chat-root` 外并带显式深字/浅底边界，深底 `<select>`／日期时间控件配 `[color-scheme:dark]` 与 `[&_option]`，白框用 `:not(:where(...))` 排除色板点/二维码白底/进度条/`qixi_event_card`/`like520_card` |
| **角色默认对话 API** | [`docs/character-api.md`](./docs/character-api.md) | 改角色独立 API、API 预设分组或对话模型路由前必读；App 优先，单角色回复才使用角色默认，凭据整套选择 |
| **全站 API 槽位、预设引用与自动保存** | [`docs/api-slots.md`](./docs/api-slots.md) | 改任何 API 配置面板、预设增删改、副 API 回退或流式升级前必读；统一复用 `ApiSlotEditor`，预设按 `presetId` 引用联动并保留内联快照兼容双通道，自动保存仅在完整合法或全空时提交 |
| **Anthropic 原生接口 / Prompt Caching** | [`docs/anthropic-messages.md`](./docs/anthropic-messages.md) | 改 Messages 转换、SSE、缓存或 amsg 原生模型调用前必读；原生端点随整套凭据保存，不新增代理，旧 Worker 先更新并验证能力 |
| **私聊可见范围 / 模型上下文顺序** | [`docs/chat-message-visibility.md`](./docs/chat-message-visibility.md) | 改私聊取数、来源过滤、上下文排序或「接着说」续写前必读；界面按 id、模型按时间戳，时间戳偏晚的旧记录要挪回原轮次，家园记录除外 |
| **心象 / 思考摘要与正文分离** | [`docs/thinking-response.md`](./docs/thinking-response.md) | 改 thinking 解析、心象显示或排查思考漏进气泡前必读；只按明确字段和标签分流，不凭语言猜测，空正文不得用思考补齐 |
| **聊天译文样式 / 外挂字幕** | [`docs/chat-translation.md`](./docs/chat-translation.md) | 改双语展示或字幕定位前必读；默认保留气泡内译文，外挂字幕独立浮层贴原文末行，样式按角色保存 |
| **ElevenLabs 角色语音** | [`docs/elevenlabs-tts.md`](./docs/elevenlabs-tts.md) | 改 v4 / Turbo 语音、Audio Tags、模型参数或字幕前必读；v4 保留开放式标签，只发送稳定度与相似度，不自动降级 |
| **网易云音乐代理与播放直链** | [`docs/netease-music-proxy.md`](./docs/netease-music-proxy.md) | 改音乐 App 播放直链、`worker/index.js` `/netease/*`、风控降级或缓存规则前必读；320k 内直走 `weapi`、高解析度失败降级，边缘缓存按凭据摘要分桶且不缓存试听或空直链 |
| **角色统计 / 上下文字数与 Token 估算** | [`docs/character-statistics.md`](./docs/character-statistics.md) | 改神经链接角色统计前必读；可读范围不等于实际请求，概率预览不得抽签，宫殿缓存单列 |
| **API 调用记录 / 用途与云端记账** | [`docs/api-call-log.md`](./docs/api-call-log.md) | 新增 `/chat/completions` 调用点、改 `ApiCallMeta` 归属或云端模型用量回传前必读；显式 `meta` 不混入前台环境角色，推送不回传凭据 |
| **世界书管线、分组与角色绑定** | [`docs/worldbook-management.md`](./docs/worldbook-management.md) | 新增 App／角色生成请求或改世界书前必读；新入口使用 ContextBuilder.buildCharacterRequest，世界书自动随角色装载；每个入口声明启用场景，新 App 先登记子场景；绑定按 ID，库与角色缓存同事务更新 |
| **协同工作私聊衔接与转发** | [`docs/collaboration-chat-bridge.md`](./docs/collaboration-chat-bridge.md) | 改协同读取 ChatApp 范围或转发消息前必读；每轮读 DB，空范围不回退，多选只发当前窗口 |
| **canary 版本通道** | [`docs/canary-channel.md`](./docs/canary-channel.md) | 改 canary 加入退出、`/canary/` 跳转脚本、通道配对、`deploy-canary.yml` 或 Worker 的 `bundle_channel` 前必读；dev 合并进 canary 分支发布，master 直接合入的改动要同步过去，同网址子路径共用数据，加入先换 Worker 再换前端，冷启动按通道对齐且跳转未生效时不动 Worker，连续两次启动失败自动退回 |
| **假模型（端到端调试 / 回归）** | [`docs/fake-llm.md`](./docs/fake-llm.md) | 用不花钱、可重复的假回复测私聊、即时对话、定时主动消息和云端代跑前看；场景按模型名 `fake/<场景>` 选，辅助请求自动给空操作回复；先查「每条链路读哪个 API 槽位」，调试面板一键换过去要能一键换回 |
| **开发调试面板 / 状态栏报错诊断** | [`docs/dev-debug.md`](./docs/dev-debug.md) | 加 dev-only 开关、加捕获日志，或改顶部「查看报错」日志归属、流式断连分类与 URL 脱敏前必读 |
| **彼方 · 书库分类与阅读偏好** | [`docs/kanata-library.md`](./docs/kanata-library.md) | 改书籍归类、批量整理、角色选书轮换或书库备份前必读；按分类模式不得回退全书库 |
| **彼方 · 活动选择与自动范围** | [`docs/kanata-activities.md`](./docs/kanata-activities.md) | 改房间/SAR 随机选取、手动子玩法路由或高级排除设置前必读；自动全禁用不得回退，手动可绕过 |
| **记忆系统** | [`docs/memory-system-overview.md`](./docs/memory-system-overview.md) | 涉及长期记忆、月度总结、向量化记忆宫殿、情感空间。改记忆相关逻辑前必读；新增拼角色上下文的入口（含云端快照）要在请求副本上自备召回，召回与门牌不落库 |
| **查手机 · 人际关系系统** | [`docs/relationship-system.md`](./docs/relationship-system.md) | 改「查手机」聊天/通讯录、角色联系人/好感、真假甄别、真角色双向对话、虚构 NPC 约束前必读 |
| **好友圈 · 独立 App 与家园手机** | [`docs/friend-feed.md`](./docs/friend-feed.md)、[`docs/friend-feed-weibo.md`](./docs/friend-feed-weibo.md) | 改好友圈入口、生活圈、动态评论、微博或备份前必读；双入口共用数据，角色按 ID 分圈；绑定微博按 RP 身份混排，同步不写记忆；通知提供文本操作格式，微博复用设置代理 |
| **查手机 · 人格模拟与生活记录** | [`docs/persona-sim.md`](./docs/persona-sim.md) | 改「用 TA 的手机活一次」生成、保存、断点续播或完成效果前必读；生成即归档，通知不是唯一剧本，首次到结尾才加情绪效果 |
| **见面 · 观测协议 OBSERVE** | [`docs/date-observe.md`](./docs/date-observe.md) | 改见面（DateApp）的角色观测面板：提示词注入、掉格式解析容错（两层）、全息 HUD 渲染前必读 |
| **银行 / 生活记录 · 收支记账** | [`docs/bank-ledger.md`](./docs/bank-ledger.md) | 改收入、支出、角色代记、预算或 CSV 导出前必读；旧流水默认支出，收入不扣支出预算，全部导出跨月跨年 |
| **彼方 · 信号坠落处（跨用户接龙诗）** | [`docs/signal-poetry.md`](./docs/signal-poetry.md) | 改彼方(VRWorld)「信号坠落处」房间：跨实例合写现代诗、复用漂流瓶后端、`po_poems`/`po_poem_lines` 表与 `/poem/*` 端点、两层容错解析、并发安全前必读 |
| **捏人器 PSD 导入 / 部件投影层** | [`docs/char-creator-psd-import.md`](./docs/char-creator-psd-import.md) | 改捏人器素材管线、部件阴影（正片叠底预转）、PSD 图层组约定前必读 |
| **QQ捏人工坊（神经链接手办柜）** | [`docs/chibi-studio.md`](./docs/chibi-studio.md) | 改小小窝/彼方/520 三处 Q 版形象、捏人器 savedState 还原、`chibiStudio` 字段前必读 |
| **3D 小人 · 服装与衣橱** | [`docs/chibi-clothing-assets.md`](./docs/chibi-clothing-assets.md) | 改 3D 服装建模、肩袖/领口、蒙皮遮挡、版型参数、分类与缩略图前必读；使用当前 48 骨素体，复用认可母版，先查参考再局部制作，保留用户确定的窄肩/A 字袖规则 |
| **3D 小屋 · 家具素材与交互** | [`docs/room3d-furniture-assets.md`](./docs/room3d-furniture-assets.md)、[`docs/room3d-seating-assets.md`](./docs/room3d-seating-assets.md)、[`docs/room3d.md`](./docs/room3d.md) | 导入 GLB / 其他家具、改配色/优化/坐位/浇水前必读；清理图片贴图，自行上色，统一项目木色，拆分桌上摆件并验收 chibi 空间 |
| **角色自定义时区** | [`docs/character-timezone.md`](./docs/character-timezone.md) | **写任何跟时间有关的代码前先扫一眼**：prompt 里的「现在是」、角色作息/夜间判断、日期 key、界面上的钟。分清「角色那边几点」和「用户自己的时间」，别自己手搓时差；关闭聊天时间感知默认停用主动消息 2.0（需显式确认才放行）。文末列了还没接时区的几处（主动消息 + 几块界面上的钟），**正式发版前记得过一遍** |
| **通用 MCP 工具服务器** | [`docs/mcp-client.md`](./docs/mcp-client.md)（开发者）、[`docs/mcp-user-guide.md`](./docs/mcp-user-guide.md)（用户教程，设置「?」弹窗跳转的就是它，改接入行为要同步） | 改用户自配 MCP 接入（设置板块、握手/session、工具循环、`?target=` 代理约定、worker/mcp-proxy）或排查「工具连不上/角色不调工具」前必读；主动消息 2.0 的后台 MCP 路径（配置上云 / fire 时注入 / worker 直连执行）也在这份 |
| **主动消息 2.0（amsg2）** | [`docs/amsg2-overview.md`](./docs/amsg2-overview.md) | 改即时对话、定时主动消息、云端生成与后台整理、频率上限、离开后消息、见面离开提醒、凭据上云、云端数据、救援、中转或设置页前必读；先读总纲里的目标与红线，再从文末导航进子文档。云端与本地生成只允许登记过的差异，其余一律按 bug 处理 |
| **使用统计** | [`docs/analytics.md`](./docs/analytics.md) | **加任何埋点前必读**。收什么/不收什么的边界、事件名与属性的规矩（属性只能是固定枚举）、构建时门禁与开关、完整事件清单。想加「某功能有多少人开了」看「加新埋点的规矩」第 5 条，别在配置页现场发 |
| **不可逆操作与二次确认** | [`docs/destructive-confirmations.md`](./docs/destructive-confirmations.md) | 改删除、清空、重置、覆盖或 AI 重生成按钮前必读；禁用原生 `confirm()`，统一用 `useConfirmDialog` / `<BeautyConfirmDialog>` / 行内两步，含高价值渔获阈值、单击归档例外与确认后再埋点规矩 |
| **二改 / 加 App / 数据流 / 后端 Worker** | [`README.md`](./README.md) 「给想二改的人」一节 | 新增 App、build badge、sfworker 代理替换、开源协议 |

> README 的「给想二改的人」区域信息量很大（数据流、ContextBuilder、sfworker 清单），动后端 / 加功能前先扫一遍。

用户定位、隐私区域、地点查询与位置提示词：先读 [`docs/user-location.md`](./docs/user-location.md)。命中隐私圈不得查地图；定位请求不得通过 Worker／代理转发；原始坐标不进提示词、日志或 Worker 状态。个人备份包含已保存的隐藏地点中心、地图 Key 与按用户的角色授权，不包含设备实时坐标或查询缓存。

## 什么时候改版本号

[`utils/appVersion.ts`](./utils/appVersion.ts) 里的 `APP_VERSION`（形如 `v3.0 (Ambient Presence)`）是手工维护的，**只有大功能更新才动它**：加了新 App、新系统，或者一整套用户能直接感知到的新玩法。

性能优化、bug 修复、文案调整、重构这些都不算，做完就是做完了，既不用改版本号，也不用在收尾时问一句「要不要顺便升个版本」。拿不准就照这条判断：用户在设置页看到版本号变了，能不能说出多了什么新东西——说不出来就是不该改。

它有三个用处：设置页底部显示的就是它；统计还拿版本号那半截当标签，面板按它切分数据；网页更新也看版本号那半截，变了才给正在用的人弹「新版本已准备好」，没变的更新等下次打开或刷新时悄悄换上。版本号跟着大功能走，标签才对得上「哪一版铺开到什么程度、这版的人在用什么」；小修小补也跳版本的话，标签会碎成一堆没法比的小格子。括号里的代号只在界面上显示，不进标签。构建 hash（`BUILD_LABEL`）是自动生成的，不用管。
