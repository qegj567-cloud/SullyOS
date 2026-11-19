# API 调用记录（`utils/apiCallLog.ts`）

「设置 → API 调用记录」（`components/settings/ApiCallLogModal.tsx`）用于记录对话大模型的调用明细、Token 消耗、输入构成拆解与实际响应后端，供用户排查额度去向、模型降级与请求报错。

## 记录边界

### 纳入记录的调用

所有面向对话生成模型（`/chat/completions` 及其 Anthropic Messages 原生转换端点）的调用均写入同一份本地日志表（`api_call_logs`，保留最近 5 天、最多 200 条），分为两条通道：

1. **浏览器本地直连通道**：由 `context/OSContext.tsx` 的全局 `fetch` 拦截器统一捕获 `/chat/completions` 请求，记录耗时、HTTP 状态、流式或非流式响应中的 `usage`（含缓存读写明细）、服务商自报的 `model`，以及按 `messages` 拆算的输入构成。
2. **主动消息 2.0 云端通道（`route: 'cloud-*'`）**：请求在用户自建的 Cloudflare Worker 上发出，不经过浏览器 `fetch`：
   - `cloud-instant-chat`：即时对话每次模型请求（`utils/amsgInstantChat.ts` + `utils/amsgApiCallLog.ts`），包括聊天回复及查记忆、排程等工具后的续答
   - `cloud-emotion-eval`：随即时对话并发执行的副 API 情绪评估（`utils/amsgInstantChat.ts` + `worker/amsg/src/emotionEval.ts`）
   - `cloud-proactive`：云端定时主动消息，含面板排程、角色自排提醒、离开后消息、见面离开提醒、纯动作回执，以及模型已执行但判定不发送或因对话重叠避让而跳过的轮次（`utils/activeMsgRuntime.ts` + `utils/amsgFireSkipResultApply.ts`）
   - `cloud-plate-consolidate`：记忆宫殿云端后台门牌整理（`utils/memoryPalace/roomPlateCloud.ts` + `worker/amsg/src/plateFire.ts`）
   - `cloud-diagnostic`：主动消息诊断复现测试（`utils/activeMsgRuntime.ts` + `worker/amsg/src/reproduction.ts`）

私聊表情通过独立识图 API 获取描述时记为「表情识图」，图库「一键起名」使用全局主 API，每次提交一组图片记一条「表情看图起名」调用。对话模型直接接收表情图片时仍是原来的聊天请求。

### 不纳入此面板的接口

向量化与重排（`/embeddings`、`/rerank`）、语音合成与复刻（ElevenLabs / MiniMax / OpenAI TTS）、语音识别、Replicate 音乐合成及外部独立引擎（BrainAgent）使用各自的计费单位（字符数、秒数、生成次数或独立会话），不混入对话 Token 统计面板。固定文案提醒（`messageType: 'fixed'`）在云端直接投递预设文本、不调用大模型，同样不写入调用记录。

---

## 新增调用点的元数据规范（`ApiCallMeta`）

每次本地发起 `/chat/completions` 请求时，调用方都应显式传入 `ApiCallMeta`（`safeFetchJson` 第 5 个参数，或原生 `fetch` / `fetchLlm` 的 `__sullyMeta` 字段）：

```ts
{
  appId: 'study',
  appName: '自习室',
  charId: selectedChar.id,
  charName: selectedChar.name,
  purpose: '生成随堂测验',
}
```

- **`purpose` 使用简明中文短语**：直接展现在列表卡片的蓝色角标上，不使用英文内部代号或函数名；连通性检测按钮统一写 `'测试连接'`。
- **显式 `meta` 与前台环境上下文严格隔离**：`resolveApiCallMeta` 在收到显式 `meta` 时，只用内置 `appId -> appName` 映射与 `charNameRegistry`（`charId -> charName`）补全同源展示名，**绝不合并前台 `ambientMeta`**。这样后台记忆管线、群聊导演、无角色工具或子页面调用不会串入当前打开的私聊角色。只有调用点完全未传 `meta` 时，才退回请求发起时刻的前台快照。
- **共享辅助函数支持透传 `meta`**：识图（`describeImageWithVisionApi` / `materializeVisionDescriptions`）、情绪评估（`evaluateEmotionBackground`）、群聊 MCP 工具循环（`completeGroupChatWithMcp`）等共用入口均接受调用方传入归属元数据，按实际触发的 App（如消息、见面、3D 家园、协同工作、彼方）记账。

