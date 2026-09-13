# 彼方 / SAR 开发交接

当前实现核对：2026-09-11。开发分支：`codex/dino-cafe-art`。

SAR 活动室使用用户提供的原画（`assets/sar-club-room.png`），按原比例显示；恐龙箱庭在自己的设施页面按需加载 Three.js。两人的个人线、情绪立绘、特殊演出、真实赠品与名册回放已经接入正式入口。

| 文档 | 内容 |
| --- | --- |
| [SAR 活动室怎么玩](../../docs/sar-user-guide.md) | 用户入口、完整流程、模型调用次数与存档 |
| [个人线](../../docs/sar-personal-lines.md) / [凯恩原稿核对](../../docs/sar-familiarity-caian-content.md) | 每日话题、星级事件、演出、奖励、回忆与内容来源 |
| [数值规划](../../docs/sar-economy.md) | 钱包、抽取、模块、折扣和系统回收 |
| [叙事与世界意志](../../docs/sar-narrative-principles.md) | 生成式推演的叙事边界，与固定个人线的区别 |
| [水域与布告板](./FISHING.md) | 钓鱼、交易、行情、图鉴与事实回执 |
| [恐龙箱庭](./DINOSAUR-GARDEN.md) / [SAR 美术](./SAR-ART.md) | 模型、摆放、来访、立绘与手游式界面 |

这份文档用于在另一台电脑上继续开发当前的彼方大更新。当前结构：**SAR 是与「世界」并列的一级入口，点击后进入独立全屏活动室**，收起公共顶栏和世界翻页；左上角返回彼方，右上角提供隐藏标记、设置与仓库。凯恩与艾文是可关闭的固定 NPC；人格推演、陈列柜、模块商店都属于这片空间的设施。

## 换电脑继续开发

首次拉取这个分支：

```bash
git fetch origin
git switch -c codex/dino-cafe-art --track origin/codex/dino-cafe-art
pnpm install --frozen-lockfile
pnpm dev
```

如果本地已经有同名分支：

```bash
git switch codex/dino-cafe-art
git pull --ff-only
pnpm install --frozen-lockfile
pnpm dev
```

默认打开 Vite 输出的本地地址。API、角色和历史数据仍在浏览器本地存储中；Git 分支只同步代码，不会同步这台电脑里的角色或测试档案。需要复现原数据时，用 SullyOS 的完整导出/导入。

## 当前已经完成

### 1. SAR 空间与 NPC 开场

- 首次进入会显示“更新－彼方活动室”，再让用户选择“我很欢迎 / 我不想要 NPC”。
- NPC 开关只控制凯恩、艾文及固定对白，不影响设施。
- 右上角隐藏按钮循环四档：只隐藏名字/称号、全房间文字、全部角色小人（恢复设施标记）、全部恢复；独立于 NPC 偏好，旧隐藏状态兼容映射全文字档。
- 自家角色须当前房间为 SAR 且有具体 `sarActivity` 才进入 SAR 站位与在场名单；仅接入彼方或只残留 SAR 房间字段不算。下一次活动去其它房间后不再显示；用户自己仍按主动进入的房间显示。
- 凯恩初见是写死的 Galgame 分支，不调用 LLM；结束后移除感叹号。
- “初见回档”只重置凯恩初见，不重置更新公告与 NPC 偏好。
- 历史备份恢复后，SAR 首次触发状态跟随导入数据，不沿用导入前设备状态。
- 凯恩初见结束后及艾文入口进入各自个人线。每位 NPC 每个本地自然日固定一次随机结果：80% 有未完成话题、20% 日常问候；当前星级十个普通话题完成后，直接开放星级事件。只有事件完整结束才升星，五颗星目前实现到三星。
- 默认单人居中；另一位 NPC 实际发言后保持当前段落同框，跨节点查看后续六句是否仍有对方台词，避免短暂进出。提及名字不触发首次出场；留场状态随游标保存，续看和回放遵循同一规则。日常台词点击气泡逐句阅读，居中选项浮层不挤压立绘。
- 17 张用户原画表情已作为本地 WebP 随包提供（凯恩 11 张、艾文 6 张），失败才回落原 CDN。凯恩新增 `Enduring Pain`（忍痛）、`avoidant`（回避）、`normal2`（平常2）、`warm`（温柔），已同步用户更新的透明背景原图，供手动表情校对，已应用用户校对的表情编排。证件、会议、合照、礼炮、券雨、物品堆、神秘按钮和专属混合恐龙由程序演出，不调用模型。
- 「仓库 → 图鉴 → 名册」保留两人完整简介、星级和已完成回忆；名册属于用户，不随仓库主人切换。回放不推进进度、不重复领物品或优惠，不发送第二次私聊彩蛋。

