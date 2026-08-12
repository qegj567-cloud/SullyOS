import { ReiClient } from '@rei-standard/amsg-client';
import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2ExpirePolicy,
  ActiveMsg2GlobalConfig,
  ActiveMsg2Mode,
  ActiveMsg2Recurrence,
  ActiveMsg2TaskRecord,
  APIConfig,
  CharacterProfile,
  Emoji,
  EmojiCategory,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../types';
import { getLastRealUserMessageAt } from './amsg2ExpireGuard';
import { AMSG_BUNDLE_VERSION } from './amsgBundleVersion';
import { buildTaskInstruction, resolveSendAtMs } from './amsgFireSchedule';
import {
  getPendingTasks, isAmsg2EnabledForChar, MAX_ACTIVE_TASKS_PER_CHAR,
  parseRemoteTaskLastError, RemoteTaskLastError, type RemoteTaskProjection,
  resolveExpirePolicy, toDatetimeLocalValue,
} from './amsg2Tasks';
import { AMSG_CHAT_PRESENCE_KEY, AmsgChatPresence } from './amsgChatPresence';
import {
  AmsgDiagnosticsProbe, AmsgFailKind, describeAmsgFetchFailure, parseAmsgDebugReport,
} from './amsgDiagnostics';
// 「这个角色欠着一条即时对话回复吗」的两个原始信号（待收记录 + 发送在飞）。
// amsgInstantChat 反过来也 import 这个文件，两边都只在函数体里用对方，模块求值期
// 谁都不碰谁，所以这个环是安全的；换成在这里另读一遍 localStorage 才是真麻烦
// （挂起判定就有了两把尺，而「发送在飞」那半截根本抄不过来，它是内存里的集合）。
import { getInstantChatPending, isInstantChatSendInFlight } from './amsgInstantChat';
import {
  buildCharChatCredRow,
  buildCharEmotionCredRow,
  buildCharInstantCredRow,
  chunkCredRows,
  forgetAllCredIds,
  forgetCredIds,
  normalizeChatApiUrl,
  pickChangedCredRows,
  rememberCredRows,
  supportsLlmCredentials,
  type LlmCredentialRow,
} from './amsgLlmCredentials';
import { flattenContentPartsToText } from './promptMessageCleanup';
import {
  AMSG_FIRE_PACK_KEY,
  FIRE_PACK_VERSION,
  AMSG_SLOT_AWAY_HINT,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_REALTIME_WORLD,
  AMSG_SLOT_SCENE,
  AMSG_SLOT_TASK_INSTRUCTION,
  AMSG2_INSTANT_STUB_TEMPLATE,
  AMSG_INSTANT_CHAT_SUBTYPE,
  AMSG_LAST_SKIP_KEY,
  AMSG_SLOT_SELF_LOG,
  AMSG_SLOT_TASK_LIST,
  AMSG_SLOT_TIME_SINCE_USER,
  AMSG_SLOT_USER_CLOCK,
  AmsgFirePack,
  type AmsgFirePackChatContent,
  type AmsgLastSkip,
  amsgStateNamespace,
  packStateValue,
  parseLastSkip,
} from './amsgFirePack';
import type { AmsgFireScene } from './amsgFireScene';
import { buildSongPool } from './charMusicSchedule';
import { getDailyScheduleForChar } from './dailySchedule';
import { getLocalDateKey } from './localDate';
import { isScheduleFeatureOn } from './scheduleGenerator';
import {
  AMSG_GLOBAL_NAMESPACE,
  AMSG_TOOL_CONFIG_KEY,
  AMSG_TOOL_PACK_KEY,
  type AmsgToolPromptControls,
  buildToolConfig,
  buildToolPack,
} from './amsgToolPack';
// 只取一个常量：客户端算 firstSendTime 时要留的提前量，和包装层「把任务行拉到期」
// 那一步是同一个数，各写各的就会出现「校验说时间要在未来 / cron 说还没到」的死角。
import type { AmsgEmotionEvalSpec } from '../worker/amsg/src/emotionEval';
import { listRecallableMonths } from './agenticTools';
import { ChatPrompts } from './chatPrompts';
import { nowInTimeZone, resolveCharTimeZone, tzAwarenessNote } from './timezone';
import { DB } from './db';
import { copyWorkerBundleToClipboard } from './instantPushClient';
import { collectMcpFireServers, getMcpUseNativeTools } from './mcpClient';
import { safeResponseJson } from './safeApi';
import { ActiveMsgStore } from './activeMsgStore';
import { KeepAlive } from './keepAlive';
import {
  bytesToB64u,
  describePushCapabilityGap,
  isDeadPushEndpoint,
  subscribeWithRetry,
  SUBSCRIBE_SETTLE_MS,
  type SubscribeFailureKind,
} from './pushSubscribeShared';
import { isPromptControlModuleEnabled, readPromptControlConfig } from './promptControl';

export const NATIVE_PUSH_TOKEN_STORAGE_KEY = 'amsg2_fcm_token_v1';
const nativePushBuildEnabled = () => import.meta.env.VITE_AMSG_NATIVE_PUSH === 'true';
const readNativePushToken = () => nativePushBuildEnabled() && typeof localStorage !== 'undefined'
  ? localStorage.getItem(NATIVE_PUSH_TOKEN_STORAGE_KEY)?.trim() || ''
  : '';

export interface ActiveMsg2PushStatus {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  hasSubscription: boolean;
  vapidConfigured: boolean;
  detail?: string;
}

/** worker 上登记的那份订阅（一个用户一行）。读不到时调用方拿 null。 */
export interface AmsgRemotePushSubscription {
  exists: boolean;
  endpoint: string | null;
  updatedAt: number | null;
}

export interface AmsgPromptAuditEntry {
  id: string;
  createdAt: number;
  expiresAt: number;
  charId: string | null;
  charName: string | null;
  taskUuid: string | null;
  taskRowId: string | null;
  clientTaskId: string | null;
  occurrenceMs: number | null;
  status: string;
  model: string | null;
  prompt: string;
  promptControls: Record<string, unknown>;
  promptModules: Array<{ key: string; label: string; enabled: boolean; included: boolean; note?: string }>;
  rounds: Array<{
    iteration: number;
    decision: string;
    model: string | null;
    usage: { totalTokens: number | null; promptTokens: number | null; completionTokens: number | null };
    toolCalls: string[];
    outputText: string;
  }>;
  usage: { totalTokens?: number | null; promptTokens?: number | null; completionTokens?: number | null };
  outputText: string;
  error: string | null;
}

/**
 * 「worker 到点会不会推到这台设备」的结论。
 *
 * 中间那两档是主动消息最难自己发现的故障：任务建得成、界面全绿、到点一条都不来。
 * 换过 worker（新库是空的）、或者在另一台设备上登记过（一个用户只存一份，后来的
 * 顶掉先前的），都会落到这里。
 */
export type AmsgPushRegistrationState =
  | 'worker-unset'    // 还没填 Worker 地址，无从谈起
  | 'unreachable'     // 问不到 worker（断网，或那台 worker 没有这个端点）
  | 'missing'         // worker 上没有登记
  | 'other-endpoint'  // 登记着，但不是本机这个端点
  | 'matched';        // 登记着，且就是本机

/**
 * 拿本机端点跟 worker 登记的那份对一下。纯函数，面板和单测共用同一套判定。
 *
 * 本机还没订阅（localEndpoint 为空）时，只要远端有登记就算 'other-endpoint'——
 * 那份登记确实指向别的地方，说「已登记」会让用户以为这台设备收得到。
 */
export const compareRemotePushSubscription = (
  localEndpoint: string | null | undefined,
  remote: AmsgRemotePushSubscription | null,
): AmsgPushRegistrationState => {
  if (!remote) return 'unreachable';
  if (!remote.exists || !remote.endpoint) return 'missing';
  return remote.endpoint === localEndpoint ? 'matched' : 'other-endpoint';
};

/**
 * 库把载荷加解密留成了私有实现，而分页拉任务、init-tenant 这类库没封装的端点
 * 得自己组加密载荷，所以按运行时的真实形状单独声明一份，在下面两个桥接函数里
 * 转一次。不能写成 `ReiClient & { _encrypt }`——交叉类型碰上 private 成员会整个
 * 塌成 never，连带 ReiClient 自己的方法一起查不到。
 */
interface ReiCryptoBridge {
  _encrypt(plaintext: string): Promise<{ iv: string; authTag: string; encryptedData: string }>;
  _decrypt(payload: { iv: string; authTag: string; encryptedData: string }): Promise<any>;
}

const ACTIVE_MSG_RUNTIME_HEADER = '[ActiveMsg2]';

/** amsg-server 的 DELETE /cancel-message 找不到目标行时回的错误码（HTTP 404）。 */
const REMOTE_TASK_NOT_FOUND_CODE = 'TASK_NOT_FOUND';
/** 行还在、但已经跑完出清（sent / failed）时回的错误码（HTTP 409）。 */
const REMOTE_TASK_ALREADY_COMPLETED_CODE = 'TASK_ALREADY_COMPLETED';

// 单用户模式：所有请求打到用户自部署的 Cloudflare Worker（config.workerUrl）。
// 配了 serverToken 就每次带 X-Client-Token；worker 端配了就强制校验，缺/错回 401。
const normalizeWorkerBase = (workerUrl: string) => workerUrl.trim().replace(/\/+$/, '');

const createClient = (config: Pick<ActiveMsg2GlobalConfig, 'userId' | 'workerUrl' | 'serverToken'>) =>
  new ReiClient({
    baseUrl: normalizeWorkerBase(config.workerUrl),
    userId: config.userId,
    serverToken: config.serverToken || undefined,
  });

/** 面板新建任务的默认时间：半小时后，折成 datetime-local 认的本地墙钟。 */
export const getDefaultActiveMsgFirstSendTime = () =>
  toDatetimeLocalValue(new Date(Date.now() + 30 * 60_000).toISOString());

/** amsg-server 对 avatarUrl 的长度上限，超了整条会被拒。 */
const REMOTE_AVATAR_URL_MAX_LENGTH = 2048;

/**
 * 能交给 worker 当推送通知图标的头像地址，不合格返回 undefined。
 *
 * worker 只收公网可访问的 URL（不能是 data: URI，上限 2048 字符）。而本地角色头像基本都是
 * base64，传过去必被拒，代价是每排一条任务就在 worker 日志里刷一条
 * `avatarUrl 不合法，已置空`。这里按同一把尺先筛掉——传了本来也是被置空，通知一样退回
 * 默认图标，少一条噪音而已。
 */
export const toRemoteAvatarUrl = (avatar: string | undefined | null): string | undefined => {
  const value = avatar?.trim();
  if (!value || value.length > REMOTE_AVATAR_URL_MAX_LENGTH || /^data:/i.test(value)) return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
};

// 失败归类（AmsgFailKind）连同「把 fetch 异常翻成人话」都住在 ./amsgDiagnostics：
// 那是一份纯函数叶子，设置页的体检面板也要用同一套判定。这里原样转出去，
// 外面按 `from './activeMsgClient'` 引的地方不用改。
export type { AmsgFailKind } from './amsgDiagnostics';

const FAIL_KIND_PROP = '__amsgFailKind';

/** 给错误挂一个失败代号，原样抛回去（不改 message、不改类型）。 */
const withFailKind = <T extends Error>(error: T, kind: AmsgFailKind): T => {
  (error as unknown as Record<string, string>)[FAIL_KIND_PROP] = kind;
  return error;
};

/**
 * 读出失败代号，没挂的一律 '其他'。
 * 上报侧只该调这个，别自己从 error 上取任何字段——那些是运行时字符串。
 */
export const readAmsgFailKind = (error: unknown): AmsgFailKind => {
  const kind = (error as Record<string, unknown> | null | undefined)?.[FAIL_KIND_PROP];
  return typeof kind === 'string' ? (kind as AmsgFailKind) : '其他';
};

/**
 * worker 自检的回执（`GET /config-check`，见 worker/amsg/src/index.ts 的 inspectWorkerEnv）。
 * missing 是缺了就跑不起来的，warnings 是能跑但有一块功能是哑的。
 */
export interface AmsgWorkerEnvReport {
  ok: boolean;
  missing: string[];
  /** worker 生成的整句，含「去哪儿补」，直接显示给用户。 */
  message: string;
  warnings: { code: string; message: string }[];
}

/**
 * 问 worker 自己配齐了没。
 *
 * 拿不到结论一律返回 null，不抛：这个端点是后加的，旧 worker 会回 404；而网络本身
 * 不通的话，紧接着的 init-tenant 会用它自己那套分类报出来，在这儿抢先报一遍只会让
 * 用户同时看到两条口径不同的错误。
 */
const inspectWorkerConfig = async (config: ActiveMsg2GlobalConfig): Promise<AmsgWorkerEnvReport | null> => {
  try {
    const { status, body } = await fetchWithAuthRaw('config-check', config, { method: 'GET' }, '配置自检');
    if (status !== 200 || !body?.success) return null;
    // 只认形状对得上的回执。没有这个端点的 worker 回什么的都有（404 只是其中一种），
    // 光看 success 就采信的话，会把一台好 worker 判成「配置缺失」——那比不自检还糟，
    // 用户照着提示改哪儿都改不对。形状不对就当它不支持自检，走原来的流程。
    const data = body.data;
    if (typeof data?.ok !== 'boolean' || !Array.isArray(data.missing) || !Array.isArray(data.warnings)) {
      return null;
    }
    return data as AmsgWorkerEnvReport;
  } catch {
    return null;
  }
};

/**
 * 拉一次体检（`GET /debug`）。
 *
 * 跟 inspectWorkerConfig 的差别在于失败也要有结论：那个是连接流程里的抢跑一步，拿不到
 * 就退回原流程；这个是用户主动来看「我到底哪儿没配对」的，连不上本身就是第一条结论，
 * 咽下去的话面板会一片空白，比不体检还难受。
 *
 * 端点是后加的，旧 worker 回 404（或者代理塞回来一段 HTML）。那种情况标成 unsupported——
 * 它只是查不了，不是坏了，报红会让人跑去改根本没错的配置。
 */
export const fetchWorkerDiagnostics = async (): Promise<AmsgDiagnosticsProbe> => {
  let config: ActiveMsg2GlobalConfig;
  try {
    config = await ensureWorkerReady();
  } catch (error: any) {
    return { reachable: false, reason: error?.message || '还没填 Worker 地址。' };
  }

  try {
    // 自带超时：连不上 Cloudflare 时 TCP 可以干等几十秒，而这个面板正是用户来问
    // 「到底怎么了」的地方——转圈转到天荒地老跟没有体检没区别。超时会被翻成
    // 「等太久」那一句，它跟「不通」的处理办法本来就不一样。
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
    const { status, body } = await fetchWithAuthRaw('debug', config, { method: 'GET', signal }, '体检');
    const report = parseAmsgDebugReport(body);
    if (report) return { reachable: true, report };

    // 401/403 是真配错了（共享密钥两边对不上），不是「版本旧」——标成 unsupported
    // 会让人跑去点更新，而更新一遍照样进不来。
    if (status === 401 || status === 403) {
      return { reachable: false, reason: `Worker 拒绝了这次请求（HTTP ${status}），多半是共享密钥两边对不上。` };
    }
    // 200 但形状对不上，跟 404 一样都是「这台 worker 上没有这个端点」。
    return {
      reachable: false,
      unsupported: true,
      reason: 'Worker 上跑的代码还没有体检端点。回你 fork 的 sullyos-workers 点一下 Sync fork，或者用上面的「更新 Worker」，之后再来看。',
    };
  } catch (error: any) {
    // fetchWithAuthRaw 抛出来的已经是人话了（见 amsgDiagnostics 的 describeAmsgFetchFailure）。
    return { reachable: false, reason: error?.message || '连不上 Worker。' };
  }
};

/**
 * 后端自更新的回执（`POST /self-update`，见 worker/amsg/src/selfUpdate.ts）。
 * supported 为 false 表示这台 worker 还是旧版、根本没有这个端点。
 */
export interface AmsgSelfUpdateResult {
  ok: boolean;
  supported: boolean;
  /** 直接显示给用户的整句，成功和失败都有。 */
  message: string;
  /** 新代码的指纹，成功时才有，拿来当「现在跑的是哪一版」。 */
  bundleHash?: string;
  /**
   * worker 挂在哪一步的代号（`CF_TOKEN_MISSING` / `UPLOAD_FAILED` 之类）。
   * 面板据此决定要不要露出「补装更新能力」那一块——缺钥匙是唯一能就地解决的一种。
   */
  code?: string;
}

/** init-tenant 没成功时按 HTTP 状态归类：三种状态要用户去改的地方完全不同。 */
const resolveInitFailKind = (status: number): AmsgFailKind => {
  if (status === 401 || status === 403) return '鉴权失败';   // 共享密钥两边对不上
  if (status === 404) return '端点不存在';                   // 地址不对，或 worker 是旧版
  return '建表失败';                                         // 多半是没绑 D1（变量名 DB）
};

/**
 * 最近一次用过的 Worker 地址，只拿来把域名写进给人看的报错里。
 *
 * 报错想说清「连不上的是哪儿」，可有几条抛错路径手上只有 client 没有 config
 * （取 VAPID 公钥、登记订阅）。为它们逐层加参数不划算——这个值不参与任何判定，
 * 错了也只是那句话里少个域名。凡是走 ensureWorkerReady 的路径都会先更新它。
 */
let lastKnownWorkerUrl = '';

const normalizeActiveMsgApiError = (error: unknown, phase: string, workerUrl?: string | null) => {
  const described = describeAmsgFetchFailure(error, phase, workerUrl || lastKnownWorkerUrl);
  // 尽量沿用原来那个异常对象（调用方可能还看它别的字段），只把给人看的那句话换掉。
  const normalized = error instanceof Error ? error : new Error(described.message);
  normalized.message = described.message;
  return withFailKind(normalized, described.kind);
};

const ensureGlobalReady = async (): Promise<ActiveMsg2GlobalConfig> => {
  const userId = await ActiveMsgStore.ensureUserId();
  const config = await ActiveMsgStore.getGlobalConfig();
  if (config.workerUrl?.trim()) lastKnownWorkerUrl = config.workerUrl;
  return { ...config, userId };
};

const ensureWorkerReady = async () => {
  const config = await ensureGlobalReady();
  if (!config.workerUrl.trim()) {
    throw withFailKind(new Error('请先在系统设置里填写「主动消息 2.0」的 Worker 地址。'), '地址没填');
  }
  return config;
};

