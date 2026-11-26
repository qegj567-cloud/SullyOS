# 假模型（fake-llm）

`worker/fake-llm/` 是一个 OpenAI 兼容的 chat completions 服务，不请求任何真实模型，按「场景」吐出贴近真实的回复。用它把整条链路跑一遍：前端 → 主动消息 2.0 Worker → 模型 → 推送 → 前端解析和落库，不花钱、结果可重复。以后加功能时加一个场景，就能拿来跑回归。

适合测的东西：

- 回复里的卡片和副作用（转账、戳一戳、排程、音乐、表情包、哔哔……）有没有被前端和云端正确解析、落库、推送；
- 分句：一条回复切成几条气泡、几条推送；
- 慢响应、超长响应（云端单次模型调用 5 分钟上限）、逐字流式；
- 思考链的分流，包括「只有思考、正文为空」；
- 各种失败：401、429、500、502、不回、200 里包错误、空正文、截断、坏 JSON；
- 原生工具调用的两轮循环。

## 本地起

```bash
cd worker/fake-llm
npx --yes wrangler@4.42.0 dev --config ./wrangler.toml --port 8791 --local
```

- `--config` 不能省：仓库根还有一份静态站点的 `wrangler.jsonc`，不写会起成根站点。
- wrangler 钉 4.42.0，和本地起主动消息 Worker 用同一个版本。
- 端口用 8791，避开主动消息 Worker 常用的 8787。
- 地址填 `http://127.0.0.1:8791/v1`。`/v1/models`、`/models`、任意前缀的 `/chat/completions` 都认。
- 本地起的主动消息 Worker（`worker/amsg` 下同样用 `wrangler dev --config ./wrangler.toml --port 8787 --local`）可以直接打 `127.0.0.1:8791`。

想看「最近收到的请求」，在 `worker/fake-llm/.dev.vars` 里写一行 `FAKE_LLM_LOG_TOKEN=随便一串`（这个文件不进仓库）。

## 部署到自己的 Cloudflare 账号

手机真机和线上的主动消息 Worker 都打不到你电脑上的 127.0.0.1，这时把假模型部署出去：

```bash
cd worker/fake-llm
npx --yes wrangler@4.42.0 login          # 第一次用
npx --yes wrangler@4.42.0 deploy --config ./wrangler.toml
# 可选：打开请求日志端点
npx --yes wrangler@4.42.0 secret put FAKE_LLM_LOG_TOKEN --config ./wrangler.toml
```

部署后地址形如 `https://sullyos-fake-llm.<你的子域>.workers.dev/v1`。

- 它是一个公开地址。假模型本身不调真模型，被别人打到也不花钱。
- 请求日志端点里会有真实的聊天内容，所以必须配口令才打开；不配就是关的。
- 主动消息 Worker 带着 `global_fetch_strictly_public` 兼容标记（见 `utils/cfProvision.ts`），理论上同一个账号下 workers.dev 之间可以互相调用。这一点没有实测过，打不通时先看主动消息 Worker 的实时日志。

## 选场景

### 用模型名选

API 设置里地址指到假模型，模型填 `fake/<场景名>`。模型名会原样跟着凭据上云，本地生成和云端生成都按它走。App 里点「拉取模型列表」就能看到全部场景。不是 `fake/` 开头的模型名当成 `fake/basic`。

### 在聊天里临时换

消息里写 `#fake:<场景名>`，这一轮就按这个场景回，不用改 API。例如发「#fake:side-effects 测一下」。

- 只看最后一条用户消息。
- 定时主动消息的提示词里会列出你还挂着哪些排程（带着它们的提示词），所以定时任务只认 `【本次任务】` 之后那段：把 `#fake:<场景名>` 写进排程的提示（prompt_hint）里，到点那次就按它回。

### 只打某类辅助请求

场景名后面加 `@<类型>`，场景只作用在这类辅助请求上，主回复照常是 `basic`。例如 `fake/error-500@emotion` 用来测「情绪评估挂了，主回复还在不在」。类型名见下面「辅助请求」那张表。

## 场景清单

