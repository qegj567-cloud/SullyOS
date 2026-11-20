# 打赏 Sully 与本次公告

设置页「主动消息 2.0」下方是「打赏 Sully」入口。保留原版卡片样式与尺寸，按钮文案为「去打赏」。页面保留设置组件挂载，返回后恢复入口焦点、滚动位置和未保存的设置草稿。公告通过 `requestSettingsFocus('support')` 直接打开，支持设置尚未挂载或已经打开两种情况。

## 打赏页

- `components/settings/SullySupportEntry.tsx`、`SullySupportPage.tsx`、`SullySupport.css`；素材在 `assets/sully-support/`，使用 Vite 静态导入，随构建生成内容 hash。
- 说明放在金额参考和收款码之前。用途统一为「所有赞赏将直接用于继续项目的更新与维护。」
- 打赏页用途区与打赏公告使用同一说明：赞赏完全自愿，不影响正常使用，不附带额外权益、更新承诺或优先服务，按意愿与余力支持。
- 七档金额仅作参考；实际金额与署名在微信扫码后填写，页面不承诺预填金额、自动拉起支付或支付成功回调。
- 仅保留微信赞赏，单次上限 ¥200。统一头像后的微信小票已由用户扫码确认可进入原赞赏页；原始码作为备用。README 与 DC 横图均为微信单码版。
- 保存复用 `shareOrDownloadBlob`：提前准备 Blob，点击时同步进入分享流程，保留移动浏览器要求的用户手势；原生封装走已有 Capacitor 分享桥。取消分享不显示保存成功。
- 署名提醒写明公开展示、每月「饲养员感谢名单」，未备注默认为「神秘猫奴」。感谢名单仍由项目组整理，不据页面点击记录捐款。
- 素材由现有 Sully 原画和 CSS 排版组成，没有 AI 生图。设计源文件和小红书末尾图位于 `art/sully-support/`；海报中淡化的小码不用于 App 收款页面。

## 两条一次性公告

复用 `UpdateNotificationController` 的启动队列，新的两条排在最前，由 `components/os/NovemberUpdatePopups.tsx` 渲染：

1. 近期主动消息更新：见面挂起、离开提醒、Worker 更新要求、首次引导优化、大陆中转。中转段落沿用官方版本门禁，替代原来的独立中转公告，避免重复弹出。
2. 打赏介绍：批准的支出与用途说明、备注署名提醒、设置入口；主按钮直接进入打赏页。读完后结束本次队列，旧的未读公告留到下次。

已读 key 在 `utils/novemberNotices.ts`：`sullyos_update_20261115_amsg2_seen`、`sullyos_update_20261115_support_seen`。只在明确点击、关闭或返回时各自记录；仅展示、挂载或卸载不记已读。点击第一条的跳转按钮时，第二条仍未读，下次启动继续展示。

两项 key 已加入 `lsMirror`，且由已有 `sullyos_update_` 规则跨用户空间共享。每个浏览器安装独立记读；没有通知推送、模型调用、支付埋点或捐款数据采集。

## 验证

- `utils/novemberNotices.test.ts`：独立已读、队列与跳转、跨空间、关闭/返回、存储失败、中转门禁。
- `utils/settingsNavigation.test.ts`、`utils/sullySupport.test.ts`：预挂载定位、重复导航、分享手势、错误与取消、原始码返回。
- `scripts/test-sully-support-ui.mjs`：真实设置页面、公告队列、直达、手机/横屏布局、文件下载字节、分享手势、未保存草稿及返回焦点。用 `PLAYWRIGHT_MODULE` 指向可用的 Playwright 安装；可指定 `SULLY_QA_BROWSER_CHANNEL=msedge`。不连接真实支付服务。
