# 用户所在地节假日感知

设置 → 扩展连接 → 实时感知 → 节假日感知。默认关闭，国家／地区不猜测、不定位，由用户选择；可选 ISO 地区代码，不选只使用全国公共假期。

与原有角色日期/星期/时间、纪念日提示并存。仅当用户所在地当天匹配公共假期或调休补班时增加一句话，普通日期、查不到年度数据时不增加文字；不推断用户实际休息，用户日程与说明优先。角色关闭时间感知时，本地和云端都不注入。

提示词里用实际用户名：前台取 userProfile.name，后台取已有 fire_pack.targetName；名字只在渲染时带入，不写入公共日历缓存、不发送给日历数据源。提醒置于共用 ContextBuilder 的「互动对象 (User)」信息区，聊天、见面、通话等复用用户信息的入口共用，不修改用户原始 bio、人设、世界书或记忆。见面架空模式（skipTimeAwareness）不注入；skipUserProfile 的多人分角色块也不重复注入。

更新引导进入原全局更新队列，提供「去填写」/「我不需要该功能」；选择记录存在 userHolidays.introChoice，随配置备份。拒绝时 enabled=false，后续不反复弹，不取数、不注入。设置中仍可重新开启。

## 数据与维护

- 国家列表快照来自 https://date.nager.at/api/v3/AvailableCountries （2026-09-27）。国际日历使用 Nager.Date v3 PublicHolidays，只接受 Public 类型，按 global/counties 过滤，不能据此推算中国调休。
- 马来西亚（MY）不在 Nager v3 支持范围，单独接入 `https://malaysia-holiday.dydxsoft.my/api/v1/holidays?year={year}`（Malaysia Holiday API，按政府公告整理的第三方服务）。必须取不带州属过滤的年度接口并校验 `meta.year`、日期与 `state_codes`；13 州和 3 个联邦直辖区的代码转换为 ISO 3166-2，界面显示中英文名称。只有覆盖全部 16 地的记录才视为全国假期，未选州属不提醒地区假期；例如屠妖节不适用于砂拉越。空年度、未知州属或错误响应不冒充有效日历。仅使用来源已收录的日期，不自行推算补假／临时假期；数据源可能未收录所有后续公告。沿用同年份缓存和失败重试，不发送用户姓名或所选州属。接口文档：https://malaysia-holiday.dydxsoft.my/api/docs ，公告：https://www.kabinet.gov.my/hari-kelepasan-am/ 。新增 MY 同时更新 amsg bundle，旧自托管 Worker 需更新。
- 中国单独使用 NateScarlet/holiday-cn 的公告整理数据（MIT），2026 年日历内置于 `presets/holidays/cn-2026.json`，来源文件的 papers 保留国务院链接。其他年份从项目公布的 jsDelivr 地址获取，年度公告未公布时不猜测。十二月合并下一年的公告（可能包含上一年十二月补班）。内置年份如有修订，需要更新该 JSON 随版本发布。
- 2026 公告：https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
- 数据项目与格式：https://github.com/NateScarlet/holiday-cn
- 浏览器 localStorage / worker client_state 缓存按国家+年份隔离，日历缓存 24 小时，请求超时 3 秒；失败仅复用同国家同年份的已有日历，进程内一小时后再试。地区筛选在本地完成。

## 时间、备份与云端

`RealtimeConfig.userHolidays` 随现有实时感知配置进入完整备份/文本备份，并由原导入流程恢复；缓存不属于用户数据，无需备份。国家、地区不发统计。

用户日期按设备时区；浏览器每次请求使用当前设备时区，buildToolConfig 同步该时区供 amsg 到点计算，不能使用角色 tzId 或 Cloudflare 的 UTC。旅行换时区后，浏览器下次同步工具配置才会更新云端时区。

前台 OSContext 在启动、切回前台和每小时预热日历，ContextBuilder 每次按当日读取缓存（未知不注入）；ChatApp 在构建前还会等待一次有时限的日历准备。同步 ContextBuilder 不发网络请求、不改变既有接口。后台 `realtimeWorld.buildUserHolidayBlock` 到点取数，写回原用户信息区；旧模板没有该区时追加用户信息补充。不会把打包时的假期烤进云端模板。部署旧版 amsg 的用户需要更新自己的 Worker，才会在云端生成时得到提醒。

验证：`pnpm vitest run utils/userHolidays.test.ts utils/realtimeWorldCore.test.ts worker/amsg/src/realtimeWorld.test.ts utils/amsgToolPack.test.ts`。