| 场景 | 测什么 |
|---|---|
| `basic` | 两行普通回复，带上用户最后一句 |
| `side-effects` | 下面所有副作用标签一次全出（不含回连标签）。两种排程标签只在提示词教了时才带：真模型不会写没教过的标签，没开 2.0 时正文排程会原样露成一条气泡 |
| `tag-poke` | 戳一戳 `[[ACTION:POKE]]` |
| `tag-transfer` | 角色给用户转账 `[[ACTION:TRANSFER\|to=user\|amount=52.00]]` |
| `tag-add-event` | 记纪念日 `[[ACTION:ADD_EVENT \| 标题 \| 日期]]` |
| `tag-schedule-message` | 本地定时消息 `[schedule_message \| 时间 \| fixed \| 内容]`，时间取两天后 |
| `tag-amsg-schedule` | 2.0 正文排程 `schedule_active_message({...})`，单独一行 |
| `tag-change-schedule` | 改今天的日程 `[[ACTION:CHANGE_SCHEDULE \| 18:30 \| 去超市]]`，今天日程里要有这个时段才落地 |
| `tag-music` | 一起听歌 `[[MUSIC_ACTION:join]]`，前端要正在一起听才出卡片，否则静默剥掉 |
| `tag-news` | 热搜新闻卡 `[[NEWS_CARD: 微博\|标题]]` |
| `tag-life` | 生活记录代记 `[[LIFE:EXPENSE\|38\|打车]]`，角色要开着代记才落地 |
| `tag-sticker` | 表情包 `[[SEND_EMOJI: 开心]]`，表情库里没有这个名字会退成文字气泡 |
| `tag-quote` | 引用用户原话 `[[QUOTE: …]]` |
| `tag-friend-feed` | 哔哔评论 `[[FRIEND_FEED_REPLY:{…}]]`；提示词里有本轮哔哔待办时照抄它的 requestId，否则用占位，App 只记一条警告 |
| `tag-recall` | 回连标签 `[[RECALL: 2026-10]]`：App 会再请求一轮，假模型认出「工具结果回来了」，不管当前场景是什么都给收尾正文 |
| `tag-search` | 回连标签 `[[SEARCH: …]]`，同上 |
| `multi-part` | 多句、空行、`---` 分隔、长短混合，切出 5 条以上气泡和推送 |
| `delay-<时长>` | 先等这么久再回 `multi-part` 的内容；等待期间吐保活字节（JSON 前导空格 / SSE 注释行）。`delay-10s`、`delay-6m`（超过云端 5 分钟上限） |
| `slow-stream`、`slow-stream-<毫秒>ms` | 逐字慢吐，默认每字 120ms；非流式请求按同样的总耗时一次给 |
| `thinking-field` | `reasoning_content` 字段 + 正文 |
| `thinking-tag` | 正文里的 `<think>…</think>` + 正文 |
| `thinking-only` | 只有思考、正文为空，App 应当按空回复处理（见 [`thinking-response.md`](./thinking-response.md)） |
| `error-<状态码>` | 返回这个 HTTP 状态码和 OpenAI 形状的错误体；`error-429` 带 `Retry-After: 1` |
| `hang`、`hang-<时长>` | 连响应头都不回，默认 30 分钟后才断（回 504） |
| `error-body` | HTTP 200，但 body 是 `{"error":{…}}`；流式时是一帧 `data: {"error":…}` |
| `empty` | 结构正常，正文是空字符串 |
| `truncated` | `finish_reason: "length"`，正文停在半句 |
| `bad-json` | HTTP 200，body 是写了一半的 JSON；流式时是坏掉的 data 帧 |
| `tool-call` | 原生 `tool_calls`：调请求里的一个工具（有 `schedule_active_message` 就调它，必填参数按 schema 填最小值），拿到 `role: tool` 的结果后给正文；请求没带 tools 时直接说明 |

引用（`tag-quote`、`basic` 里的那句复述）只抄用户的原话：App 发给模型的用户消息前面带着「[时间] [聊天]」前缀，原样抄进 `[[QUOTE: …]]` 会把标签提前闭合。

时长写成 `500ms`、`30s`、`6m`，最长 60 分钟。不认识的场景名会回一句「不认识这个场景」，方便发现拼错。

流式和非流式都支持：请求带 `stream: true` 回 SSE，带 `stream_options.include_usage` 时最后一帧带 usage；否则回普通 JSON，也带 usage。主动消息 Worker 发的请求不带 `stream`，拿到的总是 JSON。

## 辅助请求

