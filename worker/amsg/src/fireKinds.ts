/**
 * 按任务种类分派的注册表。
 *
 * 到点触发只有 `onBeforeFire` 一个入口，所有任务都从那儿进——聊天要发的、后台要整理的，
 * 全挤在同一个函数里。这里立一张 `kind → handler` 的表把非聊天的那些接走，加一种新任务
 * 就是加一个文件 + 在表里加一行，不用去动那条已经很长的聊天主干。
 *
 * 分派点刻意排在聊天那四道门**之前**：那四道门问的都是「主动消息到点还该不该发」
 * （用户正在聊天所以让路 / 对话已经往前走所以作废 / 这次任务的方向是什么），对
 * 「后台整理一份数据」全都不适用；而且它们要的 fire_pack / tool_pack 是聊天专用的
 * 云端状态，后台任务根本没传过。
 *
 * 这里只做业务分派，不该放上游——上游只需要知道「有个 hook」，不需要知道「有种任务
 * 叫门牌整理」。
 */

import { readTaskKind } from '../../../utils/amsgTaskKinds';
import { PLATE_CONSOLIDATE_KIND } from '../../../utils/amsgPlateJob';
import { plateConsolidateHandler } from './plateFire';
import { reproductionHandler } from './reproduction';

/** client_state 的写入口（value 传 null 即删除该 key）。 */
export type KindWriteState = (
  namespace: string,
  entries: Array<{ key: string; value: string | null; updatedAt?: number }>,
) => Promise<{ upserted: number; skipped: number; deleted: number }>;

/**
 * handler 用得上的那部分 fire ctx。
 *
 * 结构化取一份而不是从 index.ts import FireCtx：那边要 import 这里的注册表，
 * 反过来再 import 类型就成了循环。字段是 FireCtx 的子集，结构上天然兼容。
 */
export interface KindFireCtx {
  task: {
    id?: string | number | null;
    uuid?: string | null;
    metadata?: Record<string, unknown>;
  };
  readState: (namespace: string) => Promise<Array<{ key: string; value: string }>>;
  writeState?: KindWriteState;
  now: Date;
  scratch: Record<string, unknown>;
}

/** handler 用得上的那部分每轮 session ctx。 */
export interface KindSessionCtx {
  llmOutputText: string;
  /** 以下三项只给跳过诊断用（见 ./skipDiagnostics），上游每轮都会给。 */
  sessionId?: string;
  iteration?: number;
  llmResponse?: unknown;
  scratch?: Record<string, unknown>;
  writeState?: KindWriteState;
  /**
   * 往客户端送一条**不是聊天内容**的结果（amsg-server 2.6.0-next.21+）。
   * 一条结果落进服务端收件箱（到达的保证）+ 视通知策略发一条 Web Push（及时性）。
   * 老部署上这个方法不存在——handler 自己判，别假设它在。
   */
  emitResult?: (payload: Record<string, unknown>) => Promise<{ messageId: string; pushed: boolean }>;
}

/** 到点这一步的结论：要么安静跳过，要么给出这次要问 LLM 的话。 */
export type KindFirePlan =
  | { skip: true; reason: string }
  | {
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      /** 跨到 onLLMOutput 的上下文，库把它原样挂在 scratch 上带过去 */
      state: unknown;
      /** 这一次 fire 单独放宽超时（要同步调 claimLeaseMs 的那个值，库自己管） */
      totalTimeoutMs?: number;
    };

/** LLM 回来这一步的结论；诊断消息用正式推送，其他后台产物通常走 emitResult。 */
export type KindDecision = { decision: 'skip-push'; reason: string }
  | { decision: 'finish'; pushPayloads: Array<Record<string, unknown>> };

export interface FireKindHandler {
  /**
   * 到点：读云端状态、拼这次要问 LLM 的话。
   * 出了「这条任务的数据坏了」这种硬失败就抛——调用方会用统一那套 detail 包一层。
   */
  beforeFire(args: {
    ctx: KindFireCtx;
    charId: string;
    taskMeta: Record<string, unknown>;
  }): Promise<KindFirePlan>;

  /** LLM 回来：解析、把结果送回客户端。 */
  llmOutput(args: { ctx: KindSessionCtx; state: unknown }): Promise<KindDecision>;
}

/**
 * `metadata.amsgKind` → handler。没标 kind 的任务不查这张表，照旧走聊天主干。
 * 表里没有的 kind 是硬失败：客户端建了一种 worker 还不认识的任务，多半是 worker bundle
 * 比前端旧，宁可让这条任务终态失败，也别当聊天任务跑出一条驴唇不对马嘴的消息。
 *
 * 这类失败在用户那边是**静默**的：后台任务行按 messageSubtype 挡在主动消息清单之外
 * （那是有意的，它们不是用户排的消息，进了清单还会被「取消全部」顺手掐掉），所以
 * lastError 没有露脸的地方，只能在 `wrangler tail` 里看到。判定「这一轮活儿要不要交
 * 云端」的责任因此落在客户端那道探测门上（`GET /config-check` 的 `backgroundJobs`）：
 * 它认的是「这份 bundle 里有没有这张表」，认不出来就留在本地跑，压根不建这条任务。
 * 走到这里的失败一律是「白跑一轮」量级——下一轮消化会重新提交一份。
 *
 * 表用**没有原型的对象**建：kind 是从任务 metadata 上读出来的字符串，普通对象字面量
 * 会把 `constructor` / `toString` / `valueOf` 这些原型链上的键解析成一个真值，绕过下面
 * 那句「表里没有这个 kind」的判断，最后炸在 `handler.beforeFire is not a function` 上——
 * 而那句报错跟真正的原因（这台 worker 不认识这种任务）毫无关系，排障要多绕一大圈。
 */
export const FIRE_KIND_HANDLERS: Record<string, FireKindHandler> = Object.assign(
  Object.create(null) as Record<string, FireKindHandler>,
  { [PLATE_CONSOLIDATE_KIND]: plateConsolidateHandler, diagnostic: reproductionHandler },
);

/** 挂在 scratch 上跨 hook 传递的键。 */
const KIND_FIRE_SCRATCH_KEY = 'kindFire';

interface KindFireStash {
  kind: string;
  state: unknown;
}

export const putKindFireStash = (scratch: Record<string, unknown>, kind: string, state: unknown): void => {
  scratch[KIND_FIRE_SCRATCH_KEY] = { kind, state } satisfies KindFireStash;
};

/** onLLMOutput 用它判「这一轮是不是非聊天任务」；不是就返回 null，照旧走聊天主干。 */
export const getKindFireStash = (scratch: Record<string, unknown> | undefined): KindFireStash | null => {
  const raw = scratch?.[KIND_FIRE_SCRATCH_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const stash = raw as Partial<KindFireStash>;
  return typeof stash.kind === 'string' ? { kind: stash.kind, state: stash.state } : null;
};

export { readTaskKind };
