# 时光契约 · Capacitor 安卓系统闹钟

## 给另一台电脑的打包助手

这次改动包含原生 Java 插件，**只拉网页资源、只执行 `cap sync` 或只热更新前端都不够**。先确认所拉分支已包含本文件与 `scripts/sync-native-system-alarm.mjs`，再执行下面的接入步骤并重新生成 APK。不要覆盖原生壳的签名、Firebase 配置、图标、推送插件或已有 MainActivity 逻辑。

在 SullyOS 源码目录，使用现有脚本打包时：

```powershell
pnpm install
powershell -ExecutionPolicy Bypass -File scripts/sync-tiao-capacitor.ps1 -WrapperRoot 'D:\CHICK\CHICK2'
```

路径替换成实际安卓壳目录。这个脚本已经接入系统闹钟同步：复制 `SystemAlarmPlugin.java`，给 Manifest 添加 `com.android.alarm.permission.SET_ALARM` 和 `SET_ALARM` 的 package visibility 查询，并在 MainActivity 的 `super.onCreate` 前注册插件，然后同步 Capacitor 并构建。

如果该电脑用自己的构建流程，在构建 APK 前加一步：

```powershell
node scripts/sync-native-system-alarm.mjs 'D:\CHICK\CHICK2'
```

随后照原有流程构建网页、同步 Capacitor、构建并签名 APK。同步脚本可重复执行，不改 applicationId；目前支持包名 `com.aetheros.simulator` 的 Java MainActivity。自定义生命周期无法安全定位时会停止且不写文件；此时手动在 `super.onCreate` 前加入 `registerPlugin(SystemAlarmPlugin.class);`，再重跑脚本。Kotlin 壳或其他包名按同样机制手工接入，不能硬套路径。

## 用户行为与接口边界

- 仅安卓原生 APK 在未完成待办和纪念日旁显示「闹钟」。浏览器/PWA 和 iOS 不冒充原生支持。旧 APK 显示“更新 APK”的说明。
- 用户点闹钟，选手机本地响铃时刻，阅读日期限制，再点「创建闹钟并打开时钟」。插件发送 `AlarmClock.ACTION_SET_ALARM`，只带小时、分钟、标题和 `EXTRA_SKIP_UI=false`，让用户核对系统时钟。
- Android 的通用接口不接受年月日。本次只创建下一次该时刻的闹钟，**不会把某月某日转成每周重复，也不会承诺纪念日当天响铃**。日期在确认界面单独展示；特定日期/重复规则需用户在支持的系统时钟中调整。
- 系统时钟可能直接创建闹钟；返回只代表请求已交接，不能证明用户最终保存。UI 不显示“已成功设置提醒”。没有时钟、权限被拒、插件缺失分别给出可理解的提示，失败可重试。
- 系统闹钟由时钟应用持有。完成/删除待办、切换用户、恢复备份或重装糯米机都不自动撤销或重建它。没有新增本地表、设置键、后台调度器或云端数据。只有用户明确点按钮才交接；打开页面和恢复备份不会创建闹钟。
- 这是普通 `SET_ALARM` 权限，不申请精确闹钟、通知或后台保活权限，不使用 `AlarmManager`、全屏通知和云推送来代替系统时钟。

## 验证与发布前检查

仓库回归：

```powershell
pnpm vitest run utils/nativeAlarm.test.ts scripts/sync-native-system-alarm.test.ts utils/timeContract.test.ts
```

`scripts/test-time-contract.mjs` 验证窄屏日历、内部滚动、完成记录删除、主题与原生桥的模拟交接；模拟测试不等于真机闹钟验收。本轮编写环境没有 Android 壳、SDK 或 JDK，未在本机生成 APK。

打包电脑需编译 Android，并在目标手机覆盖安装验证：

1. 网页/PWA 不显示原生闹钟入口；旧 APK 配新前端时显示升级提示。
2. 待办和纪念日的闹钟入口都可用，选一个近期时刻，交接后系统时钟显示正确时间和标题；确认实际响铃。
3. 日期在下个月的条目仍清楚提示接口不绑定日期，不能无声变成每周重复。取消糯米机弹窗不创建；在时钟里取消/删除由系统处理。
4. 连点提交不重复打开；返回糯米机后原数据保留；完成/删除条目不擅自删除系统闹钟。
5. 没有可用时钟应用时提示失败。华为等厂商机型的处理和界面须真机确认，不能仅以 Intent 已发出宣称成功。

官方依据：[Android AlarmClock](https://developer.android.com/reference/android/provider/AlarmClock)、[常见 Intent：创建闹钟](https://developer.android.com/guide/components/intents-common#Clock)。
