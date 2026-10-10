# iOS 27 主屏幕顶部模糊：裁色兼容处理

## 来源与实机证据

采用 [OJapp 实机实验](https://tips.ojapp.app/en/ios-27-pwa-top-blur-workaround-2/) 中的 11px 固定元素 + `background-clip: text` 思路。空元素不实际画出色块，但保留 WebKit 顶部取色使用的背景声明。这不是 Apple 提供的关闭模糊 API。

它与 `origin/codex/ios-browser-top-edge` 分支不同：旧候选是 4px 不透明色条，且明确跳过 standalone；本次来自独立测试页 R1 的 C。

用户提供的 iPhone Safari `Version/27.0.1` 主屏幕截图：A 对照在状态栏下缘有暗色模糊过渡，C 没有该过渡，系统栏变成和页面相接的纯色；E 也消除过渡，但额外盖住 11px 网格。用户随后确认 C 在聊天开关、键盘开关、浅色和前后台往返后未复发。

这证明了该设备上的最小实验效果，不代表完整应用、所有 iPhone 或未来系统版本都已验证。图片没有延伸到系统时间/灵动岛区域；“纯色接上”不应表述为“壁纸贯穿安全区”。

## 实现

入口在 `index.tsx`，处理在 `utils/iosStatusBarEdge.ts`。

- 只启用可识别的 iPhone/iPad/iPod、主屏幕模式、Safari/OS 27 及以上，排除 Capacitor。主屏幕判断复用 `isStandaloneDisplayMode`，兼容 `navigator.standalone=true` 但 CSS 媒体查询仍报告 browser 的实机情况。
- Safari UA 的 CPU OS 可能仍是 18_7，优先用 `Version/` 判断。无 Version 时使用 CPU OS；旧版或无法识别的系统不启用。iPad 桌面 UA 暂不启用。
- 空元素直接挂 body，脱离外壳 containment、动画和滤镜。固定在顶部，高 11px，不占布局，不拦截触摸，不进入无障碍树。不修改 viewport、状态栏 meta、safe-area padding、键盘避让与版本号。
- 读取页面顶边中点的实际背景层：纯色沿用计算样式，半透明背景和下层合成。聊天自定义 CSS、角色切换、应用切换、锁屏/开屏都通过实际 DOM 反映。
- 图片按居中 cover 取顶行的代表色；最多缓存 12 个源/尺寸结果，每张最多等待 2.5 秒。跨域图片没有 CORS 时回退 CSS 底色，不通过代理获取，不上传像素。渐变使用首个可识别颜色作为近似，不保证任意方向/多层背景精确接色。伪元素、视频和 canvas 内容也不作逐帧像素采样。
- 变更事件合并到 80ms 一次；监听顶部相关结构/样式、样式表、加载和过渡结束、页面恢复、视口变化。忽略正文文本流与下方元素的样式变化，不做常驻轮询。旧图片采样完成后不能覆盖新界面颜色。
- 安装幂等，支持卸载和开发热更新清理。移除入口调用可回退。

## 验证

`pnpm vitest run utils/iosStatusBarEdge.test.ts utils/iosStandalone.keyboard.test.ts utils/databaseStartup.test.ts utils/isStatusBarHidden.test.ts`：门禁、alpha 合成、深浅顶栏更新、无布局遮挡、幂等/清理、忽略正文更新、过期采样不覆盖新界面，以及原键盘/启动行为。

完整应用还需在手机预览验收：默认桌面、深浅自定义聊天顶栏、独立锁屏壁纸、进入/退出聊天、弹出/收起键盘、前后台往返。跨域图片或复杂渐变顶栏可能只有近似底色。
