# 不可逆操作与二次确认规范

本文档约定 SullyOS 中删除、清空、重置、覆盖及重生成等不可逆操作的二次确认边界、选型方式与统计埋点时机。

## 一、确认机制选型

全应用统一使用应用内确认交互，不使用浏览器原生 `window.confirm` / `confirm()`：原生弹窗会破坏 PWA 全屏体验、绕过应用内返回栈，也无法在取消时维持页面状态（例如取消手账撕页时应保留草稿编辑状态）。

| 场景 | 实现方式 | 说明与约束 |
|------|----------|------------|
| 常规 App 主页面 / 列表 | `useConfirmDialog()` + `<ConfirmDialog />` | 基于 [`hooks/useConfirmDialog.tsx`](../hooks/useConfirmDialog.tsx) 与 [`components/os/ConfirmDialog.tsx`](../components/os/ConfirmDialog.tsx)。保留 `.bg-white.text-slate-800.rounded-2xl` 显式亮底深字契约以隔离外层主题继承；打开时通过 `useLocalBackHandler` 占用 `120` 优先级拦截返回键；支持连续两步链式确认（先清 `resolverRef` 与 `pending` 再 `resolve`）；卸载时自动按 `false` 结算。 |
| `<Modal>` 或原生 `<dialog>` 内的弹窗 | `useConfirmDialog({ portal: true, zIndex? })` | [`components/os/Modal.tsx`](../components/os/Modal.tsx) 的 `animate-slide-up` 与局部浮层会制造 `transform` 包含块，传 `portal: true` 挂载到 `document.body`；若确认触发时页面已存在打开的原生 `<dialog>`（如聊天角色名片 `ChatCharacterProfile`），[`components/os/ConfirmDialog.tsx`](../components/os/ConfirmDialog.tsx) 会自动外包一层透明 `<dialog data-sully-confirm-top-layer>` 进入浏览器 Top Layer，同时阻断合成事件冒泡与 `Escape` 键穿透。若宿主本身是高 `z-index` 全屏活动浮层（如 `z-[9997]` 档位），需传入更高的 `zIndex`（如 `10010`）。 |
| Chat / GroupChat 舞台外边界 | 非 Portal 的 `useConfirmDialog()` 放在 `.sully-chat-root` 外 | 为满足 [聊天装扮契约](./chat-decoration.md) 并兼容家园手机预览裁切，`<ConfirmDialog />` 需挂载在 `.sully-chat-root` 外侧且同处视口根容器内。 |
| 装扮 / 美化浮动面板 | `<BeautyConfirmDialog />` | [`components/share/BeautyConfirmDialog.tsx`](../components/share/BeautyConfirmDialog.tsx) 使用原生 `<dialog>.showModal()` 进入浏览器顶层（Top Layer），可直接越过面板 `transform` 与最高 `z-index`（如手账外观编辑器）。 |
| 紧凑工具条 / `.friend-feed` / 独立 JS 模块 | 行内两步确认或原生 `<dialog>.showModal()` | 在小浮层、底部动作条、受独立按钮样式重置影响的页面（`.friend-feed`）以及原生 DOM 面板（如 `apps/room3d/editor.js` 的 `confirmWithDialog`、`petSystem.js`）中使用，避免全屏遮罩冲突。 |

## 二、必须加二次确认的范围

1. **删除与清空**：单条/批量删除消息、帖子、动态、日记、计划、预设、世界书、记忆、主题美化、自制素材、本地/云端数据、联系人和分身账号等。
2. **重置与覆盖**：恢复默认桌面/壁纸/头像以外的核心数据或美化主题、清空内容、整库重置、导入备份覆盖当前用户空间、云端备份覆盖恢复、角色/城市重启、以及保存会截断后续消息历史的系统/提示词编辑。
3. **AI 回复重生成 / 重掷（Reroll）**：包括私聊、群聊、见面、通话、手账、日记、小说、写歌、学习、画廊、日程、剧情小剧场、彼方剧场/内阁/模拟、协同工作、攻略书与 TRPG 等所有会覆盖或丢弃上一版 AI 回复（连带语音、附件或后续轮次）的重生成入口。
4. **不可逆高代价动作**：删除 MCP 服务器/账号/联系人/自制部件、更换已有主密钥或 VAPID 密钥、覆盖用户本地上传且未入预设/库的自定义图标与内嵌音频、0 金币放生、将恐龙送出、以及卖出高价值渔获。

## 三、刻意保留单击直达的例外

以下情况为避免高频打断操作节奏，经过取舍后保留单击或仅在有实质损失时弹窗：

- **彼方钓鱼集市（[`apps/vrWorld/FishingMarketOverlay.tsx`](../apps/vrWorld/FishingMarketOverlay.tsx)）**：
  - **1–2★ 无节日帽的普通/罕见鱼**：直接按行情卖出（`needsSaleConfirm === false`），因为单次钓鱼后高频清理低星普通鱼，逐条弹窗会打断游玩节奏；`>= 3★`、稀有（`rare`/`epic`/`relic`）、佩戴万圣节帽子、时空遗物类以及 0 金币`放生`、`把这只送给 ta` 均保留二次确认。
  - **委托板`撤下并存档`**：是将委托收入`往期便笺`而非删除记录，属于无损归档，保持单击完成。
- **界面失效急救按钮**：群聊/聊天装扮的 `#sully-safe-reset`、交换日记的 `#sully-journal-saved-style-rescue` 与悬浮球复位抢救用于在自定义样式/位置失效挡住界面时一键脱困，必须单击生效，不得加确认拦路。
- **可逆开关、「跟随全局」切换与退出登录**：如便利贴取消置顶、停用主动消息 2.0 开关、角色「跟随设置中的 API」/「恢复整体头像」、锁屏恢复「跟随桌面壁纸」、设置恢复默认代理地址、网易云退出登录、悬浮球位置/排障日志/提前结束单次模块，以及仅切换选中态、筛选条件或内置样式（内置水母/经典 PWA 图标互切、内置提示音与直链互切）的操作均保持单击直达。
- **轻量化微调与自带撤销栈（Undo）的操作**：如删除单个印象标签、删除单行自定义请求头、清除临时情绪状态（buff）、恢复 3D 相纸默认文案，以及已接入整屋撤销栈的 3D 小屋整屋备份导入（`apps/room3d/editor.js` 的 `import`，可点撤销还原），保持单击流畅操作。
- **目标本就为空或无外部自定义资产被覆盖**：仅当目标已存在非空正文/用户上传资产时触发确认（例如已有内容的小说/写歌单行重生成、已有日程样式切换、已有月度总结重炼，以及已上传自定义 PWA 图标或内嵌上传音频 `isUpload` 将被清除或覆盖时）；空占位行或纯内置选项之间切换直接执行。

## 四、取消不丢状态与埋点时机

1. **取消时不丢现场状态**：异步确认返回 `false` 后应保持当前编辑器草稿、已选弹窗或列表现场不关闭（如手账单页编辑器在确认撕页返回 `false` 时保留编辑态；云端恢复列表在取消时保留列表弹窗）。
2. **埋点置于确认放行之后**：`trackEvent(...)` 不得绑定在确认前的触发按钮 `onClick` 中（例如聊天批量删除、生活记录「否决」），必须在用户点击弹窗确认、实际变更逻辑开始执行之后再记录，防止取消操作污染统计数据。详细规则见 [使用统计文档](./analytics.md)。