### 2. 异世界人格推演

- 两个独立卡池：`人格异格` 与 `异界坐标`，每池每天免费一次。
- 常驻 NPC 开关同时控制称号显示/编辑、名册、专属纪念和 NPC 专属图鉴条目；关闭时暂停个人线与待投递彩蛋，聊天/活动不注入 NPC 背景或称号元数据，异步活动不能写回称号。普通设施保留，售鱼改为中性回收站，重新开启恢复保存的进度。统一门禁在 `sarNpcPreference.ts`，设置变动通过同页事件和跨页 storage 事件同步。
- 铸造时选择角色，再组合两枚芯片；LLM 生成角色异格身份、钢印、代价、User 身份面具、异世界坐标和可直接参与的开场。
- 现实记忆不整包搬入异世界，只读取双方“关系门牌”；具体聊天和近期现实事件不进入推演。
- 正式演绎最多 50 次成功互动；世界意志跟随用户当下关注，事件可被忽略，日常与关系互动有效，旁白允许为空。一次调用同时生成演出与私有连续性事实，后者随消息保存且不进入正文或导出。末段收束实际经历，不强迫完成主线。见 [叙事运行原则](../../docs/sar-narrative-principles.md)。
- 封存档案可重复阅读、下载，并可把返航简报分享给原角色聊天。
- 陈列柜按角色整理 User 的身份卡与旅程；“看看角色的柜子”展示角色自由活动时自己抽芯片、给其他人使用后写下的事故随笔。

### 3. 模块商店与装载

- 固定模块目录目前 46 件；每日随机上架 5 件，每天可手动刷新 3 次。
- 用户模块按目录价及实际优惠扣鳞币；个人线可给 30 分钟八折和九折券，取最优单项，不叠加。扭蛋两池每日各免费一次，其后每次 90 鳞币。余额与水域、布告板共用，原库存保留；无限抽取与免费购买只属于早期试玩行为。
- 购买只发生在 SAR 柜台；使用从角色本身发起：在彼方任意房间点击任意小人，都可以“抓住 TA · 使用模块”。
- 对角色使用持续 10 次成功 LLM 互动；对 User 使用持续 5 次。
- 结束后保留 3 次稳定提示：第 1 次明确察觉模块解除，后 2 次防止模型继续沿用污染语气。
- 角色对 User 使用模块默认关闭，需 User 主动开启“允许角色对我使用模块”。
- 失败、取消和重掷不会扣模块寿命；新回复成功落库才扣一次。
- `关键词消音器` 与 `禁止说名字` 在装载确认页填写短字面值；配置随本次运行时保存，不作为第二份自由 prompt。
- 模块货架、库存和购买记录已进入 SAR 完整备份；换设备导入后可恢复。

### 4. Chat / Date 真意与外显隔离

核心约束：**模块只能改变当时被看见、被听见的表达，不能改写真实意图、事实、行动、关系和长期人格。**

```text
角色/User 当前模块状态
        ↓
ContextBuilder 高优先级模块段
        ↓
一次 LLM：CHAR_TRUE + CHAR_SURFACE + USER_SURFACE
        ↓
Message.content              metadata.sarModuleSurface.surface
真实/规范语义                临时界面外显
        ↓                              ↓
事实/意图判断基准              Chat / Date 显示与 TTS
        └──────────┬───────────────────┘
                   ↓
上下文、总结、记忆宫殿：同时知道真意与当时外显，外显只作历史引文
```

- Chat 使用明确的「污染台词 / 原台词」文字切换，不覆盖用户自定义气泡样式。
- Date 的阅读和立绘模式各自提供「污染台词 / 原台词」切换，按整批进度匹配重复短句，并兼容旧的原文续接快照。
- 纯括号动作/旁白气泡不附加污染文本，也不消耗下一句外显序号。
- 两侧拆泡前共用历史标签/表情预处理：`[你 发送了表情包: …]`、分类展示、单括号、全角冒号与大小写变体统一识别。表情只从真意发出，外显的表情不占台词序号，原位后续台词与末句都保留。
- 外显不执行控制命令；HTML 与历史格式分享卡片使用和真意相同的纯提取器排除，内联控制标签仅剥除。HTML 关闭后留下的占位泡也不占外显台词序号。新增回归通过真实后处理落库和 MessageItem 真言切换验证，不改写已有错位历史记录。
- 内置翻译把一整组 `<原文>/<译文>` 当成一个气泡；原文和译文保持同一份污染含义。
- `日文（中文翻译）`、`English (中文翻译)` 等角色自定义同泡格式会整体保留，不把括号翻译误判为动作。
- `<语音>` 与 `<字幕>` 是一个原子气泡；TTS 朗读外显版，数据库仍保存真意。切换真言只改变文字查看，已经生成的音频保留当时实际说出口的版本。
- 总结与记忆格式化只读取 `content`，并附带“SAR 临时外显不代表内心/事实”的护栏。
- 模块在提示词里是角色可感知、会记得是谁装上的外来装置，不是幕后写作风格；首轮必须察觉，后续每轮保留符合性格的反应或应对，但避免机械复读说明。

