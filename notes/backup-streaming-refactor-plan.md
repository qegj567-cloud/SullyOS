# 备份链路流式化改造方案（v2 格式）

> 二代分片格式的设计记录。之后的内存有界改造（落盘、按需读包、逐页恢复、统一格式）见 [`docs/backup-pipeline.md`](../docs/backup-pipeline.md)。

## 1. 背景与目标

SullyOS 是 local-first 的浏览器虚拟手机，全部数据存在 IndexedDB（主库 `AetherOS_Data`，50+ store）。
备份功能把这些 store 导出成一个 DEFLATE zip。当前实现从「攒数据」到「打包」到「上传」到「还原」
几乎每一步都是**整库/整包压在内存里、没有分片均衡**，重度账号（万级向量、几十万条消息、
几百 MB base64 素材）在备份时会：

- **确定性硬崩**：对单个超大 store / 整包 JSON 做 `JSON.stringify`，文本逼近 JS 单字符串 ~512MB
  上限 → `RangeError: Invalid string length`。这是「直接崩」，不是变慢。
- **概率性 OOM**：`getAll()` 整表 + 向量解码膨胀 + stringify 多份副本叠加，撑爆移动端浏览器内存。

目标（已 narrow，诚实版）：

- **彻底消除确定性硬崩**：分片后任何单根字符串都有界，永不触 `RangeError`。这是本轮的核心承诺。
- **显著降低 OOM 概率**：去掉 `join('')` 的整包翻倍（~2× → ~1×）；#2 向量转二进制再砍掉重度
  记忆宫殿账号的最大一块（number[] 文本 → 原始字节，~4-5×）。
- **不承诺 `O(单片)` 峰值**：JSZip 在 `generateAsync` 前会攥着所有文件，导出峰值仍 ~O(整包未压缩)，
  导入峰值 ~O(整树)。真要降到 `O(单片)` 必须换流式压缩库（fflate）+ 落盘流，工作量过大，**本轮不做，
  列为 follow-up**（见 §7）。所以极端账号（几十万消息 + 几百 MB 图叠低端机）仍可能 OOM——但不再有
  「低门槛、铁定触发」的 RangeError。
- **老备份永远还能导入**。

本轮范围 = 工程改造（#1/#2/#3/#5/#6），不动「该不该删老消息」那类产品决策（原 #4，已单独搁置）。

## 2. 现状确诊（带行号）

| 环节 | 位置 | 现状 | 问题 |
|------|------|------|------|
| 整表读 | `db.ts:2176 getRawStoreData` | `store.getAll()` 一次性整表进内存 | 无游标分批，峰值 = 整个 store |
| 向量解码 | `OSContext.tsx:2857-2875` | 整库 `.map` 把 `Uint8Array` 解成 `number[]` | 再复制一份且膨胀，之后还要 stringify |
| 单 store 序列化 | `OSContext.tsx:3038` | `JSON.stringify(单个大数组)` | 单库文本可超 512MB → RangeError |
| 拼整包 | `OSContext.tsx:3032-3047` | `jsonParts.join('')` 拼成一根 `data.json` 大字符串 | 整备份再复制一份，峰值翻倍 |
| 压包 | `OSContext.tsx:3054` | `zip.generateAsync({type:'blob',streamFiles:true,level:9})` | 入参 `data.json` 已成型；JSZip 生成前持有全部文件 |
| WebDAV 上传(web) | `webdavClient.ts:204-228` | XHR `send(blob)` 经 Worker 代理 POST | **blob 本身是流式的**，真风险是 Worker body 上限 + 上行超时 |
| WebDAV 上传(native) | `webdavClient.ts:86,190-201` | `blob.arrayBuffer()` 整包 → CapacitorHttp PUT | 整包进 ArrayBuffer，内存翻倍；且 CapacitorHttp 无法流式传 Blob |
| import 解析 | `OSContext.tsx:3160-3167` | `loadAsync` 整包 + `data.json` 整串 + `JSON.parse` 整树 | 整棵对象树同时在内存 |
| import 素材回填 | `OSContext.tsx:3176-3259` + `db.ts:2487` | **已是按 50 条 chunk 跑 beforeWrite、写完释放** | 这块已经均衡，不是瓶颈 |
| import 写库 | `db.ts:2470-2496 putItems` | CHUNK_SIZE=50 分批 put + 释放 | 已经均衡，不是瓶颈 |