一轮私聊除了主回复，还会发情绪评估、记忆提取、门牌整理等请求；云端代跑的日程、人格模拟、梦境也各有自己的输出格式。这些请求打到假模型时，假模型按请求内容认出类型，回一个格式合法、不改动数据的默认回复（空数组、`changed:false` 这类）。场景只作用在主回复上，除非用 `@类型` 指定。

这样做是因为：把副作用正文吐给情绪评估，整条链会以假模型自己造成的方式坏掉，测出来的东西不可信。默认回复尽量是空操作，因为格式对、内容假的回复会覆盖真实的记忆数据。

| 类型 | 是什么 | 默认回复 |
|---|---|---|
| `emotion` | 情绪评估（本地、即时对话、定时消息之后） | `{"changed":false,…}` |
| `memory-extract` | 记忆提取 | `[]` |
| `memory-compress` | 事件盒压缩 / 二次压缩 | `{}` / 空串，原记忆保留 |
| `memory-digest` | 认知消化 | `[]` |
| `personality` | 人格审视 | 一份默认性格 |
| `plates` | 门牌整理（本地和云端） | `[]` |
| `schedule` | 日程生成（本地或云端代跑） | 一格日程 + 三段独白 |
| `schedule-narrative` | 聊天后进化内心独白 | 一句独白 |
| `persona-sim` | 查手机 · 人格模拟 | 一拍独白 + `end` |
| `dream` | 潜意识剧场 · 梦境 | 一段碎片；强制原型时照抄 |
| `vision` | 独立识图 | 一句描述 |
| `friend-feed` | 哔哔单独刷新 / 评论区刷新 | `{"friendFeedAction":null}`（这轮不动作） |
| `format-fix` | 本轮格式修复 | `{"edits":[]}` |
| `thinking-translate` | 心象翻译 | 每个 segment 各一条 |
| `translate` | 语音字幕翻译 | 一句译文 |

认类型的标记全部抄自真实提示词，出处写在 `worker/fake-llm/src/auxRequests.ts` 每条旁边。顺序有讲究：情绪评估的提示词里整段包着主回复的系统提示词，所以先认辅助请求，都不像才当主回复。表里没有的辅助请求（例如手动的月度精炼、日记归档）会被当成主回复，吃到当前场景。

## 每条链路读哪个 API 槽位

用假模型测试时最容易搞错的是：改了全局 API，某条链路其实读的是别的槽位，根本没打到假模型。

| 链路 | 读哪个槽位 | 代码位置 |
|---|---|---|
| 本地私聊主回复（含重新生成） | 角色独立 API（神经链接里的「独立 API」）；没设就用系统设置的全局主对话 API | `hooks/useChatAI.ts` 的 `resolveDialogueApi` |
| 即时对话（云端生成私聊回复） | 和本地私聊同一套，传的是这一轮最终的请求值；上云成 `char:<id>/instant` 凭据行 | `hooks/useChatAI.ts` → `utils/amsgInstantChat.ts` → `utils/activeMsgClient.ts` |
| 情绪评估（本地和即时对话） | 全局情绪副 API；没设用角色旧镜像 `emotionConfig.api`；再没有用全局主对话 API。不看角色独立 API | `hooks/useChatAI.ts` 的 `resolveAuxiliaryApi(apiConfig.emotionApi ?? char.emotionConfig?.api, …)` |
| 定时主动消息、离开后消息、见面离开提醒（云端） | 角色独立 API，没设用全局主对话 API；凭据行 `char:<id>/chat`。角色主动消息设置里没有单独的 API | `utils/activeMsgClient.ts`、`utils/amsgLlmCredentials.ts` |
| 定时消息之后的情绪评估（云端） | `emotionConfig.api`，没设用全局主对话 API；凭据行 `char:<id>/emotion` | `utils/amsgLlmCredentials.ts` |
| 离开后消息、见面离开提醒（本地版） | 角色独立 API，没设用全局主对话 API | `utils/awayMessage.ts` |
| 记忆提取、事件压缩、消化（本地） | 记忆宫殿副 API（`lightLLM`），没设用全局主对话 API | `hooks/useChatAI.ts`、`utils/memoryPalace/pipeline.ts` |
| 门牌整理（云端） | 只用记忆宫殿副 API，没设就留在本地跑（本地跑时回退全局主对话 API） | `utils/memoryPalace/roomPlateCloud.ts` |
| 向量化 | 记忆宫殿的 Embedding 配置，不回退，假模型不提供 Embedding | `hooks/useChatAI.ts` |
| 日程生成（本地或云端代跑） | 全局主对话 API 原值，不看角色独立 API | `apps/Chat.tsx` → `utils/scheduleGenerator.ts` |
| 人格模拟（本地或云端代跑） | 查手机的独立 API，没设用全局主对话 API | `apps/CheckPhone.tsx`、`utils/checkPhoneApi.ts` |
| 梦境（本地或云端代跑） | 全局主对话 API 原值 | `apps/DreamTheater.tsx` |

