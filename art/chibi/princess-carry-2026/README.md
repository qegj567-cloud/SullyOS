# 公主抱动作修整 · 2026-10-29

正式入口仍为 `home-princess-carry` / `home-princess-carried`。共用 `selectedSocial.ts` 与 `princessCarry.ts`，家园互动、拍照和动作预览使用同一套实现；只支持二号素体，保留浪漫关系校验、角色交换、取消与完成复位。

## Meshy 来源

实际调用 Meshy Text-to-Motion Prime，两段 10 秒 FBX，共 **20 credits**；本轮前后余额 476 → 456。任务、提示词、哈希、消耗保存在 `motions/ledger.json`，没有保存 API Key。

| 角色 | 任务 ID | SHA-256 |
| --- | --- | --- |
| 抱起者 | `01a18617-ddac-7627-8370-d15aa1cff25b` | `9977d7bf31187af05454dbed5c0cbbe28d98398512affdf851945b4d1b63fd64` |
| 被抱者 | `01a18617-e109-73cb-bc34-d14e09b88eab` | `a6f1c27d297ebf52e0e102f1e364a853f6c0751865c30de29a73441076fcc4af` |

`meshy-motion.mjs` 支持 submit/status/download，密钥从进程环境 `MESHY_API_KEY` 读取。账本防止重复提交；本轮任务已经完成，不需要再次付费生成。`pnpm exec node art/chibi/princess-carry-2026/import-motions.mjs` 验证源 FBX 哈希后，采样为每角色 301 帧并更新两份正式 JSON 与目录来源。FBX 仅保存在本地制作目录，不作为运行时模型发布。

## 动作校正

这不是一次完整的双人动捕：两个角色分别由 Meshy 生成，再进行双人对位。保留经过幅度约束的躯干、肩、颈、头变化，独立手臂轨道交给接触解算，腿部和位移按小人比例重新编排。

- 先屈膝蓄力，再侧身、收腿、抱起；抱稳时有呼吸、靠近和脚踝变化。
- 托背、托膝、搭肩分别追随对方骨骼，固定肘部弯曲平面；接近手臂最大长度时柔和收敛，避免直肘奇点及手腕翻转。
- 先落脚，再解除支撑，最后手臂回到身侧。身高差较大时，被抱者提前触地，脚底不能穿过地面。
- 所有姿态按当前时刻重新计算，拖动时间轴、倒放查看或取消不会积累位移；骨骼长度保持不变。

## 复查

`motion-review.mjs home-princess-carry home-princess-carried --extreme` 检查 80% / 125% 身高，采样全部 301 帧并保存分镜与连续性报告。`contact-inspect.mjs` 保存近景和骨骼样本。测试页是 `http://127.0.0.1:5202/test/fixtures/room3d-social.html`，选择「公主抱」或「被公主抱」。

这些是本地正式代码与资源的修改，未部署。手掌使用有限长度骨骼的近似接触；不同服装厚度可能仍有轻微遮挡，不是布料或全身碰撞模拟。
