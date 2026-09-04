# 彼方 / SAR 开发交接

更新时间：2026-09-04

开发分支：`codex/kanata-update`
功能基线提交：`668a3926 feat: expand Kanata SAR systems`

这份文档用于在另一台电脑上继续开发当前的彼方大更新。当前方向已经从“第二页里再放一间活动室”改为：**彼方第二页整体就是 SAR 活动空间**。凯恩与艾文是可关闭的固定 NPC；人格推演、陈列柜、模块商店都属于这片空间的设施。

## 在家里的电脑接续

首次拉取这个分支：

```bash
git fetch origin
git switch -c codex/kanata-update --track origin/codex/kanata-update
pnpm install --frozen-lockfile
pnpm dev
```

如果本地已经有同名分支：

```bash
git switch codex/kanata-update
git pull --ff-only
pnpm install --frozen-lockfile
pnpm dev
```

默认打开 Vite 输出的本地地址。API、角色和历史数据仍在浏览器本地存储中；Git 分支只同步代码，不会同步这台电脑里的角色或测试档案。需要复现原数据时，用 SullyOS 的完整导出/导入。

## 当前已经完成

### 1. SAR 空间与 NPC 开场

- 首次进入会显示“更新－彼方活动室”，再让用户选择“我很欢迎 / 我不想要 NPC”。
- NPC 开关只控制凯恩、艾文及固定对白，不影响设施。
- 凯恩初见是写死的 Galgame 分支，不调用 LLM；结束后移除感叹号。
- “监控回档”只重置凯恩初见，不重置更新公告与 NPC 偏好。
- 历史备份恢复后，SAR 首次触发状态跟随导入数据，不沿用导入前设备状态。

### 2. 异世界人格推演

- 两个独立卡池：`人格异格` 与 `异界坐标`，每池每天免费一次。
- 铸造时选择角色，再组合两枚芯片；LLM 生成角色异格身份、钢印、代价、User 身份面具、异世界坐标和高潮开场。
- 现实记忆不整包搬入异世界，只读取双方“关系门牌”；具体聊天和近期现实事件不进入推演。
- 正式推演固定 50 次互动，可提前紧急封存；每轮由“世界意志旁白层 + 角色层”共同推进，负责控制倒计时、高潮与返航节奏。
- 封存档案可重复阅读、下载，并可把返航简报分享给原角色聊天。
- 陈列柜按角色整理 User 的身份卡与旅程；“看看角色的柜子”展示角色自由活动时自己抽芯片、给其他人使用后写下的事故随笔。

### 3. 模块商店与装载

