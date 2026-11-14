# ChatApp 装扮与整套预设

聊天「聊天装扮」打开与外观 App 共用的 `BeautyShareChannel` 装扮库。`ChatAppearanceWardrobe` 默认选中入口角色，只展示聊天收藏；可以切换「当前角色」，确认时也可主动勾选应用到全部角色。领取码统一识别桌面与聊天预设。角色装扮应用后留在装扮库，不切换 activeCharacterId、不重新打开聊天。

右上角「我」打开 `DecorationDraftEditor` 的「我的搭配」：展示当前角色有效搭配、各分类缩略图和布局浮窗，只选择预设组合，不显示 CSS 编辑器。应用前确认角色范围。每个分类各有制作器，气泡制作器内嵌原气泡工坊；白框、头像框、背景和心象仅编辑对应范围 CSS，提示音使用音频配置。头像框与背景 CSS 使用独立标记段，应用时合并而不清除已有白框。自制作品可更新原件，导入作品另存副本。来源采用最严格的二改和传播限制，禁止二改时锁定编辑。

「用码领取」只领取；「分享装扮」提供文件分享、图片分享、码分享。文件按原 JSON/ZIP 导出，图片沿用嵌入可导入数据的 PNG 分享卡，码分享进入私有投稿与我的提交。PNG 聊天装扮导入保留包内署名和权限。预览内容下拉框旁提供上一条/下一条。

`decorationLibrary.ts` 管理来源与编辑权限：分享码元数据优先；导入文件始终标为导入，禁止二改时同时禁用详情编辑与当前角色装扮编辑入口。来源不明的历史预设标为旧版预设，不猜测作者身份。旧白框 CSS 收藏和自定义气泡也在库中展示。来源侧记保存在 `decoration_origin_*`，角色应用记录在 `decoration_applied_*`；权限是客户端的使用规范，不是文件 DRM。

旧气泡收藏可能仍用 `blobref:` 存放本机图片，装扮库通过 `readBubbleDecoration` 先解析素材再校验可分享格式。读取失败要显示实际错误，不能永远显示「正在读取来源」；列表与详情的删除入口不依赖预览或来源读取成功，仍经过本机删除确认。来源未读出时不开放编辑或分享；不按同名自动合并或删除旧收藏。

白框制作器保持旧 `ChromeCssEditor` 的兼容边界：通用类名、页面变量及旧选择器不作为保存失败的理由，不自动改写作者 CSS；仍检查语法和装扮文件格式。稳定 `.sully-*` 钩子是新作品提示词的推荐约定，气泡、心象等单项制作器继续限制各自范围。错误只显示前三条及总数，避免整屏重复红字。CSS 校验解析时区分注释、字符串、函数参数逗号和动画步骤。

制作器输入即时更新草稿，预览在停笔 300 ms 后更新；保存和应用始终读取最新草稿，不等预览。缩略图仅在接近可视区域时构建，按帧串行处理并取消离屏任务；同一份预览数据通过 memo 避免无关状态变化引发重绘。独立预览的心象、转账和加号交互仍即时响应。

头像框上传保留原图、透明度和动画；上传完成后可用滑杆调整左右、上下、缩放和旋转。图片原始 Blob 存入 IndexedDB `blob_assets`，草稿、预设库与角色/全局 `chromeCustomCss` 的 `url(...)` 中只保留 `blobref:` 短引用。旧 CSS 内嵌图片在保存或应用时迁移；旧代码输入框仍折叠长图片。聊天、群聊和装扮缩略图显示时解析为临时 object URL，切换或卸载后回收；不持久化 object URL。复制完整 CSS、单文件导出和码分享才内嵌图片，缺图时报错。完整备份沿用 Blob 旁路，GC 扫描 CSS 中的引用，删除预设不直接删除共享图片。预览场景识别复用 `cssRuleSelectors` 单次扫描，避免大图 base64 触发正则反复回溯。

「我的搭配 → 当前使用的心象」提供「编辑并另存当前心象」，直接读取当前角色有效的旧版 `thinkingChainCustomCss`、风格及颜色，不要求它已在预设库。另存只保存心象部件，应用搭配前不改角色；仍遵守来源的二改权限。

