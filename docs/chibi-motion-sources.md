# 衣橱动作来源与接入

## 当前确认保留（2026-09-23）

用户确认 **1 轻轻待机、12 MMD 安静呼吸、14 交谈手势收腿版、16 侧头放松、17 转头看看**。菜单保留这五段及普通站姿，固定原编号，统一归入「已选动作」。`approvedWardrobeMotions.json` 是保留清单；其余候选留在素材档案及回归检查中，不再出现在选择菜单，旧草稿中未保留的动作回退普通站姿。

**后续署名以 [已选动作具体来源与致谢文案](../art/chibi/motion-sources/SELECTED-CREDITS.md) 为准**：逐项记录作者、原文件、作者页、固定下载版本、校验值、许可副本和本地改动。不能只写“MMD”或“VRoid”。下面为历史试选记录；当前确认状态以本节为准。下一步转向互动动作，触发方式待确定。

## 2026-09-23 · 窄站姿与 MMD 试选

用户反馈上一组更好，但腿张开太大，希望继续尝试 MMD 小动作。新增菜单 **12–17「新候选 · 窄站姿」**，原 1–11 不变，仍未视为最终认可：

| 编号 | 菜单 | 来源 / 本地适配 |
| --- | --- | --- |
| 12 | MMD · 安静呼吸 | DiSK / Breath_1800F，60 秒，呼吸与肩颈旋转叠加到认可普通站姿 |
| 13 | 自然待机 · 收腿版 | 原 Mesh2Motion Idle_A 的上身；骨盆和腿使用普通站姿 |
| 14 | 交谈手势 · 收腿版 | 原 Mesh2Motion Idle_Talking 的上身；骨盆和腿使用普通站姿 |
| 15 | 轻轻点头 | Overte emote_agree_headnod.fbx，经 Hanami 转为 nod.vrma；普通站姿下肢 |
| 16 | 侧头放松 | Overte idle_once_neckstretch.fbx → relaxed.vrma；普通站姿下肢 |
| 17 | 转头看看 | Overte idle_once_lookaround.fbx 前段 → think.vrma；普通站姿下肢 |

### MMD / DiSK