// 握手结果按配置记忆化：init()（get-user-key）是一次真网络往返，而用户密钥不变——
// 即时对话把它放上了发送热路径（拿到 202 之前的串行延迟）和 60s 状态点名（一跳最多
// 两次），逐次重新握手纯属白付 RTT。键取会影响握手的三个字段；配置一变（换 worker /
// 换密钥 / 清空重连）键就换，旧缓存自然作废。失败的握手不缓存，下一次重新来过。
let cachedClientEntry: { key: string; promise: ReturnType<typeof createAndInitClient> } | null = null;

/**
 * 作废握手缓存，下一次调用重新 get-user-key。
 *
 * 记忆化的键只认「地址 / 用户 id / 共享密钥」，可云端的用户密钥还能在这三样都不变的
 * 情况下换代 —— 用户在 Cloudflare 上换掉 AMSG_MASTER_KEY 就是。所以凡是「用户密钥
 * 可能已经不是刚才那把」的动作（重新连接、清空云端状态）都得先过这里，否则缓存里
 * 那条 client 握着旧密钥，加密调用发出去 worker 一条都解不开。
 */
const invalidateClientCache = () => { cachedClientEntry = null; };

const createAndInitClient = async (config: ActiveMsg2GlobalConfig) => {
  const client = createClient(config);
  try {
    await client.init();
  } catch (error) {
    throw normalizeActiveMsgApiError(error, '获取用户密钥', config.workerUrl);
  }
  return client;
};

const initializeClient = (config: ActiveMsg2GlobalConfig) => {
  const key = `${config.workerUrl}|${config.userId}|${config.serverToken ?? ''}`;
  if (cachedClientEntry?.key === key) return cachedClientEntry.promise;
  const promise = createAndInitClient(config);
  cachedClientEntry = { key, promise };
  promise.catch(() => {
    if (cachedClientEntry?.promise === promise) cachedClientEntry = null;
  });
  // 顺手刷一次即时对话的能力位（结果存进全局配置，见 probeInstantChatSupport）。
  // 挂在这里是因为这是「一次会话一次」的天然位置：握手按配置记忆化，换 worker / 换密钥
  // 才会重来。设置页那一处探测只覆盖打开过设置页的人——而最需要被纠正的恰恰是那批
  // 「装好之后再没进过设置页、Worker 还停在旧版」的人。
  // 不 await：它只影响**之后**几轮的路由判断，拿它挡住握手等于给每条消息加一次 RTT。
  void ActiveMsgClient.probeInstantChatSupport().catch(() => {});
  // 同理顺手探一次「凭据能不能存成表里的一行」（credRefs 的唯一版本门槛，见
  // isLlmCredentialsReady）。探不到就按老路走，不影响任何一条消息发出去。
  void ActiveMsgClient.probeLlmCredentialsSupport().catch(() => {});
  return promise;
};

const resolveApiConfig = (char: CharacterProfile, config: ActiveMsg2CharacterConfig, apiConfig: APIConfig) => {
  const useSecondary = config.useSecondaryApi && config.secondaryApi?.baseUrl;
  const source = useSecondary ? config.secondaryApi! : apiConfig;

  if (!source.baseUrl || !source.apiKey || !source.model) {
    throw new Error('主动消息 2.0 缺少可用的 API URL / Key / Model。');
  }

  return source;
};

/**
 * 一个角色的 AI 任务此刻该用的凭据补丁（update-message 载荷）。
 * 生效凭据的算法与排程时同一份 resolveApiConfig：角色开了单独 API 就写单独 API 的值，
 * 没开才用全局聊天 API——凭据刷新绝不能把单独 API 的任务盖成全局凭据。
 * 凭据配不齐（比如单独 API 缺字段）沿用 resolveApiConfig 的抛错，调用方按角色记失败。
 */
const resolveTaskCredentialUpdates = (
  char: CharacterProfile,
  config: ActiveMsg2CharacterConfig,
  apiConfig: APIConfig,
): Record<string, unknown> => {
  const active = resolveApiConfig(char, config, apiConfig);
  return {
    apiUrl: normalizeChatApiUrl(active.baseUrl),
    apiKey: active.apiKey,
    primaryModel: active.model,
  };
};

// ─── LLM 凭据引用（credRefs）───
//
// 走不走这条路只判一处：这台 worker 的 capabilities 里有没有 'llm-credentials'。
// 达标就把凭据存成表里的一行、任务只带名字；不达标原样走「凭据冻结进任务」的老路。
// 结论跟即时对话那个能力位一样存进全局配置（握手时探一次），发消息 / 排程的路上
// 不做逐次网络预检——那等于给每条消息加一次 RTT。

/**
 * 这台 worker 现在走不走 credRefs。**整个前端的版本门槛只有这一处。**
 *
 * undefined（还没探过）按 false 处理：老路在哪台 worker 上都能跑，宁可这一轮多冻结
 * 一份凭据，也不要拿新写法去撞一台还不认识它的 worker（那是排程直接 400）。
 * 握手时会补探一次，之后就有准数了。
 */
export const isLlmCredentialsReady = async (): Promise<boolean> => {
  try {
    return (await ActiveMsgStore.getGlobalConfig()).llmCredentialsSupported === true;
  } catch {
    return false;
  }
};

/**
 * 把这几行凭据传上去，**只传真的变了的那些**（指纹底账见 amsgLlmCredentials）。
 *
 * force 用在「云端说这行不存在」的自愈路径上：那时本地底账是脏的（记着传过、实际没有），
 * 必须绕过指纹。传成功才记账——记早了就会把一次失败的上传当成已生效。
 */
const putLlmCredentialRows = async (
  rows: LlmCredentialRow[],
  options: { force?: boolean } = {},
): Promise<number> => {
  const pending = options.force ? rows : pickChangedCredRows(rows);
  if (pending.length === 0) return 0;
  const globalConfig = await ensureWorkerReady();
  const client = await initializeClient(globalConfig);
  for (const batch of chunkCredRows(pending)) {
    const response = await client.putLlmCredentials(batch);
    if (!response?.success) {
      throw new Error(response?.error?.message || '登记 LLM 凭据失败。');
    }
    // 逐批记账：后面那批失败时，前面已经落地的不必再传一遍。
    rememberCredRows(batch);
  }
  return pending.length;
};

const formatHistoryLine =(role: string, content: any, char: CharacterProfile, userProfile: UserProfile) => {
  const speaker = role === 'assistant' ? char.name : role === 'user' ? userProfile.name : '系统';
  // 富内容（视觉模型的 [{type:'text'},{type:'image_url'}] 格式）按 part 类型拍平：
  // 文本部分照抄，图片部分压成 [图片] 占位，别的类型丢掉——不能整段 JSON.stringify，
  // 那样会把 image_url 里几百 KB 的 base64 一字不差焊进模板，排程任务的载荷直接体积炸弹。
  // 与 worker 侧 restoreEvalPrompt 用的 flattenContent（worker/amsg/src/emotionEval.ts）
  // 同一套压法，但这里保留原有的 '\n' 分段（这份模板本来就一行一段，跟 worker 那边
  // 拼单行摘要的 ' ' 连接不是同一个用途，故不跟随其分隔符）。
  const text = Array.isArray(content)
    ? content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (part?.type === 'image_url') return '[图片]';
        return '';
      })
      .filter(Boolean)
      .join('\n')
    : String(content || '');
  return `【${speaker}】\n${text.trim()}`;
};

const buildTimeGapHint = async (charId: string) => {
  const recentMessages = await DB.getRecentMessagesByCharId(charId, 200);
  return {
    // 时间差在渲染时刻才算（formatTimeSinceUser），这里只取原始时间戳——
    // 满血链路会把它放进 fire_pack，worker 到点用「fire 时刻」重算，不吃排程时的陈旧值。
    // 「真实用户消息」判定与防穿帮闸共用同一叶子 helper（见 amsg2ExpireGuard）。
    lastUserMessageAt: getLastRealUserMessageAt(recentMessages),
    recentMessages,
  };
};

// 时间性内容留槽位（AMSG_SLOT_*），由 worker 在 fire 时刻用 renderFirePack 填。
// 文案模板本身仍在前端这份代码里维护。
// includeTime：角色关掉「时间感知」时，这一段里报钟的两行连槽位一起不进模板
// （见 buildFirePack 的同名判断）。
const buildLegacyStyleProactiveHint = (targetName: string, includeTime: boolean) => {
  const target = targetName || '对方';

  return [
    '【1.0 风格主动消息提示】',
    ...(includeTime ? [`现在是 ${AMSG_SLOT_CURRENT_TIME}。`, AMSG_SLOT_AWAY_HINT] : []),
    `这不是 ${target} 正在和你聊天，而是你突然想起了 ${target}，想主动发条消息给他/她。`,
    `像真人随手发消息一样自然一点，可以是分享刚看到的东西、轻轻吐槽、问一句近况、突然想念，或者单纯想找 ${target} 聊两句。`,
    `${target} 不在的这段时间，你自己的日子也在往前过：刚发生的小事、注意到的细节、对之前聊过的话冒出来的后续想法，都比干巴巴的问候更像你。`,
    '不要写成汇报近况，不要像在完成任务，也不要解释自己为什么会发这条消息。',
    `关心别变成查岗：不催问 ${target} 在干嘛、怎么还不回；喝水、早睡这类叮嘱偶尔一句是心意，回回都发就成了说教。`,
    `正文尽量短，通常 1 到 2 句就够；如果 ${target} 很久没来找你，可以轻轻带一点想念、好奇或者小小抱怨。`,
  ].join('\n');
};

// 拼出带时间槽位的完整 prompt 模板（fire_pack）：原样 putClientState 上云，
// worker 到点用 renderFirePack 填槽（所以上下文永远是最后一次聊天的状态）。
/**
 * 表情包全库（按角色过滤前）。批量同步时由调用方读一次传进来——它跟角色无关，
 * 一个角色读一遍的话，N 个角色就是 N 次全表 getAll，读回来的还是同一份。
 */
type EmojiLibrary = { all: Emoji[]; categories: EmojiCategory[] };

const readEmojiLibrary = async (): Promise<EmojiLibrary> => {
  const [all, categories] = await Promise.all([DB.getEmojis(), DB.getEmojiCategories()]);
  return { all, categories };
};

// export 只为单测（activeMsgClient.test.ts 钉 tzId 取值与模板不烤时间）。
export const buildFirePack = async (
  char: CharacterProfile,
  userProfile: UserProfile,
  groups: GroupProfile[],
  realtimeConfig: RealtimeConfig | undefined,
  emojiLibrary?: EmojiLibrary,
  opts?: {
    /**
     * 用占位模板替代真模板（跳过系统提示词 + 近史转写 + 表情全库读取这三样大头）。
     * 只许在「这份包的模板确定无人渲染」时传：即时对话发送路径上，角色 2.0 关着
     * （selfScheduleEnabled=false，云端 fire 不给排程能力）且本地任务清单为空。
     * 其余字段（scene / lastUserMessageAt / pendingTasks / tzId…）照常构建——
     * 即时 fire 自己要读它们（sceneSong、锚点、任务清单块）。
     */
    templateStub?: boolean;
  },
): Promise<AmsgFirePack> => {
  const templateStub = opts?.templateStub === true;
  const [{ recentMessages, lastUserMessageAt }, library, schedule] = await Promise.all([
    buildTimeGapHint(char.id),
    // 表情库只喂系统提示词/近史渲染：占位模板路径整库都不用读（表情记录带图片数据，
    // 全表 getAll 不便宜）。
    templateStub
      ? Promise.resolve({ all: [], categories: [] } as unknown as EmojiLibrary)
      : (emojiLibrary ? Promise.resolve(emojiLibrary) : readEmojiLibrary()),
    // 日程随包带原始表（不是渲染好的文字），worker 到点自己挑时段。总开关关掉的角色没有表。
    isScheduleFeatureOn(char)
      ? getDailyScheduleForChar(char).catch((e) => {
          console.warn('[ActiveMsg2] 日程读取失败，这次不带作息表', char.id, e);
          return null;
        })
      : Promise.resolve(null),
  ]);
  // 角色的时间参照系：开了自定义时区用角色的，没开用设备的。worker 渲染一切给角色看的
  // 时间（当前时间、日程日期、排程清单）都按它来。
  const charTz = resolveCharTimeZone(char);
  const tzId = charTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 用户设备自己的钟。跟 tzId 分开存：角色排消息时得知道「对方那边现在几点」，
  // 不然异国恋角色会把「晚上聊两句」排到用户的凌晨三点，而且没有任何线索能让它避开。
  const userTzId = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 时间相关的行整块跟着角色的「时间感知」开关走：关掉的角色在前台连今天几号都读不到
  // （buildTimeAwarenessBlock 直接返回空串），主动消息这边却精确报出年月日 + 星期，
  // 是同一个开关的两套行为。关掉时这几行连槽位一起不进模板。
  // 排程工具的 send_at 说明不受影响（那份在 amsgFireSchedule）：排时间本来就得知道现在几点。
  const timeAware = char.timeAwarenessEnabled !== false;
  // 只摘渲染会读到的字段：整份日程里还挂着每个时段缓存的小剧场台词和看板图，
  // 带上去只是白占云端状态的体积（fire_pack 本来就有几万字）。
  const scene: AmsgFireScene | null = schedule
    ? {
        charId: char.id,
        // 这份表是角色当地「今天」的安排，到点先比日期再用（见 renderFireSceneBlock）。
        dateKey: getLocalDateKey(nowInTimeZone(tzId)),
        schedule: {
          slots: schedule.slots.map((s) => ({
            startTime: s.startTime,
            activity: s.activity,
            ...(s.description ? { description: s.description } : {}),
            ...(s.emoji ? { emoji: s.emoji } : {}),
            ...(s.location ? { location: s.location } : {}),
            ...(s.innerThought ? { innerThought: s.innerThought } : {}),
          })),
          ...(schedule.flowNarrative ? { flowNarrative: schedule.flowNarrative } : {}),
        },
        songPool: buildSongPool(char).map((s) => ({ id: s.id, name: s.name, artists: s.artists })),
      }
    : null;
  const legacyHint = buildLegacyStyleProactiveHint(userProfile.name || '对方', timeAware);
  // 前台每轮都注入的时差说明（「你身处 X 时区……对方可能在不同时区」）。它是静态文案、
  // 不随时间变，所以打包时就烤进模板；到点由 AMSG_SLOT_USER_CLOCK 补上「对方那边现在
  // 几点」。fire 侧的角色设定是 skipTimeAwareness 建的，整块时间感知都被抹掉了，
  // 不在这里补回来的话，最容易撞用户睡觉的恰恰是主动消息。
  const tzNote = timeAware ? tzAwarenessNote(charTz).trim() : '';
  // 按角色可见性过滤表情包：主动消息不经过 Chat.tsx 的 aiVisibleEmojis/visibleCategories，
  // 必须在这里复用同一套过滤，否则角色会用到只对其他角色开放的表情包。
  const { emojis, categories } = ChatPrompts.filterVisibleEmojis(
    library.all,
    library.categories,
    char.id,
  );
  const systemPrompt = templateStub ? '' : await ChatPrompts.buildSystemPrompt(
    char,
    userProfile,
    groups,
    emojis,
    categories,
    recentMessages,
    realtimeConfig,
    undefined,
    undefined,
    undefined,
    undefined,
    // 模板是现在打好、到点才渲染的，凡是「打包这一刻」的状态都不烤进去。
    // 具体拿掉哪些块、到点由谁补，见 ChatPrompts.PromptBuildOptions 上的表。
    { forFirePack: true },
  );
  const recentTranscript = templateStub ? '' : ChatPrompts.buildMessageHistory(
    recentMessages,
    Math.min(char.contextLimit || 120, 120),
    char,
    userProfile,
    emojis,
  ).apiMessages
    .slice(-30)
    .map((message) => formatHistoryLine(message.role, message.content, char, userProfile))
    .join('\n\n');

  // 记忆库里有哪些月份查得到 —— 提示词一直在教角色用 [[RECALL: 年-月]]，却没说过
  // 哪些月份有东西。不报菜单的话它多半不查，直接凭空编一段「回忆」出来。
  // 只写进下面这段主动消息自己的规则里，不动 chatPrompts 那条所有角色每轮都走的主链路。
  const recallableMonths = listRecallableMonths(char.memories);
  const recallHint = recallableMonths.length > 0
    ? `- 你的记忆库里存着这些月份的经历：${recallableMonths.join('、')}。想聊起其中某段时，先输出 [[RECALL: 年-月]] 把细节取回来再写，别凭印象编。`
    : null;

  const template = templateStub ? AMSG2_INSTANT_STUB_TEMPLATE : [
    '你将代表下面这个角色，生成一条“主动发给用户”的私聊消息。',
    '',
    '【重要规则】',
    '- 这不是回复用户刚刚发来的消息，而是角色主动来找用户聊天。',
    '- 输出只能是最终要发送的消息正文，不要解释，不要写分析，不要加引号。',
    '- 像真实聊天一样简短自然，优先 1 到 2 句，最多 3 句。',
    '- 可以用换行拆成多个聊天气泡，但不要写时间戳、名字前缀、系统提示。',
    '- 不要出现“作为AI”“系统提示”等元话语。',
    '- 语气更像真人突然想起对方时发来的私聊，不要像在完成任务。',
    '- 角色设定里描述的查记忆、读日记、联网搜索、逛小红书等能力照常可用：需要时正常输出对应标签，系统会取回结果后让你继续写。',
    ...(recallHint ? [recallHint] : []),
    '',
    '【角色系统设定】',
    systemPrompt,
    `（注意：上面角色设定里的情绪、印象等状态是最近一次聊天时的快照。${timeAware ? '此刻的时间、你正在做什么' : '你此刻正在做什么'}，以下方「当前时刻补充」为准。）`,
    '',
    '【最近对话上下文】',
    // 槽位直接黏在最后一行后面（不单独占一行）：worker 到点没有可写的自述时填空串，
    // 输出跟没这个槽位一模一样；有内容时那段自带前导空行，见 renderSelfLogBlock。
    `${recentTranscript || '（暂时没有最近聊天记录）'}${AMSG_SLOT_SELF_LOG}`,
    '',
    // 「此刻在做什么」紧跟当前时间：日程时段本来就要对着钟读，挨在一起才对得上。
    // 没日程的角色 worker 填空串，这一行连带消失（那段自带前导空行，见 renderFireSceneBlock）。
    // 时区那两行也挨着钟：静态说明打包时就烤好，「对方那边现在几点」由 worker 到点现算——
    // 一个是角色自己的钟、一个是用户的钟，各自把主语写在文案里，别让模型以为在打架。
    ...(timeAware
      ? [
          '【当前时刻补充】',
          `当前本地时间（你所在地）：${AMSG_SLOT_CURRENT_TIME}${tzNote ? `\n${tzNote}` : ''}${AMSG_SLOT_USER_CLOCK}${AMSG_SLOT_SCENE}`,
        ]
      // 关了时间感知的架空角色：整段只剩「你在做什么 / 外面什么样」，一个钟都不给。
      : [`【当前时刻补充】${AMSG_SLOT_SCENE}`]),
    // 排程清单跟在时间后面：它整段都在讲「几点会发生什么」，挨着当前时刻读才对得上。
    // 没有待触发任务时 worker 填空串，这一行连带消失。
    // 最后是「外面的世界此刻什么样」（节日 / 天气 / 热搜）：跟时间同属「此刻的读数」，
    // 一样由 worker 到点现拉现填，拉不到就整段消失。
    `${timeAware ? AMSG_SLOT_TIME_SINCE_USER : ''}${AMSG_SLOT_TASK_LIST}${AMSG_SLOT_REALTIME_WORLD}`,
    '',
    legacyHint,
    '',
    '【本次任务】',
    AMSG_SLOT_TASK_INSTRUCTION,
    '',
    // recency 末位人声锚：上面【角色系统设定】里已带「回到你自己」钢印，但被任务说明压在后面、
    // 失了 recency。这里在最后一句把它拎回来，让主动消息也从「你这个人」长出来，而不是滑回均值腔。
    `（开口前回到你自己：这条得是 ${char.name} 会发的那一条——语气、用词、节奏都只属于你。哪怕只是随口一句，也要是你。）`,
  ].join('\n');

  return {
    // 版本号只有 amsgFirePack 那一份说了算：写死数字的话，升版时 worker 侧的 parseFirePack
    // 已经在按新号校验，而这里还发着旧号，表现是每条任务到点都硬失败。
    v: FIRE_PACK_VERSION,
    template,
    lastUserMessageAt,
    // 角色的时间参照系（见上面的 tzId / userTzId）：前者是角色自己的钟，后者是用户那边的，
    // worker 渲染时两者各管各的一行，绝不混用。
    tzId,
    userTzId,
    targetName: userProfile.name || '对方',
    // 这份模板的身份戳：worker 用它判断云端自述日志里哪些正文已经进了新转写、
    // 自排任务备账还配不配得上当前清单（见 amsgFirePack 的 reconcileSelfLogWithPack）。
    // 每打一次包都是新值。
    builtAt: Date.now(),
    // 用户主权连发上限（0 = 不限；没设就不带，worker 用默认值）。worker 拿它拦两处：
    // 排程工具打回超额自排、角色自排任务到点兜底作废。用户面板排的任务不受它管。
    ...(typeof char.activeMsg2Config?.maxUnansweredSends === 'number'
      ? { maxUnansweredSends: char.activeMsg2Config.maxUnansweredSends }
      : {}),
    // 角色级 2.0 开关随包上云：关着的角色即便走即时对话（全局开关是另一颗），云端
    // fire 也不给排程能力——本地的 amsg2ToolsInjected 闸门在云端的对应物就是它。
    selfScheduleEnabled: isAmsg2EnabledForChar(char),
    // 到点时角色要知道自己还挂着什么，才不会把同一件事再排一遍。这里带原始记录，
    // 渲染成人话由 worker 现场做（时间要按 tzId 换算，且得摘掉正在发的那条）。
    pendingTasks: getPendingTasks(char.activeMsg2Config, Date.now()),
    // 「此刻在做什么」也带原始素材：整天的作息表 + 歌单抽样池，worker 到点按 tzId
    // 挑当前时段。烤成文字的话，凌晨三点触发时角色会说「我在健身房呢」。
    scene,
  };
};

