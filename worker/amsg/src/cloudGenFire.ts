/**
 * 代跑任务在 Worker 这一侧（「本机拼、云端代跑」，契约见 utils/amsgCloudGenJob.ts）。
 *
 * 浏览器已经把这次请求的 messages 拼好、和参数一起交上来，这里不理解任何业务：
 * 到点把 messages 原样交给模型，模型回来把正文、思考、结束原因存成附件，用 emitResult
 * 把附件引用送回客户端。推送文案也是客户端给的，Worker 只照着发。
 *
 * 失败也必须送回去：代跑不做生成重试（maxGenerationRetries = 0），客户端那边有一条
 * 「云端生成中」的登记在等，不告诉它就只能等 20 分钟的点名兜底。所以 fire 收尾时
 * （settleCloudGenFire，挂在 onFireSettled 上）凡是没送出成功结果的，都补一条 ok:false。
 */

import { AMSG_JOB_ID_KEY, readTaskKind } from '../../../utils/amsgTaskKinds';
import {
  CLOUD_GEN_KIND,
  CLOUD_GEN_NAMESPACE,
  CLOUD_GEN_PURPOSE_META_KEY,
  CLOUD_GEN_TOTAL_TIMEOUT_MS,
  type CloudGenJobInput,
  type CloudGenUsage,
  buildCloudGenResult,
  cloudGenJobKey,
  isCloudGenPurpose,
  parseCloudGenJobInput,
} from '../../../utils/amsgCloudGenJob';
import { unpackStateValue } from '../../../utils/amsgFirePack';
import { makeModelCall } from '../../../utils/amsgApiCallRecords';
import { readAssistantMessage } from '../../../utils/assistantThinking';
import type { FireKindHandler, KindWriteState } from './fireKinds';

interface CloudGenFireState {
  jobId: string;
  job: CloudGenJobInput;
}

/** 成功结果送出去之后在 scratch 上留的记号，收尾时据此不再补失败结果。 */
const EMITTED_SCRATCH_KEY = 'cloudGenEmitted';

/** 输入是一次性的：走完这一轮就删，删不掉等 TTL。 */
const discardJob = async (writeState: KindWriteState | undefined, jobId: string): Promise<void> => {
  if (!writeState) return;
  try {
    await writeState(CLOUD_GEN_NAMESPACE, [{ key: cloudGenJobKey(jobId), value: null }]);
  } catch (error) {
    console.warn('[amsg:cloud-gen] 输入行没删掉（等 TTL 兜底）', jobId, error);
  }
};

