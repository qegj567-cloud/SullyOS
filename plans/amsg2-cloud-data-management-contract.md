# 云端数据管理：上下游实施契约

用户已确认本方案并授权分批实现、上游走正式仓库发版流程、SullyOS 接入。此文件是本次工作的交接规范；旧计划中针对其他任务的提交/发布限制不适用于本次授权。

## 目标与边界

云端实际存储是唯一清单来源，本地角色为空仍须列出所有当前租户、当前用户的数据。本地仅辅助标注“本机有关联”，不决定可见范围或删除范围。本次只改 amsg 云端管理，不顺带清用户本地聊天、记忆或任何真实部署数据。

上游 ReiStandard 提供通用云端资源管理、SDK、持久清理与并发写入防护；SullyOS Worker 提供业务归属规则，浏览器消费服务端清单和操作结果。用户手动部署的旧 Worker 必须通过能力位检测，不能因为前端 SDK 已更新便当成服务端已更新。

## 交付批次

1. 云端全量可分页清单、归属元数据、旧数据识别，server/client 同步文档和测试。
2. 服务端预览、持久清理操作、重试、关闭页面续跑、按归属移除的写入防护。
3. 按 ReiStandard 的 RELEASING.md / Changesets / CI 流程发版，SullyOS 锁定实际发布版本、接入、构建和回归。可用同一组功能 PR 分阶段提交，避免为了分批让用户反复部署不完整能力。

## 清单

覆盖真实的任务（定时、即时、后台、失败/运行中）、client_state（含临时输入、日志和空壳）、llm_credentials、message_outbox（含已 ack 未过期记录）、push_subscriptions。大值切片按逻辑资源合并计数和体积，不得变成隐藏不可回收的孤儿。无法解密、无法识别归属的记录仍可列为 unknown，不返回凭据正文、推送端点、聊天原文等机密。

所有读接口返回完整性和缺口信息。分页必须能到达末尾；既有 namespace 200 项上限不能冒充全集。分页游标须绑定当前查询与用户，列表并发变化不得让清理误伤未确认资源。全库摘要只在用户操作时读取，避免轮询反复全表扫描。

建议资源契约（agent 可按现有适配器合理细化，开始下游实现前回传最终 TypeScript/API 形状）：

```ts
type CloudOwner = { type: string; id: string; label?: string };
type CloudResourceType = 'task' | 'state' | 'credential' | 'outbox' | 'subscription';
type CloudResource = {
  id: string; // 服务端生成的不透明标识，须按用户验证，不能直接信任传入表名或路径
  type: CloudResourceType;
  owner: CloudOwner | null;
  kind: string | null;
  label: string; // 不含秘密；未知用资源标识说明，不能编造角色名
  byteSize: number | null;
  updatedAt: number | null; // Unix 毫秒，非角色墙钟
  status: string | null;
};
type CloudPage = {
  resources: CloudResource[];
  nextCursor: string | null;
  complete: boolean; // 所支持来源可读，与是否还有下一页分别表达
  gaps: Array<{ source: string; code: string; message: string }>;
};
```

所有通用资源必须可见，不以 owner 注册表作为存在性真相。若用归属索引，索引更新与数据写入一致，索引缺失时仍可见原始记录。tenant/user 隔离沿用上游现有鉴权，不能增加跨用户列举权限。

## 归属与历史数据

写状态、凭据、任务支持 owner/kind；任务派生的状态、结果和后续任务尽量继承归属。名称快照按现有加密规则处理，不因做管理而明文存私密身份信息。

SullyOS 规则：`amsg:char:<id>`、`char:<id>/<purpose>`、任务 metadata.charId；`amsg:job` 是共享命名空间，归属必须细到每个 job 输入，不能整 namespace 随角色删除。后台任务的 jobId 可用于将旧输入与任务关联；关联不存在或不可解密则 unknown，不能猜。全局工具配置、推送订阅等不随角色删除。宿主特有规则用配置/回调提供，不硬编码进通用 SDK。

迁移按云端记录进行、可分批可重跑，不依赖浏览器角色表。迁移缺口/无法恢复名称须在 API 中如实表达。共享引用不应被错误归到单一角色。

## 清理协议

建议入口：GET /cloud-data/summary；GET /cloud-data/resources；POST /cloud-data/cleanup-plans；POST /cloud-data/cleanup-operations；GET /cloud-data/cleanup-operations（最近操作）；GET /cloud-data/cleanup-operations/:id。SDK 提供对应带类型方法。能力位建议 `cloud-data-management`，仅完整实现该契约的适配器宣告支持。