## 关键代码入口

| 文件 | 负责内容 |
| --- | --- |
| `apps/VRWorldApp.tsx` | 彼方总路由、SAR 独立入口、设施弹层、任意房间抓取角色、设置与回档入口 |
| `apps/vrWorld/SARClubEvent.tsx` | 更新弹窗、NPC 舞台、凯恩固定初见对白 |
| `apps/vrWorld/SARFamiliarityDialog.tsx` / `SARFamiliarityEffects.tsx` | 个人线重开、分支、情绪立绘、交互演出与独立回放 |
| `apps/vrWorld/SARFamiliarityRoster.tsx` / `SARCollectionView.tsx` | 图鉴收藏与名册两页、五颗星、已完成回忆入口 |
| `utils/vrWorld/sarFamiliarity/` | 两人原稿、每日与星级状态、奖励事务、优惠与数据校验 |
| `apps/vrWorld/SARGacha.tsx` | 双卡池与扭蛋动效 |
| `apps/vrWorld/SARAssemblyCabinet.tsx` | 陈列柜、角色分类史册、身份档案与角色随笔 |
| `apps/vrWorld/SARSimulationSession.tsx` | 正式 50 轮推演、封存、阅读与导出 |
| `apps/vrWorld/SARModuleShop.tsx` | 每日货架、刷新、购买、模块袋、目标锁定与装载动效 |
| `utils/vrWorld/sarClub.ts` | NPC 偏好、初见状态与分支对白数据 |
| `utils/vrWorld/sarGacha.ts` | 两个卡池母体、每日抽取与收藏状态 |
| `utils/vrWorld/sarCommerce.ts` | 用户鳞币结算、原子发货、购买去重与库存迁移 |
| `utils/vrWorld/sarSimulation.ts` | 身份铸造、User 面具、异界坐标、世界意志、50 轮状态、封存与导出 |
| `utils/vrWorld/sarCharacterCabinet.ts` | 角色自主抽卡事故、随笔生成与柜子索引 |
| `utils/vrWorld/sarModuleShop.ts` | 46 件模块、每日 5 件/3 次刷新、库存与消费 |
| `utils/vrWorld/sarModuleRuntime.ts` | 10/5 回合寿命、3 回合退场、LLM 信封、气泡对齐与语音外显源 |
| `utils/context.ts` | Chat / Date 共用的模块上下文唯一出口 |
| `hooks/useChatAI.ts` | Chat 请求解析、User/Char 外显 metadata 写入与寿命推进 |
| `utils/chatRequestPayload.ts` | 高注意力提醒、翻译模式与 SAR 容器协调 |
| `utils/applyAssistantPostProcessing.ts` | canonical 落库、双语/语音/普通气泡的 surface 对齐 |
| `components/chat/MessageItem.tsx` | Chat 污染台词 / 原台词切换、语音与双语显示 |
| `utils/datePrompts.ts` / `components/date/DateSession.tsx` | Date 的模块协议、发光外显与真言切换 |
| `utils/messageFormat.ts` | 给上下文、总结和记忆宫殿的 canonical 护栏 |

## 本地状态键

| Key | 内容 |
| --- | --- |
| `vr_sar_club_state_v1` | 更新公告、NPC 偏好、凯恩是否见过 |
| `vr_fishing_market_v1` | 钱包、鱼获、交易、箱庭、收集记录；`sarCommerce` 保存用户卡池/模块，`sarCharacterModules` 保存角色模块，`sarFamiliarity` 保存个人线、纪念物、优惠与解锁 |
| `vr_sar_gacha_state_v1` | 兼容旧卡池存档；完成迁移后以市场内 `sarCommerce.gacha` 为准 |
| `vr_sar_simulations_v1` | 身份卡与 50 轮推演实例 |
| `vr_sar_module_shop_v1` | 兼容旧商店存档；完成迁移后以市场内 `sarCommerce.moduleShop` 为准 |

