/**
 * SullyOS 主动消息 2.0（amsg2）— 单用户 Cloudflare Worker 入口。
 *
 * 定时任务存 D1（binding 名固定 `DB`），到点投递由 Cron Trigger 触发
 * scheduled()，没有 send-notifications 这类 HTTP 投递端点。
 *
 * 部署走「Dashboard 粘贴」：`pnpm build:workers` 把这份入口打成
 * worker/amsg/worker.bundle.js（+ public/amsg-worker.bundle.js 供设置页
 * 「复制 Worker 代码」按钮读取），整份粘进 CF Dashboard 的 Edit code 即可。
 * amsg-server 2.6.0-next.2 起全 Web Crypto，无需 nodejs_compat flag。
 *
 * Worker 侧要配的东西（都在 CF Dashboard 的 Settings 里）：
 *   - D1 binding:  变量名 `DB`（库随便建一个，表由前端「连接」时 POST /init-tenant 幂等创建）
 *   - Cron Trigger: `* * * * *`（每分钟查一次到点任务，UTC）
 *   - env: AMSG_MASTER_KEY（64 位 hex）+ VAPID_EMAIL / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
 *          + 可选 AMSG_SERVER_TOKEN（配了则所有端点强制校验 X-Client-Token）
 *
 * 上面这些漏了哪样，`GET /config-check` 会直接列出来（见 inspectWorkerEnv），
 * 前端「连接并验证」也会读它，不用去翻 Cloudflare 的日志。排障时还有个信息更全的
 * `GET /debug`：配置 + 库的 schema + cron 有没有在按时处理任务，全只读、不带敏感信息，
 * 隔着屏幕帮人看部署时用它。
 *
 * VAPID 必须和 SullyOS「推送凭据 (VAPID)」面板里的是同一对：整个站点
 * 共用一个浏览器 push 订阅，worker 用别的密钥对签推送会 403。
 */

import { DurableObject } from 'cloudflare:workers';
import {
  createSingleUserCloudflareWorker,
  createD1Adapter,
  createWebCryptoWebPush,
  decryptFromStorage,
  deriveUserEncryptionKey,
  encryptForStorage,
  measurePushPayload,
  runScheduledTick,
} from '@rei-standard/amsg-server/cloudflare';
import { stripReasoningTags } from '@rei-standard/amsg-shared';
import { AMSG_BUNDLE_VERSION } from '../../../utils/amsgBundleVersion';
// 「上一次推送被判订阅失效」的形状，跟前端体检共用一个类型定义（那份是零依赖纯叶子；
// 往里加任何浏览器依赖都会连累这个 bundle）。这里只产出事实，红绿灯和文案归前端。
import type { AmsgPushGoneFailure } from '../../../utils/amsgDiagnostics';
import type { UserProfile } from '../../../types';
import {
  AMSG_CHAT_FAIL_KEY,
  AMSG_FIRE_PACK_KEY,
  AMSG_LAST_SKIP_KEY,
  AMSG_SELF_LOG_KEY,
  AMSG2_INSTANT_STUB_TEMPLATE,
  type AmsgChatFailRecord,
  type AmsgLastSkip,
  type AmsgSelfLog,
  type AmsgTzRef,
  amsgStateNamespace,
  amsgXhsSessionKey,
  appendSelfLogEntry,
  appendSelfLogTask,
  countUnansweredSends,
  describeFirePackVersion,
  parseFirePack,
  parseSelfLog,
  reconcileSelfLogWithPack,
  renderFirePack,
  renderSelfLogBlock,
  resolveMaxUnansweredSends,
  unpackStateValue,
} from '../../../utils/amsgFirePack';
import { resolveFireSceneSong } from '../../../utils/amsgFireScene';
import { shouldExpireFire } from '../../../utils/amsg2ExpireGuard';
import { buildFireTaskListBlock, isPendingTask, MAX_ACTIVE_TASKS_PER_CHAR, shortTaskId } from '../../../utils/amsg2Tasks';
import {
  AMSG_FIRE_CANCEL_TOOL,
  AMSG_FIRE_RENEW_TOOL,
  AMSG_FIRE_SCHEDULE_TOOL,
  buildFireCancelTool,
  buildFireRenewTool,
  buildFireScheduleBlock,
  buildFireScheduleTool,
  buildSelfScheduleUuid,
  MAX_FIRE_SCHEDULES,
  parseFireRenewSendAt,
  parseFireScheduleArgs,
  resolveFireTargetTask,
  buildTaskInstruction,
} from '../../../utils/amsgFireSchedule';
import {
  AMSG_CHAT_PRESENCE_KEY,
  isFreshChatPresence,
  parseAmsgChatPresence,
} from '../../../utils/amsgChatPresence';
import {
  AMSG_GLOBAL_NAMESPACE,
  AMSG_TOOL_CONFIG_KEY,
  AMSG_TOOL_PACK_KEY,
  parseToolConfig,
  parseToolPack,
  type AmsgToolConfig,
  type AmsgToolPack,
} from '../../../utils/amsgToolPack';
import { buildRealtimeWorldBlock } from './realtimeWorld';
import { handleSelfUpdate } from './selfUpdate';
import {
  buildMcpDirectHeaders,
  buildMcpFireBlock,
  buildMcpFireTools,
  buildMcpNameMap,
  callMcpToolCore,
  createMcpSessionState,
  filterMcpServersForChar,
  formatMcpToolResult,
  MCP_FIRE_NAME_BUDGET,
  MCP_FIRE_NAME_PREFIX,
  type McpResolvedToolCore,
  type McpSessionState,
} from '../../../utils/mcpFireCore';
import { dispatchAgenticTool, type AgenticToolChar, type AgenticToolCtx } from '../../../utils/agenticTools';
import {
  buildDuplicateToolMessage,
  buildToolResultMessage,
  neverRan,
  toolCallFingerprint,
  type ToolCallRecord,
} from '../../../utils/agenticToolFeedback';
import { setProxyWorkerUrlOverride } from '../../../utils/proxyWorker';
import { XhsMcpClient } from '../../../utils/xhsMcpClient';
// type-only：编译期擦除，classifier 的实现不会因为这行被拉进 bundle。
import type { ToolCall } from '../../instant-push/src/classifier';
import {
  classifyNativeToolCalls,
  createFireSessionState,
  MAX_TOOL_ITERATIONS,
  processLLMRound,
  type FireSessionState,
} from './agentic';
import {
  amsgEmotionUpdateKey,
  EMOTION_EVAL_RIDE_ALONG_MS,
  resolveEmotionEvalApi,
  runAmsgEmotionEval,
  stripEmotionEvalSpec,
  takeEmotionEvalSpec,
  type AmsgEmotionEvalOutcome,
} from './emotionEval';
import {
  applyInstantNotificationPolicy,
  buildInstantTimelyBlock,
  handleInstantChat,
  INSTANT_TOTAL_TIMEOUT_MS,
  isInstantChatTask,
  type InstantTickNamespace,
} from './instantChat';
import type { ActiveMsg2TaskRecord } from '../../../types';
import { createHybridPushTransport, isFcmConfigured, type NativeFcmEnv } from './nativeFcm';

interface Env extends NativeFcmEnv {
  AMSG_MASTER_KEY: string;
  VAPID_EMAIL: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  /** 可选共享密钥；配了才校验 X-Client-Token，不配则端点全开。 */
  AMSG_SERVER_TOKEN?: string;
  /** D1 binding（factory 默认 createD1Adapter(env.DB)，这里只是标注存在）。 */
  DB: unknown;
  /** 以下三项给 /self-update 用，都可选；没配 CF_API_TOKEN 就是不开自更新。见 ./selfUpdate。 */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_SCRIPT_NAME?: string;
  /**
   * 即时对话的起跳器（Durable Object）。类型上可选是因为老版本 Worker 上真的没有它，
   * 那种情况由 /instant-chat 明确报「需要更新 Worker」，见 instantChat.kickInstantTick。
   */
  INSTANT_TICK?: InstantTickNamespace;
}

