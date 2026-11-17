# 世界书编辑、分组与角色挂载

2026-09-13 修复。

## 用户操作

- 关闭「关键词触发」改为常驻时，主关键词、辅助关键词仍然保存；重新启用即可继续使用。
- 世界书每组下方可「编辑整组」：改分组名、保持原触发方式、全部常驻或全部关键词触发。任一条缺少主要关键词时，整组关键词切换不执行，提示先补齐。停用状态和其它匹配规则不变。
- 改名不允许与已有分组合并，避免意外混组。分组名称是分类字段，不是绑定标识。
- 「删除整组」会显示条目数量并确认，同时从已挂载的角色中移除这些条目。取消不更改数据。多选删除使用同一批量通道。
- 神经链接的扩展设定按已挂载条目的分类折叠。展开组可查看条目，展开条目才挂入正文；「整组取消挂载」只修改当前角色，不删公共库、不影响其他角色。

旧版本若已把关键词清空并保存，不能从现有数据推算回来。应从原文件补回原条目的关键词；不要通过替换条目 ID 自动重建绑定。

## 绑定不变量

绑定只按条目 `id`，从不按标题、分组名或导入的 `sourceUid` 匹配。

`DB.mutateWorldbooks` 在同一个 IndexedDB 读写事务内读取最新库记录、修改目标条目、同步角色的 `mountedWorldbooks` 缓存；事务提交后才刷新 OSContext。批量操作不能循环使用捕获了旧 `characters` 的单条更新函数，否则后一次保存可能复活前一次已删除的挂载，或覆盖前一次同步。

- 修改保留原有 ID、创建时间和挂载顺序；只更新已绑定该 ID 的角色，不新增挂载。
- 部分挂载继续保持部分挂载；角色卡自带、公共库没有的其它条目保留。
- 删除按显式选中的 ID 集合执行，不按同名分类删除角色自带条目。
- 世界书库与缓存任何一步失败，全事务回滚。已修改角色在提交后标记云端提示词待刷新。

## 验证

`utils/worldbookPersistence.test.ts` 覆盖多角色、部分挂载、常驻／关键词往返、辅助关键词条件、同名但不同 ID 的独立条目、整组删除和事务回滚。

`scripts/test-worldbook-cowork.mjs` 用真实 OSContext、世界书 App、神经链接和 IndexedDB 验证保存重启、整组改名、取消删除、整组删除及当前角色解除挂载。

## 全 App 世界书构建管线

同行 demo 的 a′ 复用 `buildChatRequestPayload` 和本节完整管线；a 全文在召回之后、世界书解析之前作为临时 assistant 消息拼入，深度/关键词同轮处理一次。用户明确要求轻量接话 a 缩短提示词、不等召回，因此 `ContextBuilder.buildCompanionQuickRequest` 是专用例外：只读用户可编辑的简短设定、近段交流和现场，不读取世界书或完整记忆，不声称与完整人设等价。其他入口不使用此轻量方法。详见 [同行 demo](companion-demo.md)。

新 App 的默认入口是 `await ContextBuilder.buildCharacterRequest({ char, user }, messages)`，返回可直接发送的完整消息数组。角色档案、挂载世界书、固定位置和指定深度一次装配；不要先拼 `buildCoreContext` 再调用它，否则会重复人设。App 只负责本次玩法规则、输出格式和本场景历史。

`buildCharacterContext({ char, user, history, instructions })` 是需要拆分主提示词与历史的同一管线接口（聊天、见面、通话使用）。`buildWorldbookRequest` 服务剧场的自定义预设布局，`buildGroupWorldbookRequest` 服务多人布局；这些都在 ContextBuilder 内调用同一解析器和深度放置器。App 不得直接调用世界书解析/插入函数。

### 顺序和深度

- 固定位置优先于 order；同一位置/深度按 order 升序，同序保留挂载顺序。
- 深度按本次实际发送的历史消息从末尾倒数，包含本轮用户消息；0 在末条之后，超长深度钳到历史开头。世界书和额外系统规则不参与计数。无历史时也保留独立角色消息。
- scanDepth 只决定关键词扫描范围，与注入 depth 无关。常驻、禁用、关键词、辅助关键词、概率和宏替换都在公共层处理，概率同轮只抽一次。
- system/user/assistant 由条目 role 决定，不把所有深度条目压成 system 文本。
- 历史必须先按场景范围筛选、转成实际请求消息。不要为触发世界书读取隐藏/归档对话；空范围不能回退全库。App 的系统规则默认不参加关键词扫描。
- 群聊同 ID 只激活一次，同时保留条目所有者；私有条目不能作为所有成员共同设定。剧场仍使用场景选中的书、预设启用状态与角色归属，深度插入不会计入预填充。

参考 [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/) 的基础语义。这里没有实现酒馆全部递归、预算、Outlet 等高级功能，不宣称完整兼容。

