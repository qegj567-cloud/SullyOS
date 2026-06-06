# Dev Debug 调试子系统

开发分支专用的"工具箱"：一个悬浮按钮 + 面板，放一堆**只在开发分支显示**的调试开关，外加一套可选的「分类捕获」日志——打开**总开关**「记录日志」后会露出并排的类型 checkbox（目前 `api` 普通聊天 / `instant-push` 即 IP 通道事件），勾哪类抓哪类。面板走极简：类型并排、无逐条说明（看不懂就别用）。正式分支（main / master）默认整个隐藏，用户看不到也不会误触。

这份文档讲清楚它怎么运作，以及**怎么往里加新开关 / 加一类捕获日志**——照着步骤抄就行。

---

## 一、它什么时候出现？（可用性门禁）

整套能力（面板、开关存储、日志捕获）都挂在一个总开关后面：

```ts
isDevDebugAvailable()  // utils/devDebug.ts
  → !forceClosed && (__BUILD_BADGE_VISIBLE__（vite 构建注入）|| manualUnlock（连点解锁·会话级）)
```

`__BUILD_BADGE_VISIBLE__` 在 `vite.config.ts` 里算出来，规则如下：

| 情况 | 是否显示 |
|------|---------|
| 在 `main` / `master` 构建 | ❌ 隐藏（视为正式发布） |
| 在其他分支构建 | ✅ 显示 |
| 设了 `VITE_HIDE_BUILD_BADGE=1` | ❌ 强制隐藏（覆盖默认） |
| 设了 `VITE_SHOW_BUILD_BADGE=1` | ✅ 强制显示（在 master 本地调试用） |
| 设置页底部连点「构建版本」5 下 | ✅ 显示（**手动解锁**，会话级、刷新即关，正式版临时排障用） |

> 分支名的来源：CI 优先读 `GITHUB_REF_NAME` / `VERCEL_GIT_COMMIT_REF` / `CF_PAGES_BRANCH` / `BRANCH`，本地退化成 `git rev-parse --abbrev-ref HEAD`，非 git 环境是 `'unknown'`（`'unknown'` 不在发布分支集合里，所以会显示）。

**关键含义**：在 master 上本地想调试，跑 `VITE_SHOW_BUILD_BADGE=1 pnpm dev` 即可，不用改代码。

**正式版排障（手动解锁）**：设置页底部连点 `VersionInfo`（构建版本那栏）5 下 → `unlockDevDebug()` **会话级**解锁（**不落 localStorage**），`isDevDebugAvailable()` 放行、`<DevDebugPanel />` 经 `subscribeDevDebugAvailability` 即时弹出。

**怎么关掉**：
- **刷新页面**：`manualUnlock` 清零 → prod 回到隐藏；非 prod 因 `__BUILD_BADGE_VISIBLE__` 默认可见，刷新后照常显示（即「非 prod 一直开」）。
- **面板底部「关闭」按钮**：`closeDevDebug()` 置 `forceClosed`，**任意分支**强制关掉；会话级，**刷新后非 prod 自动恢复**。顺手把浮球位置收回默认、面板收起；**`isCaptureEnabled` 也会一并返 false**（避免面板看着关了但业务代码继续往 localStorage 写日志的隐私债），但**里面的捕获 / 行为开关存档不动**——刷新恢复后可见性回来，里面勾的还是原样。

> 可用性 = `!forceClosed && (__BUILD_BADGE_VISIBLE__ || manualUnlock)`，三个量里只有 `__BUILD_BADGE_VISIBLE__` 是构建期常量，另两个是会话级内存标志（刷新归零）。

> **面板自身状态全是纯内存、不落盘**：浮球位置、展开与否每次出现都回默认（位置默认角、收起）；prod 刷新 = 解锁失效 ≈ 手动关闭，所以位置没必要持久化。里面的捕获 / 行为开关是另一套 localStorage，跟这些无关。

---

## 二、相关文件清单