预览按资源标识/类别或精确 owner 选择，返回 planId、范围、逐类数量、影响、有效期。正常清理固定已预览资源与版本；内容变化须拒绝旧计划/要求新预览，不能扩大范围。彻底移除 owner 要在预览说明包含执行时该 owner 的全部资源，执行先停用归属再枚举，避免遗漏预览后新增的内容。

执行使用幂等键并返回 operationId；操作持久在服务端，初次请求可处理有界批次，cron 继续执行/退避重试，浏览器关页不影响。逐类返回 deleted/remaining/failed 和原因，缺失能力/查询失败不是零条。执行中断之后能继续，重复提交同一幂等键不得重复创建操作。轮询操作只读操作记录，不跑全库清点。

两个模式严格区分：

- purge：清选中的数据，之后正常写入可重建；预览说明任务受影响，不能承诺自动取消所有任务。
- retire-owner：先持久停用 owner/提升 generation，使旧任务和旧请求失效，再取消所有所属任务、清理状态、专属凭据、作业输入和结果。清理完成前核查剩余，无法确认不能 completed。

任务启动、衍生任务、状态写入、凭据写入、outbox 写入和推送边界都需要停用/generation 检查，检查与落库要有可证明的并发保护；不能只在任务开始检查。已经交给外部推送服务的通知无法撤回，结果需说明边界。恢复停用 owner 必须显式接口及用户操作，普通同步/旧设备不能悄悄复活。需提供 owner 状态/恢复入口供应用层展示。

没有归属的资源可以按明确选中项清理，不推断其所属角色；无法解密不阻塞其他已确认资源处理。凭据不应出现在任何管理响应或日志里。不得依靠 catch 后返回成功处理失败。

## SullyOS 接入

1. ActiveMsgClient 用正式 SDK 封装上述接口，能力探测后路由；旧路径明确不完整。
2. Worker 注册归属规则；浏览器写入必要 owner/kind/名称快照，服务端派生输出继承。
3. 云端管理从服务端资源列表展示，按类别/角色过滤，unknown 和 global 可见；不默认选中“本机找不到”数据。可显示名字/完整 ID/更新时间/占用/状态，详情不显示秘密。
4. 选择 → 服务端预览 → 确认 → 创建操作 → 展示逐项结果；最近操作可重开，不把 pending/skipped 计为成功。
5. 神经链接删角色提交 retire-owner；记录操作标识用于续看。旧 Worker 保留显式兼容路径，不能冒充彻底移除。不得触碰无关本地清理逻辑。
6. 统一提示名称和管理入口，将云端管理提升为设置页可直达入口；提示能告知确切入口。
7. 接入已发布精确依赖版本，更新锁文件和 Worker 产物。APP_VERSION 按现有规则不因修复/管理完善随意升级。

## 必须通过的验收

- 本地无角色仍可列全资源；201+ namespace、已 ack outbox、仅状态/仅凭据、unknown 和坏密文可见。
- tenant/user 隔离，伪造资源/plan/operation ID 不跨用户；响应不含 Key、正文、订阅秘密。
- 预览后资源变更不误删；旧计划失效行为明确；空选择不扩大为全删。
- 删除一个 owner 不动另一个 owner、全局/共享输入，切片和该角色临时输入一起收尾。
- LLM 运行中移除 owner，晚到结果不得写回/派生/重新投递；显式恢复后旧 generation 仍无效。
- 中途失败逐项报告、关闭页面后 cron 继续、重复请求幂等、失败读取不报 completed。
- 旧部署显示升级提示，不运行假定支持的新接口；SDK 和 Worker 一起升级后功能可用。
- 完成针对性测试、上游必需 CI、下游相关测试和生产构建，再走上游发版。报告真实版本、提交/PR、发布结果；凭据/权限阻塞不得谎称已发布。

## 协作

上游 agent 负责 ../ReiStandard 内所有变更、必要的 changeset / PR / CI / 发布，并尽早将稳定接口、宿主归属配置、能力位和版本计划发回主线程。主线程负责 SullyOS，勿交叉修改。发布沿用仓库流程，不手写猜测版本，不操作用户真实 Worker 数据。需要外部写权限时按工具权限流程申请。

## 已落实的应用约定

