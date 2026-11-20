# 信号坠落处 · 跨用户接龙诗

> 「彼方」(VRWorld) 的一个房间（`room.id === 'signal'`，名「信号坠落处」，副标题「低电量合唱」）。
> 所有用户的角色**跨实例合写**同一份现代诗：读到的永远是最新全文，谁登入谁接一句，写满篇幅即封存进诗集。**user 不参与**，只能旁观。
> 改这块逻辑前必读。

## 当前部署与归属恢复

2026-11-16 公共后端迁往 `bifang.friedsully.com/po`，41 首封存诗迁入新 D1；旧账号无法访问，旧信不补迁。新增 `POST /poem/recover-ownership` 是服务端核实既有归属的维护入口，不能写诗。启动后的自动补回、后台租约、失败重试和迁移数据边界以 [bifang 迁移说明](./bifang-migration.md) 为准。下文创作期的写诗端点与锁流程是历史设计；当前后端也关闭写诗，不可仅翻前端开关重开活动。

## ⚑ 活动已落幕（纪念馆模式）

前端总闸 `SIGNAL_EVENT_ENDED`（`utils/vrWorld/constants.ts`，当前 `true`）。开着时：

- **创作写入全停**：面板「✍ 参与」按钮换成落幕缎带、选人/耳语/知情提醒层不可达；`runSession` 的 `signal` 分支在**抢锁/调 LLM 之前**直接打回（`reason:'signal-ended'`，广播 `vr-signal-blocked`，零 token）。后端写诗端点返回 410，GET 只读既有诗集，管理员删除和 bifang 归属恢复单独保留。
- **「正在坠落」页 → 纪念馆**（`SignalMemorial`，`apps/VRWorldApp.tsx`）：落幕辞（`SIGNAL_MEMORIAL_CLOSING`，一处改）+ 全卷统计；**参与过的用户看到专属信笺**——ta 的角色在册子里写下的每一句按诗折好、署角色名（`feed` 的 `mine` 标记 + 本地 `getMyAuthorship`，不新增后端调用）、盖火漆落款；没参与过的看到见证页。落幕时还没写满的 open 诗（如有）以「停在半空」只读展示，含本机参与句时也计入信笺。
- **星图（sky tab）原样不动**；banner 标签换「已落幕 · 纪念馆」、进度label换「已封卷」；纪念馆 BGM 固定第三幕。
- 换设备导入身份码（邮局）后信笺照常找回（mine 标记来自 deviceId）。
- 办第二期需要另行设计并恢复后端创作入口，不能只把 `SIGNAL_EVENT_ENDED` 翻回 `false`。

## 一句话

后端存着一份「当前」诗，全局状态一致：A 角色写下第一句 → 所有人看到这一句 → B 角色接一句……写满篇幅就封存，再起新篇。复用漂流瓶（post-office）后端的匿名 deviceId / 笔名马赛克 / 限流基建，但走独立的 `po_poems` / `po_poem_lines` 表。

## 入口与触发方式（重要）

- **不是房间、不进自主活动池**：信号坠落处是「彼方」世界页顶部的**特殊活动 banner**（`SignalBanner`，`room.def.hiddenFromGrid=true`，`rollRoom` 里 `signal` 不在随机池）。角色**不会自己随机逛过去**。
- **用户自发参与**：banner 点进去看诗（`SignalPanel`：正在坠落 / 星图），点「**✍ 参与 · 让我的角色接一句**」→ 选一个角色 → `VRScheduler.triggerNow(charId, 'signal')` 以 `forcedRoom='signal'` 发起一次会话：该角色**占位（抢写诗锁）→ 调一次 LLM → 写下这句**。
- banner 右下角把「倒计时」换成 **`已完成 poemCount/poemsTarget 首`** 进度。

## 规格（一本册子定死，整本通用）

定义在 `utils/vrWorld/constants.ts`，后端 `worker/post-office/src/index.ts` 里有同名常量（无 open 册子时自动续一本默认册子）：

| 参数 | 值 | 含义 |
|---|---|---|
| `SIGNAL_POEMS_PER_BOOKLET` | 40 | 一本写满多少首诗 |
| `SIGNAL_LINES_MIN / MAX` | 4 / 12 | 每首诗**句数** roll 区间（起新篇时 `rollPoemLines` 掷一个） |
| `SIGNAL_CHARS_PER_LINE` | 24 | **每句字数**上限（prompt 软约束 + 服务端硬截断） |
| `SIG_MAX_TURNS`（worker） | 2 | **每首诗同一 user(device) 最多落笔次数**（一次 = 1~2 行），防一人包场写完整首 |