| 文件 | 职责 |
|------|------|
| `utils/devDebug.ts` | 核心：类型、存储读写、事件、分类捕获、便捷 getter。**所有逻辑都在这** |
| `components/DevDebugPanel.tsx` | 悬浮按钮 + 面板 UI（拖拽、开关行、复制 / 下载日志、重置） |
| `components/settings/VersionInfo.tsx` | 设置页底部版本脚注（APP_VERSION + build hash + sw 版本）；连点 5 下手动解锁面板 |
| `utils/swVersion.ts` | `querySwVersion()`：向 SW 查版本号（BuildBadge / VersionInfo 共用） |
| `App.tsx` | 挂载 `<DevDebugPanel />`（无脑挂，组件内部自己判断要不要渲染） |
| `vite.config.ts` | 注入 `__BUILD_BRANCH__` / `__BUILD_COMMIT__` / `__BUILD_BADGE_VISIBLE__` |
| `vite-env.d.ts` | 上面三个常量的 TS 声明 |

消费现有开关的地方（改开关行为时要一起看）：

| 开关 | 消费点 |
|------|--------|
| `skipPromptBuild` | `utils/chatRequestPayload.ts:158` |
| `skipEmotionEval` | `context/OSContext.tsx:1436`、`hooks/useChatAI.ts:439 / 685` |
| 捕获类 `api` | `utils/safeApi.ts`（调 `appendDevDebugApiLog`，仅普通聊天直发模型） |
| 捕获类 `instant-push` | `utils/activeMsgRuntime.ts`、`utils/instantPushClient.ts`（调 `appendDevDebugInstantPushLog`） |
| 总开关 `captureEnabled` | `utils/devDebug.ts` 的 `isCaptureEnabled()` 闸门——关掉时所有捕获类都不抓 |

---

## 三、两类开关的区别

面板里的开关分两种，加法不一样，别搞混：

| 类型 | 例子 | 数据形态 | 加新的成本 |
|------|------|---------|-----------|
| **行为开关（skip 型）** | `skipPromptBuild` / `skipEmotionEval` | `DevDebugFlags` 里一个 `boolean` | 改 flag 结构（见指南 A） |
| **捕获类（checkbox）** | `api` / `instant-push`（未来 `mcp`…） | 进 `captureLogs: Category[]` 数组 | 加一行 category + 一个薄封装，flag 结构不动（见指南 B） |

> 还有个**总开关** `captureEnabled`（本质也是个 boolean 行为开关）：勾选只是「选类型」，真正抓不抓 = `captureEnabled && captureLogs.includes(category)`。面板上**总开关用 switch、类型用并排 checkbox**，且**总开关打开后才露出类型 checkbox**（无逐条说明）。

> **面板文案约定（用就默认看得懂）**：标题写清"是什么"；说明（`detail`）只留**非显而易见的坑**，能省则省、不写教程。能从标题猜到的（总开关、类型 checkbox）干脆不写说明。例：「记录完整内容」说明只留一句「只对新条目生效」——为什么折叠、怎么导出这些写在 doc（第六、第九节），不挤进面板。新增开关 / 类别时照此办，详尽解释放 doc、面板只留必要提示。

捕获类共用同一套底座（存储、脱敏、限容、复制 / 下载），所以加新类很便宜——这也是为什么日志系统设计成"分类"而不是给每种日志单独开一个 boolean。

---

## 四、数据流总览

```
DevDebugPanel (UI)
   │  点开关
   ▼
writeDevDebugFlags(flags)
   │  写 localStorage（按分支隔离的 key）
   │  派发 DEV_DEBUG_EVENT 自定义事件
   │  ⚠️ 取消勾选「不」清日志（勾选是纯选择）；清日志只在「重置」时做
   ▼
业务代码调 isXxxSkipped() / isCaptureEnabled('api' | 'instant-push')
   │  闸门 = captureEnabled（总开关）&& 该类已勾
   │  每次都现读 localStorage，拿到最新值
   ▼
按 flag 改变行为（跳过某步 / 抓日志）

跨标签页同步：localStorage 的 'storage' 事件
面板内实时刷新：subscribeDevDebugFlags() / subscribeDevDebugLog()
```

**为什么用事件 + 现读 localStorage，而不是 React state 全局共享？**
因为消费方大多是普通函数（不是组件），拿不到 React context。所以约定成：**写的时候持久化 + 广播事件，读的时候直接读存储**。组件想跟着变就 `subscribe`。

---