**结论**：真正没做均衡的是 **导出侧的「整表读 → 单 store stringify → join 整包」** 和 **import 侧的
「整包 JSON.parse」**。import 的素材回填和写库其实已经分块了（这点要纠正之前的判断）。

## 3. v2 备份格式设计

保持 zip 容器不变，改内部布局：

```
backup.zip
├── manifest.json                  ← {formatVersion:2, mode, createdAt, stores:{<field>:{parts:N, count:M}}, assetCount}
├── metadata.json                  ← 所有「非 store」字段：theme/API 配置/customIcons/appearancePresets/socialAppData/设置等（R4·F2）
├── stores/characters.json         ← 小 store：整数组一个文件
├── stores/messages.000.json       ← 大 store：分片，每片 ≤ SHARD_BYTES（如 32MB）或 ≤ SHARD_ITEMS（如 5000 条）
├── stores/messages.001.json
├── stores/memory_vectors.index.json ← 向量元数据索引（每条 memoryId/charId/dims/model/byteLen）
├── stores/memory_vectors.bin      ← 向量 Float32 原始字节，按 index 顺序拼接（#2）
└── assets/asset_xxx.png           ← 图片照旧抽出去 + 全局去重（不变）
```

要点：
- **字段名 vs store 名**：沿用现有 `backupData` 的字段命名（`themes→customThemes`、`gallery→galleryImages`
  等，映射在 `OSContext.tsx:2930` 的 switch）。`manifest.stores` 的 key 用字段名，import 时喂给
  `importFullData`（它本来就按字段名认数据），改动面最小。
- **大 store 分片（sharding）**：单个 store 即使本身 >512MB，分成多片后每片独立 stringify、写进 zip、释放，
  避免触 RangeError。**单条超大记录护栏（Finding 5）**：按累积超 `SHARD_BYTES`/`SHARD_ITEMS` flush；若**单条
  记录**序列化就超预算（图片已抽 assets/，剩极端是超大文本/字体 base64 等留在 JSON 的字段），它独占一片；
  若单条 JSON 仍超硬上限（如 256MB），**干净报错、不产出半截 zip**，绝不退回 RangeError。
- **manifest 驱动 import**：导入时先读 manifest 决定走哪些文件、每个 store 几片，不靠猜文件名。
- **manifest 枚举本 mode 的所有 store（含 count:0）**：空 store 也必须列出，否则「源为空、目标有旧数据」时
  旧数据残留、full restore 名不副实（Finding 1·空 store 残留）。
- **单一真相源 `BACKUP_STORE_SPECS`（修 R3·Finding 1）**：一张声明表，每个被备份的 store 一条——
  `{ store, field, shape: array|singleton|composite, restore: clear-and-add|merge|put|singleton, emptyBehavior }`。
  **导出、manifest、导入共读这一张表**，杜绝「导出 switch 和 importFullData 各写一套、彼此漂移」。
  - 为什么不能「count:0 一律置 `[]`」：导入器各 store 行为不一致——clear-and-add 扔 `[]` 会清；merge（themes/
    emojis/categories/stickers）扔 `[]` 啥也不清；singleton（userProfile/lifeSim/vrMusic/vrGuestbook）扔 `[]` 会写
    **空壳**把好数据冲掉。所以空时清不清、传什么形状，**按 spec 来**。
  - **范围**：目标是 v2 还原**与 v1 行为完全一致、且不写空壳**；**不**顺手修 v1 本身「merge 不镜像」的老语义
    （那是独立课题，超本轮）。
  - **mode 专属虚拟字段（修 R4·F1，critical）**：spec 不是「每 store 一条静态行」就够——要建模 mode 专属字段和
    跨字段不变量：① `mediaAssets` 是 media_only 下 characters 的**投影**（不是 characters store 本身）；
    ② messages 在 media_only 下只筛 image/emoji；③ importFullData 靠「`data.characters` 在不在」判断 messages
    是否破坏性写——所以 **media_only 绝不能把 characters/messages 物化成 `[]`**，否则会误清掉文字/聊天。
    spec 要按 mode 给出**各自的应有字段集**，media_only 的集合里是 `mediaAssets`，不是 `characters`。
  - **非 store 字段单独装（修 R4·F2）**：theme/API 配置/customIcons/appearancePresets/socialAppData/设置等不是
    IndexedDB store，进 `metadata.json`，同样跑素材抽取/还原，纳入预检与组装。

