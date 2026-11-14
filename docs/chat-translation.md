# 聊天译文样式

入口：聊天设置 → 翻译与语音 → 消息翻译 → 原文与译文同时展开 → 译文样式。

- 默认「气泡内」，保留原来的分隔线、翻译标题和气泡排版。「外挂字幕」使用白字黑描边，贴着原文最后一个可见文字片段的下沿，可越出气泡并覆盖时间戳、装饰或下一条消息，不为每条译文额外撑高气泡。
- 外挂字幕使用随应用打包的粗圆体（基于 ChillRoundF Bold v3.200，转换为 WOFF2 并按上游保留字体名要求重命名）。保留全部字形，仅开启外挂字幕后加载，遵循现有静态资源缓存；不依赖外部字体 CDN。字体许可证和来源随发布位于 `public/licenses/subtitle-rounded*`，重建脚本为 `scripts/build-subtitle-font.py`。
- 样式是展示偏好，不改变双语生成、`%%BILINGUAL%%` 解析、单条点击切换或语音条的字幕。仅同时展开的普通双语文本启用；关闭消息翻译或同时展开立即撤下字幕。
- `chat_translate_style_${charId}` 按角色记忆；缺少或无效值回退 `bubble`，另一个值为 `subtitle`。沿用用户空间的私有 localStorage 视图，整合／文字备份及独立用户迁入都保留选择。旧包缺少此字段时不覆盖当前选择。
- `ChatSubtitleLayer` 在消息滚动区内提供独立、零高度的浮层，字幕不在气泡 DOM 内，因而不受气泡的 `overflow`、`clip-path`、圆角或局部层叠限制。Shadow DOM 隔离社区 CSS 的宽泛文字选择器；字幕仍受聊天滚动视口裁切，不覆盖输入栏或弹窗，也不接收点击／触摸。
- 位置取自原文 DOM Range 的末行片段，避开引用块和气泡底部留白。统一批量测量；随内容高度、窗口宽度、字体、主题和有限过渡重新定位。滚动时由同一滚动容器自然带动，无需逐条监听滚动；关闭外挂样式时不建立观察器。

验证：`scripts/test-chat-translation.mjs` 使用真实 `MessageItem` 和样式选择组件，覆盖默认、裁切、无框、深色气泡，引用、多行、Markdown、短原文长译文，320px／390px，内容增高、滚动、末条可达、触摸穿透、角色切换和重载持久化。测试入口为独立的 `test/fixtures/chat-translation.html`，不操作用户聊天数据。

## 公开白框兼容验收（2026-11-14）

`scripts/test-chat-translation-library.mjs` 在隔离 Edge 中通过正式美化库的搜索、详情、领取流程装载原件，使用正式 `ChatHeaderShell`、`MessageItem`、`ChatInputArea` 和 `BlobRefStyle` 渲染虚构聊天。作品只保存在测试页面状态，不写入日常角色配置，不修改或提交作者 CSS。

通过的六款：仿QQ 磨砂 iOS适配by秩（S-719F61E348EE）、仿微信 iOS适配by秩（S-99FB665850AC）、简讯iMessage 黑白 iOS适配by秩（S-36C07C186D47）、纸胶带（S-919767B5AE18）、Cyberpunk（S-F46892363B7E）、巨无霸简约（日夜）（S-E7480EF4BAF9）。每款检查 390px／320px × 系统浅色／深色，共 24 组；覆盖末行锚点、字体和颜色隔离、滚动、样式开关、新增长译文贴底、输入和长按。截图和结果在忽略的 `output/chat-translation-library/`。这是 Chromium 的手机宽度验收，不等同于 iOS 真机测试。

Cyberpunk 的滚动内容比视口宽 28px（390→418，320→348），气泡内与外挂字幕一致，是原主题已有行为；字幕自身保持在视口内。紧凑布局中的译文允许覆盖时间戳或相邻消息，沿用外挂字幕的展示约定。