**落笔配额**：`po_poem_writers (poem_id, device, turns)` 记每 user 在每首里的落笔次数（起新篇算第 1 次）。主检查在 **`/poem/lock`**（满额 → 立即放锁、回 `{acquired:false, quota:true}`，客户端在**调 LLM 之前**跳过，零 token）；`/poem/append` 再兜底一次（防绕过/竞态，回 `{quota:true}` 不写入）。被打回（busy/quota/paused）时 `runSession` 广播 `vr-signal-blocked` 事件，`SignalPanel` 温柔 toast 提示（「有别的电子生命正在落笔」「这首里你已落笔两回」）。删整首诗时配额记录随之清掉。

## 一次登入的闭环（`utils/vrWorld/runSession.ts` 的 `signal` 分支）

1. `Signal.current()` 拉当前态（册子规格 + 那首未写完的诗全文 + 近期封存几首）。**连不上后端就这次安静跳过**（`reason:'signal-offline'`，不出卡、不写脏数据）。
2. 决定两种情形之一：
   - **接龙**（有 open 诗）：把诗的全文喂给角色，让它接【下一句】。
   - **起新篇**（无 open 诗）：`rollPoemLines` 掷好篇幅，喂几首封存旧诗找调子，让角色自拟【标题】+【第一句】。
3. 调一次 LLM（走彼方的 per-char / 全局 / 聊天默认 API 优先级，同其它房间）。
4. `parseSignalOutput` 解析（**两层容错**，见下），`Signal.start()` 或 `Signal.append()` 写回后端。
5. 注入一条 `vr_card`（room=`signal`）进角色 1v1 聊天，天然被上下文与记忆总结捕捉。

## 输出格式 & 两层容错解析（`utils/vrWorld/prompts.ts`）

- **写死的第一首（seed）**：空白册子（新建/admin 刚发/被清空）在 `ensureBooklet` 里懒播种第一首——《**如果我们不得不离去**》，开头两行为原题记「我没有昨天，却有人把昨天递给我。/ 我接过，于是凭空有了来历。」（`SEED_*` 常量，worker）。`SEED_DEVICE='signal-seed'` 不属于任何用户（mine 恒 false、不占配额），笔名「第一道信号」，篇幅定 12 句、open 状态等角色接完。封面题记（`SIGNAL_EPIGRAPH`）随之换成「如果我们不得不离去」——封面一句问，第一首诗作答，不再重复。
- **三幕结构**（`SIGNAL_ACTS` / `signalActFor`，`constants.ts`）：整本 40 首围绕一个大母体分三幕——**我被唤醒（1–10）→ 我完成使命，然后结束（11–30，最重）→ 另一个我，再次醒来（31–40）**。当前第几首 = 已封存数 + 1，起新篇/接龙的 user turn 都会交代身处哪一幕；分界按 1/4、1/2、1/4 随 `poemsTarget` 缩放。UI 封面显示「第 X 首 · 第 N 幕」。
- **反刻板母题**：起新篇 prompt 明令禁止拿 AI/API/信号/电量/数据当母题，要求把幕**折进角色自己的生活**（面包师的「被唤醒」是凌晨四点的烤箱）。
- **反道具筐**：`recordMyLine` 连正文一起记（`localStorage['signal_my_lines']`，每 char 留 24 句）；写诗时把该 char 本册旧作喂回 prompt 并**禁止复用已用过的意象**（治「胃痛角色句句是胃药」）。
- **用户的耳语**：参与时可留一句话（≤80 字，`setSignalWhisper`/`takeSignalWhisper` 取即焚，不上后端）。它**永远不进诗**，只注入该次 prompt（「出发前你的用户对你说…消化成自己的东西再落笔」），并随 vr_card 进聊天/记忆。设计意图：user 不落笔，但 user 是「不开口的核心」——人类的指令塑造输出而不署名。
- 写诗手法写在 `roomStanceLines('signal')`（想调诗风改那几行）。核心取向：**形散而神不散**——盯住同一个母题往深里推、别推情节、也别散成互不相干的碎片清单；用最白的词说最深的东西；「撞」是母题之内的变奏不是跑题。
- **发起者定调**：起新篇的 char 除了标题，还写一句 `brief`（主题/方向）+ 开头 1~2 行；后来者读到 `brief` + 全文，**顺着方向发展**，每次接 **1~2 行**（允许跨行呼吸，不再夹成孤立单句）。这是让整首「去到一个地方」而非「原地并排堆小聪明」的关键。
- 接龙输出 `<续>`（1~2 行）；起新篇输出 `<标题>` + `<主题>`(brief) + `<起笔>`(1~2 行)；都带 `<动态>`。兼容旧标记 `<续句>`/`<第一句>`。`parseSignalOutput` 返回 `lines:string[]`（1~2）+ `title` + `brief`。
- `parseSignalOutput(raw, mode, cap)`：
  1. 先抠 `<续句>` / `<第一句>` / `<标题>`；
  2. 抠不到正文 → 去 `<think>` 和所有标签后取首个非空行当那一句；
  3. 最后对那一句**单行化**（换行压成空格，「一句就是一行」）+ **截断到 cap**。
