# QQ捏人工坊（神经链接 · 手办柜）

## 3D 家园形象与用户手办柜

### 3D 发色与 Chibi 对齐（2026-10-11）

3D 头发使用 `creatorHairTint.ts`，逐字移植原捏人器的 18 个 `HUE_PALETTE` 候选色、自然色饱和度/明度偏移、线稿保护和渐变规则；候选色的展示 HEX 不等于实际染色参数，`hairTint` 保存原始参数，`hairColor` 继续保留兼容用的显示色。不要再复用眼睛专用的白色高光规则。

`CreatorRollBridge` 除已染色的展示层外，还捕获原尺寸、已翻转的 `*-raw`（固定原色素材为 `*-raw-fixed`）和独立 `*-shadow`。3D 换色从原始发片开始，沿用基础形象的 `preserveLineart`；不对已染色图二次染色，也不染投影层。和 Chibi 一样，固定原色素材不吃候选色，但明确自定义色可以重染。合成复用原捏人器的 1.5 倍高质量缩放再缩到 472px，避免边缘采样差异。恢复原色清除 3D 覆盖，回到基础形象的原搭配。

`appearanceDye.test.ts` 从原 HTML 提取函数，对所有候选色、灰阶、透明度、线稿阈值和渐变做精确像素回归；`test/fixtures/chibi-hair-dye.html` 对照真实发片的两条路径。房间光照仍照常影响最终 3D 显示。

角色手办柜增加「3D 家园形象」入口，保存在 `char.chibiStudio.home3D`（完整基础 state、预览 img、hair 3D 参数、updatedAt）；原三处一键同步保留此独立槽，不覆盖家园搭配。用户「个人档案 → 我的手办柜」管理自己的 Chibi 与 3D 形象：Chibi 沿用 `userProfile.vrState.chibi`，不会因捏人自动登录彼方；家园形象在 `userProfile.chibiStudio.home3D`。

`HomeFigureStudio` / `HomeFigureEditor` 复用基础捏人器和已有 `HairEditor`（脸、发、衣橱、体型、撤销/重做），已有基础形象可作为底稿，必须显式保存一份家园形象。取消不改正式形象；3D 参数不读写实验页全局草稿。角色和用户使用独立基础草稿键。基础合成图仅作展示柜缩略预览，3D 编辑器展示实时模型。

正式拜访通过 `Home3DSetupEntry` 执行：定义家园 → 双方家园形象 → 日程位置检查。`Home3DView` 优先读家园槽及其 hair；邀请居民也读取其独立外观参数。当前动作面板仍统一全场素体，切换素体仅临时预览，不覆写手办柜。完整备份递归保存这些数据；角色卡仍剥离整个 chibiStudio。

统一管理一只角色在三处的 Q 版形象：**小小窝**房间立绘、**彼方**chibi、**特别时光** 520 大头贴。每处可以单独捏（互不影响），也可以挑一处形象「同步到全部」。入口在 神经链接 → 角色详情 → **「手办」tab**（独立分区：迷你三格展示柜预览 `ChibiShelfPanel` + 「进入手办柜」按钮），全屏工坊 UI 走手办展示柜风（三层展台 + 射灯 + 底座）。

## 三处形象的落库位置（工坊不新增渲染路径）

| 槽位 | 消费方 | 图片存放 | 格式 |
|------|--------|----------|------|
| `room` | 小小窝 RoomApp（房间立绘） | `char.sprites['chibi']` | **blobref 令牌**（与上传路径一致，`putImageBlob`） |
| `vr` | 彼方 VRWorldApp | `char.vrState.chibi.img`（scale/offsetY/flip 保留不动） | dataURL |
| `like520` | 特别时光 520 活动 | 已通关：`char.specialMomentRecords['like520_2026'].customData.charChibi`；未通关：`char.chibiStudio.like520.img` 兜底 | dataURL |

