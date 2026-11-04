# 3D 家园可选资源包

家具架和衣柜继续显示预览图，未下载的万圣节物件置灰但可点击。点击后仅弹「是否下载万圣节资源包？」及大小，用户选确定才下载对应家具包／服装包；取消不下载。下载完成后弹窗关闭，并继续刚才的摆放／穿戴。已下载物件正常显示并直接使用，无单独管理页面或入口。下载中取消会保留已完成文件，下次点击只补齐；已有完整旧包的更新提示可选稍后继续使用旧包。

## 存储与加载

- 小地图始终提供万圣节「活动别馆」入口：尚未追加时，确认素材包下载后才创建并进入；已有别馆（含恢复的整屋存档）也会在进入前检查本机素材包。未安装时询问下载，取消保持当前房间及存档不变，下载完成自动继续进入；已安装直接进入，不重复追加。房间列表入口使用同一检查。

- `apps/room3d/resourcePacks.ts` 使用独立 IndexedDB `sully-home-resource-packs`，不升级主库。`files` 按包 ID + SHA-256 保存 Blob；`packs` 保存当前完整包清单和下载操作标识。
- 下载并发固定为 2，不解析 GLB、不解码图片、不创建 Three 对象。文件长度与 SHA-256 验证通过后逐个落库，暂停、中断或刷新后只补缺失文件。文件自身中断则重下该文件，不保留半个文件。
- 新版本下载过程中保留旧包完整清单。全部文件落盘后，在同一事务内切换完整包指针并清理旧文件；失败不替换旧包。同包操作标识防止另一个页面的旧下载在删除后重新写入。
- `resourcePackGLTF.ts` 先读取本地完整包，不发服务器验证请求；读取模型与它的依赖时使用同一事务和同一包版本。服装的外链共用 JPEG 经 LoadingManager 映射成本地 Blob URL；解析结束释放临时 URL。当前房间和实际穿戴／预览仍沿用原先的按需加载及模板复用，不在下载完成时批量载入模型。
- 家具架和衣柜缩略图也优先读本地，DOM 重建／组件退出时释放 URL。未下载时预览仅用图片，万圣节套装不为预览提前请求 GLB／贴图；点击并确认下载后恢复原有试衣预览。已存在的存档继续兼容原有按需网络加载；已安装但文件缺失时提示补齐，避免把不完整包误报成已就绪。
- 下载使用 `cache: no-store`，现有 SW 按约定不接管这些请求，不新增一份 SW 缓存。原来的按需缓存和推送 SW 行为不改。

## 导出边界

资源库不加入 `DB.exportFullData`、通用附件库或任何备份字段。家具 ID、位置、配色、服装 ID、版型和穿搭参数仍走原来的存档与导出。底层的按包删除接口仅删除独立库中对应包的文件和元数据，不改已摆放家具与穿搭；另一设备恢复存档后可重新下载。

## 发布与校验

`scripts/home-resource-packs.mjs` 从正式家具／衣柜目录选择万圣节资产，解析 GLB 的外链图片和 buffer 依赖，生成 `apps/room3d/resourcePacks.generated.json`。Vite 的 `buildStart` 在开发启动和正式构建时更新清单，因此资源变化会更新文件摘要与包版本，不依赖手填字节数。也可运行 `pnpm node scripts/home-resource-packs.mjs`。

验证命令：

```sh
pnpm vitest run utils/homeResourcePacks.test.ts utils/homeResourcePackGLTF.test.ts utils/wardrobePickerUI.test.ts utils/backupRoundtrip.test.ts utils/home3DBackup.test.ts utils/halloweenWardrobe.test.ts utils/room3dHalloweenFurniture.test.ts
pnpm build
```

隔离浏览器：启动 `pnpm exec vite --host 127.0.0.1 --port 5181 --strictPort`，运行 `pnpm node scripts/test-home-resource-packs.mjs`。可用 `PLAYWRIGHT_MODULE` 指定现有 Playwright 模块，`RESOURCE_PACK_TEST_URL` 指定测试服务。验证灰色预览→确认／取消→自动继续选择，实际下载两个包，确认下载阶段不创建场景；刷新清空页面内存后阻断模型／贴图服务器，调用正式加载器渲染家具与服装，断言资源网络请求为零。结果在 `output/home-resource-packs/`。
