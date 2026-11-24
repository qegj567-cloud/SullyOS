/**
 * 代跑结果落地（utils/amsgResults.ts 按 resultKind 'cloud-gen' 派到这里）。
 *
 * 顺序：认形状 → 已落地底账 → 失败结果直接收尾 → 读附件、拼回 OpenAI 形状 → 交给这个功能
 * 的落地函数 → 登记表、底账、调用记录、埋点一起收尾。返回值是「这条能不能销账」：
 * 只有落地真正走完（或确定不用落地）才返回 true；读附件、落地中途抛错返回 false，下次再来。
 */

import { cloudApiCallLogId, settleCloudApiCall } from '../apiCallLog';
import { parseCloudGenOutput, parseCloudGenResult, type CloudGenUsage } from '../amsgCloudGenJob';
import type { AmsgResultContext } from '../amsgResults';
import { trackCloudGenOutcome } from './analytics';
import { loadCloudGenLander } from './landers';
import {
  getCloudGenJobById,
  isCloudGenJobDone,
  markCloudGenJobDone,
  markCloudGenJobFailed,
  removeCloudGenJob,
  updateCloudGenJob,
} from './registry';
import type { CloudGenResponse, CloudGenResultInfo } from './types';

const HEADER = '[cloud-gen]';

/**
 * 同一个 job 正在落地时，另一条腿送来的同一份先不收（不销账，下次再来时底账已经记上）。
 * 全局分发队列超时只放行不取消，没有这道闸两份会并行落地。
 */
const landing = new Set<string>();

const settleLog = (jobId: string, ok: boolean, usage?: CloudGenUsage) => settleCloudApiCall({
  id: cloudApiCallLogId(jobId),
  ok,
  ...(usage?.promptTokens !== undefined ? { promptTokens: usage.promptTokens } : {}),
  ...(usage?.completionTokens !== undefined ? { completionTokens: usage.completionTokens } : {}),
  ...(usage?.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
  ...(usage?.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
  ...(usage?.backendModel ? { backendModel: usage.backendModel } : {}),
});

/** 附件里的原始结果 → 本机直连时 safeResponseJson 拿到的那种形状。 */
export const toCloudGenResponse = (
  output: { content: string; reasoning: string; finishReason: string | null },
  usage?: CloudGenUsage,
): CloudGenResponse => ({
  choices: [{
    message: { role: 'assistant', content: output.content, ...(output.reasoning ? { reasoning_content: output.reasoning } : {}) },
    finish_reason: output.finishReason,
  }],
  ...(usage && (usage.promptTokens !== undefined || usage.completionTokens !== undefined)
    ? { usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens } }
    : {}),
  ...(usage?.backendModel ? { model: usage.backendModel } : {}),
});

export const applyCloudGenResult = async (payload: unknown, context?: AmsgResultContext): Promise<boolean> => {
  const result = parseCloudGenResult(payload);
  if (!result) {
    console.warn(`${HEADER} 结果形状认不出来，丢弃`, payload);
    return true;
  }
  const { jobId, purpose } = result;
  if (isCloudGenJobDone(jobId)) return true;
  if (landing.has(jobId)) return false;
  landing.add(jobId);
  try {
    const record = getCloudGenJobById(jobId);
    const info: CloudGenResultInfo = {
      jobId, purpose, charId: result.charId,
      ...(context?.createdAt ? { createdAt: context.createdAt } : {}),
    };
    const lander = await loadCloudGenLander(purpose);

    // 失败收尾：云端报失败、附件取不回、落地函数判这份结果不合格，三条路同一个出口。
    const failJob = async (error: { code: string; message: string }): Promise<true> => {
      settleLog(jobId, false, result.usage);
      const failed = record ? markCloudGenJobFailed(jobId, error) : null;
      if (failed) {
        trackCloudGenOutcome(purpose, 'failed');
        try { await lander.onFailed?.(failed, error); } catch (hookError) {
          console.warn(`${HEADER} ${purpose} 失败收尾出错（不影响销账）`, hookError);
        }
      }
      markCloudGenJobDone(jobId);
      return true;
    };

    if (!result.ok) {
      console.warn(`${HEADER} ${purpose} 云端生成失败（job ${jobId}）`, result.error);
      return failJob(result.error);
    }

    if (!record && !lander.acceptsOrphanResults) {
      // 别的设备交的、本机存储被清过、或已撤回的：这里没有落脚点。
      console.warn(`${HEADER} ${purpose} 结果在登记表里查不到（job ${jobId}），丢弃`);
      settleLog(jobId, false, result.usage);
      markCloudGenJobDone(jobId);
      return true;
    }

    const raw = await (await import('../activeMsgClient')).ActiveMsgClient.readAttachment(result.attachment);
    const output = raw === null ? null : parseCloudGenOutput(raw);
    if (!output) {
      // 附件过期、缺失或内容坏了：结果再也取不回来，按失败收尾。读库或网络错误会在上面直接抛出，下次重来。
      const error = { code: 'attachment-missing', message: raw === null ? '云端结果已过期或不存在' : '云端结果内容损坏' };
      console.warn(`${HEADER} ${purpose} 结果附件取不回来（job ${jobId}）`, error.message);
      return failJob(error);
    }

    const outcome = await lander.land(toCloudGenResponse(output, result.usage), record, info);
    if (typeof outcome === 'object') {
      // 结果到了但不合格（截断、格式不对）：按失败收尾，界面走原来的报错，埋点记失败而不是丢弃。
      console.warn(`${HEADER} ${purpose} 结果没通过校验（job ${jobId}）`, outcome.failed);
      return failJob(outcome.failed);
    }
    markCloudGenJobDone(jobId);
    settleLog(jobId, outcome === 'landed', result.usage);
    trackCloudGenOutcome(purpose, outcome);
    if (outcome === 'landed') updateCloudGenJob(jobId, { status: 'landed', settledAt: Date.now() });
    else removeCloudGenJob(jobId);
    return true;
  } catch (error) {
    console.warn(`${HEADER} ${purpose} 结果没落成（账没销，下次再来）`, error);
    return false;
  } finally {
    landing.delete(jobId);
  }
};
