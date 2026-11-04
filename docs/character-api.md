# 角色默认对话 API

## 私聊最大生成 Token

设置、角色独立 API 的高级选项及 API 预设支持 `maxTokens`（正整数），未设置时沿用 8000。角色未指定时继承全局值；完整备份与预设保存该参数。私聊主回复、重新生成和工具后的续答使用同一额度；云端即时聊天沿用当轮最终请求的 `max_tokens`。情绪评估、记忆提取等专用任务及主动消息自身的额度不被此项覆盖。

这是单次输出上限，不是历史容量。减小可降低预留输出额度，过小也可能截断回复；输入历史本身超出模型容量时，仍需归档或缩小上下文。额外思考预算必须小于输出额度；额度不超过 1024 时不附加额外思考参数。

神经链接 → 设定 → 角色语音音色下方的「独立 API」。未设置时显示当前全局地址的主机名和模型；设置后显示角色自己的配置，并可恢复跟随设置。

角色弹窗复用设置页的 `DialogueApiFields`、`ModelPicker` 和 `ApiPresetGroups`。API 预设库共用，分组在设置中新建或编辑预设时填写。选预设、选模型和编辑字段都只改变草稿；外层「确定」才写入角色，取消不保存。配置保存为快照，修改或删除预设不会暗中改变角色。设置的 API 区显示所有使用独立配置的角色。

## 选择规则与当前接入范围

`utils/characterApi.ts` 的 `resolveDialogueApi(globalApi, character?, appApi?)` 是单角色回复的统一入口：

**App 明确指定的 API → 角色 dialogueApi → 全局 API。**

| 调用 | 行为 |
| --- | --- |
| 私聊，含重新生成 | 使用角色默认；当轮明确传入的覆盖优先 |
| 3D 家园角色回复 | 使用角色默认；识图与情绪评估保持专用配置，JSON 动作回复仍一次性解析 |
| 见面开场、回复、重新生成 | 使用实际参与本次请求的角色；切角色的开场显式传新角色 |
| 电话 / 视频电话主回复 | 使用角色默认；语音合成、视频动作导演仍用原配置 |
| 群聊逐人调用 | 每个成员单独解析，单个成员失败不影响后续成员 |
| 群聊统一生成、TRPG 等整场统筹 | 不传角色、不受角色默认 API 影响 |
| 彼方角色活动、SAR 单角色推演 | 彼方 App 独立 API 优先，否则跟随角色和全局 |
| 哔哔首页/评论区刷新、即时评论接话 | 哔哔 App 独立 API 优先，否则跟随本次角色和全局；情绪便车与主回复侧动作保持原请求 API |
| SAR 身份铸造 | 系统任务，使用彼方 App / 全局配置 |
| 主动消息 2.0、云端即时聊天 | 与该角色对话配置一致 |
| 情绪、记忆、识图、TTS 等专用任务 | 保持各自原有的配置与回退规则 |

其他尚未接入的玩法保持原配置。新增入口先区分「单角色独立回复」「整场 / 多人生成」「专用处理」，不要因为请求含有人设或选中了某个角色就套角色 API。彼方历史数据中的 `vrState.api` 不再作为隐式覆盖来源；用户可见的彼方 API 入口只有 App 配置。

URL / Key / Model 整套选择，禁止逐字段从不同配置补齐。空 Key 保留为空，交给原调用链的无 Key 兼容或校验处理；配置不完整和请求失败都不会触发静默换模型。流式与温度可以使用所选配置，未设置则继承全局参数；不能把整个全局 `apiConfig` 替换成角色对象，它还包含语音、识图等其他用途的配置。

## 存储与云端

- `CharacterProfile.dialogueApi` 只保存文本模型相关字段，随个人系统备份保存。角色卡导出 / 导入均由 `stripSensitiveCardFields` 剥离，不能泄漏 Key 或覆盖收卡人的本地配置。
- 角色变更落库后触发现有 `syncAmsgLlmCredentials` 队列；传入新的配置快照，避免连续修改同一角色时被正在运行的同步清掉欠账。新 Worker 更新凭据行，旧 Worker 更新存量任务，沿用失败重试。
- `char:<id>/chat` 根据角色当前配置计算。`instant` 仍由本地当轮请求终值提供，情绪 / 记忆凭据不受角色对话 API 影响。
- 预设分组保存在 `ApiPreset.group`，缺省为未分组，改组不改变预设内容。
- 原生接口类型 `apiType` 随整套对话凭据与预设保存，原生 URL 归一化为 `/messages`；详情见 [Anthropic Messages](./anthropic-messages.md)。旧 Worker 未确认原生能力时不更新为原生凭据。

## 验证

`utils/characterApiPersistence.test.ts` 覆盖完整 ZIP 与纯文字游标分片 ZIP：清空角色库后重新导入，经过角色默认值和上下文迁移，再由真实 `useChatAI` 构造请求，断言地址、鉴权、模型、温度和流式参数；同时验证当轮覆盖、切回全局和预设分组保留。网络发送处使用测试替身，不调用外部模型。

`pnpm vitest run utils/characterApi.test.ts utils/characterApiPanel.test.ts utils/amsgLlmCredentials.test.ts utils/amsgStateSync.test.ts utils/apiPresetSwitch.test.ts utils/apiPresetSwitch.wiring.test.ts utils/characterCard.test.ts`

本地可视验收页：`/test/fixtures/character-api.html`。点击「加载演示配置」只写入该预览站点的虚构配置，不调用真实模型。可验证预设分组、保存 / 取消、跟随全局、跨页名单和窄屏布局。