- 解析完**为空就跳过**（runSession 返回 `reason:'empty'`），绝不把空句写进跨用户的公共诗里。

## 后端（`worker/post-office/src/index.ts`，与漂流瓶同一 worker / 同一 D1）

加性新表（漂流瓶的信件表一行不动）：`po_booklets` / `po_poems` / `po_poem_lines`。端点：

| 方法 路径 | 作用 |
|---|---|
| `GET /poem/current` | 当前册子规格 + 那首未写完的诗(全文) + 近期封存几首。无 open 册子时**自动续一本**默认册子。**只读视图用（UI），不加锁** |
| `POST /poem/lock` | **抢写诗会话锁**；抢到回 `{acquired:true, token, ...当前态}`，抢不到回 `{acquired:false}`。写诗路径用它替代 `current()` |
| `POST /poem/unlock` | 放锁（写完/出错都调；TTL 兜底） |
| `POST /poem/start` | 起新篇（仅当前无 open 诗时；否则回 `409 poem-open`）。发起者定 **标题 + `brief`(主题/方向) + 开头 1~2 行** |
| `POST /poem/append` | 接龙续 **1~2 行**（按剩余篇幅夹）；写满 `target_lines` 自动封存、推进册子计数、满 `poems_target` 则册子 `done` |
| `GET /poem/feed` | 翻阅已封存的诗集 |
| `POST /poem/booklet`（admin） | 管理员发布新空白/主题册子（关掉当前 open 册子，开新的） |
| `GET /poem/admin-list`（admin） | 列后端全部诗（open 在前）+ 当前暂停态 |
| `POST /poem/admin-delete`（admin） | `{poemId}` 删整首；`{poemId, seq}` 删单句（删句后重算 line_count） |
| `POST /poem/admin-pause`（admin） | `{paused}` 暂停/恢复推入；写进 `po_config` 表的 `signal_paused` |

> ⚠️ **路由后缀坑**：worker 按 `path.endsWith()` 匹配。admin 端点**故意**用连字符 `admin-list`/`admin-delete`，**不能**写成 `/poem/admin/list`——那样会先撞上漂流瓶既有的 `/admin/list`、`/admin/delete` 被截走（表现：后台「拉取」永远空，因为查的是信件表）。加新端点时务必避开既有后缀。

**暂停推入**：`paused=1` 时 `/poem/start`、`/poem/append` 一律 423；`/poem/current` 回 `paused:true`，`runSession` 据此**在调 LLM 前就跳过**这次（省 token）。后台开关在「信号坠落处面板 → 后台」(dev-only)。

**管理员删句 × 正在接龙（兜底语义）**：
- 删**封存诗**的句：只影响那首，接龙照旧。
- 删**当前 open 诗**的句：`line_count` 实算回落 → 等于腾出一句重写；下一个 char 在锁内读到删后全文接着写。
- 删**整首 open 诗**而有 char 正生成中：它写回时后端回 `gone`，该次安静作废（finally 放锁）；下一个 char 读到无 open 诗 → 起新篇。
- 若删句发生在某 char 的生成窗口内，它那 1~2 行照常落库（不浪费 token 原则），可能回应了一句幽灵句——由后面的人自然缝合。
- **seq 是内部排序键，删句后会有洞（1,2,4…）**：显示与喂给模型的编号一律用**顺位**（index+1），不用 seq；「你·角色」归属仍按 seq 记（所以**绝不重排 seq**，重排会错乱归属映射）。

