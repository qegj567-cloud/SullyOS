/**
 * 代跑的提交口：入口照原样拼好请求，调 trySubmitCloudGeneration 决定这次交云端还是本机跑。
 *
 * 返回三种结论，调用方各自照办：
 *   cloud  交出去了。本机不再生成，结果回来由这个功能的落地函数处理（landers/）。
 *   local  没交（原因见 CloudGenLocalReason），按原来的路在本机生成。
 *   busy   同一角色同一功能已有一份在云端跑。不交、也别在本机再生成一份。
 *
 * 门的顺序照门牌整理（plateCloudGate）：这套 API 配齐 → 2.0 开着 → 这个功能的云端生成开着
 * → Worker 认识代跑 → 没有在飞的。Worker「问不到」时先看在飞：网络抖一下不等于路断，
 * 手上那份多半还在跑，这时转本机就是同一件事做两遍。
 *
 * 与本机请求一致：消息原样、模型名原样；本机 fetch 出口会做的两项改写（Claude 温度封顶、
 * 弃用采样参数的模型摘掉温度）在这里照做一遍，图片令牌同样还原。Anthropic 原生协议由
 * Worker 的出口转换。仍然不同的两处登记在 docs/amsg2-overview.md 的有意差异表里。
 */

import { cloudApiCallLogId, recordCloudApiCall, settleCloudApiCall } from '../apiCallLog';
import {
  CLOUD_GEN_KIND,
  CLOUD_GEN_NAMESPACE,
  CLOUD_GEN_PURPOSE_META_KEY,
  type CloudGenMessage,
  buildCloudGenJobInput,
  cloudGenJobKey,
} from '../amsgCloudGenJob';
import { buildCharGenCredRow } from '../amsgLlmCredentials';
import { clampClaudeTemperature, modelRejectsSamplingParams, stripSamplingParams } from '../samplingParamCompat';
import { trackCloudGenOutcome } from './analytics';
import {
  getCloudGenJob,
  markCloudGenJobDone,
  putCloudGenJob,
  removeCloudGenJob,
  sweepStaleCloudGenJobs,
  updateCloudGenJob,
} from './registry';
import { getCloudGenFeatureSwitches } from './settings';
import {
  CLOUD_GEN_PURPOSE_META,
  type CloudGenLocalReason,
  type CloudGenSubmitInput,
  type CloudGenSubmitOutcome,
} from './types';

const HEADER = '[cloud-gen]';

