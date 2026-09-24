# 已选动作署名清单

用户于 2026-09-23 确认保留 **1、12、14、16、17**。编号固定，菜单统一放入「已选动作」，另保留普通站姿。交互触发方式尚未确定，不代表这些动作已接入点击/触摸事件。

## 1 · 轻轻待机 / sachi-idle

- 作者：**sashii**；作品：**Sachi VRMA 1**。
- 作者原页：https://booth.pm/ja/items/6412084
- 原文件：`idle-01.vrma`；许可：**CC0 1.0 Universal**。
- 实际取得文件的固定镜像：https://github.com/SanHsien/voxavatar/blob/3061a25dc9c9fa0660e2fc59c50b50f019c5129c/public/assets/animations/idle-01.vrma
- SHA256：`5ed6c016df035b21daaefe64751e1356387c6a33693d31366b0912ac7566ea92`。
- 本地改动：适配当前骨架旋转，合并胸骨，轻握手及前臂 twist；未导入源表情、模型或根位移。
- 许可记录：[VRMA-CC0.md](./VRMA-CC0.md)。

## 12 · MMD 安静呼吸 / mmd-breath

- 作者：**DiSK**；作品：**Eyedart & Breath motion v1.1**。
- 作者原页：https://bowlroll.net/file/231043
- 演示：https://www.nicovideo.jp/watch/sm38411443
- 包内原文件：`Breath_1800F.vmd`；许可：**CC0 1.0 Universal**。
- 原下载 ZIP SHA1：`033e48ca19bf2f178c4ae79eef47afbd444e3bbd`；VMD SHA256：`d1a1cbb09865c3a408cd2a2fad58ad480da0153b0bec47bf57f38000fb3eedc6`。
- 本地改动：七条旋转轨道叠加认可站姿，按 VMD Bezier 曲线采样；没有导入眼神、表情或骨位移。
- 原件：[DiSK-Breath_1800F.vmd](./DiSK-Breath_1800F.vmd)；原许可：[DiSK-Breath-CC0.txt](./DiSK-Breath-CC0.txt)。

## 14 · 交谈手势（收腿版）/ narrow-talk

- 来源项目：**Mesh2Motion**；源动画名：**Idle_Talking**。
- 官方仓库：https://github.com/Mesh2Motion/mesh2motion-app
- 固定原包：https://github.com/Mesh2Motion/mesh2motion-app/blob/3ce7f9d97d25e608b4779ce797da343775ded62b/static/animations/human-base-animations.glb
- 原包 SHA256：`406eb0a8dc4ab366e623b79b6e3005a4951392e1bda78ae39c1099d31147733c`。
- 动作素材许可：**CC0**（项目代码的 MIT 许可不替代素材许可）。未单独确认个人动画师，不虚构个人署名。
- 本地改动：保留 `Idle_Talking` 上身旋转，骨盆与腿替换为认可普通站姿；轻握手、前臂 twist，必要时追加循环回首帧。
- 原许可：[Mesh2Motion-LICENSE-CC0.md](./Mesh2Motion-LICENSE-CC0.md)。

## 16 · 侧头放松、17 · 转头看看 / overte-relaxed、overte-think

- 原动作：**Overte / High Fidelity 系列动画**；VRMA 转换来源：**Hanami / Undi95**。
- 原素材目录：https://github.com/overte-org/overte/tree/master/interface/resources/avatar/animations
- 16 原文件：`idle_once_neckstretch.fbx` → Hanami `relaxed.vrma`，5.57 秒。
- 17 原文件：`idle_once_lookaround.fbx` → Hanami `think.vrma`，取第一次转头段，3.37 秒。
- 固定转换版本：`6787685c8d40e4e79bffbb0d389b478f32ef88d6`。
- 16 文件：https://github.com/Undi95/Hanami/blob/6787685c8d40e4e79bffbb0d389b478f32ef88d6/vrma/relaxed.vrma
- 17 文件：https://github.com/Undi95/Hanami/blob/6787685c8d40e4e79bffbb0d389b478f32ef88d6/vrma/think.vrma
- 16 SHA256：`5e3849bc677f63fb5952583c39102ffdf1adb08b32baa3e4b9de54630a3bb3b9`。
- 17 SHA256：`e28485c2606b4b27869dee84d0a4be7cff9d6eb1a573cf1ea33b3d5a4b5aa3f9`。
- 许可：**Apache License 2.0**；版权：Copyright (c) 2013–2019 High Fidelity, Inc.; 2019–2021 Vircadia contributors; 2022–2026 Overte e.V.
- 本地改动：当前骨架重定向，轻握手与前臂 twist，普通站姿骨盆和腿，必要时加循环回首帧。
- 随附完整 [Apache-2.0 许可证](./Overte-LICENSE-Apache-2.0.txt)及 [Hanami NOTICE](./Hanami-NOTICE.md)，发布时需一起保留。

## 后续致谢页可直接使用

角色动作素材：Sachi VRMA 1 — sashii（CC0）；Eyedart & Breath motion — DiSK（CC0）；Idle_Talking — Mesh2Motion（CC0）；侧头放松与转头动作 — Overte / High Fidelity 系列，经 Hanami / Undi95 转为 VRMA（Apache-2.0）。以上动作已针对本项目骨架适配，其中交谈、侧头放松、转头动作调整为窄站姿；具体源文件、修改说明与许可见本清单。

来源/版本核验及历史候选记录见 [chibi-motion-sources.md](../../../docs/chibi-motion-sources.md)。本文件只登记素材来源，不将解析器、模型或衣服误记为动作作者。
