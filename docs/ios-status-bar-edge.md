# iOS 27 主屏幕顶部模糊：安全区兼容处理

## 来源与实机证据

第一轮采用 [OJapp 实机实验](https://tips.ojapp.app/en/ios-27-pwa-top-blur-workaround-2/) 中的 11px 固定元素 + `background-clip: text` 思路。空元素不实际画出色块，但保留 WebKit 顶部取色使用的背景声明。这不是 Apple 提供的关闭模糊 API。

它与 `origin/codex/ios-browser-top-edge` 分支不同：旧候选是 4px 不透明色条，且明确跳过 standalone；本次来自独立测试页 R1 的 C。

用户提供的 iPhone Safari `Version/27.0.1` 主屏幕截图：A 对照在状态栏下缘有暗色模糊过渡，C 没有该过渡，系统栏变成和页面相接的纯色；E 也消除过渡，但额外盖住 11px 网格。用户随后确认 C 在聊天开关、键盘开关、浅色和前后台往返后未复发。

完整应用实机随后仍复现模糊。Safari 远程调试发现两个环境有差异：R1 的 `navigator.standalone=true`、CSS display-mode 为 browser、高度 812px、顶部 env 为 0；完整应用 CSS display-mode 为 standalone、高度 874px、顶部 env 为 62px。不能把最小实验成功直接当成完整应用修复成功。

在同一台手机、同一完整应用里，动态把 `viewport-fit=cover` 改为 `contain` 后，页面高度变为 812px，上下 env 都为 0，顶部网格和文字恢复清晰；改回 cover，模糊立刻返回。移动/增高裁色条、改成不透明色条、去掉外壳合成层、强制深色、模拟滑出面板均未消除过渡。当前 manifest standalone 方案来自这次实机对照；并非旧分支，也不能归因于 OJapp 的 11px 方法。

代价明确：网页内容止于原生状态栏下方，不能在时间/灵动岛区域显示网页文字或完整壁纸。原生区域使用代表底色，复杂纹理/渐变不保证连续。这不是 Apple 提供的关闭模糊 API，也不代表所有设备或未来系统都已验证。

## 实现

入口在 `index.tsx`，处理在 `utils/iosStatusBarEdge.ts`。

- 只启用可识别的 iPhone/iPad/iPod、主屏幕模式、Safari/OS 27 及以上，排除 Capacitor。主屏幕判断复用 `isStandaloneDisplayMode`，兼容 `navigator.standalone=true` 但 CSS 媒体查询仍报告 browser 的实机情况。
- Safari UA 的 CPU OS 可能仍是 18_7，优先用 `Version/` 判断。无 Version 时使用 CPU OS；旧版或无法识别的系统不启用。iPad 桌面 UA 暂不启用。
- 在原有高度/安全区测量之前安装。CSS display-mode 为 standalone 时，将 viewport-fit 改为 contain 并标记 `data-ios-status-bar-contained`；仅 navigator.standalone 为 true 的旧 web-clip 环境保留 R1/C 裁色处理。
- 空元素直接挂 body，固定在顶部，高 11px，不占布局，不拦截触摸，不进入无障碍树。contain 模式同时用顶边代表色替换 PhoneShell 的备用渐变底色，避免系统栏延伸出粉色备用背景；壁纸和应用背景继续正常绘制。不修改状态栏 meta 或版本号。
- contain 中顶部 env=0 是正常的，不能回退到 44px 再留一遍状态栏空间。viewport-fit 的异步生效可能使可视高度由 874px 降至 812px，小于键盘阈值的缩小会重建高度基线，避免底部被旧高度挤出屏幕。键盘弹出/收起仍走同一套高度和键盘态判断。
- 读取页面顶边中点的实际背景层：纯色沿用计算样式，半透明背景和下层合成。聊天自定义 CSS、角色切换、应用切换、锁屏/开屏都通过实际 DOM 反映。
- 图片按居中 cover 取顶行的代表色；最多缓存 12 个源/尺寸结果，每张最多等待 2.5 秒。跨域图片没有 CORS 时回退 CSS 底色，不通过代理获取，不上传像素。渐变使用首个可识别颜色作为近似，不保证任意方向/多层背景精确接色。伪元素、视频和 canvas 内容也不作逐帧像素采样。
- 变更事件合并到 80ms 一次；监听顶部相关结构/样式、样式表、加载和过渡结束、页面恢复、视口变化。忽略正文文本流与下方元素的样式变化，不做常驻轮询。旧图片采样完成后不能覆盖新界面颜色。
- 安装幂等，支持卸载和开发热更新清理，同时恢复原 viewport 和标记。移除入口调用可回退。

## 验证

`pnpm vitest run utils/iosStatusBarEdge.test.ts utils/iosStandalone.keyboard.test.ts utils/databaseStartup.test.ts utils/isStatusBarHidden.test.ts`：门禁、alpha 合成、深浅顶栏更新、contain 安装/还原、零安全区、异步高度收缩后的键盘恢复、幂等/清理、忽略正文更新、过期采样不覆盖新界面，以及原键盘/启动行为。

完整应用还需在手机预览验收：默认桌面、深浅自定义聊天顶栏、独立锁屏壁纸、进入/退出聊天、弹出/收起键盘、前后台往返。跨域图片或复杂渐变顶栏可能只有近似底色。