## 4. 逐项改造

### #1 整表读 → 游标分批读（`db.ts`）
- 新增 `getStoreDataChunked(storeName, onBatch, batchSize)`：用 `store.openCursor()` 游标，每攒够
  `batchSize` 条回调一次 `onBatch(batch)`，回调内消费完即释放，绝不在内存里攒整表。
- `getRawStoreData` 保留（老 import 路径 / 其它调用方还用），不动。
- **效果**：导出读取阶段内存从「整个 store」降到「一个 batch」。
- **影响**：所有走新导出的 store 改用游标读；回归测试钉「不漏条、顺序与 getAll 一致」。

### #3 流式骨架 + v2 格式（`OSContext.tsx exportSystem` / `importSystem`）
- **导出**：对每个 store，游标分批读（#1）→ 每批做图片抽取（复用现有 `processObject`/`extractImagesInPlace`，
  逻辑不变）→ 累积到当前分片缓冲，超过 `SHARD_BYTES`/`SHARD_ITEMS` 就 `zip.file('stores/<field>.NNN.json', 分片串)`
  并清空缓冲 → 释放该批对象。小 store 不分片，单文件。
- 写 `manifest.json` 收尾，删掉老的 `largeArrayKeys` + `jsonParts.join('')` 整包逻辑。
- **导入（assemble-then-import-once，修 Finding 1）**：`loadAsync` 后先找 `manifest.json`；存在且
  `formatVersion>=2` → 走 v2 路径：
  1. **先校验**：先确认 `formatVersion === 2`（Finding 4）；**再从 `BACKUP_STORE_SPECS` + mode 算出「完整应有
     字段集」，要求每个应有 store/虚拟字段（含 count:0、composite、`metadata.json`）都在 manifest 里——漏声明
     当损坏、abort（修 R4·F3，防 export 漏 store 导致静默留旧数据）**；再确认 manifest 声明的每个分片文件、
     `memory_vectors.bin`、`metadata.json` 都在 zip 里（缺则 abort，此时 DB 一字未动）。**素材文件（`assets/*`）不进这道硬边界（已定·Finding 2，选 A）**：
     缺图维持 v1 的 warn+skip——缺图只可能来自篡改，且真丢了也无从恢复，为它拒绝整个导入没意义。实现处写注释
     说明此豁免。
  1b. **资源预检（修 R3·Finding 3）**：按 manifest 的 count + zip 未压缩体积 + bin/asset 体积估算导入峰值，
     超过设备阈值就**干净拒绝、根本不开始导入**（数据完好），避免「强机导得出、弱机导一半 OOM 把旧数据毁了」。
  2. **再组装（按 `BACKUP_STORE_SPECS` 还原模式，修 R3·Finding 1）**：逐 store 逐片 `file.async('string')` +
     `JSON.parse(单片)`，把同一 store 的各片**拼回完整数组**，parse 完一片即释放该片字符串；向量从 `.bin`+index
     重建成 `MemoryVector[]` 塞进 `data.memoryVectors`；**解析 `metadata.json` 把非 store 字段填回 `data`（R4·F2），
     素材回填同样覆盖它**。空 store 按 spec 处理（clear-and-add 才置 `[]` 清旧；merge/singleton 按 v1 形状，
     **不写空壳**；media_only 不物化 characters/messages，R4·F1）。**轻量自洽校验（修 R3·Finding 2，瘦身版）**：每片必须是数组、
     `组装后条数 === manifest count`、每条向量 `byteLength === dimensions*4`——抓的是我们自己的 export bug，
     不是防篡改（offset 单调不重叠那套深校验不做）。组装出完整的 `data` 对象。
  3. **后写库**：调用**一次**现有的 `DB.importFullData(data, ...)`——每个 store 的完整数组只经过一次
     `clearAndAdd`，自然只 clear 一次（不会出现「第二片把第一片清掉」）；characters↔mediaAssets 等跨字段
     逻辑、分块写库、素材回填钩子全部原样复用，不重写。
  - **为什么不按 codex 说的「clear once + 逐片 append」**：那要把 importFullData 拆成可逐片调用、还得自己
    复刻跨字段逻辑。assemble-then-import-once 更简单、复用现有逻辑，且「组装在前/写库在后」天然就是
    Finding 3 要的「破坏性写之前的校验边界」。**代价**：import 峰值 ≈ 整树（与现状 v1 相同，narrow 下接受）。
