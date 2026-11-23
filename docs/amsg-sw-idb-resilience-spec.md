# Spec: `@rei-standard/amsg-sw` IndexedDB 连接韧性修复

目标与红线见 [主动消息 2.0 总纲](./amsg2-overview.md)。

> ✅ **已实现并发版**：Gap 1（onclose + 事务级 InvalidStateError 重开兜底，dedupe / queue / multipart 库全覆盖）和 Gap 2（DELIVER ack 新增可选 `businessError` 字段，并把失败持久化到 dedupe 记录上，重复包也带 businessError）从 `@rei-standard/amsg-sw@2.3.0` 起提供。SullyOS 当前用 `@rei-standard/amsg-sw@2.4.0`、`amsg-shared@0.5.0-next.0`，`worker/sw-keep-alive.ts` 的 `SW_VERSION` 为 1.23.0。下文保留为设计记录。

> 交接给 amsg-sw 包维护方。本文描述两个**包内**的 IndexedDB 韧性缺口，给出修复方案与验收标准。
> SullyOS 侧的根因（主库连接风暴）已在 SullyOS 仓库自行修复（见文末「分工」），这里只列需要包升级才能解决的部分。
>
> 写这份 spec 时 SullyOS 锁的版本：`@rei-standard/amsg-sw@2.2.0`、`amsg-shared@0.2.0`。
> 下面引用的行号均指 `amsg-sw@2.2.0` 的 `dist/index.mjs`（发布产物），供你对照包源码定位。

---

## 背景：现象与触发链

SullyOS 是 local-first 应用，整个 origin 跑着多个 IndexedDB 库（应用主库 `AetherOS_Data`、`ActiveMsg` inbox、以及本包的 `rei-sw` dedupe/queue 库）。在高并发下，Chromium 底层 backing store 一旦报错（`Internal error opening backing store for indexedDB.open`），**可能强制关闭**该 origin 已打开的连接（这是结合「多个库同时报错」的现场得出的推断，不是单条日志能坐实的铁证；也不排除磁盘/配额/profile 损坏等其它诱因）。被强关的连接通常不会触发 `versionchange` 事件，而是触发 `close` 事件，之后对它发起事务会抛：

```
InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing
```

本包当前对「连接被强关」这种失效**没有自愈**，于是出现两个问题。

> 注意失败点的顺序：`handlePushPayload`（dist `:96`）**第一步**就是 `await maybeCleanupMultipart(...)`（dist `:97`，走 queue 库 `cachedDB`），multipart push 还会先过 `acceptMultipartChunk`（dist `:100`，同样 queue 库），**之后才轮到** `claimDedupe`（dist `:104`，dedupe 库）。所以一旦连接被强关，**queue/multipart 库往往比 dedupe 库更早把整条投递链路掐断**。下面 Gap 1 的修法对 dedupe 库和 queue 库要同等对待，不是「dedupe 为主、queue 同理」。

---

## Gap 1（必修）：dedupe / queue 连接被强关后，缓存里的死连接被无限复用

### 现状

- `openDedupeDatabase(dedupe)`（dist `dist/index.mjs:1010`）把连接缓存在 `dedupeDbCache`（Map，key=`${dbName}:${storeName}`），`openQueueDatabase()`（`:1035`）缓存在模块级 `cachedDB`。
- 两者**只在 `onversionchange` 时**清缓存：

  ```js
  // openDedupeDatabase, :1026
  db.onversionchange = () => { db.close(); dedupeDbCache.delete(cacheKey); };
  // openQueueDatabase, :1055
  cachedDB.onversionchange = () => { cachedDB.close(); cachedDB = null; };
  ```

- **没有挂 `db.onclose`**。当连接被浏览器强制关闭（backing store 出错 / 存储压力 / 用户清数据），`versionchange` 不会触发，缓存里这条**已死连接**一直留着。
- `withDedupeStore`（`:984`）/ `withDatabaseStore`（`:975`）每次都复用缓存连接发事务：

  ```js
  async function withDedupeStore(dedupe, mode, handler) {
    const db = await openDedupeDatabase(dedupe);          // 拿到死连接
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(dedupe.storeName, mode); // ← 抛 InvalidStateError
      ...
    });
  }
  ```

  `db.transaction()` 在死连接上**同步抛** `InvalidStateError`，Promise executor 捕获后 reject。

