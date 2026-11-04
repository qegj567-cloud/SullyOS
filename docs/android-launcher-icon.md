# Android 桌面图标

APK 在外观 → 应用图标复用网页版入口，但展示独立的 Android 两选一界面。默认水母，可切回经典；不提供上传图片快捷方式。网页版的 PWA 图标、customIcons._pwa_、备份和动态 manifest 逻辑不变。

## 状态与兼容

- 选择以 PackageManager 的实际组件状态为准，不从 PWA 设置或导入备份自动应用。打开页面只读取，不触发切换。
- 没有 LauncherIcon 插件的旧 APK 显示更新提示，不能把修改 favicon 误报为桌面图标已更换。
- 切换仅启停 LauncherJellyfish / LauncherClassic 两个 activity-alias，始终保持 MainActivity 启用，通知及安装后的显式启动仍指向 MainActivity。
- 先启用目标，再停用另一个，使用 DONT_KILL_APP；失败尽力恢复原入口。系统状态异常时可主动重选修复，不允许任意组件名。
- 组件启停由 Android 保留，后续升级必须继续提供相同的两个 alias 名称。不要在每次启动重置选择。
- 桌面可能延迟刷新或重新排列图标；应用管理页等使用 application 图标的界面可能仍显示默认水母。不要建议卸载来刷新。

## 原生壳接入

`native/android/launcher-icon/` 保存 Android 补充源码及测试，不包含签名和个人配置。将其中 main/java、main/res、test/java 合入同包名的原生工程，并在 MainActivity 的 super.onCreate 之前注册 LauncherIconPlugin.class。

从本次 master 原样复制以下资源到 app/src/main/res/drawable-nodpi（不重新设计或替换原画）：

| 网页资源 | Android 文件名 |
|---|---|
| public/icons/jellyfish-512.png | launcher_jellyfish.png |
| public/icons/jellyfish-maskable-512.png | launcher_jellyfish_maskable.png |
| public/icons/icon-512.png | launcher_classic.png |

application 的 icon 和 roundIcon 均使用 @mipmap/sully_launcher。MainActivity 保持 exported=true，移除原 MAIN/LAUNCHER intent-filter；在 MainActivity 声明之后添加：

```xml
<activity-alias android:name=".LauncherJellyfish" android:targetActivity=".MainActivity"
    android:enabled="true" android:exported="true" android:label="@string/app_name"
    android:icon="@mipmap/sully_launcher">
    <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>
</activity-alias>
<activity-alias android:name=".LauncherClassic" android:targetActivity=".MainActivity"
    android:enabled="false" android:exported="true" android:label="@string/app_name"
    android:icon="@mipmap/sully_launcher_classic">
    <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>
</activity-alias>
```

不新增权限，不更换 applicationId、签名、数据目录或 FileProvider。Android 26+ 使用自适应图标，旧系统使用 PNG bitmap。

## 验证

前端：pnpm vitest run utils/nativeAppIcon.test.ts utils/nativeAppIconEditor.test.ts utils/appIcon.test.ts。

原生：gradlew testDebugUnitTest --tests com.aetheros.simulator.LauncherIconControllerTest，另做 release 构建及包内 Manifest、插件、图标哈希核对。状态机单测不等于设备 Launcher 实测。

目标设备验收：旧版覆盖安装后默认水母；切换经典、返回水母、强杀重开后保持；选择经典后覆盖升级仍保留；仅一个启动图标，原数据完整；通知点击和更新安装后的打开动作可用。各厂商桌面缓存行为需要真机确认。

官方机制：[activity-alias](https://developer.android.com/guide/topics/manifest/activity-alias-element)、[PackageManager](https://developer.android.com/reference/android/content/pm/PackageManager)。
