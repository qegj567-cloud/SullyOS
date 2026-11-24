/**
 * 代跑（本机拼、云端代跑）在浏览器这一侧的公共类型。
 *
 * 一次代跑的生命周期：入口照原样拼好请求 → trySubmitCloudGeneration 交给 Worker（在飞登记表
 * 记一笔 running）→ Worker 调模型、结果存附件 → 结果回到 utils/amsgResults.ts → results.ts
 * 读附件、拼回 OpenAI 形状的响应 → 交给这个功能的落地函数（landers/）→ 登记表变成
 * landed / failed，等界面收走。
 */

import type { ApiCallMeta } from '../apiCallLog';
import type { LlmApiType } from '../llmEndpoint';
import type { CloudGenPurpose } from '../amsgCloudGenJob';

export type { CloudGenPurpose } from '../amsgCloudGenJob';
export { CLOUD_GEN_PURPOSES, isCloudGenPurpose } from '../amsgCloudGenJob';

/** 在飞登记表与已落地底账的 localStorage 键（见 registry.ts）。 */
export const CLOUD_GEN_JOBS_KEY = 'amsg2_cloud_gen_jobs_v1';
export const CLOUD_GEN_DONE_KEY = 'amsg2_cloud_gen_done_v1';

/** 「本功能不再提醒」：按功能记住不再显示云端生成小条（见 hint.ts）。 */
export const CLOUD_GEN_HINT_OFF_KEY = 'amsg2_cloud_gen_hint_off_v1';
/** 已落地、还没被用户打开的结果（如还没看的梦），按功能 + 角色各一份（见 pending.ts）。 */
export const CLOUD_GEN_PENDING_PREFIX = 'amsg2_cloud_gen_pending_v1:';

/**
 * 这是不是代跑的本机键。它们描述的是这台设备上在飞或刚落地的任务、这台设备上的提醒偏好，不进备份。
 */
export const isCloudGenStorageKey = (key: string): boolean =>
  key === CLOUD_GEN_JOBS_KEY || key === CLOUD_GEN_DONE_KEY || key === CLOUD_GEN_HINT_OFF_KEY
  || key.startsWith(CLOUD_GEN_PENDING_PREFIX);

/**
 * 每个功能的名字和「完成时通知」的默认值。用户主动发起的默认通知，自动触发的（日程）默认不通知。
 * 「云端生成」开关三个都默认开。
 */
export const CLOUD_GEN_PURPOSE_META: Record<CloudGenPurpose, { label: '日程' | '人格模拟' | '梦境'; defaultNotify: boolean }> = {
  schedule: { label: '日程', defaultNotify: false },
  'persona-sim': { label: '人格模拟', defaultNotify: true },
  dream: { label: '梦境', defaultNotify: true },
};

/** 在飞登记表里的一条。持久化在 localStorage，关掉页面重开还在。 */
export interface CloudGenJobRecord {
  jobId: string;
  purpose: CloudGenPurpose;
  charId: string;
  charName: string;
  /** 云端任务行 uuid（客户端提交前生成，答复丢了也查得到这条任务）。 */
  uuid: string;
  /** 交出去的时刻（epoch 毫秒）。 */
  submittedAt: number;
  /** 入口读数据快照的时刻（epoch 毫秒），落地时判「这期间数据被改过没有」用。 */
  snapshotAt: number;
  /**
   * Worker 确认收下、起跳器已开跑的时刻。「可以切出去了」的提示只认它：登记在发请求之前就写下，
   * 上传那几秒里切走照样会断；答复丢了、不知道交没交上的那种也不写，免得叫用户放心离开。
   */
  acceptedAt?: number;
  /** 在飞期间页面进过后台（只用于埋点的「期间离开过」，见 registry.ts 的 cloudGenJobLeftPage）。 */
  leftPage?: boolean;
  status: 'running' | 'landed' | 'failed';
  error?: { code: string; message: string };
  /** 完成时有没有发通知（这个功能的「完成时通知」开关）。 */
  notify: boolean;
  /** 落地函数需要的业务上下文，由入口给、原样存。只放小体积的 JSON。 */
  context: unknown;
  /** 变成 landed / failed 的时刻；超过保留期的记录会被清掉。 */
  settledAt?: number;
}

