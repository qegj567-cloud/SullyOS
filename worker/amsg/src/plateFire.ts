/**
 * 门牌整理任务在 worker 这一侧。
 *
 * 客户端把「现有条目 + 新材料 + 身份上下文」装成一份 job 写进 client_state，再建一条
 * 标了 `amsgKind: 'plate-consolidate'` 的任务。到点这里把 job 读回来拼提示词，LLM 跑完
 * 把整理结果原样送回客户端——合并语义（basedOn 继承来历、没被重新输出的条目淘汰）留在
 * 客户端做，因为要合并进去的门牌本体在浏览器的 IndexedDB 里，云端够不着。
 *
 * 结果走 `ctx.emitResult`：落进服务端收件箱，客户端下次上线 `GET /outbox?since=` 一定
 * 拿得到。刻意**不弹通知**（`notification: { show: false }`）——门牌整理是背景工作，
 * 整理完了不该把人叫回来看；带 `show: false` 的 payload 上游只落行不推送，也就不会
 * 白占一次推送配额（订阅是按 userVisibleOnly 建的，收了 push 不弹通知浏览器要记账）。
 */

import { AMSG_JOB_ID_KEY, AMSG_JOB_NAMESPACE } from '../../../utils/amsgTaskKinds';
import {
  PLATE_CONSOLIDATE_RESULT_KIND,
  type PlateJobInput,
  buildPlateConsolidateResult,
  buildPlateJobMessages,
  parsePlateJobInput,
  plateJobKey,
} from '../../../utils/amsgPlateJob';
import { unpackStateValue } from '../../../utils/amsgFirePack';
import { PLATE_LLM_TIMEOUT_MS, parsePlateLlmReply } from '../../../utils/memoryPalace/roomPlateCore';
import type { FireKindHandler, KindFireCtx, KindSessionCtx, KindWriteState } from './fireKinds';
import { logSkipDiagnostic } from './skipDiagnostics';

/** 跨到 onLLMOutput 的上下文。 */
export interface PlateFireState {
  jobId: string;
  job: PlateJobInput;
}

/**
 * 把 job 那行删掉：它是一次性输入，走完这一轮就再没人会读它。
 *
 * 两种时机要删：
 *   - **LLM 已经跑过之后**，不管结果好坏。这一轮无论成没成，上游都把这条
 *     `recurrenceType: 'none'` 的任务当办完了（skip-push 在上游是 `status: 'skipped'`
 *     的成功态），再没有第二次机会来读这行。
 *   - **beforeFire 认定这份输入坏了/不对版的时候**。那几种失败是确定性的（解压不出来、
 *     形状对不上、charId 对不上号），重试梯子再跑两遍也是同样的结果，行留着纯粹是占地方。
 *     注意别把「读进来到 LLM 跑完之间」的失败也算进去——那种还会重试，重试时得再读一遍。
 *
 * 不删的话每次失败都留一行孤儿，一行装着一个角色的整块门牌原文 + 蒸馏材料 + 身份上下文，
 * 在同一个共用命名空间里跨角色越攒越多，而 beforeFire 每次后台 fire 都要把这个命名空间
 * 整个读出来解密（上游没有按 key 点名的接口）。
 *
 * 删失败只记日志：命名空间上配了 clientStateTtl，cron 每跳会兜底清过期的。
 */
const discardJob = async (writeState: KindWriteState | undefined, jobId: string): Promise<void> => {
  if (!writeState) return;
  try {
    await writeState(AMSG_JOB_NAMESPACE, [{ key: plateJobKey(jobId), value: null }]);
  } catch (error) {
    console.warn('[amsg:plate] job 行没删掉（等 TTL 兜底）', jobId, error);
  }
};