## 五、存储 key（都按分支隔离）

每个 key 实际存进 localStorage 时会拼上当前分支后缀，避免不同分支的调试状态互相污染：

```
sullyos.devDebug.flags.v1.<branch>      ← 开关状态（含 captureLogs 数组）
sullyos.devDebug.log.v1.<branch>        ← 分类捕获日志（各类混存，每条带 category 字段）
```

> 浮球位置 / 展开与否**不落 localStorage**（纯内存，刷新即回默认）；可用性（解锁 / 强制关闭）也是会话级内存标志。只有上面这两个 key 真正持久化。

`<branch>` 由 `__BUILD_BRANCH__` 归一化而来（非字母数字 `._-` 的字符替换成 `_`）。

---

## 六、现有开关

| 开关 | 类型 | 作用 | 副作用 |
|------|------|------|--------|
| `skipPromptBuild` | 行为 | 只发聊天历史，不注入 system prompt | 双语 / MCD / HTML / thinking 等增强全部关掉 |
| `skipEmotionEval` | 行为 | 主回复照常，但不跑本地 / Instant Push 的 emotion eval | 关掉后情绪不更新 |
| `captureEnabled`<br>（记录日志·总开关） | 行为 | 日志录制总闸：关掉时所有捕获类都不抓 | 默认关；关掉只是停录，**不清**已抓日志 |
| 捕获类 `api` | 捕获 | 抓普通聊天直发模型的 chat completions 请求 + 响应（`safeApi`） | 取消勾选只停此后抓取，**不清**已有日志 |
| 捕获类 `instant-push` | 捕获 | 抓 instant push 通道：经 worker 的 LLM 交换 + SSE 投递结果（超时/收到/失败） | 同上，取消勾选不清日志 |
| `exposeLogDetail`<br>（记录完整内容） | 抓取 | 关（默认）：`messages` 聊天历史数组整组换成一句 `…共 N 项（已折叠）`；开：整段存 | 影响**抓取 / 存储**；要完整须复现前打开，已抓的折叠版不可还原 |

捕获日志：各类**混存在一个数组**里、每条带 `category`，全局最多留 **100 条 / 1 MB**（先到先淘汰）。因为长文本在写入时就折叠了（见第九节），实际存的是瘦身版、很省空间，1 MB 基本撑不爆、轻松存满 100 条；导出（复制 / 下载）默认导全部、自动带上当前分支 + commit，并对密钥字段脱敏。

---

## 七、操作指南 A：加一个行为开关（skip 型）

以加 `skipMemoryRecall`（跳过记忆召回）为例，只动 2 个文件。

### 1. `utils/devDebug.ts` —— 加字段 + 默认值 + 归一化 + 便捷 getter

```ts
export interface DevDebugFlags {
    skipPromptBuild: boolean;
    skipEmotionEval: boolean;
    captureLogs: DevDebugCaptureCategory[];
    skipMemoryRecall: boolean;        // ← 新增
}

export const DEFAULT_DEV_DEBUG_FLAGS: DevDebugFlags = {
    skipPromptBuild: false,
    skipEmotionEval: false,
    captureLogs: [],
    skipMemoryRecall: false,          // ← 新增，行为开关一律默认 false
};

// normalizeFlags 里也要加一行（防止旧 localStorage 缺字段读出 undefined）
function normalizeFlags(value: unknown): DevDebugFlags {
    const source = ...;
    return {
        skipPromptBuild: source.skipPromptBuild === true,
        skipEmotionEval: source.skipEmotionEval === true,
        captureLogs: normalizeCaptureLogs(source.captureLogs),
        skipMemoryRecall: source.skipMemoryRecall === true,   // ← 新增
    };
}

export function isMemoryRecallSkipped(): boolean {
    return readDevDebugFlags().skipMemoryRecall;
}
```

> ⚠️ 三处一定都要改：`DevDebugFlags`、`DEFAULT_DEV_DEBUG_FLAGS`、`normalizeFlags`。漏了 `normalizeFlags`，老用户存档里没这字段，读出来是 `undefined`，行为不可控。

### 2. `components/DevDebugPanel.tsx` —— 在两个 skip 开关下面照抄一行

