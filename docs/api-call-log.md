# API 调用记录（`utils/apiCallLog.ts`）

「设置 → API 调用记录」（`components/settings/ApiCallLogModal.tsx`）用于记录对话大模型的调用明细、Token 消耗、输入构成拆解与实际响应后端，供用户排查额度去向、模型降级与请求报错。

## 记录边界

### 纳入记录的调用

所有面向对话生成模型（`/chat/completions` 及其 Anthropic Messages 原生转换端点）的调用均写入同一份本地日志表（`api_call_logs`，保留最近 5 天、最多 200 条），分为两条通道：

1. **浏览器本地直连通道**：由 `context/OSContext.tsx` 的全局 `fetch` 拦截器统一捕获 `/chat/completions` 请求，记录耗时、HTTP 状态、流式或非流式响应中的 `usage`（含缓存读写明细）、服务商自报的 `model`，以及按 `messages` 拆算的输入构成。
2. **主动消息 2.0 云端通道（`route: 'cloud-*'`）**：请求在用户自建的 Cloudflare Worker 上发出，不经过浏览器 `fetch`：
   - `cloud-instant-chat`：即时对话主回复（`utils/amsgInstantChat.ts`）
   - `cloud-emotion-eval`：随即时对话并发执行的副 API 情绪评估（`utils/amsgInstantChat.ts` + `worker/amsg/src/emotionEval.ts`）
   - `cloud-proactive`：云端定时主动消息，含面板排程、角色自排提醒、离开后消息、见面离开提醒、纯动作回执，以及模型已执行但判定不发送或因对话重叠避让而跳过的轮次（`utils/activeMsgRuntime.ts` + `utils/amsgFireSkipResultApply.ts`）
   - `cloud-plate-consolidate`：记忆宫殿云端后台门牌整理（`utils/memoryPalace/roomPlateCloud.ts` + `worker/amsg/src/plateFire.ts`）
   - `cloud-diagnostic`：主动消息诊断复现测试（`utils/activeMsgRuntime.ts` + `worker/amsg/src/reproduction.ts`）

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
| 两阶段（先挂起后结算） | 即时对话、云端情绪评估、云端门牌整理 | `recordCloudApiCall` → `settleCloudApiCall` | 任务由当前客户端当场提交，提交时刻就能拿到完整输入消息并显示「☁️ 云端生成中」，结果回程、失败、顶替或取消时按同一确定性 ID 原地补齐用量并消除挂起状态 |
| 单阶段（回程一次落账） | 定时主动消息、模型执行后跳过的轮次、诊断复现测试 | `recordCompletedCloudApiCall` | 任务由云端 Cron 独立触发，触发时客户端可能离线；客户端上线收到推送或后台结果回执（`emitResult`）时直接写入已完成记录，使用 `taskUuid + occurrenceMs`（或 `diagRunId`）拼出确定性主键，避免离线补收与推送重放重复记账 |

### 多轮工具调用的用量累加

云端一次触发内若经过多轮工具调用（查记忆、搜网页、通用 MCP、排程），`worker/amsg/src/index.ts` 在每轮 `onLLMOutput` 中累加 `prompt_tokens` 与 `completion_tokens`。只有当某几轮服务商未返回 `usage`、导致累加不完整（或连接的仍是未累加多轮的旧版 Worker）时，记录才标记 `tokensPartial: true`（界面提示「只算末轮」）。

### 凭据不随推送回传

Web Push 载荷与 `emitResult` 结果箱只携带非敏感的数字型 `promptTokens` / `completionTokens` 字段，**绝不携带 `apiKey` 或原始 `baseUrl`**。单阶段回程落账时，客户端在本地读取当前角色的对话 API 配置（`resolveDialogueApi`）补齐渠道域名与模型名。