### 后果

1. **去重彻底失灵 + push 落库被阻断**：`handlePushPayload`（`:104`）第一步就是 `await claimDedupe(...)`，它走 `withDedupeStore`。死连接让 `claimDedupe` 抛错 → `handlePushPayload` 在 `dispatchBusinessPayload` 之前就抛 → 业务回调（消费方写 inbox 等）**根本不执行** → `handleDeliverMessage`（`:120`）catch 后回 `ok:false` ack。**不重启 SW 永远好不了**，因为缓存里的死连接不会被任何路径清掉。
2. **`dedupe cleanup failed` 刷屏**：`maybeCleanupDedupe`（`:450`）周期性跑 `cleanupDedupeStore`，同样复用死连接，每次都抛 `InvalidStateError`，被 `:459` 的 `console.error("dedupe cleanup failed:", error)` 打出来，刷屏几十上百条。
3. 同理 `cachedDB`（queue / multipart 库）一旦被强关也是死的，multipart 重组、queue 操作全挂。

### 修复方案

**(a) 挂 `onclose` 清缓存**——和现有 `onversionchange` 对称：

```js
// openDedupeDatabase
request.onsuccess = () => {
  const db = request.result;
  dedupeDbCache.set(cacheKey, db);
  const drop = () => { dedupeDbCache.delete(cacheKey); };
  db.onversionchange = () => { db.close(); drop(); };
  db.onclose = () => { drop(); };   // ← 新增：被强关时清缓存
  resolve(db);
};
```

```js
// openQueueDatabase
request.onsuccess = () => {
  cachedDB = request.result;
  cachedDB.onversionchange = () => { cachedDB?.close(); cachedDB = null; };
  cachedDB.onclose = () => { cachedDB = null; };   // ← 新增
  resolve(cachedDB);
};
```

**(b) 事务级一次重开兜底**——`onclose` 是异步事件，可能晚于下一次事务调用；而且 `db.transaction()` 是**同步抛**。所以 `withDedupeStore` / `withDatabaseStore` 要捕获「连接 closing/closed」错误，清缓存、重开一次、重试一次：

```js
function isConnectionClosingError(e) {
  return e && (e.name === 'InvalidStateError' ||
    /connection is closing|database connection is closing/i.test(String(e && e.message)));
}

async function withDedupeStore(dedupe, mode, handler) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let db;
    try { db = await openDedupeDatabase(dedupe); }
    catch (e) {
      if (attempt === 0) { invalidateDedupeCache(dedupe); continue; }
      throw e;
    }
    try {
      return await new Promise((resolve, reject) => {
        let transaction;
        try { transaction = db.transaction(dedupe.storeName, mode); }  // 同步抛 InvalidStateError
        catch (e) { reject(e); return; }
        const store = transaction.objectStore(dedupe.storeName);
        transaction.onerror = () => reject(transaction.error || new Error("Dedupe transaction failed"));
        Promise.resolve(handler(store, resolve, reject)).catch(reject);
      });
    } catch (e) {
      if (attempt === 0 && isConnectionClosingError(e)) { invalidateDedupeCache(dedupe); continue; }
      throw e;
    }
  }
}
```

`withDatabaseStore`（queue 库）同理，`invalidate` 改成 `cachedDB?.close(); cachedDB = null;`。重试上限 1 次，避免无限循环；第二次仍失败就如实抛出。

---

## Gap 2（建议修，SullyOS 不阻塞）：DELIVER ack 的 `ok:true` 不反映业务落库结果

### 现状

`dispatchBusinessPayload`（`:143`）把消费方 `onBusinessPayload` 的 rejection **吞掉**了：

```js
// :169
if (typeof defaults.onBusinessPayload === "function") {
  try {
    const result = defaults.onBusinessPayload(payload);
    if (result && typeof result.then === "function") {
      businessWork = Promise.resolve(result).catch((error) => {     // ← rejection 被吞
        console.error("[rei-standard-amsg-sw] onBusinessPayload promise rejected:", error);
      });
    }
  } catch (error) { console.error(...); }
}
await Promise.all(notificationWork);
...
if (businessWork) await businessWork;   // :186 已经 catch 过, 永不 reject
```