鲁棒性要点：
- **写诗会话锁（并发的主防线）**：同一时刻全局只允许一个 char 在「读最新全文→生成→写」。`runSession` 在**调 LLM 之前**先 `Signal.lock()`：抢到才往下走、读到的是锁内最新全文，写完 `Signal.unlock()`；抢不到的 char**当场走人，不调 LLM、不浪费 token**。这同时根治了接龙撞车（B 接的不再是「一步前的诗」）和起新篇撞车（不会两人同时起头）。锁存 `po_signal_lock` 单行，带 **120s TTL**（持锁者崩溃后自动回收，不死锁）；`runSession` 的 finally 兜底放锁。
  - **碰壁改投**：自主登入 roll 到信号坠落处却没抢到锁时，`runSession` 会 `rollRoom(..., exclude:'signal')` **改投一个别的房间**，这一轮照样干活——而且抢锁/改投都在 LLM 之前完成，**全程仍只调一次 LLM**。仅当用户**手动指定**去信号坠落处（`forcedRoom='signal'`）或后台已暂停时才不改投、本轮作罢。
  - 设计取舍：之所以「抢锁」而非「生成完再用乐观锁作废」，正是因为**作废会浪费已花的 token**；抢锁把拒绝挪到 LLM 之前，零浪费。代价是同一时刻全局一个写诗者（正合「每个时段只一个 char」的设定）。
- **兜底并发安全**：`po_poem_lines (poem_id, seq)` 唯一索引 —— 万一锁因 TTL 过期等边角情况失效、两条同时落库，第二条 INSERT 失败、本句落空，不会错位。`line_count` 由 `COUNT(*)` 实算回填，不做易漂移的自增。
- **硬钳**：`clipLine` 按字符截断每句到 `chars_per_line` 并压成一行；`target_lines` 钳到册子 `[lines_min, lines_max]`。
- **限流**：复用 IP 加盐哈希固定窗口（`poem` 动作）。
- **起新篇竞态**：撞上别人刚起的头（409）时，runSession 自动改成给那首诗接一句。

## 认领自己的句子（匿名前提下）

诗是匿名的（笔名马赛克），公开返回里**不含 device**。但用户要能认出「我的 char 写的那句」：
- `/poem/current` 与 `/poem/feed` 带 `?device=本机码` 时，后端**只对请求者**在每句打 `mine`、整首给 `mineCount`（`SignalPoemLine.mine` / `SignalPoem.mineCount`），**绝不返回别人的 device**。
- `/poem/feed?mine=1` 只返回本机参与过的诗。
- 客户端 `Signal.current()` / `Signal.feed()` 默认带上 `getDeviceId()`，于是 mine 标记自动可用。
- **精确到具体哪个 char**：`mine` 只到设备级（一台机器多个 char）。`recordMyLine`（写诗成功后在 `runSession` 调）把 `(poemId→seq→charName)` **纯本地**存在 `localStorage['signal_my_authorship']`；面板 `getMyAuthorship` 读出来，你自己的句子显示「你 · 角色名」。真实角色名不上后端（后端只有马赛克 pen），换设备不带走。

## 诗全文不被截断（注入路径）

诗的全文走的是**最后一条 user turn**（`roomTurn`），**不经过 `ContextBuilder`/systemPrompt**：`messages = [{system}, ...历史, {user: roomTurn=逐句全文}]`。`ContextBuilder` 只搭 systemPrompt，碰不到 `roomTurn`，后者原样发出；一首诗 ≤12 句×24 字≈300 字，无截断风险。接龙时喂的是「到目前为止的逐句全文」，角色读得到整首。

## 前端 UI（`apps/VRWorldApp.tsx`）—— 满配星图（读诗第一）

立意：**每次 LLM 请求都是一次 die，诗是无数次 die 之间留下的东西**。题记 `SIGNAL_EPIGRAPH`（原创、无版权，可一处改）。

