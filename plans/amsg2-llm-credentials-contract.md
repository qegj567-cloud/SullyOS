# LLM 凭据引用（credRefs）实施契约（给施工 agent）

上游（ReiStandard / `@rei-standard/amsg-server` 等）的改动契约。SullyOS 侧接入是后续另一轮，
文末留档，本轮不做。

**基线**：ReiStandard 仓库 `feat/amsg-llm-credentials` 分支（自 origin/main `784a295` 切出，
server 2.6.0-next.16）。文中行号是探查时（next.15 工作区）的参考值，以当前代码为准。

## 动机（一段话）

现状是每条任务的 `encrypted_payload` 里各冻结一份 `apiUrl / apiKey / primaryModel`：
换 Key 要把待触发任务逐条 PUT 回去（漏一条到点就 401）；角色在 fire 里自排的任务从
「正在跑的那一条」复制凭据，客户端够不着，旧 Key 顺着自排链无限传；每往任务里塞一类
新用途的凭据（如情绪评估的副 API 随 metadata 走），就要再手写一套防泄漏防线。
改法：凭据集中存一张表，任务只带**引用**。先例是 `push_subscriptions`——同一仓库里
「逐任务冻结 → 用户级一行 + legacyFallback 平滑迁移」的完整样板
（建表注释、`resolvePushSubscription` 的 `legacyFallback`、`update-message` 拒收旧写法，
都照它的思路抄）。

## 1. 新表 `llm_credentials`

```sql
CREATE TABLE IF NOT EXISTS llm_credentials (
  user_id TEXT NOT NULL,
  cred_id TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, cred_id)
);
```

- 适配器覆盖面**对齐 `push_subscriptions`**：`schema.sqlite.js`、`schema.js`（Postgres）、
  `examples/cloudflare-single-user/schema.sql`、`SQLITE_MIGRATIONS` 数组 +
  `POST /init-tenant` 幂等执行，一处不落。
- `encrypted_value` = `encryptForStorage(JSON.stringify(value), userKey)`，
  与 `encrypted_payload` 同一把 per-user 派生密钥。**红线：必须加密存**。
  （client_state 里 tool_config 明文存是历史欠账，不许照它。）
- `value` 形状：`{ apiUrl, apiKey, primaryModel }` 三字段全必填。校验口径对齐
  `update-message`：只查 truthy，不做格式校验。
- `cred_id`：**不透明字符串**，上游不解释语义。校验：非空、≤128 字符、不含控制字符。
  命名约定写进文档但不强制：`char:<charId>/<purpose>`、`global/<purpose>`。

## 2. HTTP 端点 `/llm-credentials`

挂 single-user worker 路由，鉴权同现有端点（设了 `AMSG_SERVER_TOKEN` 就要求
`X-Client-Token` 常时比较；`X-User-Id` 必须 UUID v4）。请求体加解密方式对齐
`PUT /client-state`（客户端预加密信封，服务端解开；handler 抄现有解信封的模式）。

| 方法 | 语义 | 体（信封内） | 响应 |
|---|---|---|---|
| PUT | 批量 upsert | `{ credentials: [{ credId, value }] }` | `{ upserted: n }` |
| GET | 对账清单 | — | `{ credentials: [{ credId, updatedAt }] }` |
| DELETE | 删除 | `{ credIds: [...] }` 或 `{ all: true }` | `{ deleted: n }` |

- **GET 永不回 value**——一个字段都不回，对齐 task-projection 白名单哲学。
- PUT upsert 要刷 `updated_at`；GET 排序按 `cred_id` 稳定输出。

## 3. `POST /schedule-message`：新字段 `credRefs`

- payload 顶层可选 `credRefs: Record<string, string>`（purpose → credId）。
  校验：purpose 键 ≤64 字符、条目 ≤16、值符合 cred_id 规则。
- 必填校验（`validation.js`）改为：
  - `prompted` / `auto`：prompt +（`credRefs.chat` 存在 **或** 内联三件套齐全），
    **两者都传 → 400 `INVALID_PARAMETERS`**（新 API 没有存量调用方，不留歧义）。
  - `instant`：`userMessage` 或（`credRefs.chat` / 内联三件套），同样不许两者都传。
  - `fixed`：`credRefs` 允许携带（hook 场景可能用别的 purpose），不参与必填判定。
- **存在性检查**：排程时对 `credRefs` 里**全部** credId 做一次 IN 查询，缺的回 4xx
  `CREDENTIAL_NOT_FOUND` 并点名缺哪个（先例：schedule-message 建任务前检查
  push 订阅存在性那段）。检查后被 DELETE 掉属 TOCTOU 竞态，由 fire 时兜底（§5）。
- `credRefs` 原样存进 `encrypted_payload`（`fullTaskData` 白名单加一项）。

## 4. `PUT /update-message`

- 接受 `credRefs` 更新：**整体替换**（语义同 metadata），同样做存在性检查。
- 内联三件套的 truthy-spread 更新照旧——存量任务还靠它续命。
- 传了 `credRefs` 不去动存量内联三件套（留作 fire 时兜底，见 §5）。