/**
 * 按任务生成「本次任务」指令——排程时写进 task metadata，worker 到点填槽。
 * 实现搬到了 amsgFireSchedule（worker 也要用同一份），这里转出去保持调用方不动。
 */
export { buildTaskInstruction } from './amsgFireSchedule';

/**
 * 首次发送时间 → 绝对时刻（UTC ISO）。
 *
 * 裸墙钟（`2026-08-03T09:00:00`，datetime-local 输入框和角色用工具排程时给的都是这种）
 * 按 tz 参照系解释，跟 worker 到点解析 send_at 是同一份规则（amsgFireSchedule.resolveSendAtMs）。
 * 各解各的话，纽约角色说的「明早九点」，前端按设备的东八区算成绝对时刻，worker 又按
 * 角色时区去理解，同一句话差整整一个时差。带 Z / ±hh:mm 后缀的照标注解析。
 */
const ensureFutureTime = (value: string, tzId: string) => {
  const ms = resolveSendAtMs(value, { tzId });
  if (Number.isNaN(ms)) {
    throw new Error('请选择有效的首次发送时间。');
  }
  if (ms <= Date.now()) {
    throw new Error('首次发送时间必须晚于当前时间。');
  }
  return new Date(ms).toISOString();
};

/**
 * 任务体里 messages 的占位内容。
 *
 * 服务端要求「completePrompt 或 messages」二选一、messages 非空、content 非空字符串，
 * 所以哪怕真正的 prompt 是到点才由 worker 下发的，排程时也得塞点东西过校验。
 * 写成一眼能认出来的标记：它要是出现在 worker 日志、模型输出或者聊天气泡里，
 * 就说明 worker 的 fire hooks 没生效（正常路径下它会被 onBeforeFire 的返回值覆盖）。
 */
const AMSG2_PLACEHOLDER_PROMPT =
  'AMSG2_PLACEHOLDER_PROMPT（正式 prompt 到点由 worker onBeforeFire 下发；看到这条说明 fire hooks 未生效）';

/**
 * fire_pack 里 `chat.messages` 的体积上限（对 `JSON.stringify(messages)` 按 UTF-8 字节算）。
 *
 * 上限是这么推出来的：
 *   1. 上游按**条目**卡体积：PUT /client-state 的 validateEntry 拿
 *      `new TextEncoder().encode(entry.value).length` 跟 maxStateValueBytes 比，超了回
 *      STATE_VALUE_TOO_LARGE。我们的 worker 没配这个值 → 用库的默认 5 MiB。
 *      注意它量的是**我们交出去的那个字符串**（服务端落库前的加密不算在内）。
 *   2. 不能指望压缩帮忙：packStateValue 在运行时没有 CompressionStream（老 Safari）
 *      或者压完更大时会原样返回，所以按「一点没压」的原始 JSON 算才是诚实的。
 *   3. fire_pack 里除了这串对话还有别的：完整角色卡 + 世界书 + 最近对话的 template、
 *      pendingTasks、scene。给它们留 1 MiB。剩 4 MiB。
 *   4. 再对折留一半余量 —— 同一批字节还要坐 /instant-chat 的请求体，外面套一层
 *      AES-GCM + base64（涨三分之一）；而这么大的 body 走手机上行，往往在服务端
 *      来得及判它超没超之前就先被上行超时掐掉了。
 * → 2 MiB。
 */
const CHAT_CONTENT_BUDGET_BYTES = 2 * 1024 * 1024;

const utf8ByteLength = (text: string): number => new TextEncoder().encode(text).length;

/** 结构化分段里有没有图片这类非文字内容（只有文字段的数组拆了也省不下什么）。 */
const hasNonTextPart = (content: unknown): boolean =>
  Array.isArray(content) && content.some((part: any) => part?.type !== 'text');

// 「图片消息 → 文字占位」的拍平内核与本地 stripImages 路径共用同一份
// （promptMessageCleanup.flattenContentPartsToText）：超预算降级产物必须与
// 本地拍平产物严格同源，否则同一条历史消息在两条生成路上渲染成两种样子。

/**
 * 本地那串 fullMessages → fire_pack 的 `chat.messages`。
 *
 * **原样搬运**：带图片的消息本地是结构化的（`[{type:'text'},{type:'image_url'}]`，
 * 图片是 base64 data URL），这里一个字都不动地带上云——即时对话的整个前提就是
 * 「云端跑出来的回复和本地跑出来的一模一样」，模型看不看得见图片是这里面差别最大的一项。
 *
 * 唯一的例外是体积：一条 client_state 有硬上限（见 CHAT_CONTENT_BUDGET_BYTES）。
 * 超了就**从最老的消息开始**丢图片本体（换成它自己的文字段，也就是以前那种拍平结果），
 * 一条一条丢到进预算为止。最新那条用户消息的图片永远不丢——用户刚发的这张图正是
 * 这一轮要聊的东西，把它丢了等于答非所问，而用户完全看不出来。
 *
 * 丢到只剩最新那条还是超预算 → 抛错，走「即时对话发送失败」那条明路，绝不悄悄把
 * 当前这轮截断。报错分两种：删掉最新那张图能救回来的，指向图片；纯文本本身就超限的
 * （长角色卡 + 世界书 + 近史），如实说上下文太大——这种情况用户没有图可删。
 */
