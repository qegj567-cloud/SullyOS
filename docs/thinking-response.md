# 心象与聊天正文的分离

`utils/assistantThinking.ts` 是前台 API、聊天后处理、通知清洗及主动消息 Worker 共用的纯解析器。判断依据是接口字段或明确的内联标签，不根据模型别名、语言或分析语气猜测。

## 支持的响应

- OpenAI 兼容的 `choices[].message` / SSE `choices[].delta`：`reasoning_content`、`reasoning`、`thinking`。空占位字段不能遮住后面的有效字段；同时出现的别名视为镜像，避免重复。
- `reasoning_details` 中的 `reasoning.text.text` 和 `reasoning.summary.summary`。可见别名优先，别名为空时才读 details；不显示加密数据、签名或 redacted thinking。
- `content` 数组中 `thought: true`，以及 `thinking` / `thought` / `reasoning` 类型块。只有正文进入气泡、通知和正文预览。这里仅兼容被渠道放进 Chat Completions 的内容块，未新增 Gemini 原生 generateContent / Interactions 传输接口。
- 正文内明确的 `<think>` / `<thinking>` / `<thought>` 块，允许标签属性和闭合空格。全部完整块及末尾未闭合块均提取；未闭合部分不进入正文。

非流式响应统一成字符串正文及 `reasoning_content`，保留独立的 `anthropic_content`、`anthropic_thinking` 和 `reasoning_details` 字段；Anthropic 原生工具续答仍使用原转换器保存的签名块。SSE 可见摘要按增量拼接，不把加密签名解释为文字。

`extractContent` 不再用思考代替空正文。Worker 也不使用 SDK 的思考回退值覆盖明确为空的回答。云端心象仍只回传最终回复轮，且只挂第一条推送，长内容沿用旁路存储。

## 用户侧边界

关闭心象控制新卡片的显示及相关请求提示，不保证关闭模型推理、减少用量或让回复完全不变。Gemini 官方说明有些模型不能关闭推理，返回的可见内容可能只是摘要；摘要短或缺失不等于客户端漏捕获。

如果渠道把分析文字作为没有标记的普通正文返回，客户端无法可靠判断哪些应隐藏。截图只能证明显示异常，不能据此判定「假思考」、模型故障或渠道修改提示词。排查时核对同一轮响应字段和流式状态，不要求用户清空历史，也不收集 Key 或私人聊天内容。

此次修复同时涉及前端和 `worker/amsg`。Worker bundle 版本为 `2026-11-13`，APP_VERSION 不变。发布后云端路径需更新用户 Worker；本地路径使用新版前端即可。

## 手动翻译与设置

- 长按心象或点击卡片上的「···」打开操作菜单，可选择复制全文、翻译成中文或心象设置。不会在打开卡片、收到回复或翻页时自动请求翻译；正在流式生成的临时卡片只支持复制与设置。
- 「心象设置」先显示开关，然后是翻译 API 和角色的心象提示词，长说明移至最后。说明首次打开时展开，之后默认折叠；已读状态由 `os_thinking_help_seen_v1` 本机保存，跨用户空间共用并参与镜像恢复。
- 提示词按角色保存。新旧角色默认「追加」，原有自定义内容接在内置规则之后。「替换默认提示词」只使用自定义内容，空白时省略整个心象提示词块。两种模式都沿用「显示心象」开关及相同的响应解析。角色的个人文字和完整备份保留这个选择，分享角色卡时移除模式和自定义提示词。
- 翻译配置是全局 `APIConfig.thinkingTranslationApi`，独立于角色对话 API。可从现有 API 预设载入整套配置、明确载入当前对话 API，或手填后另存为「心象翻译」分组的新预设；修改字段只改草稿，点「保存翻译 API」生效。未配置时引导设置，不自动回退到聊天模型。
- 翻译通过既有 `safeFetchJson` / Anthropic 转换出口发送，仅包含这一条已显示的思考文字及翻译要求，不附角色人设、记忆、聊天上下文或工具。显式记录角色及用途「心象翻译」，失败不自动重发、不切换模型。
- 原文仍保留在 `metadata.thinkingChain`；译文与对应原文存在 `metadata.thinkingChainTranslation`。原文未变时复用已保存译文，支持「译文／原文／中英对照」三选一及复制当前显示文本；切换不调用 API，不改聊天正文或下一轮模型上下文。翻译期间修改／删除原消息时拒绝写入旧结果，写入使用事务并保留并发新增的其他 metadata。
- 新翻译在本机按段落和句子编号，一次请求返回每个编号的中文，校验完整且不重复后保存为 `segments`。对照展示原文在上、中文在下；原文始终取自本机，不让模型重写。旧译文或纯文本响应保留整篇原文／译文对照，不猜测句子对应关系，也不为了切换显示重新请求。
- 同一条心象的同时点击合并为一次请求；本机保存失败时保留最近 32 条已完成结果，重试保存不重复调用。翻译 API 与译文随个人文字／完整备份保留，不进入角色卡或美化分享。

验证：`utils/thinkingTranslation.test.ts` 检查专用凭据、单条输入、重复调用、编号对应、旧数据兼容、过期原文、并发 metadata、失败重试与真实备份恢复；`utils/chatRequestPayload.test.ts` 对实际本机／云端请求组装及主动消息历史验证：加入原文、译文和对照 metadata 前后，聊天上下文一致。`scripts/test-thinking-translation.mjs` 检查长按、复制、预设、首次说明、三种显示切换、对照复制、刷新及窄屏安全区。网络使用测试响应，没有调用用户的模型或测试真实计费。

## 协议验证

- [Gemini OpenAI 兼容接口](https://aistudio.google.com/docs/openai)：thinking 参数及 include_thoughts。
- [Gemini thinking](https://aistudio.google.com/docs/thinking)：可见摘要与不可读签名的区别。
- [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)：结构化摘要与流式增量。

回归覆盖普通 JSON、带回调和不带回调的 SSE、镜像去重、空白增量、结构化 thought 块、闭合后仍有未闭合块、关闭显示、普通英文保留、云端推送及空正文。均为协议样本和模拟请求，未使用用户渠道 Key 实测。
