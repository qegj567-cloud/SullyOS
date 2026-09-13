# 自定义 PWA 应用图标

## 2026-09-14 原画修订

新版来自用户的 logo2.png，重新生成 180 / 192 / 512 PNG 与独立 maskable 图；只等比缩放和留安全边距。资源版本 38b1adde1d，主 manifest 地址和应用身份不变。经典图标及用户上传图标保留。

## 2026-09-13 内置图标选择

默认网页图标和 PWA 图标改用用户提供的水母原画，按比例制作 180 / 192 / 512 PNG；maskable 版独立留安全边距。原来的图标文件保留，通过「外观 → 应用图标 → PWA 应用图标」选择「经典」。已有上传或链接图标不会被新版默认覆盖。

经典选择仍存于 customIcons._pwa_，值为 builtin:classic；水母默认不存额外值。经典使用随包的 manifest-classic.webmanifest，与主 manifest 保持相同 start_url / scope。自定义上传继续走 blobRef 与备份管线。

当前实现更新：普通浏览器和 standalone 均更新 manifest，确保安装前选择生效；旧文中“非 standalone 不更新 manifest”的描述已被本节取代。异步图标加载带版本校验，慢请求不能覆盖后一次选择或重置。

回归：utils/appIcon.test.ts；scripts/test-app-icon-choice.mjs 覆盖二选一、刷新、自定义上传、重置和 320px 布局。

## 这是什么

用户在「外观定制 → 应用图标」里上传一张图（或填图床链接），直接当 SullyOS 的主屏图标用。
iOS 和 Android 两边都支持，不需要把图传到公网。

## 怎么做到的

启动时 JS 动态注入两样东西：

| 平台 | 注入点 | 怎么写 |
|------|--------|--------|
| iOS | `<link rel="apple-touch-icon">` | `href` 直接写 `data:image/png;base64,...` |
| Android / Chrome | `<link rel="manifest">` | 用 `URL.createObjectURL(new Blob(...))` 生成临时 manifest，图标 `src` 写 data: URI |

2026-08-04 真机实测 iOS 26.5.2 和 Android 17 (Chrome, Pixel 8) 都认 data: URI，两端全通。

## 已安装图标更新取决于平台（2026-09-14 更正）

功能和网页资源可随正常更新加载，无需卸载。主屏图标属于安装元数据，不能保证即时同步：

- Android Chrome 安装的 WebAPK 支持检查稳定 manifest 并更新 icons；通常需要启动过应用并等待系统调度。
- iOS / iPadOS 的已安装主屏图标通常需要重新添加才更新。
- 自定义图标使用临时 blob manifest，无法承诺现有安装会自动同步；图标选择首先保障下一次安装。

依据：[Chrome manifest 更新](https://web.dev/articles/manifest-updates)、[PWA 更新机制](https://web.dev/learn/pwa/update)。不要改变 manifest URL、start_url 或应用身份来强迫刷新。本次只给默认图标资源加内容版本查询参数。

若为更换图标而卸载或重新添加，先从现有 PWA 导出完整备份并确认文件保存；尤其不要假定 iOS 主屏应用与 Safari 共享存档。

## 涉及的文件

### 新建

| 文件 | 干什么 |
|------|--------|
| `utils/appIcon.ts` | 注入/清除 PWA 图标的核心逻辑：读 blobRef 令牌→解出 data URL→写进 DOM |
| `components/appearance/AppIconEditor.tsx` | 上传/链接切换、预览、环境感知警告 |

### 改动

| 文件 | 改什么 |
|------|--------|
| `apps/Appearance.tsx` | 「应用图标」标签页顶部塞 PWA 图标卡片 |
| `context/OSContext.tsx`（轻量） | 启动时读已保存的 PWA 图标并注入；提供读取入口 |

## AppIconEditor 的 UI

### 模式切换

提供两个 tab 切换，同一时间只展示一种：

- **上传图片**：文件选择器（accept image），选完即时预览
- **填入链接**：文本输入框，输完点「确认」拉图并预览

### 环境感知提示

按浏览器 / standalone 显示简短说明：标签页及下次安装使用当前选择；已安装图标由平台更新，功能更新无需重装。如需重新添加，先导出完整备份。不要再把所有平台统一写成“只能卸载重装”。

### 图标状态

- 已经设了自定义图标 → 显示当前图标预览 + 「重置为默认」按钮
- 没设过 → 显示默认图标 + 引导文字

## appIcon.ts 的接口

```ts
// 把 blobRef 令牌解成 data URL 并注入 DOM。
// standalone 下同时替换 manifest 和 apple-touch-icon；
// 非 standalone 下只换 apple-touch-icon（浏览器标签页图标）。
async function injectPwaIcon(blobRef: string): Promise<void>

// 恢复默认图标（删掉注入的 link/manifest，指回原始文件）。
function clearPwaIcon(): void

// 启动时调用：检查是否有已保存的 PWA 图标，有就注入。
async function initPwaIcon(customIcons: Record<string, string>): Promise<void>
```

内部细节：
- manifest 替换要处理路径问题：`blob:` URL 的 manifest 里所有相对路径都会相对 blob 解析导致 404，所以动态 manifest 里的 `start_url`、`scope`、备用图标等全部折成绝对地址
- `apple-touch-icon` 直接设 `data:` URI，没有路径解析问题
- manifest 只在 `display-mode: standalone` 时替换——浏览器里替换 manifest 没意义，还可能在 DevTools 里刷出一堆 blob URL 干扰调试

## 存储

复用现有 `customIcons` 体系，appId 用特殊值 `_pwa_`：

- `setCustomIcon('_pwa_', blobRef)` — 存图
- `setCustomIcon('_pwa_', undefined)` — 重置
- 图走 `blobRef` 管线：压缩后的 Blob 存 IndexedDB blob_assets，字段里只存 `blobref:...` 令牌
- 备份导出链路已通：`resolveBlobRefsDeep` 会把 `_pwa_` 的令牌转回 data URL，跟其他自定义图标一起打进备份包

## 不想做的

- 不按角色换图标——通知图标来自 `showNotification` 的 `icon` 字段（Android）或 PWA 主屏图标（iOS），不是前端能动态改的
- 不做图标裁切/编辑器——传图前自己裁好，组件里只做等比缩放和压缩
- 图的大小上限 512px（跟现有 `handleIconUpload` 一样），覆盖 180、192、512 三个尺寸需求