export const toFirePackChatMessages = (
  messages: Array<{ role: string; content: unknown }>,
): Array<{ role: string; content: AmsgFirePackChatContent }> => {
  const result: Array<{ role: string; content: AmsgFirePackChatContent }> = messages.map((message) => {
    if (typeof message.content === 'string') return { role: message.role, content: message.content };
    // 结构化分段整段原样带走（分段内部长什么样是 chat API 的方言，这里不解释也不改写）。
    if (Array.isArray(message.content)) {
      return { role: message.role, content: message.content as AmsgFirePackChatContent };
    }
    return { role: message.role, content: String(message.content ?? '') };
  });

  // 体积账做增量：全量 stringify 只做这一次。整串 JSON 是「[ 条目,条目,… ]」，
  // 换掉第 i 条时分隔符一个字节都不动，总字节的变化就恰好是这条自身序列化字节的差。
  // 把全量 stringify 放进下面循环的条件里的话，每压平一条都要翻搅一遍整串
  // （带图历史动辄数 MB），发生在用户刚按下发送的主线程上，一次就是秒级卡顿。
  const entryBytes = (entry: { role: string; content: AmsgFirePackChatContent }) =>
    utf8ByteLength(JSON.stringify(entry));
  let totalBytes = utf8ByteLength(JSON.stringify(result));
  if (totalBytes <= CHAT_CONTENT_BUDGET_BYTES) return result;

  // 最新那条用户消息 = 用户刚发出去、正在等回复的这一条。它的图片是这一轮的题面。
  let protectedIdx = -1;
  for (let i = result.length - 1; i >= 0; i -= 1) {
    if (result[i].role === 'user') { protectedIdx = i; break; }
  }

  // 从最老的开始丢：越老的图片对这一轮越不重要，而正文那句「用户发来一张图片」还在，
  // 模型至少知道当时发生过这件事。
  for (let i = 0; i < result.length && totalBytes > CHAT_CONTENT_BUDGET_BYTES; i += 1) {
    if (i === protectedIdx || !hasNonTextPart(result[i].content)) continue;
    const bytesBefore = entryBytes(result[i]);
    result[i] = { role: result[i].role, content: flattenContentPartsToText(result[i].content as unknown[]) };
    totalBytes -= bytesBefore - entryBytes(result[i]);
    console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 即时对话这轮体积超标，第 ${i + 1} 条消息的图片本体没带上云（文字段保留）`);
  }

  if (totalBytes > CHAT_CONTENT_BUDGET_BYTES) {
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    // 走到这里，能拍的图全拍平了，还带着图的只可能是受保护的最新那条用户消息。
    // 报错前先算一笔账：把它的图也拍掉能不能进预算。能 → 罪魁确实是这张图，让用户
    // 删图/换小图是条真出路；不能 → 超限的是纯文本本身（长角色卡 + 世界书 + 近史），
    // 这时候还叫人删图就是指错路——用户可能压根没发过图，照着做也永远修不好。
    const protectedEntry = protectedIdx >= 0 ? result[protectedIdx] : undefined;
    const protectedImageBytes = protectedEntry && hasNonTextPart(protectedEntry.content)
      ? entryBytes(protectedEntry) - entryBytes({
          role: protectedEntry.role,
          content: flattenContentPartsToText(protectedEntry.content as unknown[]),
        })
      : 0;
    if (totalBytes - protectedImageBytes <= CHAT_CONTENT_BUDGET_BYTES) {
      throw new Error(
        `即时对话发不出去：这一轮要带的图片太大（约 ${mb(totalBytes)} MB，上限 ${mb(CHAT_CONTENT_BUDGET_BYTES)} MB）。`
        + '删掉图片、或者换一张小一点的再发。',
      );
    }
    throw new Error(
      `即时对话发不出去：这一轮上下文太大（约 ${mb(totalBytes)} MB，即时对话单轮上限 ${mb(CHAT_CONTENT_BUDGET_BYTES)} MB）。`
      + '精简一下上下文（比如角色设定、世界书或携带的历史条数），或先关掉即时对话走本地生成。',
    );
  }
  return result;
};

/** POST /instant-chat 的失败原因（包装层的错误码 → 一句能照着做的话）。 */
export const describeInstantChatFailure = (status: number, body: any): string => {
  const code = body?.error?.code;
  const upstream = body?.error?.upstream?.error?.message || body?.error?.upstream?.message;
  // Worker 内部真正抛出来的那句（`D1_ERROR: no such table …` 之类）。上游只回一句写死的
  // 「服务器内部错误」，包装层从它的日志里把原文捞了出来（见 worker 的 forwardWithFatalLog）。
  // 这才是能照着做事的那一句，所以排在泛型报文后面一起给出来，别让人再去翻 Cloudflare 面板。
  const upstreamLog = typeof body?.error?.upstreamLog === 'string' ? body.error.upstreamLog : '';
  const detail = [body?.error?.message, upstream, upstreamLog].filter(Boolean).join('：');
  if (status === 401 || code === 'INVALID_CLIENT_TOKEN') {
    return '即时对话没发出去：共享密钥和 Worker 上的对不上，去「主动消息 2.0」设置里核对一下。';
  }
  if (status === 405 || status === 404) {
    return '即时对话没发出去：Worker 上还没有这个端点，去你 fork 的 sullyos-workers 点一下 Sync fork 更新。';
  }
  if (status === 503) {
    return '即时对话没发出去：Worker 的环境变量没配齐（设置页点「重新连接并验证」能看到缺什么）。';
  }
  // 上游打回「时间必须在未来」：firstSendTime 是设备的钟加提前量算出来的，被打回
  // 说明提前量在路上被吃光了——要么整包状态上传得太慢，要么设备时钟本身偏慢。
  // 这两种用户能做的事是一样的：重试，或去检查自动对时。别让它掉进下面那句
  // 光秃秃的 HTTP 400。
  if (body?.error?.upstream?.error?.code === 'INVALID_TIMESTAMP') {
    return '即时对话没发出去：没赶上服务端的时间校验——网络太慢，或设备时钟偏慢。'
      + '重试一次通常就好；每次都这样的话，检查一下设备的「自动设置时间」开没开。';
  }
  return `即时对话没发出去（HTTP ${status}${code ? ` / ${code}` : ''}）${detail ? `：${detail}` : '。'}`;
};

/**
 * 这个错误体是不是「引用的凭据行在云端不存在」。
 *
 * 两层都看：排程直接调上游时错误码就在顶层；即时对话经包装层，上游那份原样躺在
 * `error.upstream` 里。补传自愈的两处（排程 / 即时对话）共用这一把尺。
 */
export const isCredentialNotFound = (body: any): boolean =>
  body?.error?.code === 'CREDENTIAL_NOT_FOUND'
  || body?.error?.upstream?.error?.code === 'CREDENTIAL_NOT_FOUND';

/** client_state 上传每次尝试前等多久：数组长度即总尝试次数（首次不等）。 */
const CLIENT_STATE_BACKOFF_MS = [0, 400, 1200];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 上传一批 client_state 条目：网络抖动重试，最终失败抛错——不降级。
 *
 * 为什么这一步是硬要求：worker 到点靠 fire_pack 拿新鲜上下文，「远端有任务、云端
 * 没状态」是个不该存在的中间态。过去这里失败只 warn，任务照建，到点用排程那一刻
 * 冻结的 prompt 发——用户不知道自己收到的是旧上下文。现在传不上去就让整个排程失败，
 * 由用户 / 角色重试。
 *
 * 被 worker 点名 rejected（体积超限等结构性原因）不重试：重试不会变好，直接把原因
 * 抛出来。注意 putClientState 失败有两种形态——抛异常和回 { success: false }，
 * 两种都要接住，只判 try/catch 会漏掉后者。
 */
export const putClientStateOrThrow = async (
  client: ReiClient,
  entries: Array<{ namespace: string; key: string; value: string; updatedAt: number }>,
  phase: string,
): Promise<void> => {
  let lastError: unknown;

  for (const backoffMs of CLIENT_STATE_BACKOFF_MS) {
    if (backoffMs) await delay(backoffMs);

    let response: { success?: boolean; data?: { rejected?: Array<{ key: string; message?: string }> }; error?: { message?: string } } | undefined;
    try {
      response = await client.putClientState(entries) as typeof response;
    } catch (error) {
      lastError = error;
      continue;
    }

    if (!response?.success) {
      lastError = new Error(response?.error?.message || `${phase}失败。`);
      continue;
    }

    const rejected = response.data?.rejected;
    if (rejected?.length) {
      throw new Error(
        `${phase}被 Worker 拒绝：${rejected.map((r) => `${r.key}(${r.message || 'rejected'})`).join('、')}。`
        + '请确认已部署最新的 Worker 代码（设置页有版本探测）。',
      );
    }
    return;
  }

  throw normalizeActiveMsgApiError(lastError, phase);
};

/**
 * 把一个 namespace 下还有内容的条目全部清空，返回被清掉的键名。
 *
 * 先读一遍再逐条写空，而不是照着已知键名盲写，有两个原因：
 *   1. 旁路存储的键名带 clientTaskId（`xhs_session:<id>`），任务记录被
 *      pruneStaleTasks 清掉之后就再也拼不出来，只能靠读回来才知道有哪些；
 *   2. 盲写会把本来不存在的条目 upsert 出来 —— putClientState 是 upsert，
 *      "清理" 反倒变成新建。
 *
 * 和 clearClientStateValue 一样是写空串而不是删行（HTTP 的 PUT /client-state 没有
 * 删除语义，value: null 会被当无效条目跳过），留下的是几字节的空壳，内容本身没了。
 */
export const clearNamespaceValuesOrThrow = async (
  client: ReiClient,
  namespace: string,
): Promise<string[]> => {
  // 全局 namespace 不许走这条路：里面的 tool_config 只在配置变更时才重传，被清成空壳
  // 之后没有任何一条路会把它补回来，而 worker 到点读不到它就整条任务硬失败。
  // 这个函数目前只服务「删角色」（每角色一个 namespace），加道护栏免得将来被顺手复用。
  if (namespace === AMSG_GLOBAL_NAMESPACE) {
    throw new Error('全局云端状态不能按 namespace 清空（tool_config 清掉就没人补了）。');
  }
  const response = await client.getClientState(namespace);
  if (!response?.success) {
    throw new Error(response?.error?.message || '读取云端状态失败。');
  }
  const entries = (response.data?.entries ?? []) as Array<{ key?: string; value?: string }>;
  // 已经是空壳的条目跳过：再写一遍不会更干净，只是白占一次请求体。
  const keys = entries.filter((e) => e?.key && e?.value).map((e) => e.key as string);
  if (keys.length === 0) return [];

  const now = Date.now();
  await putClientStateOrThrow(
    client,
    keys.map((key) => ({ namespace, key, value: '', updatedAt: now })),
    '清空云端状态',
  );
  return keys;
};

/**
 * 这个角色此刻欠着一条即时对话的回复吗（发送还在飞 / 已受理还没收到）。
 *
 * 欠着的那段时间里，云端的 fire_pack 是 POST /instant-chat 带上去的那一份，比常规的包
 * 多一段 chat —— worker 到点全靠它拿这一轮的对话。常规重建的包没有 chat 段，覆盖上去
 * worker 只会硬失败（「fire_pack 里没有 chat 段」），重试梯子上每一跳都是同一个错，
 * 用户最后拿到一句「即时对话没能完成」，话还得自己重发一遍。
 *
 * 所以凡是会写 fire_pack 的路径，写之前都得先问一次这里：批量同步（amsgStateSync 的
 * 挂起段）和排程（scheduleCharacterTask）共用这一把尺，别各写各的。
 *
 * 「发送在飞」这一半不能省：待收记录要 202 回来才有，光认它的话，慢网上传的那几秒
 * 正好是敞着的。
 */
export const owesInstantChatReply = (charId: string): boolean =>
  !!getInstantChatPending(charId) || isInstantChatSendInFlight(charId);

/**
 * 角色侧云端状态的两条条目（fire_pack + tool_pack）。
 *
 * 「哪个 namespace 配哪个 key 配哪个 build 函数」只在这里写一遍：排程和批量同步两条路
 * 都得把同一批东西写上去，各写各的话漏一条就是 worker 到点读不到 → 整条任务硬失败。
 */
const buildCharStateEntries = async (
  char: CharacterProfile,
  firePack: AmsgFirePack,
  updatedAt: number,
  promptControls: AmsgToolPromptControls = readAmsgToolPromptControls(),
) => [
  {
    namespace: amsgStateNamespace(char.id),
    key: AMSG_FIRE_PACK_KEY,
    // 压在加密之前：上游 putClientState 先加密再发，密文压不动（见 amsgFirePack）。
    value: await packStateValue(JSON.stringify(firePack)),
    updatedAt,
  },
  // v2 服务端工具循环的角色侧数据（recall 月度总结 / XHS 开关 / 角色名）。
  {
    namespace: amsgStateNamespace(char.id),
    key: AMSG_TOOL_PACK_KEY,
    value: await packStateValue(JSON.stringify(buildToolPack(char, promptControls))),
    updatedAt,
  },
];

/** 全局工具凭据条目（v2 服务端工具循环用的搜索 / Notion / 飞书 / 小红书 / 自配 MCP 配置）。 */
const buildToolConfigEntry = (
  realtimeConfig: RealtimeConfig | undefined,
  updatedAt: number,
  promptControls: AmsgToolPromptControls = readAmsgToolPromptControls(),
) => ({
  namespace: AMSG_GLOBAL_NAMESPACE,
  key: AMSG_TOOL_CONFIG_KEY,
  // MCP 配置在这里现读现带：三条上传路径（排程 / fire_pack 冲刷 / 设置保存）
  // 全走这个咽喉，不会出现某条路漏带的版本分叉。
  value: JSON.stringify(buildToolConfig(realtimeConfig, {
    servers: promptControls.mcpTools ? collectMcpFireServers() : [],
    useNativeTools: getMcpUseNativeTools(),
  }, promptControls)),
  updatedAt,
});

/**
 * 现有推送订阅还能不能继续用；不能用的当场退订，返回 null 让调用方重新订阅。
 *
 * 两种「留着必失联」的形态：
 *   1. 死端点——浏览器把订阅僵尸化成 `permanently-removed.invalid` 哨兵，推必失败；
 *   2. 绑的 VAPID 公钥跟目标 worker 的不一致——换过 VAPID 后旧订阅还签着老公钥，
 *      worker 发推会被推送服务 403 拒掉。
 * 退订后要等浏览器清内部 removed 标记（SUBSCRIBE_SETTLE_MS），否则紧接着的
 * subscribe() 又拿到死哨兵。
 *
 * 判定口径与 instantPushClient.getOrCreateInstantSubscription /
 * proactivePushConfig.getOrCreateSubscription 的内联实现一致；那两处在各自文件里，
 * 将来合并时以这份抽出来的函数为准。export 供单测 mock pushManager 钉行为。
 */
export const dropStaleSubscription = async (
  sub: PushSubscription | null,
  targetVapidPublicKey: string,
): Promise<PushSubscription | null> => {
  if (!sub) return null;
  if (isDeadPushEndpoint(sub.endpoint)) {
    try { await sub.unsubscribe(); } catch { /* ignore */ }
    await delay(SUBSCRIBE_SETTLE_MS);
    return null;
  }
  try {
    const existingKey = bytesToB64u(sub.options.applicationServerKey);
    if (existingKey && existingKey !== targetVapidPublicKey) {
      await sub.unsubscribe();
      await delay(SUBSCRIBE_SETTLE_MS);
      return null;
    }
  } catch {
    // 公钥读不出来（个别浏览器不暴露 options）就按可复用处理——
    // 与 instant / proactive 两处同款 fall-through。
  }
  return sub;
};

/**
 * 重置类操作的前置：Worker 地址填了、浏览器有推送能力、通知权限拿到了。
 *
 * 权限这一步会弹框（用户点的就是「重置订阅」，弹一次合理）；没给就直接抛，
 * 别硬着头皮往下走——没有权限 subscribe() 必然失败，报「订阅失败」会把用户
 * 引去查网络，实际上只要去站点设置里放开通知。
 */
const requirePushReady = async (): Promise<ActiveMsg2GlobalConfig> => {
  const capabilityGap = describePushCapabilityGap();
  if (capabilityGap) throw withFailKind(new Error(`${capabilityGap}。`), '不支持推送');

  const config = await ensureWorkerReady();

  let permission = Notification.permission;
  if (permission !== 'granted') permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw withFailKind(new Error('通知权限未授予，没法重建推送订阅。'), '权限被拒');
  }

  await KeepAlive.init();
  return config;
};

/** 退掉当前这条浏览器订阅，并等浏览器把内部的 removed 标记清完再返回。 */
const unsubscribeCurrentPush = async (): Promise<void> => {
  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (!existing) return;
    try { await existing.unsubscribe(); } catch { /* 退不掉也继续，下面重订会再试 */ }
    // 不等的话，紧接着的 subscribe() 大概率直接吐 permanently-removed.invalid 哨兵。
    await delay(SUBSCRIBE_SETTLE_MS);
  } catch (error) {
    console.warn('[ActiveMsg] 退订旧推送订阅时出错，继续重建', error);
  }
};

/**
 * 问 worker 要它自己签推送用的 VAPID 公钥。
 *
 * 各用户自部署 worker、各有各的 VAPID，运行时拉、不编译进前端。拿别人的公钥订阅，
 * worker 推的时候会 403。
 */
const fetchWorkerVapidKey = async (client: ReiClient): Promise<string> => {
  let vapidPublicKey: string;
  try {
    vapidPublicKey = await client.getVapidPublicKey();
  } catch (error) {
    throw normalizeActiveMsgApiError(error, '获取 Worker VAPID 公钥');
  }
  if (!vapidPublicKey) {
    throw withFailKind(new Error('Worker 没返回 VAPID 公钥，请确认已配置 VAPID 并部署了最新 worker。'), 'worker没配VAPID');
  }
  return vapidPublicKey;
};

/**
 * 建一条新的浏览器推送订阅，拿不到活端点就抛。
 *
 * 走共用的 subscribeWithRetry 而不是 `ReiClient.subscribePush`：后者是裸的
 * `pushManager.subscribe()`，刚退订完的窗口期里浏览器会吐 permanently-removed.invalid
 * 哨兵，它照单收下——那个死端点一旦被登记进 worker，用户看到「订阅成功」，到点却一条
 * 都收不到，两边都没有任何报错。重试到底仍是僵尸的话挂 '端点僵尸' 代号，设置页据此
 * 把「重置订阅」升级成「深度重置」。
 */
/** 共用层的失败分类 → 上报用的失败代号。两边都是源码里写死的枚举。 */
const SUBSCRIBE_FAIL_KIND: Record<SubscribeFailureKind, AmsgFailKind> = {
  'channel-unreachable': '推送通道不通',
  unsupported: '不支持推送',
  permission: '权限被拒',
  state: '订阅失败',
  zombie: '端点僵尸',
  unknown: '订阅失败',
};

const subscribeOrThrow = async (
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string,
): Promise<PushSubscription> => {
  const { sub, failure } = await subscribeWithRetry(registration, vapidPublicKey, ACTIVE_MSG_RUNTIME_HEADER);
  if (sub) return sub;
  // 提示原文（浏览器能力、重试了几次）留在 toast 和 console 里。挂上去的代号来自
  // 上面那张写死的表，不是从异常对象上读出来的任何东西。
  const message = failure?.text || '订阅创建失败';
  throw withFailKind(new Error(message), failure ? SUBSCRIBE_FAIL_KIND[failure.kind] : '订阅失败');
};

/** 重置的公共尾段：拿 worker 的 VAPID → 重新订阅 → 覆盖登记回 worker。 */
const resubscribeAndRegister = async (client: ReiClient): Promise<void> => {
  const vapidPublicKey = await fetchWorkerVapidKey(client);
  const registration = await navigator.serviceWorker.ready;
  const sub = await subscribeOrThrow(registration, vapidPublicKey);

  try {
    await client.putPushSubscription(sub);
  } catch (error) {
    throw normalizeActiveMsgApiError(error, '登记推送订阅');
  }
};

/**
 * 带鉴权头请求 worker，同时把 HTTP 状态一起交出来。
 * 状态只有「连接」那条路用得上（401/404/其它要引导用户去改的地方不同），
 * 其余调用方走下面那层薄壳，签名跟以前一样只拿 body。
 */
const fetchWithAuthRaw = async (
  path: string,
  config: ActiveMsg2GlobalConfig,
  init: RequestInit,
  phase = '接口',
): Promise<{ status: number; body: any }> => {
  const headers = new Headers(init.headers);
  if (config.serverToken) headers.set('X-Client-Token', config.serverToken);
  headers.set('X-User-Id', config.userId);

  try {
    const response = await fetch(`${normalizeWorkerBase(config.workerUrl)}/${path}`, {
      ...init,
      headers,
    });

    return { status: response.status, body: await safeResponseJson(response) };
  } catch (error) {
    throw normalizeActiveMsgApiError(error, phase, config.workerUrl);
  }
};

const fetchWithAuth = async (path: string, config: ActiveMsg2GlobalConfig, init: RequestInit, phase = '接口') =>
  (await fetchWithAuthRaw(path, config, init, phase)).body;

const readAmsgToolPromptControls = (): AmsgToolPromptControls => {
  const config = readPromptControlConfig();
  return {
    mcpTools: isPromptControlModuleEnabled('mcpTools', config),
    realtimeState: isPromptControlModuleEnabled('realtimeState', config),
    timeAwareness: isPromptControlModuleEnabled('timeAwareness', config),
  };
};

const encryptPayload = async (client: ReiClient, payload: unknown) => {
  return (client as unknown as ReiCryptoBridge)._encrypt(JSON.stringify(payload));
};

const decryptPayload = async (client: ReiClient, payload: { iv: string; authTag: string; encryptedData: string }) => {
  return (client as unknown as ReiCryptoBridge)._decrypt(payload);
};

/**
 * 即时对话能力探测这一次到底问到了什么。
 *
 * 「探不到」必须和「问到了、答案是不行」分开。混成同一个 false 的话，一次网络抖动
 * （切代理节点、CF 边缘抖一下、D1 冷启动慢）就会把即时对话长期钉死在本地生成——存量
 * 是粘的，只有下次探测成功才翻得回来，而重探只挂在握手和打开设置页两处，用户不进设置页
 * 就一直卡着。线上真踩过：Worker 那头全绿，用户却连着几小时每一轮都在本地直连生成，
 * 而他的本地直连根本不通，只看得到一条读不懂的网络报错，开关还写着「已开启」。
 */
export type InstantChatProbeOutcome =
  /** 200 + instantTick:true —— 跑得动 */
  | 'supported'
  /** 200 但没有 instantTick —— 明确跑不动（老 bundle，或代码新了绑定没接上） */
  | 'unsupported'
  /** 压根没问到（网络异常、超时、401、5xx、网关页）—— 这不是答案，不能拿来判死刑 */
  | 'unknown';

export interface InstantChatProbeResult {
  outcome: InstantChatProbeOutcome;
  /** 探完之后真正生效的存量。unknown 时 = 探测前那份（原样不动，可能是 undefined）。 */
  supported: boolean | undefined;
}

/**
 * 单条任务此刻的状态（`getRemoteTaskStatus` 的答案）。
 *   pending   —— 行在且还会跑（可能正在重试等待里，retryCount>0）
 *   completed —— 行在但已经出清（对一次性任务就等于失败：发成功的行会被删掉）
 *   gone      —— 行没了（发成功后被删 / 被取消 / 被顶替）
 */
export type RemoteTaskStatus =
  | { state: 'pending'; retryCount?: number; nextSendAt?: string }
  /**
   * lastError：amsg-server 2.6.0-next.15 起 409 的 error.details 带的行级失败摘要
   * （查询本来就按 uuid 点名，必然是这一行的）。旧 worker 不带 → null，调用方退回
   * chat_fail 留痕那条路。
   */
  | { state: 'completed'; lastError?: RemoteTaskLastError | null }
  | { state: 'gone' };

/**
 * 服务端消息账本里的一条。
 *
 * 云端每条推送发出去之前先记一行，客户端收下之后销账（ack）。`push` 就是推送信封
 * 本身，跟 Service Worker 收到的那一份逐字一致——补收时原样走收件箱那条老路即可。
 */
export interface AmsgOutboxEntry {
  /** 行号，同时也是翻页游标。 */
  id: number;
  messageId: string;
  taskUuid: string | null;
  sessionId: string | null;
  messageIndex: number | null;
  totalMessages: number | null;
  /** 落账时刻（epoch ms）。补收按它掐时效，太老的不再往聊天流里放。 */
  createdAt: number;
  deliveredAt: number | null;
  push: Record<string, any>;
}

/** 单页条数。服务端上限 100，取满减少往返。 */
const OUTBOX_PAGE_SIZE = 100;

/**
 * 最多翻几页。护栏而非配额：正常情况一两页就到底了，堆到 2000 条说明账本没人销过，
 * 这时也不该无限翻下去把启动卡死——剩下的下次再拉。
 */
const OUTBOX_MAX_PAGES = 20;

/** 单次 ack 的条数上限（服务端 200，超了自己分批）。 */
const OUTBOX_ACK_BATCH_SIZE = 200;

export const ActiveMsgClient = {
  async registerNativePushToken(token: string): Promise<void> {
    if (!nativePushBuildEnabled()) throw new Error('当前构建未开启 Capacitor 原生推送');
    const value = token.trim();
    if (!value) throw new Error('FCM registration token 为空');
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    await client.putPushSubscription({ endpoint: `fcm:${value}` });
  },

  async getGlobalConfig() {
    return ensureGlobalReady();
  },

  // 生成 worker env 用的 AMSG_MASTER_KEY（32 字节 → 64 位 hex）。
  // 只在设置页展示给用户粘进 CF env，前端自己不存也用不到它。
  generateMasterKey(): string {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    return Array.from(buf, (byte) => byte.toString(16).padStart(2, '0')).join('');
  },

  // 复制站点随 build 发布的 public/amsg-worker.bundle.js（Dashboard 粘贴部署用）。
  copyWorkerBundleToClipboard(): Promise<void> {
    return copyWorkerBundleToClipboard('amsg-worker.bundle.js');
  },

  // 复制 public/amsg-deno-proxy.ts —— 贴进 Deno Playground 当 worker 的门面用。
  // 走的是同一套「fetch 站点静态文件 → 剪贴板」，只是这份不打包、原样发布，
  // 因为用户要照着里面的注释改 UPSTREAM 那一行。
  copyDenoProxyToClipboard(): Promise<void> {
    return copyWorkerBundleToClipboard('amsg-deno-proxy.ts');
  },

  async getPushStatus(): Promise<ActiveMsg2PushStatus> {
    const config = await ensureGlobalReady();
    const workerConfigured = Boolean(config.workerUrl.trim());
    // 能力检测与 instant push / proactive push 共用 describePushCapabilityGap：
    // 它会说清缺的是三件套里的哪一件，「不支持」这三个字用户拿着没法action。
    const capabilityGap = describePushCapabilityGap();
    if (capabilityGap) {
      return {
        supported: false,
        permission: 'unsupported',
        hasSubscription: false,
        vapidConfigured: workerConfigured,
        detail: `${capabilityGap}。`,
      };
    }

    await KeepAlive.init();
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    return {
      supported: true,
      permission: Notification.permission,
      hasSubscription: Boolean(subscription),
      vapidConfigured: workerConfigured,
      detail: !workerConfigured ? '请先填写 Worker 地址。' : undefined,
    };
  },

  async ensurePushSubscription() {
    // 只需要「支不支持」这一个判断，不走 getPushStatus——那会把 KeepAlive.init /
    // serviceWorker.ready / getSubscription 整套先跑一遍，下面又原样跑一次。
    const capabilityGap = describePushCapabilityGap();
    if (capabilityGap) throw withFailKind(new Error(`${capabilityGap}。`), '不支持推送');

    const config = await ensureWorkerReady();

    let permission = Notification.permission;
    if (permission !== 'granted') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      throw withFailKind(new Error('通知权限未授予，无法创建主动消息 2.0 的推送订阅。'), '权限被拒');
    }

    await KeepAlive.init();
    const registration = await navigator.serviceWorker.ready;

    // **有旧订阅也要拉公钥**：换过 VAPID 后旧订阅绑的还是老公钥，无条件复用等于把一个
    // 必 403 的订阅继续写进新任务——自检就是拿目标公钥跟旧订阅比对（还有浏览器僵尸化
    // 的死端点），不合格先退订再重订（见 dropStaleSubscription）。
    const client = createClient(config);
    const vapidPublicKey = await fetchWorkerVapidKey(client);

    const existing = await registration.pushManager.getSubscription();
    const reusable = await dropStaleSubscription(existing, vapidPublicKey);
    if (reusable) return reusable.toJSON();

    return (await subscribeOrThrow(registration, vapidPublicKey)).toJSON();
  },

  /**
   * 把当前这个浏览器的推送订阅登记到 worker——一个用户一份，覆盖写。
   *
   * worker 到点投递时读的就是这一份，包括角色在 fire 里给自己排的、客户端根本
   * 不知道存在的那些任务。所以订阅换了端点只要覆盖这一份，已排的任务一条都不用
   * 碰；反过来说**排程前必须先登记过**，否则 worker 没地方推、直接拒绝建任务。
   *
   * 幂等：重复调用只是把同一份再写一遍，启动自检可以无脑调。
   *
   * 「一个用户一份」是有意为之，不是待修的限制：worker 上按 user_id 存单行，后登记的
   * 设备直接顶掉前一台，主动消息只会推到最后登记的那一台。所以不支持多设备同时收——
   * 一般也不会有人同时开着两台设备玩，真开了的话，「另一台不响了」就是正常现象。
   */
  async registerPushSubscription(): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const subscription = await this.ensurePushSubscription();
    try {
      await client.putPushSubscription(subscription);
    } catch (error) {
      throw normalizeActiveMsgApiError(error, '登记推送订阅');
    }
  },

  /**
   * worker 上登记的那份订阅现状（不含密钥，只有 endpoint 和登记时间）。
   *
   * 问不到一律返回 null、不抛：设置页的状态面板会反复调它，断网或者对面是台没有
   * 这个端点的旧 worker 时，面板显示「问不到」就够了，不该整块红着报错。
   */
  async getRemotePushSubscription(): Promise<AmsgRemotePushSubscription | null> {
    try {
      const config = await ensureWorkerReady();
      const client = await initializeClient(config);
      const response = await client.getPushSubscription();
      if (!response?.success) return null;
      const data = response.data;
      // 形状对不上就当问不到。旧 worker 什么都可能回，照着猜会把「没登记」显示成
      // 「已登记」——那正好是这一行要拆穿的故障，判反了还不如不显示。
      if (typeof data?.exists !== 'boolean') return null;
      return {
        exists: data.exists,
        endpoint: typeof data.endpoint === 'string' ? data.endpoint : null,
        updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : null,
      };
    } catch {
      return null;
    }
  },

  /**
   * 只删掉 worker 上登记的那行订阅，浏览器这边的订阅原样不动。
   *
   * 跟 resetPushSubscription 的分工：那个是「收不到推送了」的修复动作，删完要重建
   * 浏览器订阅再登记回去；这里是清空云端数据时的收尾，本机压根没开推送的话不该顺手
   * 去申请通知权限，把云端那行删干净、留白就是对的。
   */
  async deleteRemotePushSubscription(): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    try {
      await client.deletePushSubscription();
    } catch (error) {
      throw normalizeActiveMsgApiError(error, '删除推送订阅登记');
    }
  },

  /**
   * 重置订阅：清掉现在这条，重新建一条，再覆盖登记回 worker。
   *
   * 三步缺一不可。只在浏览器重订不登记的话，worker 的 push_subscriptions 里还是
   * 旧端点，到点推给一个已经不存在的地址——界面全绿、一条消息都收不到，正是这个
   * 按钮要治的病，不能自己再犯一遍。
   */
  async resetPushSubscription(): Promise<void> {
    const config = await requirePushReady();
    const client = await initializeClient(config);

    // 先让 worker 忘掉旧的那行。失败不拦：下面重新登记本来就是覆盖写，删不掉也不
    // 影响结果，只是万一后面挂了，D1 里会多留一条已经没用的旧记录。
    try {
      await client.deletePushSubscription();
    } catch (error) {
      console.warn('[ActiveMsg] 重置订阅：删除 worker 上的旧订阅失败，继续重建', error);
    }

    await unsubscribeCurrentPush();
    await resubscribeAndRegister(client);
  },

  /**
   * 深度重置：在普通重置的基础上，把 Service Worker 整个注销再装一遍。
   *
   * 什么时候需要：Chromium 会把订阅锁死在内部的 MarkedForRemoval 状态，这时候
   * `pushManager.unsubscribe()` 清不掉标记，重订多少次都只会拿到
   * `permanently-removed.invalid`。唯一能从代码里走出来的路是换一个 SW 注册 id，
   * 绑在旧 id 上的坏记录自然失效。
   *
   * 副作用：SW 会短暂下线（1 秒上下），这期间来的推送是真丢。但会点这个按钮的前提
   * 就是「已经收不到了」，不存在把原本收得到的弄丢。主动消息 2.0 的排程存在 worker
   * 的 D1 里、跟 SW 无关，不用像 proactive-push 那样重新推排程回去。
   */
  async deepResetPushSubscription(): Promise<void> {
    const config = await requirePushReady();
    const client = await initializeClient(config);

    try {
      await client.deletePushSubscription();
    } catch (error) {
      console.warn('[ActiveMsg] 深度重置：删除 worker 上的旧订阅失败，继续重建', error);
    }

    await unsubscribeCurrentPush();

    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)));
    } catch (error) {
      console.warn('[ActiveMsg] 深度重置：注销 Service Worker 失败，继续走重装', error);
    }

    try {
      await KeepAlive.reregister();
      await navigator.serviceWorker.ready;
    } catch (error) {
      throw withFailKind(
        new Error(`Service Worker 重新注册失败：${(error as Error)?.message || error}`),
        '订阅失败',
      );
    }

    await resubscribeAndRegister(client);
  },

  /**
   * 「连接并验证」的收尾：把浏览器当前的推送订阅补登记到这台 worker 上。
   *
   * 订阅存在 worker 自己的 D1 里（push_subscriptions，一个用户一行）。换一台 worker
   * 就是换一个空库，而浏览器这侧的订阅一个字都没变——SW 的 pushsubscriptionchange
   * 不会响，refreshPushSubscriptionIfMarked 也就没有标记可消费。于是面板全绿、连接
   * 验证通过，worker 到点却读不到订阅，直接抛 PUSH_SUBSCRIPTION_MISSING：消息一条
   * 都发不出来，用户这侧看不到任何异常。所以连接这一步顺手覆盖写一次。
   *
   * 只在**权限已授予且浏览器已有订阅**时补。没订阅说明用户还没走「开启通知与推送
   * 订阅」那步，那是引导流程该做的事——连接不替用户开推送，也不在这儿弹权限框。
   *
   * 返回值只为单测断言：'registered' 补了 / 'skipped' 条件不满足 / 'failed' 补失败了。
   */
  async reconcilePushSubscription(): Promise<'registered' | 'skipped' | 'failed'> {
    try {
      if (describePushCapabilityGap()) return 'skipped';
      if (Notification.permission !== 'granted') return 'skipped';
      await KeepAlive.init();
      const registration = await navigator.serviceWorker.ready;
      if (!await registration.pushManager.getSubscription()) return 'skipped';
    } catch {
      // 探测本身炸了（SW 没就绪 / 环境不支持）就算了，别为一句自检拦住连接。
      return 'skipped';
    }

    try {
      await this.registerPushSubscription();
      return 'registered';
    } catch (error) {
      // init-tenant 过了、鉴权也通了，连接本身是成功的，这里不能往外抛：否则用户
      // 会被指去改一堆根本没错的配置。补不上就等排程那步（scheduleTask 也会登记）。
      console.warn('[ActiveMsg] 连接后补登记推送订阅失败', error);
      return 'failed';
    }
  },

  // 单用户「连接」：先 POST /init-tenant 让 worker 在自己的 D1 里幂等建表
  // （Dashboard 粘贴部署的用户不用碰 SQL），再拿一次 user key 验证地址与鉴权都通，
  // 最后把推送订阅补登记上去（换 worker 后云端那份是空的，见 reconcilePushSubscription）。
  async connect() {
    const config = await ensureWorkerReady();

    // 先问 worker 配齐了没：缺 D1 绑定或 master key 的话，下面的 init-tenant 必然失败，
    // 而那一步只能按 HTTP 状态猜个大概（三种原因共用「建表失败」）。自检能直接说出
    // 缺的是哪一样、去哪儿补，用户不用再去翻 Cloudflare 的日志。
    const report = await inspectWorkerConfig(config);
    if (report && !report.ok) {
      throw withFailKind(new Error(report.message), '配置缺失');
    }

    const { status, body: initResponse } = await fetchWithAuthRaw('init-tenant', config, { method: 'POST' }, '初始化数据库');
    if (!initResponse?.success) {
      throw withFailKind(
        new Error(initResponse?.error?.message || '主动消息 2.0 初始化数据库失败，请确认 Worker 已绑定 D1（变量名 DB）。'),
        resolveInitFailKind(status),
      );
    }
    // 「重新连接并验证」是显式的重新握手，缓存必须先作废。用户按它多半正是因为云端换了
    // 东西（典型是在 Cloudflare 上换掉 AMSG_MASTER_KEY，用户密钥跟着换代），而记忆化的
    // 三个键一个都没变 —— 不作废的话这里拿回来的还是握着旧密钥的老 client：init-tenant
    // 成功、界面报「连接成功」，此后每一次加密调用（排任务 / 即时对话 / 读云端状态）
    // worker 都解不开，只有整页刷新才能恢复。
    invalidateClientCache();
    await initializeClient(config);
    await ActiveMsgStore.saveGlobalConfig({ ...config, initializedAt: Date.now() });
    // 「重新连接并验证」是用户显式的一次对表，凭据引用那个能力位也当场探准，别等下次握手。
    // 排在保存之后：上面那句写的是握手前的配置快照，探测结论放它前面会被原样盖回去。
    await this.probeLlmCredentialsSupport();
    await this.reconcilePushSubscription();
    const nativeToken = readNativePushToken();
    if (nativeToken) await this.registerNativePushToken(nativeToken);
    // warnings 是「连上了，但有一块功能是哑的」——比如 VAPID 没配齐，任务能建、到点
    // 却一条都推不出去。连接本身算成功，交给调用方提示，别拦住流程。
    return { ok: true, userId: config.userId, warnings: report?.warnings ?? [] };
  },

  // 分页全量：循环 messages?limit=100&offset=<n>，每页解密后读 tasks 与 pagination.hasMore，
  // 拉到最后一页为止。任一页失败整体抛错——不能拿半页结果去判「远端不存在」（会误伤没拉到的任务）。
  // 每条任务带上游投影的顶层 charId / clientTaskId，供按角色对账/关闭全部。
  async listAllTasks(): Promise<any[]> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);

    const all: any[] = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const response = await fetchWithAuth(`messages?limit=${limit}&offset=${offset}`, config, {
        method: 'GET',
        headers: {
          'X-Response-Encrypted': 'true',
          'X-Encryption-Version': '1',
        },
      }, '读取任务列表');

      if (!response?.success) {
        throw new Error(response?.error?.message || '读取主动消息 2.0 任务列表失败。');
      }

      const page = await decryptPayload(client, response.data);
      const pageTasks: any[] = page?.tasks || [];
      all.push(...pageTasks);

      if (!page?.pagination?.hasMore || pageTasks.length === 0) break;
      offset += limit;
    }
    return all;
  },

  /**
   * 某个角色在远端的任务投影（uuid + status + lastError），面板对账 / 失败可见化用。
   *
   * 老 worker（amsg-server < 2.6.0-next.5）不投影 charId：远端明明有任务，这里却一条都
   * 匹配不上。空结果此时不是「远端没有」的证据，直接抛错让调用方走各自的降级——面板
   * 对账整体关掉「远端不存在」徽标，关闭 2.0 退回本地全量清单——而不是拿半份证据误判。
   *
   * lastError 是 run-tick 记进 payload 的「上一次为什么没发出去」（2.6.0-next.10 起
   * GET /messages 透出；旧 worker 没有这字段 → null，界面上就是不显示那行说明）。
   */
  async listRemoteTasksForChar(charId: string): Promise<RemoteTaskProjection[]> {
    const tasks = await this.listAllTasks();
    if (tasks.length > 0 && tasks.every((t) => t?.charId == null)) {
      throw new Error('worker 版本过旧：任务列表没有 charId 投影，无法按角色对账，请在设置里重新粘贴部署。');
    }
    return tasks
      .filter((t) => t?.charId === charId && typeof t?.uuid === 'string')
      .map((t) => ({
        uuid: t.uuid as string,
        status: typeof t?.status === 'string' ? t.status as string : undefined,
        lastError: parseRemoteTaskLastError(t?.lastError),
        clientTaskId: typeof t?.clientTaskId === 'string' ? t.clientTaskId : undefined,
        messageType: typeof t?.messageType === 'string' ? t.messageType : undefined,
        // 排程方写进 payload 的自由文本标签，即时对话的行标着 'instant-chat'。
        messageSubtype: typeof t?.messageSubtype === 'string' ? t.messageSubtype : undefined,
        recurrenceType: typeof t?.recurrenceType === 'string' ? t.recurrenceType : undefined,
        // 远端算出来的下一次触发时刻。循环任务按角色时区的墙钟推进，本地拿固定周期
        // 自己乘出来的那个跨夏令时会偏一小时——显示以远端为准，跟真正会响的时刻一致。
        nextSendAt: typeof t?.nextSendAt === 'string' ? t.nextSendAt : undefined,
        // 已经重试过几次（远端行上的计数）。旧 worker 不投影这字段 → undefined。
        retryCount: typeof t?.retryCount === 'number' ? t.retryCount : undefined,
      }));
  },

  /**
   * 取消一个远端任务。**幂等**：远端已经没有这一条（一次性任务发完就删行、或在别处
   * 取消过），amsg-server 回 404 `TASK_NOT_FOUND`，那正是取消要达到的终态，算成功并
   * 带上 alreadyGone=true 交给调用方——当失败处理会让「取消一条已经发过的任务」显示
   * 成红色的「远端取消失败，可重试」，其实没有任何东西需要重试。
   * 其余错误（鉴权、D1 挂了、网络）照常抛，别一起吞掉。
   */
  async cancelTask(taskUuid: string): Promise<{ uuid: string; alreadyGone: boolean }> {
    const config = await ensureWorkerReady();
    const response = await fetchWithAuth(`cancel-message?id=${encodeURIComponent(taskUuid)}`, config, {
      method: 'DELETE',
    }, '取消任务');

    if (!response?.success) {
      if (response?.error?.code === REMOTE_TASK_NOT_FOUND_CODE) {
        return { uuid: taskUuid, alreadyGone: true };
      }
      throw new Error(response?.error?.message || '取消主动消息 2.0 任务失败。');
    }

    return { uuid: taskUuid, alreadyGone: false };
  },

  /**
   * 查一条任务此刻的状态（即时对话「一直等」的判定器）。
   * 比 listAllTasks（全表分页 + 逐行解密）便宜得多，适合回前台时点名查一条。
   *
   * 只认远端明说的这两个错误码来下结论，不看 HTTP 状态：worker 地址填错时未知路由
   * 同样回 404（错误码是 NOT_FOUND），照状态判就会把「压根没问到」当成「任务没了」。
   * 网络故障、鉴权失败照常抛——调用方据此什么都不结论，继续等。
   */
  async getRemoteTaskStatus(taskUuid: string): Promise<RemoteTaskStatus> {
    const config = await ensureWorkerReady();
    const response = await fetchWithAuth(`message?id=${encodeURIComponent(taskUuid)}`, config, {
      method: 'GET',
      headers: {
        'X-Response-Encrypted': 'true',
        'X-Encryption-Version': '1',
      },
    }, '查询任务状态');

    if (!response?.success) {
      const code = response?.error?.code;
      if (code === REMOTE_TASK_NOT_FOUND_CODE) return { state: 'gone' };
      if (code === REMOTE_TASK_ALREADY_COMPLETED_CODE) {
        // 失败摘要跟着 409 一起来（新 worker 的 details.lastError；明文列，无凭据）。
        const details = (response.error as { details?: { lastError?: unknown } } | undefined)?.details;
        return { state: 'completed', lastError: parseRemoteTaskLastError(details?.lastError) };
      }
      throw new Error(response?.error?.message || '查询任务状态失败。');
    }

    // 能回 200 的行必然是 pending（上游那条 SQL 写死了 status='pending'）。
    // 响应整体加密，解出来是 { task }，字段在里头。解密要用户密钥，所以拖到这一步
    // 才建客户端——判定成 gone / completed 的那两条路省掉一次 get-user-key 往返。
    const client = await initializeClient(config);
    const task = (await decryptPayload(client, response.data))?.task ?? {};
    return {
      state: 'pending',
      ...(typeof task.retryCount === 'number' ? { retryCount: task.retryCount } : {}),
      ...(typeof task.nextSendAt === 'string' ? { nextSendAt: task.nextSendAt } : {}),
    };
  },

  /**
   * 服务端消息账本里还没销账的条目，翻页拉全。
   *
   * 「哪些消息客户端还没收下」在服务端是查得出来的事实——每条推送发出去之前先记一行，
   * 客户端落库之后销账。所以这里不做任何本地对账，读回来是什么就是什么。
   *
   * 读失败照常抛：调用方要能分清「读到了、里面确实没有」和「压根没读成」，
   * 后者不构成任何结论（见 docs/instant-push-dual-channel.md 那条铁律）。
   */
  async listOutboxEntries(): Promise<AmsgOutboxEntry[]> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const collected: AmsgOutboxEntry[] = [];
    let since: number | undefined;

    for (let page = 0; page < OUTBOX_MAX_PAGES; page += 1) {
      const response = await client.getOutbox({
        limit: OUTBOX_PAGE_SIZE,
        ...(since == null ? {} : { since }),
      });
      if (!response?.success) {
        throw new Error(response?.error?.message || '读取云端消息账本失败。');
      }
      const data = (response.data ?? {}) as {
        entries?: unknown;
        cursor?: unknown;
        hasMore?: unknown;
      };
      const entries = Array.isArray(data.entries) ? data.entries : [];
      for (const raw of entries) {
        const entry = raw as Partial<AmsgOutboxEntry> | null;
        // messageId 是销账和去重的唯一依据，缺了这条就没法处理，跳过。
        if (!entry || typeof entry.messageId !== 'string' || !entry.messageId) continue;
        if (!entry.push || typeof entry.push !== 'object') continue;
        collected.push({
          id: typeof entry.id === 'number' ? entry.id : 0,
          messageId: entry.messageId,
          taskUuid: typeof entry.taskUuid === 'string' ? entry.taskUuid : null,
          sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : null,
          messageIndex: typeof entry.messageIndex === 'number' ? entry.messageIndex : null,
          totalMessages: typeof entry.totalMessages === 'number' ? entry.totalMessages : null,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
          deliveredAt: typeof entry.deliveredAt === 'number' ? entry.deliveredAt : null,
          push: entry.push as Record<string, any>,
        });
      }
      if (data.hasMore !== true) break;
      const cursor = typeof data.cursor === 'number' ? data.cursor : null;
      // 游标没往前走就停：再拉一次是同一页，会转成死循环。
      if (cursor == null || (since != null && cursor <= since)) break;
      since = cursor;
    }

    return collected;
  },

  /**
   * 销账：告诉服务端这些消息已经收下了，之后不会再拉到。
   *
   * **只在消息真的落地之后调**——账销了而落库半途失败的话，这条消息就再也补不回来。
   * 幂等，重复销同一批不会出错。超过单次上限自动分批；某一批失败不拦着后面几批，
   * 没销掉的下次拉回来会被落库那层的去重挡下，不会重复上屏。
   */
  async ackOutboxMessages(messageIds: string[]): Promise<void> {
    const ids = Array.from(new Set(messageIds.filter((id) => typeof id === 'string' && !!id)));
    if (ids.length === 0) return;
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    let failed = 0;
    let lastError: unknown = null;
    for (let i = 0; i < ids.length; i += OUTBOX_ACK_BATCH_SIZE) {
      const batch = ids.slice(i, i + OUTBOX_ACK_BATCH_SIZE);
      // 一批挂了继续跑后面几批：中途 throw 的话剩下的批次一条都销不掉，账本只会
      // 越积越多，下一趟又整批拉回来。没销掉的那批下次拉回来有落库那层的去重挡着。
      try {
        const response = await client.ackOutbox(batch);
        if (!response?.success) {
          throw new Error(response?.error?.message || '云端消息账本销账失败。');
        }
      } catch (error) {
        failed += batch.length;
        lastError = error;
      }
    }
    if (failed > 0) {
      const detail = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`云端消息账本销账失败（${failed}/${ids.length} 条没销掉）：${detail}`);
    }
  },

  /**
   * 取消某个角色在远端的全部任务（关闭 2.0 / 删角色共用）。
   *
   * 以远端清单为准：本地 pending 派生会漏掉「已过点但 Cron 还没消费」的一次性任务，
   * 只按本地清单取消会留下还会响的幽灵任务。远端读不到（网络故障 / 老 worker 没
   * charId 投影）才退回调用方给的本地清单——半份证据也比不取消强。
   *
   * 逐条取消，单条失败记进 failed 继续跑完其余的：一条网络抖动不该让剩下的任务都留着。
   *
   * 即时对话的行不在取消范围内（过滤口径与面板对账同一把尺 AMSG_INSTANT_CHAT_SUBTYPE，
   * 见 amsg2Tasks 的 reconcileTasksWithRemote）：那不是定时任务，是用户此刻正等着的一轮
   * 聊天。角色的 2.0 开关管的是定时主动消息，连它一起掐掉的话 worker 那一跳永远不会跑，
   * 用户等到的是一句「云端已处理这条消息，但回复没能取回」，还得自己把话重发一遍。
   * 退回本地清单的那条路天然不含即时对话（本地任务记录里从来没有它）。
   */
  async cancelAllTasksForChar(
    charId: string,
    localTaskUuids: string[],
  ): Promise<{ targets: string[]; failed: Set<string> }> {
    let targets: string[];
    try {
      targets = (await this.listRemoteTasksForChar(charId))
        .filter((task) => task.messageSubtype !== AMSG_INSTANT_CHAT_SUBTYPE)
        .map((task) => task.uuid);
    } catch {
      targets = localTaskUuids;
    }
    const failed = new Set<string>();
    for (const uuid of targets) {
      try { await this.cancelTask(uuid); } catch { failed.add(uuid); }
    }
    return { targets, failed };
  },

  async scheduleCharacterTask(params: {
    char: CharacterProfile;
    /** 角色级共享设置（secondaryApi / maxTokens）。 */
    config: ActiveMsg2CharacterConfig;
    /** 本次要排的任务。 */
    task: {
      mode: ActiveMsg2Mode;
      firstSendTime: string;
      recurrenceType: ActiveMsg2Recurrence;
      promptHint?: string;
      userMessage?: string;
      expirePolicy?: ActiveMsg2ExpirePolicy;
      /** 角色自己排的（工具桥传 true）。带上 metadata 标记，连发上限的到点兜底闸只拦它。 */
      selfScheduled?: boolean;
    };
    /** 编辑/续期时传旧任务 uuid：先取消它再新建（不传 = 纯新建）。 */
    replaceTaskUuid?: string;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig: RealtimeConfig;
    apiConfig: APIConfig;
  }) {
    const { char, config, task, replaceTaskUuid, userProfile, groups, realtimeConfig, apiConfig } = params;
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    // 任务体不带订阅，worker 到点读用户级那一份——所以建任务前先把它登记上去。
    const nativeToken = readNativePushToken();
    if (nativeToken) await this.registerNativePushToken(nativeToken);
    else await this.registerPushSubscription();

    // 数量封顶：待触发任务（不含被替换的那个）满 5 个就拒绝，让角色/用户先清。
    const pendingOthers = getPendingTasks(config, Date.now())
      .filter((t) => t.taskUuid !== replaceTaskUuid);
    if (pendingOthers.length >= MAX_ACTIVE_TASKS_PER_CHAR) {
      throw new Error(`该角色的待触发任务已达上限 ${MAX_ACTIVE_TASKS_PER_CHAR} 个，请先取消或合并已有任务。`);
    }

    // 角色的时间参照系：任务行、fire_pack、worker 渲染全用这一个，解析 send_at 也一样。
    const tzId = resolveCharTimeZone(char) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    // 裸墙钟在这里被折成绝对时刻。调用方要把这一份存进任务记录（见返回值 firstSendAt），
    // 别存自己手上那个墙钟串——角色写的是它那边的钟、面板填的是设备的钟，两种串长得一样，
    // 落盘后谁也认不出该按哪个时区读，本地一律 new Date() 按设备解析就会差一个时差。
    const firstSendTime = ensureFutureTime(task.firstSendTime, tzId);
    // AI 模式的 prompt 只有一条来源：firePack 上传 client_state，worker 到点现场填槽。
    // 任务体里不再冻结一份渲染好的 prompt——读不到 fire_pack 就直接报错，没有第二条路，
    // 留着那份快照只是白占请求体（完整角色卡 + 世界书）。
    const firePack = task.mode === 'fixed'
      ? null
      : await buildFirePack(char, userProfile, groups, realtimeConfig);
    // 防穿帮闸锚点：排程这一刻的最后一条真实用户消息（见 utils/amsg2ExpireGuard.ts）。
    // 与 fire_pack 的 lastUserMessageAt 同源，直接复用——各读各的就是同一段 200 条历史
    // 扫两遍。fixed 任务恒 force，锚点用不到，也就不必去读。
    const anchorMs = firePack?.lastUserMessageAt ?? 0;
    // 任务身份：客户端自造 clientTaskId——远端 uuid 要创建成功后才有，而 metadata
    // 必须在创建时就带上归属键；push 原样透传，送达归属全靠它。
    const clientTaskId = crypto.randomUUID();

    const remoteAvatarUrl = toRemoteAvatarUrl(char.avatar);
    const payload: Record<string, any> = {
      contactName: char.name,
      // 本地 base64 头像过不了 worker 的校验，不合格干脆不带这个字段（见 toRemoteAvatarUrl）。
      ...(remoteAvatarUrl ? { avatarUrl: remoteAvatarUrl } : {}),
      messageType: task.mode,
      messageSubtype: 'chat',
      firstSendTime,
      recurrenceType: task.recurrenceType,
      // 角色的时间参照系（与 fire_pack 同一份）。daily / weekly 由 worker 按这个时区的
      // 墙钟推进——固定加 24 小时的话，跨夏令时切换之后每天的触发时刻会永久偏一小时。
      tzId,
      metadata: {
        charId: char.id,
        charName: char.name,
        source: 'active_msg_2',
        // worker 满血链路的 onLLMOutput 拿不到任务顶层的 messageType，靠 metadata 透传
        // 还原 push.messageType（老任务没这字段时 worker 回退 'auto'，收侧只展示不路由）。
        amsgMode: task.mode,
        // 防穿帮闸字段：worker onBeforeFire 与客户端送达兜底都从这里读。
        // fixed 恒为 force——它走不了 worker 闸（taskNeedsLlm=false），语义统一钉死。
        // recurrenceType / occurrenceMs 不往这儿抄：库会把它们盖在每条 push 顶层，
        // 角色在 fire 里自排的任务也一样有，抄一份反而多一处会漏写的地方。
        amsgClientTaskId: clientTaskId,
        amsgExpirePolicy: resolveExpirePolicy(task.mode, task.expirePolicy),
        amsgAnchorMs: anchorMs,
        // 自排标记：到点兜底闸只拦带它的任务（用户面板排的不带、不受连发上限管）。
        ...(task.selfScheduled ? { amsgSelfScheduled: true } : {}),
      },
    };

    // 凭据这一轮走哪条路：能存表就只带引用，老 worker 照旧内联三件套。
    // 引用那条路要先把行传上去（下面的 credRow），传成功才建任务。
    const useCredRefs = task.mode !== 'fixed' && await isLlmCredentialsReady();
    let credRow: LlmCredentialRow | null = null;

    if (task.mode === 'fixed') {
      const userMessage = task.userMessage?.trim();
      if (!userMessage) throw new Error('固定消息模式需要填写消息内容。');
      payload.userMessage = userMessage;
    } else {
      const activeApi = resolveApiConfig(char, config, apiConfig);
      // 「本次任务」指令随任务 metadata 走，worker 到点拿它填 fire_pack 的指令槽。
      payload.metadata.amsgTaskInstruction = buildTaskInstruction(task.mode, task.promptHint);
      // 服务端要求「completePrompt 或 messages」二选一，且 messages 必须非空、
      // content 必须非空字符串，所以这里给一条占位。到点真正发给 LLM 的 messages 由
      // worker 的 onBeforeFire 返回值覆盖（库用 { ...payload, messages } 调 LLM），
      // 这条内容永远不参与生成——它要是真出现在哪里，就说明 worker 的 fire hooks 没生效。
      payload.messages = [{ role: 'user', content: AMSG2_PLACEHOLDER_PROMPT }];
      if (useCredRefs) {
        // 引用与内联三件套上游只收一种，同传直接 400——所以这条路上一个内联字段都不写。
        // 行的值按 (char, config, apiConfig) 现算，与后台补传那条路同一个入口，
        // 两边算出来的指纹才对得上（否则每次排程都会白传一次）。
        credRow = buildCharChatCredRow(char, config, apiConfig);
        if (!credRow) throw new Error('主动消息 2.0 缺少可用的 API URL / Key / Model。');
        payload.credRefs = { chat: credRow.credId };
      } else {
        payload.apiUrl = normalizeChatApiUrl(activeApi.baseUrl);
        payload.apiKey = activeApi.apiKey;
        payload.primaryModel = activeApi.model;
      }
      if (config.maxTokens && config.maxTokens > 0) {
        payload.maxTokens = config.maxTokens;
      }
    }

    // ── 先传云端状态，成功了再建任务 ──
    // fire_pack / tool_pack 都按角色存、不依赖任务 id，所以顺序可以倒过来。倒过来的好处：
    // 上传失败时远端还没有任务，直接抛错就行，既不用回滚、也不会留下「用户看到排程失败、
    // 远端却会到点触发」的幽灵任务。反过来（先建后传）失败时只剩降级或回滚两条路，都更差。
    //
    // 反向的残留是无害的那一侧：上传成功但建任务失败 → 云端多一份没人引用的 fire_pack，
    // 不会被读（worker 只在 fire 某个任务时读它），下次同步直接覆盖。
    //
    // 大值（胖角色的完整角色卡 / 世界书）由 amsg-server 2.6.0-next.4+ 在 worker 存储层
    // 透明分块，客户端整条直传即可；老 worker 会拒超限条目 → putClientStateOrThrow 抛错。
    //
    // 角色欠着即时对话回复时，这一批里的 fire_pack 抽掉不写（口径与批量同步那条路共用
    // owesInstantChatReply）：云端此刻那份带着用户正等的这一轮 chat 段，盖掉的话 worker
    // 到点只能硬失败。tool_pack / tool_config 里没有 chat，照传。抽掉的那份不会就此作废：
    // 排完任务紧跟着的落库会打脏，等回复销账后由状态同步把最新的包补上去。
    if (firePack) {
      const now = Date.now();
      const owesChat = owesInstantChatReply(char.id);
      if (owesChat) {
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 该角色还欠着一条即时对话回复，这次排程不覆盖云端 fire_pack（等回复销账后由状态同步补传）`);
      }
      const charEntries = await buildCharStateEntries(char, firePack, now);
      await putClientStateOrThrow(client, [
        ...(owesChat ? charEntries.filter((entry) => entry.key !== AMSG_FIRE_PACK_KEY) : charEntries),
        buildToolConfigEntry(realtimeConfig, now),
      ], '上传云端状态');
    }

    // 凭据行要先在云端存在：上游建任务前会挨个查引用，缺一个就 409 CREDENTIAL_NOT_FOUND。
    // 只在值变过时真的发请求（指纹底账），所以常态下这一步一个请求都不发。
    if (credRow) await putLlmCredentialRows([credRow]);

    const postSchedule = async () => {
      const encrypted = await encryptPayload(client, payload);
      return fetchWithAuth('schedule-message', globalConfig, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Payload-Encrypted': 'true',
          'X-Encryption-Version': '1',
        },
        body: JSON.stringify(encrypted),
      }, '创建任务');
    };

    let response = await postSchedule();
    // 云端说这行凭据不存在（换过 master key、点过「清空云端数据」、或者上一次上传其实
    // 没落地而本地底账记着传过）——本地那本账此刻是脏的，绕过指纹强传一次再重排一次。
    // 只自愈一次：再不成就是真出了别的问题，抛给用户看得见的报错。
    if (!response?.success && response?.error?.code === 'CREDENTIAL_NOT_FOUND' && credRow) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 云端没有这行凭据，补传后重排一次`, credRow.credId);
      forgetCredIds([credRow.credId]);
      await putLlmCredentialRows([credRow], { force: true });
      response = await postSchedule();
    }

    if (!response?.success) {
      throw new Error(response?.error?.message || '主动消息 2.0 任务创建失败。');
    }

    // 先建后删（Codex #4）：新任务确认创建成功才取消旧的——反过来一旦创建失败，
    // 旧任务已删、新任务没建，两头空。取消失败时新旧短暂并存于远端，把状态交还
    // 调用方（保留旧记录 + 标错 + 可重试），绝不静默。
    let replacedCancelFailed = false;
    if (replaceTaskUuid) {
      try {
        await this.cancelTask(replaceTaskUuid);
      } catch (error) {
        replacedCancelFailed = true;
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 替换后取消旧任务失败（远端新旧并存，待重试）`, error);
      }
    }

    return {
      ...(response.data as { uuid: string; status: string; nextSendAt?: string }),
      anchorMs,
      clientTaskId,
      replacedCancelFailed,
      // 解析好的绝对时刻（UTC ISO）。任务记录存这一份，字段口径才只有一种。
      firstSendAt: firstSendTime,
    };
  },

  /**
   * 即时对话：把「用户刚按下发送」这一轮交给云端跑，一个请求受理完就返回。
   *
   * 请求体里两个信封都是这里加密好的（外壳是明文 JSON，包装层只搬不看）：
   *   statePayload —— 和 putClientState 逐字节同构的 `{ entries }`，带这一轮的 fire_pack
   *                   （v7，多一段 chat）+ tool_pack + 全局工具凭据；
   *   taskPayload  —— 和 scheduleCharacterTask 同构的排程体，标着 amsgInstantChat。
   *
   * 只有 202 才算受理。**任何别的状态都是「这条没发出去」**，抛错交调用方明说，
   * 绝不退回本地生成——静默分流那种查无可查的坑踩过一次就够了。
   */
  async sendInstantChat(params: {
    char: CharacterProfile;
    /** 本地生成会 POST 给 /chat/completions 的那串 fullMessages，原样带上去。 */
    chatMessages: Array<{ role: string; content: unknown }>;
    /**
     * 这一轮该用的聊天凭据——**必须是本地生成那一轮会用的同一份**（effectiveApi）。
     * 换成主动消息的「角色单独 API」的话，同一句话开不开即时对话会由不同的模型来答，
     * 而用户完全看不出这件事发生过。
     */
    api: { baseUrl: string; apiKey: string; model: string };
    /**
     * 本地这一轮会发的采样温度。不传就是本地也不发（开思考时本地会删掉温度）——
     * 上游 buildLlmRequestBody 对空温度整个省略该字段，两边落到同一个供应商默认值。
     */
    temperature?: number;
    maxTokens?: number;
    /**
     * 本地这一轮会额外发进请求体的字段（思考链三件套：thinking / reasoning_effort /
     * extra_body，由 useChatAI 的 shouldSendThinkingParams 分支决定）。worker 组请求体
     * 时原样展开、核心字段（model/messages 等）优先——两条路发出去的请求体必须一致，
     * 不然开思考的角色一开即时对话，心象卡片就静默消失。
     */
    extraBody?: Record<string, unknown>;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig: RealtimeConfig;
    /**
     * 这一轮的情绪评估（副 API 提示词 + 凭据），交给云端跑。
     * 走 taskPayload —— 那份是端到端加密的信封，凭据不会以明文出门。
     */
    emotionEval?: AmsgEmotionEvalSpec;
    /** 上一条还没被认领的即时对话任务，连发两条时用它顶掉（合并成一起回）。 */
    supersedesUuid?: string;
  }): Promise<{ uuid: string; clientTaskId: string }> {
    const { char, chatMessages, api, userProfile, groups, realtimeConfig } = params;
    if (!api.baseUrl || !api.model) throw new Error('即时对话没发出去：聊天 API 地址或模型没配齐。');
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);

    const now = Date.now();
    const tzId = resolveCharTimeZone(char) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    // 模板只有定时任务那条路才渲染：角色 2.0 关着（云端 fire 不注入排程工具，排不出
    // 会消费模板的新任务）且本地任务清单为空时，用占位模板省掉每次发送的二次全量
    // 构建与上传。2.0 开着 / 还挂着任务（含取消失败的幽灵行）就老老实实带真模板。
    const templateStub = !isAmsg2EnabledForChar(char)
      && (char.activeMsg2Config?.tasks?.length ?? 0) === 0;
    const firePack: AmsgFirePack = {
      ...(await buildFirePack(char, userProfile, groups, realtimeConfig, undefined, { templateStub })),
      chat: { messages: toFirePackChatMessages(chatMessages), builtAt: now },
    };

    const clientTaskId = crypto.randomUUID();

    // ── 这一轮的凭据走引用还是内联 ──
    //
    // 走引用时两行一起登记：
    //   char:<id>/instant  这一轮真正会用的聊天凭据（model 是请求体终值，claude 系开思考
    //                      时带 -thinking 后缀）。**必须带上它**——只带 emotion 一个引用的话，
    //                      角色在这一轮里给自己排的任务会继承一份「有引用、没聊天凭据」的
    //                      空壳（上游 scheduleTask 见到任何 credRefs 就不再复制内联三件套）。
    //   char:<id>/emotion  情绪评估的副 API。有了它，评估配置里就不必再塞一份凭据。
    //
    // 走内联时一切照旧：三件套写在任务顶层，评估配置连凭据一起放 metadata。
    const useCredRefs = await isLlmCredentialsReady();
    const credRows: LlmCredentialRow[] = [];
    const credRefs: Record<string, string> = {};
    if (useCredRefs) {
      const instantRow = buildCharInstantCredRow(char.id, api);
      if (instantRow) {
        credRows.push(instantRow);
        credRefs.chat = instantRow.credId;
      }
      if (params.emotionEval?.api) {
        const emotionRow = buildCharEmotionCredRow(char.id, params.emotionEval.api, {
          baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model,
        });
        // 只在聊天那一行也立得住时才挂 emotion：单挂一个 emotion 引用就是上面说的那种空壳。
        if (emotionRow && credRefs.chat) {
          credRows.push(emotionRow);
          credRefs.emotion = emotionRow.credId;
        }
      }
    }
    const inlineCreds = !credRefs.chat;
    // 评估配置：凭据走引用时只留提示词模板，副 API 的 apiKey 一个字节都不进任务 metadata。
    const emotionEvalSpec = params.emotionEval
      ? (credRefs.emotion ? { prompt: params.emotionEval.prompt } : params.emotionEval)
      : undefined;

    const remoteAvatarUrl = toRemoteAvatarUrl(char.avatar);
    const taskPayload: Record<string, unknown> = {
      contactName: char.name,
      ...(remoteAvatarUrl ? { avatarUrl: remoteAvatarUrl } : {}),
      // 用 'auto' 而不是 'instant'：'instant' 在上游是「当场跑完」的行型，走不到 fire hooks，
      // 到点拿的就不是这份 chat 段。客户端收到的 push.messageType 由 metadata.amsgMode 决定。
      messageType: 'auto',
      // 上游只把它当自由文本标签原样带进推送，不据此分支；本地拿它把即时对话的行跟
      // 定时任务的行分开——不然一条失败的即时对话行会被面板对账当成排程任务补进清单。
      // 常量与面板对账的过滤端共用（amsgFirePack 的 AMSG_INSTANT_CHAT_SUBTYPE）。
      messageSubtype: AMSG_INSTANT_CHAT_SUBTYPE,
      // 落库即到期（不带 firstSendTime）：用户已经把话说完了，现在就该答。
      // 排未来时刻的话，打包/上传的耗时都要预支提前量，慢网低端机会被
      // 「时间必须在未来」打回，而同一轮走本地路径毫无问题。
      immediate: true,
      // 顶替上一条还没被认领的任务（连发两条时合并成一起回）：上游在建新任务的
      // 同一事务里取消旧的，原子、无第二个请求。
      ...(params.supersedesUuid ? { supersedesUuid: params.supersedesUuid } : {}),
      recurrenceType: 'none',
      tzId,
      // 真正要发给模型的消息在 fire_pack.chat 里，这条只为过上游「messages 非空」的校验。
      messages: [{ role: 'user', content: AMSG2_PLACEHOLDER_PROMPT }],
      // 引用与内联上游只收一种，同传直接 400。
      ...(inlineCreds
        ? {
          apiUrl: normalizeChatApiUrl(api.baseUrl),
          apiKey: api.apiKey,
          primaryModel: api.model,
        }
        : { credRefs }),
      // 温度跟着本地走：本地发多少云端发多少，本地不发（开思考时）云端也不发。
      // 少了它，同一句话云端会落到供应商默认温度（常为 1.0），回复风格和本地对不上。
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(params.maxTokens && params.maxTokens > 0 ? { maxTokens: params.maxTokens } : {}),
      // 思考链三件套（thinking / reasoning_effort / extra_body）放行顶层，随加密信封
      // 到 fire 时刻由上游 buildLlmRequestBody 展开进请求体（核心字段 model/messages
      // 等优先）。⚠️ 依赖上游 amsg-server 认领这个字段（/schedule-message 的
      // fullTaskData 白名单 + buildLlmRequestBody 的展开）；旧版上游会把它剥掉——
      // 那时行为退回「只有 -thinking 模型名后缀生效」，即本次改动前的样子，不会更糟。
      ...(params.extraBody && Object.keys(params.extraBody).length > 0
        ? { llmExtraBody: params.extraBody }
        : {}),
      metadata: {
        charId: char.id,
        charName: char.name,
        source: 'active_msg_2',
        // push 的 messageType 取自这里（收侧按 'instant' 分轨）。
        amsgMode: 'instant',
        // worker 到点靠它认出「这是用户在等回复」，从而跳过那几道主动消息专用的闸。
        amsgInstantChat: true,
        amsgClientTaskId: clientTaskId,
        // 情绪评估交给云端跑：worker 到点和主回复并行发起，结果随最后一条推送回来
        // （见 worker/amsg/src/emotionEval.ts）。凭据走引用时这里只剩提示词模板；
        // 老 worker 那条路还带着副 API 的 apiKey，它只能待在这个加密信封里——worker
        // 组推送前会把它摘掉，一个字节都不许跟着 push 出门。
        ...(emotionEvalSpec ? { amsgEmotionEval: emotionEvalSpec } : {}),
        // 刻意不带 amsgExpirePolicy / amsgAnchorMs：防穿帮闸问的是「到点还该不该主动开口」，
        // 对「回一句用户刚说的话」不适用，带上去反而会把用户等着的回复吞掉。
      },
    };

    const stateEntries = {
      entries: [
        ...(await buildCharStateEntries(char, firePack, now)),
        buildToolConfigEntry(realtimeConfig, now),
      ],
    };
    const [statePayload, encryptedTask] = await Promise.all([
      encryptPayload(client, stateEntries),
      encryptPayload(client, taskPayload),
    ]);

    // 凭据行先落地再建任务（上游建任务前会挨个查引用）。只有值变过才真的发请求，
    // 所以常态下这一步是零请求——不给「用户正等着回复」这条路白加一次往返。
    if (credRows.length > 0) await putLlmCredentialRows(credRows);

    const postInstantChat = () => fetchWithAuthRaw('instant-chat', globalConfig, {
      method: 'POST',
      // 外壳是明文：里头两个信封已经加密好，别再给外壳挂加密头（包装层会当它是整体密文）。
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statePayload, taskPayload: encryptedTask }),
    }, '即时对话');

    let { status, body } = await postInstantChat();
    // 云端说引用的凭据不存在（本地底账脏了）：绕过指纹强传一次再发一次，只自愈一次。
    // 包装层把上游那份原样塞在 error.upstream 里，所以要往里再剥一层看错误码。
    if (status !== 202 && credRows.length > 0 && isCredentialNotFound(body)) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 云端没有这一轮引用的凭据，补传后重发一次`);
      forgetCredIds(credRows.map((row) => row.credId));
      await putLlmCredentialRows(credRows, { force: true });
      ({ status, body } = await postInstantChat());
    }

    if (status !== 202 || typeof body?.uuid !== 'string' || !body.uuid) {
      throw new Error(describeInstantChatFailure(status, body));
    }
    return { uuid: body.uuid, clientTaskId };
  },

  // 同角色活跃会话租约：只 PUT 这一条几十字节的 chat_presence，不复用胖 fire_pack。
  // worker 对 expire AI 任务到点前先读它——新鲜则 skip，避免正在聊天时又弹主动消息。
  // 写入失败由调用方（amsgStateSync 的 lease timer）只 warn，45s TTL 自然失效。
  async syncChatPresence(charId: string, presence: AmsgChatPresence): Promise<void> {
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const response = await client.putClientState([{
      namespace: amsgStateNamespace(charId),
      key: AMSG_CHAT_PRESENCE_KEY,
      value: JSON.stringify(presence),
      updatedAt: presence.activeAt,
    }]);
    if (!response?.success) {
      throw new Error(response?.error?.message || '上传活跃会话租约失败。');
    }
  },

  // 满血同步：把一批角色的最新 fire_pack 合成一次 putClientState 上传（amsgStateSync
  // 打脏后在微任务里合批调用；iOS 切后台只有几秒存活窗口，多角色也必须一次请求写完）。
  // 这里只是拿最新聊天状态去刷新云端那份，失败由调用方 warn（沿用上一份，上下文旧一点）。
  async syncCharFirePacks(items: Array<{
    char: CharacterProfile;
    config: ActiveMsg2CharacterConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
  }>): Promise<void> {
    if (!items.length) return;
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const now = Date.now();
    // 表情包全库与角色无关，整批读一次就够——放在循环里的话 N 个角色要跑 2N 次全表
    // getAll（表情记录带图片数据），拿回来的还是同一份。
    const emojiLibrary = await readEmojiLibrary();
    const entries = [];
    // 逐个串行：并发跑会同时开 N 个 IDB 事务，正是 instant push 那次超时的连接风暴成因。
    for (const item of items) {
      const firePack = await buildFirePack(
        item.char, item.userProfile, item.groups, item.realtimeConfig, emojiLibrary,
      );
      // 大值由 amsg-server 2.6.0-next.4+ 在 worker 存储层透明分块，整条直传，
      // 内容一个字不裁；老 worker 拒超限条目 → 设置页 capabilities 探测亮牌。
      entries.push(...(await buildCharStateEntries(item.char, firePack, now)));
    }
    const response = await client.putClientState(entries);
    if (!response?.success) {
      throw new Error(response?.error?.message || '上传云端状态失败。');
    }
    // amsg-server 2.6.0-next.4+ 局部失败语义：单个坏条目只拒自己，不连坐同批。
    // 被拒的条目点名 warn 出来（该角色沿用上一份 fire_pack，其余角色不受影响）。
    const rejected = (response as { data?: { rejected?: Array<{ namespace: string; key: string; message?: string }> } })
      .data?.rejected;
    if (rejected && rejected.length > 0) {
      console.warn(
        `${ACTIVE_MSG_RUNTIME_HEADER} 云端状态部分条目被拒（对应角色沿用上一份 fire_pack）`,
        rejected.map((r) => `${r.namespace}/${r.key}: ${r.message || 'rejected'}`),
      );
    }
    // amsg-server 2.6.0-next.15 起服务端按 updatedAt 做条件写（旧不盖新）。被拦 = 云端
    // 已有**更新**的一份（多设备 / 多标签页竞写时晚到的旧包），是保护生效而不是错误，
    // log 一句留个排障线索就好。
    const skipped = (response as { data?: { skippedEntries?: Array<{ namespace: string; key: string }> } })
      .data?.skippedEntries;
    if (skipped && skipped.length > 0) {
      console.log(
        `${ACTIVE_MSG_RUNTIME_HEADER} 云端已有更新的一份，这批旧条目被拦下（条件写保护）`,
        skipped.map((s) => `${s.namespace}/${s.key}`),
      );
    }
  },

  async syncToolConfig(realtimeConfig: RealtimeConfig | undefined): Promise<void> {
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const response = await client.putClientState([buildToolConfigEntry(realtimeConfig, Date.now())]);
    if (!response?.success) {
      throw new Error(response?.error?.message || '上传工具凭据失败。');
    }
  },

  // worker 特性探测（amsg-server 2.6.0-next.4+ 的 GET /capabilities）。
  // 老部署没有这个端点 → null。设置页用它亮「worker 需要重新粘贴部署」的牌子，
  // 防止版本落后时新特性静默降级、用户以为功能坏了。不需要 init（无加密参与）。
  /**
   * 这台 worker 现在**真的跑得动**即时对话吗（即时对话的唯一版本门槛）。
   *
   * 认的是 `GET /config-check` 里的 `instantTick`——运行时到底有没有 INSTANT_TICK 绑定。
   * 不认 `instantChat`（那只说明代码里有这条路由）也不认版本号，因为这三样会分家：
   * 自更新由用户那台 Worker 上的**旧代码**执行，旧代码不认识 Durable Object，所以更新完
   * 第一下常常是「代码新了、版本号也对上了、绑定却没接上」，这条路只能回 503。看版本号
   * 的话前端会一边说「已经是最新版」一边发一条挂一条。
   *
   * 「探不到」和「问到了、答案是不行」是两回事，只有后者才写进存量——详见
   * InstantChatProbeOutcome 那段注释。返回值是**探完之后生效的存量**（探不到时
   * 就是探测前那份），调用方只想要一个「现在能不能上云」时用这个签名即可；要分辨
   * 这次到底问没问到，用 probeInstantChatSupportDetailed。
   *
   * 结论顺手存进全局配置（`instantChatSupported`）：真正拦下这一轮的是发消息那条路上的
   * resolveInstantChatReadiness，而它只认这份存量（外加存量为 false 时的一次现探）。
   */
  async probeInstantChatSupport(options?: { timeoutMs?: number }): Promise<boolean> {
    return (await this.probeInstantChatSupportDetailed(options)).supported === true;
  },

  /**
   * 同上，但把「这次到底问到了什么」一并交出来。发消息路上的重探要靠它区分
   * 「确认跑不动」（该提示去更新 Worker）和「这一刻连不上」（多半是网络，等会儿自己好）。
   *
   * timeoutMs：给现探用的护栏。握手时那次不传（不阻塞任何人），发消息路上那次必须传，
   * 否则一条连不上的线路会把用户按在发送键上干等。
   */
  async probeInstantChatSupportDetailed(options?: { timeoutMs?: number }): Promise<InstantChatProbeResult> {
    let previous: boolean | undefined;
    try {
      previous = (await ActiveMsgStore.getGlobalConfig()).instantChatSupported;
    } catch {
      previous = undefined;
    }
    let outcome: InstantChatProbeOutcome = 'unknown';
    try {
      const config = await ensureWorkerReady();
      const init: RequestInit = { method: 'GET' };
      const timeoutMs = options?.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (typeof timeoutMs === 'number' && timeoutMs > 0 && typeof AbortController !== 'undefined') {
        const controller = new AbortController();
        init.signal = controller.signal;
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }
      try {
        const { status, body } = await fetchWithAuthRaw('config-check', config, init, '即时对话能力探测');
        // 只有「200 + 这份 JSON 自称成功」才算问到了答案。401（密钥没填对）、5xx、
        // 中间设备塞回来的网关页……说明的都是「这条线路/这份配置有问题」，而不是
        // 「那台 Worker 跑不动即时对话」，一律留在 unknown。
        if (status === 200 && body?.success === true) {
          outcome = body?.data?.instantTick === true ? 'supported' : 'unsupported';
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    } catch {
      // 网络异常 / 超时 / 中止：同上，不是答案。
      outcome = 'unknown';
    }
    // 探不到就什么都不写：存量保持原样。这一句就是「一次抖动 ≠ 长期降级」的全部。
    if (outcome === 'unknown') return { outcome, supported: previous };
    const supported = outcome === 'supported';
    try {
      await ActiveMsgStore.saveGlobalConfig({ instantChatSupported: supported });
    } catch (error) {
      // 存不下只是这一轮的判断留不到下次，探测结论本身照常返回。
      console.warn('[AmsgInstantChat] 能力探测结果没存下来（下次发消息按上一次的存量判断）', error);
    }
    return { outcome, supported };
  },

  /**
   * 这台 worker 支不支持「凭据存表、任务带引用」（credRefs）。
   *
   * 认的是 GET /capabilities 里的 features 有没有 'llm-credentials'。结论存进全局配置，
   * 之后排程 / 即时对话 / 保存配置都只读那份存量（见 isLlmCredentialsReady）——路上不做
   * 逐次预检，那等于给每条消息加一次 RTT。
   *
   * 探不到（老 worker 没这个端点、网络不通）一律 false：老路在哪台 worker 上都能跑。
   */
  async probeLlmCredentialsSupport(): Promise<boolean> {
    let supported = false;
    try {
      const capabilities = await this.getCapabilities();
      supported = supportsLlmCredentials(capabilities?.features);
    } catch {
      supported = false;
    }
    try {
      await ActiveMsgStore.saveGlobalConfig({ llmCredentialsSupported: supported });
    } catch (error) {
      console.warn('[AmsgLlmCred] 能力探测结果没存下来（下次按上一次的存量判断）', error);
    }
    return supported;
  },

  /**
   * 把几行凭据登记到云端（只传真的变了的那些）。排程 / 即时对话之前调，失败就抛，
   * 让那一轮明确失败——建了一条引用着不存在凭据的任务，到点只会白白失败几轮。
   */
  async putLlmCredentials(rows: LlmCredentialRow[], options?: { force?: boolean }): Promise<number> {
    return putLlmCredentialRows(rows, options ?? {});
  },

  /**
   * 删掉云端登记的凭据行。`credIds` 删指定几行（删角色时清它名下的），
   * `all` 全删（「清空云端数据」）。本地指纹底账同步划掉，不然下次「没变过」会拦住重传。
   */
  async deleteLlmCredentials(opts: { credIds?: string[]; all?: boolean }): Promise<number> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const response = await client.deleteLlmCredentials(opts);
    if (!response?.success) {
      throw new Error(response?.error?.message || '删除 LLM 凭据失败。');
    }
    if (opts.all) forgetAllCredIds();
    else forgetCredIds(opts.credIds ?? []);
    return Number(response.data?.deleted ?? 0);
  },

  /**
   * 用户那台 Worker 上跑的后端代码是不是最新的。
   *
   * 比的是 `GET /config-check` 报的 workerVersion 和本 App 编译进来的
   * AMSG_WORKER_VERSION——两者同源（都出自 utils/amsgWorkerVersion.ts），所以只要不相等
   * 就是「那台 Worker 贴的是旧 bundle」。
   *
   * 三种拿不到结论的情况分开表态，因为界面上该说的话不一样：
   *   - 老 bundle 根本不报这个字段 → outdated（它确实旧，只是旧到还不会自报家门）；
   *   - 网络不通 / 还没连上 → unknown（别在用户断网时催他更新）。
   */
  async probeWorkerVersion(): Promise<{
    state: 'current' | 'outdated' | 'unknown';
    /** 那台 Worker 自报的版本；老 bundle 不报就是 null。 */
    deployed: string | null;
    /** 本 App 期望的版本，用来在界面上写「更新到 X」。 */
    expected: string;
  }> {
    const expected = AMSG_BUNDLE_VERSION;
    try {
      const config = await ensureWorkerReady();
      const { status, body } = await fetchWithAuthRaw('config-check', config, { method: 'GET' }, '后端版本探测');
      if (status !== 200 || body?.success !== true) return { state: 'unknown', deployed: null, expected };
      const deployed = typeof body?.data?.workerVersion === 'string' ? body.data.workerVersion : null;
      if (!deployed) return { state: 'outdated', deployed: null, expected };
      return { state: deployed === expected ? 'current' : 'outdated', deployed, expected };
    } catch {
      return { state: 'unknown', deployed: null, expected };
    }
  },

  /**
   * 让后端自己更新到最新版本。
   *
   * 这活儿只能由 worker 自己干：api.cloudflare.com 不返回 CORS 头，浏览器直接调一律被拦。
   * 所以这里只是按一下开关，取代码、校验、覆盖都发生在 worker 那一侧（见 worker/amsg/src/selfUpdate.ts）。
   *
   * 更新成功那一刻代码就换了，但本次响应仍由旧代码发出——所以这个方法拿到的是「旧代码
   * 报告更新已完成」，不是新代码的自我介绍。想确认新版本真跑起来了，看返回的 bundleHash。
   */
  async selfUpdateWorker(): Promise<AmsgSelfUpdateResult> {
    const config = await ensureWorkerReady();
    const { status, body } = await fetchWithAuthRaw('self-update', config, { method: 'POST' }, '后端自更新');

    // 旧 worker 没有这个端点。它可能回 404，也可能被上游当成未知路由回一段自己的 JSON，
    // 两种都归到「不支持」——让面板去说「先用老办法更新一次」，而不是报一个看不懂的错。
    if (status === 404 || body?.error?.code === 'NOT_FOUND') {
      return {
        ok: false,
        supported: false,
        message: '这台 Worker 还是旧版本，没有自更新能力。先按原来的办法更新一次，之后就能在这儿点了。',
      };
    }
    if (status === 200 && body?.success === true) {
      const data = body.data ?? {};
      return {
        ok: true,
        supported: true,
        message: typeof data.message === 'string' ? data.message : '已经更新到最新版本。',
        bundleHash: typeof data.bundleHash === 'string' ? data.bundleHash : undefined,
      };
    }
    return {
      ok: false,
      supported: true,
      message: body?.error?.message || `更新没成功（HTTP ${status}）。`,
      code: typeof body?.error?.code === 'string' ? body.error.code : undefined,
    };
  },

  async getCapabilities(): Promise<{ serverVersion: string; features: string[] } | null> {
    const globalConfig = await ensureWorkerReady();
    const client = createClient(globalConfig);
    return client.getCapabilities();
  },

  async listPromptAudits(limit = 20): Promise<AmsgPromptAuditEntry[]> {
    const config = await ensureWorkerReady();
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 20));
    const response = await fetchWithAuth(
      `prompt-audit?limit=${safeLimit}`,
      config,
      { method: 'GET' },
      '璇诲彇浜戠 prompt 瀹¤',
    );
    if (!response?.success) {
      throw new Error(response?.error?.message || '读取云端 prompt 审计失败。');
    }
    return Array.isArray(response.data?.entries)
      ? response.data.entries as AmsgPromptAuditEntry[]
      : [];
  },

  async clearPromptAudits(): Promise<{ deleted: number }> {
    const config = await ensureWorkerReady();
    const response = await fetchWithAuth(
      'prompt-audit',
      config,
      { method: 'DELETE' },
      '娓呯┖浜戠 prompt 瀹¤',
    );
    if (!response?.success) {
      throw new Error(response?.error?.message || '清空云端 prompt 审计失败。');
    }
    return { deleted: Number(response.data?.deleted ?? 0) };
  },

  /**
   * 逐条 PUT update-message，返回成功数与失败的 uuid。
   * TASK_NOT_FOUND / TASK_ALREADY_COMPLETED 不算失败——远端已经没有 / 已完结的
   * 任务本来就没有「刷新」可言，正是不需要动的那一侧。单条失败继续跑完其余的
   * （口径同 cancelAllTasksForChar：一条网络抖动不该拖累剩下的任务）。
   */
  async updatePendingTasksRemote(
    taskUuids: string[],
    updates: Record<string, unknown>,
  ): Promise<{ updated: number; failed: string[] }> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    let updated = 0;
    const failed: string[] = [];
    for (const uuid of taskUuids) {
      try {
        const response = await client.updateMessage(uuid, { ...updates });
        const code = response?.error?.code;
        if (response?.success) {
          updated += 1;
        } else if (code !== 'TASK_NOT_FOUND' && code !== 'TASK_ALREADY_COMPLETED') {
          failed.push(uuid);
        }
      } catch {
        failed.push(uuid);
      }
    }
    return { updated, failed };
  },

  /**
   * 单角色版凭据刷新：面板保存后用。
   * 面板手里就有最新的角色级配置（onSave 落库是异步的，读 DB 会拿到旧的），
   * 所以这里让调用方把 config 和要刷的任务清单直接传进来；fixed 在这里再滤一遍，
   * 传错也不至于给固定消息塞凭据。
   */
  async refreshCharPendingAiTaskCredentials(params: {
    char: CharacterProfile;
    config: ActiveMsg2CharacterConfig;
    apiConfig: APIConfig;
    tasks: ActiveMsg2TaskRecord[];
  }): Promise<{
    status: 'no-tasks' | 'ok' | 'partial';
    updated: number;
    failed: number;
  }> {
    const aiTaskUuids = params.tasks
      .filter((t) => t.mode !== 'fixed')
      .map((t) => t.taskUuid);
    if (aiTaskUuids.length === 0) return { status: 'no-tasks', updated: 0, failed: 0 };

    const updates = resolveTaskCredentialUpdates(params.char, params.config, params.apiConfig);
    const { updated, failed } = await this.updatePendingTasksRemote(aiTaskUuids, updates);
    return { status: failed.length ? 'partial' : 'ok', updated, failed: failed.length };
  },

  /**
   * 聊天 API 配置保存后，把新凭据写回还会响的远端 AI 任务（设置页保存路径调）。
   * 任务体里的 apiUrl / apiKey / primaryModel 是排程那一刻冻结的——换了 Key、
   * 旧 Key 吊销后，已排程任务到点全部 401，用户只看到「主动消息怎么不来了」。
   *
   * 范围：开着 2.0（enabled:true）且有 pending AI 任务（mode !== 'fixed'）的
   * 角色。fixed 不走 LLM 用不到凭据；关掉 2.0 的角色残留任务是「待取消」而不是
   * 「待续命」，不给它们续新凭据。生效凭据按 resolveTaskCredentialUpdates 算——
   * 开了单独 API 的角色写的是单独 API 的值，不会被全局配置覆盖。
   */
  async refreshApiCredentialsForPendingTasks(apiConfig: APIConfig): Promise<{
    status: 'no-tasks' | 'ok' | 'partial';
    updated: number;
    failed: number;
  }> {
    const now = Date.now();
    const targets = (await DB.getAllCharacters())
      .filter((char) => isAmsg2EnabledForChar(char))
      .map((char) => ({
        char,
        config: char.activeMsg2Config ?? { enabled: true },
        aiTaskUuids: getPendingTasks(char.activeMsg2Config, now)
          .filter((t) => t.mode !== 'fixed')
          .map((t) => t.taskUuid),
      }))
      .filter((item) => item.aiTaskUuids.length > 0);
    // 没有要刷的任务直接返回：没配 2.0 的用户每次保存 API 不该多打一个请求。
    if (targets.length === 0) return { status: 'no-tasks', updated: 0, failed: 0 };

    let updated = 0;
    let failed = 0;
    for (const item of targets) {
      let updates: Record<string, unknown>;
      try {
        updates = resolveTaskCredentialUpdates(item.char, item.config, apiConfig);
      } catch (error) {
        // 这个角色的凭据配不齐（多半是单独 API 缺字段），整组记失败，别拦着其他角色。
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 角色凭据解析失败，跳过其任务的凭据刷新`, item.char.id, error);
        failed += item.aiTaskUuids.length;
        continue;
      }
      const result = await this.updatePendingTasksRemote(item.aiTaskUuids, updates);
      updated += result.updated;
      failed += result.failed.length;
    }
    return { status: failed ? 'partial' : 'ok', updated, failed };
  },

  /**
   * 角色资料改了之后，把跟着变的字段写回还会响的远端任务行（角色页保存的路径调）。
   *
   * **timeZone**：上游是按任务行里冻结的那份 tzId、以墙钟推进循环任务的下次触发时刻的
   * （tzId 缺省时才退回死加 24h）。fire_pack 里那份 tzId 每轮聊天都会重传，但它救不了
   * 任务行——不刷的话「每天 9:00」会一直按排程那天的时区走，角色改到纽约就成了当地晚上
   * 八九点，跨夏令时还会永久偏一小时；同一次 fire 里 prompt 用新时区、触发时刻用旧时区，
   * 两个钟直接打架。
   *
   * **contactName**：推送横幅标题「来自 X」。AI 模式的 fire 会从 tool_pack 取当前名字
   * （见 worker 的 onLLMOutput），但 fixed 模式不走 hooks，标题直接读任务行这一份。
   *
   * 范围是全部 pending 任务，**含 fixed**：固定文本的循环任务同样按墙钟推进、同样要弹
   * 横幅，所以不能沿用凭据刷新那边的 `mode !== 'fixed'` 过滤。
   *
   * fields 由调用方按「哪些真的变了」逐项开：任务行里存的可能是排程那一刻的快照，跟着
   * 别的操作顺手全刷的话，用户出差时保存一次配置就会把所有任务的时区悄悄挪走。
   */
  async refreshCharPendingTaskRow(
    char: CharacterProfile,
    fields: { timeZone?: boolean; contactName?: boolean },
  ): Promise<{
    status: 'no-tasks' | 'ok' | 'partial';
    updated: number;
    failed: number;
  }> {
    const updates: Record<string, unknown> = {};
    // 关掉自定义时区也走这里：那时该回落到设备时区，跟排程时的算法保持同一份。
    if (fields.timeZone) {
      updates.tzId = resolveCharTimeZone(char) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    // 上游要求非空字符串，空名字传上去会被打回 400。
    if (fields.contactName && char.name?.trim()) updates.contactName = char.name;
    if (Object.keys(updates).length === 0) return { status: 'no-tasks', updated: 0, failed: 0 };

    const uuids = getPendingTasks(char.activeMsg2Config, Date.now()).map((t) => t.taskUuid);
    if (uuids.length === 0) return { status: 'no-tasks', updated: 0, failed: 0 };

    const { updated, failed } = await this.updatePendingTasksRemote(uuids, updates);
    return { status: failed.length ? 'partial' : 'ok', updated, failed: failed.length };
  },

  /**
   * 取回 worker 旁路存下的一份云端状态（push 装不下的大内容，见 amsgXhsSessionKey）。
   * 键不存在、或者内容已被取走清空，都返回 null 交调用方决定——不要在这里编一个空壳
   * 出来，那会让「数据还没取回」和「本来就没有」变成同一件事。
   */
  async readClientStateValue(namespace: string, key: string): Promise<string | null> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const response = await client.getClientState(namespace);
    if (!response?.success) {
      throw new Error(response?.error?.message || '读取云端状态失败。');
    }
    const entries = (response.data?.entries ?? []) as Array<{ key: string; value: string }>;
    const hit = entries.find((e) => e?.key === key);
    return hit?.value ? hit.value : null;
  },

  /**
   * 防穿帮闸最近一次拦下了哪次触发（没有记录 / 读不出来一律 null）。
   *
   * 闸跳过一次 fire 时不发任何 push，而远端那行任务照样被消费掉——客户端事后分不出
   * 「让路了」和「发出去但没收到」。这条记录就是 worker 留下的那句解释，面板照实说明。
   * 读失败按「没有记录」处理：这是一句锦上添花的说明，不该让面板打不开。
   */
  async readLastSkip(charId: string): Promise<AmsgLastSkip | null> {
    try {
      const value = await this.readClientStateValue(amsgStateNamespace(charId), AMSG_LAST_SKIP_KEY);
      return value ? parseLastSkip(value) : null;
    } catch {
      return null;
    }
  },

  /**
   * 往云端 client_state 的某个 namespace/key 上写一份内容（不存在就新建，已有就覆盖）。
   *
   * 云端状态的读写都从这个模块走：worker 地址、用户身份、鉴权初始化都在这里一处备齐，
   * 别处要写云端状态时调这个函数就行，不用自己再建一条连接。
   *
   * 写失败会抛错（内部带网络抖动重试），交调用方决定是重试还是放弃——静默吞掉的话
   * 云端留的就是上一份旧内容，而调用方以为自己已经写成功了。
   */
  async writeClientStateValue(namespace: string, key: string, value: string): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    await putClientStateOrThrow(
      client,
      [{ namespace, key, value, updatedAt: Date.now() }],
      '写入云端状态',
    );
  },

  /**
   * 取回落库后把云端那份的内容清掉，腾回 D1 空间。
   *
   * 这里是**写空串**而不是删除整行：`value: null` 的删除语义只有 hook 侧的
   * `ctx.writeState` 有，HTTP 的 `PUT /client-state` 会把这条当无效条目跳过、
   * 内容原封不动（harness S6b 钉住了这个差异）。留一个几字节的空壳无所谓——键是
   * 每任务固定的，下次触发直接覆盖，存量本来就有上限。
   */
  async clearClientStateValue(namespace: string, key: string): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    await client.putClientState([{ namespace, key, value: '', updatedAt: Date.now() }]);
  },

  /**
   * 清掉某个角色在云端 client_state 里的全部条目（fire_pack / tool_pack /
   * 活跃会话租约 / 旁路存的小红书会话），删角色时用。
   *
   * 为什么单独有这么一个：设置页的「清空云端数据」是全局的、要用户主动去点，
   * 删一个角色时该走的是只清这一个角色的路。返回被清掉的键名供调用方记账。
   */
  async clearCharClientState(charId: string): Promise<string[]> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    return clearNamespaceValuesOrThrow(client, amsgStateNamespace(charId));
  },

  /**
   * 清空该用户在 worker D1 里的全部 client_state，清完立刻把全局工具凭据补回去。
   * 设置页「清空云端数据」把它当其中一步用（见 amsgStateSync 的 wipeAmsgCloudData）。
   *
   * 为什么补传这一步是必须的：云端有三份数据，角色上下文与角色工具数据每轮聊完都会
   * 重新同步（见 syncCharFirePacks），只有全局的 tool_config 是「改的时候才传」——
   * 它没有别的补写时机。而 worker 到点三份缺一就硬失败（见 worker/amsg/src/index.ts
   * 的 fireStateError），于是清空之后已排程的 AI 任务会一直失败，聊多少轮天都不会好。
   *
   * 清空这个动作本身就是一次「云端凭据变没了」的变更，所以在这里就地补回来，
   * 不必让每轮同步都白传一遍。这个方法只碰 client_state、不动任务表，所以它就是
   * 「任务还活着、凭据却没了」的唯一入口，堵住这里就够。
   *
   * 补传失败不算清空失败（清空确实成功了），返回值把结果交给调用方去提示。
   */
  async clearClientState(
    realtimeConfig: RealtimeConfig | undefined,
  ): Promise<{ deleted: number; toolConfigRestored: boolean }> {
    const config = await ensureWorkerReady();
    // 清云端状态可能连用户密钥一起换代：握手缓存作废，之后的第一次调用重新 init。
    invalidateClientCache();
    const client = createClient(config);
    const response = await client.clearClientState();
    if (!response?.success) {
      throw new Error(response?.error?.message || '清除云端状态失败。');
    }
    const { deleted } = response.data as { deleted: number };

    let toolConfigRestored = true;
    try {
      const authed = await initializeClient(config);
      await putClientStateOrThrow(
        authed,
        [buildToolConfigEntry(realtimeConfig, Date.now())],
        '重新上传工具凭据',
      );
    } catch (error) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 清空后补传工具凭据失败`, error);
      toolConfigRestored = false;
    }
    return { deleted, toolConfigRestored };
  },
};