> ⚠️ `char.sprites` 是混装袋：`chibi`（blobref 令牌）与见面情绪立绘同居一个对象。任何「从 sprites 里随便挑一张当立绘」的兜底都必须跳过 `chibi` 键和 blobref 值（不能直接当 `<img src>`），统一走 `utils/dateSprites.ts` 的 `pickDateFallbackSprite`——否则会复现「没传见面立绘的角色，捏完 Q 版后见面模式裂图」。

捏人器完整导出 state（选件 + 换色 + 翻转 + 眼型…）按槽位存 `char.chibiStudio.{room,vr,like520}.state`（`types.ts` 的 `ChibiStudioData`），再编辑时整套还原。`chibiStudio` 属运行时本地状态，已加入 `CARD_STRIPPED_FIELDS`（角色卡导出/导入双向剥离）。

## 关键文件

- `components/character/ChibiStudio.tsx` — 工坊本体（展示柜 + 单槽编辑 + 一键同步）。
- `apps/Character.tsx` — 入口按钮 + 全屏覆盖层。**注意**：详情页 `formData` 是整体 auto-save 的副本，工坊直接写库后，关闭回调里必须把最新角色数据 `setFormData` 拉回来，否则后续编辑会用旧副本盖掉工坊成果（新增外部写库的面板都要防这个）。
- `public/like520/character_creator.html` — 捏人器 iframe。`like520_init` 新增 `savedState` 字段：**草稿 > savedState > presets**（presets 只有 `selected`，savedState 连换色/翻转一起还原，见 `applyFullState`）。
- `components/Like520Event.tsx` — `CreatorIframe` 新增 `savedState` prop 透传；`isSullyChar`/`sullyPresets` 改为导出；520 活动 fresh 模式的角色捏人器会带上 `char.chibiStudio.like520.state`（工坊里捏好的造型开场直接穿上）。
- `apps/VRWorldApp.tsx` — 彼方两个 chibi 编辑器也改传 `savedState`（原来 presets 只回填选件，丢换色）。

## 安全区（iOS 顶/底约束）

全屏工坊浮层遵循项目单一来源（`index.html :root`）约定，见 `ChibiStudio.tsx` 顶部常量：

- 顶栏 `STUDIO_TOP = var(--chrome-top)`——安全区 + SullyOS 状态栏；状态栏隐藏（iOS 全屏 PWA 默认）时自动塌回 `--safe-top`。**不能只用 `--safe-top`**，否则状态栏显示时顶栏会怼进时钟/电量条。
- 底部 `--safe-bottom`（带 JS 探测兜底，iOS 全屏 PWA 原生 `env(safe-area-inset-bottom)` 偶发返回 0，别直接用它）+ 手势余量。展示柜滚动区 `STUDIO_BOTTOM`、同步弹层 `STUDIO_SHEET_BOTTOM`。

迷你预览 `ChibiShelfPanel` 渲染在角色详情 tab 内（非全屏浮层），安全区由神经链接（自理名单，见 `utils/safeAreaApps.ts`）统一处理，组件本身不再单独让位。

## 随「设置 → 导出」往返

`chibiStudio` 是 `CharacterProfile` 上的普通字段，随 `characters` store 走**整合导出（full）/ 纯文字（text_only）**。导出/导入的图片抽取（`extractImagesInPlace`）与还原（`restoreAssetsInPlace`）都是**全字段递归、无白名单**，所以：

- `chibiStudio.like520.img`（兜底大头贴 dataURL）、`vrState.chibi.img`、`specialMomentRecords…charChibi.dataUrl` 三处 dataURL 会被抽进 zip `assets/*`、导入时原样还原；
- `sprites.chibi`（blobref 令牌）原样进 JSON，二进制随 zip 的 `blobs/<id>` 旁路走、导入按原 id 写回（收集免名单，见 `utils/backupBlobs.ts`）；
- `chibiStudio.*.state`（选件 JSON，无图）随文字走，`text_only` 模式下图片被剥、但 state 仍在（可再编辑），与全局图片剥离行为一致。