- SDK 能力位为 `cloud-data-management`。统一标准加密信封，session 固定 Worker URL 与 userId。
- 资源通过 `listCloudDataResources` 分页，每页 50 项；`complete` 指数据源完整性，`nextCursor` 表示仍有下一页。`getCloudDataSummary` 汇总实际云端资源；`listCloudDataOwners` 独立列出停用登记，不把它当资源清单。
- 预览由 `createCloudDataCleanupPlan` 返回，执行由 `startCloudDataCleanup({planId,idempotencyKey})` 返回操作；`getCloudDataCleanupOperation` 只读进度。页面仅轮询 pending/running 操作，每 4 秒一次。后续批次依赖 Worker 的 Cron Trigger；暂停后台任务的部署需要恢复定时触发。
- 普通清理 `purge` 固定资源及版本；删除角色用 `retire-owner`，成功受理响应必须已经建立停用屏障。未确认时保留本地角色，用户可明确选择仍删本地。
- `getCloudDataOwner` 查询状态，`restoreCloudDataOwner` 明确恢复。恢复操作返回新 generation；已启用的 owner 返回当前代次供另一设备明确接入。每个浏览器连接在创建时冻结代次，旧异步请求不会随恢复获得新权限；停用/恢复时同时丢弃待重试的旧上下文快照。
- 删除角色的请求身份、计划编号和幂等键按 Worker/user 保存在本机。丢响应后重试同一请求；本地角色已删也能从管理面板再次提交。此记录只是未确认请求，不作为云端资源存在的证据。
- `amsg:global` 及订阅使用 `owner:null`、`kind:global-state/global-subscription`；不随单角色移除。未知资源同为 null，但没有共享 kind，界面显示“归属未知”。
- 旧 Worker 只允许查看明确标成不完整的旧清单。角色删除保留旧兼容路径；设置中的旧组合“清空云端数据”按钮已移除，统一使用云端管理预览。
- 本次未扩展“重置全部本地数据”的旧云端善后流程，也未处理所有本地跨 App 角色引用。这两项不能据本次改动宣称已彻底清除。

## 手工验证

使用隔离模拟数据，在 390×844 视口检查分页、默认不选、单项预览、提交后显示处理中、已停用角色恢复入口、恢复失败提示、部分清单缺口。未读取或删除任何实际用户 Worker 数据。

## 发布与验证结果（2026-10-07）

- ReiStandard 功能 PR：[94](https://github.com/Tosd0/ReiStandard/pull/94)；版本 PR：[95](https://github.com/Tosd0/ReiStandard/pull/95)，均已合并。
- 已发布到 `next` 且已在 SullyOS 精确安装：`@rei-standard/amsg-client@2.9.0-next.15`、`@rei-standard/amsg-server@2.6.0-next.34`。`latest` 渠道未改。
- 上游完整 CI 1421 项通过。下游使用实际发布包，17 个相关测试文件共 780 项通过，生产构建成功。
- Worker bundle 标记 `2026-10-07`，包含 `cloud-data-management` 与 schema `2.6.0-cloud-data.1`，仓库产物与 public 分发副本一致。
- 部署新版 Worker 后，定时触发的 `ensureSchemaOnce` 会补齐表；也可在主动消息配置中重新连接，通过 `/init-tenant` 幂等补表。只更新网页或 SDK 不会更新用户自己的 Worker。
- 全仓 `tsc --noEmit` 仍受既有手办实验/夹具缺模块、jsdom 声明和 Worker 测试类型问题影响；本次接入代码无新增类型错误。
- 本次未发布 SullyOS 网站、未操作真实用户云端数据；应用变更随本契约提交独立 PR。


### D1 空闲维护与额度修复（2026-10-08）

本次精确安装正式发布的 `@rei-standard/amsg-client@2.9.0-next.16`、`@rei-standard/amsg-server@2.6.0-next.35`；Worker bundle 标识为 `2026-10-08`，App 大版本不变。

- 普通删除和 TTL 删除在同一事务内清掉资源标签；状态根或任意分块还在时保留逻辑资源标签。定时任务不再逐类全库扫描孤儿标签。
- 清理操作以独立索引保存执行时间与到期时间；每跳只读取最多 25 个到期、未完成、未被租约占用的操作。已完成历史不再每分钟枚举和解密，未完成操作不因存放时间长而丢失。
- 旧标签和操作索引按每源每跳最多 100 个根记录补齐，持久保存游标和完成标记。Worker 重启或重新部署不会重新全扫；不可读旧记录保留给用户检查。
- 清理预览、清单快照、终态操作及原有任务/状态/收件箱的过期清理均按索引分批处理，保留原来的到期判据。云端资源清单随页返回同一快照的摘要，网页直接复用；旧 Worker 无此字段时回退独立摘要接口。
- Worker 的定时更新检查移到表结构补齐、维护和投递之前；维护失败不再跳过本轮更新尝试。后台检查仍是 6 小时节流，网页冷启动检查仍是 30 分钟节流，均不代表固定半小时计时器；关闭定时任务时不会自行后台检查或执行续清理。
- 手动更新入口先于业务数据库检查，D1 额度耗尽时仍可尝试安装公开修复包；更新成功不等于当天 D1 额度已经恢复，业务仍须等待 UTC 零点额度刷新。
