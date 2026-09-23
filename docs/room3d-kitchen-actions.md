# 厨房家具动作

2026-09-20：点击家具选择动作，使用房间现有行走系统和同一渲染循环。能力注册在 `apps/room3d/kitchenActivities.js`，不通过中文名称猜测。

- `kitchenware_coffee`：走到咖啡机前，萃取、拿杯、小幅举杯，约 8 秒后结束。
- `kitchenware_plates`、`kitchen_ref_prep`、`kitchenware_settings`、`kitchen_ref_breakfast`：取一只代表盘，端至同房间的可达水槽，冲洗/擦拭约 7 秒，再端回原处。组合里其余盘架、杯盘保持原样，不隐藏整个组合或修改存档数量。
- `show_kitchen_range`、`kitchen_range`：走到灶台前，用临时锅和锅铲搅拌，约 10 秒后结束。样板房临时锅对准空闲右侧炉口，避开原有汤锅。
- 水槽匹配 `show_kitchen_counter`、`kitchen_sink`，排除已收纳物件，严格限当前房间。没有水槽会在盘子动作入口提示；多个水槽选可达路线，不能穿柜子或跨房间借用。

## 路线与生命周期

先检查入口到取物点、取物点到水槽和返回路线。沿承托家具正面取物，中岛允许从背面取盘以避开长凳；旋转承托家具后转换站位坐标。所有行走仍保留实际头宽的避障要求。

`editor.js` 的临时 kitchenTask 分阶段运行 approach → pickup → toSink → work → return → putback。咖啡和煮饭只有 approach → work。每段重新检查路径，布局指纹变化时取消；切房间、改家具、收纳、撤销、换动作、主动休息均清理道具与路线。镜头放大、转向、墙面可见性切换不取消动作。状态和完成提示不写入房屋/角色存档，也不触发对话、联网或真实消耗。

旧圆团体型使用刚性手部轨迹，操作时借助临时两级踏台满足台面高度，端盘行走时回到地面。新骨骼体型复用 FK 手臂/手指姿势，道具跟随实际手骨，不改变骨长或拉伸身体。踏台、杯、盘、海绵、锅铲、水流和泡沫全部复用低面几何，编辑器销毁时释放；不用图片贴图、额外渲染器、定时器或永久灯光。减少动态效果下限制姿势变化，阶段时钟继续正常完成。

## 验收

- `utils/room3dKitchenActions.test.ts`：样板房四种触发点可达、跨房间水槽排除、阻挡拒绝、依赖改变、道具资源复用和清理。
- `art/jellyfish-home/kitchen-actions-qa.mjs`：真实点击三种家具，逐段推进，检查往返、存档不变、主动休息和收纳水槽取消、控制台错误及近景截图。`KITCHEN_BLANK=1` 另验新骨骼体型。
- 隔离预览 `test/fixtures/room3d-showrooms.html?room=kitchen&fresh=1`；附加 `&blank=1` 查看新骨骼体型。正式应用同样使用 editor，不需重新建立已有房间。