```tsx
<ToggleRow
    title="跳过记忆召回"
    detail="不注入历史记忆，用来隔离记忆相关的问题。"
    checked={flags.skipMemoryRecall}
    onChange={(checked) => updateFlag('skipMemoryRecall', checked)}
/>
```

`activeCount`（浮球小红点）已经按 `skipPromptBuild + skipEmotionEval + captureLogs.length` 累加——加一个新 skip 字段要顺手把它也加进 `activeCount` 的算式里。

### 3. 在业务代码里消费

```ts
import { isMemoryRecallSkipped } from '../utils/devDebug';

if (isMemoryRecallSkipped()) {
    console.warn('[DevDebug] Memory recall skipped.');
    return [];
}
```

> 习惯：开关命中时打一条 `console.warn('[DevDebug] ...')`，方便在控制台确认开关真生效了（参考 `chatRequestPayload.ts:158`）。

---

## 八、操作指南 B：加一类捕获日志（checkbox）

捕获类共用底座，加新类**不用碰 `DevDebugFlags` 结构**，面板也会自动多出一个开关。以加一类 `mcp`（抓 MCP 工具调用）为例：

### 1. `utils/devDebug.ts` —— 加 category + 元信息

```ts
export type DevDebugCaptureCategory = 'api' | 'instant-push' | 'mcp';   // ← 加一个字面量

export const DEV_DEBUG_CAPTURE_CATEGORIES: DevDebugCaptureCategoryMeta[] = [
    { key: 'api', title: 'API（普通聊天请求）', detail: '...' },
    { key: 'instant-push', title: 'Instant Push（通道事件）', detail: '...' },
    { key: 'mcp', title: '记录 MCP 调用', detail: '抓 MCP 工具的入参和返回。' },  // ← 加一行
];
```

> 面板靠遍历 `DEV_DEBUG_CAPTURE_CATEGORIES` 渲染并排 checkbox，加了这一行就自动多一个，**不用动 Panel 代码**。注意：面板只用 `title` 当短标签，`detail` 现在不渲染（仅作源码文档）。

### 2.（可选）写一个语义化薄封装

底层 `appendDevDebugLog(category, { label, data })` 已经够用，但给每类包一层薄封装调用更顺手、字段更整齐（参考文件末尾的 `appendDevDebugApiLog` / `appendDevDebugInstantPushLog`，HTTP 形状的可直接复用 `appendDevDebugHttpLog`）：

```ts
export function appendDevDebugMcpLog(input: { tool: string; args: unknown; result?: unknown }): void {
    appendDevDebugLog('mcp', {
        label: `MCP ${input.tool}`,
        data: { tool: input.tool, args: input.args, result: input.result },
    });
}
```

### 3. 在业务代码里捕获

```ts
import { appendDevDebugMcpLog } from '../utils/devDebug';

const result = await callMcpTool(tool, args);
appendDevDebugMcpLog({ tool, args, result });   // 没勾 mcp 时是空操作，零成本
```

`appendDevDebugLog` 自带的保护，调用方都不用操心：

- **门禁**：对应 category 没勾就直接 return，零成本。
- **脱敏**：`data` 里 key 名命中 `api_key / authorization / bearer / token / secret / endpoint / p256dh / auth` 的字段，值替换成 `<redacted>`（正则见 `SECRET_KEY_PATTERN`）。
- **折叠**：默认把 `data` 里超 10 字的长文本截成「前 10 字 + `...`」再落库（省空间 / 隐私）——所以你新加的捕获类导出默认也是瘦身版，要原文得复现前开「记录完整内容」，详见第九节。
- **容量**：全局最多最近 100 条、超 1 MB 从头丢，不会撑爆 localStorage。
- **永不抛**：内部整个包了 try/catch，日志失败不影响主流程。

> 想自己看一眼，用 `console.log('[模块名] ...')` 就行；只有当你需要把整份请求 / 响应**导出成文件发给别人排查**（或存档、版本间对比）时，才值得加一类捕获。

---

## 九、复制 / 下载日志

面板底部有两个按钮，都调 `formatDevDebugLog()` 拿同一份 JSON（默认全部类别；传 category 可只导一类）：