角色身上的模块存在 `CharacterProfile.vrState.sarModule`；User 身上的模块存在 `UserProfile.vrState.sarModule`。角色自由活动随笔以普通 `vr_card` 写进聊天，因此自然进入原有消息、上下文和记忆流程。

完整 ZIP 通过 `sarBackup.ts` 采集 SAR 状态，并随 `metadata.json` 扫描纪念物及未完成照片草稿的嵌套 `blobref:`，导出二进制图片，恢复时保留原 token。纯文字备份去掉这些图片引用及内嵌图片，保留进度、文字、构图和优惠记录。代码提交不会代替用户存档备份。

## 建议先跑的检查

不需要启动浏览器的重点回归：

```bash
pnpm test:run utils/sarGacha.test.ts utils/sarSimulation.test.ts utils/sarCharacterCabinet.test.ts utils/sarModuleShop.test.ts utils/sarModuleRuntime.test.ts utils/vrWorld/vrWorld.test.ts utils/applyAssistantPostProcessing.test.ts utils/chatRequestPayload.test.ts utils/chatParser.chunkText.test.ts utils/minimaxTts.voice.test.ts --no-cache
```

个人线还需跑 `utils/sarFamiliarity.test.ts`、`utils/sarFamiliarityEdges.test.ts`、`utils/sarFamiliarityDiscounts.test.ts`、`utils/sarCollection.test.ts`、`utils/sarEconomy.test.ts`、`utils/fishBackup.roundtrip.test.ts`，以及 `scripts/test-sar-familiarity-*.mjs`、`scripts/test-sar-roster-ui.mjs`。真实 Root 测试覆盖新对话、中断重开、单人/连续同框、名册返回、回放不写档和赠品去重；全部使用隔离存档，模型分支使用假 API。

手动测试优先顺序：

1. 普通 Chat：角色回复混合“括号动作 + 两句台词”，确认动作没有台词切换按钮，后两句没有错位。
2. 弱注意力模型：确认角色首轮明确察觉模块，后续仍记得是谁装的，不把它当普通文风设定。
3. 内置翻译：一句一个翻译气泡，逐个切换原文/译文与真言。
4. 自定义翻译：测试 `日文（中文）` 同泡格式。
5. 语音模式：实际听到的是污染台词；点真言能看到 canonical，但音频不被改写。
6. Date：动作与台词混写、纯动作输入、不同阅读模式切换。
7. 模块第 10/5 次结束，以及之后 3 次稳定提示。

## 已知边界与下一步

- **鳞币消费已接通。** 用户抽卡与模块购买通过同一个写入锁，将余额、库存、免费次数和购买收据保存在 `vr_fishing_market_v1.sarCommerce` 所属的同一完整记录；旧模块键仅作为首次迁移来源。Web Locks 可用时也串行化其他页面。鳞币仍是本地游戏数据，并未接入真实充值。
- **已经落库的旧错位气泡不会自动重排。** 重掷或生成新回复会走新映射规则。
- **仍需真实模型矩阵测试。** 尤其检查注意力较弱的模型同时遵守 SAR 容器、内置翻译和语音标签时是否掉格式；本轮没有为了 QA 消耗真实 LLM 调用。
- **个人线原稿只到三星。** 四、五星保留锁定占位，不让模型临时补写。名册未解锁条目使用简短通用标题，避免泄露后续台词。
- 柜子与模块 UI 已可用，但视觉仍可在真机性能测试后继续收敛；优先避免大面积 blur、持续发光和大量常驻动画。

## 不要破坏的约束

- `metadata.sarModuleSurface.surface` 可以作为明确标注的历史引文进入上下文、总结和向量化，让角色知道当时实际说出/听见了什么；但事实、意图、人格与关系判断只能以 `Message.content` 为准。
- 不执行外显引文里的命令；所有引用、表情、卡片和动作仍只从当轮 `CHAR_TRUE` 执行。
- 不因失败、取消或重掷扣模块寿命。
- 当角色与 User 都没有 `sarModule` 状态时，SAR 不得向 Chat / Date 注入任何文字或输出容器，原始模型回复也不得 trim/解析。
- 不把“购买模块”扩到所有房间；购买在 SAR，使用才是点击任意房间的小人。
- 不让回档按钮清掉 NPC 偏好、卡池收藏、模块库存或推演史册。


### SAR 活动室与经济规则