### 已接入与兼容边界

聊天、见面发送/重生成/开场感知、通话、群聊、剧场、跑团、Spark、学习、日程、交换日记、歌词本、攻略本、小说、都市人生、角色间私聊、自由活动、记忆潜行、触碰/陪伴、节日活动等生成入口使用消息管线。单次生成只有一条任务消息时，深度 4 会自然落在该消息之前；不会把任务正文中的换行冒充四条历史。

旧 `buildCoreContext` 只用于文本兼容：全部已激活位置都有正文，但字符串无法携带消息角色和真实深度。保留的消费者是记忆诊断/迁移/门牌任务，以及多人布局的无世界书人设子块。旧主动消息模板也仍是单串协议：包含激活条目正文，但不保证独立消息角色/深度；不能将此称为消息模式。当前前台聊天请求不走这个降级接口。

新增 App 必须使用消息入口，不再新增文本兼容调用。`utils/contextPipeline.test.ts` 限制旧入口扩散和 App 私自解析世界书，`utils/contextWorldbook.test.ts` 验证公共行为。后续若调整旧后台模板协议，应连同 Worker 契约与对应测试迁移，不能仅改文本拼接。

### 笔友会写作人格

「深度分析写作风格」使用 `buildCharacterRequest`，携带角色核心设定、当前挂载且满足触发条件的世界书、用户档案及按公共规则可读的记忆。分析规则放在系统指令中，不参与世界书关键词扫描；指定深度和消息角色由公共管线保持。

`CharacterProfile.impression` 是角色对 **用户** 的印象，不是角色自己的性格档案。笔友会不得把其中的 MBTI、特质、喜恶、习惯、总结拿来充当作者人格、写作禁忌、范文或采样参数。世界书绑定给角色也不代表条目里每个人物都属于角色；分析和共创提示词明确区分 char、user 和小说人物，用户资料仅用于互动关系。

未生成创作档案时使用中性占位与通用写作指导，不从备注、混合世界观或用户印象猜出固定性格。保存的 `writerPersona`（包括手工修改）原样保留；旧分析如已混淆，需要用户点「深度分析写作风格」重新生成或手动修正。请求失败或输出为空不会覆盖旧档案，也不会以本地兜底冒充分析成功。

验证：`utils/novelPersona.test.ts`。

### 发送统计

统计按正文标题拆分；沿用 master 的修复，世界书条目内部小标题不再拆散世界书分区。`apiCallLog.findBlockHeaders` 通过 `formatWorldbookSection` 的收尾格式（条目末尾 `---`，整段末尾额外空行）识别边界，修改格式须同步统计解析与测试。完整请求 JSON 用于确认实际发送内容。见面用户输入参与关键词匹配，VN 指令不参与；depth=0 条目不会被错误追加用户输入的 System Note。

验证：`utils/contextPipeline.test.ts`、`utils/contextWorldbook.test.ts`、`utils/chatRequestPayload.test.ts`、`utils/datePrompts.test.ts`、`utils/worldbook.test.ts`、`utils/storyTheater.test.ts`、`utils/apiCallLog.test.ts`。

视频通话先给真实用户消息贴摄像头快照，再构建世界书消息；不支持图片时只还原原用户消息，保留同轮世界书的激活结果与顺序。群聊输出继续沿用 master 的思考块清理逻辑。


### 3D 实验分支对齐（2026-10-05）

本分支沿用 master 的 `25468054`（PR #674）公共管线及其前置世界书修复，不维护第二套 contextRequest/worldbookRequest 组装器。随后已完整合并 master（0e8d3534），保留 3D 家园适配与分支功能。

分支已有日程从 IndexedDB 异步读取，因此 `buildCoreContext`、`buildCharacterContext`、`buildCharacterRequest` 返回 Promise，调用时必须 await。世界书解析、消息角色和深度放置仍复用 master 的实现。

3D 家园通过 `buildChatRequestPayload` 复用 ChatApp 的历史清洗、世界书装配、记忆召回和实时上下文，替换本应用的行为/输出提示词。2026-10-06 修正记录粒度：发言各自保留 user / assistant，连续短动作合段，跨发言、其他 App 消息或归档边界不合并；旧整轮记录保留数据库 ID，在范围筛选后展开角色与时间，世界书扫描和深度插入消费展开后的实际历史。家园生成前也复用本机收件准备。`homeChatPipelineParity.test.ts` 对照共享组装器输出，`homeContextSegments.integration.test.ts` 补充跨 App 顺序、收件、迁移回滚、归档并发及旧输入重试边界；不能仅凭共享组装器测试推断整个入口的准备流程一致。

后台保留既有 fire_pack v7、门牌输入 v1 和文本兼容边界。本次撤回额外的后台结构化世界书协议扩展，不要求为此升级云端协议。