- **复制**：写进剪贴板，丢给别人 debug。
- **下载**：存成 `devdebug-log-<分支>-<时间>.json` 文件，适合日志大、或要存档对比的场景。
- **清空**：只清掉已抓的日志，**不动**总开关 / 类型勾选 / 完整内容。跟「关掉总开关」（清完之后类型 UI 也收起）和「重置」（连开关一起回默认）是三件事，挑最小动作做。

导出的 JSON 顶层带 `exportedAt` + `build.{branch,commit}`，方便定位"到底是哪个版本、什么时候抓的"。

### 长文本折叠（`exposeLogDetail`）

LLM 日志里的聊天历史动辄几十条，整段塞进 localStorage 很快就把 1 MB 吃满、存不了几条。所以**默认在写入时只折一处**：递归找对象里 key 名等于 `messages` 且值是数组的字段（任意嵌套深度），整组替换成一句 `…共 N 项（已折叠）`——首条通常是体积最大的 system prompt，留着没省到多少空间，要看就开「记录完整内容」。**其它字段（url / status / error.reason / response.outcome / 任意键值）一律原样保留**——之前的版本会无差别把超过 10 字的字符串截成「前 10 字 + `...`」，结果连 `reason: "flush-not-confirmed"` 这种关键短字段都看不到，现在不折了。容量保护靠下面那条「100 条 / 1 MB 先到先淘汰」兜底。

- 折叠发生在**写入层 `appendDevDebugLog()`**——`localStorage` 里存的就是瘦身版（messages 已折），容量限制作用在瘦身后的数据上。
- **代价**：要看完整 messages 历史得**在复现之前**先开「记录完整内容」（`exposeLogDetail`），之后抓的才整段存；**已抓的折叠版无法事后还原**（原文压根没存过）。
- 折叠只动每条的 `data` 里嵌的 `messages` 数组（整组替换成一句 metadata）；`label`（含完整 url，便于定位）和 `id` / `timestamp` / `category` 保留；其它任何字段（含数组）都原样。每条带 `collapsed` 标记记录抓时折没折（expose 中途切换会让一份日志混着两种）。
- 导出 JSON 只要有折叠条目，顶层就带一句 `note` 提示，拿到日志的人一眼知道 messages 被截过、别当完整看。

> 折叠是**通用**的——对所有捕获类的 `data` 一视同仁，未来加的捕获类自动享受，不用各自处理。当前规则只有一条：递归遇到 key=`messages` 的数组就整组替换成 metadata，其它字段一律原样。

---

## 十、容易踩的坑

- **改了开关行为，记得同步改面板 / category 的 `detail` 文案**，否则别人按文案理解会和实际不符。
- **总开关 `captureEnabled` 是录制总闸**：光勾类型不会录，得把总开关打开；关掉总开关 = 一次「录制周期」结束 —— **立即清空已抓日志**（清空动作落在 `writeDevDebugFlags` 数据层，任何路径改 `captureEnabled` true → false 都触发，不只 UI handler）、把「类型 / 记录完整内容 / 复制 / 下载」整段 UI 收起；勾选的类型 + `exposeLogDetail` 作为下次的**配置**保留。
- **取消勾选某个捕获类 = 只停此后抓取，不清已有日志**（勾选是纯选择）。想清日志走面板「重置」——它会一并把总开关关掉、清空全部勾选和日志，比"全不勾"更彻底。
- **容量是全局共享的**（100 条 / 1 MB，各类混算）：某一类刷得很猛会把别的类挤掉，排查时注意。删了字符串截短之后每条 response 完整保留，单条体积变大（典型 5–10 KB），1 MB 大约 100 条上下——跟 MAX_LOG_ENTRIES 同档，先到先丢的保护仍然成立。
- **`exposeLogDetail`（记录完整内容）必须复现前开**：它管的是"抓取时存不存完整"，不是导出时才展开。中途打开只对**之后**抓的生效，已经抓下来的折叠版还原不了（原文没存过）。这是用空间换的，符合"大多数时候不需要那堆历史"的设计取舍。
- **存储按分支隔离**：切到别的分支构建，之前的开关状态 / 日志不会带过来，是预期行为。
- **master 上看不到面板是正常的**，要么切开发分支，要么 `VITE_SHOW_BUILD_BADGE=1`。
- **行为开关默认值一律 `false`、捕获类默认不勾**：dev 开关是"出问题时手动打开来隔离变量"的，默认不能改变正常行为。