const usageOf = (usage: unknown, response: unknown): CloudGenUsage | undefined => {
  const call = makeModelCall({ index: 1, completedAt: Date.now(), causes: [], ok: true, usage: usage ?? undefined, response });
  const out: CloudGenUsage = {
    ...(call.promptTokens !== undefined ? { promptTokens: call.promptTokens } : {}),
    ...(call.completionTokens !== undefined ? { completionTokens: call.completionTokens } : {}),
    ...(call.cacheReadTokens !== undefined ? { cacheReadTokens: call.cacheReadTokens } : {}),
    ...(call.cacheWriteTokens !== undefined ? { cacheWriteTokens: call.cacheWriteTokens } : {}),
    ...(call.backendModel ? { backendModel: call.backendModel } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
};

export const cloudGenHandler: FireKindHandler = {
  async beforeFire({ ctx, charId, taskMeta }) {
    const jobId = taskMeta[AMSG_JOB_ID_KEY];
    if (typeof jobId !== 'string' || !jobId) throw new Error(`代跑任务的 metadata 里没有 ${AMSG_JOB_ID_KEY}`);

    const rows = await ctx.readState(CLOUD_GEN_NAMESPACE);
    const row = rows.find((r) => r.key === cloudGenJobKey(jobId));
    // 行不在 = 过期被清；值是空的 = 客户端撤回了（起跳失败转本机、删角色）。不算坏数据，
    // 收尾那步会给客户端补一条失败结果。
    if (!row?.value) return { skip: true, reason: `代跑 job ${jobId} 的输入已不在（过期或已撤销）` };

    // 下面几种是确定性失败，重来也是同一份坏数据：认定的同时就删行。
    const discardAndFail = async (message: string): Promise<never> => {
      await discardJob(ctx.writeState, jobId);
      throw new Error(message);
    };
    let json: string;
    try {
      json = await unpackStateValue(row.value);
    } catch (error) {
      return discardAndFail(`代跑 job ${jobId} 的输入解压失败（数据损坏）：${String(error)}`);
    }
    const job = parseCloudGenJobInput(json);
    if (!job) return discardAndFail(`代跑 job ${jobId} 的输入解析失败（数据损坏）`);
    if (job.charId !== charId || job.jobId !== jobId || job.purpose !== taskMeta[CLOUD_GEN_PURPOSE_META_KEY]) {
      return discardAndFail(`代跑 job ${jobId} 的输入与任务对不上`);
    }

    return {
      messages: job.messages,
      totalTimeoutMs: CLOUD_GEN_TOTAL_TIMEOUT_MS,
      state: { jobId, job } satisfies CloudGenFireState,
    };
  },

  async llmOutput({ ctx, state }) {
    const { jobId, job } = state as CloudGenFireState;
    const choice = (ctx.llmResponse as { choices?: Array<Record<string, unknown>> } | null)?.choices?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    // 正文和思考按明确字段分开（与本地解析同一个读法），不拿思考补空正文。
    const { content, reasoning } = message
      ? readAssistantMessage(message)
      : { content: ctx.llmOutputText || '', reasoning: '' };
    const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;

    if (typeof ctx.storeAttachment !== 'function' || typeof ctx.emitResult !== 'function') {
      throw new Error('CLOUD_GEN_UNSUPPORTED: 这台 Worker 没有附件或结果箱，请更新 Worker');
    }
    // 结果一律走附件：人格模拟一份就超过推送上限，只留一条路，不按大小分支。
    const attachment = await ctx.storeAttachment(
      JSON.stringify({ v: 1, content, reasoning, finishReason }),
      { owner: { type: 'character', id: job.charId }, kind: CLOUD_GEN_KIND },
    );
    const usage = usageOf((ctx as { usage?: unknown }).usage, ctx.llmResponse);
    await ctx.emitResult({
      ...buildCloudGenResult({
        ok: true, jobId, purpose: job.purpose, charId: job.charId, attachment, ...(usage ? { usage } : {}),
      }),
      notification: job.notify ? { show: 'always', title: job.notify.title, body: job.notify.body } : { show: false },
    });
    if (ctx.scratch) ctx.scratch[EMITTED_SCRATCH_KEY] = true;
    return { decision: 'skip-push', reason: 'cloud-gen-result-emitted' };
  },
};

/** 上游 onFireSettled 回执里这里用得上的字段。 */
export interface CloudGenSettleInfo {
  status?: string;
  skipReason?: string | null;
  willRetry?: boolean | null;
  error?: unknown;
  metadata?: Record<string, unknown> | null;
  usage?: unknown;
  scratch: Record<string, unknown>;
  writeState?: KindWriteState;
  emitResult?: (payload: Record<string, unknown>) => Promise<unknown>;
}

const errorCodeOf = (info: CloudGenSettleInfo): string => {
  const code = (info.error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return code;
  if (info.status === 'skipped') return 'input-missing';
  return 'generation-failed';
};

const errorMessageOf = (info: CloudGenSettleInfo): string => {
  if (info.status === 'skipped') return '云端没找到这次的输入（已过期或已撤销）';
  const error = info.error;
  if (error instanceof Error) return error.message;
  return typeof error === 'string' && error ? error : '云端生成失败';
};

/**
 * 代跑任务的收尾：删输入行；没送出成功结果的补一条失败结果。不是代跑任务返回 false。
 *
 * 取消（客户端起跳失败转本机时会取消）不补：那是客户端自己的决定，而且取消后结果箱也不收。
 */
export async function settleCloudGenFire(info: CloudGenSettleInfo): Promise<boolean> {
  const meta = info.metadata ?? {};
  if (readTaskKind(meta) !== CLOUD_GEN_KIND) return false;
  const jobId = typeof meta[AMSG_JOB_ID_KEY] === 'string' ? meta[AMSG_JOB_ID_KEY] as string : '';
  const charId = typeof meta.charId === 'string' ? meta.charId : '';
  const purpose = meta[CLOUD_GEN_PURPOSE_META_KEY];

  if (jobId && info.willRetry !== true) await discardJob(info.writeState, jobId);

  if (info.scratch?.[EMITTED_SCRATCH_KEY] === true) return true;
  if (info.status !== 'failed' && info.status !== 'skipped') return true;
  if (!jobId || !charId || !isCloudGenPurpose(purpose) || typeof info.emitResult !== 'function') {
    console.warn('[amsg:cloud-gen] 失败结果送不回去（任务身份不全或没有结果箱）', { jobId, status: info.status });
    return true;
  }
  const usage = usageOf(info.usage, null);
  try {
    await info.emitResult({
      ...buildCloudGenResult({
        ok: false, jobId, purpose, charId,
        error: { code: errorCodeOf(info), message: errorMessageOf(info) },
        ...(usage ? { usage } : {}),
      }),
      notification: { show: false },
    });
  } catch (error) {
    console.warn('[amsg:cloud-gen] 失败结果没送进结果箱（客户端靠点名兜底）', jobId, error);
  }
  return true;
}