**媒体与美化素材（media_only）**模式的角色只导出一份手挑的视觉子集（avatar/sprites/roomItems/backgrounds…），不含 `chibiStudio`/`vrState`/`specialMomentRecords`——与这些运行时字段既有的处理一致，官方也提示「别只导媒体包」。回归测试见 `utils/backupExport.test.ts`「角色的 chibiStudio / vrState.chibi / 520 记录里的图都会被递归抽取」。

角色**卡**分享（单角色导出）则会剥掉 `chibiStudio`（已在 `CARD_STRIPPED_FIELDS`），与 `vrState`/`specialMomentRecords` 同属运行时本地状态，不随卡外传。

## 草稿与 savedState 的关系

捏人器 iframe 用 `localStorage` 存未确认草稿（key 按 `draftKey` 隔离；工坊用 `studio_${charId}_${slot}`）。非空草稿优先于 savedState——用户上次捏一半退出，再进来先恢复 WIP；确认导出后草稿内容与已存 state 一致，行为无感。重置产生的空草稿不覆盖 savedState；清草稿时同时取消待写计时器，避免旧回调重新写入空草稿。传入 savedState 时显示「已保存形象」，可显式丢弃当前草稿，完整恢复选件、颜色与翻转；这一步不会确认导出或修改宿主正式形象。520 的用户形象编辑入口也要传递已有 `userChibi.state`。

家园捏人首屏直接展示 Chibi / 3D 体型，旁边说明家园内全员跟随房主体型。预览画布支持鼠标或单指水平拖动旋转，下方选项区域保留独立滚动；手机隐藏原生滚动条，桌面使用细滚动条。Sully 的家园入口沿用 `isSullyChar` 判断，向基础捏人器传递专属标识与初始预设，并在前发、耳发和两层后发分类分别提供 Sully 部件。

家园捏人前先选择底稿：角色可选小小窝、彼方、特别时光中有完整 state 的形象，用户可选自己的 Chibi；也可继续当前家园形象或从头捏。来源只在显式保存时写入家园槽，不修改原手办。每次选择使用独立草稿键，避免旧草稿覆盖刚选的底稿。Sully 眼睛入口使用原画 `eyes_99`；`face.useBaseEyes` 保留专属完整眼睛，嘴型仍可独立调整，选择通用眼睛部件后切回可拆分捏脸。

自绘素材也直接出现在家园 3D 编辑器：`CustomPartChoices` 将 `loadCreatorPartsForRender()` 读取的用户素材按类目放入头发、眼睛、嘴巴、面饰；面饰中的 `facemark` / `decor` 保留多选开关。选择后经原基础捏人器桥重新合成，保留换色、翻转等状态；重建期间禁用保存。`useBaseEyes` / `useBaseMouth` 分别保留完整原画五官，通用眼型或嘴型选择可以切回拆分素材。现有导入格式没有独立眉毛类目，整套眼睛里的眉毛随眼睛保留。

Sully 眼型仅在 Sully 自己的「脸部 → 眼睛 → 眼型款式」显示，用户形象及其他角色不提供专属五官。`face.eyeArtwork='sully'` 直接加载原画，随 3D 参数保存/撤销；选择 01—07 或自绘眼睛时清除该选项。

捏人界面图片优先：套装并入衣橱一级分类，使用所含服装的真实缩略图组合展示；内置发型、Sully 发型、自绘素材平级展示。眼型和嘴型的自绘款与内置款处于同一网格，不另设优先级按钮。图格统一选中勾，保留短名称和无障碍标签。发色/发片参数、配色、版型、叠穿默认折叠；移除 SECTION 标号及选项前重复说明。预览只保留图标工具，换装默认使用 12 号呼吸动作，不再显示动作菜单；眼部整体调整移回选项区。换基础部件保留当前分类，并与 3D 参数一起进入撤销/重做快照。

换装准备支持 AbortSignal：快速切换或卸载时取消旧任务，模型加载后及各服装/计算阶段让出浏览器主线程并检查取消；取消任务释放准备资源且不动正在显示的衣服。预览检测到单次动态叠穿处理超过 16ms 时暂停动作，保留旋转与换装，避免逐帧重算阻塞整个界面。可重新播放；切换衣服重新评估。回归见 `wardrobeSwap.test.ts`，重负载预览 `home-figure.html?sully=1&stress=1`。

