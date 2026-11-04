# 万圣节恶作剧与新增亲密互动

2026-10-28。本轮是正式双人动作目录的增量，家园人物互动轮盘新增「恶作剧」。两种体型分别共用同一时间轴；第三位居民保留独立状态。动作不按真实日期锁定，也不写入家具或衣橱存档。首轮仅道具来自 Meshy、动作采用程序摆姿势，用户反馈僵硬；最终保留六组、十二段 Meshy Text-to-Motion Prime 动作。程序负责比例适配、同步和接触修正。

| 分支 | 动作 | 两人分工 |
|---|---|---|
| 恶作剧 | 突然吓一下 | 发起者抬手装怪，回应者受惊后放松 |
| 恶作剧 | 不给糖就捣蛋 | 发起者提南瓜桶要糖，对方递糖投入桶中 |
| 恶作剧 | 撒糖接糖 | 发起者扬手撒出七颗糖，对方伸双手接糖 |
| 恶作剧 | 举幽灵逗你 | 发起者晃动幽灵玩偶，对方惊讶后伸手回应 |
| 亲密 | 贴额头 | 拉住手、扶肩，靠近停留后分开 |
| 亲密 | 接吻 | 靠近、闭眼短暂停留、分开；高的一方屈膝适配 |

两项亲密动作沿用 `homeRomance.ts` 的具体角色对授权；好感、同居、文字描述都不授权。六项均要求两人站立。正式执行沿用双人寻路、空地检查、加载后复查关系、切房间/离场取消。脸部动作额外检查 0.24 场景单位的接触位移余量。

## Meshy 工作流

`art/halloween-2026/interactions/meshy-props.mjs` 通过官方 `POST /openapi/v2/text-to-3d` 创建三个 `meshy-6` preview 任务，直接获取无贴图几何。只接受当前进程的 `MESHY_API_KEY`，不保存凭据；浏览器和应用运行时不调用 Meshy。

- `meshy-ledger.json` 记录任务 ID、请求参数、消耗和源 GLB 的 SHA-256；原始 `*-source.glb` 留在制作目录。
- 提交前记录 `SUBMITTING`，结果不明确不自动重投。`run` 只提交清单中尚未登记的三件；`status` 只查询、下载已存在任务。独占锁避免并发重复提交。
- 这三件共消耗 **60 credits**。任务完成时账户余额 **836 credits**，这是当次快照。
- `build-props.mjs` 去图片/UV、合并顶点、按预算减面和平滑，按语义手工配色，统一尺寸与握持原点。幽灵脸补实体深色眼口，保留生成模型的小柄作为握持端。
- 发布文件仅在 `public/room3d/props/halloween/`：糖桶 2,514 面 / 61,588 B；糖果 836 面 / 21,340 B；幽灵 2,378 面 / 60,196 B。三件均无图片、无 UV、少于 4,000 三角面。

命令：

```powershell
# MESHY_API_KEY 由调用进程注入，不把值写进脚本或仓库。
pnpm node art/halloween-2026/interactions/meshy-props.mjs status
pnpm node art/halloween-2026/interactions/build-props.mjs
pnpm node art/halloween-2026/interactions/build-clips.mjs
```

