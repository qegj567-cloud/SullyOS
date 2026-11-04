# Anthropic 原生 Messages 与 Prompt Caching

设置 → API 接口，以及角色独立 API 均可选择「Anthropic 原生」。填官方根地址 `https://api.anthropic.com` 或完整 `/v1/messages` 地址、Key 和模型后保存。预设保存接口类型；切回旧 OpenAI 预设会清除原生模式。只根据域名不会自动切换接口。

## 请求边界

- `utils/llmEndpoint.ts` 把原生配置保存为明确的 `/messages` 端点；根地址补 `/v1/messages`，已有路径作为 API 前缀保留。第三方服务须自行支持 Messages 协议和浏览器 CORS。
- `utils/anthropicApi.ts` 在实际网络出口转换。兼容项目原有 `/messages/chat/completions`、`/messages/models` 拼接方式，真正发送 `/messages`、`/models`。OpenAI 和非模型请求不改变。
- `safeApi`、OSContext 裸 fetch 出口、设置页连接测试与模型列表共用转换器，安装标记避免重复转换。
- 使用 `x-api-key` 和 `anthropic-version: 2023-06-01`。仅浏览器增加 `anthropic-dangerous-direct-browser-access: true`；不新建代理，也没有失败后自动换供应商的路径。
- 支持文本、图片、函数工具、多轮工具结果、JSON 输出意图、thinking 签名、普通 JSON 及 SSE。原生模型名保持用户输入，不增加兼容接口专用的 `-thinking` 后缀。未知内容块明确报错。
- 当前支持 adaptive thinking 的 Claude 模型把旧的 `enabled/budget_tokens` 转为 `adaptive` 并映射 effort，旧模型保留手动预算。带工具的续答保留原生内容块顺序与完整签名，不能只复制可见正文和 tool_calls。
- SSE 按 UTF-8 分片解析，保留文本与工具参数增量；`message_stop` 才确认完成，连接提前断开和流内错误向上抛出，取消传到上游。模型请求不因网络失败自动重发。

## 缓存与用量

默认使用 5 分钟 `cache_control: {type: "ephemeral"}`。最多三个断点分别位于工具定义、稳定系统提示和动态提醒之前的历史末尾。不会把每轮改变的尾部 system 提醒搬到历史前面：本次不启用中途 system 的扩展协议，而是在原位置转为 `<system-reminder>` 上下文块，并在稳定 system 中说明其用途。原文不清洗。

缓存是否命中由模型、最短前缀长度、内容一致性和有效期共同决定；短提示词不会因此保证省钱。首次写入与后续缓存读取的计费不同。设置 → API 调用记录展示返回的缓存读取／写入 token；输入总量包含普通输入、缓存读取和写入，不漏算。

## 主动消息 2.0

`worker/amsg/src/index.ts` 在模块初始化时安装无状态 fetch 转换器，覆盖 amsg SDK 内部调用及其他 Worker 模型请求。配置和凭据不存于全局变量；所有转换仅依赖本次请求。

`llm_credentials` 继续使用既有加密三字段 `apiUrl / apiKey / primaryModel`，原生协议由完整 `/messages` URL 表达。无数据库迁移，无新增明文凭据字段，工具续答保留 Anthropic 签名。

发布并同步新版 Worker 成品包后，已配置自动更新的用户打开新版 App 即会后台更新，成功后自动复查能力，无需手动重新连接。若部署完成晚于启动探测，首次原生请求会限时复查旧的不支持结果；确认支持后不再逐次预检。只有自动更新未配置、失败或网络异常持续存在时，才需要检查设置、手动更新等兜底操作。

`/config-check` 返回 `anthropicMessages: true`；前台把能力结果绑定到探测过的 Worker 地址，仍未确认支持时阻止提交原生云端任务或凭据。OpenAI 任务不受此门槛影响。后端 bundle 版本为 `2026-10-29`，应用 APP_VERSION 不变。

## 验证

- 协议测试覆盖图片、工具结果、普通／流式响应、UTF-8 任意分片、签名、错误、截断、缓存计数和真实 amsg SDK 两轮工具调用。
- Worker 模拟使用真实 D1/SQLite、加密任务、定时触发、即时对话与 Web Push，替换的只有模型响应等外部网络。
- 角色 API 面板的 jsdom 测试验证切换原生、测试连接、确认保存，不覆盖全局配置。
- 2026-10-29 对官方 `/v1/messages` 做不带 Key 的 OPTIONS 预检，返回 200，允许 Origin 与四个所需请求头。没有真实 Key，因此未验证某个账户的生成、账单或实际缓存命中率。

官方资料：[TypeScript SDK 浏览器选项](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript)、[Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[Messages 流式事件](https://platform.claude.com/docs/en/build-with-claude/streaming)。

思考参数依据：[官方 Extended thinking 迁移说明](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)。4.7 及后续模型拒绝旧手动预算；4.6 建议改用 adaptive，4.5 及更早模型不能直接改用 adaptive。