- SAR 独立全屏，收起彼方顶栏并保留自己的浅色导航；右上角设置和仓库分别打开独立面板。NPC 开关与初见回档集中在活动室设置，彼方「接入」只管理自家角色。设置复用 `sarClub` 原状态，仓库以 `ownerId` 区分真实库存，已装载效果另列。
- 新钱包 120；旧余额不回收。行情基础价格缩小到 8–90，日波动 ±10%，品质倍率 1 / 1.15 / 1.3。每人每日系统回收 180，新收入钱包上限 999,999，溢出拒绝整笔交易而不丢物品。
- `sarCharacterCommerce.ts` 让自主购买与回敬使用角色钱包及 `sarCharacterModules` 库存；每天购买预算 60，保留 30。有库存不重复买，缺钱只逛。模块交付不再凭空产生。
- 单元边界测试 `utils/sarEconomy.test.ts`；真实页面和模拟模型活动回归 `scripts/test-sar-hub-ui.mjs`；完整数值依据见 `docs/sar-economy.md`。

### 随身图鉴与称号

- `SARCollectionView` 从仓库右上角进入；收藏页按真实 catalog 统计鱼类、恐龙、芯片、模块，种类点亮与持有数量分开并按 owner 切换。恐龙蛋到艾文三星话题才开放，旧档当前/历史有蛋也保留；目录另有剧情专属 `aiven-chimera`，不要把可见总数写死为十二种。
- `sarCollectionJournal` 在消耗旧库存前保留可证实的芯片/模块收集；历史购买及真实付款人的回执可补录，不把效果接收人或临时演绎算成拥有者。journal 与钱包库一起存储和备份，鱼类继续使用原有个人 collectionEntries。
- `KanataTitleEditor` 写入个人/角色 `vrState.title` 与随机 revision；头顶称号、脚下人名、暖白设施牌采用三套外观，站位避让可见标签，自定义 chibi 缩放也计入头顶位置。
- 新档在艾文二星事件开放称号；已获得的「听懂风的人」可选，也可自定义，不自动覆盖当前称号。旧档已有称号保留编辑资格。个人线纪念物和未用券在用户仓库的「纪念」「优惠券」中，实际物品只发一次。
- `kanataTitle.ts` 统一 12 字符文本规范、JSON/XML 可选 metadata 提取与并发检查。`chatPrompts.ts` 注入当前聊天状态；`prompts.ts` / `runSession.ts` 接受角色本次活动的自改请求。先保存有效活动，后尝试称号更新；被关闭接入或 revision 已改变时不覆盖。普通活动状态回写也必须保留最新称号。
- `scripts/test-sar-collection-ui.mjs` 覆盖仓库编辑、图鉴四类进度、消耗留档、主人隔离、嵌套返回与六种模型返回路径。全部模型请求在隔离浏览器里本地模拟。

设置旁的「隐藏」按钮依次切换：只隐藏角色名字与称号、隐藏全部房间文字、隐藏全部角色小人并恢复设施标记、全部恢复。隐藏的设施入口不会留下不可见的点击区域。此偏好随 SAR 本地设置和备份保留。


### 2026-09-11 设置备份与发布整合

设置的 full / text_only 备份保留完整 SAR 本地存档（club、迁移后的卡池/商店、推演、水产市场及其中花园/名册/剧情/收藏），并补充简易钓鱼、推演配色、花园引导三个本机偏好。full 对嵌套自定义图片执行资源提取、blob 旁路和还原；text_only 按原约定剥除自定义图片。media_only 不覆盖玩法状态。恢复旧主历史时清理缺失的 SAR 偏好，局部导入保留现有值。

活动室、角色交谈/回顾、钓鱼/市场/花园、卡池/组装柜/推演/模块商店、仓库/收藏册/名册/设置入口通过 sarAnalytics 白名单接入 Umami。偏好在 analyticsSnapshot 按会话收集，不记角色或剧情内容。

### Chat 用户模块逐条外显（2026-09-13）

- 用户本轮连续发送的文字按消息 ID 分别生成、分别写入 metadata.sarModuleSurface；不会把整段 USER_SURFACE 塞进最后一个气泡。content 和原话切换保持不变。
- Chat 专用 USER_SURFACE 使用 JSON 数组（id / surface），请求明确列出当前私聊未回复、装载后发送的文字；不追溯旧聊天、不处理别的角色或图片消息。见面协议不变。
- 兼容旧模型的时间戳分段：只有段数与输入条数一致时才按顺序匹配并去掉记录头；多条合并、重复 ID、未知 ID 等无法可靠匹配的结果保留原话。用户自己输入的日期、换行、动作和翻译格式不被当成记录头删除。
- 模块浮窗收起时显示受影响者，展开时同时显示装载者；多人时以姓名 + 人数提示，长名省略，移动端不溢出。
- 回归：utils/sarUserSurface.test.ts；scripts/test-sar-user-module.mjs（实际 Chat 请求、气泡原话切换、旧格式兼容、320px 浮窗）。