---

## 云端调用的记账模式与隐私边界

### 两阶段记账 vs 单阶段成单记账

| 模式 | 适用场景 | 写入函数 | 原因 |
|------|----------|----------|------|
| 两阶段（先挂起后结算） | 即时对话、云端情绪评估、云端门牌整理 | `recordCloudApiCall` → `settleCloudApiCall`；新版即时对话用 `settleInstantModelCalls` | 任务提交时先显示「☁️ 云端生成中」。即时对话回程时，第一笔替换挂起记录，续答请求各自成单；其余场景原地结清 |
| 单阶段（回程一次落账） | 定时主动消息、模型执行后跳过的轮次、诊断复现测试 | `recordCompletedCloudApiCall` | 任务由云端 Cron 独立触发，触发时客户端可能离线；客户端上线收到推送或后台结果回执（`emitResult`）时直接写入已完成记录，使用 `taskUuid + occurrenceMs`（或 `diagRunId`）拼出确定性主键，避免离线补收与推送重放重复记账 |

### 即时对话按实际模型请求分别记账

`worker/amsg/src/index.ts` 每次 `onLLMOutput` 提取本次 API 返回的用量，放入 `metadata.amsgModelCalls`。客户端以 `cloud-<taskUuid>`、`cloud-<taskUuid>:call:2` 等确定性 ID，在同一个 IndexedDB 事务中替换挂起记录并写入续答记录，不额外保留整轮合计行。

- 第一次请求用途为「聊天回复」；查记忆或排程后再次请求模型，用途为「查记忆后回复」「主动消息排程后回复」。若一次续答接收了多个工具结果，用途合并，但仍只记一次模型请求。工具执行本身不伪造模型调用记录。
- 每条记录保留本次响应的输入、输出、总 Token、缓存读写和实际后端模型；没有返回的字段保持未知，不按字符或工具数量估算。只有第一笔有本地捕获的输入构成，不将这份输入构成复用给后续工具轮。
- 失败或空回复通过静默可靠结果 `resultKind:'instant-api-calls'` 补记已发生的请求。失败调用依据 SDK `llmCalls` 确认，不能把工具失败或推送失败算作新的模型请求，也不能拿上一次成功响应的 usage 填给失败请求。取消时尽力回传；若 SDK 已撤销任务租约并禁止写入结果箱，尚未回传的用量无法补齐，不绕过取消门禁。
- 推送与 outbox 重复补收幂等；迟到的挂起登记、旧版整轮用量或失败收尾不得覆盖已拆分请求的用量和成功状态。本地 API 归属信息仍可补齐。
- 旧 Worker 未提供 `amsgModelCalls` 时继续显示原有整轮记录，经过工具的记录明确提示更新 Worker；历史合计不能事后拆成各次真实用量。前端与 Worker 需一并更新。

定时主动消息保留原有整轮累加方式：每轮 `onLLMOutput` 累加输入与输出，`amsgUsageComplete` 表示是否收齐。缺报或旧 Worker 只报末轮时标记 `tokensPartial: true`，界面提示「用量不完整」。即时对话仍回传兼容的 `amsgUsage`，供尚未更新的前端使用。

### 凭据不随推送回传

用量回执只挑选数值用量、请求序号、完成时刻、状态、固定枚举用途和响应自报模型；**绝不携带 `apiKey`、原始 `baseUrl`、请求正文、工具参数或供应商私有字段**。本地已登记的 API 配置信息用于即时对话归属；定时主动消息等单阶段回程落账时，客户端读取当前角色的对话 API 配置（`resolveDialogueApi`）补齐渠道域名与模型名。