自由组合主预览使用 `sceneScope="all"`，提供完整聊天记录、表情包、图片以及全部卡片场景，未定制的部分按默认样式展示。收藏详情和选择预设的缩略图继续按预设内容筛选；增加预览场景不扩大 AI 提示词的默认生成范围。

批量展示与独立预览分开：白框/整套缩略图保留完整聊天；气泡仅展示双方对话气泡，背景仅展示壁纸，心象仅展示卡片。分类选择器明确指定缩略图部件，收藏列表对单一部件自动识别，混合作品保留整套。独立详情及自由组合主预览仍显示聊天顶栏、情绪栏和输入栏。所有样例均为虚构静态渲染。

独立预览支持本机交互演示：点击心象展开/折叠，点击转账卡查看详情、接收/退回并生成虚构回执，点击聊天加号展开/收起真实菜单及翻页。使用 `decorationPreviewInteraction.ts` 的内存状态重新静态渲染，不挂载真实聊天副作用，不写 DB、不发消息、不调用支付、音频或其他 App。非演示菜单操作保持不可用，缩略图仍不可交互。切换场景或点击「重置演示」清空演示状态；导出只截取当前外观，不把演示状态写入预设。

聊天库顶部由导航栏统一消费安全区，外层不重复留白；详情与草稿编辑器使用 visual viewport 高度及上下安全区，输入文字至少 16px，避免 iOS 聚焦缩放。

聊天「＋」→「聊天装扮」统一布局、气泡、背景、声音和进阶 CSS（原白框）。旧 `chrome-css`、`fine-tune`、`chrome-sound` action 保持兼容。面板支持角色专属 / 全局默认、背景透明度和完整聊天预览。

## 导入 / 分享流程

「进阶」旁的「预设」分类统一接受：版本化的整套 JSON、带 Sully 数据的分享 PNG、CSS/TXT 原文件、原气泡 JSON、提示音分享码和普通图片。分享 PNG 优先解析元数据，角色卡等其他类型明确提示到相应功能导入；损坏文件不降级为普通图片。

导入只暂存待确认内容，不修改角色。显示六项内容及应用范围，可以勾选部分内容；未勾选的部分保持原样。普通图片先选聊天背景 / 我的气泡贴图 / 角色气泡贴图，然后确认。应用过程中禁止切换范围和离开面板，防止异步应用目标变化。

当前整套装扮可保存到「我的预设」，或以 JSON / PNG 分享图导出。本地图片及 CSS 中的 Blob URL/令牌会内嵌；缺失素材导出报错，不能把无效令牌分享出去。HTTP(S) 外链保持原样，需要联网。输入/输出均限制 40 MB。预设列表位于资产键 `chat_decoration_presets_v1`，随已有资产备份机制保留。

## 数据边界

- 格式为 `sullyos-chat-decoration` version 1，聊天 `parts` 包含 layout、bubbles、background、sound、css、psyche。见面界面／剧情界面使用独立的 date / story 部分，不与聊天部件混装；二者位于提示音后的独立分类，不进入「我的搭配」。未知版本拒绝导入。
- 使用聊天视觉字段白名单，只导出当前有效的视觉设置，不包含角色人设、API、聊天内容或整机设置。气泡以新 ID 安装，不覆盖已有同 ID 主题。
- 全局布局继续写 OSTheme；角色整套布局存 `chatAppearance`（运行时只读取白名单），原有 `chatFineTune` 为可视化微调层。关闭角色布局开关会停用布局覆盖并保留数据。
- `theme.chatDefaultBubbleStyle` 与 `theme.chatBackground` 为全局默认；角色的 `bubbleStyle`、`chatBackground` 优先。角色背景 undefined 表示继承，空字符串表示明确无图片，避免“预设无背景”被接收方旧背景覆盖。
- 全套导出会将生效的全局 CSS 与角色 CSS 合成。导入到角色后设置 `chatDecorationCssIsolated`，防止接收方全局 CSS 再次混入；普通已有角色仍维持原叠加关系。还原角色 CSS 后恢复全局继承。
- CSS 与声音拆分保存。声音 null 在应用时转成 `{src:'none'}`（明确静音），而缺少 sound 是保留原声音。仅替换 CSS 时先保留当前声音；手动编辑 CSS 删除旧 `@sully-sound` 注释时也转存到独立声音字段。
- 解码和所有资源准备完成后，先保存新气泡，再一次更新目标角色/全局设置。保存错误会展示，不声称成功。旧主题不删除，避免破坏别的角色。可能尚未引用的新素材交由既有 GC 处理。
- 装扮库应用同一作品到多个角色时，共用同一个气泡 ID；重复应用会按完整气泡内容和来源权限复用已有记录，不按名称或导入文件中的 ID 合并。气泡单项仍保留角色已有头像框，确实不同的头像框组合才单独准备一份；不影响未选择的角色设置，不自动删除历史重复收藏。准备失败不更新任何角色，全部所需气泡保存后再应用角色补丁。