2026-10-04 — 脸部→面饰按面纹/配饰展开素材网格，独立衣橱页补齐7款面纹与17款配饰，正式形象编辑器继续含本机自定义素材。支持多选/取下，每组高低、左右、大小、旋转与重置，数值保存在hair.layers.facemark/decor；面部图层合成时应用变换，身体配饰不随脸部整体偏移。独立页部件选择接入原CreatorRollBridge及撤销/重做，保存基础选件，调整跟随3D参数保存。

Sully 专属部件保存在 `public/like520/sully/`：`fronthair`、`earhair`、`back1`、`back2` 四层发型共用 `_99` 专属 ID，初始预设选中四层，编辑时逐层更换，不提供整套发型快捷项。`eyes-base.png` 与 `brows.png` 保留分层原图，按 472×472 原画布像素位置叠合为 `eyes.png`，供 Chibi 与 3D 专属眼型共同使用；合成时须按像素尺寸绘制，不能按 PNG 的 DPI 缩放。

3D 造型间的四个头发分类分别提供 Sully 部件，只显示当前分类的单层选中状态。3D 专属眼型使用 `eyes-base.png` 与独立 `brows.png`，原款眉毛保持原画位置，也可替换、取下或微调；改眉毛和表情不清除 Sully 眼型。继续编辑旧 `eyes_99/useBaseEyes` 形象时在编辑副本中转为分层渲染，显式保存后才写回；Chibi 的完整 `eyes.png` 保留。专属选项只对 Sully 开放。像素验收页：`test/fixtures/sully-face-layers.html`。

2026-10-07 — 家园形象来源页改为「基于哪个形象 3D 化？」；已有形象和从头创建都直接进入 3D，默认底稿由 homeFigureSeed 确定，不读取别人的草稿。编辑历史固定在分类栏下方，衣服、版型、颜色及基础部件共同撤回/重做。回到正面同时重置旋转、缩放和位移。肤色存 hair.skinColor、统一发色存 hair.hairColor，眼色保留分层/完整眼型并通过 face.baseIrisColor 显式染色；不设置颜色时保留旧图。原图不修改，正式小屋与捏人使用同一渲染入口。套装与我的衣柜以正式服装、保存版型和分区配色生成整套素体穿着图，仅可见项排队渲染，支持取消并缓存结果。

3D 造型间复用居家桌面的 homelyPaletteStyle，由 HomeFigureStudio 传入当前 homelyPalette；独立入口默认奶油杏橙。分类使用图标导航、纸感圆角面板，视角、撤回/重做、保存和细调分区保持原行为。样式集中在 experiments/chibi/figure-theme.css，遵循减弱动态效果设置。

拉杆预览由 `useFigurePreview` 合并更新：头发、体型、衣服等昂贵几何修改在手势期间仅更新控件值，松手后应用最后一次值；五官纹理保留 80ms 合并预览。预览参数和素材列表保持稳定引用，避免滑块每次变化都重绘五官。拖动等待更新时暂歇动作；窗口收到 pointerup / pointercancel / blur 也结束手势，避免手机取消触控后卡在调整状态。粗指针设备拉杆触控高度至少 44px。

头发、五官、面饰、体型与衣服统一使用 `FigureSlider`：右侧数值可直接输入，输入草稿只存在控件内，回车/失焦才应用一次；Esc 取消，空值/无效值保持原值，有限数值按步长与范围限制。不变的值不生成历史。外部撤回/重置同步输入框。`Puppet` 使用 memo 配合稳定参数，拖动控件时不重复执行未变化的预览组件。

手机局域网 HTTP 预览不提供 `crypto.randomUUID()`；形象来源草稿、添加发片和衣柜搭配使用 `createLocalId` 生成本地记录编号，兼容 `getRandomValues`，不依赖安全上下文。真实来源页与懒加载编辑器可用 `test/fixtures/home-figure.html?source=1` 验收，保存只更新页面内存，不改用户档案。

