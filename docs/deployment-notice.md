# 启动时的版本来源提醒

`PhoneShell` 在开机动画与数据加载完成后、锁屏与其他启动提示之前展示一次来源提醒。检查未完成或公告未确认时，其他启动提示与空闲预加载等待；浏览器与 Android 返回不能确认公告。确认后继续原有流程，不改变锁屏状态。

## 来源判断

`utils/deploymentSource.ts` 将来源分成 `official`、`unofficial`、`unknown`，不请求网络，不上传地址、签名或用户数据。

- 网页官方域名精确匹配：`qegj567-cloud.github.io`、`sully-os-nu.vercel.app`、`friedsully.com`。不放行整个平台或任意子域名。
- 其他公开域名展示「当前使用的糯米机版本是非官方／二改版本」。
- `localhost`、`.localhost`、`.local`、无点主机名、IP 地址、文件或无法解析的地址展示「无法确认当前使用的糯米机是否为官方版本」。
- 原生 Android 优先读取现有 `ApkInstaller.getInstalledInfo`，同时核对包名与签名证书 SHA-256，不使用 WebView 的 `localhost` 或分支名判断。包名或有效指纹不匹配为非官方；插件缺失、读取失败、指纹无效、超过 3 秒未返回或其他原生平台均为无法确认。

官方 APK 的身份依据为 [android-v3.5.11 Release](https://github.com/qegj567-cloud/SullyOS/releases/tag/android-v3.5.11)，于 2026-10-16 下载并用 Android SDK `apksigner verify --print-certs` 核实签名，用 `aapt dump badging` 核实包名：

| 项目 | 值 |
| --- | --- |
| 包名 | `com.aetheros.simulator` |
| 签名证书 SHA-256 | `d644dddeeb6e00191f90cf621cca2649f372a653c2c37066def2f8f9c81ef1c8` |
| APK 文件 SHA-256 | `6c4fc2e8b3ed154ef9b65a04d9d5942193068a652085bb7045c768791026d8ab` |
| Release 对应提交 | `6acadfd267096ce4aa3b308cf6ee65e9e64b5859` |

证书指纹与文件哈希不同。识别名单保存证书指纹，后续版本沿用同一签名即可继续识别；正式更换签名时需核实新 APK 并更新名单。Release 说明为同步 master、原生壳单独打包；仓库历史上的 `TIAO-Capacitor` 分支不能当作官方身份依据。本次仅修改网页源码，下次 APK 打包需带入这些改动。

## 确认与显示

公告实际挂载时才开始 10 秒倒计时，使用单调时钟，不受修改设备日期影响。按钮禁用与点击处理各自检查时限；没有关闭按钮，背景、Escape 与返回都不标记已读。文案中的版本来源、全部聊天记录、API 密钥及恶意代码风险以红色加粗突出；未知来源的免责句仅指非官方版本，避免把未核实的安装包直接定性为二改。

只有点击可用的「确定」才写入 `sullyos_deployment_notice_v1_accepted=1`。它是当前浏览器／站点的记录，不加入个人备份；未确认就退出，下次重新展示并倒计时。清除站点数据、换浏览器或换站点后重新提示。存储不可写时仍允许继续，只在当前页面会话记住确认。

测试：`pnpm vitest run utils/deploymentSource.test.ts utils/deploymentNoticeUI.test.ts`。