export const plateConsolidateHandler: FireKindHandler = {
  async beforeFire({ ctx, charId, taskMeta }) {
    const jobId = taskMeta[AMSG_JOB_ID_KEY];
    if (typeof jobId !== 'string' || !jobId) {
      throw new Error(`门牌整理任务的 metadata 里没有 ${AMSG_JOB_ID_KEY}`);
    }

    // 只能整个命名空间读回来再挑：`readState` 按 namespace 取，上游没有按 key 点名的
    // 接口。同一角色同时只许一份整理在飞、跑完立刻删行，所以这里通常只有个位数条。
    const rows = await ctx.readState(AMSG_JOB_NAMESPACE);
    const row = rows.find((r) => r.key === plateJobKey(jobId));
    if (!row?.value) {
      // 行不在了 = 躺太久被 TTL 清了；行在但值是空的 = 客户端主动撤了这份输入（删角色
      // 时会把它写成空壳——HTTP 那侧没有删除语义）。两种都不是「坏了」，重试也不会长
      // 出来：安静跳过，该重来的下一轮消化会重新提交一份。
      return { skip: true, reason: `门牌整理 job ${jobId} 的输入已不在（过期或已撤销）` };
    }

    // 下面这几种失败都是确定性的：重试再读一遍还是同一份坏数据。所以认定的同时就把行
    // 删掉，别让它在共用命名空间里躺满 TTL——每一份都是一个角色的整块门牌原文，而每次
    // 后台 fire 都要把整个命名空间读出来解密才能挑出自己那一行。
    const discardAndFail = async (message: string): Promise<never> => {
      await discardJob(ctx.writeState, jobId);
      throw new Error(message);
    };

    // 上传时压过（gz1: 前缀），跟 fire_pack 同一套；没压过的原样穿过去。
    let json: string;
    try {
      json = await unpackStateValue(row.value);
    } catch (error) {
      return discardAndFail(`门牌整理 job ${jobId} 的输入解压失败（数据损坏）：${String(error)}`);
    }

    const job = parsePlateJobInput(json);
    if (!job) return discardAndFail(`门牌整理 job ${jobId} 的输入解析失败（数据损坏）`);
    if (job.charId !== charId) {
      return discardAndFail(`门牌整理 job ${jobId} 的 charId 与任务对不上`);
    }
    if (job.rooms.length === 0) {
      await discardJob(ctx.writeState, jobId);
      return { skip: true, reason: `门牌整理 job ${jobId} 没有要整理的房间` };
    }

    return {
      messages: buildPlateJobMessages(job),
      // 跟浏览器那条路同一个超时（叶子里那个常量）。不显式交上去的话这一次 fire 会落到
      // 库自己的默认值（四分钟），同一件活儿两条路的耐心不一样，而且改那个常量对云端
      // 毫无影响——「本地什么样云端就什么样」这条线得自己拉齐。
      totalTimeoutMs: PLATE_LLM_TIMEOUT_MS,
      state: { jobId, job } satisfies PlateFireState,
    };
  },

  async llmOutput({ ctx, state }) {
    const { jobId, job } = state as PlateFireState;
    const items = parsePlateLlmReply(ctx.llmOutputText || '');

    if (items.length === 0) {
      // 一条都没解析出来（模型跑偏 / 输出被截断）。不送空结果——客户端收到空列表会
      // 按「LLM 决定清空」处理，把整块门牌抹掉。什么都不送，门牌保持不动，
      // 下一轮消化会重新提交一份新的 job 再整理。
      console.warn('[amsg:plate] LLM 没返回有效条目，门牌保持不动', jobId);
      logSkipDiagnostic({
        sessionId: ctx.sessionId,
        reason: 'plate-empty-generation',
        iteration: ctx.iteration,
        llmResponse: ctx.llmResponse,
        llmOutputText: ctx.llmOutputText,
      });
      await discardJob(ctx.writeState, jobId);
      return { decision: 'skip-push', reason: 'plate-empty-generation' };
    }

    if (typeof ctx.emitResult !== 'function') {
      // 老部署（amsg-server < 2.6.0-next.21）没有这个能力。整理白跑了，但说清楚原因，
      // 否则用户只会看到「门牌一直不更新」而面板上一片正常。
      console.warn('[amsg:plate] 这台 worker 不支持 emitResult，整理结果送不回去', jobId);
      await discardJob(ctx.writeState, jobId);
      return { decision: 'skip-push', reason: 'plate-emit-result-unsupported' };
    }

    const rawUsage = (ctx as { usage?: Record<string, unknown> | null }).usage
      ?? ((ctx.llmResponse as { usage?: Record<string, unknown> | null } | null)?.usage);
    const promptTokens = typeof rawUsage?.prompt_tokens === 'number' && Number.isFinite(rawUsage.prompt_tokens)
      ? rawUsage.prompt_tokens : undefined;
    const completionTokens = typeof rawUsage?.completion_tokens === 'number' && Number.isFinite(rawUsage.completion_tokens)
      ? rawUsage.completion_tokens : undefined;
    const usage = (promptTokens !== undefined || completionTokens !== undefined)
      ? {
        ...(promptTokens !== undefined ? { promptTokens } : {}),
        ...(completionTokens !== undefined ? { completionTokens } : {}),
      }
      : undefined;

    try {
      await ctx.emitResult({
        ...buildPlateConsolidateResult({
          jobId,
          charId: job.charId,
          items,
          rooms: job.rooms,
          snapshotAt: job.snapshotAt,
          ...(usage ? { usage } : {}),
        }),
        // 背景工作，整理完不该把人叫回来看。show:false 的 payload 上游只落收件箱、
        // 不发推送，客户端下次上线补收。
        notification: { show: false },
      });
    } catch (error) {
      // 方法在、调用却炸了：收件箱那张表缺列/缺表（升级 worker 后不跑 init-tenant 就是
      // 这个样子），或者上游自己判定不支持。抛出去的话这一轮算失败，重试梯子会**再跑
      // 两次完整生成**——LLM 已经烧过一次了，而下两次注定同样送不回来。所以就地收成
      // 跳过：这一轮整理白跑，但只白跑一次，门牌保持不动等下轮消化重来。
      console.warn('[amsg:plate] 整理结果送不进收件箱（多半是收件箱表没建全，去设置页点一次「重新连接并验证」）', jobId, error);
      await discardJob(ctx.writeState, jobId);
      return { decision: 'skip-push', reason: 'plate-emit-result-failed' };
    }
    console.log('[amsg:plate] 整理结果已送进收件箱', {
      jobId, charId: job.charId, items: items.length, resultKind: PLATE_CONSOLIDATE_RESULT_KIND,
    });

    await discardJob(ctx.writeState, jobId);
    return { decision: 'skip-push', reason: 'plate-result-emitted' };
  },
};

/** 只为单测导出：让测试能不经 index.ts 直接喂一份 ctx。 */
export type { KindFireCtx, KindSessionCtx };
