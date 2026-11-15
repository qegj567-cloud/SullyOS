# Android AMSG2 / UnifiedPush 收件桥

这里保存 Android 壳使用的原生桥源码，不包含签名、个人 Worker 地址或配置。
网页、Worker、正文/情绪/后台结果的业务实现仍以 master 为准。Android 只替换浏览器推送的接收端：
用户自己的 Worker → 标准加密 Web Push → UnifiedPush distributor（如 ntfy）→ 原生通知和持久收件队列 → master 的处理器。
不使用 Firebase，不替代 ntfy，也不在 Android 本地再生成回复。

这是已有系统推送配置的兼容桥，并非 APK 必走的独立流程。设置入口、第三方服务商及默认选择与网页版共用；选择 WxPusher / Bark / MeoW 时走 master 的第三方推送实现，不依赖此桥，也不需要另配 ntfy。升级不自动更换用户已有推送方式。

## 构建契约

- 将 `main/java/` 中的文件同步进 Capacitor Android 工程的 `app/src/main/java/`；测试放进 `app/src/test/java/`。
- 保留现有 Manifest 的 `AmsgUnifiedPushReceiver` / `AmsgUnifiedPushService` 声明，以及 MainActivity 在 `super.onCreate` 前注册 `AmsgUnifiedPushPlugin` 的步骤。
- 原生依赖 `org.unifiedpush.android:connector:3.3.2`；测试依赖 JUnit 4.13.2 与 `org.json:json:20231013`（后者仅 testImplementation）。
- Web 侧 `utils/unifiedPushPlugin.ts` / `utils/unifiedPushRuntime.ts` 与桥 v2 **必须一起打包**；不能只替换其中一半。
- 运行 `:app:testDebugUnitTest`、前端 nativeAmsgInbox/unifiedPushRuntime/nativeNotificationNavigation 测试，再构建 release。APK 的递增版本号与网页的大功能版本号独立。

## 与 master 对齐的行为

- 正文进现有 inbox；`emotion_update` 保留空完成/错误尾包与全部元数据；`result` 交给已有结果分发器；`error` 交给即时聊天失败处理器。内部 reasoning/tools 不冒充聊天。
- 结果未被接收、数据库失败、结果属于另一个用户空间时，不确认原生队列；下次恢复前台再试。正文在全局 inbox 中按原有空间规则入库。
- 队列读取不再清空：每条都有稳定 ID，成功处理才 ACK。保留原先最多 100 条的上限；这不是无限归档，云端 outbox 的保留与补收规则不变。
- 原生接收、分片完成记录及去重标记先同一次持久提交，再通知 WebView。分片遵循 amsg-shared 的 multipart v1：UTF-8 字节、base64url、1 起始序号、最多 128 片/256000 字节/60 秒，最多 16 个并行组。
- 按 `notification.show`（always / when-hidden / false）、silent、tag、renotify 处理通知；通知专用预览优先于私密正文。情绪/错误默认不弹系统通知，后台 result 是否通知取决于 Worker 的策略。
- 原生已决定通知策略的正文不会再由 WebView 补弹一条本地通知；点击冷启动通知会等 UI 就绪再走现有跨空间导航。
- 新版“测试推送”的原生回执保留真实接收时间与通知 API 调用结果，以 `side: native` 写入独立诊断库，不冒充 SW；没有回执不记为成功，测试通知不打开虚构角色，不导出普通消息正文。
- distributor 端点变化后记录待同步版本；仅在 2.0 总开关开启、Worker 已配置且不是第三方推送模式时补登记。成功后才确认；不后台轮询、不反复重新注册 distributor。

## 真机验收边界

必须分开测试：前台、按 Home 退后台、划掉任务后、系统“强行停止”。后者会限制应用被唤醒，不能承诺继续推送。
ntfy 必须已经打开并正常连通，通知权限与厂商后台限制也会影响结果。
只有再次打开 App 后出现聊天内容，可能只是 outbox 补收，**不能作为关 App 推送成功的证据**。
单元测试通过也不等同于厂商 ROM 的后台通知验收。