- **效果**：消除导出侧 join 整包 + 单 store stringify 的 RangeError；导入侧修掉跨片清库的数据丢失。
- **影响**：导出主流程重写；导入新增 v2 组装路径（写库仍走旧 importFullData）；manifest 是新增契约。

### #2 向量走二进制（`OSContext.tsx` + `utils/memoryPalace`）
- 导出：`memory_vectors` 不再解码成 `number[]` 进 JSON。游标读出每条，**先过现有归一化路径
  （ensureFloat32/vecForStorage：Uint8Array / Float32Array / 遗留 number[] 三态统一成 Float32 字节，修 R4·F4）**——
  现有 IndexedDB 里可能还存着没迁移的遗留 number[] 向量，不归一化直接当 Uint8Array 读会写出无效字节。
  归一化后顺序写进 `memory_vectors.bin`（拼接字节），按归一化后的字节算 `byteLength`，往 `memory_vectors.index.json`
  push 一条 `{memoryId, charId, dimensions, model, byteOffset, byteLength}`。
- 导入：读 index + bin，按 offset/len 切出每条 `Uint8Array`，组回 `MemoryVector[]`，**塞进 `data.memoryVectors`，
  跟其它 store 一样走那一次 `importFullData` 的 memory_vectors 段（clear-once）**——不走 `saveMany` 旁路。
  `saveMany` 是 upsert、不清旧数据，当旁路用会让目标上旧向量残留、破坏 clear-once 不变量（Finding 3）。
- **效果**：同时干掉「解码膨胀」和「向量内联进 JSON 撞上限」两个崩点，体积也更小（二进制 vs JSON 文本 ~4-5×）。
- **影响**：备份格式里向量部分变二进制；import 要兼容老备份里向量仍是 `number[]` 的情况（见 §5）。

### #5 WebDAV 上传（`webdavClient.ts`）——**本轮最受限、最该被质疑的一项**
- 先纠正：备份 blob 已是压缩 zip，**gzip 上行无效**，从方案里删掉。
- web 路径 XHR `send(blob)` 已是流式，**内存不是瓶颈**；真瓶颈是 Worker 代理 body 上限 + 上行超时。
  WebDAV 协议是单次 PUT，不原生支持分片/续传；分块 PUT（Content-Range）依赖服务端支持，不通用。
- native 路径 `blob.arrayBuffer()` 整包进内存是真问题，但 CapacitorHttp 无法流式传 Blob，
  彻底解需改成「先写临时文件、用支持文件路径上传的原生能力 PUT」，是更大的改动。
