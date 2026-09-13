# ChatApp 装扮与整套预设

聊天「＋」→「聊天装扮」统一布局、气泡、背景、声音和进阶 CSS（原白框）。旧 `chrome-css`、`fine-tune`、`chrome-sound` action 保持兼容。面板支持角色专属 / 全局默认、背景透明度和完整聊天预览。

## 导入 / 分享流程

「进阶」旁的「预设」分类统一接受：版本化的整套 JSON、带 Sully 数据的分享 PNG、CSS/TXT 原文件、原气泡 JSON、提示音分享码和普通图片。分享 PNG 优先解析元数据，角色卡等其他类型明确提示到相应功能导入；损坏文件不降级为普通图片。

导入只暂存待确认内容，不修改角色。显示五项内容及应用范围，可以勾选部分内容；未勾选的部分保持原样。普通图片先选聊天背景 / 我的气泡贴图 / 角色气泡贴图，然后确认。应用过程中禁止切换范围和离开面板，防止异步应用目标变化。

当前整套装扮可保存到「我的预设」，或以 JSON / PNG 分享图导出。本地图片及 CSS 中的 Blob URL/令牌会内嵌；缺失素材导出报错，不能把无效令牌分享出去。HTTP(S) 外链保持原样，需要联网。输入/输出均限制 40 MB。预设列表位于资产键 `chat_decoration_presets_v1`，随已有资产备份机制保留。

## 数据边界

- 格式为 `sullyos-chat-decoration` version 1，`parts` 包含 layout、bubbles、background、sound、css。未知版本拒绝导入。
- 使用聊天视觉字段白名单，只导出当前有效的视觉设置，不包含角色人设、API、聊天内容或整机设置。气泡以新 ID 安装，不覆盖已有同 ID 主题。
- 全局布局继续写 OSTheme；角色整套布局存 `chatAppearance`（运行时只读取白名单），原有 `chatFineTune` 为可视化微调层。关闭角色布局开关会停用布局覆盖并保留数据。
- `theme.chatDefaultBubbleStyle` 与 `theme.chatBackground` 为全局默认；角色的 `bubbleStyle`、`chatBackground` 优先。角色背景 undefined 表示继承，空字符串表示明确无图片，避免“预设无背景”被接收方旧背景覆盖。
- 全套导出会将生效的全局 CSS 与角色 CSS 合成。导入到角色后设置 `chatDecorationCssIsolated`，防止接收方全局 CSS 再次混入；普通已有角色仍维持原叠加关系。还原角色 CSS 后恢复全局继承。
- CSS 与声音拆分保存。声音 null 在应用时转成 `{src:'none'}`（明确静音），而缺少 sound 是保留原声音。仅替换 CSS 时先保留当前声音；手动编辑 CSS 删除旧 `@sully-sound` 注释时也转存到独立声音字段。
- 解码和所有资源准备完成后，先保存新气泡，再一次更新目标角色/全局设置。保存错误会展示，不声称成功。旧主题不删除，避免破坏别的角色。可能尚未引用的新素材交由既有 GC 处理。

## 回归入口

- `utils/chatDecoration.test.ts`：白名单、有效快照、文件识别、分享 PNG、缺失素材、选择性应用、声音/CSS 保留、全局/角色隔离。
- `scripts/test-chat-decoration-consolidation.mjs`：两个入口的首次公告、确认后持久化、旧入口移除、搬迁控件与作用范围。
- `scripts/test-chat-decoration.mjs`：原装扮控件、声音绑定、背景、完整预览与真实 Chat 入口。
- `scripts/test-chat-decoration-presets.mjs`：导入确认、部分应用、取消、普通图片用途、导出再导入、预设重开、错误版本、真实角色落库与刷新。
- `test/fixtures/chat-decoration.html`：可交互展示；角色修改是页面临时状态，本地预设使用此测试来源的 IndexedDB。

外观 App 已移除「聊天界面」分类；原布局控件（含内置布局、在线状态、头像频率、表情包尺寸、输入栏）移入装扮「布局」，聊天设置的背景上传也移入「背景」。加号保留一个「聊天装扮」入口。

外观 App 和装扮面板首次进入各显示一次本轮公告，点击「知道了」或 Escape 后，分别存入本地 `sully-chat-decoration-announcement-v1:appearance/decoration`。不改动美化数据；存储不可写时仅在当前会话记住。

CSS 编辑器的旧预设及分享格式不迁移。CSS 分类保留 body portal 的 `#sully-safe-reset`，标注还原角色或全局；收起面板时也能还原。全局编辑在聊天装扮中切换「全局默认」；角色切换处的气泡快捷入口继续可用。
