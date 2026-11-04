# VRoid 方向的人物风格化（2026-10-29）

用户明确希望接近 VRoid 的风格化观感。此次调整正式小屋的 `chibi/illustration.ts`，并让捏人器 `Puppet` 在人物生成、服装载入后使用同一套材质；两套素体均覆盖。裸模材质对照仍沿用原设置。

## 方法

参考 [MToon 材质说明](https://vrm.dev/en/univrm/shaders/shader_mtoon/) 与 [VRMC_materials_mtoon 规范](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_materials_mtoon-1.0/README.md) 的独立阴影色、明暗边界偏移与羽化、面部特殊参数和受光边缘处理。另阅读 [Unity Toon Shader](https://github.com/Unity-Technologies/com.unity.toonshader) 的三色及边缘光设计。

本实现借鉴这些机制，仍是项目自有 Three.js 材质扩展，并非引入完整 MToon/VRM 渲染器。保留原贴图、顶点色、剪裁透明、服装染色钩子和骨骼。

- 明暗分界改为法线与主光方向控制，环境光强度不再把整个角色推入同一个亮区。
- 衣服与头发使用偏冷的阴影色；面部更浅、更柔和，保留眼睛、嘴与皮肤原色。
- 保留轻微体积渐变，头发加受控高光，边缘在现有材质中塑形。没有新增轮廓网格或全屏描边通道；此处不是完整几何描边。
- 实际房间阴影仍被采样，白天/夕阳/夜晚使用原有共享光照色和亮度；不同房间的 uniform 不互相污染。

## 验证与预览

- `pnpm vitest run utils/chibiIllustration.test.ts utils/wardrobeColors.test.ts --no-cache --maxWorkers=1 --minWorkers=1`：9 项通过，包含材质钩子组合/恢复、场景隔离、着色器缓存分离及服装染色资源。
- 拍照与捏人两个独立正式模块入口的生产构建通过。全库 TypeScript 现有错误记录在拍照任务中，不声称全库检查通过。
- `review.mjs before/after/classic`：真实 WebGL 下测试三种光照，页面/着色器错误均为空；`before` 目录在改动前保存，基线源码为 `illustration-before.ts`。
- 完成资源加载后的夕阳/夜间相同场景，改前改后均为 90 次绘制、308235 三角面；着色器程序数 20 → 21（新增头发差异）。首屏资源异步到达会改变计数，不能用首次白天帧作严格性能比较。这不是 FPS 测量。
- `preview-review.mjs` 检查捏人器两套素体正面与侧后方，转向不重建人物；错误与失败请求为空。`skill-qa` 为 develop-web-game 客户端截图。

本地：`http://127.0.0.1:5206/test/fixtures/chibi-toon.html`；同机位原片对照：`http://127.0.0.1:5206/art/toon-style-2026/compare.html`。修改尚未部署。


### 新旧人物渲染切换（2026-10-29）

光影与画质 → 人物渲染提供「新版 · 风格化」「旧版 · 经典」，缺省和非法值回退新版。本机偏好键为 sully-home3d-character-style，不写角色或房屋数据。小屋旧版恢复此前 v3 插画着色，捏人旧版恢复改动前的原始材质；新旧切换保留光照 uniform、染色钩子、模型与动作。现有小屋和捏人预览通过订阅即时更新，跨标签 storage 事件同步，销毁时取消订阅；存储受限时本次仍可切换。

13 项材质/染色/偏好测试与两入口构建通过。浏览器验证默认新版、切换后的原片变化、刷新记忆、跨标签同步及人物实例复用，报告见 art/toon-style-2026/style-qa/report.json。


### 夕阳去紫与降低冷暖反差（2026-10-29）

根据用户久看反差过强的反馈，夕阳环境/地面补光与阴影改为低饱和暖灰，直射光从浓橙调整为浅杏色，降低直射强度、家具日照反差及柔光强度。新版人物以共享 roomShadeSoftness 中和阴影系数的蓝紫偏色并放柔分界，不降低服装/头发本身的色彩饱和度；其他时段将该 uniform 恢复为 0。新旧版选择继续有效，时段与时区规则保持原状。

三时段原片复核无页面或着色器错误，20 项光照/材质测试通过，拍照与捏人入口构建通过。同机位对照见 art/toon-style-2026/sunset-compare.html，截图与报告在 sunset-before / sunset-after。