- **本轮拟定动作（保守）**：(a) 给上传加大小预检 + 明确报错（超 Worker 限制时提示用户用本地导出/GitHub），
  (b) native 端尽量避免额外拷贝、或文档化其上限。**是否值得在本轮就上「临时文件上传」存疑，留给评审定。**
- **影响**：可能本轮 WebDAV 只做「预检 + 提示」，把「大账号云备份」正式收口留到下一轮。

### #6 import 流式（大部分已存在）
- 素材回填（`putItems` 每 50 条 `beforeWrite`）和分块写库**已实现**，v2 组装路径（§#3）直接复用这套写库逻辑。
- 本项实际工作 = §#3 的「先校验 → 逐片拼回完整数组 → 调一次 importFullData」，不再额外大改。

## 5. 兼容与迁移（最高风险点）

- **导入双路径**：`importSystem` 先探 `manifest.json`。
  - 有 manifest 且 v2 → 新路径。
  - 无 manifest（或只有 `data.json`）→ 老 v1 路径，**原样保留现有逻辑**，老备份永远打得开。
- **向量兼容**：v2 import 读 `.bin`；v1（老备份）import 走老逻辑，向量仍是 JSON 里的 `number[]`，
  `saveMany` 照旧压回。两条都要测。
- **导出只产 v2**：新版本导出统一产 v2，不再产 v1。
- **版本号严格匹配（Finding 4）**：v2 解析路径只认 `formatVersion === 2`；`>2`（未来 v3 改布局）在组装/写库
  前直接报错，绝不用 v2 parser 去解未知布局还做破坏性写。
- **写库前校验分三档（都在 DB 未动时完成）**：① 文件存在性（分片/`memory_vectors.bin` 齐全，缺则 abort）；
  ② 轻量自洽（每片是数组、`组装后条数 === manifest count`、向量 `byteLength === dimensions*4`）——抓我们自己的
  export bug，不是防篡改；③ 资源预检（估算峰值，超阈值干净拒绝，修 R3·Finding 3）。
- **不做** 逐条 checksum、向量 offset 单调不重叠那类深校验——备份坏只可能是用户手动改文件，那种不兜
  （符合 `import-discards-old-data` 原则）；`assets/*` 缺图也维持 warn+skip（§#3 step 1）。
- **不做事务暂存**：组装通过后 `importFullData` 若写到一半遇 IndexedDB 配额炸等，按既有原则可接受
  （大不了重导），不为此上跨 store 事务回滚。

## 6. 测试清单（回归守卫，旧行为下挂、新行为下过）

1. `sliceRanges`/分片纯函数：已有测试，扩展覆盖「单 store 超一片」分片边界。
2. **大 store RangeError 回归**：构造一个会让 v1 `join` 超长的 mock 数据，断言 v1 stringify 抛错、
   v2 分片导出成功。这是钉住「修好别退化」的核心守卫。
3. 向量 round-trip：`Uint8Array → .bin → 切片 → saveMany → 读回`，逐字节相等；维度=1024 不丢精度。
4. v1→v2 兼容：用一个旧格式 `data.json`-only zip 走 import，断言数据完整落库。
5. 游标读 vs getAll：同一 store 两种读法结果集相等（条数、顺序、内容）。
6. 素材去重/回填：跨 store 共享的 base64 导出后只存一份、导入后每处都还原。
7. **跨片 clear-and-add 还原（Finding 1 守卫，核心）**：构造一个 `galleryImages` 跨 ≥2 片的 v2 备份，
   走 import，断言**所有片的数据都在**（旧的「逐片喂 importFullData」写法下只剩最后一片 → 必须挂）。
8. **缺片 abort**：manifest 声明 2 片但 zip 里只有 1 片，断言 import 在写库前抛错、且**目标 store 数据未被
   清空**（DB 未发生破坏性写）。
9. **空 store 按 spec 还原（R3·Finding 1，核心）**：覆盖四种 shape 的空备份——
   clear-and-add（如 gallery）空时**清旧**；merge（themes）空时**与 v1 一致地不动**；singleton（userProfile）空时
   **不写空壳**、保持 v1 形状。断言每种都与 v1 行为逐字节一致（「count:0 一律置 []」的错写法在 merge/singleton 上必须挂）。