## 5. fire 时的解析（读取侧）

- 解析顺序：`credRefs.chat` 有 → 查表取值；查不到行 → 退回内联三件套（如有）；
  都没有 → 本轮失败，`last_error` 记 `CREDENTIAL_MISSING`，走常规重试语义
  （用户补传凭据后下一轮自愈）。
- 解析发生在 `callLlm` 的调用点（`message-processor.js` 的 instant / prompted-auto
  两处 + `agentic-fire.js` 的 agentic 循环），把取到的三件套只合进**传给 callLlm
  的请求对象**。**红线：不许把解析结果写回** `decryptedPayload` / `buildHookTask`
  产物 / ctx / metadata——任何会流向 hook 或 push 的对象都不行，否则
  `CREDENTIAL_PAYLOAD_KEYS` 那道防线等于白搭。`shared/llm-call.js` 不动。
- `taskNeedsLlm()` 判据更新：`!!(credRefs?.chat)` 或内联三件套齐。
- `ctx.scheduleTask()`（自排）：父任务有 `credRefs` → **复制引用**（不是解析后的值），
  不复制内联；父任务是存量内联 → 照今天复制内联。
  这是本次改动要钉死的核心行为：自排链传引用之后，换 Key 自动跟随。

## 6. hook 能力：`ctx.resolveLlmCredential(credId)`

- fire hook 的 ctx 新增方法：`resolveLlmCredential(credId): Promise<{ apiUrl, apiKey,
  primaryModel } | null>`，查不到回 null。
- 每次调用返回新对象。文档红线：hook 拿到就用，**不得**把结果挂到 ctx / task /
  metadata / push 上。宿主 hook（如情绪评估）以后用它取副 API，凭据自此不再随
  metadata 走。
- `CREDENTIAL_PAYLOAD_KEYS` 不动（护的是存量内联）。`credRefs` 本身不是机密：
  不加入屏蔽集，且 **task-projection 白名单加上它**（客户端对账要看）。

## 7. 限额与错误码汇总

| 项 | 值 |
|---|---|
| cred_id 长度 | 1–128，无控制字符 |
| value 单字段长度 | ≤2048 |
| PUT 单批 | ≤100 条 |
| 单用户总行数 | ≤500 |
| credRefs 条目 | ≤16，purpose 键 ≤64 |
| 引用不存在（排程/更新时） | 4xx `CREDENTIAL_NOT_FOUND`，点名 credId |
| fire 时解析不到且无内联 | `last_error: CREDENTIAL_MISSING`，常规重试 |
| 形状/超限 | 复用现有 `INVALID_PARAMETERS` / LIMIT 类错误码风格 |

## 8. 兼容与迁移

- 存量任务**不迁移**：内联三件套继续工作到任务自然消亡（legacyFallback，
  先例同 push 订阅）。凭据锁在 per-user key 加密的 payload JSON 里，没有批量
  解密重写的路径，也不要造——将来有需要由客户端逐条按需做。
- `amsg-client` SDK 新增：`putLlmCredentials` / `listLlmCredentials` /
  `deleteLlmCredentials`；`scheduleMessage` / `updateMessage` 参数透传 `credRefs`。
  信封加密复用现有封装。

## 9. 测试（回归守卫，每条都要能在旧行为下挂、修好后过）

1. 端点：PUT/GET/DELETE 加密往返；GET 响应里摸不到 apiKey/apiUrl/primaryModel。
2. 排程：只带 `credRefs.chat` 能建 prompted/auto 任务；credRefs 与内联同传被拒；
   引用不存在被拒且点名。
3. fire：credRefs 解析成功调到 LLM（mock 断言请求头/模型来自表里的值）；
   行删掉后退回内联；都没有 → `CREDENTIAL_MISSING` + 重试语义。
4. **自排链跟随换 Key（灵魂测试）**：父任务带 credRefs → 自排出的子任务复制的是
   引用；改表里的值后，子任务 fire 用的是新值。
5. 泄漏防线：hookTask / push payload 里摸不到解析后的 apiKey。
6. update-message：credRefs 整体替换 + 存在性检查。
7. schema 一致性：examples 的 schema.sql 与 SQLITE_MIGRATIONS 建出来的表一致
   （有现成的一致性测试就跟着加）。

## 10. 文档与发版

- 更新相关包 README / API 文档：端点、payload 字段、hook API、cred_id 命名约定、
  与内联三件套的关系（平铺直叙「这是啥 / 啥时候用」，不写纠错腔、不踩旧写法）。
- changeset：server minor、client minor（当前 pre 模式 `next`，**只加 changeset
  文件**，不跑 `changeset version` / `changeset publish`）。

## 11. 施工边界（红线）

- 只许改 `/Users/tntobsidian/Documents/GitHub/ReiStandard` 内的文件。
- **禁一切 git 写操作**（commit / push / reset / switch / stash / rebase…）；
  分支已由主线程切好，改动留在工作区待审。git 只读命令（status / diff / log）随意。