头发支持纯色/渐变：3D 使用 `hair.hairColor`（发根）和可选 `hair.hairTipColor`（发梢）；旧捏人器在对应 `tintColor` 保存 `color` / `gradientColor`，继承前发联动规则，随草稿和完整 state 还原。由旧形象进入 3D 时，渐变保留在桥接发片图中；3D 显式调色再覆盖。渐变沿原画布高度从 10% 到 70% 插值，各发层位置一致，保留透明度、线稿和明暗，追加发片不重复染色。旧捏人器肤色自定义按原图平均明度保留阴影；3D 肤色仍保存在 `hair.skinColor`。两套界面均支持色盘和 HEX，原色可恢复。回归：`appearanceDye.test.ts`。

自定义颜色使用内置 HSV 色环，不再依赖手机系统的原生颜色弹窗：圆周选色相、向中心减饱和度，下方明暗条调深浅，HEX 保留。3D 由 `ColorWheel` 渲染，旧捏人器内联同样交互（确保隔离 iframe 的素材桥也可使用）。色环拖动只更新本地选色预览，松手才提交角色颜色；捕获指针，取消/卸载结束调整。手机展开自动滚入视野，明暗条保留 44px 触控区。回归：`colorWheel.test.ts`、`colorWheelUI.test.ts`。

2026-10-07 — 备份审计补齐 3D 家园显示偏好、拍照滤镜收藏及 DB 备用导出路径的完整用户档案。整机整合导出保留双方 home3D 槽、自绘部件及 Blob 原始图；纯文字仍只保留参数，换设备携带自绘素材必须使用整合导出。小屋内整屋备份仅带房屋、日常和宠物；恢复同步替换运行态日常/宠物，撤销重做可恢复前后存档，普通装修撤销不倒退生活。

原 Chibi / PSD 自绘前发、耳发、后发、眼睛、嘴、面纹和配饰沿用原 categoryKey、部件 ID、染色及翻转，通过同一个 CreatorRollBridge 进入 3D。体型页提供自绘肤色底稿（使用原图平均肤色，不改变素体拓扑），Chibi 衣橱直接列出自绘服装/外套。2D 服装贴图用于 Chibi，不能当成可蒙皮的 3D 衣服模型。

3D 镜像沿用基础 state.flipped：四层头发按类目保存，面纹/配饰按单件 ID 保存，3D 内可以切换、撤回和重做。CreatorRollBridge 把 2D 图层及子部件 CSS 翻转真实绘入贴图，避免仅在 2D 看起来翻转。额外发片独立保存 mirrored，不改变源发层。

异色瞳以画面左/右为准，继承 2D 的两侧颜色及镜像后的顺序；3D 的独立颜色保存为 face.irisColors，face.heterochromia 控制同色/异色入口。基础眼型未改色的侧保留原合成图，显式改色从 eyes-raw 原图染色，避免对已染色图反复染色；分层眼型、Sully 原画与正式小屋使用同一分侧染色规则。切换分层眼型保留已有双侧颜色。内存验收入口 home-figure.html?mirror=1，覆盖头发与单件面纹镜像、异色、撤回、保存后重新编辑。

3D 眼睛候选色与 Chibi 共用 18 色及饱和度/明度规则。`face.irisTint` / `face.irisTints` 保存原始预设参数，HEX 字段保留兼容；不能把高明度预设先压成 HEX 再还原。桥接保留原尺寸 `eyes-raw` 和镜像后的双侧参数，基础眼型先从原图染色，再按 Chibi 的 1.5 倍采样输出，未改的一侧继续使用底稿。分层脸沿用底稿线稿阈值并保留睫毛遮罩。旧 HEX 存档按原值重绘，无须重捏；没有 3D 改色的底稿保持原合成图，已导出图片和保存的底稿缩略图不被批量改写。回归：`chibiFaceTint.test.ts`、`homeFigureEyeControls.test.ts`；浏览器对照 `test/fixtures/chibi-eye-dye.html`。