10. **向量 clear-once（Finding 3）**：目标有旧向量、备份向量集不含其中一部分，断言 import 后目标独有的旧向量
    消失（走 saveMany 旁路时残留 → 必须挂）。
11. **单条超大记录（Finding 5）**：构造一条 JSON 超 `SHARD_BYTES` 的记录，断言独占一片导出成功；再造一条超
    硬上限的，断言**干净报错、无半截 zip/import 副作用**（不复现 RangeError）。
12. **版本护栏（Finding 4）**：`formatVersion:3` 的 zip 走 import，断言干净报错、DB 未动。
13. **条数自洽（R3·Finding 2）**：manifest count 与组装后实际条数不符（或某片不是数组）→ 写库前 abort、DB 未动。
14. **资源预检拒绝（R3·Finding 3）**：manifest 估算峰值超阈值 → import **根本不开始**、目标数据完好无损
    （证明「拒绝」而非「毁一半」）。
15. **media_only patch 存活（R4·F1，核心）**：目标有完整角色 + 文字消息，导入 media_only 备份后，**非 media 的
    角色字段和文字消息全部存活**、只有 media（头像/立绘/背景）被更新（错把 characters/messages 物化成 [] 时必须挂）。
16. **非 store 字段 round-trip（R4·F2）**：theme / API 配置 / customIcons / appearancePresets / socialAppData /
    设置导出再导入逐字段一致（漏 metadata.json 时必须挂）。
17. **漏声明 store abort（R4·F3）**：manifest 漏掉某应有 store（如 gallery）→ import 在组装前 abort、DB 未动。
18. **遗留向量导出（R4·F4）**：`memory_vectors` 里塞 raw 遗留 `number[]` 行，导出 v2、再导入与原始逐字节/逐值一致。

## 7. 取舍记录与仍待评审的点

### 已定的取舍（评审第 1 轮后拍板）

- **A. 不追 `O(单片)` 真流式**：JSZip 在 `generateAsync` 前持有所有文件，导出峰值 ~O(整包)。换 fflate +
  落盘流才能真降，工作量过大 → **本轮接受「峰值 ~O(整包) 但无 RangeError」**，真流式列 follow-up。
  代价：极端账号仍可能 OOM，但确定性硬崩已除。
- **B. Finding 1（跨片清库丢数据）= must-fix**：采用 assemble-then-import-once（§#3），不复用「逐片喂
  importFullData」。
- **C. Finding 3（写库前校验）= 瘦身版**：只做分片完整性检查，不做 checksum/byte-range，不做事务暂存（§5）。
- **D. #5 WebDAV**：本轮只做「体积预检 + 明确提示」，native 端避免多余拷贝；「临时文件上传」列 follow-up。

### follow-up（不在本轮）

- 换 fflate / File System Access 真流式压缩落盘，把导出/导入峰值降到 `O(单片)`。
- WebDAV 大账号云备份：临时文件上传 / 分块。
- 原 #4：messages/gallery 保留策略（产品决策）。

### 第 2 轮 codex 复审结果（已折入上文）

- **Finding 1·空 store 残留** → 已修：manifest 枚举本 mode 所有 store（含 count:0），import 对 count:0 置空数组清旧（§3、§#3、测试 9）。
- **Finding 3·向量 saveMany 旁路** → 已修：向量并入 `data.memoryVectors` 走 importFullData 一次（§#2、§#3、测试 10）。
- **Finding 4·版本号** → 已修：`formatVersion === 2` 严格匹配，`>2` 写库前报错（§5、§#3、测试 12）。
- **Finding 5·单条超大记录** → 已修：超大记录独占一片，超硬上限干净报错不退回 RangeError（§3、测试 11）。
- **Finding 2·缺素材不在硬边界** → 已定（选 A）：维持 v1 的 warn+skip + 注释说明豁免。理由：缺图只可能来自篡改、
  真丢了也无从恢复，为它拒绝整个导入没意义。