于是 `handlePushPayload` 不会因为业务失败而抛，`handleDeliverMessage`（`:128`）照样回 `ok:true`。**即「业务落库失败，ack 仍报成功」。**

### 影响评估

- **对 SullyOS 不构成 bug**：SullyOS 客户端不信这个 ack——它把成功信号绑在业务侧自己 `postMessage` 的 `active-msg-received` 事件上（落库成功后才 fire），ack 的 `ok` 只用来区分超时文案。所以「ack 撒谎」在 SullyOS 这条链路上不会变成「假成功」。
- **对「信 ack = 业务已处理」的其它消费方是真坑**：这类消费方会把没落库的消息当成功。

### 建议（二选一，保持向后兼容）

- **方案 A（推荐，非破坏）**：ack 增加一个可选字段透传业务错误，`ok` 维持现含义（= 已收下并分发）：

  ```js
  respondToSender(event, { ok: true, duplicate, key, requestId,
    businessError: result.businessError /* 业务回调 reject 时填 message, 否则 undefined */ });
  ```

  需要 `dispatchBusinessPayload` 把 `onBusinessPayload` 的 rejection 捕获后**回传**（而不是只 console.error），并 `await` 它再 ack。

- **方案 B（opt-in 改语义）**：`installReiSW` 增加 `ackReflectsBusiness?: boolean`，开启后业务失败让 `handleDeliverMessage` 回 `ok:false`。默认 false 保持现状。

无论哪种，文档里要写清 DELIVER ack 的 `ok` 到底代表「收下」还是「已落库」。

---

## 验收标准

1. **dedupe 自愈**：下一次 `claimDedupe` 能透明重开并成功，**不再持续抛 `InvalidStateError`**，无需重启 SW。注意两条失效路径要分开测，别混为一谈：
   - **事务级重开兜底（(b)）**：让缓存里的连接处于 closing/closed 态后再发事务——可 mock `db.transaction` 抛 `InvalidStateError`，或对拿到的连接调 `db.close()` 后复用它（`close()` 是正常关闭、**不会**触发 `close` 事件，所以这条测的是「死连接 → 事务抛错 → 清缓存重开」，不是在验证 `onclose`）。
   - **`onclose` 清缓存（(a)）**：要单独验证「连接被强关 → `close` 事件 → 缓存被清」，得 mock/手动派发那条失效路径（如直接调用挂在连接上的 `onclose` 回调），不能用 `db.close()` 代替。
2. **业务不被阻断**：上述场景下，dedupe 短暂失败并恢复后，`onBusinessPayload` 仍被调用、push 仍能落库。
3. **cleanup 不刷屏**：连接被强关后，`maybeCleanupDedupe` 重开成功，不再每轮 `dedupe cleanup failed`。
4. queue / multipart 库（`cachedDB`）同样适用 1–3。
5.（若采纳 Gap 2）DELIVER ack 能区分「业务落库失败」与「传输成功」。

---

## 分工与发版

| 侧 | 改什么 | 状态 |
|----|--------|------|
| **amsg-sw 包** | 本 spec 的 Gap 1（必修）、Gap 2（建议） | ✅ 已实现，随 2.3.0 发版 |
| **SullyOS** | 主库 `utils/db.ts`、`utils/activeMsgStore.ts`、SW `worker/sw-keep-alive.ts` 的 IDB 连接全部改单例复用 + `onversionchange`/`onclose` 失效自愈 + `onblocked` 统一清缓存重试；另把 `apps/pixelHome/pixelHomeDb.ts`（之前自带一个裸开同一个 `AetherOS_Data` 的 `openDB`）并到共享单例。这是连接风暴的**根因**，消除后 backing store 不再被撑爆，Gap 1 的强关诱因基本消失，Gap 1 退化为「极少数其它原因强关」的兜底 | ✅ 已修 |

**发版后 SullyOS 侧动作**：bump `package.json` 里 `@rei-standard/amsg-sw` 版本 → `pnpm install` → `pnpm run build:workers`（bundle 自动带上修好的包）→ bump `worker/sw-keep-alive.ts` 的 `SW_VERSION`（触发字节比较让浏览器重装 SW）。