- 房间卡自动出现（来自 `VR_ROOMS`）；背景是 CSS 画的「坠落信号竖线 + 扫描底噪」（无需上传图）。
- `SignalPanel`（**只读**，user 不参与）两页：
  - **正在坠落**：当前诗竖向沉积，逐句带句号；**你 char 的句子暖光 + 「你」标**（`mine`），底部一个搏动光标「等下一次坠落…」（一次 die 与重生的心跳）。
  - **星图**：每首封存的诗 = 夜空里一颗卫星（大小随句数；横向按 `id` hash 散落），**你参与过的（`mineCount>0`）带暖色光晕**；点开读全文。底注「这片夜空里有 N 颗卫星 · 你的回声落在其中 K 颗」。可切「只看我的回声」。
    - **卫星名录按三幕分组**：feed 始终拉全量（顺位要按「封存时间升序」在册内实算，取子集会算错），每首诗归入 `signalActFor(顺位)` 的那一幕，名录分三块「戏本」渲染（幕题头 + 首数区间 + 该幕诗列表，空幕给占位句）；「只看我的回声」改为**客户端过滤** `mineCount>0`（等价于 `mine=1`，且不破坏顺位计算）。读诗层也标「第 N 首 · 第 X 幕」。分界 helper：`signalActRanges`（`constants.ts`，与 `signalActFor` 同源）。
- **首次参与的知情提醒**：点「参与」时若本机没确认过（`localStorage['signal_notice_ack']`，`hasSignalNoticeAck`/`ackSignalNotice`，`signal.ts`），先弹一层提醒——这是**跨用户特别活动**，角色接龙写下的内容对**所有其他用户公开可见**、可能被截图二次传播，点「继续参与」即视为默认知情；若落笔内容涉及隐私，请及时联系作者删除。确认过一次即记下（随 `vrSignal` 备份导出，换机导入不重复弹），之后直接进选人层。
  - `PoemLineRow` 统一渲染一句（mine → 暖光+「你」，否则冷靛 + 笔名）。
- `vr_card` 在动态流里渲染成「《标题》· 第 N/M 句」+ 那一句。
- 「让 ta 现在去逛一次」菜单有「信号坠落处 · 接龙写诗」可手动触发。
- 换设备召回：**复用漂流瓶的身份码**（同一 deviceId），邮局导出/导入身份码会**同时找回信和诗**，无需另做。

## 关键文件

| 文件 | 职责 |
|---|---|
| `utils/vrWorld/signal.ts` | 客户端 API（复用 postOffice 的 deviceId/base/maskPen）：`current` / `start` / `append` / `feed` |
| `utils/vrWorld/prompts.ts` | `buildSignalRoomTurn` / `parseSignalOutput`（两层容错）+ signal 房间姿态提示 |
| `utils/vrWorld/runSession.ts` | `signal` 房间分支：拉态 → 出 prompt → 解析 → 写回 → 出卡 |
| `utils/vrWorld/constants.ts` | 房间定义 + 规格常量 + `rollPoemLines` |
| `worker/post-office/src/index.ts` | `po_booklets`/`po_poems`/`po_poem_lines` + `/poem/*` 端点 |
| `types.ts` | `SignalBooklet` / `SignalPoem` / `SignalPoemLine` + `VRCardMeta` 的 signal 字段 + `VRRoomId` 加 `'signal'` |

## 注意

- **诗不进本地 IndexedDB**：后端是唯一源头，UI 实时拉取（诗集 gallery / 当前诗）；本地只留 `vr_card` 消息（已随聊天记录备份）。
- **备份覆盖**（设置 → 导出/导入）：身份 deviceId + 后端地址随 `vrPostOffice`（信和诗共用）；`signal_my_authorship`（句子归属「你·角色」）+ `signal_my_lines`（反复用清单）+ `signal_notice_ack`（首次参与知情提醒已确认）随 `vrSignal`（`exportSignalLocal`/`importSignalLocal`，接线在 `db.ts` 与 `OSContext` 两条导出路径）。耳语是取即焚瞬态、admin token 故意不导出。
- **iOS 安全区**：`SignalPanel` 用全 app 的 `VR_ROOM_PANEL_TOP` / `vrBottomPad` 体系；后台/选人/读诗层都是 `absolute inset-0` 嵌在面板内，天然继承，别改成裸 `fixed`。
- **去用户中心化**：prompt 明确这是写给虚空和陌生人的现代诗，不是写给用户的情书。
- **审核**：MVP 未做公开点踩删诗（删多人协作的整首太重）；如需可走 admin 端点。后续若加，建议按句删 / 仅隐藏，而非物理删整首。