官方端点说明：[Meshy Text to 3D](https://docs.meshy.ai/en/api/text-to-3d)、[Meshy Text-to-Motion](https://docs.meshy.ai/en/api/text-to-motion)。动作是 AI 生成，不能称为真人动作捕捉。

动作制作流程：

- `meshy-motion.mjs submit` 使用 `POST /openapi/v1/text-to-motion`，`mode: prime`、`duration: 8`；每个角色分别描述动作。14 段共 **140 credits**，完成快照余额 **696 credits**。加上本轮道具共 200 credits。
- `motions/ledger.json` 留存每段完整提示词、任务 ID、成功状态、费用与 SHA-256；原始 FBX 下载到同目录，只留本机，忽略入库。服务端队列曾明确返回 429，只有这种已知未接受请求可以重投；不明确的 SUBMITTING 不重投。`status` 只查询和下载。
- `import-motions.mjs` 读取 FBX 的 SMPLH 动画，不发布预览人体或纹理。映射 21 个主关节、折叠多余脊柱节点，每角色采样 241 帧；保留源旋转变化，不改变目标骨长。每次采样重置 AnimationAction，防止末帧暂停污染后续采样。
- 移除意外转身、线性位置漂移，保留小幅重心移动。吓人/受惊用连续时间映射对齐反应；旋转用对称滤波减轻手腕抖动。两段独立生成动作共用时间轴，Meshy 并未一次生成原生双人接触动画。
- `selectedSocial.ts` 真正调用 `applySelectedFrame` 播放数据；脸部接触把真人的大幅前倾平滑缩小到大头小人可用范围。`seasonalSocial.ts` 校正递糖、牵手、扶肩等接触，不覆盖吓人、撒糖的身体表演。

重新生成时在进程中提供密钥后运行 `pnpm node art/halloween-2026/interactions/meshy-motion.mjs submit`；下载完成后运行 `pnpm node art/halloween-2026/interactions/build-clips.mjs`。现有成功任务不会重复消费。

## 运行与验收

- `seasonalSocial.ts`：双方动作、错开反应和表情；`faceSocialContact.ts`：拟合后素体表面的默认嘴部/额头接触点、屈膝和脚底修正。直接用骨骼世界矩阵，避免读取渲染器上一帧的 bindMatrixInverse。骨长不变。
- `halloweenProps.ts`：三个有限共享模板、懒加载、失败可重试。加载完成前不开始动作；取消后迟到资源不会恢复旧动作。暂停/倒拖用相同时间重算，糖果转移不积累物理状态。结束释放场景中的道具，模板资源供下次复用。
- 正式目录：`selectedMotionCatalog.json`，四项 `mischief`、两项 `close`；共 48 项动作、27 项双人动作。六份 JSON 包含真实生成的双人旋转、位置与接触采样，`source: meshy-text-to-motion`，目录记录两段来源 SHA-256。
- 预览：`test/fixtures/room3d-social.html`，可切两种体型、交换角色、改身高、暂停和拖进度；使用演示人物，不改正式存档。道具单独预览在 `art/halloween-2026/interactions/props.html`。
- 隔离服务：`pnpm exec vite --config art/halloween-2026/interactions/vite.config.ts`；`motion-review.mjs <动作 ID...>` 保存连续时刻拼图并采样整段骨骼变化与脚底位置，`--classic` 检查旧体型。单张截图不构成动作质量验收。
- 回归：`chibiSeasonalSocial.test.ts`、`chibiSocial.test.ts`、`chibiIntimacy.test.ts`、`chibiSocialFacing.test.ts`、`chibiSocialProps.test.ts`、`homeRomance.test.ts`、`homeSocialWheel.test.ts`。

验收边界：脸部接触按默认五官位置和实际素体尺寸计算；大幅自定义嘴部位置、长刘海、极端宽袖仍可能遮挡或穿插，不能视为所有衣橱组合均验收。Chibi 沿用原有刚性手部表现；二号素体有屈膝和手臂 IK。未连接在线 LLM，未部署。

首轮程序动作的 56 项测试通过不代表观感合格。替换生成动作后增加来源可追溯、完整身体实际播放、末帧冻结回归；这七份回归文件现为 58 项。最新连续画面检查保存在 `motions/*-sequence.png`，测试用于发现错误，不替代用户对动作观感的判断。全仓 tsc 先前仍有范围外错误；既有 homeSocialRoles.test.ts 的模拟 editor 缺少 getState 问题未在此修改。

本轮复验：58 项相关回归通过；删除旧摆姿势分支、修正牵手掌向后，9 项专项回归再次通过。两种体型七组动作检查均无 pageerror；二号素体额外检查 80% / 125% 身高组合，脚底没有穿地。接吻前倾引发的跳转和牵手前臂翻转已修正。试玩与构建验证均在本地，未部署。

2026-10-28 最终取舍：用户要求删除「亲密 → 拉手轻晃」，已从正式目录、运行分支、发布 JSON 和重建/生成清单移除。历史 Meshy 任务账本保留两段弃用源的费用记录，140 credits 为实际历史支出；正式使用十二段。其余六组直接通过 HomeSocialWheel → HomeSocialPanel → editor.playSocial → createSocialScene 执行，角色动作选项也读取同一正式目录。亲密保留贴额头、接吻，继续检查具体角色对的浪漫关系。