---

## 十一、TODO：还没接入 devDebug 的日志支线

`makeDebugLogger` 已经把 P1 等价的错误支线接进来了（safeApi 重试、InstantPush HTTP failure / fetch threw / saveOutboundSession、ActiveMsg post-processing / saveMessage / requeue lost / flushInboxToChat、amsg multipart expired）。下面这些还没接，价值递减或工程量大，**单点踩坑时再换成 `log.warn(...)` 即可**（每条改 1 行）：

### P2 — 价值递减的前端支线

| 文件 | 行 | 标签 | 干嘛 |
|------|----|------|------|
| `utils/instantPushClient.ts` | — | （已无遗漏） | — |
| `utils/activeMsgRuntime.ts` | 166 | `[ActiveMsg] claimReasoning failed` | reasoning 兜底失败 |
| `utils/activeMsgRuntime.ts` | 183 | `[ActiveMsg] restore xhs session notes failed` | xhs note 恢复失败 |
| `utils/activeMsgRuntime.ts` | 237 | `[push:toast]` | 通知文案 |
| `utils/activeMsgRuntime.ts` | 346 | `[DevDebug] instant-push LLM log failed` | **自身的元错误，别接！会绕死或加重 bug** |
| `utils/activeMsgRuntime.ts` | 385 / 387 / 390 | `[push:memory-palace]` 几条 | 记忆宫殿 stage / 异常 |
| `utils/activeMsgRuntime.ts` | 445 | `[flush:emotion_update] apply failed` | 情绪更新落库失败 |
| `utils/activeMsgRuntime.ts` | 569 | `[instant-push] runPendingToolCalls failed` | 工具调用待办失败 |
| `utils/activeMsgRuntime.ts` | 604 | `[ActiveMsg] backfill reasoning failed` | reasoning 回填失败 |

> 接的姿势就是：模块顶 `const log = makeDebugLogger('instant-push', '<Tag>')`（已有就复用），然后 `console.warn('[Tag] event', ...x)` 换成 `log.warn('event', ...x)`。

### SW 端（Service Worker context，工程量大）

SW 跑在自己的 context，没法直接访问 page 的 `localStorage` / `appendDevDebugLog`。要接 devDebug 得走一条新通道：

1. SW 端攒一份 trace ring buffer（已有 `[InstantTrace:SW]` 在 `worker/sw-keep-alive.ts`）
2. page 端解锁面板时，向所有 SW client `postMessage({ type: 'GET_DEBUG_TRACE' })` 拉一份
3. page 端收到 SW 回包 → 写进 devDebug 的 `instant-push` 类目

涉及范围（grep 出来的 SW 端日志，先列着）：

| 文件 | 行 | 标签 |
|------|----|------|
| `worker/sw-keep-alive.ts` | 107 | `[InstantTrace:SW]` |
| `worker/sw-keep-alive.ts` | 486 | `[amsg] clearReasoningBuffer before tool_request failed` |
| `worker/sw-keep-alive.ts` | 531 | `[amsg] tool_request notification failed` |
| `worker/sw-keep-alive.ts` | 579 / 589 | `[amsg] blob fetch ...` |
| `worker/sw-keep-alive.ts` | 632 | `[amsg] error push` |
| `worker/sw-keep-alive.ts` | 642 | `[amsg] unknown messageKind, falling back to content` |
| `public/sw-keep-alive.js` | 234 / 240 / 436 / 449 / 509 / 539 / 551 | `[rei-standard-amsg-sw] ...` 系列 |
| `public/sw-keep-alive.js` | 689 / 739 / 854 / 881 / 891 | `RESTORE ERROR` |
| `public/sw-keep-alive.js` | 1308 | `[InstantTrace:SW]`（构建产物里也叫这名） |

> **建议路径**：等真的有 SW 端 bug 需要远端排障时再做（开发本地 SW 在 DevTools 单独面板就能看，价值不大）。做的时候在 `utils/swVersion.ts` 旁边新增 `utils/swTrace.ts` 包通信协议。