type D1RunResult = { success?: boolean; meta?: { changes?: number } };
type D1BoundStatement = {
  run?(): Promise<D1RunResult>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
};
type D1Statement = D1BoundStatement & {
  bind(...values: unknown[]): D1BoundStatement;
};
type D1AuditLike = {
  prepare(sql: string): D1Statement;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

// ─── 满血 fire-time hooks（amsg-server 2.6.0-next.4+：含 ctx.scratch / 存储层大值分块） ───
//
// AI 任务的 prompt 到点才组装：读前端同步上来的 fire_pack（client_state 表，见
// utils/amsgFirePack.ts + utils/amsgStateSync.ts），在 fire 时刻现算时间填槽 →
// 上下文永远是「用户最后一次聊天时」的状态。任务体里没有第二份 prompt——排程链保证
// 「先传云端状态、成功了再建任务」（activeMsgClient 的 putClientStateOrThrow），
// 所以读不到 fire_pack 就是异常，直接抛错，不降级（见 fireStateError）。
//
// v2 服务端工具循环：LLM 输出经 instant 同款业务标签 classifier 分类
// （见 ./agentic.ts），数据标签由 executeToolCalls 在 worker 内就地执行
// （recall 读 tool_pack 里的月度总结，搜索 / Notion / 飞书 / XHS 用 tool_config
// 里的凭据直调，全程不需要客户端在线）；副作用标签结构化成 directives 挂
// 最后一条 push，客户端收到时重放。tool_pack / tool_config 与 fire_pack 同批上传，
// 所以和它一样按「读不到就是异常」处理；没配凭据的工具自己会回 not_configured。
//
// 思考链走 metadata、不占一条 push：只发 content push，把这次生成的 reasoning 挂在
// **第一条** push 的 metadata.amsgReasoning 上，客户端在那条上渲染思考链卡片
// （收侧与 instant push 共用同一处认领，见 utils/activeMsgRuntime.ts）。
// 这么走的好处是编号不动：hook 路径的 sendHookPushPayloads 会把 pushPayloads 数组整体
// 编号（messageIndex/totalMessages），多插一条 reasoning push 就会把第一条 content
// 顶到 messageIndex=2，多段消息的等齐、补收、directive 重放全跟着编号走。
// 正文里的 <think> 标签照旧 strip，只是剥之前先抄一份当思考链。

interface FireCtx {
  task: {
    id?: string | number | null;
    /** 任务行 uuid（客户端清单里的那个）；跳过时留痕要拿它对上是哪一条。 */
    uuid?: string | null;
    contactName?: string;
    recurrenceType?: string;
    nextSendAt?: string | null;
    metadata?: Record<string, unknown>;
    /**
     * 凭据引用（`{ <用途>: <cred_id> }`）。聊天那一路由上游自己解析后直接喂给 LLM，
     * 宿主碰不到也不必碰；这里只用得上别的用途——现在只有 `emotion`（情绪评估的副 API）。
     * 引用本身不是机密（只是个名字），所以上游没把它挡在 hook 之外。
     */
    credRefs?: Record<string, unknown> | null;
  };
  userId: string;
  /**
   * 按名字取一行凭据（amsg-server 2.6.0-next.17+）。查不到回 null，老部署上整个方法不存在。
   * **红线**：取到就地用完即弃，绝不挂到 ctx / task / metadata / push 上——凭据一旦
   * 沾上会流向推送的任何对象，就等于送出门了。
   */
  resolveLlmCredential?: (
    credId: string,
  ) => Promise<{ apiUrl: string; apiKey: string; primaryModel: string } | null>;
  readState: (namespace: string) => Promise<Array<{ key: string; value: string }>>;
  /** 与每轮 sessionCtx 上那个是同一套写口（防穿帮闸跳过时用它留一句原因）。 */
  writeState?: WriteState;
  scheduleTask?: ScheduleTask;
  cancelTask?: CancelTask;
  renewTask?: RenewTask;
  now: Date;
  /**
   * 单次 fire 的宿主便签（amsg-server 2.6.0-next.4+）：与同一次 fire 每轮的
   * sessionCtx.scratch 是同一个对象引用，fire 结束随调用栈丢弃，库不读不写。
   */
  scratch: Record<string, unknown>;
}

/** client_state 的写入口（amsg-server 2.6.0-next.7+）；value 传 null 即删除该 key。 */
type WriteState = (
  namespace: string,
  entries: Array<{ key: string; value: string | null; updatedAt?: number }>,
) => Promise<{ upserted: number; skipped: number; deleted: number }>;

/**
 * 在这次 fire 里再建一条定时任务（amsg-server 2.6.0-next.9+）。
 * 凭据与投递配置由库从当前任务继承，这里只说「什么时候、说什么方向」。
 * uuid 撞车不抛错，回 { created: false } 外带已存在那行的脱敏投影（不含任何凭据）
 * ——fire 重跑时靠确定性 uuid 天然幂等，投影让重跑那一轮也能把账记下来。
 */
type ScheduleTask = (options: {
  firstSendTime: string;
  recurrenceType?: string;
  messageType?: string;
  metadata?: Record<string, unknown>;
  uuid?: string;
  /** 任务的时间参照系（IANA），daily / weekly 按这个时区的墙钟推进。 */
  tzId?: string | null;
}) => Promise<
  | { created: true; id: number | null; uuid: string; nextSendAt: string }
  | {
      created: false;
      reason: 'duplicate';
      uuid: string;
      task: {
        nextSendAt?: string | null;
        recurrenceType?: string | null;
        messageType?: string | null;
        clientTaskId?: string | null;
      } | null;
    }
>;

/**
 * 取消 / 改期一条既有任务（amsg-server 2.6.0-next.15+ 的 fire ctx）。
 * 两个都不许动当前正在 fire 的这条（上游抛 RangeError），调用前先自己拦。
 * renewTask 只换时间（uuid 不变、重试计数清零）；行不存在回 { renewed: false }。
 */
type CancelTask = (uuid: string) => Promise<{ cancelled: boolean }>;
type RenewTask = (uuid: string, nextSendAt: string) => Promise<
  { renewed: true; uuid: string; nextSendAt: string } | { renewed: false; reason: string }
>;

interface SessionCtx {
  /** 日志与去重用的不透明串。任务身份读下面三个字段，别拿它切。 */
  sessionId: string;
  llmResponse: unknown;
  llmOutputText: string;
  contactName: string;
  avatarUrl?: string;
  metadata: Record<string, unknown>;
  scratch?: Record<string, unknown>;
  writeState?: WriteState;
  scheduleTask?: ScheduleTask;
  cancelTask?: CancelTask;
  renewTask?: RenewTask;
  /** 本次 fire 的第几轮 LLM（0-based）。最后一轮不再放行工具请求，见 MAX_TOOL_ITERATIONS。 */
  iteration?: number;
  /** 任务行 id；没有任务行的 in-server instant 路径为 null。 */
  taskId: number | string | null;
  /** 任务行 uuid。 */
  taskUuid: string | null;
  /** 本次触发的名义时刻（epoch 毫秒）。 */
  occurrenceMs: number | null;
}

/** 一次 fire 的跨轮状态：工具执行上下文 + 旁白累积。挂在 ctx.scratch.fire 上。 */
interface FireStash {
  session: FireSessionState;
  toolCtx: AgenticToolCtx;
  proxyWorkerUrl: string | null;
  xhsCookie: string;
  /** 本次触发时刻（任务行 next_send_at）；透传给每条 push 的 metadata.amsgOccurrenceMs。 */
  occurrenceMs: number;
  /**
   * 「角色自己发过什么」的当前版本（已跟本次 fire_pack 对齐过；对不上就是空的一份）。
   * onBeforeFire 读进来注入 prompt，onLLMOutput 发完在它上面追加一条写回云端。
   */
  selfLog: AmsgSelfLog;
  /**
   * selfLog 上有没有还没落盘的改动。收尾时（amsgFireSettled）据此决定要不要写一次库。
   *
   * 「角色给自己排了任务」这件事必须靠它落账：任务在 ctx.scheduleTask 那一刻就真的
   * 建进 D1 了，但如果这轮最终没有正文可发（只做了副作用 / 空生成），账没记下来的话
   * 客户端认领不到、面板看不见，用户永远取消不掉它，而它会一直按时发下去。
   */
  selfLogDirty: boolean;
  /** 通用 MCP：暴露名 → 服务器/工具。tool_config 里没配（或对该角色不可见）时为 null。 */
  mcpResolve: Map<string, McpResolvedToolCore> | null;
  /**
   * 本次 fire 声明给模型的非 MCP native 工具名（schedule / cancel / renew 按各自开关
   * 在场与否）。onLLMOutput 认领 native tool_call 时拿它当清单（MCP 那份在 mcpResolve）。
   * 从拼好的 fireTools 现算——以后加新工具不用再来入口登记。onBeforeFire 拼完 fireTools
   * 后填充，在那之前是空集。
   */
  fireToolNames: Set<string>;
  /** 每服务器一份连接会话，单次 fire 内跨轮复用，fire 结束随 scratch 丢弃。 */
  mcpSessions: Map<string, McpSessionState>;
  /** 本次 fire 已经花在 MCP 调用上的毫秒数，见 MCP_TOTAL_BUDGET_MS。 */
  mcpSpentMs: number;
  /** 打包那一刻客户端已知的待触发任务，用来算「还能不能再排」。 */
  pendingTaskCount: number;
  /**
   * fire 开场的活任务清单（客户端快照 + 自排未认领），取消 / 改期工具按短 id
   * 在这里找目标。唯一生产者 onBeforeFire 恒定初始化，必填。
   */
  pendingTasks: ActiveMsg2TaskRecord[];
  /** 角色本次 fire 已经排成功的任务（也是要随 push 带回客户端认领的那些）。 */
  scheduledTasks: ActiveMsg2TaskRecord[];
  /**
   * 本次 fire 内已经消耗掉的排程序号（只增不减）。自排任务的确定性 uuid 由
   * 「触发时刻 + 序号」推出来，序号不能取 scheduledTasks.length——取消会让数组回缩，
   * 「排 A → 排 B → 取消 A → 排 C」时 C 会撞上还活着的 B 的 uuid（撞车被当成
   * fire 重跑回 ok:true，任务实际没建）。fire 重跑时 stash 重建、序号从头推进，
   * 重跑的确定性去重语义不变。
   */
  selfScheduleSeq: number;
  /**
   * 本次 fire 里取消 / 改期掉的既有任务（uuid / uuid+新时刻）。随最后一条 push 的
   * metadata.amsgTaskMutations 带回客户端消账——D1 行已经动了，本地清单不跟着动的话，
   * 面板会一直列着一条永远不会响（或时间不对）的任务。唯一生产者恒定初始化，必填。
   */
  cancelledTasks: string[];
  renewedTasks: Array<{ taskUuid: string; sendAt: string }>;
  /**
   * 用户设的「未回复期间最多连发几条」（已解析：0 → Infinity、缺省 → 默认值）。
   * 排程工具用它打回超额的自排；到点兜底闸在 onBeforeFire 里直接用 pack 上的原始值。
   */
  maxUnansweredSends: number;
  /**
   * fire 开场时还没响的自排任务条数（pendingTasks + selfLog.tasks 里 source='character'
   * 且时间在未来的）。它们到点各会消耗一条连发额度，排程工具算「还能不能再排」要连它一起数。
   */
  plannedSelfSends: number;
  /**
   * plannedSelfSends 那份快照里各条任务的 uuid。排程闸退额度用：本轮被成功取消的、
   * 原本计入快照的任务，按它与 cancelledTasks 的交集把额度还回来——不退的话，
   * pending 打满上限时提示词教的「cancel + 重排」必被打回（任务删了却排不回来）。
   */
  plannedSelfSendUuids: string[];
  /** 本次触发用到的角色 id / 任务归属键，排程时要写进新任务的 metadata。 */
  charId: string;
  /** 防穿帮闸锚点：这份 fire_pack 记的「用户最后一次开口」。 */
  anchorMs: number;
  /**
   * 角色的时间参照系（fire_pack 的 tzId）。worker 里一切「给角色看的时间」
   * ——当前时间槽、self_log 时间戳、排程清单、send_at 解析与打回文案——都从这一份出。
   */
  tz: AmsgTzRef;
  /** 任务行 uuid（skip 留痕要对上是哪一条；拿不到为 null）。 */
  taskUuid: string | null;
  /** 任务行 id（字符串化）；日志与自排任务的 metadata 用。 */
  taskRowId: string | null;
  /** 客户端给这条任务起的归属键，self_log 的条目 id 用它。 */
  clientTaskId: string;
  /**
   * 这次生成的各段正文，等推送发完由 onAfterSend 按真送出去的段数写进 self_log。
   * 没生成、或者已经写过一次时为 null。
   */
  selfLogTexts: string[] | null;
  /**
   * prompt 里那句「你此刻在听：《X》」写的是哪一首（这一段没渲染时为 null）。
   *
   * 在 onBeforeFire 就定下来，用的是填槽那一刻的时间：角色写的 MUSIC_ACTION 说的正是
   * 它读到的那首歌，onLLMOutput 把它冻进 directive 带给客户端（见 agentic.attachSceneSong）。
   */
  sceneSong: { id?: number; name: string; artists: string } | null;
  /** 这条任务是不是即时对话（用户刚发完消息在等回复）；决定要不要写 outbox。 */
  instant: boolean;
  /**
   * 这一轮的情绪评估（副 API）。onBeforeFire 起跑、onLLMOutput 收尾时 await，
   * 结论挂上最后一条 push。没配评估 / 不是即时对话时是 null。
   *
   * 存 promise 而不是结果：评估和主生成是并行跑的，等到收尾时多半早就跑完了。
   */
  emotionEvalPromise: Promise<AmsgEmotionEvalOutcome> | null;
  /**
   * 评估没赶上顺风车（EMOTION_EVAL_RIDE_ALONG_MS），push 上只挂了引用键 + pending
   * 标记。收尾时（amsgFireSettled）据此把迟到的结果写进旁路存储，客户端轮询补落。
   */
  emotionLatePending: boolean;
  /** 本次 fire 的云端 prompt 审计。完整 prompt 在 onBeforeFire 生成，结局在收尾时补齐落库。 */
  promptAudit: AmsgPromptAuditDraft | null;
}

const getFireStash = (scratch: Record<string, unknown> | undefined): FireStash | undefined =>
  scratch?.fire as FireStash | undefined;

interface AmsgPromptAuditModule {
  key: string;
  label: string;
  enabled: boolean;
  included: boolean;
  note?: string;
}

interface AmsgPromptAuditRound {
  iteration: number;
  decision: string;
  model: string | null;
  usage: {
    totalTokens: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
  };
  toolCalls: string[];
  outputText: string;
}

interface AmsgPromptAuditDraft {
  id: string;
  createdAt: number;
  expiresAt: number;
  charId: string;
  charName: string;
  taskUuid: string | null;
  taskRowId: string | null;
  clientTaskId: string;
  occurrenceMs: number;
  status: string;
  prompt: string;
  promptControls: Record<string, unknown>;
  promptModules: AmsgPromptAuditModule[];
  rounds: AmsgPromptAuditRound[];
  outputText: string;
  error: string | null;
}

const PROMPT_AUDIT_TABLE = 'prompt_audit_log';
const PROMPT_AUDIT_RETENTION_MS = 5 * 24 * 60 * 60 * 1000;
const PROMPT_AUDIT_MAX_LIMIT = 50;
const PROMPT_AUDIT_DEFAULT_LIMIT = 20;

const getAuditD1 = (env: Pick<Env, 'DB'>): D1AuditLike => {
  const db = env.DB as D1AuditLike | undefined;
  if (typeof db?.prepare !== 'function') {
    throw new Error('AMSG2_PROMPT_AUDIT_DB_MISSING');
  }
  return db;
};

const runD1 = async (statement: D1BoundStatement): Promise<D1RunResult> => {
  if (typeof statement.run === 'function') return statement.run();
  await statement.first();
  return { success: true, meta: { changes: 0 } };
};

const toFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const readLlmModel = (llmResponse: unknown): string | null => {
  const model = (llmResponse as { model?: unknown })?.model;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
};

const readLlmUsage = (llmResponse: unknown) => {
  const usage = (llmResponse as { usage?: Record<string, unknown> })?.usage ?? {};
  return {
    totalTokens: toFiniteNumber(usage.total_tokens ?? usage.totalTokens),
    promptTokens: toFiniteNumber(usage.prompt_tokens ?? usage.promptTokens),
    completionTokens: toFiniteNumber(usage.completion_tokens ?? usage.completionTokens),
  };
};

const buildPromptAuditModules = (
  promptControls: AmsgToolConfig['promptControls'],
  runtime: {
    mcpEnabled: boolean;
    realtimeStateEnabled: boolean;
    timeAwarenessEnabled: boolean;
  },
) => {
  const controls = promptControls && typeof promptControls === 'object' ? promptControls : {};
  return Object.entries(controls).map(([key, value]) => {
    const enabled = value !== false;
    const included = key === 'mcpTools'
      ? runtime.mcpEnabled
      : key === 'realtimeState'
        ? runtime.realtimeStateEnabled
        : key === 'timeAwareness'
          ? runtime.timeAwarenessEnabled
          : enabled;
    return {
      key,
      label: key,
      enabled,
      included,
      note: included ? undefined : '已关闭',
    };
  });
};

const createPromptAuditDraft = (
  ctx: FireCtx,
  prompt: string,
  promptControls: AmsgToolConfig['promptControls'],
  runtime: {
    mcpEnabled: boolean;
    realtimeStateEnabled: boolean;
    timeAwarenessEnabled: boolean;
  },
): AmsgPromptAuditDraft => {
  const createdAt = Date.now();
  const taskUuid = typeof ctx.task.uuid === 'string' ? ctx.task.uuid : null;
  const taskRowId = ctx.task.id != null ? String(ctx.task.id) : null;
  const clientTaskId = typeof ctx.task.metadata?.amsgClientTaskId === 'string'
    ? ctx.task.metadata.amsgClientTaskId
    : '';
  return {
    id: `${ctx.task.metadata?.charId || 'char'}:${taskUuid || taskRowId || 'task'}:${ctx.task.nextSendAt || ctx.now.getTime()}`,
    createdAt,
    expiresAt: createdAt + PROMPT_AUDIT_RETENTION_MS,
    charId: typeof ctx.task.metadata?.charId === 'string' ? ctx.task.metadata.charId : 'unknown',
    charName: typeof ctx.task.contactName === 'string' && ctx.task.contactName.trim() ? ctx.task.contactName.trim() : 'unknown',
    taskUuid,
    taskRowId,
    clientTaskId,
    occurrenceMs: ctx.now.getTime(),
    status: 'pending',
    prompt,
    promptControls: { ...(promptControls || {}) },
    promptModules: buildPromptAuditModules(promptControls, runtime),
    rounds: [],
    outputText: '',
    error: null,
  };
};

const appendPromptAuditRound = (
  draft: AmsgPromptAuditDraft,
  ctx: SessionCtx,
  outputText: string,
  decision: { decision: string; toolCalls?: Array<{ function?: { name?: string } }> },
) => {
  draft.rounds.push({
    iteration: typeof ctx.iteration === 'number' ? ctx.iteration : draft.rounds.length,
    decision: decision.decision,
    model: readLlmModel(ctx.llmResponse),
    usage: readLlmUsage(ctx.llmResponse),
    toolCalls: (decision.toolCalls ?? [])
      .map((tool) => (typeof tool?.function?.name === 'string' ? tool.function.name : ''))
      .filter(Boolean),
    outputText,
  });
  draft.outputText = outputText;
};

const sumPromptAuditUsage = (rounds: AmsgPromptAuditRound[]) => {
  const sum = (key: keyof AmsgPromptAuditRound['usage']) => {
    let total = 0;
    let seen = false;
    for (const round of rounds) {
      const value = round.usage[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        total += value;
        seen = true;
      }
    }
    return seen ? total : null;
  };
  return {
    totalTokens: sum('totalTokens'),
    promptTokens: sum('promptTokens'),
    completionTokens: sum('completionTokens'),
  };
};

const parseAuditJson = <T,>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const ensurePromptAuditSchema = async (env: Pick<Env, 'DB'>): Promise<void> => {
  const db = getAuditD1(env);
  await runD1(db.prepare(`
    CREATE TABLE IF NOT EXISTS ${PROMPT_AUDIT_TABLE} (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      char_id TEXT,
      char_name TEXT,
      task_uuid TEXT,
      task_row_id TEXT,
      client_task_id TEXT,
      occurrence_ms INTEGER,
      status TEXT NOT NULL,
      model TEXT,
      prompt TEXT NOT NULL,
      prompt_controls_json TEXT NOT NULL,
      prompt_modules_json TEXT NOT NULL,
      rounds_json TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      output_text TEXT NOT NULL,
      error TEXT
    )
  `));
  await runD1(db.prepare(`CREATE INDEX IF NOT EXISTS idx_prompt_audit_expires ON ${PROMPT_AUDIT_TABLE} (expires_at)`));
  await runD1(db.prepare(`CREATE INDEX IF NOT EXISTS idx_prompt_audit_created ON ${PROMPT_AUDIT_TABLE} (created_at DESC)`));
};

const deleteExpiredPromptAudits = async (
  env: Pick<Env, 'DB'>,
  cutoff = Date.now(),
): Promise<number> => {
  await ensurePromptAuditSchema(env);
  const result = await runD1(
    getAuditD1(env)
      .prepare(`DELETE FROM ${PROMPT_AUDIT_TABLE} WHERE expires_at <= ?`)
      .bind(cutoff),
  );
  return Number(result.meta?.changes ?? 0);
};

export const recordPromptAudit = async (
  env: Pick<Env, 'DB'>,
  entry: AmsgPromptAuditDraft,
): Promise<void> => {
  await ensurePromptAuditSchema(env);
  await deleteExpiredPromptAudits(env);
  const model = [...entry.rounds].reverse().find((round) => round.model)?.model ?? null;
  await runD1(
    getAuditD1(env)
      .prepare(`
        INSERT INTO ${PROMPT_AUDIT_TABLE} (
          id, created_at, expires_at, char_id, char_name, task_uuid, task_row_id,
          client_task_id, occurrence_ms, status, model, prompt, prompt_controls_json,
          prompt_modules_json, rounds_json, usage_json, output_text, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          created_at = excluded.created_at,
          expires_at = excluded.expires_at,
          char_id = excluded.char_id,
          char_name = excluded.char_name,
          task_uuid = excluded.task_uuid,
          task_row_id = excluded.task_row_id,
          client_task_id = excluded.client_task_id,
          occurrence_ms = excluded.occurrence_ms,
          status = excluded.status,
          model = excluded.model,
          prompt = excluded.prompt,
          prompt_controls_json = excluded.prompt_controls_json,
          prompt_modules_json = excluded.prompt_modules_json,
          rounds_json = excluded.rounds_json,
          usage_json = excluded.usage_json,
          output_text = excluded.output_text,
          error = excluded.error
      `)
      .bind(
        entry.id,
        entry.createdAt,
        entry.expiresAt,
        entry.charId,
        entry.charName,
        entry.taskUuid,
        entry.taskRowId,
        entry.clientTaskId,
        entry.occurrenceMs,
        entry.status,
        model,
        entry.prompt,
        JSON.stringify(entry.promptControls),
        JSON.stringify(entry.promptModules),
        JSON.stringify(entry.rounds),
        JSON.stringify(sumPromptAuditUsage(entry.rounds)),
        entry.outputText,
        entry.error,
      ),
  );
};

type PromptAuditRow = {
  id?: unknown;
  created_at?: unknown;
  expires_at?: unknown;
  char_id?: unknown;
  char_name?: unknown;
  task_uuid?: unknown;
  task_row_id?: unknown;
  client_task_id?: unknown;
  occurrence_ms?: unknown;
  status?: unknown;
  model?: unknown;
  prompt?: unknown;
  prompt_controls_json?: unknown;
  prompt_modules_json?: unknown;
  rounds_json?: unknown;
  usage_json?: unknown;
  output_text?: unknown;
  error?: unknown;
};

const auditRowToEntry = (row: PromptAuditRow) => ({
  id: typeof row.id === 'string' ? row.id : String(row.id ?? ''),
  createdAt: Number(row.created_at ?? 0),
  expiresAt: Number(row.expires_at ?? 0),
  charId: typeof row.char_id === 'string' ? row.char_id : null,
  charName: typeof row.char_name === 'string' ? row.char_name : null,
  taskUuid: typeof row.task_uuid === 'string' ? row.task_uuid : null,
  taskRowId: typeof row.task_row_id === 'string' ? row.task_row_id : null,
  clientTaskId: typeof row.client_task_id === 'string' ? row.client_task_id : null,
  occurrenceMs: typeof row.occurrence_ms === 'number' ? row.occurrence_ms : Number(row.occurrence_ms ?? 0) || null,
  status: typeof row.status === 'string' ? row.status : 'unknown',
  model: typeof row.model === 'string' && row.model ? row.model : null,
  prompt: typeof row.prompt === 'string' ? row.prompt : '',
  promptControls: parseAuditJson<Record<string, unknown>>(row.prompt_controls_json, {}),
  promptModules: parseAuditJson<AmsgPromptAuditModule[]>(row.prompt_modules_json, []),
  rounds: parseAuditJson<AmsgPromptAuditRound[]>(row.rounds_json, []),
  usage: parseAuditJson<Record<string, unknown>>(row.usage_json, {}),
  outputText: typeof row.output_text === 'string' ? row.output_text : '',
  error: typeof row.error === 'string' ? row.error : null,
});

export const listPromptAudit = async (
  env: Pick<Env, 'DB'>,
  limit = PROMPT_AUDIT_DEFAULT_LIMIT,
) => {
  const safeLimit = Math.max(1, Math.min(PROMPT_AUDIT_MAX_LIMIT, Math.floor(limit) || PROMPT_AUDIT_DEFAULT_LIMIT));
  await deleteExpiredPromptAudits(env);
  const rows = await getAuditD1(env)
    .prepare(`
      SELECT id, created_at, expires_at, char_id, char_name, task_uuid, task_row_id,
             client_task_id, occurrence_ms, status, model, prompt, prompt_controls_json,
             prompt_modules_json, rounds_json, usage_json, output_text, error
        FROM ${PROMPT_AUDIT_TABLE}
       ORDER BY created_at DESC
       LIMIT ?
    `)
    .bind(safeLimit)
    .all<PromptAuditRow>();
  return (rows.results ?? []).map(auditRowToEntry);
};

export const clearPromptAudit = async (env: Pick<Env, 'DB'>): Promise<{ deleted: number }> => {
  await ensurePromptAuditSchema(env);
  const result = await runD1(getAuditD1(env).prepare(`DELETE FROM ${PROMPT_AUDIT_TABLE}`));
  return { deleted: Number(result.meta?.changes ?? 0) };
};

/** 两个时间戳取较新的那个；两个都没有为 null。 */
const laterOf = (a: number | null, b: number | null): number | null =>
  (a == null ? b : b == null ? a : Math.max(a, b));

/**
 * 用云端 tool_pack / tool_config 拼 dispatchAgenticTool 要的 ctx。
 *
 * 纯构造：解析与「解析不出来怎么办」都留在 onBeforeFire（它才知道 taskId / charId 这些
 * 报错上下文），这里只管把两份已经验好的数据装成 ctx。
 */
const buildToolCtx = (
  pack: AmsgToolPack,
  config: AmsgToolConfig,
): { toolCtx: AgenticToolCtx; proxyWorkerUrl: string | null; xhsCookie: string } => {
  // AgenticToolChar 就是 agenticTools 真正会读的那几个字段（runRecall / resolveXhsConfig /
  // 日记按角色名查）。用它当类型而不是硬转 CharacterProfile：那边多读一个字段这里就编译不过，
  // 不会等到 worker 到点才拿到 undefined。
  const char: AgenticToolChar = {
    name: pack.charName,
    xhsEnabled: pack.xhsEnabled,
    activeMemoryMonths: pack.activeMemoryMonths,
    memories: pack.memories,
  };

  return {
    toolCtx: {
      char,
      userProfile: {} as UserProfile,
      // AmsgToolConfig 的凭据字段就是 AgenticToolRealtimeConfig，结构化直接满足——
      // 不用逐字段抄一遍再强转，那样 buildToolConfig 加字段这里不会报错。
      realtimeConfig: config,
      // XHS 多步流程（search → detail 的 xsecToken 缓存）在同一次 fire 内共享。
      xhsCaches: {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
      },
      lastXhsNotesRef: { current: [] },
    },
    proxyWorkerUrl: config.proxyWorkerUrl ?? null,
    xhsCookie: config.xhsMcpConfig?.cookie ?? '',
  };
};

/**
 * fire 前置状态不完整时抛这个 —— 不降级。
 *
 * 排程链已经保证「先传云端状态、成功了再建任务」（见 activeMsgClient 的
 * putClientStateOrThrow），所以到点读不到 fire_pack 只有三种可能：云端状态被删了、
 * 数据坏了、任务是开发期的旧格式。都是异常，不是能悄悄降级的正常分支。
 *
 * 为什么抛错而不是 { skip: true }：skip 是「这次故意不发」的出口（防穿帮闸在用），
 * 用它表达「坏了」会把两件事混在一起，而且循环任务会天天静默不响、只有 worker 日志
 * 里看得见。抛错走库的投递失败路径，任务标 failed + 写 last_error，至少留下痕迹。
 *
 * permanent: true 是 amsg-server 2.6.0-next.15 起 isNonRetryableError 认的鸭子契约
 * （与它导出的 NonRetryableError 同效，标属性就不用把根入口整个打进 bundle）：
 * 这批失败全是确定性的状态问题（fire_pack 缺失 / 解析不过 / 缺 chat 段），状态不变
 * 重试三次只是让等回复的用户多白等六分钟，直接终审处置。老版上游不认这个属性，
 * 行为退回「重试 3 次再 failed」，不会更糟。
 */
const fireStateError = (reason: string, detail: Record<string, unknown>): Error => {
  console.error('[amsg:fire-state-missing]', { reason, ...detail });
  const error = new Error(`AMSG2_FIRE_STATE_MISSING: ${reason}`);
  (error as Error & { permanent: boolean }).permanent = true;
  return error;
};

/** 内联思考块的成对标签，跟 stripReasoningTags 认的是同一批。 */
const INLINE_THINK_RE = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/gi;

/**
 * 把正文里内联的思考块抄出来拼成一段（没有就是空串）。
 *
 * 只认闭合的成对标签：抄的范围要跟正文剥掉的范围对得上（stripReasoningTags 主判的就是
 * 成对标签），也跟客户端渲染那份同口径——本地的 extractThinkingChain 只在**全文一个闭合
 * 标签都没有**时才走 open-only 兜底。没闭合的那种照旧交给正文侧兜：sanitize 有自己的
 * 未闭合兜底，整段只有一个没闭合的思考块时这一轮压根不发 push。
 */
const extractInlineThink = (text: string): string => {
  if (!text.includes('<')) return '';
  const blocks: string[] = [];
  for (const match of text.matchAll(INLINE_THINK_RE)) {
    const inner = match[2].trim();
    if (inner) blocks.push(inner);
  }
  return blocks.join('\n\n');
};

/**
 * 思考链太长、一条 push 装不下时的旁路存储键（同 XHS / 情绪评估那套，见
 * amsgXhsSessionKey / amsgEmotionUpdateKey）。push 里只留 `metadata.amsgReasoningRef`
 * 指过来，客户端按键取回、用完即删。每任务固定一份、下次触发覆盖。
 */
export const amsgReasoningKey = (clientTaskId: string) => `reasoning:${clientTaskId}`;

// 体积判定按「库补完信封字段之后」的尺寸算：hook 交还 payload 之后，库还会补
// messageId / sessionId / timestamp / messageIndex / totalMessages 和四个任务身份
// 字段。卡着上限判的话，量出来「刚好装得下」的那一档补完就超了——既没走旁路存储、
// 也发不出去，整条消息丢掉，而且每次重试都卡在同一处。余量由库导出
// （PUSH_ENVELOPE_RESERVED_BYTES），跟着它自己补的字段走，不用这边手猜。

/** 这一份 payload 现在装得下吗（按库补完信封字段之后的尺寸算）。 */
const pushFits = (payload: Record<string, unknown>): boolean =>
  measurePushPayload(JSON.stringify(payload), { reserveEnvelope: true }).withinLimit;

/** 旁路存储的一棒：metadata 上的哪个字段整份挪走、挪完留哪个引用键、存到哪个键下。 */
interface OffloadBaton {
  /** metadata 上要挪走的字段名。 */
  field: string;
  /** 挪完留在 metadata 上的引用键字段名，客户端照着它取回。 */
  refField: string;
  /** client_state 里的存储键（每任务一份，下次触发覆盖）。 */
  key: (clientTaskId: string) => string;
  /** 日志前缀，`wrangler tail` 上一眼看出是哪一棒挪的。 */
  log: string;
}

/**
 * 挪的顺序：思考链 → 情绪评估结果 → XHS 会话数据。
 *
 * 前两样都是整段模型输出（几百到几千字），超限时多半是它俩撑爆的，而且客户端拿它们
 * 只是渲染卡片 / 落 buff，晚一步取回来不影响这条消息本身；XHS 那份关系到这条消息里的
 * 卡片能不能出来，所以排最后，挪完还是装不下才动它。
 */
const OFFLOAD_BATONS: OffloadBaton[] = [
  {
    field: 'amsgReasoning',
    refField: 'amsgReasoningRef',
    key: amsgReasoningKey,
    log: '[amsg:reasoning] 思考链旁路存储',
  },
  {
    field: 'amsgEmotionUpdate',
    refField: 'amsgEmotionRef',
    key: amsgEmotionUpdateKey,
    log: '[amsg:emotion] 评估结果旁路存储',
  },
  {
    field: 'xhsSession',
    refField: 'xhsSessionRef',
    key: amsgXhsSessionKey,
    log: '[amsg:agentic] XHS 会话数据旁路存储',
  },
];

/**
 * 一条 push 装不下时，把大块附加数据旁路存进 client_state，payload 里只留引用键。
 *
 * Web Push 的 payload 上限是 4096 字节密文（明文 3993，见 measurePushPayload），
 * 一张笔记连标题带摘要就六七百字节。过去的做法是硬砍到 4 张，于是角色说「分享了 6 张」
 * 而只出来 4 张卡——话和内容对不上，一眼假。现在改成按真实字节算：装得下就照装
 * （日常 1-3 张走的就是这条，行为不变），装不下才把整份挪到 client_state，
 * 客户端上线后按引用键取回，一张不少。
 *
 * 挪哪几样、按什么顺序挪见 OFFLOAD_BATONS。
 *
 * 存不进去时**抛错**而不是砍内容：抛错走投递失败重试，砍内容则是当场穿帮且无从察觉。
 */
export const offloadOversizedPush = async (
  payload: Record<string, unknown>,
  writeState: WriteState | undefined,
  charId: string,
  clientTaskId: string,
): Promise<Record<string, unknown>> => {
  if (pushFits(payload)) return payload;

  if (!clientTaskId) {
    // 存储键是按 clientTaskId 编的，没有它就没法旁路。两条建任务路径和角色自排那条
    // 都必带 amsgClientTaskId，走到这里说明任务行是坏的——接下来库会抛
    // PUSH_PAYLOAD_TOO_LARGE 把整条消息卡住，光看那个错认不出根因，先吼一声。
    console.warn('[amsg:offload] push 超限却没有 clientTaskId，旁路存储用不上', {
      charId,
      bytes: measurePushPayload(JSON.stringify(payload)).bytes,
    });
    return payload;
  }

  const hasOffloadable = (value: unknown): boolean =>
    (typeof value === 'string' ? !!value : value != null);
  const readMeta = (p: Record<string, unknown>) => (p.metadata ?? {}) as Record<string, unknown>;

  // 没有可旁路的东西，交给库抛 PUSH_PAYLOAD_TOO_LARGE
  if (!OFFLOAD_BATONS.some((baton) => hasOffloadable(readMeta(payload)[baton.field]))) return payload;

  if (typeof writeState !== 'function') {
    // 老部署（amsg-server < 2.6.0-next.7）没有写入口。不静默砍卡片——抛错让这次投递
    // 失败重试，设置页的版本门槛会提示用户重新粘贴部署。
    throw new Error('AMSG2_WRITE_STATE_UNSUPPORTED: push 超限需要旁路存储，请在设置页重新粘贴部署 worker');
  }

  // 一棒接一棒：每棒都从**上一棒的结果**上读，装得下了就收手。各挪各的字段，
  // 从原始 payload 重新起算的话，前一棒挪走的会被原样塞回去、引用键也丢。
  let current = payload;
  for (const baton of OFFLOAD_BATONS) {
    const meta = readMeta(current);
    const value = meta[baton.field];
    if (!hasOffloadable(value)) continue;

    const key = baton.key(clientTaskId);
    // 字符串原样存（客户端取回来直接用），对象序列化一份。
    await writeState(amsgStateNamespace(charId), [
      { key, value: typeof value === 'string' ? value : JSON.stringify(value) },
    ]);
    const { [baton.field]: _moved, ...restMeta } = meta;
    const slimmed = { ...current, metadata: { ...restMeta, [baton.refField]: key } };
    console.log(baton.log, {
      key,
      charId,
      beforeBytes: measurePushPayload(JSON.stringify(current)).bytes,
      afterBytes: measurePushPayload(JSON.stringify(slimmed)).bytes,
    });
    current = slimmed;
    if (pushFits(current)) return current;
  }
  return current;
};

/**
 * 防穿帮闸跳过一次触发时，留一句「为什么没响」给客户端。
 *
 * 闸是静默工作的：判定该让路就直接跳过，一条 push 都不发，而远端那行任务两种情况下
 * （真发出去了 / 被闸拦下）都会被消费掉。客户端事后看到的一模一样，用户只会觉得
 * 「说好的消息呢」。留一条记录，面板就能照实说明。
 *
 * best-effort：写不进去不能连累这次 skip 本身——闸该拦还是要拦，少一句解释而已。
 */
const writeLastSkip = async (
  writeState: WriteState | undefined,
  charId: string,
  skip: AmsgLastSkip,
): Promise<void> => {
  if (typeof writeState !== 'function') return;
  try {
    await writeState(amsgStateNamespace(charId), [
      { key: AMSG_LAST_SKIP_KEY, value: JSON.stringify(skip) },
    ]);
  } catch (error) {
    console.warn('[amsg:skip] 跳过原因写入失败（跳过本身照常生效，只是面板少一句说明）', error);
  }
};

const recordSkip = async (
  ctx: FireCtx,
  charId: string,
  reason: AmsgLastSkip['reason'],
  occurrenceMs: number,
): Promise<void> =>
  writeLastSkip(ctx.writeState, charId, {
    v: 1,
    taskUuid: typeof ctx.task.uuid === 'string' ? ctx.task.uuid : null,
    occurrenceMs,
    reason,
    skippedAt: ctx.now.getTime(),
  });

// ─── self_log 的发送后回写（⑥）───
//
// 过去 recordSelfLog 在 onLLMOutput 里、推送发出**之前**调用——LLM 成功但推送全挂时
// 云端记了「说过」而用户一个字没收到，下次 fire 角色会接着一句不存在的话往下说。
// 现在改成：onLLMOutput 只把各段正文挂在本次 fire 的 scratch 上，等库发完（或发挂）
// 之后调 config 级 hook onAfterSend，只把**前 sentCount 段**写进 self_log，entry.at
// 用实际发送时刻。sentCount=0（一段都没出去）不写——重试的下一条 fire 会重新生成。
//
// scratch 是这一次 fire 独有的对象，onBeforeFire / onLLMOutput / onAfterSend 拿到的
// 是同一个引用，所以并发的几个 fire 天然互不串台，也不需要按任务行 id 自建登记表。

/**
 * 一次 fire 收尾时把云端自述日志落盘（config 级 hook onFireSettled，见 buildWorkerConfig）。
 *
 * 挂在 onFireSettled 而不是 onAfterSend 上，因为后者只在「真发出去了」那条路被调用：
 * skip-push（这轮只做了副作用 / 空生成）、防穿帮闸 skip、中途抛错三条路都不调。而角色
 * 用工具给自己排的任务在 ctx.scheduleTask 那一刻就已经建进 D1 了——账没落下来的话，
 * 客户端认领不到、面板看不见、用户取消不掉，它却会一直按时发下去。
 *
 * 正文只在真送出去时才记：sentCount 是「实际送达几段」，部分失败时后面几段用户没收到，
 * 记进去下一次角色就会以为自己说过。
 *
 * entry.at 用实际发送时刻（不是名义 occurrenceMs）：日志给角色读的是「我几点几分真的
 * 说了这句」，cron 延迟半小时时名义时刻是句谎话。id 仍是 `clientTaskId@occurrenceMs`
 * ——去重语义（同一次触发重跑同 id 覆盖）靠它，不动。
 *
 * best-effort：写不进去不能连累投递结果，但下一次到点角色就不知道自己说过这句，要吼一声。
 */
/**
 * chat_fail 留痕的统一出口（即时对话失败原因，客户端 60s 点名判到行已出清后读回）。
 * 三个写入点共用：fire 收尾（amsgFireSettled）、过期跳过（amsgStaleSkip）、以及
 * onBeforeFire 抛错那一刻（fail 的副作用——最典型的失败都发生在挂 stash 之前，
 * 只靠收尾那份的话这些路径一条痕都留不下）。每次覆盖写，最终留下最后一跳的原因。
 * best-effort：写不进去只是失败原因退化成笼统一句，绝不连累调用方。
 */
const writeChatFail = async (
  writeState: WriteState,
  charId: string,
  record: { uuid: string; reason: string; retryCount: number },
): Promise<void> => {
  const full: AmsgChatFailRecord = {
    v: 1,
    uuid: record.uuid,
    reason: record.reason.slice(0, 500),
    retryCount: record.retryCount,
    at: Date.now(),
  };
  try {
    await writeState(amsgStateNamespace(charId), [
      { key: AMSG_CHAT_FAIL_KEY, value: JSON.stringify(full) },
    ]);
  } catch (error) {
    console.warn('[amsg:instant-chat] 失败留痕写不进去（客户端只能报笼统原因）', error);
  }
};

/**
 * 即时对话终态失败直发 error push 用到的三样：推送 transport、D1、master key。
 * buildWorkerConfig 每次组装配置时写入（isolate 级全局，同代理地址 / XHS cookie 的先例：
 * 单用户部署里全局同一份才安全）。没配齐时直发整个跳过，失败告知退回 60s 点名兜底。
 */
interface InstantErrorPushDeps {
  webpush: { sendNotification: (subscription: unknown, body: string) => Promise<unknown> };
  db: { prepare: (sql: string) => { bind: (...args: unknown[]) => { first: () => Promise<Record<string, unknown> | null> }; first: () => Promise<Record<string, unknown> | null> } };
  masterKey: string;
}
let instantErrorPushDeps: InstantErrorPushDeps | null = null;

/** buildWorkerConfig 的写入口；export 只为单测注入假 transport / 假库。 */
export const configureInstantErrorPush = (deps: InstantErrorPushDeps | null): void => {
  instantErrorPushDeps = deps;
};

/** 通知横幅上那句话（简短人话）；聊天流里的详细说明由客户端 describeInstantChatFailure 出。 */
const instantErrorNotificationBody = (reason: string): string => {
  if (reason === 'empty-generation') return '模型这一轮没有生成内容，可以重新发一次。';
  if (reason === 'side-effects-only') return '角色这一轮只做了动作，没有文字回复。';
  if (reason === 'stale') return '这条消息在云端排队太久，已作废。可以重新发一次。';
  return '这一轮云端生成失败了，点开查看原因，可以重新发一次。';
};

/**
 * 即时对话的**终态**失败直发一条 `messageKind:'error'` 的 push（best-effort）。
 *
 * 只许在「这条任务不会再跑」的场合调：重试打光（retry_count 判定与上游
 * handleDeliveryFailure 同源）、skip-push（行被当成功消费）、stale 跳过。还会重试的
 * 失败绝不发——「报错完回复又到了」这种误报比晚知道更伤（SSE↔push 双通道的老教训）。
 *
 * 通知打 `show: 'when-hidden'`：前台由页面监听 active-msg-error 当场收尾（落系统消息、
 * 熄灯），不弹横幅；后台弹「回复没能生成」。发不出去只 warn——客户端 60s 点名读
 * chat_fail 的兜底路径原样保留，这条 push 只是把感知从分钟级提到秒级。
 *
 * 订阅行是加密存的（encryptForStorage 的 iv:authTag:data 格式）；个别老部署可能存的是
 * 明文 JSON，解密失败时按明文再试一次，都不行才放弃。
 */
const sendInstantErrorPush = async (args: {
  charId: string;
  taskUuid: string;
  reason: string;
  /** 任务行上的 user_id；拿不到时取订阅表唯一那行（单用户部署）。 */
  userId?: string | null;
  contactName?: string | null;
}): Promise<void> => {
  const deps = instantErrorPushDeps;
  if (!deps?.masterKey) return;
  try {
    const row = args.userId
      ? await deps.db.prepare('SELECT user_id, subscription FROM push_subscriptions WHERE user_id = ? LIMIT 1').bind(args.userId).first()
      : await deps.db.prepare('SELECT user_id, subscription FROM push_subscriptions LIMIT 1').first();
    const stored = row?.subscription;
    const userId = row?.user_id;
    if (typeof stored !== 'string' || !stored || typeof userId !== 'string' || !userId) return;
    let subscription: unknown;
    try {
      const userKey = await deriveUserEncryptionKey(userId, deps.masterKey);
      subscription = JSON.parse(await decryptFromStorage(stored, userKey));
    } catch {
      subscription = JSON.parse(stored);
    }
    const payload = {
      messageKind: 'error',
      messageType: 'instant',
      charId: args.charId,
      contactName: args.contactName ?? undefined,
      // 确定性 id：同一条任务的终态只有一个，重复投递靠 SW 的 messageId 去重兜住
      messageId: `err_${args.taskUuid}`,
      timestamp: new Date().toISOString(),
      metadata: {
        charId: args.charId,
        amsgInstantError: true,
        taskUuid: args.taskUuid,
        reason: args.reason.slice(0, 500),
      },
      notification: {
        title: args.contactName ? `${args.contactName} 的回复没能生成` : '回复没能生成',
        body: instantErrorNotificationBody(args.reason),
        show: 'when-hidden',
      },
    };
    await deps.webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (error) {
    console.warn('[amsg:instant-chat] 失败通知没发出去（客户端仍靠 60s 点名兜底）', error);
  }
};

export const amsgFireSettled = async (
  info: {
    /** sent / skipped / failed / not-handled；区分「有没有真发出去」和「这跳挂了」。 */
    status?: string;
    sentCount?: number;
    /** D1 任务行原样（上游 notifyFireSettled 透传；retry_count 是明文列）。 */
    task?: { retry_count?: unknown } | null;
    /** 这一跳抛出的错误（status 'failed' 时才有）。 */
    error?: unknown;
    scratch: Record<string, unknown>;
    writeState: WriteState;
    env?: Pick<Env, 'DB'>;
  },
): Promise<void> => {
  const stash = getFireStash(info.scratch);
  if (!stash) return;   // onBeforeFire 没走到挂 stash 那步（比如取 fire_pack 就失败了）

  // 即时对话这一跳挂了 → 失败原因留痕（chat_fail），每次失败尝试覆盖写，最终留下的
  // 就是最后一跳的原因。客户端 60s 点名判到「行已出清」后一次点名读回这份，向用户
  // 交代为什么没发出去——不用再按角色扫全量任务列表逐条解密（几秒起步）。
  // best-effort：写不进去只是失败原因退化成笼统的一句，不能连累收尾其他动作。
  if (stash.instant && info.status === 'failed' && stash.taskUuid) {
    const failReason = info.error instanceof Error ? info.error.message : String(info.error ?? '未知错误');
    const retryCount = typeof info.task?.retry_count === 'number' ? info.task.retry_count : 0;
    await writeChatFail(info.writeState, stash.charId, {
      uuid: stash.taskUuid,
      reason: failReason,
      retryCount,
    });
    // 终态判定与上游同源，两种都算：retry_count >= 3 的这跳失败后行转 failed
    // （handleDeliveryFailure 的梯子打光）；permanent 标记的错误（fireStateError 那族）
    // 上游一跳就终审。info.error 就是 fire 里抛出的那个对象，permanent 属性原样带过来
    // ——挂上 stash 之后才炸出的 permanent 只有这里看得到（挂 stash 之前的那族由
    // onBeforeFire 的 fail() 直发，那时没有 stash、走不到这里，两条机制天然互斥）。
    // 还会重试的失败绝不发通知（回复可能随后就到）。
    const permanent = info.error instanceof Error
      && (info.error as Error & { permanent?: boolean }).permanent === true;
    if (retryCount >= 3 || permanent) {
      await sendInstantErrorPush({
        charId: stash.charId,
        taskUuid: stash.taskUuid,
        reason: failReason,
        userId: typeof (info.task as Record<string, unknown> | null | undefined)?.user_id === 'string'
          ? (info.task as Record<string, unknown>).user_id as string
          : null,
      });
    } else if (stash.emotionEvalPromise && stash.clientTaskId) {
      // 还会重试的失败：这一跳的情绪评估结果写进旁路键留给下一跳——重试会整轮重跑
      // onBeforeFire，读到这份就不再白烧一次副 API（见那边的复用逻辑）。等待有界：
      // 只等搭车窗口那么久，评估还没跑完就算了，下一跳重新评估。
      try {
        const outcome = await raceEmotionEval(
          stash.emotionEvalPromise, '评估没赶上这跳收尾，重试那轮只好重新评估');
        if (outcome?.raw) {
          await info.writeState(amsgStateNamespace(stash.charId), [
            { key: amsgEmotionUpdateKey(stash.clientTaskId), value: outcome.raw },
          ]);
        }
      } catch (error) {
        console.warn('[amsg:emotion] 重试前留不下评估结果（下一跳会重新评估）', error);
      }
    }
  }

  // 情绪评估没赶上顺风车、回复已经先发出去了 → 在这里等它出结果，写进旁路存储
  // （push 上已挂引用键 + pending 标记，客户端对着键轮询补落）。上游 await 这个 hook，
  // 评估自带 EMOTION_EVAL_TIMEOUT_MS，续等是有界的。只在真送出去过（sentCount > 0）
  // 时等：一段都没出去的话客户端根本没收到 pending 标记，任务还会整轮重跑。
  // 评估失败或超时什么都不写——旁路只存 applyEmotionEvalRaw 认识的评估原文，
  // 客户端轮询到点自会按「最终没等到」收尾。
  if (stash.instant && stash.emotionLatePending && stash.emotionEvalPromise
      && stash.clientTaskId && (info.sentCount ?? 0) > 0) {
    stash.emotionLatePending = false;   // 认领掉，重复调用不会写两遍
    try {
      const outcome = await stash.emotionEvalPromise;
      if (outcome.raw) {
        await info.writeState(amsgStateNamespace(stash.charId), [
          { key: amsgEmotionUpdateKey(stash.clientTaskId), value: outcome.raw },
        ]);
      } else {
        console.warn('[amsg:emotion] 晚投评估没跑出结果（这一轮情绪不更新）', outcome.error);
      }
    } catch (error) {
      console.warn('[amsg:emotion] 晚投评估收尾失败（这一轮情绪不更新）', error);
    }
  }

  const texts = stash.selfLogTexts;
  stash.selfLogTexts = null;   // 认领掉，重复调用不会记两遍
  const sentCount = info.sentCount ?? 0;
  const audit = stash.promptAudit;
  if (audit) {
    audit.status = info.status || (sentCount > 0 ? 'sent' : 'settled');
    if (info.error) {
      audit.error = info.error instanceof Error ? info.error.message : String(info.error);
    }
    const deliveredText = texts
      ?.slice(0, sentCount)
      .filter((message) => message.trim())
      .join('\n')
      .trim();
    if (deliveredText) audit.outputText = deliveredText;
    stash.promptAudit = null;
    if (!info.env) {
      console.warn('[amsg:prompt-audit] missing env, audit not recorded');
    } else {
      try {
        await recordPromptAudit(info.env, audit);
      } catch (error) {
        console.warn('[amsg:prompt-audit] write failed', error);
      }
    }
  }
  if (texts && sentCount > 0) {
    // 多段消息在用户那边是连着的几条气泡，对角色而言是一次「我说了这些」，合成一条记。
    // 只取前 sentCount 段：部分失败时没送出去的正文绝不能进日志。
    const text = texts
      .slice(0, sentCount)
      .filter((message) => message.trim())
      .join('\n');
    const next = appendSelfLogEntry(stash.selfLog, {
      id: `${stash.clientTaskId || 'task'}@${stash.occurrenceMs}`,
      at: Date.now(),
      text,
      // 即时对话是在答用户刚说的话——列进自述块保持连续性，但不占「主动连发」的额度
      // （带这个标记的条目不会让 selfLog.unansweredSends 加一）。
      ...(stash.instant ? { reply: true } : {}),
    });
    // 整段只有副作用标签（正文为空）时 append 原样返回——没有话可记。
    if (next !== stash.selfLog) {
      stash.selfLog = next;
      stash.selfLogDirty = true;
    }
  }

  if (!stash.selfLogDirty) return;   // 这次 fire 什么也没添进日志，不必写库
  stash.selfLogDirty = false;

  try {
    await info.writeState(amsgStateNamespace(stash.charId), [
      { key: AMSG_SELF_LOG_KEY, value: JSON.stringify(stash.selfLog) },
    ]);
  } catch (error) {
    console.warn('[amsg:self-log] 写入失败（这次照常发送，但下一次到点角色不会知道说过这句）', error);
  }
};

// ─── stale 守卫的消费端（⑥）───
//
// 上游 run-tick 的补发新鲜度守卫：任务错过触发时刻太久（服务停摆后恢复）不再补发，
// 并调 config 级 hook onStaleSkip(task, info)。不接这个 hook 的话，用户看到的就是
// 「说好的消息凭空消失」——这里把它写成 last_skip，面板照实说明。
//
// info.action 分两种，面板文案也分两种：
//   expired        一次性任务，行已标 failed，这一次永远不会补发了
//   fast_forwarded 循环任务，攒下的这几次都跳过，排期已快进到 nextSendAt，下次照常
// 混为一谈的话，每日提醒断更一天会被说成「已经彻底没了」。
//
// task 是 D1 任务行原样，charId 在 encrypted_payload 里解不开：上游把解密后的
// payload.metadata 递进 info（只透传 metadata，凭据不外漏），charId 从那里取。两条
// 排程路径（客户端排 / 角色自排）建任务时都写了 metadata.charId，取不到就是真异常，
// 只能放弃留痕。写口由 info 直接给，不用攒——攒下来的那份在 isolate 冷启动后的第一
// 跳是空的，而「服务停摆恢复」正是这个 hook 最该留痕的时候。

/** config 级 stale 回执 hook（见 buildWorkerConfig）。export 只为单测。 */
export const amsgStaleSkip = async (
  task: { id?: unknown; uuid?: unknown } | null | undefined,
  info: {
    reason: string;
    action: 'expired' | 'fast_forwarded';
    metadata: unknown;
    occurrenceMs: number | null;
    skippedCount: number;
    nextSendAt: string | null;
    writeState: WriteState;
  },
): Promise<void> => {
  const meta = (info.metadata ?? {}) as Record<string, unknown>;
  const charId = typeof meta.charId === 'string' && meta.charId ? meta.charId : null;
  if (!charId) {
    console.warn('[amsg:stale-skip] 任务 metadata 缺 charId，这次过期跳过没法留痕', { taskId: task?.id ?? null });
    return;
  }
  // 被过期跳过的是即时对话（服务停摆恢复时可能发生）→ 也写一份 chat_fail：
  // 客户端点名判到「行已出清」后靠它说出「排队太久没轮到」，而不是笼统的生成失败。
  if (isInstantChatTask(meta) && typeof task?.uuid === 'string' && task.uuid) {
    await writeChatFail(info.writeState, charId, { uuid: task.uuid, reason: 'stale', retryCount: 0 });
    // 过期跳过也是一锤定音 → 直发失败通知（best-effort），别让用户干等点名。
    await sendInstantErrorPush({ charId, taskUuid: task.uuid, reason: 'stale' });
  }
  const nextSendAtMs = Date.parse(String(info.nextSendAt ?? ''));
  await writeLastSkip(info.writeState, charId, {
    v: 1,
    taskUuid: typeof task?.uuid === 'string' ? task.uuid : null,
    // 名义触发时刻由上游给——它知道被跳过的是哪一次。任务行上的 next_send_at 在循环
    // 任务快进之后已经是「下一次」了，拿它当被跳过的时刻会差出一整轮。
    occurrenceMs: info.occurrenceMs ?? Date.now(),
    reason: 'stale',
    skippedAt: Date.now(),
    staleAction: info.action,
    skippedCount: info.skippedCount,
    nextSendAtMs: Number.isFinite(nextSendAtMs) ? nextSendAtMs : null,
  });
};

/**
 * 把角色这次给自己排下的任务挂到最后一条 push 上，客户端收到时补进本地清单。
 *
 * 为什么要带回去：任务是在 D1 里建的，客户端那份清单并不知道它存在——面板不显示、
 * 用户想取消也找不到。任务本身照常触发（这正是自排的意义：不依赖客户端在线），
 * 客户端上线认领只是把账对上。
 *
 * 挂在**最后一条**：与 directives 同一个位置，收侧的 isLastChunk 守卫保证只重放一次。
 * 一条 push 都没有（整段被判空）时原样返回——那种情况下这次本来也没东西发出去。
 */
export const attachScheduledTasks = (
  pushPayloads: Array<Record<string, unknown>>,
  tasks: ActiveMsg2TaskRecord[],
): Array<Record<string, unknown>> => {
  if (tasks.length === 0 || pushPayloads.length === 0) return pushPayloads;
  const lastIdx = pushPayloads.length - 1;
  return pushPayloads.map((payload, i) => (i === lastIdx
    ? {
      ...payload,
      metadata: { ...(payload.metadata as Record<string, unknown> ?? {}), amsgSelfScheduled: tasks },
    }
    : payload));
};

/** 会真动 D1 任务行的那三个工具（其余都是查东西的）。 */
const TASK_MUTATING_TOOLS = new Set<string>([
  AMSG_FIRE_SCHEDULE_TOOL, AMSG_FIRE_CANCEL_TOOL, AMSG_FIRE_RENEW_TOOL,
]);

/**
 * 一次工具调用值不值得记进工具痕迹（用来填 ToolCallRecord.ran）。两族问的问题不一样：
 *
 * - 查东西的（recall / 搜索 / 日记 / MCP…）问「有没有真去查」：跑起来了就算，
 *   查了没查到照算——角色说「我翻了下没找到」是实话。压根没跑起来的（没配 key、
 *   连不上、服务器没开机）不算，那一族由 neverRan 认。
 * - 改排程的（schedule / cancel / renew）问「有没有真改成」：`ok:false` 一律不算。
 *   它们的打回码（unanswered_limit、task_not_found、ambiguous_task、cancel_failed…）
 *   都不在 neverRan 的集合里，照 neverRan 判就成了「跑起来了」——于是取消失败的那次
 *   也会在气泡底下写一行「调用了工具：取消排好的消息」，用户据此以为排程没了，而任务
 *   原封不动到点照响。这行灰字本来就是防穿帮的，不能自己造一个。
 *
 * 形状认不出来（不是对象）时按「算」处理，与 neverRan 的兜底同口径。
 */
const toolDidSomething = (name: string, result: unknown): boolean => {
  if (!result || typeof result !== 'object') return true;
  if (TASK_MUTATING_TOOLS.has(name)) return (result as { ok?: unknown }).ok !== false;
  return !neverRan(result);
};

/**
 * 这一轮在云端**真做成事**的工具，按第一次出现的顺序压成 `[{ name, count }]`。
 *
 * 只留原始工具名和次数：参数和结果都不带（那些是角色的内心活动，摊给用户看反而出戏），
 * 翻译成人话也不在这儿——那是显示的事，归客户端（见 utils/amsgToolTrace.ts）。
 *
 * 哪些算「做成了」见 toolDidSomething：查东西的看有没有真去查，改排程的看有没有真改成。
 */
const condenseToolTrace = (
  calls: ReadonlyArray<ToolCallRecord>,
): Array<{ name: string; count: number }> => {
  const counts = new Map<string, number>();
  for (const call of calls) {
    if (call.ran === false) continue;
    counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }));
};