const isTextMessage = (m: { role: string; content: unknown }): m is CloudGenMessage =>
  (m.role === 'system' || m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';

/**
 * 按本机 fetch 出口的规则整理请求体，拆成上游认的三块：温度、输出上限、其余字段。
 * 核心字段（model / messages）在后面写入，撞键时赢——与上游拼请求体的顺序一致。
 */
export const buildCloudGenRequestParams = (
  model: string,
  params: CloudGenSubmitInput['params'],
): { temperature?: number; maxTokens?: number; extraBody?: Record<string, unknown> } => {
  const body: Record<string, any> = { ...params, model };
  clampClaudeTemperature(body);
  if (modelRejectsSamplingParams(body.model)) stripSamplingParams(body);
  // stream 是传输方式，云端一律非流式（已登记的差异）；model / messages 由任务本身给。
  const { model: _model, messages: _messages, stream: _stream, temperature, max_tokens, ...extra } = body;
  return {
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(typeof max_tokens === 'number' && max_tokens > 0 ? { maxTokens: max_tokens } : {}),
    ...(Object.keys(extra).length > 0 ? { extraBody: extra } : {}),
  };
};

export async function trySubmitCloudGeneration(input: CloudGenSubmitInput): Promise<CloudGenSubmitOutcome> {
  const { purpose, char } = input;
  const local = (reason: CloudGenLocalReason): CloudGenSubmitOutcome => {
    trackCloudGenOutcome(purpose, 'local', reason);
    return { route: 'local', reason };
  };

  const credRow = buildCharGenCredRow(char.id, purpose, input.api);
  if (!credRow) return local('no-credentials');

  const { isAmsg2GlobalReady } = await import('../amsg2ToolBridge');
  if (!await isAmsg2GlobalReady()) return local('amsg2-off');

  const switches = await getCloudGenFeatureSwitches(purpose);
  if (!switches.enabled) return local('feature-off');

  if (!input.messages.length || !input.messages.every(isTextMessage)) {
    console.warn(`${HEADER} ${purpose} 的消息里有非纯文本内容，这次在本机生成`);
    return local('unsupported-content');
  }

  // 躺太久的先收掉，再判在飞：不然一份早就没了的会一直挡着。
  await sweepStaleCloudGenJobs().catch(() => {});

  const { ActiveMsgClient, mayHaveCreatedBackgroundJob, resolveChatMessagesForUpload } = await import('../activeMsgClient');
  const support = await ActiveMsgClient.probeCloudGenSupportDetailed();
  if (support === 'unsupported') return local('worker-unsupported');
  const existing = getCloudGenJob(char.id, purpose);
  if (existing?.status === 'running') return { route: 'busy', jobId: existing.jobId };
  if (support === 'unknown') return local('worker-unreachable');

  const messages = (await resolveChatMessagesForUpload(input.messages)) as CloudGenMessage[];
  const request = buildCloudGenRequestParams(input.api.model, input.params);
  const notifyCopy = switches.notify
    ? (input.notifyCopy ?? { title: char.name, body: `${CLOUD_GEN_PURPOSE_META[purpose].label}生成好了` })
    : null;
  const jobId = crypto.randomUUID();
  const uuid = crypto.randomUUID();
  const now = Date.now();
  const logId = cloudApiCallLogId(jobId);

  // 登记和调用记录都在发请求之前落下：请求到了、答复丢了的那种，这是唯一的痕迹。
  putCloudGenJob({
    jobId, purpose, charId: char.id, charName: char.name, uuid,
    submittedAt: now, snapshotAt: input.snapshotAt ?? now,
    status: 'running', notify: !!notifyCopy, context: input.context,
  });
  recordCloudApiCall({
    id: logId, route: 'cloud-generation', baseUrl: input.api.baseUrl, model: input.api.model,
    messages, meta: input.apiMeta,
  });

  // 这次确定没在云端跑：撤掉登记，调用记录标成已顶替（本机那次另记一笔），
  // 底账记上，万一有一份结果漏网回来也不再落地。
  const rollBack = (reason: CloudGenLocalReason): CloudGenSubmitOutcome => {
    removeCloudGenJob(jobId);
    markCloudGenJobDone(jobId);
    settleCloudApiCall({ id: logId, ok: false, superseded: true });
    return local(reason);
  };

  let dispatch: string | undefined;
  try {
    ({ dispatch } = await ActiveMsgClient.scheduleBackgroundJob({
      kind: CLOUD_GEN_KIND,
      charId: char.id,
      charName: char.name,
      namespace: CLOUD_GEN_NAMESPACE,
      jobKey: cloudGenJobKey(jobId),
      jobId,
      uuid,
      jobInput: buildCloudGenJobInput({ jobId, purpose, charId: char.id, charName: char.name, messages, notify: notifyCopy }),
      credRow,
      // 每次都覆盖云端那行：本机记的「上次传过什么」靠不住（别的入口、别的设备会改云端那行）。
      forceCredUpload: true,
      metadata: { [CLOUD_GEN_PURPOSE_META_KEY]: purpose },
      ...request,
    }));
  } catch (error) {
    if (mayHaveCreatedBackgroundJob(error)) {
      // 不知道交没交上：按交上了处理，本机不再生成一份。真没交上的，点名会在 20 分钟后标失败。
      console.warn(`${HEADER} ${purpose} 交任务没等到答复，按已交出处理`, error);
      trackCloudGenOutcome(purpose, 'submitted');
      return { route: 'cloud', jobId };
    }
    console.warn(`${HEADER} ${purpose} 交云端失败，这次在本机生成`, error);
    return rollBack('submit-failed');
  }

  if (dispatch !== 'kicked') {
    // 起跳器没叫醒，只能等 cron，而用户可能关着后台任务。页面此刻开着，本机生成是诚实的退路：
    // 撤掉任务和输入，免得 cron 之后又跑一遍。
    console.warn(`${HEADER} ${purpose} 任务没能立刻开跑（${dispatch ?? '未知'}），撤回后在本机生成`);
    await ActiveMsgClient.cancelTask(uuid).catch((error) => console.warn(`${HEADER} 撤回任务失败`, error));
    await ActiveMsgClient.clearClientStateValue(CLOUD_GEN_NAMESPACE, cloudGenJobKey(jobId))
      .catch((error) => console.warn(`${HEADER} 撤回输入失败（等 TTL 兜底）`, error));
    return rollBack('kick-failed');
  }

  updateCloudGenJob(jobId, { acceptedAt: Date.now() });
  trackCloudGenOutcome(purpose, 'submitted');
  console.log(`${HEADER} ${purpose} 已交给云端（job ${jobId}，任务 ${uuid}）`);
  return { route: 'cloud', jobId };
}