- 包管理器用 **npm**（ReiStandard 是 npm workspaces + package-lock；pnpm 是
  SullyOS 的规矩，别带过去）。依赖没装就 `npm install`。
- 不动 `shared/llm-call.js`、不动加密原语、不动与本契约无关的行为。
- 验证：至少跑 server 包的 build + test（`npm run build` / `npm test`，或根目录
  `npm run ci`），结果如实报告，失败不许粉饰。

## 修订（2026-08-10）：credRefs 继承与空凭据语义

首版实现按「有 credRefs 就只复制引用」处理自排继承，没有覆盖「credRefs 只带非 chat
purpose」的组合，会产出既无引用可解析、又无内联凭据的空壳后代并静默不生成。修订后
的语义：

- `ctx.scheduleTask()` 的凭据继承按 **`credRefs.chat`** 分支：父任务带 chat 引用 →
  复制整份 credRefs、内联置空；父任务只带非 chat 引用（如仅 emotion）→ credRefs 与
  内联三件套**都**复制——引用归 hook 用途，内联管聊天。
- `prompted` / `auto` 任务 fire 时既无 `credRefs.chat` 也无内联三件套 → 按
  `CREDENTIAL_MISSING` 失败进常规重试，不许静默判成「不需要 LLM」。`instant` 保持
  「无凭据 = 纯推送」的路由语义不变。
- 校验口径：`credRefs.chat` 与内联三件套**任一字段**同传 → 400（不是三件齐全才拒）；
  仅含非 chat purpose 的 credRefs 与内联三件套共存是合法组合。
- 文档里提可用性门槛时引用 capabilities feature `'llm-credentials'`，不写死版本号
  （实际发版号与预估不同步是常态）。

## SullyOS 侧落地（2026-08-10 完成）

- 凭据行分用途：`char:<id>/chat`（排程任务，使用当前聊天主 API）、
  `char:<id>/instant`（即时对话，当轮请求终值，含思考模式的 `-thinking` 模型名）、
  `char:<id>/emotion`（情绪评估，`emotionConfig.api` 缺省时回落主 API）。
  chat / instant 仍分行，避免配置同步覆盖正在生成的即时回复。
  **2026-10-02：主动消息单独 API 已下线**，旧角色 / 旧备份的副 API 字段不再生效。
  页面内定时主动消息（1.0）同时移除独立 API 开关，使用实时的聊天主 API。
  两处设置面板都说明调用使用主 API；情绪和记忆整理的独立 API 不变。
- 构建与命名住 `utils/amsgLlmCredentials.ts`；上云的指纹门控、退避、底账在
  `utils/amsgStateSync.ts`（与 tool_config 同款）；排程 / 即时对话带 `credRefs` 与
  `CREDENTIAL_NOT_FOUND` 当场补传自愈在 `utils/activeMsgClient.ts`。
- 门槛只一处：`isLlmCredentialsReady()` 判 capabilities 含 `'llm-credentials'`，
  不达标原样走内联老路（旧 Worker 只是用不上新路，不会坏）。
- 情绪评估新任务的 `metadata.amsgEmotionEval` 只剩 `{ prompt }`，凭据走
  `credRefs.emotion`；存量任务 metadata 里的 `api` 继续认，两道 strip 防线保留到
  存量消亡。
- `emotion` 行是懒创建的：第一次跑「带情绪评估的即时对话」时才随指纹门控 PUT 上表，
  在那之前表里只有 `chat` / `instant` 两行——排查时见不到 `emotion` 行属正常，
  不代表没实现。
- 「清空云端数据」第四样 `deleteLlmCredentials({ all: true })`，与前三样互不短路。
- 启动和主 API 切换都走凭据同步队列，失败退避重试、保留跨会话欠账。
  即使没有本地凭据指纹底账，也为启用角色同步 chat 行，覆盖旧副 API。
- 补刷函数同时读取本地任务和远端清单，覆盖页面关闭期间的自排任务。
  内联任务更新主 API 三字段；引用任务先登记主 API 行，再更新 chat 引用，保留其它 purpose。
  继承 `instant-chat` 标签的自排任务通过详情的 `amsgSelfScheduled` 确认；真正的即时回复、
  fixed 和后台作业不参与迁移。迁移需用户打开新版应用并成功连接其 Worker 后才会生效。

### Anthropic 原生端点（2026-10-29）

凭据仍为加密三字段。`apiUrl` 为完整 `/v1/messages`（自定义服务保留自己的路径前缀）时，由 SullyOS Worker 的无状态出口转换为原生请求；不增加协议字段或明文 Key。前端先确认该地址的 `/config-check` 返回 `anthropicMessages: true`，否则不上传原生凭据、不创建或改写原生云端任务。沿用冷启动自动更新，成功后自动复查能力；首次原生调用还会限时复查旧的不支持结果，不要求用户手动重连。详细映射与缓存边界见 [Anthropic Messages](../docs/anthropic-messages.md)。