## 回归入口

- `utils/chatDecoration.test.ts`：白名单、有效快照、文件识别、分享 PNG、缺失素材、选择性应用、声音/CSS 保留、全局/角色隔离。
- `scripts/test-chat-decoration-consolidation.mjs`：两个入口的首次公告、确认后持久化、旧入口移除、搬迁控件与作用范围。
- `scripts/test-chat-decoration.mjs`：原装扮控件、声音绑定、背景、完整预览与真实 Chat 入口。
- `scripts/test-chat-decoration-presets.mjs`：导入确认、部分应用、取消、普通图片用途、导出再导入、预设重开、错误版本、真实角色落库与刷新。
- `test/fixtures/chat-decoration.html`：可交互展示；角色修改是页面临时状态，本地预设使用此测试来源的 IndexedDB。

外观 App 已移除「聊天界面」分类；原布局控件（含内置布局、在线状态、头像频率、表情包尺寸、输入栏）移入装扮「布局」，聊天设置的背景上传也移入「背景」。加号保留一个「聊天装扮」入口。

外观 App 和 ChatApp 首次进入各显示一次本轮公告（无需先找到装扮入口），点击「知道了」或 Escape 后，分别存入本地 `sully-chat-decoration-announcement-v1:appearance/chat`。不改动美化数据；存储不可写时仅在当前会话记住。

CSS 编辑器的旧预设及分享格式不迁移。CSS 分类保留 body portal 的 `#sully-safe-reset`，标注还原角色或全局；收起面板时也能还原。全局编辑在聊天装扮中切换「全局默认」；角色切换处的气泡快捷入口继续可用。

## 转账和头像框 CSS

协同「白框制作」的稳定选择器清单与 CSS 编辑器的复制提示词必须同步维护。`features/collaboration/makers.ts` 已收录下述转账和头像框选择器，制作提示词和作品校验使用同一清单，避免模型误判这些类名未开放。

进阶 CSS 的复制提示词包含 `.sully-chat-transfer-*`：主卡 `card`、回执 `receipt`、金额 `amount`、备注 `note`、状态 `status`、收款方 `recipient`、标题 `header`、图标 `icon`、品牌 `brand`、水印 `watermark`，以及详情弹窗 `overlay` / `dialog`、操作按钮 `accept` / `return`。主卡和回执带 `data-status`，用于区分 pending / accepted / returned（回执没有 pending）。

消息头像通用容器 `.sully-chat-avatar-wrap` 仅在该头像可见时提供，含普通消息头像及组首头像。用它的 `::after` 配合透明背景图绘制外框，设置 `pointer-events:none`；容器保持 overflow:visible，图片形状单独通过 `.sully-chat-message-avatar-img` 的圆角或 clip-path 控制。气泡工坊已有框图是 `.sully-chat-avatar-frame`，可按需隐藏以避免叠加。以上 CSS 随原有 CSS 预设保存、分享和切换，不要求额外配置气泡贴图。

已确认过旧版 `v1:decoration` 公告的用户不会重复弹出。装扮面板本身不再挂公告。聊天加号功能按单一顺序列表每页 8 项自动分页，第二页补入相册；各页固定两行，避免第三页内容少导致面板和翻页圆点跳动。