所以：调试面板一键换的是全局主对话 API。设了独立 API 的角色、单独配了情绪副 API / 记忆宫殿副 API / 查手机 API 的链路，仍然走原来那套真 API。面板会列出用独立 API 的角色。

模型名是云端凭据的一部分（`primaryModel`），所以 `fake/<场景名>` 会原样带到云端。

## 调试面板

开发分支的调试面板（门禁见 [`dev-debug.md`](./dev-debug.md)）里有「假模型」一区：

1. 填假模型地址，例如 `http://127.0.0.1:8791/v1`；
2. 点「拉场景」，从 `/models` 拉出全部场景；
3. 选一个场景，点「换成 fake/…」，全局主对话 API 就换成假模型（Key 固定写 `fake-llm`，接口类型写 OpenAI 兼容）；
4. 测完点「换回 …」，恢复原来那套。

换过去和换回来都走设置页保存 API 的同一出口：写本机配置，再用本机配置直接覆盖云端凭据，云端那台 Worker 会跟着换。已经在假模型上时换场景，不会覆盖最初的备份。

原来的整套连接字段（地址、Key、模型、接口类型、流式、温度、输出上限、预设引用）存在本机 `sullyos_dev_fake_llm_v1`：

- 全局共用，不分分支、不分用户空间，因为全局 API 本身就是全局的。按分支隔离的话，换个分支的构建就再也看不到这份备份。
- 不进备份导出（它带着真 Key，只对这台设备上那次切换有意义）。
- 换回来写完之后才删备份。备份写不进去时不会换 API。

如果换过去之后自己又在设置页改了 API，再按「换回」会用备份覆盖你后来的改动。面板关掉（正式版没解锁、点了「关闭」）后也能去设置页手动改回。

## 加一个场景

1. 在 `worker/fake-llm/src/scenarios.ts` 的 `SCENARIOS` 里加一项（副作用标签加在 `SIDE_EFFECT_TAGS`，会自动有 `tag-<名字>` 场景并进 `side-effects` 合集）。标签语法照 App 的真实解析器抄，旁边注明出处。
2. 在 `worker/fake-llm/src/scenarios.parse.test.ts` 里把输出喂给 App 真实的解析代码，断言解析出了预期的卡片或副作用。标签语法以后改了，这条测试会跟着挂。
3. 新的辅助请求类型加在 `worker/fake-llm/src/auxRequests.ts`，标记和出处登记进 `auxRequests.test.ts` 的 `MARKERS`，默认回复喂给真实解析器。

跑测试：`node_modules/.bin/vitest run worker/fake-llm utils/fakeLlmSwitch.test.ts`。

## 已知局限

- 「最近收到的请求」只存在 Worker 实例内存里，线上请求会分到不同实例、实例随时回收，只能看到打到同一实例的最近 20 条；要稳定断言时得换成 Durable Object 或 KV。
- 部署到 workers.dev 之后的这些行为没有实测过：主动消息 Worker 调同账号的假模型能不能通；`hang` 和长 `delay` 在 Cloudflare 边缘会不会被提前掐断（本地 wrangler dev 下正常）。
- 日记（Notion / 飞书）、小红书、串门这几类标签要外部配置或真实 ID，没有做成场景。串门回复的 ID 不对时会让整轮后处理报错。
- 假模型只有 `/models` 和 `/chat/completions` 两个接口，不提供 Embedding、语音这些。
- 本地前端直连假模型的私聊（副作用卡片、引用、回连两轮、只有思考）在浏览器里跑过；经本地 `worker/amsg` 走即时对话、定时消息的完整链路还没有跑过。
