# AGENTS.md

给 AI 编程助手（Claude Code 等）的项目导航。SullyOS 是装在浏览器里的虚拟手机系统（React + TS + Vite，local-first，IndexedDB 存储）。详细介绍见 [`README.md`](./README.md)。

这份文件只做一件事：**告诉你遇到某类问题该去翻哪份文档**，别在代码里瞎逛。

> 包管理器统一用 **pnpm**：装依赖 `pnpm install`、跑测试 `pnpm vitest run`、跑脚本 `pnpm <script>`。别用 npm / yarn（仓库里是 `pnpm-lock.yaml`）。

## 文档地图

| 主题 | 文档 | 什么时候看 |
|------|------|-----------|
| **世界书分组与角色绑定** | [`docs/worldbook-management.md`](./docs/worldbook-management.md) | 改世界书触发方式、整组编辑／删除、神经链接挂载前必读；绑定按 ID，库与角色缓存同事务更新 |
| **协同工作私聊衔接与转发** | [`docs/collaboration-chat-bridge.md`](./docs/collaboration-chat-bridge.md) | 改协同读取 ChatApp 范围或转发消息前必读；每轮读 DB，空范围不回退，多选只发当前窗口 |
| **开发调试面板 / 开关** | [`docs/dev-debug.md`](./docs/dev-debug.md) | 加 dev-only 开关、加调试日志、排查"角色怎么又不说话了"。含逐步指南 |
| **彼方 · 书库分类与阅读偏好** | [`docs/kanata-library.md`](./docs/kanata-library.md) | 改书籍归类、批量整理、角色选书轮换或书库备份前必读；按分类模式不得回退全书库 |
| **彼方 · 活动选择与自动范围** | [`docs/kanata-activities.md`](./docs/kanata-activities.md) | 改房间/SAR 随机选取、手动子玩法路由或高级排除设置前必读；自动全禁用不得回退，手动可绕过 |
| **记忆系统** | [`docs/memory-system-overview.md`](./docs/memory-system-overview.md) | 涉及长期记忆、月度总结、向量化记忆宫殿、情感空间。改记忆相关逻辑前必读 |
| **查手机 · 人际关系系统** | [`docs/relationship-system.md`](./docs/relationship-system.md) | 改「查手机」聊天/通讯录、角色联系人/好感、真假甄别、真角色双向对话、虚构 NPC 约束前必读 |
| **见面 · 观测协议 OBSERVE** | [`docs/date-observe.md`](./docs/date-observe.md) | 改见面（DateApp）的角色观测面板：提示词注入、掉格式解析容错（两层）、全息 HUD 渲染前必读 |
| **彼方 · 信号坠落处（跨用户接龙诗）** | [`docs/signal-poetry.md`](./docs/signal-poetry.md) | 改彼方(VRWorld)「信号坠落处」房间：跨实例合写现代诗、复用漂流瓶后端、`po_poems`/`po_poem_lines` 表与 `/poem/*` 端点、两层容错解析、并发安全前必读 |
| **捏人器 PSD 导入 / 部件投影层** | [`docs/char-creator-psd-import.md`](./docs/char-creator-psd-import.md) | 改捏人器素材管线、部件阴影（正片叠底预转）、PSD 图层组约定前必读 |
| **QQ捏人工坊（神经链接手办柜）** | [`docs/chibi-studio.md`](./docs/chibi-studio.md) | 改小小窝/彼方/520 三处 Q 版形象、捏人器 savedState 还原、`chibiStudio` 字段前必读 |
| **角色自定义时区** | [`docs/character-timezone.md`](./docs/character-timezone.md) | **写任何跟时间有关的代码前先扫一眼**：prompt 里的「现在是」、角色作息/夜间判断、日期 key、界面上的钟。分清「角色那边几点」和「用户自己的时间」，别自己手搓时差。文末列了还没接时区的几处（主动消息 + 几块界面上的钟），**正式发版前记得过一遍** |
| **通用 MCP 工具服务器** | [`docs/mcp-client.md`](./docs/mcp-client.md)（开发者）、[`docs/mcp-user-guide.md`](./docs/mcp-user-guide.md)（用户教程，设置「?」弹窗跳转的就是它，改接入行为要同步） | 改用户自配 MCP 接入（设置板块、握手/session、工具循环、`?target=` 代理约定、worker/mcp-proxy）或排查「工具连不上/角色不调工具」前必读；主动消息 2.0 的后台 MCP 路径（配置上云 / fire 时注入 / worker 直连执行）也在这份 |
| **主动消息 2.0 · 即时对话** | [`plans/amsg2-instant-chat.md`](./plans/amsg2-instant-chat.md)（设计与取舍）、[`plans/amsg2-instant-chat-contract.md`](./plans/amsg2-instant-chat-contract.md)(端点/信封/fire_pack v7 契约) | 改「聊天在用户自己的 CF Worker 上生成」这条路（`POST /instant-chat`、`utils/amsgInstantChat.ts`、fire_pack 的 `chat` 段、chat_outbox 补收、「正在输入」超时）前必读 |
| **主动消息 2.0 · 后台任务（不说话的活儿）** | [`plans/amsg2-expansion.md`](./plans/amsg2-expansion.md) | 改「页面关着也能跑完」的后台活儿前必读：`metadata.amsgKind` → handler 注册表（`worker/amsg/src/fireKinds.ts`）、一次性输入的 `amsg:job` 命名空间与 TTL、`ctx.emitResult` 的结果回程与客户端分发（`utils/amsgResults.ts`）。文首「现状」是实况，正文是「还有哪些调用点值得搬、哪些不该搬」的取舍 |
| **主动消息 2.0 · API 凭据引用 credRefs** | [`plans/amsg2-llm-credentials-contract.md`](./plans/amsg2-llm-credentials-contract.md) | 改凭据上云（`llm_credentials` 表、任务 `credRefs`、`utils/amsgLlmCredentials.ts` 的每角色三行）或排查「换 Key 后主动消息 401 / 不来了」前必读；文末「SullyOS 侧落地」是实况 |
| **Instant Push SSE↔Push 契约** | [`docs/instant-push-dual-channel.md`](./docs/instant-push-dual-channel.md) | **改 instant push 路径或排查「报错但收到消息」类 bug 前必读**。SSE ≠ 送达判定通道、catch 不能直接判 send-failed |
| **Instant Push 通道** | [`docs/instant-push-branch-notes.md`](./docs/instant-push-branch-notes.md)、[`worker/instant-push/README.md`](./worker/instant-push/README.md) | LLM-driven Web Push、worker 端 agentic loop / reasoning / 副作用 directive |
| **使用统计** | [`docs/analytics.md`](./docs/analytics.md) | **加任何埋点前必读**。收什么/不收什么的边界、事件名与属性的规矩（属性只能是固定枚举）、构建时门禁与开关、完整事件清单。想加「某功能有多少人开了」看「加新埋点的规矩」第 5 条，别在配置页现场发 |
| **二改 / 加 App / 数据流 / 后端 Worker** | [`README.md`](./README.md) 「给想二改的人」一节 | 新增 App、build badge、sfworker 代理替换、开源协议 |

> README 的「给想二改的人」区域信息量很大（数据流、ContextBuilder、Instant Push Phase 2、sfworker 清单），动后端 / 加功能前先扫一遍。

## 什么时候改版本号

[`utils/buildInfo.ts`](./utils/buildInfo.ts) 里的 `APP_VERSION`（形如 `v3.0 (Ambient Presence)`）是手工维护的，**只有大功能更新才动它**：加了新 App、新系统，或者一整套用户能直接感知到的新玩法。

性能优化、bug 修复、文案调整、重构这些都不算，做完就是做完了，既不用改版本号，也不用在收尾时问一句「要不要顺便升个版本」。拿不准就照这条判断：用户在设置页看到版本号变了，能不能说出多了什么新东西——说不出来就是不该改。

它有两个用处：设置页底部显示的就是它；统计还拿版本号那半截当标签，面板按它切分数据。版本号跟着大功能走，标签才对得上「哪一版铺开到什么程度、这版的人在用什么」；小修小补也跳版本的话，标签会碎成一堆没法比的小格子。括号里的代号只在界面上显示，不进标签。构建 hash（`BUILD_LABEL`）是自动生成的，不用管。