- [作者原下载页](https://bowlroll.net/file/231043)与包内 readme 明示 **CC0 1.0**。下载包 `Eyedart_Breath_motion_v1.1.zip` 的 SHA1 为 `033e48ca19bf2f178c4ae79eef47afbd444e3bbd`，与作者页一致。
- 原始呼吸 VMD（47 KB）与 readme 保存在 `art/chibi/motion-sources/DiSK-Breath_1800F.vmd`、`DiSK-Breath-CC0.txt`；VMD SHA256 `d1a1cbb09865c3a408cd2a2fad58ad480da0153b0bec47bf57f38000fb3eedc6`。
- `pnpm node art/chibi/import-mmd-breath.mjs` 可重建 `experiments/chibi/wardrobeMmdMotions.json`。复用 MIT 的 [mmd-parser](https://github.com/takahirox/mmd-parser) 解析 Shift-JIS 骨名及左右手系，按 [Three.js r169 MMDLoader](https://github.com/mrdoob/three.js/blob/r169/examples/jsm/loaders/MMDLoader.js) 的 VMD 旋转曲线布局，用目标关键帧的 Bezier 时间进行 30 Hz 四元数采样。
- 只为这份呼吸素材映射七条旋转轨道，不是通用 VMD 导入器。源骨位移不进入角色；无腿轨道，不改变骨长或蒙皮。原包另有眼神运动，当前没有接入眼骨，不能声称包含眼神或表情。

### Overte / Hanami

- 原始素材 [Overte](https://github.com/overte-org/overte) 为 Apache-2.0；VRMA 转换固定为 [Hanami 6787685](https://github.com/Undi95/Hanami/blob/6787685c8d40e4e79bffbb0d389b478f32ef88d6/vrma/NOTICE.md)，只采用表中三段 Overte 来源，不混用该库其他授权。
- 逐文件 SHA256 保存于 `art/chibi/motion-sources/overte-manifest.json`。随附 `Hanami-NOTICE.md` 保留来源与转换说明，`Overte-LICENSE-Apache-2.0.txt` 保留完整许可证。Copyright (c) 2013–2019 High Fidelity, Inc.; 2019–2021 Vircadia contributors; 2022–2026 Overte e.V.
- 复用已有 VRMA 转换器：`pnpm node art/chibi/import-vrma-wardrobe.mjs <三份 VRMA 所在目录> experiments/chibi/wardrobeOverteMotions.json art/chibi/motion-sources/overte-manifest.json`。
- 本项目的改动：重定向为当前骨架的旋转数据、轻握手与已有前臂 twist、普通站姿骨盆和双腿、必要时加原有 0.45 秒回首帧。源文件本身的站距不是菜单中收窄后的效果；没有脚位移或走路，不能把这套下肢固定用于舞蹈和移动动作。

验收增加整段 121 个时间点双脚位置不变、下肢等于普通站姿、两段 Mesh2Motion 变体上身不变、MMD 加法姿势和 Bezier 目标帧曲线测试；新动作仍需用户现场挑选。

## 当前衣橱 · 轻柔候选

2026-09-22：用户随后否决 Mesh2Motion 的动作气质，选择「日系可爱、轻柔小动作」。菜单把 **Sachi / rerofumi 的三段 VRMA** 放在「轻柔候选」组最前：轻轻待机、轻声交谈、转身小手势；原八段放在「上一组 · 对比」，普通站姿继续保留。这些仍是现场试选，不能写成用户已经认可。

- 作者原页：[Sachi VRMA 1 / sashii](https://booth.pm/ja/items/6412084)、[使いどころに困るモーションセット / へすい・rerofumi](https://booth.pm/ja/items/5527394)。两页明确 CC0，已核对；BOOTH 下载需登录，实际文件从公开再分发的 [VoxAvatar](https://github.com/SanHsien/voxavatar/blob/3061a25dc9c9fa0660e2fc59c50b50f019c5129c/ASSET_LICENSES.md) 镜像取得。
- 镜像固定版本 `3061a25dc9c9fa0660e2fc59c50b50f019c5129c`，文件位于 `public/assets/animations/`；逐个 SHA256 与该版本 `public/assets/manifest.json` 一致，由生成器强制检查。许可为素材自己的 CC0，不是镜像仓库代码的 MIT。

| 菜单 | 源文件 | 长度 | SHA256 |
| --- | --- | --- | --- |
| 轻轻待机 | idle-01.vrma / sashii | 7.97 秒 | `5ed6c016df035b21daaefe64751e1356387c6a33693d31366b0912ac7566ea92` |
| 轻声交谈 | speaking-01.vrma / sashii | 1.97 秒 | `ba0339d2d9755fc2e0dab06e96a0d91303d0a508c9f89f07dc17a07dc0e2535c` |
| 转身小手势 | pose-motion.vrma / rerofumi | 19.97 秒 | `e3b06f78b21df2fe1f26d80dd1826fd47941a891d44b46a6197f8a87de05ff2c` |

生成命令 `pnpm node art/chibi/import-vrma-wardrobe.mjs <上述三个文件所在目录>`，输出 `experiments/chibi/wardrobeVrmaMotions.json`。通过 VRMC_vrm_animation 的人形骨语义读取绑定姿势与动画世界旋转差；合并 upperChest 到当前 chest，再求目标局部旋转。没有复制源模型或重绑蒙皮，保留源动画节奏。新旧生成器输出分开，互不覆盖。

已对照源骨架与当前小人正/侧/背面：前两段是安静的小幅动作；第三段包括前倾、转身与抬手，幅度更明显。这里只转移身体旋转，未导入源表情、唇形、根位移和细分手指轨道；继续使用轻握手及前臂 twist 分配，不等于源 VRM 完整表现。全段碰撞、脚底锁定及大头比例下的手部接触仍不是本轮保证项。

## 前一轮接入记录

用户于 2026-09-22 否决自制的「叉腰 / 可爱」两套试衣动作。正式入口已撤下，`boy` / `cute` 旧存档回退到认可的普通站姿，未删除衣服、人物或用户搭配。旧动作只移至 `test/fixtures/legacyWardrobePose.ts` 作为叠穿压力姿势，不进入正式页面依赖。原衣橱入场插值代码也已撤下。

目前保留「普通站姿」，另按用户要求接入 **8 段开源候选动作现场挑选**：自然待机、抱臂站立、放松抖肩、交谈手势、打电话（空手）、点头回应、伸手互动、轻快舞步。菜单编号 1–8，支持上一段、下一段、重播；切换从动作开头播放，暂停与换装沿用原控制。候选不代表最终选定；用户选择后再精修保留项，尤其是手臂接触、宽袖穿插及脚底。普通站姿仍是用户认可的肩袖角度。

## 已采用：Mesh2Motion / Idle_A

- 官方：[Mesh2Motion](https://github.com/Mesh2Motion/mesh2motion-app#licenses)。项目声明代码 MIT，模型/骨架/动画 CC0；本地许可证副本在 `art/chibi/motion-sources/Mesh2Motion-LICENSE-CC0.md`。
- 固定版本：`3ce7f9d97d25e608b4779ce797da343775ded62b`。
- [原动画包](https://raw.githubusercontent.com/Mesh2Motion/mesh2motion-app/3ce7f9d97d25e608b4779ce797da343775ded62b/static/animations/human-base-animations.glb)，SHA256 `406eb0a8dc4ab366e623b79b6e3005a4951392e1bda78ae39c1099d31147733c`。
- 下载的基础包包含 87 段动作；`wardrobeMotionCatalog.json` 登记本轮 8 段候选及中文标签，生成器从该清单提取。`Idle_A` 时长 3.125 秒，95 个采样；完整模型与贴图不进入发布包。
- 生成器：`pnpm node art/chibi/import-wardrobe-motions.mjs <原动画包路径>`。校验源 hash，以 Three.js GLTFLoader / AnimationMixer 采样源骨架，用源 T 姿势的世界旋转差映射到当前骨名；合并多级脊柱，不导入人体网格或重绑权重。手指沿用既有轻握，前臂 twist 复用项目现有分配函数。
- 运行时不修改骨长、缩放或人物位置。播放及暂停沿用衣橱原动画时钟，换动作不重建角色/衣服。不同体型和大幅动作仍需单独处理接触与脚底稳定；这不是通用重定向器。
- 用户要求扩大候选后加入 `Idle_FoldArms / Idle_ShakeOff / Idle_Talking / Idle_TalkingPhone / Yes / Interact / Dance_Simple`。单次动作首尾不一致时，仅追加 0.45 秒回到首帧的过渡，原动作段不裁改，便于循环试看；电话动作不附带电话模型。

## 本轮查过的其他来源

| 来源 | 结论 |
| --- | --- |
| [VRoid 官方 7 段 VRMA 包](https://booth.pm/ja/items/5512385) | 包含全身展示、招呼、V 手势、射击、转身、模特姿势、深蹲。免费，但禁止未经许可以可提取方式再分发，不能当作开放素材直接提交到本项目 public；未下载或加入。 |
| [Quaternius Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html) | 适合人形动作，单包页标 CC0；[总授权页](https://quaternius.com/license.html) 已列 2026-08-28 的 QAL，限制单独再分发。来源声明存在差异，未直接从其新下载入口导入素材；未来要按具体包的随附许可确认。 |
| [Mesh2Motion 源资产库](https://github.com/Mesh2Motion/mesh2motion-assets) | CC0，保留 Blender/原始动作来源，可供后续制作与筛选。正式压缩 GLB 在应用库。 |

VRoid/VRM 生态提供角色与动作格式，动作文件仍各有自己的授权。也不能把格式支持等同于当前自定义 48 骨角色可以直接播放；需要骨轴/绑定姿势适配及实际预览。

## 验收

`utils/wardrobePose.test.ts` 检查普通站姿不变、旧存档回退、导入动作有实际变化、循环首尾、四元数归一化和不修改活骨架。接入检查现在包含普通站姿、自然待机及两个仅测试使用的退役压力姿势，各取 0.7 秒；它不是全时段动作碰撞验收。旧压力回归继续使用原动作，避免删除 UI 动作后悄悄降低穿模测试覆盖。