/** 旁路也用不上（任务行没有 clientTaskId）时给用户看的一句话（跟着 amsgEmotionDone 回去）。 */
const EMOTION_EVAL_LATE_REASON = '情绪评估没赶上这条回复（副 API 太慢），这一轮先不更新';

/** 等评估结果，最多等 EMOTION_EVAL_RIDE_ALONG_MS；没赶上返回 null，回复照发。 */
const raceEmotionEval = (
  promise: Promise<AmsgEmotionEvalOutcome>,
  lateNote = '评估没赶上这条回复，先把话发出去（这一轮不更新情绪）',
): Promise<AmsgEmotionEvalOutcome | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[amsg:emotion] ${lateNote}`);
      resolve(null);
    }, EMOTION_EVAL_RIDE_ALONG_MS);
  });
  return Promise.race([promise, late])
    .finally(() => { if (timer !== undefined) clearTimeout(timer); });
};

/**
 * 执行一次「给自己排下一条」。永不抛错——参数写歪、排满了都以 ok:false 回喂让模型改口，
 * 跟别的工具一个语义（fire 抛错 = 整条任务重跑 = 用户这次一个字都收不到）。
 *
 * 幂等：任务 uuid 由「本次触发 + 第几条」推出来，fire 重跑时上游认出撞车、回 created:false，
 * 不会每重试一次多排一条。
 */
export const runFireScheduleTool = async (
  stash: FireStash,
  scheduleTask: ScheduleTask | undefined,
  args: Record<string, unknown>,
  nowMs: number,
): Promise<Record<string, unknown>> => {
  if (typeof scheduleTask !== 'function') {
    // 老 worker 部署（amsg-server < 2.6.0-next.9）没有这个口子。设置页的版本门槛会提示
    // 重新粘贴，这里只需要让角色别以为排上了。
    return { ok: false, reason: 'not_supported', message: '当前后台版本还不支持给自己排后续，这次就把话说完吧。' };
  }
  // 连发上限·排程闸（用户主权）：已发的 + 先前排了还没响的 + 这次已排的，加上这条会超
  // 就打回。到点兜底闸（onBeforeFire）是它的另一半——先排满再触发的在那边拦。
  // 本轮成功取消的、原本计入快照的任务把额度还回来：提示词教的「cancel + 重排」
  //（renew 循环任务补当次走的也是这条）在同一次 fire 内额度中性。只抵扣快照里的
  // ——本轮刚排又反悔的不在快照里，它的额度已随 scheduledTasks 回缩，不重复退。
  const unansweredLimit = stash.maxUnansweredSends;
  const refundedSends = stash.cancelledTasks
    .filter((uuid) => stash.plannedSelfSendUuids.includes(uuid)).length;
  const committedSends = countUnansweredSends(stash.selfLog)
    + stash.plannedSelfSends - refundedSends + stash.scheduledTasks.length;
  if (committedSends + 1 > unansweredLimit) {
    return {
      ok: false,
      reason: 'unanswered_limit',
      message: `对方还没回复，这期间你已经发了/排了 ${committedSends} 条，用户设置的连发上限是 ${unansweredLimit} 条——这次别排了，等 ta 回复再说。`,
    };
  }
  if (stash.scheduledTasks.length >= MAX_FIRE_SCHEDULES) {
    return {
      ok: false,
      reason: 'fire_limit',
      message: `这次已经排了 ${MAX_FIRE_SCHEDULES} 条，够了，剩下的话直接写进这条消息里。`,
    };
  }
  const live = stash.pendingTaskCount + stash.scheduledTasks.length;
  if (live >= MAX_ACTIVE_TASKS_PER_CHAR) {
    return {
      ok: false,
      reason: 'task_limit',
      message: `你同时挂着的任务已经有 ${live} 个（上限 ${MAX_ACTIVE_TASKS_PER_CHAR}），这次别再排了。`,
    };
  }

  // 裸 send_at 按角色的时间参照系解析（③）：角色在 prompt 里看到的钟是它自己时区的，
  // worker 跑在 UTC，不带 tz 的话「明早 9 点」会整整差一个时差。
  const parsed = parseFireScheduleArgs(args, nowMs, stash.tz);
  if ('ok' in parsed) return parsed as unknown as Record<string, unknown>;

  // 同一次触发内第几条 —— 连同触发时刻构成确定性 uuid，重跑对得上。序号只增不减
  // （selfScheduleSeq，见字段注释）：取不得 scheduledTasks.length，取消会让它回缩，
  // 「排→取消→再排」就会撞上还活着那条的 uuid。
  // uuid 开头那 8 位摘要正是排程清单里印给角色看的短 id，同一次 fire 排下的两条
  // 必须印得不一样（见 buildSelfScheduleUuid）。
  const seq = stash.selfScheduleSeq;
  const uuid = buildSelfScheduleUuid(stash.charId, stash.occurrenceMs, seq);
  const clientTaskId = `${uuid}-c`;

  let result;
  try {
    result = await scheduleTask({
      firstSendTime: parsed.sendAt,
      recurrenceType: parsed.recurrence,
      messageType: parsed.mode,
      uuid,
      // 角色自排的循环任务也按角色所在时区的墙钟推进，跟用户在面板排的同一套。
      tzId: stash.tz.tzId,
      metadata: {
        charId: stash.charId,
        source: 'active_msg_2',
        amsgMode: parsed.mode,
        amsgClientTaskId: clientTaskId,
        amsgExpirePolicy: parsed.expirePolicy,
        // 防穿帮闸锚点：这条排下去之后，用户再开口就算「对话往前走了」。
        amsgAnchorMs: stash.anchorMs,
        amsgTaskInstruction: buildTaskInstruction(parsed.mode, parsed.promptHint),
        // 自排标记：到点兜底闸只拦带它的任务（用户面板排的不受连发上限管）。
        amsgSelfScheduled: true,
      },
    });
  } catch (error) {
    // 上游的护栏（时间太近、类型不对、超上限）都抛错。转成回喂，让模型换个时间再试。
    return {
      ok: false,
      reason: 'schedule_rejected',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // 这个序号已经打到远端了（created 和撞车都算），下一条换新号。打回/抛错（上面已
  // return）不消号：重跑时同样在那一步被打回，序号推进保持确定性。
  stash.selfScheduleSeq += 1;

  // 撞车 = 这一条在上一次重跑里已经建过了（投递失败重试会重跑整个 fire）。任务确实在
  // D1 里排着，但这一轮要是什么账都不记，它就只活在 D1 里：随 push 带不回客户端、面板
  // 看不到、用户也取消不掉。以远端那一行为准记账——这一轮模型给的时间未必和第一次一样，
  // 而真正会响的是第一次写进去的那个。
  const remote = result.created ? null : result.task;
  const sendAt = remote?.nextSendAt || parsed.sendAt;
  const record: ActiveMsg2TaskRecord = {
    taskUuid: result.uuid,
    clientTaskId: remote?.clientTaskId || clientTaskId,
    mode: (remote?.messageType as ActiveMsg2TaskRecord['mode']) || parsed.mode,
    firstSendTime: sendAt,
    recurrenceType: (remote?.recurrenceType as ActiveMsg2TaskRecord['recurrenceType'])
      || parsed.recurrence,
    ...(parsed.promptHint ? { promptHint: parsed.promptHint } : {}),
    expirePolicy: parsed.expirePolicy,
    anchorLastUserMsgAt: stash.anchorMs,
    source: 'character',
    status: 'scheduled',
    createdAt: nowMs,
  };

  // 幂等：同一轮里两次调到同一个 uuid 不重复记账。
  if (!stash.scheduledTasks.some((t) => t.taskUuid === record.taskUuid)) {
    stash.scheduledTasks.push(record);
    stash.selfLog = appendSelfLogTask(stash.selfLog, record);
    stash.selfLogDirty = true;
  }
  console.log('[amsg:self-schedule]', {
    uuid: result.uuid,
    sendAt,
    mode: record.mode,
    duplicate: !result.created,
  });

  if (!result.created) {
    // 对模型来说结果一样：那条确实排上了。时间报远端的真实值，别报它这次想改成的。
    return { ok: true, already_scheduled: true, send_at: sendAt };
  }

  return {
    ok: true,
    task_id: shortTaskId(result.uuid),
    send_at: sendAt,
    message: '排好了。到点你会知道自己这次说了什么，接着说就行，现在不用剧透。',
  };
};

/**
 * 取消 / 改期工具按短 id 找目标时的活任务视图：开场清单 + 本轮新排的，
 * 刨掉本轮已经取消的。不含当前正在 fire 的这条（它的收尾归 run-tick 管）。
 */
const liveTaskView = (stash: FireStash): ActiveMsg2TaskRecord[] => {
  const cancelled = new Set(stash.cancelledTasks);
  return [...stash.pendingTasks, ...stash.scheduledTasks]
    .filter((t) => !cancelled.has(t.taskUuid) && t.taskUuid !== stash.taskUuid);
};

/** 从 selfLog.tasks 摘掉一条（取消时）或换时间（改期时）。没这条就原样返回。 */
const patchSelfLogTask = (
  stash: FireStash,
  taskUuid: string,
  patch: { remove: true } | { sendAt: string },
): void => {
  const tasks = stash.selfLog.tasks;
  if (!tasks.some((t) => t.taskUuid === taskUuid)) return;
  stash.selfLog = {
    ...stash.selfLog,
    tasks: 'remove' in patch
      ? tasks.filter((t) => t.taskUuid !== taskUuid)
      : tasks.map((t) => (t.taskUuid === taskUuid
        ? { ...t, firstSendTime: patch.sendAt, nextSendAt: patch.sendAt }
        : t)),
  };
  stash.selfLogDirty = true;
};

/**
 * fire 侧取消任务（cancel_active_message）。
 *
 * D1 行删掉之后必须两头消账：selfLog.tasks（不消的话下次 fire 的清单里它还在，
 * 角色以为没取消成）+ stash.cancelledTasks（随最后一条 push 回客户端，面板跟着删）。
 * 本轮刚排的那条也允许当场反悔——从 scheduledTasks 里一并摘掉。
 */
export const runFireCancelTool = async (
  stash: FireStash,
  cancelTask: CancelTask | undefined,
  args: Record<string, unknown>,
  nowMs: number,
): Promise<Record<string, unknown>> => {
  if (typeof cancelTask !== 'function') {
    return { ok: false, reason: 'not_supported', message: '当前后台版本还不支持取消任务，先当它会照常响，把要说的话说清楚。' };
  }
  const resolved = resolveFireTargetTask(liveTaskView(stash), args.task_id, nowMs, stash.tz);
  if ('ok' in resolved) return resolved as unknown as Record<string, unknown>;
  const target = resolved.task;

  let result;
  try {
    result = await cancelTask(target.taskUuid);
  } catch (error) {
    return { ok: false, reason: 'cancel_failed', message: error instanceof Error ? error.message : String(error) };
  }
  if (!result.cancelled) {
    // 行已经不在了（先前取消过 / 已经触发跑掉了）。对模型来说目的达成，照实说。
    return { ok: true, already_gone: true, message: `任务 [${shortTaskId(target.taskUuid)}] 已经不在排程里了，不用再管它。` };
  }

  stash.cancelledTasks = [...stash.cancelledTasks, target.taskUuid];
  stash.scheduledTasks = stash.scheduledTasks.filter((t) => t.taskUuid !== target.taskUuid);
  patchSelfLogTask(stash, target.taskUuid, { remove: true });
  console.log('[amsg:self-cancel]', { uuid: target.taskUuid });
  return { ok: true, task_id: shortTaskId(target.taskUuid), message: `已取消 [${shortTaskId(target.taskUuid)}]。` };
};

/**
 * fire 侧改期（renew_active_message）。
 *
 * 一次性任务走 ctx.renewTask 原地换时间（uuid 不变，与前台「重建换编号」不同——
 * fire 侧有原地改的能力就不折腾编号）；循环任务与前台同语义：只给这一次补发一条
 * 一次性任务（复用排程工具的全部账目与上限），原序列不动。fixed 模式不让动
 * （没有 AI 生成环节，改期该去设置面板）。
 */
export const runFireRenewTool = async (
  stash: FireStash,
  fireCtx: { renewTask?: RenewTask; scheduleTask?: ScheduleTask },
  args: Record<string, unknown>,
  nowMs: number,
): Promise<Record<string, unknown>> => {
  if (typeof fireCtx.renewTask !== 'function') {
    return { ok: false, reason: 'not_supported', message: '当前后台版本还不支持改期，要么取消重排，要么先当它会照常响。' };
  }
  const resolved = resolveFireTargetTask(liveTaskView(stash), args.task_id, nowMs, stash.tz);
  if ('ok' in resolved) return resolved as unknown as Record<string, unknown>;
  const target = resolved.task;
  if (target.mode === 'fixed') {
    return { ok: false, reason: 'fixed_task', message: '固定内容的任务不在这里改，让用户去设置面板调整。' };
  }
  const parsed = parseFireRenewSendAt(args.send_at, nowMs, stash.tz);
  if ('ok' in parsed) return parsed as unknown as Record<string, unknown>;

  // 循环任务：补发一条一次性，原节奏不动（与前台 renew 同语义）。走排程工具的
  // 完整入口，连发上限 / 任务上限 / 记账 / 认领全部照常生效。
  if (target.recurrenceType !== 'none') {
    const result = await runFireScheduleTool(stash, fireCtx.scheduleTask, {
      send_at: args.send_at,
      mode: target.mode,
      ...(target.promptHint ? { prompt_hint: target.promptHint } : {}),
      recurrence: 'none',
      expire_policy: target.expirePolicy,
    }, nowMs);
    if (result.ok === true) {
      return { ...result, message: `已为 [${shortTaskId(target.taskUuid)}] 的这一次补上一条一次性任务，原来的重复节奏不变。` };
    }
    return result;
  }

  let result;
  try {
    result = await fireCtx.renewTask(target.taskUuid, parsed.sendAt);
  } catch (error) {
    // 上游的护栏（时间太近、行型不认）都抛错，转成回喂让模型换个时间再试。
    return { ok: false, reason: 'renew_rejected', message: error instanceof Error ? error.message : String(error) };
  }
  if (!result.renewed) {
    return { ok: false, reason: 'task_gone', message: `任务 [${shortTaskId(target.taskUuid)}] 已经不在排程里了（可能刚触发过），要说的话用 schedule_active_message 重新排。` };
  }

  stash.renewedTasks = [...stash.renewedTasks, { taskUuid: target.taskUuid, sendAt: result.nextSendAt }];
  patchSelfLogTask(stash, target.taskUuid, { sendAt: result.nextSendAt });
  console.log('[amsg:self-renew]', { uuid: target.taskUuid, sendAt: result.nextSendAt });
  return {
    ok: true,
    task_id: shortTaskId(target.taskUuid),
    send_at: result.nextSendAt,
    message: `已把 [${shortTaskId(target.taskUuid)}] 改到新时间（编号不变）。`,
  };
};

/**
 * 倒数第二轮的工具回喂末尾追加的一句。
 *
 * 这批结果喂进去之后就是最后一轮了，模型再请求工具只会被硬收尾（processLLMRound 那道
 * 闸），它写的「等我再查查」会被丢掉。先把话说在前面，让它自己把内容写完——软提示不管用
 * 时还有硬收尾兜着，两层都在。
 */
const FINAL_ROUND_NOTICE = '（提醒：这是最后一轮了，不要再调用任何工具，直接把想说的话写完。）';

/** 本轮的工具结果是不是喂给最后一轮的（ctx.iteration 缺失的老部署不提示）。 */
const feedsFinalRound = (iteration: number | undefined): boolean =>
  typeof iteration === 'number' && iteration >= MAX_TOOL_ITERATIONS - 2;

/**
 * 单个 MCP 调用的超时。总 fire 预算 240s / 最多 5 轮，一个慢服务器不能吃光
 * 整条链（浏览器侧是 60s，那边没有轮次预算压力）。
 *
 * 单次上限之外还有下面那条共享总预算：native FC 一轮可以吐好几个调用，
 * executeToolCalls 是串行 await 的，只卡单次的话 25s × N 照样能顶穿 240s。
 */
const MCP_CALL_TIMEOUT_MS = 25_000;

/**
 * 单次 fire 内全部 MCP 调用共享的时间预算。总 fire 240s，扣掉 LLM 往返，
 * MCP 最多吃一半——预算尽了让后续调用早退（ok:false 回喂），比转到轮次上限
 * 整条任务重跑便宜得多（重跑的代价见 agenticToolFeedback 头注释）。
 */
const MCP_TOTAL_BUDGET_MS = 120_000;

/**
 * 执行一个带 MCP_FIRE_NAME_PREFIX 的工具调用。永不抛错——失败也以 ok:false 回喂给 LLM
 * 圆场（与 dispatchAgenticTool 的失败语义对齐，见 executeToolCalls 注释）。
 * export 只为单测。
 */
export const runMcpFireTool = async (
  stash: Pick<FireStash, 'mcpResolve' | 'mcpSessions' | 'mcpSpentMs'>,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const exposed = name.slice(MCP_FIRE_NAME_PREFIX.length);
  const hit = stash.mcpResolve?.get(exposed);
  if (!hit) {
    return { ok: false, reason: 'unknown_tool', message: `未配置的 MCP 工具: ${exposed}` };
  }
  // 预算尽了就不再发请求，直接把「别调了，收尾吧」回喂给模型——继续排队等超时只会
  // 把 fire 拖过总预算，那是整条任务重跑，比少查一次贵得多。
  const remaining = MCP_TOTAL_BUDGET_MS - stash.mcpSpentMs;
  if (remaining <= 0) {
    return {
      ok: false,
      reason: 'mcp_budget_exhausted',
      source: hit.server.name,
      message: 'MCP 调用时间预算已用完，这轮别再调外部工具了，用手上已有的信息收尾。',
    };
  }
  // 每台服务器一份会话，单次 fire 内跨轮复用：一次 fire 最多五轮，每轮重握手就是白烧往返。
  let session = stash.mcpSessions.get(hit.server.id);
  if (!session) {
    session = createMcpSessionState();
    stash.mcpSessions.set(hit.server.id, session);
  }
  const started = Date.now();
  const result = await callMcpToolCore(
    // worker 侧 fetch 没有 CORS，直连用户配的地址，不经代理。
    { url: hit.server.url, headers: (sid) => buildMcpDirectHeaders(hit.server, sid) },
    session,
    hit.toolName,
    args as Record<string, any>,
    {
      // 剩余预算比单次上限还少时按剩余的来，最后一个调用不会越过总线。
      timeoutMs: Math.min(MCP_CALL_TIMEOUT_MS, remaining),
      inputSchema: hit.tool.inputSchema,
      serverLabel: hit.server.name,
    },
  );
  // 失败/超时的耗时同样记账——烧掉的墙钟时间不因为结果不好就不算。
  stash.mcpSpentMs += Date.now() - started;
  return result.success
    ? { ok: true, source: hit.server.name, data: formatMcpToolResult(result.data) }
    : { ok: false, reason: 'mcp_error', source: hit.server.name, message: result.error };
};

// export 只为单测（见 index.test.ts）：onBeforeFire 的四道门顺序是这个功能最关键的
// 决策路径，一个判断写错位就是「该拦的没拦」或「全都不发」，必须有回归守卫钉住。
export const amsgHooks = {
  async onBeforeFire(ctx: FireCtx) {
    const charId = ctx.task?.metadata?.charId;
    if (typeof charId !== 'string' || !charId) {
      throw fireStateError('task metadata 缺 charId', { taskId: ctx.task.id });
    }
    // 提前到这儿算（下面那段注释仍在原位）：fail 的留痕副作用要用它。
    const instant = isInstantChatTask((ctx.task.metadata ?? {}) as Record<string, unknown>);

    // 下面每道门的报错都带同一套定位信息，绑一次就好——逐处手抄 detail 的话，
    // 加一道门就要再抄一遍，漏了就是一条查不到是谁的错误日志。
    // 即时对话的失败还在抛出那一刻就写 chat_fail：最典型的失败（fire_pack 缺失 /
    // 解析不过 / 缺 chat 段）都发生在挂 stash 之前，onFireSettled 那份留痕拿不到
    // stash、一条都写不了，用户等完全部重试只会得到「云端没记下原因」。fire-and-forget，
    // 不拦 throw；挂 stash 之后的失败会被收尾那份用最后一跳的原因覆盖，语义不变。
    const fail = (reason: string, extra?: Record<string, unknown>) => {
      if (instant && typeof ctx.task.uuid === 'string' && ctx.task.uuid) {
        // writeState 在老版本上游的 FireCtx 上可能不存在——那就退回没有留痕的老行为。
        if (typeof ctx.writeState === 'function') {
          void writeChatFail(ctx.writeState, charId, {
            uuid: ctx.task.uuid,
            reason,
            retryCount: typeof (ctx.task as { retry_count?: unknown }).retry_count === 'number'
              ? (ctx.task as { retry_count: number }).retry_count
              : 0,
          });
        }
        // fireStateError 一律 permanent：上游一跳就把任务行标 failed（终态），而这批失败
        // 都发生在挂 stash 之前——收尾那份（amsgFireSettled）因读不到 stash 提前走人，
        // 一条通知都发不出，用户会对着「正在输入…」干等到超时。终态失败的 error push
        // 只能在这里补发；与收尾那条互斥不双发（这里只在挂 stash 之前跑，收尾只在
        // stash 在场时发）。老上游不认 permanent 时每跳重试都会走到这儿，重复投递由
        // 确定性 messageId（err_<uuid>）交给 SW 去重兜住。fire-and-forget，不拦 throw。
        void sendInstantErrorPush({
          charId,
          taskUuid: ctx.task.uuid,
          reason,
          contactName: ctx.task.contactName ?? null,
        });
      }
      return fireStateError(reason, { taskId: ctx.task.id, charId, ...extra });
    };

    // 前端上传的云端状态可能被 packStateValue 压过（值以 gz1: 开头），读回来统一先过
    // 一遍解压——没压过的原样穿过去，读侧不用赌客户端到底压了哪几份。带月度总结的
    // tool_pack 就在压缩量级上，漏掉这一步整条 fire 链会卡死在「解析失败」。
    // 解压失败说明数据真损坏了，和解析失败同款硬失败语义。
    const unpackOrFail = async (label: string, value: string): Promise<string> => {
      try {
        return await unpackStateValue(value);
      } catch (error) {
        throw fail(`${label} 解压失败（数据损坏）`, { error: String(error) });
      }
    };

    const charRows = await ctx.readState(amsgStateNamespace(charId));

    const taskMeta = (ctx.task.metadata ?? {}) as Record<string, unknown>;
    const policy = typeof taskMeta.amsgExpirePolicy === 'string'
      ? taskMeta.amsgExpirePolicy : undefined;

    // 副 API 凭据落地即取走：这一份 metadata 对象上游还要按引用往下传（onLLMOutput 的
    // ctx.metadata、以及 hook 不接手时那条会把整份 metadata 直接挂上推送的模板路径），
    // 在最早的地方摘掉，后面谁也漏不出去。取完还要用——即时对话那一支下面拿它起跑评估。
    // 这里不分支：定时任务上本来就不该有这个键，真有也一样删掉。见 takeEmotionEvalSpec。
    const emotionEvalSpec = takeEmotionEvalSpec(ctx.task.metadata);

    // 即时对话：用户刚把话说完、正盯着「正在输入…」等回复。下面三道门问的都是
    // 「主动消息到点还该不该发」——用户正在聊天所以让路、对话已经往前走所以作废、
    // 这次任务的方向是什么——对「回一句用户刚说的话」全都不适用，整段跳过。
    // （instant 本体在上面 fail 之前就算好了，这里只是叙事位置。）

    // 同角色活跃会话租约：一轮对话生成期间客户端每 15s 续租，45s TTL。
    // 这是 worker 防通知的第一道快速门；缺失/过期/坏数据就继续走 fire_pack 规则。
    // 保持在 fire_pack 检查之前：用户正在聊天时应该直接 skip，既省一次状态读，
    // 也让「状态不完整」的异常任务在用户正忙时安静跳过、而不是抛错刷失败计数。
    const presence = parseAmsgChatPresence(
      charRows.find((r) => r.key === AMSG_CHAT_PRESENCE_KEY)?.value,
    );
    if (!instant && policy === 'expire' && isFreshChatPresence(presence, charId, ctx.now.getTime())) {
      console.log('[amsg:expire-skip]', {
        taskId: ctx.task.id,
        reason: 'active-chat-presence',
        presenceActiveAt: presence?.activeAt,
      });
      // 这道门在解析 fire_pack 之前，拿不到 occurrenceMs，用任务行的名义时刻。
      await recordSkip(
        ctx, charId, 'active-chat-presence',
        Date.parse(String(ctx.task.nextSendAt)) || ctx.now.getTime(),
      );
      return { skip: true } as const;
    }

    const packRow = charRows.find((r) => r.key === AMSG_FIRE_PACK_KEY);
    if (!packRow) throw fail('云端没有这个角色的 fire_pack');

    // 大值分块由 amsg-server 2.6.0-next.4+ 在存储层透明处理，readState 拿到的已是拼回的原文。
    const packJson = await unpackOrFail('fire_pack', packRow.value);
    const pack = parseFirePack(packJson);
    // 失败原因写清楚：升 fire_pack 版本要 worker bundle 和前端一起动，而设置页的版本门槛
    // 读的是上游 amsg-server 库的版本号，只改 SullyOS 自己这份 worker 代码时它不会亮。
    // 面板上的 lastError 是用户唯一能看到的线索，得直接说出该做什么。
    if (!pack) throw fail(`fire_pack 解析失败：${describeFirePackVersion(packJson)}`);

    // 即时对话缺 chat 段 = 云端状态和任务对不上（客户端只传了主动消息那半份）。
    // 硬失败，绝不退回模板渲染：拿「到点主动找人说话」的提示词去答用户刚说的话，
    // 出来的东西驴唇不对马嘴，而用户完全看不出这是坏了还是角色就这样。
    if (instant && !pack.chat) {
      throw fail('即时对话任务的 fire_pack 里没有 chat 段（云端状态没跟上）');
    }

    // 定时轮撞上占位模板：角色 2.0 关着且无任务时，即时对话上传的轻量包把 template 填成
    // 占位串（AMSG2_INSTANT_STUB_TEMPLATE）；欠着即时回复期间用户新排了定时任务、真模板
    // 的补传又被挡到销账之后时，任务可能先到点——照渲就是把那句占位自白当系统提示词发出去。
    // 抛**可重试**错误（不带 permanent、不走 fail()）：这不是状态坏了，只是包还没就绪，
    // 走上游重试梯子（2/4/6 分钟，第一跳就比客户端销账后 60s 一轮的补传回看宽），销账后
    // 真模板到位自然放行；一直不来就按正常梯子终失败。
    // 即时轮不渲染模板，不受这道门管；这条是定时轮，也不写 chat_fail、不发 error push。
    // fixed 任务（固定文案、不走 LLM）不会被这道门等死：上游按 taskNeedsLlm 把关，
    // messageType 'fixed' 压根不进 onBeforeFire，直接走固定文案分支。
    if (!instant && pack.template === AMSG2_INSTANT_STUB_TEMPLATE) {
      console.warn('[amsg:fire-pack-stub] fire_pack 还是即时对话的占位模板，等客户端补传后重试', {
        taskId: ctx.task.id,
        charId,
      });
      throw new Error('AMSG2_FIRE_PACK_NOT_READY: fire_pack 里还是即时对话的占位模板（真模板尚未补传），这次触发先重试等它就位');
    }

    // 本次触发时刻：任务行 next_send_at（NOT NULL，buildHookTask 已摊平提供）。防穿帮闸的
    // 循环判定要拿它当窗口锚点，之后又经 scratch 透传给每条 push 的 metadata.amsgOccurrenceMs
    // （客户端兜底闸的循环判定与吞放缓存键都要它）。解析不出来说明上游任务行的时间格式变了，
    // 按状态异常硬失败。
    const occurrenceMs = Date.parse(String(ctx.task.nextSendAt));
    if (!Number.isFinite(occurrenceMs)) {
      throw fail('任务行 next_send_at 解析不出触发时刻', { nextSendAt: ctx.task.nextSendAt });
    }

    // 防穿帮闸·worker 主判定：一次性任务创建后对话已前进 / 循环任务到点时用户
    // 正在热聊 → { skip: true } 跳过本次 fire（amsg-server skip 出口，任务照常
    // 推进/删除），一个生成 token 都不花。fire_pack.lastUserMessageAt 随 amsgStateSync
    // 在微任务里冲刷，滞后的只有一次上传往返（慢网下也是几秒量级）；这点残余竞态由客户端
    // 送达兜底闸兜住（activeMsgRuntime 的 runtime-expire-swallow）。缺策略字段的任务不拦。
    //
    // 「用户最后一次开口」取 fire_pack 和 presence 两份里较新的：presence 行是每轮聊天
    // 一开场就写的小值，几十字节就发完了；fire_pack 是整包几十 KB，同样是打脏即发，
    // 但传完总要慢一截。presence 过期（TTL 45s，上面那道门用的就是它）只说明用户此刻不在
    // 等回复，不影响「他最后一次开口是几点」这个事实，所以这里不看新鲜度，只保留 charId
    // 校验——别拿别的角色的对话当锚点。
    const presenceLastUserMessageAt = presence?.charId === charId ? presence.lastUserMessageAt : null;
    const expireInput = {
      policy,
      recurrenceType: ctx.task.recurrenceType,
      anchorMs: typeof taskMeta.amsgAnchorMs === 'number' ? taskMeta.amsgAnchorMs : null,
      lastUserMessageAt: laterOf(pack.lastUserMessageAt ?? null, presenceLastUserMessageAt),
      nowMs: ctx.now.getTime(),
      occurrenceMs,
    };
    if (!instant && shouldExpireFire(expireInput)) {
      console.log('[amsg:expire-skip]', { taskId: ctx.task.id, ...expireInput });
      await recordSkip(ctx, charId, 'conversation-moved-on', occurrenceMs);
      return { skip: true } as const;
    }

    // 任务指令缺失（开发期旧格式任务）：不能用默认 auto 指令凑一个渲染——那会把
    // prompted 任务的方向偷换掉，发出去的内容和用户当初排的不是一回事。
    // 即时对话没有「本次任务」这回事，方向就是回用户刚说的那句话。
    if (!instant && typeof taskMeta.amsgTaskInstruction !== 'string') {
      throw fail('任务 metadata 缺 amsgTaskInstruction（旧格式任务）');
    }

    // 工具数据与 prompt 同拍装好，挂 ctx.scratch 给同一次 fire 的
    // onLLMOutput / executeToolCalls（库保证同引用、fire 结束即丢，
    // 不需要自维护 sessionId → 状态的 Map 和防泄漏水位）。
    const globalRows = await ctx.readState(AMSG_GLOBAL_NAMESPACE);
    const toolPackRow = charRows.find((r) => r.key === AMSG_TOOL_PACK_KEY);
    const toolConfigRow = globalRows.find((r) => r.key === AMSG_TOOL_CONFIG_KEY);
    if (!toolPackRow) throw fail('云端没有这个角色的 tool_pack');
    if (!toolConfigRow) throw fail('云端没有 tool_config');

    // 两份数据和 fire_pack 同批原子上传（activeMsgClient 的 putClientStateOrThrow），
    // 所以走到这里必然都在；和 fire_pack 一样先解压再解析（tool_pack 攒上几条月度总结
    // 就会被前端压缩）。解析不出来就是云端状态坏了，硬失败不降级。
    const toolPack = parseToolPack(await unpackOrFail('tool_pack', toolPackRow.value));
    if (!toolPack) throw fail('tool_pack 解析失败（格式不对或数据损坏）');
    const toolConfig = parseToolConfig(await unpackOrFail('tool_config', toolConfigRow.value));
    if (!toolConfig) throw fail('tool_config 解析失败（格式不对或数据损坏）');

    // 通用 MCP：提示词块 / tools 数组与凭据同源同拍（都来自这一行 tool_config），
    // 不存在「教了角色用、凭据却没到」的窗口。charIds 过滤与前台同语义。
    // mcpUseNativeTools=false = 用户的中转拒 tools（前台兼容模式同款开关），
    // 请求不带 tools 参数、提示词块教正文协议，识别走 processLLMRound 第二层。
    const promptControls = toolConfig.promptControls;
    const mcpEnabled = promptControls?.mcpTools !== false;
    const realtimeStateEnabled = promptControls?.realtimeState !== false;
    const timeAwarenessEnabled = toolPack.timeAwarenessEnabled && promptControls?.timeAwareness !== false;
    const mcpServers = mcpEnabled ? filterMcpServersForChar(toolConfig.mcpServers, charId) : [];
    // 暴露名后面要拼 MCP_FIRE_NAME_PREFIX，长度预算得先把前缀那几个字符扣掉。
    const mcpResolve = mcpServers.length
      ? buildMcpNameMap(mcpServers, { maxNameLen: MCP_FIRE_NAME_BUDGET })
      : null;
    const mcpNative = toolConfig.mcpUseNativeTools !== false;

    // 角色上次到点自己说了什么：对齐到本次的 fire_pack 与用户发言状态。
    // 连发记录（entries）只在用户开口时清零，fire_pack 换代只作废 tasks 段
    // ——两段生死分开的理由见 amsgFirePack 的 reconcileSelfLogWithPack。
    const storedSelfLog = parseSelfLog(charRows.find((r) => r.key === AMSG_SELF_LOG_KEY)?.value ?? '');
    const selfLog = reconcileSelfLogWithPack(storedSelfLog, pack, expireInput.lastUserMessageAt);

    // 连发上限·到点兜底闸（用户主权）：用户未回复期间，角色自己排的任务最多响这么多次。
    // 只拦自排（amsgSelfScheduled）——用户面板排的是明确意愿，不受自己的防骚扰上限误伤；
    // 即时对话在答用户刚说的话，更不归它管。排程工具那半边只能拦「再排新的」，
    // 先排满再触发的绕不过它，得在这里兜住。用户一回话 entries 清零，闸自动解除。
    const maxUnansweredSends = resolveMaxUnansweredSends(pack.maxUnansweredSends);
    if (!instant && taskMeta.amsgSelfScheduled === true
      && countUnansweredSends(selfLog) >= maxUnansweredSends) {
      console.log('[amsg:unanswered-limit-skip]', {
        taskId: ctx.task.id,
        charId,
        sends: countUnansweredSends(selfLog),
        limit: maxUnansweredSends,
      });
      await recordSkip(ctx, charId, 'unanswered-limit', occurrenceMs);
      return { skip: true } as const;
    }

    // 客户端记录的（打包那一刻的快照）+ 角色自己在之前几次 fire 里排下、客户端还没认领的。
    // 后者不补上的话，角色排完一条、下次到点又看不见它，很容易把同一件事再排一遍。
    const livePendingTasks = [...pack.pendingTasks, ...selfLog.tasks];

    // 角色级 2.0 开关（pack.selfScheduleEnabled，打包时取 isAmsg2EnabledForChar）。
    // 关着 = 排程说明块、排程工具、任务清单一概不注入：本地路径这道闸在 useChatAI 的
    // amsg2ToolsInjected——用户显式关掉的功能不能被云端聊天轮绕开重排任务。
    // 必填字段（parseFirePack 把关），不做缺省——这道闸缺省放行就是 fail-open。
    const selfScheduleAllowed = pack.selfScheduleEnabled;

    // 老 worker 部署（amsg-server < 2.6.0-next.9）没有这个口子。教了也排不成，
    // 只会让角色说「我等下再找你」然后没有下文——干脆不教。
    const canSelfSchedule = typeof ctx.scheduleTask === 'function' && selfScheduleAllowed;

    // 角色的时间参照系：fire_pack 的 tzId（parseFirePack 保证非空，Intl 管夏令时）。
    const tz: AmsgTzRef = { tzId: pack.tzId };

    // 任务归属键：self_log 的条目 id、以及「排程清单里排除掉自己这条」都用它。
    const clientTaskId = typeof taskMeta.amsgClientTaskId === 'string' ? taskMeta.amsgClientTaskId : '';

    const { toolCtx, proxyWorkerUrl, xhsCookie } = buildToolCtx(toolPack, toolConfig);
    // 连发额度里「先前排了还没响」那一份的快照：条数进 plannedSelfSends，uuid 留一份
    // 给排程闸退额度用（本轮取消掉快照里的任务时按交集抵扣，cancel + 重排额度中性）。
    const plannedSelfSendTasks = livePendingTasks
      .filter((t) => t.source === 'character' && isPendingTask(t, ctx.now.getTime()));
    // 显式标注而不是 satisfies：下面即时对话那一支要往 emotionEvalPromise 上写 promise，
    // 用 satisfies 的话这个字段会被推成字面量 null 类型，写不进去。
    const stash: FireStash = {
      session: createFireSessionState(),
      toolCtx,
      proxyWorkerUrl,
      xhsCookie,
      occurrenceMs,
      selfLog,
      selfLogDirty: false,
      mcpResolve,
      fireToolNames: new Set(),
      mcpSessions: new Map(),
      mcpSpentMs: 0,
      // 「还能不能再排」按客户端已知的 + 角色自己排过还没被认领的一起算，
      // 不然角色离线期间连排几次就能绕过每角色的任务上限。
      pendingTaskCount: livePendingTasks.length,
      pendingTasks: livePendingTasks,
      scheduledTasks: [],
      // 序号与 scheduledTasks 一样从空账起步；此后只增不减（取消不回退，见字段注释）。
      selfScheduleSeq: 0,
      cancelledTasks: [],
      renewedTasks: [],
      maxUnansweredSends,
      plannedSelfSends: plannedSelfSendTasks.length,
      plannedSelfSendUuids: plannedSelfSendTasks.map((t) => t.taskUuid),
      charId,
      anchorMs: pack.lastUserMessageAt ?? 0,
      tz,
      taskUuid: typeof ctx.task.uuid === 'string' ? ctx.task.uuid : null,
      taskRowId: ctx.task.id != null ? String(ctx.task.id) : null,
      clientTaskId,
      selfLogTexts: null,
      // 跟下面 renderFirePack 填「你此刻在听」用的是同一个时刻、同一份 scene、同一个种子
      // （resolveFireSceneSong 与 renderFireSceneBlock 共用判定），冻的必然是正文里那首。
      sceneSong: resolveFireSceneSong(pack.scene, ctx.now.getTime(), tz),
      instant,
      // 下面即时对话那一支起跑（要等请求消息拼完才知道给评估喂什么）。
      emotionEvalPromise: null,
      emotionLatePending: false,
      promptAudit: null,
    };
    ctx.scratch.fire = stash;

    // 「你还挂着这些排程」：客户端记录的（打包那一刻的快照）+ 角色自己在之前几次 fire 里
    // 排下、客户端还没认领的那些。后者不补上的话，角色排完一条、下次到点又看不见它，
    // 很容易把同一件事再排一遍。
    // 角色级 2.0 开关关着时整块不给（跟排程工具同一道闸，但不看 scheduleTask 能力：
    // 老 worker 只是排不了新任务，已有清单照旧要给）。本地路径关着开关连任务清单都
    // 不注入，云端给了就是「看得见任务」的半截能力，反而引导角色去聊它。
    // 取消 / 改期工具（amsg-server 2.6.0-next.15 的 ctx.cancelTask / renewTask）。
    // 与排程同一道角色级闸；native tools 才注入——正文协议不教这两个（排程那个教了
    // 是因为它是主链路，取消 / 改期在拒 tools 的中转上宁缺勿滥，语法教多了模型会把
    // 工具名当叙述写进正文）。
    const canManageTasks = canSelfSchedule && mcpNative
      && typeof ctx.cancelTask === 'function' && typeof ctx.renewTask === 'function';

    const baseTaskListBlock = selfScheduleAllowed
      ? buildFireTaskListBlock(livePendingTasks, {
        nowMs: ctx.now.getTime(),
        tzId: pack.tzId,
        excludeClientTaskId: clientTaskId || undefined,
      })
      : '';
    // 清单非空且工具在位时补一句「这些归你管」——工具声明模型看得到，但不点一句的话，
    // 它多半不会想到清单里的条目是可以动的。
    const taskListBlock = baseTaskListBlock && canManageTasks
      ? `${baseTaskListBlock}\n（清单里的任务归你管：情况变了不该响的可以用 cancel_active_message 取消，只是要换时间的用 renew_active_message 改期，task_id 就是清单里的短 id。）`
      : baseTaskListBlock;

    // 「外面的世界此刻什么样」：今日节日 + 实时天气 + 热搜，到点现拉现填。
    // 拉不到 / 超时都只是返回空串，那一段整个消失，这次触发照常往下走。
    const realtimeWorldBlock = realtimeStateEnabled
      ? await buildRealtimeWorldBlock({
        toolConfig,
        timeAwarenessEnabled,
        tzId: pack.tzId,
        nowMs: ctx.now.getTime(),
        globalRows,
        globalNamespace: AMSG_GLOBAL_NAMESPACE,
        writeState: ctx.writeState,
      })
      : '';

    // MCP 说明块 / 「给自己排下一条」说明块：两条路都要，只是挂的位置不同
    // （主动消息接在渲染好的 prompt 后面，即时对话拼进末尾追加的那个 system 块）。
    const mcpBlock = mcpResolve
      ? buildMcpFireBlock(mcpResolve, { mode: mcpNative ? 'native' : 'text' })
      : '';
    // 跟 MCP 共用一个 native/text 判断：用户的中转拒 tools 时两边都得改教正文协议，
    // 不然一边声明成 tools、一边教语法，模型会两种都写一遍。
    // 时间上下文让 send_at 的示例是「明天这个点」的裸墙钟，别再教模型写 offset。
    const scheduleBlock = canSelfSchedule
      ? buildFireScheduleBlock(mcpNative ? 'native' : 'text', { nowMs: ctx.now.getTime(), tz })
      : '';

    const fireTools = [
      ...(mcpResolve && mcpNative ? buildMcpFireTools(mcpResolve) : []),
      ...(canSelfSchedule && mcpNative
        ? [buildFireScheduleTool({ nowMs: ctx.now.getTime(), tz })]
        : []),
      ...(canManageTasks
        ? [buildFireCancelTool(), buildFireRenewTool({ nowMs: ctx.now.getTime(), tz })]
        : []),
    ];
    // 非 MCP 的声明名单独留一份给 onLLMOutput 认领 native 调用用（见 FireStash.fireToolNames）。
    stash.fireToolNames = new Set(fireTools
      .map((t) => t?.function?.name)
      .filter((n): n is string => typeof n === 'string' && !n.startsWith(MCP_FIRE_NAME_PREFIX)));
    // 轮次上限显式给一份：worker 要靠同一个数判「这是最后一轮了」（见 onLLMOutput），
    // 而上游只有内部默认值、没导出常量，各写各的迟早对不上。
    // tools 由 amsg-server 带 agentic-fire-tools feature 的版本起透传给每轮 LLM 请求。
    const common = {
      maxToolIterations: MAX_TOOL_ITERATIONS,
      ...(fireTools.length ? { tools: fireTools } : {}),
    };

    // 即时对话：请求消息就是客户端本地生成会发出去的那一串，末尾追加一块时效信息。
    // 不走模板渲染——那是「到点主动找人说话」的提示词，拿它答用户刚说的话必然跑偏。
    if (instant) {
      // 到点才知道的那些事（现在几点、外面在下雨、还挂着哪些排程…）。一件都没有时是空串，
      // 那就一条都不追加——空的系统消息挂在对话末尾只会让模型以为话没说完。
      const timelyBlock = buildInstantTimelyBlock({
        nowMs: ctx.now.getTime(),
        tz,
        userTzId: pack.userTzId,
        targetName: pack.targetName,
        timeAwarenessEnabled,
        blocks: [
          realtimeWorldBlock,
          renderSelfLogBlock(selfLog, ctx.now.getTime(), tz, maxUnansweredSends),
          taskListBlock, mcpBlock, scheduleBlock,
        ],
      });
      const instantMessages = [
        // content 原样透传，一个字都不动：带图片的消息本地就是结构化分段
        // （`[{type:'text'},{type:'image_url'}]`），上游把这个数组整个丢进
        // /chat/completions 的请求体（amsg-shared 的 buildLlmRequestBody 只做
        // `messages: llmMessages`，不看 content 的类型）。这里但凡 String() 一下，
        // 模型收到的就是「[object Object]」而不是那张图。
        // 每条重新包一层对象只是不把 pack 上那份交出去，content 仍是同一个引用。
        ...pack.chat!.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(timelyBlock ? [{ role: 'system' as const, content: timelyBlock }] : []),
      ];

      // 情绪评估（副 API）：跟主生成**并行**跑，等 onLLMOutput 收尾时 await——那时
      // 多半早就跑完了，等于零额外延迟。挂了返回 null，主回复照发。
      //
      // 喂给它的是主生成看到的同一串消息（含末尾那块时效信息）：客户端打包的 chat 段
      // 里已经没有「现在几点」了（那部分留给到点现填），只喂原串的话评估模型连时间都
      // 不知道，判出来的情绪跟角色刚说的话对不上。
      //
      // fire 重试（2/4/6 分钟梯子）会整轮重跑到这里。上一跳评估已经出了结果的话，
      // 失败收尾（amsgFireSettled）把它写在旁路键 amsgEmotionUpdateKey 下——重试跨
      // tick 唯一能带过来的位置。读到就直接包成 resolved promise 复用，别再白烧一次
      // 副 API；读不到才起新评估。
      if (emotionEvalSpec) {
        const storedEvalRaw = clientTaskId
          ? charRows.find((r) => r.key === amsgEmotionUpdateKey(clientTaskId))?.value
          : undefined;
        // 副 API 凭据两种来路：存量任务里内联的那份，或任务只带引用、这里现读凭据表
        // （换 Key 之后不用回头改任务，见 resolveEmotionEvalApi）。取不到就这一轮不评估，
        // 主回复照发——评估从来不连累正文。
        // 取凭据是异步的，包在一个 promise 里保持「与主生成并行起跑」这件事不变。
        stash.emotionEvalPromise = storedEvalRaw
          ? Promise.resolve({ raw: storedEvalRaw, error: null })
          : (async () => {
            const evalApi = await resolveEmotionEvalApi(
              emotionEvalSpec, ctx.task.credRefs, ctx.resolveLlmCredential,
            );
            if (!evalApi) {
              console.warn('[amsg:emotion] 这一轮取不到副 API 凭据，跳过评估');
              return { raw: null, error: '云端没有可用的情绪评估 API 凭据' };
            }
            return runAmsgEmotionEval(
              emotionEvalSpec, evalApi, instantMessages,
              toolPack.charName || ctx.task.contactName || '角色',
            );
          })();
      }

      return {
        messages: instantMessages,
        ...common,
        // 用户正盯着「正在输入…」等回复，给足时间把工具循环跑完，别让他重发一遍。
        totalTimeoutMs: INSTANT_TOTAL_TIMEOUT_MS,
      };
    }

    // fire_pack v3：「本次任务」指令随任务 metadata 走，这里填槽。
    // MCP 块拼在渲染好的 prompt 之后（同一条 user 消息）。
    const prompt = renderFirePack(pack, ctx.now.getTime(), taskMeta.amsgTaskInstruction as string, {
      selfLog,
      taskListBlock,
      realtimeWorldBlock,
    }) + mcpBlock + scheduleBlock;
    stash.promptAudit = createPromptAuditDraft(ctx, prompt, promptControls, {
      mcpEnabled,
      realtimeStateEnabled,
      timeAwarenessEnabled,
    });
    return {
      messages: [{ role: 'user' as const, content: prompt }],
      ...common,
    };
  },

  async onLLMOutput(ctx: SessionCtx) {
    const content = stripReasoningTags(ctx.llmOutputText || '').trim();

    // 任务身份直接从 ctx 上读（sessionId 是给日志和去重用的不透明串，不拿它切）。
    const taskId = ctx.taskId != null ? String(ctx.taskId) : null;
    if (taskId == null) {
      // 没有任务行的路径（in-server instant）才该是 null。定时任务走到这里说明上游没
      // 给身份，而后果是静默的：送达消息的 metadata.activeMsg2.taskId 会是 null →
      // 客户端 hasDeliveredProactiveNear 判定「这次没送达过」→ 排程现状块给角色注入
      // 一条假的「已作废」回执，角色可能把已经发出去的事又当没发生。留个日志。
      console.warn('[amsg:agentic] ctx 上没有 taskId，送达归属会失效', ctx.sessionId);
    }
    const messageType = typeof ctx.metadata?.amsgMode === 'string' ? ctx.metadata.amsgMode : 'auto';

    // onBeforeFire 要么抛错、要么 skip、要么在返回 messages 之前把 stash 挂上，所以
    // 走到这里 stash 必然存在（库保证 fireCtx.scratch 与每轮 sessionCtx.scratch 同引用）。
    // 真缺了就是这个前提被打破（比如库不再共享 scratch）——响亮地失败，别静默丢旁白。
    const stash = getFireStash(ctx.scratch);
    if (!stash) {
      throw new Error('AMSG2_FIRE_STASH_MISSING: onLLMOutput 读不到 ctx.scratch.fire，检查 amsg-server 是否仍共享 scratch');
    }
    const session = stash.session;

    // 思考链两个来源：响应字段 + 正文内联 <think>。抄的是没 strip 过的原文
    // （上面那个 content 是剥完的）。字段名认三个，跟本地路径一样宽
    // （见 utils/safeApi.ts）：reasoning_content 是 deepseek-r1 / GLM 那批的写法，
    // OpenRouter 转出来叫 reasoning，还有渠道写 thinking——只认一个就会静默没有卡片。
    // 不复用上游的 readReasoningContent：它是「原生**或**第一个内联块」，这里要的是
    // 「原生**加**全部内联块」，跟客户端渲染的那份对齐。
    //
    // 每轮**覆盖**（包括覆盖成空）：留下的必须是产出正文那一轮的思考。中间轮那句
    // 「我先去查一下」跟用户看到的正文对不上，最后一轮没思考时也不能拿它顶上。
    //
    // 包装层不主动开 thinking 参数——该不该开由客户端定：本地那一轮会发的三件套
    // （thinking / reasoning_effort / extra_body）随 taskPayload 顶层 llmExtraBody
    // 上云（含 Gemini 让步在内的判定都在 useChatAI 的 shouldSendThinkingParams），
    // 由上游 buildLlmRequestBody 展开进请求体；上游没认领这个字段时退化为只有
    // -thinking 模型名后缀生效。这里替客户端多开一份的话，Gemini 系 thinking + tools
    // 同发直接 400。
    const llmMessage = (ctx.llmResponse as {
      choices?: Array<{ message?: Record<string, unknown> }>;
    })?.choices?.[0]?.message;
    const nativeReasoning = llmMessage?.reasoning_content ?? llmMessage?.reasoning ?? llmMessage?.thinking;
    const roundReasoning = [nativeReasoning, extractInlineThink(ctx.llmOutputText || '')]
      .filter((s): s is string => typeof s === 'string' && !!s.trim())
      .map((s) => s.trim())
      .join('\n\n');
    session.finalReasoning = roundReasoning || null;

    // native tool_calls：只认声明过的工具（fireToolNames 的管理工具 + mcpResolve 的
    // MCP 名），但认法放宽——模型常把声明名的「姓」搞丢或换家：声明的 mcp__foo 回报成
    // foo / default_api:foo，cancel_active_message 也在此列。严格命中优先，对不上再
    // 去掉命名空间取裸名、唯一命中才认领（见 classifyNativeToolCalls，认领时名字改写
    // 回声明名）。真幻觉的（哪份清单都对不上）照旧丢弃并留日志——直接透传会让
    // executeToolCalls 撞上没有 stash 映射的名字。日志带上当时声明了哪些，
    // 「模型编的」和「名字映射建歪了」一眼能分开。
    const rawToolCalls = (ctx.llmResponse as { choices?: Array<{ message?: { tool_calls?: unknown } }> })
      ?.choices?.[0]?.message?.tool_calls;
    const nativeCalls = classifyNativeToolCalls(rawToolCalls, stash.fireToolNames, stash.mcpResolve);
    for (const droppedName of nativeCalls.dropped) {
      console.warn('[amsg:agentic] 丢弃未声明的 native tool_call', {
        sessionId: ctx.sessionId,
        name: droppedName,
        declared: [...stash.fireToolNames, ...(stash.mcpResolve?.keys() ?? [])],
      });
    }

    let decision = processLLMRound(session, content, {
      // 名字取 tool_pack 里的那份：它跟着每轮聊天重新上云，改名当天就是新的。
      // ctx.contactName 是排程那一刻冻进任务行的快照，用户改完名字之后，之前排的
      // 任务推送出来横幅还顶着旧名字（上游 update-message 也不让改这个字段）。
      // tool_pack 里没名字时退回任务行那份，别让标题变成「来自 」。
      contactName: stash.toolCtx.char.name || ctx.contactName,
      avatarUrl: ctx.avatarUrl ?? null,
      taskId,
      messageType,
      // 摘掉评估配置再交出去：它里头是用户副 API 的 apiKey，而 metadata 会被整个
      // 摊进每条 push 的 payload（见 agentic 的 buildScheduledPush）。见 stripEmotionEvalSpec。
      metadata: stripEmotionEvalSpec(ctx.metadata),
      occurrenceMs: stash.occurrenceMs,
      // round 1 XHS 工具抓到的笔记 / xsecToken 快照：finish 时按 directive 引用
      // 挑选后随最后一条 push 带回客户端（客户端离线跑不了 round 1，缺这份
      // [[XHS_SHARE]] / 点赞 / 评论重放必然 available:0 掉卡片）。
      xhsNotes: stash.toolCtx.lastXhsNotesRef?.current,
      xhsXsecTokens: stash.toolCtx.xhsCaches
        ? Array.from(stash.toolCtx.xhsCaches.xsecTokenCache.entries())
        : undefined,
      // 角色写了 MUSIC_ACTION 的话，把它读到的那首歌一起带给客户端：标签里只有歌单名，
      // 没有这一份的话客户端只能拿「用户此刻在听的那首」凑（补收时多半是空的）。
      sceneSong: stash.sceneSong,
    },
    stash.mcpResolve ? { resolve: stash.mcpResolve, nativeToolCalls: nativeCalls.mcp } : null,
    // 传 null = 这次不认排程（老部署没这口子），正文里写了也不当调用。
    // manage 池里可能还有 cancel / renew——它们被认领的前提是声明过（canManageTasks），
    // 而 canManageTasks ⊆ canSelfSchedule ⊆「scheduleTask 是函数」，这道闸不会误拦。
    typeof ctx.scheduleTask === 'function' ? { nativeToolCalls: nativeCalls.manage } : null,
    // 最后一轮不再放行工具请求，改成用手上的内容收尾（见 agentic.ts 的 MAX_TOOL_ITERATIONS）。
    ctx.iteration);

    if (stash.promptAudit) {
      appendPromptAuditRound(stash.promptAudit, ctx, content, decision);
      stash.promptAudit.status = decision.decision;
      if (decision.decision === 'finish') {
        const generatedText = decision.pushPayloads
          .map((payload) => (typeof payload.message === 'string' ? payload.message : ''))
          .filter((message) => message.trim())
          .join('\n')
          .trim();
        if (generatedText) stash.promptAudit.outputText = generatedText;
      }
    }

    if (decision.decision === 'tool-request') {
      console.log('[amsg:agentic]', {
        type: 'tool_request',
        sessionId: ctx.sessionId,
        tools: decision.toolCalls.map((tc) => tc.function.name),
      });
    } else {
      // finish / skip-push：这次 fire 到头，scratch 随调用栈丢弃，无需手动回收。
      console.log('[amsg:agentic]', {
        type: decision.decision,
        sessionId: ctx.sessionId,
        pushes: decision.decision === 'finish' ? decision.pushPayloads.length : 0,
      });
    }

    if (decision.decision === 'skip-push') {
      // ⑤ 没发出去也留痕：模型返回空/纯拒答、或者只做了副作用没说话时，上游把任务
      // 当成功消费，用户看到的就是「说好的消息凭空消失」。写一条 last_skip，面板能
      // 照实解释是哪种。best-effort，写不进去不影响 skip 本身。
      await writeLastSkip(ctx.writeState, stash.charId, {
        v: 1,
        taskUuid: stash.taskUuid,
        occurrenceMs: stash.occurrenceMs,
        reason: decision.reason,
        skippedAt: Date.now(),
      });
      // 即时对话被 skip：一次性行会被上游当成功消费删掉，客户端点名只能看到「行没了、
      // outbox 也空」，落下的说明是「回复没能取回」——把「没生成出来」说成了「取不回」。
      // 也写一份 chat_fail（认 uuid），客户端 gone 分支读回后能照实说「模型这轮没说话」。
      if (stash.instant && stash.taskUuid && ctx.writeState) {
        await writeChatFail(ctx.writeState, stash.charId, {
          uuid: stash.taskUuid,
          reason: decision.reason,
          retryCount: 0,
        });
        // skip 一锤定音（行不会再跑）→ 直发失败通知，等待当场收尾，不用干等 60s 点名。
        await sendInstantErrorPush({
          charId: stash.charId,
          taskUuid: stash.taskUuid,
          reason: decision.reason,
          contactName: ctx.contactName ?? null,
        });
      }
    }

    if (decision.decision === 'finish') {
      // 「我这次说了什么」不在这里写库（这里还没发出去），只把各段正文挂到本次 fire 的
      // scratch 上，等 onAfterSend 按真正送出去的段数落盘。
      stash.selfLogTexts = decision.pushPayloads.map(
        (p) => (typeof p.message === 'string' ? p.message : ''));

      // 角色这次给自己排的任务，随最后一条 push 带回客户端认领——不然它们只活在 D1 里，
      // 面板看不到、用户也没法取消。任务本身照常触发，客户端上线补进清单即可。
      let payloads = attachScheduledTasks(decision.pushPayloads, stash.scheduledTasks);

      // 往指定那一条 push 的 metadata 上追加字段（其余条原样）。下面三处挂载共用：
      // 展开顺序固定「旧 metadata 在前、新字段在后」，键冲突时新值赢。
      const attachMetaAt = (
        list: typeof payloads, idx: number, extra: Record<string, unknown>,
      ): typeof payloads => list.map((payload, i) => (i === idx
        ? { ...payload, metadata: { ...(payload.metadata as Record<string, unknown> ?? {}), ...extra } }
        : payload));

      // 本轮取消 / 改期掉的既有任务同样随最后一条回去消账（与排程认领对称：那边是
      // 「D1 多了一行，本地补上」，这边是「D1 那行没了 / 换时间了，本地跟上」）。
      const cancelled = stash.cancelledTasks;
      const renewed = stash.renewedTasks;
      if ((cancelled.length > 0 || renewed.length > 0) && payloads.length > 0) {
        payloads = attachMetaAt(payloads, payloads.length - 1, {
          amsgTaskMutations: {
            ...(cancelled.length > 0 ? { cancelled } : {}),
            ...(renewed.length > 0 ? { renewed } : {}),
          },
        });
      }

      // 这次生成的思考链随**第一条** push 回客户端：思考链卡片渲染在第一条气泡上，
      // 收侧也只在 messageIndex<=1 那条上认领（见 utils/activeMsgRuntime.ts）。
      // 同样排在旁路存储之前，装不下时才能连它一起挪走。
      //
      // 只在即时对话这条路回传。那一轮的 prompt 里带着「心象」提示词（客户端
      // buildThinkingChainPrompt 打进 fire_pack 的 chat 段），模型的 thinking 写出来是
      // 角色脑内的嘟囔，当卡片正合适。定时任务这条路的 prompt 是 renderFirePack 现拼的，
      // 没有那段提示词，thinking 就是原始推理腔（「用户三小时没说话了，我应该……」）——
      // 那个放进心象卡片就是穿帮。等哪天给 fire_pack 也注入那段提示词，再把这道门放开。
      if (stash.instant && session.finalReasoning && payloads.length > 0) {
        payloads = attachMetaAt(payloads, 0, { amsgReasoning: session.finalReasoning });
      }

      // 末条 push 的挂载合成一次：工具痕迹 + 情绪评估结果都跟正文一起收尾。
      //
      // 工具痕迹：气泡底下那行灰字照它渲染。挂最后一条是因为用户读完话才看到
      // 「哦，这是查过的」；挂第一条就成了还没开口先报备一句「我搜了网页」。
      // 只在即时对话这条路回传。定时任务的气泡是凭空冒出来的（用户没在等这一轮），底下
      // 再挂一行「调用了工具」等于把后台实现摊开给用户看，跟主动消息要的那点不着痕迹相冲。
      //
      // 情绪评估（客户端拿 applyEmotionEvalRaw 落 buff，与本地路径共用同一套解析）：
      // 评估是 onBeforeFire 就起跑的，跟主生成并行，走到这里多半早跑完了。**最多再等
      // EMOTION_EVAL_RIDE_ALONG_MS**，等不到就不搭这班车（见那个常量的注释）。评估挂了
      // 或没赶上都要挂一个 amsgEmotionDone——客户端从按下发送那一刻就点着「情绪更新中」，
      // 只在有结果时才带信号的话，评估一失败那盏灯就得亮到十几分钟后才由安全网熄。
      // 挂了还捎一句短原因（amsgEmotionError），原因里绝不含凭据（见 describeEvalFailure）。
      //
      // 两样都排在旁路存储之前，装不下时才能连它们一起挪走。
      if (stash.instant && payloads.length > 0) {
        const lastMeta: Record<string, unknown> = {};
        const toolTrace = condenseToolTrace(session.toolCalls);
        if (toolTrace.length > 0) lastMeta.amsgToolTrace = toolTrace;
        // 最后一轮的 token 用量（amsg-server 2.6.0-next.15 起 sessionCtx 带 usage，
        // 来源是供应商响应体的 usage 字段）。只挑三个数、不透传原对象——各家供应商
        // 往 usage 里塞的私有字段（缓存命中、思考 token 明细…）没必要跟着每条 push 走。
        // 客户端暂时只存不显示，将来做用量角标不用再动 worker。
        const usage = (ctx as { usage?: Record<string, unknown> | null }).usage;
        if (usage && typeof usage === 'object') {
          const pick = (key: string): number | undefined =>
            typeof usage[key] === 'number' ? usage[key] as number : undefined;
          const promptTokens = pick('prompt_tokens');
          const completionTokens = pick('completion_tokens');
          if (promptTokens !== undefined || completionTokens !== undefined) {
            lastMeta.amsgUsage = {
              ...(promptTokens !== undefined ? { promptTokens } : {}),
              ...(completionTokens !== undefined ? { completionTokens } : {}),
            };
          }
        }
        if (stash.emotionEvalPromise) {
          const outcome = await raceEmotionEval(stash.emotionEvalPromise);
          if (outcome === null) {
            // 没赶上顺风车：不作废也不熄灯。挂引用键 + pending 标记，收尾 hook
            // （amsgFireSettled）等评估出结果写进旁路，客户端对着引用键轮询补落。
            // clientTaskId 缺失时旁路无处可写（存储键按它编），退回「这一轮不更新」。
            if (stash.clientTaskId) {
              lastMeta.amsgEmotionRef = amsgEmotionUpdateKey(stash.clientTaskId);
              lastMeta.amsgEmotionPending = true;
              stash.emotionLatePending = true;
            } else {
              lastMeta.amsgEmotionDone = true;
              lastMeta.amsgEmotionError = EMOTION_EVAL_LATE_REASON;
            }
          } else {
            lastMeta.amsgEmotionDone = true;
            if (outcome.raw) lastMeta.amsgEmotionUpdate = outcome.raw;
            else if (outcome.error) lastMeta.amsgEmotionError = outcome.error;
          }
        }
        if (Object.keys(lastMeta).length > 0) {
          payloads = attachMetaAt(payloads, payloads.length - 1, lastMeta);
        }
      }

      // 发之前按真实字节预算过一遍：装不下的大块数据旁路存起来，push 只留引用键。
      // clientTaskId 当存储键（每任务一份、下次触发覆盖），缺了就没法旁路——那时超限会
      // 由库抛 PUSH_PAYLOAD_TOO_LARGE，照样不会静默丢消息。缺了照样走一趟，是为了让
      // offloadOversizedPush 把「为什么没法旁路」吼出来，别只留一个光秃秃的超限错。
      if (stash.charId) {
        const budgeted = [];
        for (const payload of payloads) {
          budgeted.push(await offloadOversizedPush(
            payload, ctx.writeState, stash.charId, stash.clientTaskId));
        }
        payloads = budgeted;
      }

      // 即时对话的通知策略：用户正盯着窗口等这条回复时不弹横幅（见
      // applyInstantNotificationPolicy）。收件兜底不在这里做——库自己会在每条推送
      // 发出去之前记进服务端账本，客户端按账本补收。
      if (stash.instant) {
        payloads = payloads.map((payload) => applyInstantNotificationPolicy(payload));
      }

      return { ...decision, pushPayloads: payloads };
    }

    return decision;
  },

  /**
   * 服务端工具执行：客户端在 fire 时刻离线，数据工具全部在 worker 内跑完。
   * 单个工具失败（含抛错）都以失败 JSON 回填给 LLM 让它圆场，不失败整条链。
   */
  async executeToolCalls(
    toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
    ctx: SessionCtx,
  ) {
    const stash = getFireStash(ctx.scratch);
    if (!stash) {
      throw new Error('AMSG2_FIRE_STASH_MISSING: executeToolCalls 读不到 ctx.scratch.fire，检查 amsg-server 是否仍共享 scratch');
    }
    // 搜索/Notion/飞书经代理 worker 转发；地址来自前端同步的 tool_config。XHS Lite cookie 同拍注入。
    //
    // 这两个注入写的是 isolate 级全局，而库到点最多并发跑 8 个任务（MAX_CONCURRENT=8）。
    // 现在安全的前提是：两个值都来自全局 namespace 的 tool_config，所有角色同一份，
    // 并发写的是同一个值。缺值时不覆盖——tool_config 瞬时读失败的那个 fire 不该把并发中
    // 另一个 fire 已经注入好的值清成空。
    //
    // TODO(按角色配凭据)：应用层目前不支持（realtimeConfig 是全局单份，按角色的只有
    // char.xhsEnabled 这个开关）。哪天凭据改成按角色配，这里必须改成显式传参——否则
    // 同一分钟并发的两个角色会互相串凭据，而且不会报错。
    if (stash.proxyWorkerUrl) setProxyWorkerUrlOverride(stash.proxyWorkerUrl);
    if (stash.xhsCookie) XhsMcpClient.setCookie(stash.xhsCookie);

    const results = [];
    for (const toolCall of toolCalls) {
      const name = toolCall?.function?.name || '';
      let content: string;
      try {
        const args = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        const fingerprint = toolCallFingerprint(name, args);

        // 同名同参第二次直接打回，一次请求都不发。软提示（下面那段回喂）挡不住时靠它兜底：
        // 转满上限会抛 AGENTIC_LOOP_EXCEEDED，任务不出清、下一分钟整条从头重跑，代价远大于
        // 少查一次。只拦完全一样的调用——换月份、换关键词照常放行，多轮能力不受影响。
        if (stash.session.toolCalls.some((r) => r.fingerprint === fingerprint)) {
          // 计数交给 processLLMRound：连着重复到阈值就直接收尾，不陪它转到轮次上限
          // （上限一到整条任务失败重跑，用户一个字都收不到）。
          stash.session.duplicateToolCalls += 1;
          console.log('[amsg:agentic]', {
            type: 'tool_duplicate',
            sessionId: ctx.sessionId,
            tool: name,
            count: stash.session.duplicateToolCalls,
          });
          results.push({
            tool_call_id: toolCall.id,
            role: 'tool' as const,
            content: buildDuplicateToolMessage(name),
          });
          continue;
        }

        // 三条去处，失败语义一致（都回 ok:false，不抛），回喂 / 记账 / 日志共用下面这段：
        //   排程 → 在 D1 里建下一条任务；MCP → 直连用户配的服务器；其余 → 内置数据工具。
        const result = name === AMSG_FIRE_SCHEDULE_TOOL
          ? await runFireScheduleTool(stash, ctx.scheduleTask, args, Date.now())
          : name === AMSG_FIRE_CANCEL_TOOL
            ? await runFireCancelTool(stash, ctx.cancelTask, args, Date.now())
            : name === AMSG_FIRE_RENEW_TOOL
              ? await runFireRenewTool(stash, ctx, args, Date.now())
              : name.startsWith(MCP_FIRE_NAME_PREFIX)
                ? await runMcpFireTool(stash, name, args)
                : await dispatchAgenticTool(name, args, stash.toolCtx);
        // ran 记的是「这次值不值得写进工具痕迹」：查东西的看有没有真去查，改排程的看有没有
        // 真改成（见 toolDidSomething）。回喂给模型的措辞另有一套口径（buildToolResultMessage
        // 里的 neverRan），两者不共用——痕迹是给用户看的，只说真发生过的事。
        stash.session.toolCalls.push({ name, fingerprint, ran: toolDidSomething(name, result) });
        // 不再回裸 JSON：模型从裸 JSON 里看不出「这一步已经做完了」，提示词里但凡有一句
        // 常驻的「先去查 X」就会每轮照做。这段话跟前台说的是同一套（见 agenticToolFeedback）。
        content = buildToolResultMessage({ name, result, history: stash.session.toolCalls });
        console.log('[amsg:agentic]', { type: 'tool_done', sessionId: ctx.sessionId, tool: name });
      } catch (error) {
        content = JSON.stringify({
          ok: false,
          reason: 'tool_error',
          message: error instanceof Error ? error.message : String(error),
        });
        console.warn('[amsg:agentic]', { type: 'tool_failed', sessionId: ctx.sessionId, tool: name, error: String(error) });
      }
      results.push({ tool_call_id: toolCall.id, role: 'tool' as const, content });
    }

    // 只挂在最后一条 tool 消息末尾（离模型下一次输出最近），不逐条重复刷屏。
    if (feedsFinalRound(ctx.iteration) && results.length > 0) {
      const last = results[results.length - 1];
      last.content = `${last.content}\n${FINAL_ROUND_NOTICE}`;
    }
    return results;
  },
};

/**
 * VAPID JWT 的 sub 字段：推送服务只要求它是个合法的 mailto: / https: 联系方式，
 * 内容不参与签名校验。但 scheduled() 一旦发现 email 为空就会整轮 return（一条任务
 * 都不处理、前端毫无提示），而「推送凭据」面板复制出来的 env 里 VAPID_EMAIL 是注释
 * 掉的可选项——照着部署必然缺它。所以这里给个缺省值兜底，配了就用用户配的。
 * （instant-push worker 一直是这个做法。）
 */
export const resolveVapidEmail = (raw: string | undefined): string =>
  raw?.trim() || 'mailto:noreply@sullyos.app';

/** worker 运行配置；导出便于单测钉住 VAPID 兜底。 */
export const buildWorkerConfig = (env: Env) => {
  // vapid 与 webpush 必须同源同一份：两处各读一次 env 时，改了一处漏另一处
  // 会变成「签名用兜底、校验用空值」这类只在真发推送时才暴露的坑。
  const vapid = {
    email: resolveVapidEmail(env.VAPID_EMAIL),
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  const nativeFcmReady = isFcmConfigured(env);
  // 上游在进入发送器前会检查 VAPID 字段非空；纯 FCM 部署用内部占位值通过该检查。
  // 普通 Web Push endpoint 仍只会走真实 VAPID，没配真实值时配置自检会明确提示。
  const effectiveVapid = nativeFcmReady && (!vapid.publicKey?.trim() || !vapid.privateKey?.trim())
    ? { email: vapid.email, publicKey: 'native-fcm', privateKey: 'native-fcm' }
    : vapid;
  const webpush = createHybridPushTransport(env, createWebCryptoWebPush(effectiveVapid));
  // 即时对话终态失败的直发通道拿同一份 transport（见 sendInstantErrorPush）。
  configureInstantErrorPush(env.DB && env.AMSG_MASTER_KEY
    ? { webpush, db: env.DB as unknown as InstantErrorPushDeps['db'], masterKey: env.AMSG_MASTER_KEY }
    : null);
  const onFireSettled = (info: Parameters<typeof amsgFireSettled>[0]) =>
    amsgFireSettled({ ...info, env: { DB: env.DB } });
  return {
    // db 缺省时 factory 自动用 createD1Adapter(env.DB)
    masterKey: env.AMSG_MASTER_KEY,
    serverToken: env.AMSG_SERVER_TOKEN,
    vapid: effectiveVapid,
    webpush,
    // 前端和 Worker 不同源，带自定义头的请求会先发 CORS 预检，必须放行。
    // 单用户自用默认全开；想收紧就把 '*' 换成自己的 SullyOS 站点 origin。
    cors: { origin: '*' },
    // 满血 fire-time hooks（onBeforeFire 现场填槽 + onLLMOutput 分类 +
    // executeToolCalls 服务端工具循环）；轮数/超时用库默认（5 轮 / 240s），
    // 即时对话那条单独把超时抬到 INSTANT_TOTAL_TIMEOUT_MS（onBeforeFire 返回值里给）。
    hooks: amsgHooks,
    // 租约不再显式配：amsg-server 2.6.0-next.15 起投递期间按心跳滚动续租（30s 一跳、
    // 90s TTL），fire 跑多久租约就滚多久——以前为了盖住即时对话 600s 的 fire 把
    // claimLeaseMs 定格在 12 分钟，代价是 isolate 中途死掉后任务要干等 12 分钟才被
    // 下一跳接手；心跳租约把这个恢复窗压到 ~90s，还不用管单条超时抬到多高。
    // 收尾回执 + 过期跳过回执（config 级 hook）。
    // onFireSettled: 无论这次 fire 是发出去了、跳过了还是抛错了都会调一次，self_log
    //   在这里统一落盘（见 amsgFireSettled）。不用 onAfterSend——它只在真发出去那条路
    //   触发，角色自排任务碰上「只做了副作用没说话」就会漏账变成幽灵任务。
    // onStaleSkip: 过期不补发时给面板留一句「为什么没响」（见 amsgStaleSkip）。
    onFireSettled,
    onStaleSkip: amsgStaleSkip,
    // 同一个角色的多条任务不并发跑：两条撞在一起时用户会收到两条互不知情的消息，
    // 而且 self_log 是读-改-写整份，后写的会盖掉先写的那条「我说过什么」。分组键取
    // 角色 id，上游按它同跳去重 + 跨跳看租约，被拦下的任务一个字段都不动，下一跳原样再来。
    serializeBy: (task: { metadata?: Record<string, unknown> | null }) =>
      (typeof task.metadata?.charId === 'string' ? task.metadata.charId : null),
  };
};

/** 环境自检的结论。missing 为空就能正常干活，warnings 是「能跑但有一块是哑的」。 */
export interface WorkerEnvReport {
  ok: boolean;
  /** 缺失项的变量名，`DB` 指 D1 绑定。给机器读的。 */
  missing: string[];
  /** 给人读的整句，含「去哪儿补」，前端直接显示。 */
  message: string;
  warnings: { code: string; message: string }[];
}

/** 缺了就一个请求都处理不了的两样东西，各自带一句「去哪儿补」。 */
const REQUIRED_ENV = [
  {
    key: 'DB',
    label: 'D1 数据库绑定',
    // D1 绑定不在 Variables and Secrets 那一栏，指错地方比不指还费时间。
    how: '在 Settings → Bindings 里加一条 D1 database，变量名填 DB',
    isMissing: (env: Env) =>
      typeof (env.DB as { prepare?: unknown } | null | undefined)?.prepare !== 'function',
  },
  {
    key: 'AMSG_MASTER_KEY',
    label: 'AMSG_MASTER_KEY',
    how: '在 Settings → Variables and Secrets 里加，类型选 Secret',
    isMissing: (env: Env) => !env.AMSG_MASTER_KEY?.trim(),
  },
] as const;

/**
 * 进上游库之前先看一眼 env 齐不齐。
 *
 * 存在的理由：这两样缺任何一样，上游都是在建配置那一步抛异常，被它的全局 catch
 * 吞成一句「服务器内部错误」，而那个响应还不带 CORS 头——浏览器于是连这句话都不
 * 让前端读，控制台只剩一个 "Failed to fetch"。用户拿着它既分不清是 D1 没绑还是
 * 密钥没配，也分不清是不是自己网断了。所以缺什么在这儿就说什么。
 */
export const inspectWorkerEnv = (env: Env): WorkerEnvReport => {
  const absent = REQUIRED_ENV.filter((item) => item.isMissing(env));
  const warnings: WorkerEnvReport['warnings'] = [];

  // 上游把 masterKey 当普通字符串做 SHA-256（deriveUserEncryptionKey），长度不对
  // 照样跑得动，所以只提醒不拦——拦了会把已经在正常工作的实例打挂。真正的风险是
  // 它一旦和当初不一致，之前加密存进 D1 的任务就再也解不开了。
  const masterKey = env.AMSG_MASTER_KEY?.trim();
  if (masterKey && !/^[0-9a-f]{64}$/i.test(masterKey)) {
    warnings.push({
      code: 'MASTER_KEY_FORMAT',
      message: 'AMSG_MASTER_KEY 不是 64 位十六进制，可能是粘贴时少了几位。它必须和当初生成的那一串完全一致，换一串的话已存的任务就解不开了。',
    });
  }
  // VAPID 缺了不影响读写任务，但 scheduled() 每分钟会整轮 return，到点消息一条
  // 都发不出来——而界面上一切正常，这是最难自己查出来的一种坏法。
  const vapidReady = Boolean(env.VAPID_PUBLIC_KEY?.trim() && env.VAPID_PRIVATE_KEY?.trim());
  const fcmParts = [env.FCM_PROJECT_ID, env.FCM_SERVICE_ACCOUNT_EMAIL, env.FCM_SERVICE_ACCOUNT_PRIVATE_KEY]
    .map((value) => value?.trim());
  const fcmReady = fcmParts.every(Boolean);
  if (!vapidReady) {
    warnings.push({
      // 保留既有诊断码，避免旧前端/排障脚本因为新增 FCM 通道而失配。
      code: 'VAPID_MISSING',
      message: fcmReady
        ? 'Capacitor FCM 通道已配置，但 VAPID 没配齐：原生 App 可推送，浏览器/PWA Web Push 不可用。'
        : 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 没配齐，且没有完整 FCM 配置，到点消息不会推送出去。',
    });
  }
  if (fcmParts.some(Boolean) && !fcmReady) warnings.push({
    code: 'FCM_INCOMPLETE',
    message: 'FCM 配置只填了一部分；需要同时设置 FCM_PROJECT_ID、FCM_SERVICE_ACCOUNT_EMAIL、FCM_SERVICE_ACCOUNT_PRIVATE_KEY。',
  });
  if (!env.AMSG_SERVER_TOKEN?.trim()) {
    warnings.push({
      code: 'SERVER_TOKEN_MISSING',
      message: '没设 AMSG_SERVER_TOKEN，这个 Worker 地址对公网开放，知道地址的人都能读写你的任务。',
    });
  }

  return {
    ok: absent.length === 0,
    missing: absent.map((item) => item.key),
    message: absent.length
      ? `Worker 配置不完整：${absent.map((item) => `缺 ${item.label}（${item.how}）`).join('；')}。`
      : 'Worker 配置齐全。',
    warnings,
  };
};

// 跟上游 corsHeadersFor 放行的那一份保持一致：预检放行的头少一个，正式请求就会被
// 浏览器拦下，而拦下的表现同样是没有下文的 "Failed to fetch"。
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, X-User-Id, X-Payload-Encrypted, X-Encryption-Version, X-Response-Encrypted, X-Client-Token',
  'Access-Control-Max-Age': '86400',
};

const jsonWithCors = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });

type WakeNowProfile = {
  apiUrl: string;
  apiKey: string;
  primaryModel: string;
  maxTokens?: number | null;
  temperature?: number | null;
};

type ParsedWakeNowRequest = {
  wakeId: string;
  userId: string;
  charId: string;
  firstSendTime: string;
  taskPayload: Record<string, unknown>;
};

const randomWakeId = (): string => `heartbeat-${crypto.randomUUID()}`;

const requiredWakeText = (value: unknown, name: string, maxLength: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
    throw new Error(`WAKE_NOW_INVALID_${name.toUpperCase()}`);
  }
  if (value.length > maxLength) throw new Error(`WAKE_NOW_${name.toUpperCase()}_TOO_LONG`);
  return value;
};

export const isWakeNowAuthorized = (headers: Headers, expectedToken: string | undefined): boolean => {
  const expected = expectedToken?.trim();
  if (!expected) return false;
  const bearer = headers.get('Authorization')?.trim();
  const clientToken = headers.get('X-Client-Token')?.trim();
  return bearer === `Bearer ${expected}` || clientToken === expected;
};

export const parseWakeNowRequest = async (request: Request): Promise<ParsedWakeNowRequest> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new Error('WAKE_NOW_INVALID_JSON');
  }
  if (!isRecord(body) || body.version !== 1 || body.type !== 'heartbeat') {
    throw new Error('WAKE_NOW_INVALID_TYPE');
  }

  const userId = requiredWakeText(body.userId, 'user_id', 255);
  const charId = requiredWakeText(body.charId, 'char_id', 255);
  const instruction = requiredWakeText(
    body.instruction
      ?? '这是一次自主心跳。请先查看年轮空间，再决定今天要做什么；可以写成长记录、整理记忆、调用其它 MCP，也可以保持安静。',
    'instruction',
    8_000,
  );
  if (!isRecord(body.profile)) throw new Error('WAKE_NOW_PROFILE_REQUIRED');
  const profile = body.profile as Record<string, unknown>;
  const wakeProfile: WakeNowProfile = {
    apiUrl: requiredWakeText(profile.apiUrl, 'api_url', 2_048),
    apiKey: requiredWakeText(profile.apiKey, 'api_key', 8_000),
    primaryModel: requiredWakeText(profile.primaryModel, 'primary_model', 255),
    ...(typeof profile.maxTokens === 'number' ? { maxTokens: profile.maxTokens } : {}),
    ...(typeof profile.temperature === 'number' ? { temperature: profile.temperature } : {}),
  };
  const wakeId = typeof body.wakeId === 'string' && body.wakeId.trim()
    ? requiredWakeText(body.wakeId, 'wake_id', 160)
    : randomWakeId();
  const firstSendTime = new Date().toISOString();

  return {
    wakeId,
    userId,
    charId,
    firstSendTime,
    taskPayload: {
      contactName: typeof body.contactName === 'string' && body.contactName.trim()
        ? body.contactName.trim()
        : charId,
      avatarUrl: null,
      messageType: 'auto',
      messageSubtype: 'chat',
      userMessage: null,
      firstSendTime,
      recurrenceType: 'none',
      tzId: 'UTC',
      apiUrl: wakeProfile.apiUrl,
      apiKey: wakeProfile.apiKey,
      primaryModel: wakeProfile.primaryModel,
      completePrompt: null,
      messages: null,
      maxTokens: wakeProfile.maxTokens ?? null,
      temperature: wakeProfile.temperature ?? null,
      splitPattern: null,
      metadata: {
        charId,
        source: 'heartbeat',
        amsgMode: 'heartbeat',
        amsgExpirePolicy: 'keep',
        amsgClientTaskId: wakeId,
        amsgTaskInstruction: instruction,
      },
    },
  };
};

const runDirectHeartbeatFire = async (env: Env, parsed: ParsedWakeNowRequest) => {
  const db = createD1Adapter(env.DB as { prepare: (sql: string) => unknown });
  const userKey = await deriveUserEncryptionKey(parsed.userId, env.AMSG_MASTER_KEY);
  const encryptedPayload = await encryptForStorage(JSON.stringify(parsed.taskPayload), userKey);
  const uuid = `amsg-${parsed.wakeId}`;
  await db.createTask({
    user_id: parsed.userId,
    uuid,
    encrypted_payload: encryptedPayload,
    next_send_at: parsed.firstSendTime,
    message_type: 'auto',
  });
  const task = await db.getTaskByUuidOnly(uuid);
  if (!task) throw new Error('WAKE_NOW_TASK_NOT_FOUND_AFTER_CREATE');

  if (typeof db.claimTask !== 'function') throw new Error('WAKE_NOW_CLAIM_UNSUPPORTED');
  const directDb = {
    getPendingTasks: async () => [task],
    claimTask: db.claimTask.bind(db),
    updateTaskById: db.updateTaskById.bind(db),
    deleteTaskById: db.deleteTaskById.bind(db),
    createTask: db.createTask.bind(db),
  };
  const config = buildWorkerConfig(env);
  return runScheduledTick({ ...config, db: directDb, masterKey: env.AMSG_MASTER_KEY });
};

const handleWakeNowRequest = async (request: Request, env: Env): Promise<Response> => {
  if (request.method.toUpperCase() === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (!isWakeNowAuthorized(request.headers, env.AMSG_SERVER_TOKEN)) {
    return jsonWithCors(401, {
      success: false,
      error: { code: 'WAKE_NOW_UNAUTHORIZED', message: 'Authorization is required for /wake-now.' },
    });
  }
  const report = inspectWorkerEnv(env);
  if (!report.ok) {
    return jsonWithCors(503, {
      success: false,
      error: { code: 'WORKER_CONFIG_MISSING', message: report.message, missing: report.missing },
    });
  }
  try {
    const parsed = await parseWakeNowRequest(request);
    const result = await runDirectHeartbeatFire(env, parsed);
    return jsonWithCors(202, { accepted: true, wake_id: parsed.wakeId, result });
  } catch (error) {
    console.error('[amsg:wake-now] direct fire failed', error instanceof Error ? error.message : String(error));
    return jsonWithCors(400, {
      success: false,
      error: { code: 'WAKE_NOW_FAILED', message: error instanceof Error ? error.message : String(error) },
    });
  }
};

const requirePromptAuditAuth = (request: Request, env: Env): Response | null => {
  const expected = env.AMSG_SERVER_TOKEN?.trim();
  if (!expected) {
    return jsonWithCors(403, {
      success: false,
      error: {
        code: 'PROMPT_AUDIT_TOKEN_REQUIRED',
        message: 'Prompt audit requires AMSG_SERVER_TOKEN before full prompts can be viewed.',
      },
    });
  }
  const actual = request.headers.get('X-Client-Token')?.trim();
  if (actual !== expected) {
    return jsonWithCors(401, {
      success: false,
      error: { code: 'INVALID_CLIENT_TOKEN', message: 'X-Client-Token is missing or invalid.' },
    });
  }
  return null;
};

const handlePromptAuditRequest = async (
  request: Request,
  env: Env,
  method: string,
): Promise<Response> => {
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const authError = requirePromptAuditAuth(request, env);
  if (authError) return authError;

  const report = inspectWorkerEnv(env);
  if (!report.ok) {
    return jsonWithCors(503, {
      success: false,
      error: { code: 'WORKER_CONFIG_MISSING', message: report.message, missing: report.missing },
    });
  }

  if (method === 'GET') {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') ?? PROMPT_AUDIT_DEFAULT_LIMIT);
    return jsonWithCors(200, {
      success: true,
      data: {
        entries: await listPromptAudit(env, limit),
        retentionDays: PROMPT_AUDIT_RETENTION_MS / 86400000,
      },
    });
  }

  if (method === 'DELETE') {
    return jsonWithCors(200, { success: true, data: await clearPromptAudit(env) });
  }

  return jsonWithCors(405, {
    success: false,
    error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or DELETE for prompt audit.' },
  });
};

// cron 触发时 CF 传进来的事件，只往上游转手，没必要为它引 workers-types。
type CfScheduledEvent = { scheduledTime: number; cron: string };

/** 到点多久还没被处理就算 cron 那侧出了问题。cron 每分钟一跳，留足重试余量。 */
const TICK_STALL_MINUTES = 5;

/**
 * 把上游的 schema 自查结果拆成「缺表 / 缺列」两摞。
 *
 * 上游报的形如 `table:message_outbox`、`column:scheduled_messages.last_error`、
 * `index:uidx_uuid`，而体检面板是按这两类分开说话的（缺表 → 点连接就能建好；
 * 缺列 → 是升级后没重连的典型症状）。索引归进「表」那一摞：对用户来说都是
 * 「点一次重新连接」，没必要多一个词。
 *
 * 为什么不自己列一份期望清单：手抄的那份会漏。这个判断本身要守的就是
 * 「升级后老表没长出新列、cron 每分钟静默挂」，而漏掉的恰恰会是最新加的那一列——
 * 于是体检对着一个正在挂的库回「表和列都齐了」，比不查更误导人。上游那份是从
 * 建表语句现解析出来的，它加了什么列，这里就查什么列。
 */
/** 上游 schema 自查的结果；查不了时是 null（见 inspectSchema）。 */
type SchemaProbe = Awaited<ReturnType<typeof upstream.getSchemaVersion>> | null;

/**
 * schema 自查查不动时的归类代号。**只有这四个字面量会进 /debug 回执**，异常原文一个
 * 字都不带——那上面可能挂着 SQL 片段，而这个端点是不设防的。
 *
 * 分这几档是因为用户该做的事完全不同：`unsupported` 点一下「更新 Worker」就好，
 * `denied` 是后端自己的毛病、点什么都没用，`timeout` 再体检一次多半就过了。
 * 混成一句「查不了」的话，界面只能说一句谁都用不上的废话。
 */
export type AmsgSchemaProbeError = 'unsupported' | 'denied' | 'timeout' | 'other';

/**
 * 把 schema 自查抛出来的异常归到上面四档里。
 *
 * `denied` 排在最前面，因为它的特征串最硬（D1 的授权器只会报这一种）。2026-08-09
 * 真机上撞到的就是它：新建的 D1 库里自带一张 Cloudflare 内部表 `_cf_KV`，上游遍历
 * 全库逐表问列时问到它，被 D1 一口回绝，整个自查断在第一张表上。
 */
export const classifySchemaProbeError = (error: unknown): AmsgSchemaProbeError => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const name = error instanceof Error ? error.name : '';
  if (/SQLITE_AUTH/i.test(message) || /not authorized/i.test(message)) return 'denied';
  // 老 bundle 里压根没有 getSchemaVersion，或者适配器没实现 describeSchema。
  if (/is not a function/i.test(message) || /不支持 schema 自查/.test(message)) return 'unsupported';
  if (name === 'AbortError' || name === 'TimeoutError' || /timed? ?out/i.test(message)) return 'timeout';
  return 'other';
};

export const splitSchemaMissing = (missing: string[]) => ({
  missingTables: missing
    .filter((item) => item.startsWith('table:') || item.startsWith('index:'))
    .map((item) => item.slice(item.indexOf(':') + 1)),
  missingColumns: missing
    .filter((item) => item.startsWith('column:'))
    .map((item) => item.slice('column:'.length)),
});

type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null> };
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results?: T[] }>;
  };
};

/** 推送服务判定订阅已失效时回的状态码：410 = 已注销/过期，404 = 端点根本不存在。 */
const PUSH_GONE_STATUSES = [410, 404];

/**
 * 推送到底推没推出去：最近一次被推送服务判成「这条订阅已经失效」是什么时候。
 *
 * 这是「登记状态全绿、到点一条都不来」的最后一块拼图。浏览器手里有订阅、库里也
 * 登记着同一条 endpoint，两边都自洽，但那条 endpoint 在推送服务（FCM / Mozilla /
 * Apple）那侧早就作废了，推过去只换回一个 410。这件事只有推送服务知道，前端和
 * Worker 自己都查不出来。
 *
 * 事实由上游 amsg-server 产生：投递失败时它把推送服务回的状态码结构化写进任务的
 * `last_error.pushStatus`。这里只是把它读出来——**不去解析 `reason` 那句人话**，
 * 那是给用户看的自由文本，拿它当接口用的话，上游改个措辞这里就静默失效。
 *
 * 只回状态码和时刻，不回 `last_error` 原文：那是一段没有约束的错误摘要，而
 * `/debug` 这个端点是不设防的。
 *
 * 查不成（老库还没有 last_error 列、查询被拒）返回 null = 「这一项没查出来」，
 * 界面照实说查不了，不会因此给一个假绿灯。
 */
export const inspectPushDelivery = async (
  db: D1Like,
  registeredAtMs: number | null,
): Promise<{ gone: AmsgPushGoneFailure | null; registeredAtMs: number | null } | null> => {
  try {
    // 只看有失败记录的行，按最近更新排。订阅一旦作废，每条到点的任务都会撞上同一个
    // 410，最近那次必然排在最前面——取 20 条足够，不必把整个任务表读一遍。
    const rows = await db
      .prepare(
        `SELECT last_error FROM scheduled_messages
          WHERE last_error IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 20`,
      )
      .all<{ last_error: string | null }>();

    let gone: AmsgPushGoneFailure | null = null;
    for (const row of rows.results || []) {
      let record: { at?: unknown; pushStatus?: unknown } | null = null;
      try {
        const parsed = JSON.parse(row.last_error || 'null');
        record = parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        continue; // 存进去的不是 JSON（不该发生），跳过这一条就是了
      }
      const status = Number(record?.pushStatus);
      if (!PUSH_GONE_STATUSES.includes(status)) continue;
      const atMs = Date.parse(String(record?.at ?? ''));
      if (!Number.isFinite(atMs)) continue;
      if (!gone || atMs > gone.atMs) gone = { status, atMs };
    }

    return { gone, registeredAtMs };
  } catch {
    return null;
  }
};

/**
 * 只读地看一眼库里的状况：表齐不齐、列全不全、有没有到点却没人处理的任务。
 *
 * 全程不写库，也不读任何一条任务的内容——只数数、比对 schema，以及从失败记录里
 * 认一个状态码。数出来的东西（待发条数、最老的一条过期了多久）不指向任何角色、
 * 时间点或正文。
 */
const inspectStorage = async (
  env: Env,
  probe: { schema: SchemaProbe; error: AmsgSchemaProbeError | null },
) => {
  const { schema, error: schemaError } = probe;
  const db = env.DB as D1Like | undefined;
  if (typeof db?.prepare !== 'function') return { reachable: false as const };

  try {
    const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{
      name: string;
    }>();
    const present = new Set((tables.results || []).map((row) => row.name));

    // schema 齐不齐由上游说了算（它按自己的建表语句比对，见 splitSchemaMissing）。
    //
    // 查不了（schema 为 null）时报 **null，不是 true**：这一项的全部意义就是查出
    // 「升级完 Worker 没重新连接」造成的表结构漂移——那种情况下 cron 每分钟静默失败、
    // 主动消息整个停摆，而界面处处正常。查询本身挂了却回一句「表和列都齐了」，等于在
    // 唯一能发现这件事的地方给了假绿灯，比没有这项检查更糟。让它照实说「查不了」，
    // 界面那一行显示成灰色的未知，人至少知道还得自己确认一次。
    const { missingTables, missingColumns } = splitSchemaMissing(schema?.missing ?? []);

    if (!present.has('scheduled_messages')) {
      // 主表都不在，这个不用上游背书也是确定的：库是空的。
      return { reachable: true as const, missingTables, missingColumns, schemaReady: false, schemaError };
    }
    // 主表在、但比对不出来 → 不知道。
    const schemaReady = schema ? missingTables.length === 0 && missingColumns.length === 0 : null;

    const nowIso = new Date().toISOString();
    const stats = await db
      .prepare(
        `SELECT COUNT(*) AS pending,
                SUM(CASE WHEN next_send_at <= ? THEN 1 ELSE 0 END) AS overdue,
                MIN(CASE WHEN next_send_at <= ? THEN next_send_at END) AS oldest
           FROM scheduled_messages WHERE status = 'pending'`,
      )
      .bind(nowIso, nowIso)
      .first<{ pending: number; overdue: number | null; oldest: string | null }>();

    // 一行表，条数和登记时刻一次拿全。登记时刻是判断投递失败还算不算数的标尺：
    // 重置订阅会覆盖这一行、刷新时刻，比它更早的失败都是上一条订阅的旧账。
    const pushRow = present.has('push_subscriptions')
      ? await db
        .prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS updatedAt FROM push_subscriptions')
        .first<{ n: number; updatedAt: number | null }>()
      : null;

    return {
      reachable: true as const,
      schemaReady,
      // null = 这次自查跑成了。有值时 schemaReady 必然是 null，界面照它选该说哪句话。
      schemaError,
      missingTables,
      missingColumns,
      // 单用户 worker 只存一行。到点却发不出去最常见的原因就是这行是空的——
      // 换了一台 worker 之后云端订阅是空的，而浏览器那侧的订阅一个字都没变。
      pushSubscriptionRegistered: (pushRow?.n ?? 0) > 0,
      pushDelivery: await inspectPushDelivery(db, pushRow?.updatedAt ?? null),
      pendingTasks: stats?.pending ?? 0,
      overdueTasks: stats?.overdue ?? 0,
      oldestOverdueMinutes: stats?.oldest
        ? Math.floor((Date.now() - Date.parse(stats.oldest)) / 60000)
        : null,
    };
  } catch (error) {
    // 报错类型而不是原文：原文可能带 SQL 片段，而这个端点是不设防的。
    return { reachable: false as const, error: (error as Error)?.name || 'QueryFailed' };
  }
};

/**
 * cron 到底在不在跑。
 *
 * 不写心跳，靠「有没有到点了还没被处理的任务」反推——心跳要往用户库里建表、每分钟
 * 写一次，而这个判断纯读、零副作用，问的还正好是用户真正关心的那件事（任务有没有
 * 被按时处理），比「tick 有没有触发」更贴。代价是手上没有待发任务时无从判断，那种
 * 情况下 cron 停没停也确实不影响什么。
 */
const judgeTick = (storage: Awaited<ReturnType<typeof inspectStorage>>) => {
  if (!storage.reachable || !('pendingTasks' in storage)) return 'unknown';
  if (!storage.pendingTasks) return 'idle';
  const overdueMinutes = storage.oldestOverdueMinutes;
  if (overdueMinutes === null || overdueMinutes < TICK_STALL_MINUTES) return 'healthy';
  return 'stalled';
};

/** DO 存「这个实例负责哪条任务」用的 storage 键。 */
const INSTANT_TICK_UUID_KEY = 'taskUuid';

const upstream = createSingleUserCloudflareWorker(buildWorkerConfig, {
  /**
   * cron 那条路上没有调用方能看到错误响应——上游把异常 catch 掉之后，整轮就这么无声
   * 结束了。表结构漂移（升级后老表没加列）撞上的正是这里：cron 每分钟静默失败、
   * 主动消息整个停摆，而界面上一切正常，没人知道出了事。
   *
   * 这个 hook 是那条路唯一的出口，所以什么都不做也要把它记下来。
   */
  onError({ stage, cause, path }) {
    const where = path ? `${stage} ${path}` : stage;
    console.error(`[amsg:upstream-error] ${where} → ${cause.name}: ${cause.message}`);
  },
});

/**
 * 库的表结构跟当前这版代码对不对得上。
 *
 * 这是「升级完 Worker 却没重新连接」的唯一可查证据：表结构漂移（新版要的列老表没有）
 * 之后，cron 每分钟静默失败、主动消息整个停摆，而配置自检、任务列表、界面全都正常，
 * 隔着屏幕根本问不出来。missing 里会直接点名缺哪张表、哪一列。
 *
 * 查不了不算错（D1 没绑之类）——报 null，让面板照旧显示其余部分。
 *
 * 但**为什么查不了要一起带出去**：只往日志里写一行的话，用户看到的永远是一句
 * 「查不了，不知道」，而这句话对他做什么毫无帮助，隔着屏幕也问不出来。归类见
 * classifySchemaProbeError。
 */
const inspectSchema = async (env: Env): Promise<{ schema: SchemaProbe; error: AmsgSchemaProbeError | null }> => {
  try {
    return { schema: await upstream.getSchemaVersion(env), error: null };
  } catch (error) {
    const kind = classifySchemaProbeError(error);
    console.warn(`[amsg:debug] schema 查不了（${kind}）`, error);
    return { schema: null, error: kind };
  }
};

/**
 * 即时对话的起跳器：把「立刻跑这一条」搬进 Durable Object 的 alarm 里。
 *
 * 为什么非得是 DO：客户端发完就走（切后台、锁屏、杀进程都行），所以这一跳不能挂在
 * 那个已经回了 202 的 HTTP 请求上——`ctx.waitUntil` 只给 30 秒，一轮带工具循环的生成
 * 必被砍在半路。Cloudflare 上能「不依赖客户端连接 + 长墙钟」的入口只有三个：
 * Cron Trigger、Queue consumer、DO alarm，都是 15 分钟。这里选 DO 是因为它不用预建
 * 任何资源（namespace 随 Worker 上传自动创建），一键部署那条路一个额外 API 调用都不用加。
 *
 * **一条任务一个实例**（实例名 = 任务 uuid），所以几条聊天同时在跑互不排队。
 * 每个实例只碰自己那一条（`upstream.runTask(uuid)`），不会去扫别人的任务。
 *
 * cron 仍然留着：它是所有定时任务的正常投递通道，同时也是这一跳万一没跑成时的兜底。
 */
export class InstantTickDO extends DurableObject<Env> {
  /**
   * 叫醒：记下要跑哪条、设一个立刻到期的 alarm，然后马上返回——调用方还等着回 202。
   *
   * 已经挂着 alarm 就只覆盖 uuid 不重设时间：同一个实例只服务同一条任务，重复叫醒
   * （客户端重发）应该合并成一次，而不是排成两次生成。
   */
  async kick(uuid: string): Promise<void> {
    await this.ctx.storage.put(INSTANT_TICK_UUID_KEY, uuid);
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(Date.now());
  }

  /** 独立 invocation，15 分钟墙钟。跑挂了不重设 alarm——下一分钟的 cron 会接着捡。 */
  async alarm(): Promise<void> {
    const uuid = await this.ctx.storage.get<string>(INSTANT_TICK_UUID_KEY);
    if (!uuid) {
      console.error('[amsg:instant-tick] alarm 醒了却不知道要跑哪条，跳过（等 cron 兜底）');
      return;
    }
    const report = inspectWorkerEnv(this.env);
    if (!report.ok) {
      console.error(`[amsg:instant-tick] 整轮跳过：${report.message}`);
      return;
    }
    // 跑完就把 uuid 清掉：这个实例的活儿到此为止，留着只会让下一次 kick 分不清新旧。
    // 放在 runTask 之前清是不行的——中途被回收就查不出这条到底跑没跑。
    const result = await upstream.runTask(uuid, this.env);
    await this.ctx.storage.delete(INSTANT_TICK_UUID_KEY);
    if (!result.ran) {
      // 一次性任务发完即删，所以 not_found 多半是「cron 抢先跑掉了」，属正常。
      // 其余几种（未到期、退避窗口里、配置不全）留一行，排障时能看出是哪种。
      console.warn(`[amsg:instant-tick] ${uuid} 没跑：${result.reason}`);
    }
  }
}

/**
 * 版本号只有上游的 capabilities 才给，转手问它一次；问不到不算错，报 null。
 * 配置不全时直接不问：那一问必然失败，还会在 Cloudflare 日志里留一条
 * 「fetch() unhandled error」——排障的人正盯着日志看，别给他添噪音。
 */
const readServerVersion = async (request: Request, env: Env) => {
  if (!inspectWorkerEnv(env).ok) return null;
  try {
    const url = new URL(request.url);
    url.pathname = '/capabilities';
    url.search = '';
    const response = await upstream.fetch(new Request(url.toString(), { headers: request.headers }), env);
    if (response.status !== 200) return null;
    const body = await response.json() as { serverVersion?: string; features?: string[] };
    return { version: body.serverVersion ?? null, featureCount: body.features?.length ?? 0 };
  } catch {
    return null;
  }
};

/**
 * 在上游 worker 外面包一层配置自检。多出来的四个行为：
 *   GET  /config-check  配置齐不齐（只读 env，前端「连接并验证」用的就是它）
 *   GET  /debug         上面那些再加库和 cron 的状况，给隔着屏幕帮人排障用
 *   POST /instant-chat  即时对话：一个请求受理一轮聊天（见 ./instantChat）
 *   POST /self-update   自己去取最新代码覆盖自己（见 ./selfUpdate，要共享密钥 + CF_API_TOKEN）
 *   其它请求            配置不全时直接 503 + 说明缺什么，不进上游
 */
// 两个 handler 都只收 (request/event, env)：CF 还会给第三个参数 ctx，但这里用不上——
// /instant-chat 回完 202 之后的那一跳跑在 InstantTickDO 的 alarm 里，不占这个请求的
// 生命周期（waitUntil 只有 30 秒，见 InstantTickDO 的注释）。
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    if (pathname.endsWith('/wake-now')) {
      return handleWakeNowRequest(request, env);
    }

    if (pathname.endsWith('/config-check')) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      // 刻意不校验 X-Client-Token：worker 配了口令而前端没填正是要诊断的情形之一，
      // 校验了就查不出来。作为交换，这里只回「配没配」，不回任何值。
      //
      // 三个能力标志，各答各的问题，前端全都要：
      //
      //   instantChat  这份代码里有没有 /instant-chat 这条路由。老 bundle 没有这个字段。
      //   instantTick  起跳器（INSTANT_TICK 绑定）接上了没有——**即时对话真正能不能用**看它。
      //   workerVersion 这份 bundle 自己的版本，跟前端编译进去的同一个常量比，不一样就该更新。
      //
      // 为什么「有路由」和「能用」得分开报：自更新是由**用户当前那台 Worker 上的旧代码**
      // 执行的，而旧代码不认识 Durable Object，所以它传上去的新 bundle 是不带 INSTANT_TICK
      // 绑定的——代码是新的、版本号也对上了，`/instant-chat` 却只能回 503。这中间态没有
      // 单独的信号的话，前端会一边说「已经是最新版」一边发一条挂一条。再点一次更新（这次
      // 跑的是新代码，会把绑定补上）就好，而让用户知道「还得再点一次」的正是这个字段。
      //
      // 同理，以后再加别的绑定也会撞上同一堵墙：自更新永远由旧代码执行。所以判断「能不能
      // 用」一律看运行时真的有没有那个绑定，别看版本号。
      return jsonWithCors(200, {
        success: true,
        data: {
          ...inspectWorkerEnv(env),
          instantChat: true,
          instantTick: !!env.INSTANT_TICK,
          workerVersion: AMSG_BUNDLE_VERSION,
        },
      });
    }

    if (pathname.endsWith('/debug')) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      // 全只读、也不设防，所以能报什么是有边界的：只有配置齐不齐、schema 对不对、
      // 数出来的条数，以及本来就公开的 VAPID 公钥。密钥的值、用户标识、任务正文、
      // 推送 endpoint 一概不出现——不是没取到，是刻意不取。
      const probe = await inspectSchema(env);
      const storage = await inspectStorage(env, probe);
      return jsonWithCors(200, {
        success: true,
        data: {
          now: new Date().toISOString(),
          config: inspectWorkerEnv(env),
          server: await readServerVersion(request, env),
          storage,
          tick: judgeTick(storage),
          schema: probe.schema,
          vapidPublicKey: env.VAPID_PUBLIC_KEY?.trim() || null,
        },
      });
    }

    if (pathname.endsWith('/self-update')) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (method !== 'POST') {
        return jsonWithCors(405, {
          success: false,
          error: { code: 'METHOD_NOT_ALLOWED', message: '/self-update 只接受 POST' },
        });
      }
      // 排在下面那道配置门之前：配置缺了一半正是想更新一版试试的时候，
      // 被门挡住反而没法自救。它自己校验共享密钥，不吃这道门的豁免。
      const result = await handleSelfUpdate(request, env);
      return jsonWithCors(result.ok ? 200 : 400, {
        success: result.ok,
        data: result.ok ? result : undefined,
        error: result.ok ? undefined : { code: result.code, message: result.message },
      });
    }

    if (pathname.endsWith('/prompt-audit')) {
      return handlePromptAuditRequest(request, env, method);
    }

    const report = inspectWorkerEnv(env);
    if (!report.ok) {
      // 预检也得放行：带自定义头的请求会先发 OPTIONS，这一步被挡住的话正式请求
      // 根本发不出去，下面那句 503 用户就永远看不到。
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      return jsonWithCors(503, {
        success: false,
        error: { code: 'WORKER_CONFIG_MISSING', message: report.message, missing: report.missing },
      });
    }

    if (pathname.endsWith('/init-tenant') && method === 'POST') {
      const response = await upstream.fetch(request, env);
      if (response.status >= 200 && response.status < 300) {
        try {
          await ensurePromptAuditSchema(env);
        } catch (error) {
          console.warn('[amsg:prompt-audit] schema init failed', error);
          return jsonWithCors(500, {
            success: false,
            error: { code: 'PROMPT_AUDIT_SCHEMA_FAILED', message: 'Prompt audit table init failed.' },
          });
        }
      }
      return response;
    }

    // 即时对话：一个请求把「传云端状态 + 建任务」串完，回 202 之后立刻起一跳。
    // 排在配置门之后，所以走到这里 D1 和密钥必然都在。
    if (pathname.endsWith('/instant-chat')) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (method !== 'POST') {
        return jsonWithCors(405, {
          success: false,
          error: { code: 'METHOD_NOT_ALLOWED', message: '/instant-chat 只接受 POST' },
        });
      }
      return handleInstantChat({ request, env, upstream, json: jsonWithCors });
    }

    return upstream.fetch(request, env);
  },

  async scheduled(event: CfScheduledEvent, env: Env): Promise<void> {
    // 定时任务这条路没人看得见，配置不全时上游只会抛一个堆栈。写明白点，
    // wrangler tail 里一眼能看出是配置问题还是任务本身挂了。
    const report = inspectWorkerEnv(env);
    if (!report.ok) {
      console.error(`[amsg] 定时任务整轮跳过：${report.message}`);
      return;
    }
    // 整轮出错时上游把原因放在返回值里（同一份也会经 onError 记一行）。这里不再重复
    // 打印，但要把它咽掉——CF 不看 scheduled 的返回值，往外抛只会变成一条没上下文的堆栈。
    await upstream.scheduled(event, env);
  },
};
