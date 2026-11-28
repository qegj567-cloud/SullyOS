# 全站 API 槽位、预设引用与自动保存

全局主对话、角色独立 API、各类副 API（记忆宫殿、情绪评估、心象翻译、独立识图）以及各独立应用（哔哔、彼方、查手机、家园、自习室、模拟人生、协同工作）统一使用同一套 API 槽位组件与预设引用解析器。

## 数据结构与预设引用

所有对话类接口配置统一采用 `DialogueApiConfig`（见 [`types.ts`](../types.ts) 和 [`utils/apiSlots.ts`](../utils/apiSlots.ts)），在保留内联连接字段（`baseUrl`、`apiKey`、`model`、`apiType` 等）的同时携带可选的 `presetId` 与 `presetFp`：

- **跟随默认**：槽位为 `undefined`（或三项连接字段均为空）。运行时沿各业务自身的跟随链向上回退（例如应用独立 API → 角色独立 API → 全局主对话 API；记忆宫殿、情绪评估、心象翻译、自习室、模拟人生、家园未单独配置时回退至全局主对话 API）。
- **绑定预设**：`presetId` 指向 `os_api_presets` 中的条目，且 `presetFp` 与内联连接字段的指纹一致。运行时通过 `resolveEffectiveSlot` 实时读取该预设的最新配置。
- **单独填写**：未携带 `presetId`，仅对当前槽位生效。

### 保留内联快照与指纹的原因

同一浏览器下的 Canary 通道与正式版共用同一份 IndexedDB 和 localStorage（见 [`canary-channel.md`](./canary-channel.md)）。槽位内保留完整的内联连接快照，可确保：

1. 切换回不识别 `presetId` 的版本时，内联字段直接可用，请求不会中断；
2. 当某条预设被修改时，`OSContext.updateApiPreset` 与 `refreshPresetSnapshotsEverywhere` 会同步刷新全局设置及各用户空间数据库中的所有绑定快照，并在末尾合并触发一次主动消息 2.0 云端凭据同步；
3. 当某条预设被删除时，原引用处自动退化使用删除前的最新内联快照继续运行，打开面板时提示原预设已删除并可一键改绑或转为单独填写；
4. 若不识别 `presetId` 的外部入口直接改写了内联连接字段，读取时检测到内联指纹与 `presetFp` 不一致，会自动视为单独填写，避免旧预设覆盖新填写的连接。

## 编辑边界与所见即所得自动保存

标准组件 [`ApiSlotEditor.tsx`](../components/settings/ApiSlotEditor.tsx) 与 [`ApiPresetEditorModal.tsx`](../components/settings/ApiPresetEditorModal.tsx) 采用自动保存机制：

- **绑定预设后直接显示紧凑表单**：复用 ApiPresetEditorModal 的内联模式，直接修改接口、URL、Key、模型与参数，仍经 updateApiPreset 同步全部使用位置；不展示摘要卡片或独立配置按钮。上方随时选择其他预设，名称、分组、复制和删除由长按管理。
- **自动保存的提交门禁**：切换预设、选定模型、拨动开关立即落盘；文本编辑仅在输入框失焦时校验；输入和停顿期间不写入、不触发全局同步，，仅当「地址为合法 HTTP(S) 且模型非空（密钥允许为空以支持本地免密模型）」或「连接字段全部清空（恢复跟随）」时才提交存储与云端同步。填了一半的半成品只停留在面板内并提示缺失项，关闭面板时自动丢弃未完成草稿，防止半截密钥进入后台任务或云端凭据表。
- **地址规范化时机**：打字过程中保持输入原样不改写光标位置；在输入框失焦或切换接口类型时执行 `normalizeLlmBaseUrl`（例如 Anthropic 原生接口自动规范为 `/v1/messages`）并回显。

## 副 API、云端凭据与流式隔离

- **副 API 统一回退主对话 API**：记忆宫殿副 API（`memoryPalaceConfig.lightLLM`）、全局情绪副 API（`apiConfig.emotionApi`）和心象翻译 API（`apiConfig.thinkingTranslationApi`）留空时均整套回退至解析后的全局主对话 API。任何槽位在单独配置时均整套采用自身凭据，禁止跨配置逐字段补齐。
- **主动消息 2.0 云端凭据重算**：主对话 API、预设增删改、全局情绪副 API 与记忆宫殿副 API 变更时，统一通过防抖队列重算所有用户空间角色的 `chat`、`emotion` 和 `memory` 云端凭据行（见 [`amsgStateSync.ts`](../utils/amsgStateSync.ts)），确保副 API 留空回退主 API 的场景下更换主密钥后云端后台整理同步更新。
- **透明流式升级同源隔离**：[`streamUpgrade.ts`](../utils/streamUpgrade.ts) 优先遵循槽位自身显式声明的 `slotStream`；未显式声明时仅对与全局主对话 API 同源的请求启用防空闲超时流式升级，不跨服务商改动其他渠道的流式参数。

API 界面遵守 [API 配置交互设计约定](./api-settings-design.md)：当前预设入口打开可搜索、分组筛选的底部面板，长按编辑，滑动取消本次点选与长按。对话和识图共用紧凑字段与自定义接口菜单。调用记录在识图右侧页签，每页 5 条、固定列表高度、隐藏滚动条但保留滚动；输入构成单独弹窗。预设绑定、自动保存、备份和云端同步沿用原路径。