## 白框统一契约（2026-09）

「全部聊天」是收藏的汇总筛选，不是一种独立美化格式。复制提示词和协同提示词始终提供完整接口说明（包括 App 卡片、文件、日程和子类型），并保留布局与设计指导；接口参考不是必须全部输出的清单。实际输出默认保留原有聊天外壳、输入与头像结构，内容只要求普通聊天、语音条、转账、心象。各 App 卡片仅在用户明确点名时设计，未点名保留原样；局部作品只设计对应部分。

- `utils/chatWhitebox.ts`：固定选择器分组、卡片种类、CSS 作用域和完整设计要求的唯一来源。白框编辑器复制给 AI 的提示词与协同工作白框制作共用；协同验证器同样接受 `.sully-psyche*`。
- `components/chat/ChatCardSurface.tsx`：私聊/群聊共用的卡片边界。外层 `.sully-chat-card`，包含 `.sully-chat-card-surface` 和 `.sully-chat-card-content`。`data-card-kind` 对应 MessageType，`data-card-variant` 标识结算/日记等子类型，`data-role` 区分 user/assistant/system。旧卡片业务组件、操作回调和元数据继续保留，未写新 CSS 时保留原样。
- `utils/psycheAppearance.ts`：心象样式目录、解析和外观字段白名单。旧 `thinkingChainStyle/CustomColors/CustomCss` 继续读取；全局默认是 `OSTheme.chatPsyche`。角色设置优先于全局。心象设置只保留显示开关和追加提示词，内置风格位于个性装扮「心象」，自定义颜色/CSS 在聊天装扮「心象」。
- 导出格式仍是 `sullyos-chat-decoration` v1，新增可选 `parts.psyche={styleId,customColors?,customCss?}`。旧文件没有这个字段则不改变现有心象；整套导出包含它；显示开关、追加提示词、角色资料和聊天记录绝不导出。领取并应用心象外观不会开启模型推理。
- 样式顺序：布局基础 → 心象外观 CSS → 全局白框 → 角色白框 → 气泡 CSS → 关键操作保护。已有气泡 CSS 的覆盖顺序不变，白框现在可以明确覆盖旧心象 CSS。

### 预览与验收

`utils/chatPreviewFixtures.ts` 维护纯虚构的消息样例，类型表覆盖全部 MessageType，供开发回归使用。用户菜单由 `utils/decorationPreviewScenes.ts` 按预设 parts 和 CSS 明确指向的选择器筛选：心象只有折叠/展开，气泡显示普通聊天与语音，整套白框显示四类基础内容。App 卡片只有明确的 data-card-kind（及可选 data-card-variant）或专用选择器才出现。菜单不提供全类型记录，CSS 注释和声明值不作为内容声明。

`ChatDecorationSample.tsx` 通过 React 静态渲染复用真实 MessageItem，不挂载副作用或事件处理，不读取聊天 DB，不发送消息、不生成语音、不执行支付和跳转。`BeautyPresetPreview` 将样例与作者 CSS 放入 Shadow DOM；个性装扮、白框编辑器和协同作品预览共用。缩略图只渲染首个相关场景，切换作品时不可沿用不受支持的场景。心象外观目录从 MessageItem 提取，避免再复制预设颜色。

基础工具类单独编译为 `components/chat/chatPreview.generated.css`，不依赖浏览器 CDN Tailwind 是否扫描过某条真实消息，也不复制当前角色的自定义 CSS。命令 `pnpm build:chat-preview`；`pnpm dev` 和 `pnpm build` 自动先生成。新增布局类后需重新生成，不手改生成文件。

HTML 卡片仍在独立 iframe 沙盒中；白框控制其外壳和排版，不越过沙盒修改 HTML 内容。预览头部/输入栏是有同名钩子的示例外壳，卡片内容复用真实渲染器。

### 作者的写法

从 `.sully-chat-root` 定义配色，检查顶栏、输入栏、消息首尾/双方、心象折叠/展开、语音和转账各状态。不要依赖 Tailwind 类名或子元素序号。仅当用户明确需要 App 卡片样式时，使用对应类型的选择器；以下外壳变量也应限定在指定卡片上：