### 第 3 轮 codex 复审结果（已折入上文）

- **R3·Finding 1·count:0 不能统一置 []** → 已修：引入 `BACKUP_STORE_SPECS` 单一真相源，空 store 按 shape/restore
  mode 处理（clear-and-add 才清、merge/singleton 按 v1 形状不写空壳）。范围限定「与 v1 一致、不写空壳」，不修 v1
  老语义（§3、§#3 step 2、测试 9）。这张表同时收掉了下文「3 文件知识漂移」的耦合隐患。
- **R3·Finding 2·校验太薄** → 已折（瘦身版）：加「每片是数组 + 条数 === count + 向量 byteLength === dims*4」
  自洽检查（抓自家 export bug），深校验仍不做（§5、§#3 step 2、测试 13）。
- **R3·Finding 3·弱机导入 OOM 不可恢复** → 已修：写库前加资源预检，超阈值干净拒绝、不开始导入（§#3 step 1b、
  测试 14）。真·流式导入列 follow-up。

### 第 4 轮 codex 复审结果（已折入上文）

- **R4·F1·media_only patch 被误清（critical）** → 已修：store-spec 建模 mode 专属虚拟字段，media_only 不物化
  characters/messages（§3、§#3 step 2、测试 15）。
- **R4·F2·非 store 字段丢失** → 已修：加 `metadata.json` 容器（§3 布局、§3 spec、§#3、测试 16）。
- **R4·F3·漏声明 store 静默留旧数据** → 已修：预检从 spec+mode 算完整应有字段集，反查 manifest 漏没漏（§#3 step 1、测试 17）。
- **R4·F4·遗留向量导出写无效字节** → 已修：导出每条先归一化三态再写 bin（§#2、测试 18）。

> **收敛判断**：四轮每轮都挖出真问题（critical/high），未收敛。结论是「纯文档 plan 审到 codex approve」不是合适的
> 终点——v2 触及的特殊分支（media_only patch、非 store 字段、遗留向量、各 store 还原模式）太多，应转入实现，
> 用 18 条回归测试 + 对**真实 diff** 跑 codex 来兜，而不是继续审 plan 散文。

### 仍待评审的点

1. **分片大小 / 资源预检阈值怎么定**：`SHARD_BYTES=32MB`、import 拒绝阈值都是拍的。要不要按设备内存/平台自适应？
   阈值定太严会误拒正常大账号，定太松又挡不住 OOM。
2. **向量二进制的字节序/对齐**：`Uint8Array(v.vector.buffer, byteOffset, ...)` 直接拼接，IndexedDB 结构化克隆
   回来的 typed array 是平台原生序——同机导出导入没问题，**跨设备迁移**（大端↔小端，虽极罕见）会不会读乱？
   要不要在 manifest 里记字节序、读时校正？
3. **assemble-then-import-once 的 import 峰值 ≈ 整树**：R3·Finding 3 的资源预检已堵住「毁一半」的危险路径
   （超阈值干净拒绝），但**弱机导大备份依旧是「拒绝」而非「能导」**——这个能力缺口要不要靠「无耦合大 store
   流式导入」补上（follow-up），还是接受「拒绝」就行？
4. **改动集中在 OSContext/db.ts**：`BACKUP_STORE_SPECS` 单一真相源已把「导出/import 知识漂移」收敛成一处，
   缓解了耦合；但 #1/#3/#6 主流程仍需一起改才自洽——落地时怎么切分提交/测试边界更稳？

## 8. 落地顺序

1. **骨架**（#1 游标读 + #3 v2 格式 + #6 逐片 parse）——一起改、一起测，立住 manifest 契约。
2. **向量二进制**（#2）——挂到骨架上。
3. **WebDAV**（#5）——独立，按评审结论决定做到哪一步。

> 三步串行，不裸并行多 agent（同改 OSContext/db.ts 会互踩）。每步带回归测试再进下一步。