/** 交给落地函数的响应：与本机直连时 `safeResponseJson` 拿到的形状一致。 */
export interface CloudGenResponse {
  choices: Array<{
    message: { role: 'assistant'; content: string; reasoning_content?: string };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

/** 结果的随身信息：登记表里没有这条时（别的设备交的、本机存储被清过）靠它认出是谁的。 */
export interface CloudGenResultInfo {
  jobId: string;
  purpose: CloudGenPurpose;
  charId: string;
  /** 结果记进服务端收件箱的时间；推送直达时没有。 */
  createdAt?: number;
}

/**
 * 每个功能的落地函数。一个功能一个文件，放在 landers/ 下。
 *
 * 结果会到达不止一次、也可能隔很久才到：
 *   - 重放由 results.ts 的已落地底账挡住，落地函数不用自己去重；
 *   - 全局分发队列 60 秒超时只放行不取消，落地函数要自己锁住自己那份数据；
 *   - 结果晚到时现场可能已经变了（用户手动重新生成过、角色被删了），由落地函数判断还要不要。
 */
export interface CloudGenLander {
  /**
   * 落地。`response` 交给原来的解析函数即可；`record` 为 null 表示登记表里没有这条
   * （只有 acceptsOrphanResults 为 true 时才会这样调用）。
   * 返回 'discarded' 表示这份结果不要了（现场已经变了，登记表里那条随之删掉）；返回 `{ failed }`
   * 表示结果到了但不合格（截断、格式不对），按失败收尾：登记表标 failed、调 onFailed、埋点记失败。
   * 抛错 = 这次没处理成，结果不销账，下次上线再来。
   */
  land(
    response: CloudGenResponse,
    record: CloudGenJobRecord | null,
    info: CloudGenResultInfo,
  ): Promise<'landed' | 'discarded' | { failed: { code: string; message: string } }>;
  /** 云端明确失败时调用（登记表已标成 failed）。可选。 */
  onFailed?(record: CloudGenJobRecord, error: { code: string; message: string }): Promise<void>;
  /** 用户点「进入」时跳到对应界面。可选。 */
  open?(record: CloudGenJobRecord): void;
  /** 登记表里查不到的结果要不要也交给 land。默认不要，直接销账。 */
  acceptsOrphanResults?: boolean;
}

/** 交一次代跑需要的全部材料。 */
export interface CloudGenSubmitInput {
  purpose: CloudGenPurpose;
  char: { id: string; name: string };
  /** 本机这次会 POST 给 /chat/completions 的 messages，原样。只收纯文本。 */
  messages: Array<{ role: string; content: unknown }>;
  /** 本机请求体里除 model / messages 之外的字段，原样（temperature、max_tokens、思考参数等）。 */
  params: { temperature?: number; max_tokens?: number } & Record<string, unknown>;
  /** 本机这次请求实际使用的那套 API。 */
  api: { baseUrl: string; apiKey: string; model: string; apiType?: LlmApiType };
  /** 落地函数需要的业务上下文，原样存进登记表。 */
  context: unknown;
  /** 本机请求的调用记录标签（与 __sullyMeta 同一份）。 */
  apiMeta: ApiCallMeta;
  /** 完成通知的文案；不给就用「角色名 · 功能名好了」。 */
  notifyCopy?: { title: string; body: string };
  /** 入口读数据快照的时刻；不给就取交任务这一刻。 */
  snapshotAt?: number;
}

/**
 * 这次没交云端的原因（固定枚举，进埋点）：
 *   no-credentials      这套 API 没配齐
 *   amsg2-off           没开主动消息 2.0（或没填 Worker）
 *   feature-off         这个功能的「云端生成」关着
 *   worker-unsupported  Worker 太旧，不认识代跑
 *   worker-unreachable  这一刻问不到 Worker
 *   unsupported-content 消息里有非纯文本内容
 *   submit-failed       交任务时确定失败（服务端拒了、上传输入失败）
 *   kick-failed         任务建了但没能立刻开跑，已撤回
 */
export type CloudGenLocalReason =
  | 'no-credentials' | 'amsg2-off' | 'feature-off' | 'worker-unsupported' | 'worker-unreachable'
  | 'unsupported-content' | 'submit-failed' | 'kick-failed';

export type CloudGenSubmitOutcome =
  | { route: 'cloud'; jobId: string }
  | { route: 'local'; reason: CloudGenLocalReason }
  /** 同一角色同一功能已有一份在云端跑，这次不交也不在本机重复生成。 */
  | { route: 'busy'; jobId: string };