```css
.sully-chat-card[data-card-kind="world_card"] {
  --sully-card-background: #fffaf2;
  --sully-card-border: 1px solid #e6d9c8;
  --sully-card-radius: 18px;
  --sully-card-shadow: 0 4px 14px #4e382012;
}
.sully-chat-card[data-card-kind="world_card"] .sully-chat-card-content {
  font-size: 13px;
  line-height: 1.7;
}
.sully-psyche-card { border-radius: 18px !important; }
```

外壳变量不强制抹除各卡片原有的内部背景；需要重画内容区时使用 `.sully-chat-card-content` 的后代选择器并覆盖相应内联样式。不要隐藏转账金额、状态、接收/退回、文件打开或返回/发送按钮。图片和表情保持比例，长文字能换行，避免持续模糊动画。

回归：`pnpm vitest run utils/chatWhitebox.test.ts utils/chatDecoration.test.ts utils/collaborationMakers.test.ts utils/beautyShare.test.ts`；另做手机宽度下的心象、转账、长卡片、滚动和旧预设验证。

内置白框新增「星轨 · 深空」「星轨 · 雾紫」，在聊天装扮的全部/白框分类和「我的搭配」选择器中展示。入口通过 `utils/builtinWhitebox.ts` 读取 `presets/chat/*.json`，只使用本地静态素材，不写入收藏库或替换用户已有设置；应用沿用角色选择确认流程。两款源文件与构建脚本在 `art/acid-orbit`：依次执行 `build-lace.mjs`、`build.mjs`、`build-builtins.mjs`、`build-preview.mjs` 可同步 CSS、导入文件和内置包。蕾丝为用户提供的 CC0 scallop2（来源见 `art/acid-orbit/SCALLOP-LICENSE.txt`）。

### 舞台隔离与深浅色对比度边界

- `.sully-chat-root` 仅包裹聊天舞台本身（顶栏、消息流、底部输入区／加号与表情面板，以及舞台内直出的转账详情弹层 `.sully-chat-transfer-overlay` / `.sully-chat-transfer-dialog`、日程变更卡 `.sully-schedule-change`）。设置弹窗（如心象设置）、装扮工坊与自由搭配面板、小程序（瑞幸／麦当劳）、全屏语音／图片预览、消息内展开的全屏转发／520 信纸弹层及全局确认弹窗均挂载或 Portal 到 `.sully-chat-root` 之外，独立聊天页外层带 `text-slate-900`（家园小手机 `homePhone` 模式除外，保留小手机自身配色与 `.home-phone .fixed` 高度约束），使深色白框的文字配色仅作用于聊天舞台，不向通用弹窗或表单继承。
- Tailwind Preflight 为 `input`、`textarea`、`select` 设置 `color: inherit`：浅色背景上的输入框与下拉框需要显式声明文字色与占位符色（如 `text-slate-800 placeholder:text-slate-400`；聊天默认浅色输入栏将 `text-slate-800` 放在 `.sully-chat-inputbar` 外壳上，兼顾防顶层白字继承与白框对输入栏的继承覆盖），深色底上的原生 `<select>` 与 `<input type="date">`／`<input type="time">` 声明 `[color-scheme:dark]` 并用 `[&_option]` 覆盖含 `<optgroup>` 在内的选项配色，避免 Windows / Chromium 原生弹出列表出现白底浅字。
- 内置白框的通用面板／卡片覆盖使用零权重的 `:not(:where(...))` 排除语义功能元素，避免抬高选择器权重压过后续状态规则：颜色色板点（`.sully-chat-swatch-dot`）、未读或状态角标点（`.sully-chat-badge-dot`）、分页指示点（`.sully-chat-page-dot`）、可扫描二维码白底区（`.sully-chat-qr-surface`）、进度条填充（`.sully-chat-meter-fill`），以及自带独立视觉设计的七夕活动卡（`[data-card-variant="qixi_event_card"]`）与 520 典藏卡（`[data-card-variant="like520_card"]`）。回归守卫见 `utils/__tests__/themeContrastInheritance.test.ts`。
