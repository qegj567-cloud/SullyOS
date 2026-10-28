import { buildChatOutputStylePrompt, readChatTranslationConfig } from './chatOutputStylePrompt';
import { resolveDialogueApi } from './characterApi';
import { ackStoppedReplyReceipts, stoppedReplyStateEntries } from './amsgStoppedReplyClient';
import { loadCharacterContextMessages } from './chatContextRange';
import { ReiClient, classifyClientStateWrite } from '@rei-standard/amsg-client';
import { createCloudDataSession } from './amsgCloudData';
import { captureCloudOwnerGenerations, rememberCloudOwnerGeneration, stampCloudWrite, captureCloudWriteCheck, invalidateCloudOwnerWrites } from './amsgCloudOwnerGeneration';
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
import { parseAmsgSelfUpdateState, type AmsgSelfUpdateReport } from './amsgSelfUpdateState';
import { buildTaskInstruction, resolveSendAtMs } from './amsgFireSchedule';
import {
  getPendingTasks, isAmsg2EnabledForChar,
  parseRemoteTaskLastError, RemoteTaskLastError, type RemoteTaskProjection,
  resolveExpirePolicy, toDatetimeLocalValue,
} from './amsg2Tasks';
import {
  AMSG_DAILY_SENDS_KEY,
  AMSG_LIMITS_KEY,
  type AmsgDailySends,
  buildAmsgLimitsRecord,
  parseDailySends,
  resolveAmsgLimits,
} from './amsgLimits';
import { AMSG_CHAT_PRESENCE_KEY, AmsgChatPresence } from './amsgChatPresence';
import {
  AmsgDiagnosticsProbe, AmsgFailKind, type AmsgTickReportResult, describeAmsgFetchFailure, parseAmsgDebugReport,
} from './amsgDiagnostics';
import { parseAmsgTickReport } from './amsgTickReport';
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
  parseCharCredId,
  pickChangedCredRows,
  rememberCredRows,
  supportsLlmCredentials,
  type LlmCredentialRow,
} from './amsgLlmCredentials';
import {
  chunkClientStateEntries,
  pickSidechannelShellKeys,
  supportsClientStateDelete,
} from './amsgClientStateDelete';
import { observeRemoteStateUpdatedAt, stampStateUpdatedAt } from './amsgStateClock';
import { flattenContentPartsToText } from './promptMessageCleanup';
import { resolveBlobRefsDeep } from './blobRef';
import {
  AMSG_FIRE_PACK_KEY,
  FIRE_PACK_VERSION,
  AMSG_SLOT_AWAY_HINT,
  BEFORE_SPEAK_LINES,
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
import {
  AMSG_BACKGROUND_JOB_SUBTYPE,
  AMSG_JOB_ID_KEY,
  AMSG_JOB_NAMESPACE,
  AMSG_TASK_KIND_KEY,
} from './amsgTaskKinds';
import type { AmsgFireScene } from './amsgFireScene';
import { buildSongPool } from './charMusicSchedule';
import { getDailyScheduleForChar } from './dailySchedule';
import { getLocalDateKey } from './localDate';
import { isScheduleFeatureOn } from './scheduleGenerator';
import {
  AMSG_GLOBAL_NAMESPACE,
  AMSG_TOOL_CONFIG_KEY,
  AMSG_TOOL_PACK_KEY,
  buildToolConfig,
  buildToolPack,
} from './amsgToolPack';
// 只取一个常量：客户端算 firstSendTime 时要留的提前量，和包装层「把任务行拉到期」
// 那一步是同一个数，各写各的就会出现「校验说时间要在未来 / cron 说还没到」的死角。
import type { AmsgEmotionEvalSpec } from '../worker/amsg/src/emotionEval';
import type { AmsgSarModuleSnapshot } from './vrWorld/sarEnvelopeCore';
import { listRecallableMonths } from './agenticTools';
import { ChatPrompts } from './chatPrompts';
import { nowInTimeZone, resolveCharTimeZone, tzAwarenessNote } from './timezone';
import { DB } from './db';
import { copyWorkerBundleToClipboard } from './workerDeploy';
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
import { isUnifiedPushPlatform } from './unifiedPushPlugin';

export const NATIVE_PUSH_TOKEN_STORAGE_KEY = 'amsg2_fcm_token_v1';
const nativePushBuildEnabled = () => import.meta.env.VITE_AMSG_NATIVE_PUSH === 'true';
const readNativePushToken = () => nativePushBuildEnabled() && typeof localStorage !== 'undefined'
  && !isUnifiedPushPlatform()
  ? localStorage.getItem(NATIVE_PUSH_TOKEN_STORAGE_KEY)?.trim() || ''
  : '';

export interface ActiveMsg2PushStatus {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  hasSubscription: boolean;
  vapidConfigured: boolean;
  detail?: string;
  transport?: 'web-push' | 'unified-push';
  distributor?: string | null;
  needsDistributor?: boolean;
}

/** worker 上登记的那份订阅（一个用户一行）。读不到时调用方拿 null。 */
export interface AmsgRemotePushSubscription {
  exists: boolean;
  endpoint: string | null;
  updatedAt: number | null;
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

const createClient = (config: Pick<ActiveMsg2GlobalConfig, 'userId' | 'workerUrl' | 'serverToken'>) => {
  const client = new ReiClient({
    baseUrl: normalizeWorkerBase(config.workerUrl),
    userId: config.userId,
    serverToken: config.serverToken || undefined,
  });
  captureCloudOwnerGenerations(client, config);
  return client;
};

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
 * 拉一次定时任务细账（`GET /tick-report`，形状见 amsgTickReport.ts）。
 *
 * 体检「定时任务」那一行靠它把「到点没发」拆成逐条的原因。跟 /debug 并排拉，所以
 * 失败也不抛：那一行照旧按 /debug 的两个数给笼统结论，这里的原因挂在下面，
 * 让人知道为什么没有逐条的。
 */
export const fetchWorkerTickReport = async (): Promise<AmsgTickReportResult> => {
  let config: ActiveMsg2GlobalConfig;
  try {
    config = await ensureWorkerReady();
  } catch (error: any) {
    return { ok: false, reason: error?.message || '还没填 Worker 地址。' };
  }

  try {
    // 超时的理由同 fetchWorkerDiagnostics：两边是一起等的，这边干等会拖住整块体检。
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
    const { status, body } = await fetchWithAuthRaw('tick-report', config, { method: 'GET', signal }, '体检');
    const report = status === 200 ? parseAmsgTickReport(body) : null;
    if (report) return { ok: true, report };

    if (status === 401 || status === 403) {
      return { ok: false, reason: `Worker 拒绝了读定时任务细账的请求（HTTP ${status}），多半是共享密钥两边对不上。` };
    }
    // 端点在、但查的时候自己出了错（读库失败之类）：这跟「代码太旧」是两回事，原话带上。
    if (status >= 500) {
      const message = typeof body?.error?.message === 'string' ? body.error.message : '';
      return { ok: false, reason: `Worker 查定时任务细账时出错了（HTTP ${status}）${message ? `：${message}` : '。'}` };
    }
    // 404，或者 200 但形状对不上：这台 Worker 上还没有这个端点。
    return { ok: false, reason: '没拿到每条任务的细账（Worker 上的代码可能还不是最新，点上面的「更新 Worker」）。' };
  } catch (error: any) {
    return { ok: false, reason: error?.message || '连不上 Worker。' };
  }
};

/** probeWorkerVersion 的回执：版本对不对，外加那台 Worker 自动更新的近况。 */
export interface AmsgWorkerVersionProbe {
  state: 'current' | 'outdated' | 'unknown';
  /** 那台 Worker 自报的版本；老 bundle 不报就是 null。 */
  deployed: string | null;
  /** 本 App 期望的版本，用来在界面上写「更新到 X」。 */
  expected: string;
  /** 自动更新：有没有这个能力 + 最近一次检查。老 bundle 不报这一段就是 null。 */
  autoUpdate: AmsgSelfUpdateReport | null;
}

const parseSelfUpdateReport = (raw: unknown): AmsgSelfUpdateReport | null => {
  const value = raw as { supported?: unknown; state?: unknown } | null;
  if (!value || typeof value !== 'object' || typeof value.supported !== 'boolean') return null;
  return { supported: value.supported, state: parseAmsgSelfUpdateState(value.state) };
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

/**
 * 后台任务的定时触发（Worker 的 cron trigger）现在开着没有（`GET /cron-trigger`，
 * 见 worker/amsg/src/cronTrigger.ts）。
 * supported 为 false 是端点在、但 Worker 自己查不了（多半是没配 CF_API_TOKEN），code 说明卡在哪。
 */
export interface AmsgCronTriggerState {
  supported: boolean;
  /** 开着 = true。supported 为 false 时没有这一项。 */
  enabled?: boolean;
  /** worker 报的代号（`CF_TOKEN_MISSING` / `SCRIPT_NAME_UNKNOWN` 之类），supported 为 false 时才有。 */
  code?: string;
  /** 给人看的一句，supported 为 false 时才有。 */
  message?: string;
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
/**
 * 「这台 worker 认不认识后台任务」的探测结果（见 probeBackgroundJobSupport）。
 * 只在内存里存，换 workerUrl 自然作废——用户中途换后端时不该拿旧结论当数。
 */
let backgroundJobProbe: { workerUrl: string; supported: boolean; at: number } | null = null;

/**
 * 存量答案是「不支持」时，最多隔这么久就再问一遍。
 *
 * 下面那个 forget 只盖得住「在设置页点按钮更新 Worker」这一条路，而换 bundle 不止这
 * 一条：文档里那条 GitHub「Sync fork」→ Cloudflare Workers Builds 更新完，地址没变、
 * 整个过程也不经过前端，缓存里那句「不支持」就会一直活到用户刷新页面为止——这段时间
 * 每一轮消化都在前台跑那一两分钟的整理，页面一关就死。即时对话那条探测对同样的状态
 * 就是「存着 false 就重探」（见 reprobeInstantChatSupport）。
 *
 * 正面答案不设冷却：一份认识后台任务的 bundle 不会自己变回不认识。
 */
const BACKGROUND_JOB_UNSUPPORTED_RECHECK_MS = 5 * 60_000;

/**
 * 把探测结论作废，下次重新问一遍。
 *
 * 缓存是按 workerUrl 键的，而「更新 Worker」换的是同一个地址上的 bundle——地址没变，
 * 结论却过期了。不作废的话用户刚把后端升上去，前端还认着升级前那句「不支持」，得刷新
 * 页面才好。所以凡是**在同一个地址上换 bundle** 的路径都要调一次：设置页的「重新连接
 * 并验证」、以及「更新 Worker」（POST /self-update）。
 *
 * 从零部署那条路不用调：它换的是 workerUrl 本身，键一变旧缓存自然作废。
 */
export const forgetBackgroundJobProbe = (): void => { backgroundJobProbe = null; };

/**
 * 后台任务能力探测的三种结论。
 *
 * `unsupported` 和 `unknown` 分开是有用的：前者是「这条路断了」（老 bundle，重试也一样），
 * 后者是「这次没问到」（网络抖一下、CF 边缘抽风、D1 冷启动超时）。调用方对这两种的处置
 * 不一样——路断了就该退回本地把活儿干了，而只是没问到时，手上要是还有一份任务在云端跑，
 * 退回本地就是拿同一份快照再烧一次 API、两份结果先后落地互相盖。
 */
export type BackgroundJobProbeOutcome = 'supported' | 'unsupported' | 'unknown';

const BACKGROUND_JOB_MAYBE_CREATED_PROP = '__amsgBackgroundJobMaybeCreated';

/**
 * 这次失败的后台任务，**有没有可能其实已经在远端建起来了**。
 *
 * 只有「`POST /schedule-message` 发出去之后没等到答复」才算——那一刻请求可能已经到了
 * 服务端。服务端答复了「不行」不算（确定没建），上传输入、传凭据那几步失败也不算
 * （它们排在建任务之前）。
 *
 * 调用方靠它区分「没交出去」和「不知道交没交出去」：前者该退回本地把活儿干了，后者
 * 绝不能——那会拿同一份快照在两条路上各跑一次，白烧一次 API，两份结果还先后落地互相盖。
 */
export const mayHaveCreatedBackgroundJob = (error: unknown): boolean =>
  (error as Record<string, unknown> | null | undefined)?.[BACKGROUND_JOB_MAYBE_CREATED_PROP] === true;

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
  // 同理顺手探一次按特性位存的几个结论（凭据存表 credRefs、云端状态删行，见
  // probeWorkerFeatures）。探不到就按老路走，不影响任何一条消息发出去。
  void ActiveMsgClient.probeWorkerFeatures().catch(() => {});
  return promise;
};

const resolveApiConfig = (char: CharacterProfile, _config: ActiveMsg2CharacterConfig, apiConfig: APIConfig) => {
  const source = resolveDialogueApi(apiConfig, char);

  if (!source.baseUrl || !source.apiKey || !source.model) {
    throw new Error('主动消息 2.0 缺少可用的 API URL / Key / Model。');
  }

  return source;
};

/** 存量内联任务的凭据补丁，与新排程一样取聊天主 API。 */
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
 * 这台 worker 现在认不认 `PUT /client-state` 里 `value: null` 的删行语义
 * （能力位 'client-state-delete'，握手时探一次存进全局配置，见 probeWorkerFeatures）。
 *
 * undefined（还没探过）按 false 处理：写空串在哪台 worker 上都能跑，而 null 发到
 * 老 worker 上是逐条被拒。取回旁路内容后的清理、删角色、存量空壳清理三处都读这一份。
 */
export const isClientStateDeleteReady = async (): Promise<boolean> => {
  try {
    return (await ActiveMsgStore.getGlobalConfig()).clientStateDeleteSupported === true;
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
  options: { force?: boolean; client?: ReiClient } = {},
): Promise<number> => {
  const assertWriteCurrent = captureCloudWriteCheck(rows.flatMap(row => { const owner = parseCharCredId(row.credId); return owner ? [owner.charId] : []; }));
  const pending = options.force ? rows : pickChangedCredRows(rows);
  if (pending.length === 0) return 0;
  const client = options.client ?? await initializeClient(await ensureWorkerReady());
  assertWriteCurrent();
  for (const batch of chunkCredRows(pending)) {
    const response = await client.putLlmCredentials(batch.map(row => stampCloudWrite(client, row)));
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
  // 请求内副本：门牌常驻但内容会变，每次从本机重读，不能沿用 UI 挂着的旧注入。
  char = { ...char, roomPlatesInjection: '' };
  if (!templateStub && char.memoryPalaceEnabled) {
    const { buildRoomPlatesInjection } = await import('./memoryPalace/roomPlates');
    char.roomPlatesInjection = await buildRoomPlatesInjection(char.id, userProfile.name);
  }
  const [{ lastUserMessageAt }, recentMessages, library, schedule] = await Promise.all([
    buildTimeGapHint(char.id),
    templateStub ? Promise.resolve([]) : loadCharacterContextMessages(char),
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
  const outputStyle = buildChatOutputStylePrompt({
    charName: char.name,
    userName: userProfile.name,
    translationConfig: readChatTranslationConfig(char.id),
    htmlMode: { enabled: !!char.htmlModeEnabled, customPrompt: char.htmlModeCustomPrompt },
    thinkingChain: { enabled: !!char.showThinkingChain, customPrompt: char.thinkingChainCustomPrompt },
  });
  const recentTranscript = templateStub ? '' : ChatPrompts.buildMessageHistory(
    recentMessages,
    Math.max(1, recentMessages.length),
    char,
    userProfile,
    emojis,
  ).apiMessages
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
    systemPrompt + outputStyle.prompt,
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
    // 到点说不说由角色自己判（见 amsgFirePack 的 BEFORE_SPEAK_LINES）。
    ...BEFORE_SPEAK_LINES,
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
    thinkingChainEnabled: outputStyle.thinkingActive,
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

/** 字节数 → 给人看的 MB（体积类报错共用一份口径）。 */
const formatMegabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

/** 结构化分段里有没有图片这类非文字内容（只有文字段的数组拆了也省不下什么）。 */
const hasNonTextPart = (content: unknown): boolean =>
  Array.isArray(content) && content.some((part: any) => part?.type !== 'text');

// 「图片消息 → 文字占位」的拍平内核与本地 stripImages 路径共用同一份
// （promptMessageCleanup.flattenContentPartsToText）：超预算降级产物必须与
// 本地拍平产物严格同源，否则同一条历史消息在两条生成路上渲染成两种样子。

/**
 * 上云前把聊天消息里的图片令牌（`blobref:<id>`）还原成 data URL，返回一份独立副本。
 *
 * 两条理由，缺一条都不能省这一步：
 *   · worker 那边没有 IndexedDB，令牌到了云端谁也解不开。浏览器里那层「发请求前统一
 *     还原」（utils/apiBlobRefs.ts）够不到 worker 自己发出去的请求，图会静默消失；
 *   · 令牌只有几十字节，而它代表的图可能几 MB。先算预算再还原的话，一份「看着没超」
 *     的包还原后照样超限，下面那道体积闸等于白设。所以顺序是死的：**先还原，再算预算**。
 *
 * resolveBlobRefsDeep 原地改对象，所以先深拷贝再交给它——调用方那串 fullMessages
 * 本地这一轮还要用，一个字节都不能被改。拷贝发生在还原之前，拷的是还带着短令牌的
 * 小结构，不是几 MB 的 base64。
 */
export const resolveChatMessagesForUpload = async (
  messages: Array<{ role: string; content: unknown }>,
): Promise<Array<{ role: string; content: unknown }>> => {
  const copy = messages.map((message) => ({
    role: message.role,
    content: message.content === null || typeof message.content !== 'object'
      ? message.content
      : (typeof structuredClone === 'function'
        ? structuredClone(message.content)
        : JSON.parse(JSON.stringify(message.content))),
  }));
  await resolveBlobRefsDeep(copy);
  return copy;
};

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
    const mb = formatMegabytes;
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
  // 任务正文超过存储的单行上限（amsg-server 2.6.0-next.21 起在建任务时就回 400，
  // 以前要一路走到落库才撞上 D1 的 `string or blob too big`）。上游把两个数放在
  // details 里，照着念就是了——重试没有意义，得先把带上去的内容减下来。
  //
  // 跟 CHAT_CONTENT_BUDGET_BYTES 那道闸不是一回事：那道量的是 fire_pack 里的对话
  // （走 client_state，5 MiB 一条），这道量的是任务正文本身（约 1 MB）。
  const tooLarge = body?.error?.upstream?.error?.code === 'TASK_PAYLOAD_TOO_LARGE'
    ? body?.error?.upstream?.error
    : (code === 'TASK_PAYLOAD_TOO_LARGE' ? body?.error : null);
  if (tooLarge) {
    const bytes = Number(tooLarge?.details?.bytes);
    const maxBytes = Number(tooLarge?.details?.maxBytes);
    const sizes = Number.isFinite(bytes) && Number.isFinite(maxBytes)
      ? `（约 ${formatMegabytes(bytes)} MB，上限 ${formatMegabytes(maxBytes)} MB）`
      : '';
    return `即时对话没发出去：这一轮的任务内容超过了云端单条任务的上限${sizes}。`
      + '精简一下角色设定 / 世界书 / 携带的历史条数，或先关掉即时对话走本地生成。';
  }
  // 上游打回「时间必须在未来」：firstSendTime 是设备的钟加提前量算出来的，被打回
  // 说明提前量在路上被吃光了——要么整包状态上传得太慢，要么设备时钟本身偏慢。
  // 这两种用户能做的事是一样的：重试，或去检查自动对时。别让它掉进下面那句
  // 光秃秃的 HTTP 400。
  if (body?.error?.upstream?.error?.code === 'INVALID_TIMESTAMP') {
    return '即时对话没发出去：没赶上服务端的时间校验——网络太慢，或设备时钟偏慢。'
      + '重试一次通常就好；每次都这样的话，检查一下设备的「自动设置时间」开没开。';
  }
  // 走到这里说明连自愈那一轮（读回云端时间戳对齐再发一次）都没盖上去：要么云端状态
  // 读不回来，要么真的有另一台设备/另一个标签页在同时写同一个角色。
  if (code === 'INSTANT_CHAT_STATE_STALE') {
    return '即时对话没发出去：云端那份状态比这台设备的新，对齐之后重发也没能盖上去。'
      + '另一台设备或另一个标签页开着同一个角色的话，先关掉再发；只有这一台的话，'
      + '检查一下设备的「自动设置时间」开没开。';
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

/**
 * 这个错误体是不是「云端拒收了这一轮的状态」——条件写把 fire_pack 拦下了。
 *
 * 这个码由包装层判出来（`worker/amsg/src/instantChat.ts`），所以只在顶层，不用像
 * 凭据那个一样再往 `error.upstream` 里剥一层。
 */
export const isInstantChatStateStale = (body: any): boolean =>
  body?.error?.code === 'INSTANT_CHAT_STATE_STALE';

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
const putCloudClientState = (client: ReiClient, entries: Parameters<ReiClient['putClientState']>[0]) =>
  client.putClientState(entries.map(entry => stampCloudWrite(client, entry)));

export const putClientStateOrThrow = async (
  client: ReiClient,
  // value 为 null 表示删掉这一行（只在 isClientStateDeleteReady 为 true 时才能发）。
  entries: Array<{ namespace: string; key: string; value: string | null; updatedAt: number; owner?: { type: string; id: string; label?: string } }>,
  phase: string,
): Promise<void> => {
  let lastError: unknown;

  for (const backoffMs of CLIENT_STATE_BACKOFF_MS) {
    if (backoffMs) await delay(backoffMs);

    let response: { success?: boolean; data?: { rejected?: Array<{ key: string; message?: string }> }; error?: { message?: string } } | undefined;
    try {
      response = await putCloudClientState(client, entries) as typeof response;
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
 * 被条件写拦下之后，照云端那几行的时间戳把本地水位抬上去；返回水位有没有真的动。
 *
 * 为什么非得读一遍：拦下只说明「你盖的戳不够新」，没说云端那行是几点。不读回来就只能
 * 猜偏移多少，而这个偏移取决于当初设备时钟跑偏了多少，猜不出来。对齐之后下一次盖的戳
 * 自然就跨得过去了（见 amsgStateClock）。
 *
 * 读失败不抛：调用方拿 false 当「没对齐上」处理，该报的错照报——自愈是加分项，不该
 * 把原本清清楚楚的失败盖成一句「读云端状态失败」。
 */
const alignStateClockWithRemote = async (
  client: ReiClient,
  namespaces: string[],
): Promise<boolean> => {
  let aligned = false;
  for (const namespace of namespaces) {
    try {
      const response = await client.getClientState(namespace) as
        { data?: { entries?: Array<{ updatedAt?: unknown }> } } | undefined;
      for (const entry of response?.data?.entries ?? []) {
        if (observeRemoteStateUpdatedAt(entry?.updatedAt)) aligned = true;
      }
    } catch (error) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 读云端状态时间戳失败，这一轮不对齐`, error);
    }
  }
  return aligned;
};

/**
 * 把一个 namespace 下的条目全部清掉，返回被清掉的键名。
 *
 * 先读一遍再逐条清，而不是照着已知键名盲写，有两个原因：
 *   1. 旁路存储的键名带 clientTaskId（`xhs_session:<id>`），任务记录被
 *      pruneStaleTasks 清掉之后就再也拼不出来，只能靠读回来才知道有哪些；
 *   2. 盲写会把本来不存在的条目 upsert 出来 —— putClientState 是 upsert，
 *      "清理" 反倒变成新建。
 *
 * 清法跟 clearClientStateValue 同一套，按 worker 的能力位分两条路：
 *   - worker 认删行（isClientStateDeleteReady）：读回来的每一行都发 `value: null`
 *     真删，已经是空壳的行也在内——它们正是过去写空留下的，现在能一起删干净；
 *   - 老 worker：只对还有内容的行写空串，留下几字节的空壳；已经是空壳的跳过，
 *     再写一遍不会更干净，只是白占一次请求体。
 * 条目多过上游单批上限时切批发。
 */
export const clearNamespaceValuesOrThrow = async (
  client: ReiClient,
  namespace: string,
): Promise<string[]> => {
  // 全局 namespace 不许走这条路：里面的 tool_config 只在配置变更时才重传，被清掉
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
  const deleteSupported = await isClientStateDeleteReady();
  const keys = entries
    .filter((e) => e?.key && (deleteSupported || e?.value))
    .map((e) => e.key as string);
  if (keys.length === 0) return [];

  const updatedAt = stampStateUpdatedAt();
  const value = deleteSupported ? null : '';
  for (const batch of chunkClientStateEntries(keys)) {
    await putClientStateOrThrow(
      client,
      batch.map((key) => ({ namespace, key, value, updatedAt })),
      '清空云端状态',
    );
  }
  return keys;
};

/**
 * 旁路存储的存量空壳清理：把这几个角色命名空间里历史积累的空壳行扫一遍删掉，
 * 每个角色只扫一次。
 *
 * 在 worker 认删行之前，取回旁路内容后是写空串；即时对话每轮的键都是新的
 * （`reasoning:<uuid>` 这类），于是每个角色的命名空间里躺着一堆只涨不跌的空壳，
 * 而 worker 每次生成都要把整个命名空间读一遍。现在取回即删、不再新增，这里负责清旧账：
 *   - 只在探到 'client-state-delete' 时做，老 worker 收到 null 是逐条被拒；
 *   - 每个角色读一次命名空间，挑出旁路键且值为空串的行（见 pickSidechannelShellKeys），
 *     按上游单批上限切开发 null。别的键一律不碰；
 *   - 扫完（不管有没有空壳）把角色 id 记进全局配置的已扫列表，之后的同步不再为它多读一次；
 *   - 哪一步失败只 warn、这个角色不记进列表，下一次同步再试。
 *
 * 挂在 syncCharFirePacks 的末尾：那条路每次聊完都会为每个角色跑到，正好顺路。放在
 * 正常同步之后，这里的成败不影响同步本身。
 */
const sweepSidechannelShells = async (client: ReiClient, charIds: string[]): Promise<void> => {
  let config: ActiveMsg2GlobalConfig;
  try {
    config = await ActiveMsgStore.getGlobalConfig();
  } catch {
    return;
  }
  if (config.clientStateDeleteSupported !== true) return;
  const swept = new Set(config.sidechannelShellsSweptCharIds ?? []);
  const pending = [...new Set(charIds)].filter((charId) => !swept.has(charId));
  if (pending.length === 0) return;

  const newlySwept: string[] = [];
  for (const charId of pending) {
    const namespace = amsgStateNamespace(charId);
    try {
      const response = await client.getClientState(namespace) as {
        success?: boolean;
        data?: { entries?: Array<{ key?: unknown; value?: unknown }> };
        error?: { message?: string };
      } | undefined;
      if (!response?.success) {
        throw new Error(response?.error?.message || '读取云端状态失败。');
      }
      const shellKeys = pickSidechannelShellKeys(response.data?.entries);
      if (shellKeys.length > 0) {
        const updatedAt = stampStateUpdatedAt();
        for (const batch of chunkClientStateEntries(shellKeys)) {
          await putClientStateOrThrow(
            client,
            batch.map((key) => ({ namespace, key, value: null, updatedAt })),
            '清理旁路存储空壳',
          );
        }
      }
      newlySwept.push(charId);
    } catch (error) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 角色 ${charId} 的旁路存储空壳没清完（下次同步再试）`, error);
    }
  }
  if (newlySwept.length === 0) return;

  try {
    await ActiveMsgStore.saveGlobalConfig({ sidechannelShellsSweptCharIds: [...swept, ...newlySwept] });
  } catch (error) {
    // 列表没存下来只是下次会再扫一遍（再读一次、发现没空壳），已经删掉的行不会回来。
    console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 已扫过的角色列表没存下来（下次同步会再扫一遍）`, error);
  }
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
/**
 * 用户给这个角色定的「频率与额度」（见 amsgLimits）。
 *
 * 保存设置时单独立刻传一次（putCharLimits），每次传 fire_pack 也顺手带一份——两条路
 * 都走这里，worker 读到的永远是同一个构造出来的形状。
 */
const buildLimitsEntry = (char: CharacterProfile, updatedAt: number) => ({
  namespace: amsgStateNamespace(char.id),
  owner: { type: 'character', id: char.id, label: char.name },
  key: AMSG_LIMITS_KEY,
  value: JSON.stringify(buildAmsgLimitsRecord(char.activeMsg2Config, isAmsg2EnabledForChar(char))),
  updatedAt,
});

const buildCharStateEntries = async (
  char: CharacterProfile,
  firePack: AmsgFirePack,
  updatedAt: number,
) => [
  ...(await stoppedReplyStateEntries(char.id)).map(entry => ({ ...entry, namespace: amsgStateNamespace(char.id), updatedAt })),
  buildLimitsEntry(char, updatedAt),
  {
    namespace: amsgStateNamespace(char.id),
    key: AMSG_FIRE_PACK_KEY,
    owner: { type: 'character', id: char.id, label: char.name },
    // 压在加密之前：上游 putClientState 先加密再发，密文压不动（见 amsgFirePack）。
    value: await packStateValue(JSON.stringify(firePack)),
    updatedAt,
  },
  // v2 服务端工具循环的角色侧数据（recall 月度总结 / XHS 开关 / 角色名）。
  {
    namespace: amsgStateNamespace(char.id),
    key: AMSG_TOOL_PACK_KEY,
    owner: { type: 'character', id: char.id, label: char.name },
    value: await packStateValue(JSON.stringify(buildToolPack(char))),
    updatedAt,
  },
];

/** 全局工具凭据条目（v2 服务端工具循环用的搜索 / Notion / 飞书 / 小红书 / 自配 MCP 配置）。 */
const buildToolConfigEntry = (
  realtimeConfig: RealtimeConfig | undefined,
  updatedAt: number,
) => ({
  namespace: AMSG_GLOBAL_NAMESPACE,
  key: AMSG_TOOL_CONFIG_KEY,
  // MCP 配置在这里现读现带：三条上传路径（排程 / fire_pack 冲刷 / 设置保存）
  // 全走这个咽喉，不会出现某条路漏带的版本分叉。
  value: JSON.stringify(buildToolConfig(realtimeConfig, {
    servers: collectMcpFireServers(),
    useNativeTools: getMcpUseNativeTools(),
  })),
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
 * 判定口径与 proactivePushConfig.getOrCreateSubscription 的内联实现一致；那一处在
 * 它自己的文件里，将来合并时以这份抽出来的函数为准。export 供单测 mock pushManager 钉行为。
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
    // 与 proactive 那处同款 fall-through。
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
  'no-subscription': '没拿到订阅',
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
 * 请求体超过这么多字节才压。跟 amsg-client 的 `compressRequest` 用同一个数
 * （16 KB）：小请求压缩省下的字节还不够抵一次 CompressionStream 的开销，而这条路上
 * 真正的大件（fire_pack、整轮聊天）动辄几百 KB 起步，一个数就分得开。
 */
const REQUEST_GZIP_THRESHOLD_BYTES = 16 * 1024;

/**
 * 超阈值的请求体先 gzip 再上网线。
 *
 * 收益有限，得说清楚：这里的正文进 HTTP 之前已经是**密文**，
 * 而 fire_pack 真正的压缩早在交给上游加密之前就做过了（见 amsgFirePack 的
 * packStateValue，省 60%）。所以这一层压掉的只是密文那层 base64 的膨胀，约 25%。
 * 慢网和 iOS 上行那几秒里，这 25% 仍然是实打实少传的字节。
 *
 * 接收端：上游端点由 amsg-server 的 readRequestBody 解（2.6.0-next.21 起），包装层
 * 自己的 `/instant-chat` 由 readMaybeGzippedBody 解。两边都按 gzip 魔数判断，所以
 * 中途被边缘节点替我们解开、头还留着的那种情形也接得住。
 *
 * 压不动就退回明文：老 Safari 没有 CompressionStream，压缩本身出错也一样——这条路
 * 只是省流量，绝不能变成发不出去的理由。
 *
 * export 只为单测。
 */
export const maybeGzipRequestBody = async (
  body: BodyInit | null | undefined,
): Promise<{ body: BodyInit | null | undefined; gzipped: boolean }> => {
  if (typeof body !== 'string') return { body, gzipped: false };
  // 快速排除：UTF-8 一个字符最多三字节（BMP 之外是四字节，但那是代理对、占两个
  // char），所以字符数乘三还不到阈值的，字节数必然也不到，连量都不用量。反过来
  // **不成立**——「字符数不到阈值」推不出「字节数不到阈值」，一段六千字的中文就是
  // 六千字符、一万八千字节。绝大多数请求都在这条线以下，一次 encode 都不用做。
  if (body.length * 3 < REQUEST_GZIP_THRESHOLD_BYTES) return { body, gzipped: false };
  if (typeof CompressionStream !== 'function') return { body, gzipped: false };
  try {
    const raw = new TextEncoder().encode(body);
    // 到这儿才量得准。压缩要用的也是这份字节，没有多算。
    if (raw.byteLength < REQUEST_GZIP_THRESHOLD_BYTES) return { body, gzipped: false };
    const stream = new Response(raw).body!.pipeThrough(new CompressionStream('gzip'));
    return { body: await new Response(stream).arrayBuffer(), gzipped: true };
  } catch (error) {
    console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 请求体压缩失败，这一次照常发明文`, error);
    return { body, gzipped: false };
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

  const { body, gzipped } = await maybeGzipRequestBody(init.body);
  if (gzipped) headers.set('Content-Encoding', 'gzip');

  try {
    const response = await fetch(`${normalizeWorkerBase(config.workerUrl)}/${path}`, {
      ...init,
      headers,
      body,
    });

    return { status: response.status, body: await safeResponseJson(response) };
  } catch (error) {
    throw normalizeActiveMsgApiError(error, phase, config.workerUrl);
  }
};

/**
 * 把 `GET /config-check` 这次报的 bundle 版本记进全局配置（`workerBundleVersion`）。
 * 只在问到答案（200 + success）时调；老 bundle 不报这个字段就记 null（问到了，确实旧）。
 * 即时对话里需要新协议的回合（SAR 信封）靠这份存量判断能不能上云，所以两处探
 * /config-check 的地方都顺手记一笔。存不下只是这一次的结论留不到下次，不影响探测本身。
 */
const rememberWorkerBundleVersion = async (body: any): Promise<void> => {
  const deployed = typeof body?.data?.workerVersion === 'string' ? body.data.workerVersion : null;
  try {
    await ActiveMsgStore.saveGlobalConfig({ workerBundleVersion: deployed });
  } catch (error) {
    console.warn('[AmsgInstantChat] Worker 的 bundle 版本没存下来（下次探测再补）', error);
  }
};

const fetchWithAuth = async (path: string, config: ActiveMsg2GlobalConfig, init: RequestInit, phase = '接口') =>
  (await fetchWithAuthRaw(path, config, init, phase)).body;

const encryptPayload = async (client: ReiClient, payload: unknown) => {
  return (client as unknown as ReiCryptoBridge)._encrypt(JSON.stringify(payload && typeof payload === 'object' && !Array.isArray(payload) ? stampCloudWrite(client, payload as Record<string, unknown>) : payload));
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
    if (isUnifiedPushPlatform()) {
      try {
        const { getUnifiedPushStatus } = await import('./unifiedPushPlugin');
        const status = await getUnifiedPushStatus();
        const needsDistributor = !status.distributor && status.distributors.length === 0;
        return {
          supported: !needsDistributor,
          permission: status.permission === 'prompt' ? 'default' : status.permission,
          hasSubscription: Boolean(status.subscription),
          vapidConfigured: workerConfigured,
          transport: 'unified-push',
          distributor: status.distributor,
          needsDistributor,
          detail: needsDistributor
            ? '尚未检测到 UnifiedPush 服务。请先安装并打开 ntfy 的无 Firebase 版本。'
            : status.lastError
              ? `UnifiedPush：${status.lastError}`
              : !workerConfigured
                ? '请先填写 Worker 地址。'
                : status.distributor
                  ? `UnifiedPush 服务：${status.distributor}`
                  : undefined,
        };
      } catch (error) {
        return {
          supported: false,
          permission: 'unsupported',
          hasSubscription: false,
          vapidConfigured: workerConfigured,
          transport: 'unified-push',
          detail: `UnifiedPush 原生桥不可用：${(error as Error)?.message || error}`,
        };
      }
    }
    // 能力检测与 proactive push 共用 describePushCapabilityGap：
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
      transport: 'web-push',
    };
  },

  async ensurePushSubscription() {
    if (isUnifiedPushPlatform()) {
      const config = await ensureWorkerReady();
      const client = createClient(config);
      const vapidPublicKey = await fetchWorkerVapidKey(client);
      const { ensureUnifiedPushSubscription } = await import('./unifiedPushPlugin');
      return ensureUnifiedPushSubscription(vapidPublicKey);
    }

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
    if (isUnifiedPushPlatform()) {
      const config = await ensureWorkerReady();
      const client = await initializeClient(config);
      try {
        await client.deletePushSubscription();
      } catch (error) {
        console.warn('[ActiveMsg] UnifiedPush 重置：删除 Worker 旧订阅失败，继续覆盖', error);
      }
      const subscription = await this.ensurePushSubscription();
      await client.putPushSubscription(subscription);
      return;
    }

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
    if (isUnifiedPushPlatform()) {
      await this.resetPushSubscription();
      return;
    }

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
    if (isUnifiedPushPlatform()) {
      try {
        const { readUnifiedPushSubscription } = await import('./unifiedPushPlugin');
        const subscription = await readUnifiedPushSubscription();
        if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) return 'skipped';
        const config = await ensureWorkerReady();
        const client = await initializeClient(config);
        await client.putPushSubscription({ endpoint: subscription.endpoint, keys: subscription.keys });
        return 'registered';
      } catch (error) {
        console.warn('[ActiveMsg] 连接后补登记 UnifiedPush 订阅失败', error);
        return 'failed';
      }
    }

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
    // 同理：那台 worker 上的 bundle 可能刚被换过（「更新 Worker」走的是同一个地址），
    // 而「认不认识后台任务」这个结论是按地址缓存的，不作废就还认着升级前那句「不支持」。
    forgetBackgroundJobProbe();
    await initializeClient(config);
    // 写回的是握手前的配置快照，两样探测结论必须剔掉：握手顺手发起的能力探测
    // （initializeClient 里那次 probeInstantChatSupport）可能已经抢先落了新结论，
    // 整份写回会把 instantChatSupported / workerBundleVersion 盖回旧值——
    // 用户刚更新完 Worker 点「重新连接」，存量却还说它是旧版。
    const {
      instantChatSupported: _staleSupported,
      workerBundleVersion: _staleBundleVersion,
      ...handshakeConfig
    } = config;
    await ActiveMsgStore.saveGlobalConfig({ ...handshakeConfig, initializedAt: Date.now() });
    // 「重新连接并验证」是用户显式的一次对表，按特性位存的能力位也当场探准，别等下次握手。
    // 排在保存之后：上面那句写的是握手前的配置快照，探测结论放它前面会被原样盖回去。
    await this.probeWorkerFeatures();
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
   * 后者不构成任何结论——网络抖一下、请求被掐断都会读失败，消息可能好好地躺在账本上，
   * 拿它判「消息没了 / 发送失败」就是误判。
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
    signal?: AbortSignal;
    char: CharacterProfile;
    /** 角色级共享设置（maxTokens）。 */
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
    const assertWriteCurrent = captureCloudWriteCheck([params.char.id]);
    const { char, config, task, replaceTaskUuid, userProfile, groups, realtimeConfig, apiConfig } = params;
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    assertWriteCurrent();
    // 任务体不带订阅，worker 到点读用户级那一份——所以建任务前先把它登记上去。
    const nativeToken = readNativePushToken();
    if (nativeToken) await this.registerNativePushToken(nativeToken);
    else await this.registerPushSubscription();

    // 数量封顶：待触发任务（不含被替换的那个）排满就拒绝，让角色/用户先清。名额用户可调，
    // 用户和角色共用（见 amsgLimits 的 maxActiveTasks）。
    const maxActiveTasks = resolveAmsgLimits(config).maxActiveTasks;
    const pendingOthers = getPendingTasks(config, Date.now())
      .filter((t) => t.taskUuid !== replaceTaskUuid);
    if (pendingOthers.length >= maxActiveTasks) {
      throw new Error(`该角色已经排好了 ${maxActiveTasks} 次主动消息，到上限了（上限在「主动频率」里调），请先取消或合并已有的。`);
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
        // 到点策略字段：worker onBeforeFire 从这里读；amsgClientTaskId 还随 push 落到气泡上，
        // 是这条任务在客户端的归属键。
        // fixed 恒为 force——它走不了 worker 闸（taskNeedsLlm=false），语义统一钉死。
        // recurrenceType / occurrenceMs 不往这儿抄：库会把它们盖在每条 push 顶层，
        // 角色在 fire 里自排的任务也一样有，抄一份反而多一处会漏写的地方。
        amsgClientTaskId: clientTaskId,
        amsgExpirePolicy: resolveExpirePolicy(task.mode, task.expirePolicy),
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
      const now = stampStateUpdatedAt();
      const owesChat = owesInstantChatReply(char.id);
      if (owesChat) {
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 该角色还欠着一条即时对话回复，这次排程不覆盖云端 fire_pack（等回复销账后由状态同步补传）`);
      }
      const charEntries = await buildCharStateEntries(char, firePack, now);
      await putClientStateOrThrow(client, [
        ...(owesChat ? charEntries.filter((entry) => entry.key !== AMSG_FIRE_PACK_KEY) : charEntries),
        buildToolConfigEntry(realtimeConfig, now),
      ], '上传云端状态');
      ackStoppedReplyReceipts(charEntries, char.id);
    }

    // 凭据行要先在云端存在：上游建任务前会挨个查引用，缺一个就 409 CREDENTIAL_NOT_FOUND。
    // 只在值变过时真的发请求（指纹底账），所以常态下这一步一个请求都不发。
    if (credRow) await putLlmCredentialRows([credRow], { client });

    const postSchedule = async () => {
      params.signal?.throwIfAborted();
      const encrypted = await encryptPayload(client, payload);
      return fetchWithAuth('schedule-message', globalConfig, {
        method: 'POST',
        signal: params.signal,
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
      await putLlmCredentialRows([credRow], { force: true, client });
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
      clientTaskId,
      replacedCancelFailed,
      // 解析好的绝对时刻（UTC ISO）。任务记录存这一份，字段口径才只有一种。
      firstSendAt: firstSendTime,
    };
  },

  /**
   * 这台 worker 上的代码认不认识「后台任务」。
   *
   * 认的是 `GET /config-check` 里的 `backgroundJobs`——**这份 bundle 里有没有那段分派代码**，
   * 不是版本号：自更新永远由用户那台 Worker 上的旧代码执行，「版本号对上了、新逻辑没生效」
   * 是真实存在的中间态（即时对话那次踩过，见 probeInstantChatSupportDetailed）。
   *
   * 老 bundle 不报这个字段 → false，调用方留在本地跑。老 worker 会把后台任务当聊天任务
   * 跑、卡在「本次任务指令缺失」终态失败，而那条任务行不在用户的清单里——面板一片正常，
   * 活儿却永远不干。这道门就是为了别走到那儿。
   *
   * 探不到（网络抖 / 没连上）是单独一种结论 `unknown`，不跟「不支持」混：后台活儿本来
   * 就有本地那条路，宁可这一轮在本地跑掉也别建一条注定失败的任务——但「这次没问到」时
   * 手上可能还有一份任务正在云端跑，那时候退回本地是有害的（见 plateCloudGate）。
   *
   * 「问不到」也**不写进缓存**——只有拿到明确答复（不管支不支持）才按 workerUrl 记下来。
   * 混着缓存的话，一次代理切换、一次 CF 边缘抖动、一次 D1 冷启动超时，就能把整个会话
   * 钉死在本地整理，只有刷新页面才翻得回来。
   *
   * 缓存本身只为省掉「一轮里连着提交好几个 job」时的重复请求——这类任务几十轮才跑一次。
   */
  async probeBackgroundJobSupportDetailed(): Promise<BackgroundJobProbeOutcome> {
    let config: ActiveMsg2GlobalConfig;
    try {
      config = await ensureWorkerReady();
    } catch {
      return 'unknown';
    }
    const cached = backgroundJobProbe;
    if (
      cached?.workerUrl === config.workerUrl
      // 「不支持」只当阶段性结论：worker 可能在这个会话里被别的路径换掉了
      // （见 BACKGROUND_JOB_UNSUPPORTED_RECHECK_MS）。
      && (cached.supported || Date.now() - cached.at < BACKGROUND_JOB_UNSUPPORTED_RECHECK_MS)
    ) {
      return cached.supported ? 'supported' : 'unsupported';
    }
    try {
      const { status, body } = await fetchWithAuthRaw(
        'config-check', config, { method: 'GET' }, '后台任务能力探测',
      );
      if (status !== 200 || body?.success !== true) {
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 后台任务能力问不到（HTTP ${status}），不记缓存`);
        return 'unknown';
      }
      const supported = body?.data?.backgroundJobs === true;
      backgroundJobProbe = { workerUrl: config.workerUrl, supported, at: Date.now() };
      return supported ? 'supported' : 'unsupported';
    } catch (error) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 后台任务能力探测没发出去，不记缓存`, error);
      return 'unknown';
    }
  },

  /** 只问「能不能交」的那一版：问不到当不能交。要区分「问不到」用上面那个。 */
  async probeBackgroundJobSupport(): Promise<boolean> {
    return (await this.probeBackgroundJobSupportDetailed()) === 'supported';
  },

  /**
   * 排一条**后台任务**：不说话的那种活儿（门牌整理是第一个），跑完把结果送回客户端。
   *
   * 跟排主动消息的那条路（scheduleCharacterTask）共用调度器，但要的东西少得多：
   * 不传 fire_pack / tool_pack（那是聊天专用的云端状态，worker 的 kind 分派排在读它们
   * 之前），不填「本次任务指令」，也不写防穿帮锚点——「到点还该不该说这句话」那一整套
   * 判断对后台活儿都不适用。
   *
   * 只走凭据引用那条路，不做内联降级：这类任务用的往往是副 API（比如记忆宫殿那份），
   * 内联三件套那条老路只有一个 chat 槽位，塞进去等于把副 API 冒充成聊天 API。凭据存不了
   * 表的老 worker 上直接抛错，调用方据此留在本地跑。
   *
   * 顺序与排程那条路一致：**先传输入、成功了再建任务**。反过来失败的话，远端会留下一条
   * 到点取不到输入的任务；这个方向的残留是无害的那一侧——没人引用的输入行会被
   * clientStateTtl 清掉。
   *
   * @returns 远端任务 uuid
   */
  async scheduleBackgroundJob(params: {
    /** 业务种类，worker 按它分派 handler（见 utils/amsgTaskKinds.ts） */
    kind: string;
    /** 任务归属的角色。worker 的 charId 是必填的，调度器也按它分组串行 */
    charId: string;
    charName: string;
    /** 这一次的一次性输入在 amsg:job 命名空间下的 key */
    jobKey: string;
    /** 任务 metadata 上带的 job 编号，worker 靠它去抽屉里取输入 */
    jobId: string;
    /** 一次性输入本体（会被 JSON 序列化 + 压缩后上传） */
    jobInput: unknown;
    /** 这条任务该用哪一行凭据。行不在云端时这里负责补传 */
    credRow: LlmCredentialRow;
    /**
     * 采样温度与输出上限：**同一件活儿在本地跑和在云端跑必须用同一组**。
     * 不传的话上游整个省略这两个字段，落到供应商默认值（温度常为 1.0、输出上限常远小于
     * 后台活儿需要的量）——同一批材料两条路会跑出不一样的结果，而界面上完全看不出来。
     */
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ uuid: string }> {
    const assertWriteCurrent = captureCloudWriteCheck([params.charId]);
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    assertWriteCurrent();

    if (!await isLlmCredentialsReady()) {
      throw new Error('这台 Worker 还不支持凭据存表，后台任务跑不了（去设置页重新部署一次）。');
    }

    const now = stampStateUpdatedAt();
    await putClientStateOrThrow(client, [{
      namespace: AMSG_JOB_NAMESPACE,
      key: params.jobKey,
      owner: { type: 'character', id: params.charId, label: params.charName },
      value: await packStateValue(JSON.stringify(params.jobInput)),
      updatedAt: now,
    }], '上传后台任务输入');

    await putLlmCredentialRows([params.credRow], { client });

    const payload: Record<string, any> = {
      contactName: params.charName,
      messageType: 'auto',
      // 任务清单跟远端对账时靠它把这些行挡在外面（见 amsg2Tasks 的 reconcileTasksWithRemote）。
      messageSubtype: AMSG_BACKGROUND_JOB_SUBTYPE,
      // 立刻可跑：到期时间由服务端自己盖，下一跳 cron（最多一分钟）就会捞起来。
      // 不能改成客户端算一个 firstSendTime——那个时刻在上传输入、传凭据、加密、
      // 发请求这一路上早就过去了，服务端一律打回「时间必须在未来」，整条云端路
      // 每次都退回本地跑。即时对话那条路同样只用 immediate。
      immediate: true,
      recurrenceType: 'none',
      metadata: {
        charId: params.charId,
        charName: params.charName,
        source: 'active_msg_2',
        [AMSG_TASK_KIND_KEY]: params.kind,
        [AMSG_JOB_ID_KEY]: params.jobId,
      },
      credRefs: { chat: params.credRow.credId },
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(params.maxTokens && params.maxTokens > 0 ? { maxTokens: params.maxTokens } : {}),
      // 服务端要求「completePrompt 或 messages」二选一。到点真正发给 LLM 的 messages 由
      // worker 的 kind handler 返回值覆盖，这条占位内容永远不参与生成。
      messages: [{ role: 'user', content: AMSG2_PLACEHOLDER_PROMPT }],
    };

    const postSchedule = async () => {
      const encrypted = await encryptPayload(client, payload);
      try {
        return await fetchWithAuth('schedule-message', globalConfig, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Payload-Encrypted': 'true',
            'X-Encryption-Version': '1',
          },
          body: JSON.stringify(encrypted),
        }, '创建后台任务');
      } catch (error) {
        // 请求发出去了却没等到答复（断网、超时、连接被掐）：这条任务可能已经在远端建
        // 起来了。挂个标记交给调用方，别让它把这种情形当成「没交出去」——见
        // mayHaveCreatedBackgroundJob。只包这一步：上面上传输入、传凭据那两步排在建任务
        // 之前，它们失败时确定还没有任务。
        if (error && typeof error === 'object') {
          (error as Record<string, unknown>)[BACKGROUND_JOB_MAYBE_CREATED_PROP] = true;
        }
        throw error;
      }
    };

    let response = await postSchedule();
    // 与排程那条路同款自愈：本地指纹底账记着传过、云端其实没有（换过 master key /
    // 点过「清空云端数据」）。绕过指纹强传一次再重排一次，只自愈一次。
    if (!response?.success && response?.error?.code === 'CREDENTIAL_NOT_FOUND') {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 云端没有这行凭据，补传后重排一次`, params.credRow.credId);
      forgetCredIds([params.credRow.credId]);
      await putLlmCredentialRows([params.credRow], { force: true, client });
      response = await postSchedule();
    }

    if (!response?.success) {
      throw new Error(response?.error?.message || '后台任务创建失败。');
    }
    return response.data as { uuid: string };
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
    uuid?: string;
    signal?: AbortSignal;
    char: CharacterProfile;
    /** 本地生成会 POST 给 /chat/completions 的那串 fullMessages，原样带上去。 */
    chatMessages: Array<{ role: string; content: unknown }>;
    /**
     * 这一轮该用的聊天凭据——**必须是本地生成那一轮会用的同一份**（effectiveApi）。
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
    /**
     * SAR 临时模块的请求时快照（只在角色或用户身上有模块时带）。worker 按它拆信封、
     * 逐段带回外显，并把它原样挂回最后一条推送，落库侧据此写事件、推进回合。
     */
    sarModule?: AmsgSarModuleSnapshot;
    /** 上一条还没被认领的即时对话任务，连发两条时用它顶掉（合并成一起回）。 */
    supersedesUuid?: string;
  }): Promise<{ uuid: string; clientTaskId: string }> {
    params.signal?.throwIfAborted();
    const assertWriteCurrent = captureCloudWriteCheck([params.char.id]);
    const { char, chatMessages, api, userProfile, groups, realtimeConfig } = params;
    if (!api.baseUrl || !api.model) throw new Error('即时对话没发出去：聊天 API 地址或模型没配齐。');
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    assertWriteCurrent();

    params.signal?.throwIfAborted();
    const now = Date.now();
    const tzId = resolveCharTimeZone(char) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    // 模板只有定时任务那条路才渲染：角色 2.0 关着（云端 fire 不注入排程工具，排不出
    // 会消费模板的新任务）且本地任务清单为空时，用占位模板省掉每次发送的二次全量
    // 构建与上传。2.0 开着 / 还挂着任务（含取消失败的幽灵行）就老老实实带真模板。
    const templateStub = !isAmsg2EnabledForChar(char)
      && (char.activeMsg2Config?.tasks?.length ?? 0) === 0;
    const firePack: AmsgFirePack = {
      ...(await buildFirePack(char, userProfile, groups, realtimeConfig, undefined, { templateStub })),
      // 先还原图片令牌再算体积预算——反过来会让一份「看着没超」的包在云端胀成几 MB，
      // 而 worker 那边根本解不开令牌（见 resolveChatMessagesForUpload）。
      chat: { messages: toFirePackChatMessages(await resolveChatMessagesForUpload(chatMessages)), builtAt: now },
    };

    const clientTaskId = crypto.randomUUID();

    params.signal?.throwIfAborted();
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
      ? (credRefs.emotion ? {
          prompt: params.emotionEval.prompt,
          ...(params.emotionEval.homeSecretRequestId ? {homeSecretRequestId: params.emotionEval.homeSecretRequestId} : {}),
        } : params.emotionEval)
      : undefined;

    const remoteAvatarUrl = toRemoteAvatarUrl(char.avatar);
    const taskPayload: Record<string, unknown> = {
      ...(params.uuid ? { uuid: params.uuid } : {}),
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
        // SAR 模块生效 / 恢复期的那一轮：请求时冻结的快照（见 AmsgSarModuleSnapshot）。
        // 只有收尾用得到的最小字段，不含凭据，worker 原样挂回末条推送。
        ...(params.sarModule ? { amsgSar: params.sarModule } : {}),
        // 刻意不带 amsgExpirePolicy：防穿帮闸问的是「到点还该不该主动开口」，
        // 对「回一句用户刚说的话」不适用，带上去反而会把用户等着的回复吞掉。
      },
    };

    // 云端那一行的版本号走水位而不是墙钟（见 amsgStateClock）：设备时钟领先过真实时间
    // 的话，云端会留着一个还没到的时刻，之后每次上传都被条件写判成「旧的」，这条路上
    // 的表现就是每发一句都 409。
    const stampedAt = stampStateUpdatedAt();
    const stateEntries = [
      ...(await buildCharStateEntries(char, firePack, stampedAt)),
      buildToolConfigEntry(realtimeConfig, stampedAt),
    ];
    // 自愈那一轮只换戳、不重打包：value 里那份压好的 fire_pack 原样复用。
    const encryptStateEntries = (updatedAt: number) => encryptPayload(client, {
      entries: stateEntries.map((entry) => ({ ...entry, updatedAt })),
    });
    // 凭据行随这一轮一起交给 worker，由它在建任务前照这份覆盖——每一轮都带，不看底账。
    // 底账只记得「这台设备传过什么」，云端那行被别的入口（iOS 上 Safari 和主屏 App 各存
    // 各的）或别的 Worker 改过时它还写着「传过了」，任务就会一直拿别人留下的凭据跑。
    // 请求体多几百字节、worker 多写一两行 D1，不多一次往返。
    const [encryptedTask, initialState, credPayload] = await Promise.all([
      encryptPayload(client, taskPayload),
      encryptStateEntries(stampedAt),
      credRows.length > 0 ? encryptPayload(client, { credentials: credRows }) : Promise.resolve(undefined),
    ]);
    // 重发那一轮要换成新盖的戳，所以这份是可变的。
    let statePayload = initialState;

    // 旧 bundle 的 worker 不认 credPayload，凭据行还得靠这一步单独登记（上游建任务前会
    // 挨个查引用）。只有值跟底账不一样才真的发请求，常态下是零请求；新 bundle 上它最多是
    // 值刚变的那一轮多写一遍。
    params.signal?.throwIfAborted();
    if (credRows.length > 0) await putLlmCredentialRows(credRows, { client });

    const postInstantChat = () => {
      params.signal?.throwIfAborted();
      // 已发出的受理请求读完 UUID 后再取消，避免请求断开却留下不知道身份的任务。
      return fetchWithAuthRaw('instant-chat', globalConfig, {
        method: 'POST',
        // 外壳是明文：里头两个信封已经加密好，别再给外壳挂加密头（包装层会当它是整体密文）。
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statePayload, taskPayload: encryptedTask, ...(credPayload ? { credPayload } : {}) }),
      }, '即时对话');
    };

    let { status, body } = await postInstantChat();
    if (status !== 202) params.signal?.throwIfAborted();
    // 云端说引用的凭据不存在（本地底账脏了）：绕过指纹强传一次再发一次，只自愈一次。
    // 包装层把上游那份原样塞在 error.upstream 里，所以要往里再剥一层看错误码。
    if (status !== 202 && credRows.length > 0 && isCredentialNotFound(body)) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 云端没有这一轮引用的凭据，补传后重发一次`);
      forgetCredIds(credRows.map((row) => row.credId));
      await putLlmCredentialRows(credRows, { force: true, client });
      ({ status, body } = await postInstantChat());
    }
    // 云端拒收了这一轮的状态：不是内容有问题，是这台设备盖的时间戳跨不过云端那一行
    // （设备时钟被改过之后，云端会一直留着一个还没到的时刻）。读回云端那份对齐水位、
    // 重新盖戳再发一次。对齐不动就不重发——那说明拦下它的不是时间戳，重发也是白发。
    if (status !== 202 && isInstantChatStateStale(body)) {
      if (await alignStateClockWithRemote(client, [amsgStateNamespace(char.id)])) {
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 云端状态的时间戳比本机的钟新，对齐后重发这一轮`);
        statePayload = await encryptStateEntries(stampStateUpdatedAt());
        ({ status, body } = await postInstantChat());
      }
    }

    if (status !== 202 || typeof body?.uuid !== 'string' || !body.uuid) {
      throw new Error(describeInstantChatFailure(status, body));
    }
    ackStoppedReplyReceipts(stateEntries, char.id);
    // worker 说凭据行已经照这一轮覆盖过了：底账跟着对齐，后台补传和排程那几条路才不会
    // 拿一份过期的「传过什么」去判断。旧 bundle 不回这个键，不记。
    if (body.credentialsSynced === true) rememberCredRows(credRows);
    return { uuid: body.uuid, clientTaskId };
  },

  // 同角色活跃会话租约：只 PUT 这一条几十字节的 chat_presence，不复用胖 fire_pack。
  // worker 对 expire AI 任务到点前先读它——新鲜则 skip，避免正在聊天时又弹主动消息。
  // 写入失败由调用方（amsgStateSync 的 lease timer）只 warn，45s TTL 自然失效。
  async syncChatPresence(charId: string, presence: AmsgChatPresence): Promise<void> {
    const assertWriteCurrent = captureCloudWriteCheck([charId]);
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    assertWriteCurrent();
    const response = await putCloudClientState(client, [{
      namespace: amsgStateNamespace(charId),
      key: AMSG_CHAT_PRESENCE_KEY,
      value: JSON.stringify(presence),
      // 行的版本号走水位，而不是 presence.activeAt：worker 读的是 value 里那个
      // activeAt（45s TTL 判活跃），版本号只管「这一行能不能盖上去」，两者不是一回事。
      updatedAt: stampStateUpdatedAt(),
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
    /** 队列快照的授权仍有效；必须在真正发送前再次确认。 */
    isCurrent?: () => boolean;
  }>): Promise<void> {
    const assertWriteCurrent = captureCloudWriteCheck(items.map(item => item.char.id));
    if (!items.length) return;
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    assertWriteCurrent();
    const now = stampStateUpdatedAt();
    // 表情包全库与角色无关，整批读一次就够——放在循环里的话 N 个角色要跑 2N 次全表
    // getAll（表情记录带图片数据），拿回来的还是同一份。
    const emojiLibrary = await readEmojiLibrary();
    const entries = [];
    // 逐个串行：并发跑会同时开 N 个 IDB 事务，容易撞上 IndexedDB 连接风暴（写失败、确认超时）。
    for (const item of items) {
      if (item.isCurrent?.() === false) continue;
      const firePack = await buildFirePack(
        item.char, item.userProfile, item.groups, item.realtimeConfig, emojiLibrary,
      );
      // 大值由 amsg-server 2.6.0-next.4+ 在 worker 存储层透明分块，整条直传，
      // 内容一个字不裁；老 worker 拒超限条目 → 设置页 capabilities 探测亮牌。
      entries.push(...(await buildCharStateEntries(item.char, firePack, now)));
    }
    const authorizedNamespaces = new Set(items.filter(item => item.isCurrent?.() !== false).map(item => amsgStateNamespace(item.char.id)));
    const authorizedEntries = entries.filter(entry => authorizedNamespaces.has(entry.namespace));
    if (!authorizedEntries.length) return;
    for (const batch of chunkClientStateEntries(authorizedEntries)) {
      const response = await putCloudClientState(client, batch);
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
      // amsg-server 2.6.0-next.15 起服务端按 updatedAt 做条件写（旧不盖新）。被拦有两种
      // 成因，长得一模一样：云端确实有更新的一份（多设备 / 多标签页竞写），或者云端那行
      // 的时间戳落在了未来（设备时钟被改过，见 amsgStateClock）。后者不管的话，这个角色
      // 的云端上下文会一直停在旧版本、主动消息一直拿旧上下文说话，而这条路上除了这行 log
      // 没有任何动静——比即时对话那条明着报 409 的还难发现。
      //
      // 对齐水位就够了，这一轮不重传：fire_pack 每轮聊天都是全量重建的，下一次打脏同步
      // 带着更新的内容盖过去，比现在拿这份已经被判成「旧」的包硬挤进去更有道理。
      const skipped = (response as { data?: { skippedEntries?: Array<{ namespace: string; key: string }> } })
        .data?.skippedEntries;
      if (skipped && skipped.length > 0) {
        console.warn(
          `${ACTIVE_MSG_RUNTIME_HEADER} 云端已有更新的一份，这批条目被条件写拦下`,
          skipped.map((s) => `${s.namespace}/${s.key}`),
        );
        await alignStateClockWithRemote(client, [...new Set(skipped.map((s) => s.namespace))]);
      }
      const notApplied = new Set([
        ...(rejected ?? []).map(r => `${r.namespace}/${r.key}`),
        ...(skipped ?? []).map(s => `${s.namespace}/${s.key}`),
      ]);
      ackStoppedReplyReceipts(batch.filter(e => !notApplied.has(`${e.namespace}/${e.key}`)));
    }
    // 同步已经落定，顺路把这几个角色的存量空壳清一遍（每角色一次，失败只 warn）。
    await sweepSidechannelShells(client, items.filter(item => item.isCurrent?.() !== false).map(item => item.char.id));
  },

  async syncToolConfig(
    realtimeConfig: RealtimeConfig | undefined,
    options?: { updatedAt: number },
  ): Promise<void> {
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const entry = buildToolConfigEntry(realtimeConfig, options?.updatedAt ?? stampStateUpdatedAt());
    const response = await putCloudClientState(client, [entry]);
    const [outcome] = classifyClientStateWrite([entry], response);
    if (outcome?.status === 'applied') return;
    if (outcome?.status === 'conflict') {
      // 只为下一次明确保存校时；这份已被拒的快照不自动换一个更高版本覆盖远端。
      await alignStateClockWithRemote(client, [entry.namespace]);
      throw Object.assign(new Error('云端工具配置已有更新，本次修改尚未同步。请核对配置后重新保存。'), {
        code: 'TOOL_CONFIG_CONFLICT',
      });
    }
    throw Object.assign(new Error(outcome?.error?.message || response?.error?.message || '工具配置写入未确认，稍后重试。'), {
      code: 'TOOL_CONFIG_SYNC_UNCONFIRMED',
    });
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
          await rememberWorkerBundleVersion(body);
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
   * 一次 GET /capabilities，把按特性位存的几个结论一起刷新进全局配置：
   *   llmCredentialsSupported     'llm-credentials'      凭据存表、任务带引用（见 isLlmCredentialsReady）
   *   clientStateDeleteSupported  'client-state-delete'  PUT /client-state 认 value: null 删行（见 isClientStateDeleteReady）
   *
   * 之后排程 / 即时对话 / 清云端状态各条路都只读那份存量——路上不做逐次预检，
   * 那等于给每条消息加一次 RTT。握手时（initializeClient）和「重新连接并验证」各探一次。
   *
   * 探不到（老 worker 没这个端点、网络不通）一律 false：老路在哪台 worker 上都能跑。
   */
  async probeWorkerFeatures(): Promise<{ llmCredentialsSupported: boolean; clientStateDeleteSupported: boolean }> {
    let features: string[] | null = null;
    try {
      features = (await this.getCapabilities())?.features ?? null;
    } catch {
      features = null;
    }
    const flags = {
      llmCredentialsSupported: supportsLlmCredentials(features),
      clientStateDeleteSupported: supportsClientStateDelete(features),
    };
    try {
      await ActiveMsgStore.saveGlobalConfig(flags);
    } catch (error) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 能力探测结果没存下来（下次按上一次的存量判断）`, error);
    }
    return flags;
  },

  /** 这台 worker 支不支持 credRefs（只关心凭据那一位的入口；探测本身见 probeWorkerFeatures）。 */
  async probeLlmCredentialsSupport(): Promise<boolean> {
    return (await this.probeWorkerFeatures()).llmCredentialsSupported;
  },

  /**
   * 把几行凭据登记到云端（只传真的变了的那些）。排程 / 即时对话之前调，失败就抛，
   * 让那一轮明确失败——建了一条引用着不存在凭据的任务，到点只会白白失败几轮。
   */
  async putLlmCredentials(rows: LlmCredentialRow[], options?: { force?: boolean }): Promise<number> {
    return putLlmCredentialRows(rows, options ?? {});
  },

  /**
   * 列出云端 client_state 里有哪些命名空间，各占多少。给「云端数据」清点用。
   *
   * 这是唯一一条能发现「本地已经没有、云端只剩一份上下文」的角色的线索：任务表和凭据
   * 表都问不到它们（还没创建过任务或凭据行），而角色命名空间在 worker 侧没有 TTL，
   * 不主动去看就永远不知道它在那儿。
   *
   * 要用户那台 worker 更新到带 `client-state-namespaces` 的版本。老 worker 上那条路由
   * 不存在，直接问会拿到一句没法解释的 404——所以先问 capabilities，缺能力时抛一句
   * 说得清的话，界面照它提示「更新 Worker 之后清单会更全」。
   *
   * 这一趟要在 worker 上按用户扫一遍 client_state，所以只在用户点开清点界面时调，
   * 别塞进体检或者任何定时路径（每分钟白扫一遍 D1 就是 rows read 被扫穿的来由）。
   */
  async listCloudNamespaces(): Promise<Array<{
    namespace: string; entryCount: number; byteSize: number; updatedAt: number | null;
  }>> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const features = await this.getCapabilities().then((c) => c?.features ?? null).catch(() => null);
    if (!features?.includes('client-state-namespaces')) {
      throw new Error('这台 Worker 还没有「列出云端命名空间」的能力，更新 Worker 之后清单会更全。');
    }
    const response = await fetchWithAuth('client-state/namespaces', config, {
      method: 'GET',
      headers: {
        'X-Response-Encrypted': 'true',
        'X-Encryption-Version': '1',
      },
    }, '读取云端命名空间清单');
    if (!response?.success) {
      throw new Error(response?.error?.message || '读取云端命名空间清单失败。');
    }
    const payload = await decryptPayload(client, response.data) as {
      namespaces?: Array<{ namespace?: unknown; entryCount?: unknown; byteSize?: unknown; updatedAt?: unknown }>;
    };
    return (payload?.namespaces ?? [])
      .filter((row): row is { namespace: string } & Record<string, unknown> => typeof row?.namespace === 'string' && !!row.namespace)
      .map((row) => ({
        namespace: row.namespace,
        entryCount: Number(row.entryCount ?? 0) || 0,
        byteSize: Number(row.byteSize ?? 0) || 0,
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : null,
      }));
  },

  /**
   * 列出云端登记着哪些凭据行。上游只回 credId 和更新时间，**不回凭据本体**。
   *
   * credId 的形状是 `char:<charId>/<用途>`，角色身份就编在这个字符串里——所以这是眼下
   * 唯一一个「不靠本地记录，直接问云端还记着哪些角色」的口子。任务表那边角色 id 埋在
   * 密文里，要把全部任务拉回来逐条解密才看得见；client_state 则要等用户那台 worker
   * 更新到带命名空间清单的那一版。
   */
  async listLlmCredentials(): Promise<Array<{ credId: string; updatedAt?: number }>> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const response = await client.listLlmCredentials();
    if (!response?.success) {
      throw new Error(response?.error?.message || '读取云端凭据清单失败。');
    }
    const rows = (response.data as { credentials?: Array<{ credId?: unknown; updatedAt?: unknown }> })?.credentials ?? [];
    return rows
      .filter((row): row is { credId: string; updatedAt?: number } => typeof row?.credId === 'string' && !!row.credId)
      .map((row) => ({ credId: row.credId, updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : undefined }));
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
  async probeWorkerVersion(options?: { timeoutMs?: number }): Promise<AmsgWorkerVersionProbe> {
    const expected = AMSG_BUNDLE_VERSION;
    // timeoutMs：发消息路上现探时用的护栏（见 resolveInstantChatReadiness 的 ensureBundleVersion），
    // 超时按 unknown 处理。设置页那次不传。
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = await ensureWorkerReady();
      const init: RequestInit = { method: 'GET' };
      const timeoutMs = options?.timeoutMs;
      if (typeof timeoutMs === 'number' && timeoutMs > 0 && typeof AbortController !== 'undefined') {
        const controller = new AbortController();
        init.signal = controller.signal;
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }
      const { status, body } = await fetchWithAuthRaw('config-check', config, init, '后端版本探测');
      if (status !== 200 || body?.success !== true) return { state: 'unknown', deployed: null, expected, autoUpdate: null };
      await rememberWorkerBundleVersion(body);
      const deployed = typeof body?.data?.workerVersion === 'string' ? body.data.workerVersion : null;
      const autoUpdate = parseSelfUpdateReport(body?.data?.selfUpdate);
      if (!deployed) return { state: 'outdated', deployed: null, expected, autoUpdate };
      return { state: deployed === expected ? 'current' : 'outdated', deployed, expected, autoUpdate };
    } catch {
      return { state: 'unknown', deployed: null, expected, autoUpdate: null };
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  /**
   * 让后端自己看一眼该不该更新（`POST /self-update/check`，见 worker/amsg/src/autoUpdate.ts）。
   *
   * App 冷启动时顺手发的（见 utils/amsgAutoUpdateTrigger.ts：版本对不上时走的是 selfUpdateWorker，
   * 这条只在版本对得上、想让它按指纹再看一眼时用）。只是按一下门铃——worker 回 202 就走人，检查在它那边后台跑，节流也在它那边；结果记进
   * 它的诊断表，设置页从 probeWorkerVersion 的 autoUpdate 里读。
   *
   *   - 'accepted'：worker 收下了（真查不查看它自己的节流）；
   *   - 'unsupported'：旧版 worker 没这条路（404），或没配 CF_API_TOKEN、没设共享密钥；
   *   - 'failed'：没连上或别的错。
   */
  async requestWorkerUpdateCheck(): Promise<'accepted' | 'unsupported' | 'failed'> {
    try {
      const config = await ensureWorkerReady();
      const { status, body } = await fetchWithAuthRaw('self-update/check', config, { method: 'POST' }, '后端更新检查');
      if (status === 202 && body?.success === true) return 'accepted';
      if (status === 404 || body?.error?.code === 'NOT_FOUND') return 'unsupported';
      const code = body?.error?.code;
      if (code === 'CF_TOKEN_MISSING' || code === 'SERVER_TOKEN_REQUIRED') return 'unsupported';
      return 'failed';
    } catch {
      return 'failed';
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
      // 地址没变、bundle 换了，而「认不认识后台任务」这个结论是按地址缓存的。不作废的话
      // 用户刚把后端升上去，接下来这几分钟每一轮消化还是照着升级前那句「不支持」在前台
      // 跑那一两分钟的整理，页面一关就死。
      forgetBackgroundJobProbe();
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

  /**
   * 问一下这台 Worker 的定时触发（cron trigger）现在开着没有。
   *
   * 回 null 表示问不到：旧版 Worker 没有这个端点（404）、没填地址、或者这一次没连上。
   * 三种都按「不支持」处理——设置页不显示那个按钮，也不报错。
   */
  async getCronTriggerState(): Promise<AmsgCronTriggerState | null> {
    try {
      const config = await ensureWorkerReady();
      const { status, body } = await fetchWithAuthRaw('cron-trigger', config, { method: 'GET' }, '后台任务状态');
      // 旧 worker 没有这个端点：可能回 404，也可能被上游当成未知路由回一段自己的 JSON。
      if (status === 404 || body?.error?.code === 'NOT_FOUND') return null;
      if (status === 200 && body?.success === true) {
        const data = body.data ?? {};
        if (data.supported === true && typeof data.enabled === 'boolean') {
          return { supported: true, enabled: data.enabled };
        }
        return {
          supported: false,
          code: typeof data.code === 'string' ? data.code : undefined,
          message: typeof data.message === 'string' ? data.message : undefined,
        };
      }
      return {
        supported: false,
        code: typeof body?.error?.code === 'string' ? body.error.code : undefined,
        message: body?.error?.message || `HTTP ${status}`,
      };
    } catch {
      return null;
    }
  },

  /**
   * 暂停（false）或恢复（true）后台任务：让 Worker 摘掉或加回自己的 cron trigger。
   *
   * 暂停期间到点的任务在 D1 里排着，一条都不丢；恢复后的第一跳一起补发。
   * 成功和失败都带一句能直接显示的话；code 是 worker 报的代号，缺 CF_API_TOKEN 时
   * 面板据此露出补钥匙那一块。网络层面的失败照常抛（跟 selfUpdateWorker 一样），调用方兜。
   */
  async setCronTriggerEnabled(enabled: boolean): Promise<{ ok: boolean; message: string; code?: string }> {
    const config = await ensureWorkerReady();
    const { status, body } = await fetchWithAuthRaw(
      'cron-trigger',
      config,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) },
      enabled ? '恢复后台任务' : '暂停后台任务',
    );
    if (status === 404 || body?.error?.code === 'NOT_FOUND') {
      return {
        ok: false,
        message: '这台 Worker 还是旧版本，没有暂停后台任务的能力。先点「更新 Worker」，之后就能在这儿点了。',
      };
    }
    if (status === 200 && body?.success === true) {
      return {
        ok: true,
        message: enabled
          ? '后台任务已恢复，攒下的消息会在下一分钟一起补发。'
          : '后台任务已暂停，到点的消息先攒着，恢复后一起补发。',
      };
    }
    return {
      ok: false,
      message: body?.error?.message || `${enabled ? '恢复' : '暂停'}没成功（HTTP ${status}）。`,
      code: typeof body?.error?.code === 'string' ? body.error.code : undefined,
    };
  },

  async getCapabilities(): Promise<{ serverVersion: string; features: string[] } | null> {
    const globalConfig = await ensureWorkerReady();
    const client = createClient(globalConfig);
    return client.getCapabilities();
  },

  /** 一次管理会话固定连接；界面直接使用上游的完整清单与持久清理操作。 */
  async openCloudDataSession() {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    return createCloudDataSession(client, { workerUrl: config.workerUrl, userId: config.userId }, {
      onRestored: async state => {
        invalidateCloudOwnerWrites(state.owner);
        if (state.owner.type === 'character') (await import('./amsgStateSync')).discardAmsgPendingState(state.owner.id);
        rememberCloudOwnerGeneration(config, state.owner, state.generation);
        forgetAllCredIds();
        invalidateClientCache();
      },
      onCleanupStarted: async operation => {
        forgetAllCredIds();
        if (operation.mode === 'retire-owner' && operation.owner?.type === 'character') {
          invalidateCloudOwnerWrites(operation.owner);
          (await import('./amsgStateSync')).discardAmsgPendingState(operation.owner.id);
        }
      },
    });
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
    /** 全局刷新已读过列表时复用，避免每个角色再读一遍。 */
    remoteTasks?: any[];
  }): Promise<{
    status: 'no-tasks' | 'ok' | 'partial';
    updated: number;
    failed: number;
  }> {
    const aiTaskUuids = params.tasks
      .filter((t) => t.mode !== 'fixed')
      .map((t) => t.taskUuid);
    if (aiTaskUuids.length === 0) return { status: 'no-tasks', updated: 0, failed: 0 };

    const inlineUpdates = resolveTaskCredentialUpdates(params.char, params.config, params.apiConfig);
    const remoteTasks = params.remoteTasks ?? await this.listAllTasks();
    const remoteByUuid = new Map(remoteTasks.map((task) => [task.uuid, task]));
    const credRow = buildCharChatCredRow(params.char, params.config, params.apiConfig)!;
    // 引用任务不能写内联凭据；先确保主 API 行存在，再改 chat 引用。其它 purpose 原样保留。
    if (aiTaskUuids.some((uuid) => remoteByUuid.get(uuid)?.credRefs?.chat)) {
      await this.putLlmCredentials([credRow]);
    }
    let updated = 0;
    let failed = 0;
    for (const uuid of aiTaskUuids) {
      const refs = remoteByUuid.get(uuid)?.credRefs;
      const updates = refs?.chat
        ? { credRefs: { ...refs, chat: credRow.credId } }
        : inlineUpdates;
      const result = await this.updatePendingTasksRemote([uuid], updates);
      updated += result.updated;
      failed += result.failed.length;
    }
    return { status: failed ? 'partial' : 'ok', updated, failed };
  },

  /**
   * 主 API 变更 / 启动时同步存量任务。远端列表补齐关闭页面期间角色自己排的任务；
   * 即时对话和后台作业各有自己的凭据生命周期，不在这里改它们的请求终值。
   */
  async refreshApiCredentialsForPendingTasks(apiConfig: APIConfig): Promise<{
    status: 'no-tasks' | 'ok' | 'partial';
    updated: number;
    failed: number;
  }> {
    const characters = (await DB.getAllCharacters()).filter(isAmsg2EnabledForChar);
    if (!characters.length) return { status: 'no-tasks', updated: 0, failed: 0 };
    const remoteTasks = await this.listAllTasks();
    let updated = 0;
    let failed = 0;
    let hasTasks = false;
    for (const char of characters) {
      const tasksByUuid = new Map(getPendingTasks(char.activeMsg2Config, Date.now())
        .filter((task) => task.mode !== 'fixed').map((task) => [task.taskUuid, task]));
      for (const remote of remoteTasks) {
        if (remote.charId !== char.id || remote.status !== 'pending') continue;
        if (remote.messageType !== 'auto' && remote.messageType !== 'prompted') continue;
        if (remote.messageSubtype === AMSG_INSTANT_CHAT_SUBTYPE) {
          // 上游自排会继承父任务的 subtype。只看标签会漏掉从即时对话排出的子任务；
          // 读 metadata 确认是自排任务，不能改用户正在等待的那一轮即时回复。
          try {
            const globalConfig = await ensureWorkerReady();
            const response = await fetchWithAuth(`message?id=${encodeURIComponent(remote.uuid)}`, globalConfig, {
              method: 'GET',
              headers: { 'X-Response-Encrypted': 'true', 'X-Encryption-Version': '1' },
            }, '查询任务凭据');
            if (!response?.success) {
              const code = response?.error?.code;
              if (code === 'TASK_NOT_FOUND' || code === 'TASK_ALREADY_COMPLETED') continue;
              throw new Error(response?.error?.message || '读取任务失败');
            }
            const client = await initializeClient(globalConfig);
            const metadata = (await decryptPayload(client, response.data))?.task?.metadata;
            if (metadata?.amsgInstantChat || metadata?.amsgSelfScheduled !== true) continue;
          } catch {
            failed += 1;
            continue;
          }
        } else if (remote.messageSubtype && remote.messageSubtype !== 'chat') continue;
        tasksByUuid.set(remote.uuid, { taskUuid: remote.uuid, mode: remote.messageType } as ActiveMsg2TaskRecord);
      }
      const tasks = [...tasksByUuid.values()];
      if (!tasks.length) continue;
      hasTasks = true;
      try {
        const result = await this.refreshCharPendingAiTaskCredentials({
          char, config: char.activeMsg2Config!, apiConfig, tasks, remoteTasks,
        });
        updated += result.updated;
        failed += result.failed;
      } catch (error) {
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 任务凭据同步失败，下次重试`, char.id, error);
        failed += tasks.length;
      }
    }
    return { status: failed ? 'partial' : hasTasks ? 'ok' : 'no-tasks', updated, failed };
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
  /** SDK 校验任务/轮次绑定并定点读取；读取不删除，重试与别的设备仍能消费。 */
  async readAttachment(ref: { version: 1; namespace: string; key: string; taskUuid: string; occurrenceMs: number; expiresAt: number }): Promise<string | null> {
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    return client.getAttachment(ref);
  },

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
    return (await this.readPanelStatus(charId)).lastSkip;
  },

  /**
   * 面板上那两句「近况」一次读齐：最近一次为什么没响（last_skip）、今天主动找了几次
   * （daily_sends）。两份住在同一个角色命名空间里，读一次整个命名空间就都有了——分两次
   * 读的话每次都要把几十 KB 的 fire_pack 一起拉下来解密。读失败两样都按「没有」处理：
   * 这是锦上添花的说明，不该让面板打不开。
   */
  async readPanelStatus(charId: string): Promise<{
    lastSkip: AmsgLastSkip | null;
    dailySends: AmsgDailySends | null;
  }> {
    try {
      const config = await ensureWorkerReady();
      const client = await initializeClient(config);
      const response = await client.getClientState(amsgStateNamespace(charId));
      if (!response?.success) return { lastSkip: null, dailySends: null };
      const entries = (response.data?.entries ?? []) as Array<{ key: string; value: string }>;
      const valueOf = (key: string) => entries.find((e) => e?.key === key)?.value || null;
      const skipValue = valueOf(AMSG_LAST_SKIP_KEY);
      return {
        lastSkip: skipValue ? parseLastSkip(skipValue) : null,
        dailySends: parseDailySends(valueOf(AMSG_DAILY_SENDS_KEY)),
      };
    } catch {
      return { lastSkip: null, dailySends: null };
    }
  },

  /**
   * 把这个角色的「频率与额度」单独传上去（面板保存、关掉 2.0 时用）。
   *
   * 不等下一次 fire_pack 同步：那一份要「有待发任务、聊完一轮」才重传，用户改的上限会
   * 迟迟不生效。失败照抛，让面板告诉用户没同步上。
   */
  async putCharLimits(char: CharacterProfile): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    await putClientStateOrThrow(client, [buildLimitsEntry(char, stampStateUpdatedAt())], '同步主动频率设置');
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
      [{ namespace, key, value, updatedAt: stampStateUpdatedAt() }],
      '写入云端状态',
    );
  },

  /**
   * 取回落库后把云端那一行清掉，腾回 D1 空间。按 worker 的能力位分两条路：
   *   - worker 认删行（isClientStateDeleteReady）：发 `value: null`，整行连大值的切片
   *     一起删掉。即时对话每轮的旁路键都是新的（`reasoning:<uuid>` 这类），只有真删
   *     才不会让角色的命名空间只涨不跌——worker 每次生成都要把它整个读一遍；
   *   - 老 worker（没探到、或探到不认）：写空串，留一个几字节的空壳，内容本身没了。
   *     null 发到老 worker 上会被当无效条目拒掉、内容原封不动，所以不认就不发。
   * 历史积累的空壳由 syncCharFirePacks 末尾的存量清理扫掉。
   */
  async clearClientStateValue(namespace: string, key: string): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const value = (await isClientStateDeleteReady()) ? null : '';
    await putCloudClientState(client, [{ namespace, key, value, updatedAt: stampStateUpdatedAt() }]);
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
   *
   * `restoreToolConfig: false` 用在「重置全部数据」那条路上：那时用户要的是一切归零，
   * 本地紧接着就要删库，补传只会在刚清空的库里重新留下一行谁也不会再读的凭据。
   */
  async clearClientState(
    realtimeConfig: RealtimeConfig | undefined,
    options: { restoreToolConfig?: boolean } = {},
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
    if (options.restoreToolConfig === false) return { deleted, toolConfigRestored: false };

    let toolConfigRestored = true;
    try {
      const authed = await initializeClient(config);
      await putClientStateOrThrow(
        authed,
        [buildToolConfigEntry(realtimeConfig, stampStateUpdatedAt())],
        '重新上传工具凭据',
      );
    } catch (error) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 清空后补传工具凭据失败`, error);
      toolConfigRestored = false;
    }
    return { deleted, toolConfigRestored };
  },
};