- 固定模块目录目前 46 件；每日随机上架 5 件，每天可手动刷新 3 次。
- 钓鱼货币尚未完成，因此商店现在处于开发配给模式，可直接测试购买。
- 购买只发生在 SAR 柜台；使用从角色本身发起：在彼方任意房间点击任意小人，都可以“抓住 TA · 使用模块”。
- 对角色使用持续 10 次成功 LLM 互动；对 User 使用持续 5 次。
- 结束后保留 3 次稳定提示：第 1 次明确察觉模块解除，后 2 次防止模型继续沿用污染语气。
- 角色对 User 使用模块默认关闭，需 User 主动开启“允许角色对我使用模块”。
- 失败、取消和重掷不会扣模块寿命；新回复成功落库才扣一次。

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
上下文、总结、记忆宫殿               Chat / Date 显示与 TTS
```

- Chat 使用小光点切换外显/真言，不覆盖用户自定义气泡样式。
- Date 点击发光文字切换真言，兼容不同阅读模式。
- 纯括号动作/旁白气泡不附加污染文本，也不消耗下一句外显序号。
- 内置翻译把一整组 `<原文>/<译文>` 当成一个气泡；原文和译文保持同一份污染含义。
- `日文（中文翻译）`、`English (中文翻译)` 等角色自定义同泡格式会整体保留，不把括号翻译误判为动作。
- `<语音>` 与 `<字幕>` 是一个原子气泡；TTS 朗读外显版，数据库仍保存真意。切换真言只改变文字查看，已经生成的音频保留当时实际说出口的版本。
- 总结与记忆格式化只读取 `content`，并附带“SAR 临时外显不代表内心/事实”的护栏。
- 模块在提示词里是角色可感知、会记得是谁装上的外来装置，不是幕后写作风格；首轮必须察觉，后续每轮保留符合性格的反应或应对，但避免机械复读说明。

## 关键代码入口

| 文件 | 负责内容 |
| --- | --- |
| `apps/VRWorldApp.tsx` | 彼方总路由、第二页、设施弹层、任意房间抓取角色、设置与回档入口 |
| `apps/vrWorld/SARClubEvent.tsx` | 更新弹窗、NPC 舞台、凯恩固定初见对白 |
| `apps/vrWorld/SARGacha.tsx` | 双卡池与扭蛋动效 |
| `apps/vrWorld/SARAssemblyCabinet.tsx` | 陈列柜、角色分类史册、身份档案与角色随笔 |
| `apps/vrWorld/SARSimulationSession.tsx` | 正式 50 轮推演、封存、阅读与导出 |
| `apps/vrWorld/SARModuleShop.tsx` | 每日货架、刷新、购买、模块袋、目标锁定与装载动效 |
| `utils/vrWorld/sarClub.ts` | NPC 偏好、初见状态与分支对白数据 |
| `utils/vrWorld/sarGacha.ts` | 两个卡池母体、每日抽取与收藏状态 |
| `utils/vrWorld/sarSimulation.ts` | 身份铸造、User 面具、异界坐标、世界意志、50 轮状态、封存与导出 |
| `utils/vrWorld/sarCharacterCabinet.ts` | 角色自主抽卡事故、随笔生成与柜子索引 |
| `utils/vrWorld/sarModuleShop.ts` | 46 件模块、每日 5 件/3 次刷新、库存与消费 |
| `utils/vrWorld/sarModuleRuntime.ts` | 10/5 回合寿命、3 回合退场、LLM 信封、气泡对齐与语音外显源 |
| `utils/context.ts` | Chat / Date 共用的模块上下文唯一出口 |
| `hooks/useChatAI.ts` | Chat 请求解析、User/Char 外显 metadata 写入与寿命推进 |
| `utils/chatRequestPayload.ts` | 高注意力提醒、翻译模式与 SAR 容器协调 |
| `utils/applyAssistantPostProcessing.ts` | canonical 落库、双语/语音/普通气泡的 surface 对齐 |
| `components/chat/MessageItem.tsx` | Chat 光点、真言切换、语音与双语显示 |
| `utils/datePrompts.ts` / `components/date/DateSession.tsx` | Date 的模块协议、发光外显与真言切换 |
| `utils/messageFormat.ts` | 给上下文、总结和记忆宫殿的 canonical 护栏 |

## 本地状态键

| Key | 内容 |
| --- | --- |
| `vr_sar_club_state_v1` | 更新公告、NPC 偏好、凯恩是否见过 |
| `vr_sar_gacha_state_v1` | 双卡池每日次数、收藏与抽取历史 |
| `vr_sar_simulations_v1` | 身份卡与 50 轮推演实例 |
| `vr_sar_module_shop_v1` | 每日货架、刷新次数、模块库存与购买记录 |

角色身上的模块存在 `CharacterProfile.vrState.sarModule`；User 身上的模块存在 `UserProfile.vrState.sarModule`。角色自由活动随笔以普通 `vr_card` 写进聊天，因此自然进入原有消息、上下文和记忆流程。

## 建议先跑的检查

不需要启动浏览器的重点回归：

```bash
pnpm test:run utils/sarGacha.test.ts utils/sarSimulation.test.ts utils/sarCharacterCabinet.test.ts utils/sarModuleShop.test.ts utils/sarModuleRuntime.test.ts utils/vrWorld/vrWorld.test.ts utils/applyAssistantPostProcessing.test.ts utils/chatRequestPayload.test.ts utils/chatParser.chunkText.test.ts utils/minimaxTts.voice.test.ts --no-cache
```

最近一次针对模块气泡、翻译与语音边界的检查为 5 个文件、80 个用例全部通过；隔离 Vite 生产构建也已通过。

手动测试优先顺序：

1. 普通 Chat：角色回复混合“括号动作 + 两句台词”，确认动作没有光点，后两句没有错位。
2. 弱注意力模型：确认角色首轮明确察觉模块，后续仍记得是谁装的，不把它当普通文风设定。
3. 内置翻译：一句一个翻译气泡，逐个切换原文/译文与真言。
4. 自定义翻译：测试 `日文（中文）` 同泡格式。
5. 语音模式：实际听到的是污染台词；点真言能看到 canonical，但音频不被改写。
6. Date：动作与台词混写、纯动作输入、不同阅读模式切换。
7. 模块第 10/5 次结束，以及之后 3 次稳定提示。

## 已知边界与下一步

- **钓鱼区与正式货币未实装。** 商店暂时使用开发配给模式；接入钓鱼货币时关闭 `SAR_MODULE_SHOP_DEVELOPMENT_MODE` 并替换余额来源。
- **模块商店状态尚未进入 SAR 主备份。** `utils/vrWorld/sarBackup.ts` 当前只收集 club、gacha、simulations；需要把 `vr_sar_module_shop_v1` 加入收集、恢复和迁移测试。换电脑导入旧备份时，模块库存不会跟随，这是已知缺口。
- **已经落库的旧错位气泡不会自动重排。** 重掷或生成新回复会走新映射规则。
- **仍需真实模型矩阵测试。** 尤其检查注意力较弱的模型同时遵守 SAR 容器、内置翻译和语音标签时是否掉格式；本轮没有为了 QA 消耗真实 LLM 调用。
- **NPC 立绘仍是 CSS 占位。** 后续导入凯恩/艾文立绘与表情拆分时，替换 `SARClubEvent.tsx` 的 `NpcStandIn`，不要改对白状态机。
- 柜子与模块 UI 已可用，但视觉仍可在真机性能测试后继续收敛；优先避免大面积 blur、持续发光和大量常驻动画。

## 不要破坏的约束

- 不把 `metadata.sarModuleSurface.surface` 喂回模型、总结器、向量化或关系计算。
- 不用前台显示文本执行命令；所有引用、表情、卡片和动作只从 `CHAR_TRUE` 执行。
- 不因失败、取消或重掷扣模块寿命。
- 不把“购买模块”扩到所有房间；购买在 SAR，使用才是点击任意房间的小人。
- 不让回档按钮清掉 NPC 偏好、卡池收藏、模块库存或推演史册。
