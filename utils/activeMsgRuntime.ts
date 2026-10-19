import { createReplyRun, isReplyStopped, withReplyCancellation, type ReplyRun } from './chatReplyCancellation';
import { loadCharacterContextMessages } from './chatContextRange';
import { ActiveMsg2InboxMessage, ActiveMsg2TaskRecord, APIConfig, RealtimeConfig, UserProfile } from '../types';
import { DB } from './db';
import { ChatPrompts } from './chatPrompts';
import { ActiveMsgStore } from './activeMsgStore';
import { ActiveMsgClient, type AmsgOutboxEntry, type RemoteTaskStatus } from './activeMsgClient';
import { AMSG_CHAT_FAIL_KEY, amsgStateNamespace, parseChatFailRecord } from './amsgFirePack';
import {
  applyAssistantPostProcessing,
  type PostProcessDirective,
  type XhsCaches,
} from './applyAssistantPostProcessing';
import { drainPendingDiaries } from './pendingDiary';
import { applyEmotionEvalRaw } from './emotionApply';
import { CHAT_GEN_EVENTS, announceChatGen, announceEmotionDone } from './chatGenEvents';
import { processNewMessagesWithAutoArchive } from './memoryPalace/autoArchive';
import { loadMusicHooks } from '../context/MusicContext';
import type { XhsNote } from './realtimeContext';
import { appendDevDebugLog, makeDebugLogger } from './devDebug';
import {
  AMSG_INSTANT_CHAT_PENDING_EVENT,
  INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS,
  clearInstantChatPending,
  drainOutbox,
  failInstantChatPending,
  getInstantChatPending,
  listInstantChatPendings,
  settleInstantChatApiLog,
  settleInstantChatExpiredNotices,
} from './amsgInstantChat';
import { dispatchAmsgResult } from './amsgResults';
import { requestStartupUpdateCheck } from './amsgAutoUpdateTrigger';
import { flushAmsgState } from './amsgStateSync';
import { describeInstantChatFailure, pruneStaleTasks, type RemoteTaskLastError } from './amsg2Tasks';
// 线协议常量的唯一出处是 shared（amsg-sw 只是 re-export 同一份）。
import { MULTIPART_FAILURE_REASON } from '@rei-standard/amsg-shared';
import { appendInstantTraceEntry } from './instantTraceLog';
import { captureSwRegistrationSnapshot, probeSwChannel } from './swChannelProbe';
import { trackEvent } from './analytics';
import {
  readAmsgSarSurface,
  resolveAmsgSarSnapshot,
  resolveAmsgSarSurface,
  settleSarModuleAfterCloudReply,
  stripAmsgSarTransportKeys,
} from './sarModuleCloudSettle';

// 同一个 category，两个 tag——保持 console 里现有的 [ActiveMsg] / [amsg] 标签，
// 方便用户 / 文档里 grep 历史报错信息。两条 tag 都归 amsg 一类。
const log = makeDebugLogger('amsg', 'ActiveMsg');
const logAmsg = makeDebugLogger('amsg', 'amsg');

let initialized = false;

// 三写：console.info + 无条件 localStorage ring（instantTraceLog，远端排障事后导出用）
// + 用户勾控的 devDebug。
function activeMsgTrace(event: string, details: Record<string, unknown> = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    sessionId: typeof details.sessionId === 'string' ? details.sessionId : undefined,
    event,
    visibility: typeof document !== 'undefined' ? document.visibilityState : 'n/a',
    online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
    ...details,
  };
  try {
    console.info('[InstantTrace]', entry);
  } catch { /* ignore */ }
  appendInstantTraceEntry(entry);
  // 也挂进 devDebug 的 amsg 类目：勾了之后 trace 跟其它主动消息日志一起被
  // 复制 / 下载导出。gate 由 isCaptureEnabled('amsg') 自动管，未勾时零成本。
  appendDevDebugLog('amsg', { label: `trace:${event}`, data: entry });
}

// ─── push 路径模块级 XHS 共享状态 ─────────────────────────────────────────────
//
// 本地 fetch 路径 useChatAI 用 useRef 持有 5 个 cache Map + 单次调用闭包的 lastXhsNotesRef.
// 生命周期 = useChatAI mount 期间 (刷页面 / 切角色 = 清). 跨多次 send / 跨工具调用都共享.
//
// push 路径在 React 之外跑 (SW postMessage → activeMsgRuntime 监听器), 没 useRef.
// 改成模块级单例: 跟本地路径"应用打开期间共享, 刷页面就清"行为字节级对齐.
//
// 笔记列表来自 worker 随 push 捎回的 metadata.xhsSession（落库后在冲刷时读回这里），
// applyAssistantPostProcessing 重放 [[XHS_SHARE: 序号]] 等标签时读同一份 ref.
//
// 主进程刷新 / 浏览器关闭 → 清空, 跟本地路径 useChatAI 重 mount 清 useRef 等价.
// 不写 IndexedDB — 行为与本地路径对齐, 不引入持久化代价.
export const pushXhsCaches: XhsCaches = {
  xsecTokenCache: new Map(),
  noteTitleCache: new Map(),
  commentUserIdCache: new Map(),
  commentAuthorNameCache: new Map(),
  commentParentIdCache: new Map(),
};
export const pushLastXhsNotesRef: { current: XhsNote[] } = { current: [] };

type MemoryPalaceGlobalConfig = {
  embedding: { baseUrl: string; apiKey: string; model: string; dimensions: number };
  lightLLM: { baseUrl: string; apiKey: string; model: string };
};

/** 从 localStorage 读 memoryPalaceConfig — OSContext 同步存的是 os_memory_palace_config key */
const loadMemoryPalaceConfigFromLocalStorage = (): MemoryPalaceGlobalConfig | undefined => {
  try {
    const raw = localStorage.getItem('os_memory_palace_config');
    if (!raw) return undefined;
    return JSON.parse(raw) as MemoryPalaceGlobalConfig;
  } catch {
    return undefined;
  }
};

/** 从 localStorage 读 APIConfig (与 OSContext load 逻辑保持一致, 但这里在 React 之外跑) */
const loadApiConfigFromLocalStorage = (): APIConfig => {
  const fallback: APIConfig = { baseUrl: '', apiKey: '', model: '' };
  try {
    const raw = localStorage.getItem('os_api_config');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      baseUrl: parsed.baseUrl || '',
      apiKey: parsed.apiKey || '',
      model: parsed.model || '',
      ...parsed,
    };
  } catch {
    return fallback;
  }
};

/** 从 localStorage 读 RealtimeConfig — 整个 push 路径里我们不会再回连 LLM, 但 ChatParser
 *  及 DIARY 写入(可执行的副作用)需要这些配置, 缺失时返回 undefined 让消费方走 fallback。 */
const loadRealtimeConfigFromLocalStorage = (): RealtimeConfig | undefined => {
  const raw = (() => {
    try {
      return localStorage.getItem('os_realtime_config');
    } catch {
      // 隐私模式 / 存储被禁：跟「没配过」同样处理，但值得留一行。
      console.warn('[amsg2] 读不到 os_realtime_config（存储不可用），按没配过处理');
      return null;
    }
  })();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as RealtimeConfig;
  } catch {
    // 「没配过」和「配过但存坏了」都会走到 undefined，而后者会让这一轮打脏上传的
    // fire_pack 少掉整块实时内容（天气 / 热搜 / 节日），把云端那份好的盖掉。行为上
    // 仍按没配过走——现场没有别的东西可用——但必须留痕，否则用户只会看到「主动消息
    // 里怎么不提天气了」而查无可查。
    console.warn('[amsg2] os_realtime_config 存的内容解析不了，这一轮按没配过处理');
    return undefined;
  }
};

/**
 * 用 applyAssistantPostProcessing 把 push 收到的 inbox message 走一遍 13 步管线。
 * skipSecondPassLLM=true: 不回连 LLM (worker 现在还没续跑能力, Phase 2 才解决),
 * 二轮标签 (RECALL / SEARCH / READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*) 留在
 * 原文里, 由 ChatParser.sanitize 等步骤兜底剥掉。
 * 副作用类标签 (POKE / TRANSFER / ADD_EVENT / schedule_message / 写日记) 仍会执行。
 * 失败时抛出, 由调用方决定是否重新入队。
 */
/**
 * 已经取回来、等这条消息真处理完了才能删的一份云端旁路副本。
 *
 * 取回就删是不行的：落库半路失败会把这条消息压回收件箱重试，而重试那一趟去读同一个键
 * 已经是空的——心象卡片、小红书卡片数据这一轮就永久没了，用户侧还看不到任何报错
 * （回复照常上屏，只是少了东西）。删只是让 D1 干净一点（键每任务固定、下次触发直接
 * 覆盖），值不上这个代价。
 */
type OffloadedCleanup = { namespace: string; ref: string; what: string };

/**
 * 这条消息处理成功之后，把它取用过的那几份云端旁路副本删掉。
 * 尽力而为：删不掉只 warn（下次触发会覆盖，不影响正确性）。
 */
const runOffloadedCleanups = async (cleanups: OffloadedCleanup[]): Promise<void> => {
  for (const { namespace, ref, what } of cleanups) {
    try {
      await ActiveMsgClient.clearClientStateValue(namespace, ref);
    } catch (error) {
      log.warn(`清空旁路存储的${what}失败（下次触发会覆盖，不影响正确性）`, { ref, error });
    }
  }
};

/**
 * 取回 worker 旁路存下的 XHS 会话数据（push 装不下时才有，见 offloadOversizedPush）。
 * 云端那份不在这里删，登记进 cleanups、等整条消息处理成功后再删（见 OffloadedCleanup）。
 *
 * 取不回来就抛错：调用方会把这条消息压回收件箱重试，而不是发一条「说分享了却没有卡片」
 * 的消息出去。
 */
const fetchOffloadedXhsSession = async (
  message: ActiveMsg2InboxMessage,
  cleanups: OffloadedCleanup[],
): Promise<any | null> => {
  const attachment = (message.metadata as any)?.xhsSessionAttachment;
  if (attachment && typeof attachment === 'object') {
    const raw = await ActiveMsgClient.readAttachment(attachment);
    if (raw == null) throw new Error('XHS attachment is unavailable or expired');
    return JSON.parse(raw);
  }
  const ref = (message.metadata as any)?.xhsSessionRef;
  if (typeof ref !== 'string' || !ref) return null;

  const namespace = amsgStateNamespace(message.charId);
  const raw = await ActiveMsgClient.readClientStateValue(namespace, ref);
  if (raw == null) {
    // 键不在了：同任务的下一次触发已经把它覆盖/清掉了，这条 push 是迟到的老消息。
    // 重试也取不回来，按「没有卡片数据」继续——比卡在收件箱里反复重试强。
    log.warn('旁路存储里没有这份 XHS 会话数据（多半被下一次触发覆盖了）', { ref, charId: message.charId });
    return null;
  }

  const parsed = JSON.parse(raw);
  cleanups.push({ namespace, ref, what: 'XHS 会话数据' });
  return parsed;
};

/**
 * 取回 worker 旁路存下的一段附赠内容（情绪评估原文 / 思考链——它俩撑爆一条 push 时
 * worker 会整段挪进 client_state、只在 metadata 留个引用键，见 worker 的
 * offloadOversizedPush）。云端那份登记进 cleanups，等整条消息处理成功后再删
 * （见 OffloadedCleanup）。
 *
 * 取不回来只返回 null、**不抛错**：这条消息本身（角色说的那句话）已经完整送到了，
 * 为了一次情绪更新 / 一张心象卡片把它压回收件箱反复重试，用户看到的是回复迟迟不上屏。
 *
 * XHS 那份不走这里：卡片数据缺了角色的话就和内容对不上，得抛错重试，见
 * fetchOffloadedXhsSession。
 */
const fetchOffloadedExtra = async (
  message: ActiveMsg2InboxMessage,
  /** metadata 上的引用键字段名。 */
  refField: 'amsgEmotionRef' | 'amsgReasoningRef' | 'amsgSarRef' | 'amsgSarSurfaceRef' | 'amsgSarUserSurfaceRef',
  /** 日志里怎么称呼它 + 取不到时这一轮少了什么。 */
  labels: { what: string; whenMissing: string },
  /** 取回成功时把「这份云端副本可以删了」登记进来，由调用方在处理成功后统一删。 */
  cleanups: OffloadedCleanup[],
): Promise<string | null> => {
  const attachment = (message.metadata as any)?.[refField.replace(/Ref$/, 'Attachment')];
  if (attachment && typeof attachment === 'object') {
    try { return await ActiveMsgClient.readAttachment(attachment); }
    catch (error) { log.warn(`取附件中的${labels.what}失败（${labels.whenMissing}）`, { error }); return null; }
  }
  const ref = (message.metadata as any)?.[refField];
  if (typeof ref !== 'string' || !ref) return null;

  const namespace = amsgStateNamespace(message.charId);
  try {
    const raw = await ActiveMsgClient.readClientStateValue(namespace, ref);
    if (raw == null) {
      // 键不在了：同角色的下一轮已经把它覆盖/清掉了，这条是迟到的老消息。
      log.warn(`旁路存储里没有这份${labels.what}（多半被下一轮覆盖了）`, { ref, charId: message.charId });
      return null;
    }
    cleanups.push({ namespace, ref, what: labels.what });
    return raw;
  } catch (error) {
    log.warn(`取旁路存储的${labels.what}失败（${labels.whenMissing}）`, { ref, error });
    return null;
  }
};

const fetchOffloadedEmotionUpdate = (
  message: ActiveMsg2InboxMessage,
  cleanups: OffloadedCleanup[],
) => fetchOffloadedExtra(message, 'amsgEmotionRef', {
  what: '情绪评估', whenMissing: '这一轮情绪不更新，回复照常',
}, cleanups);

const fetchOffloadedReasoning = (
  message: ActiveMsg2InboxMessage,
  cleanups: OffloadedCleanup[],
) => fetchOffloadedExtra(message, 'amsgReasoningRef', {
  what: '思考链', whenMissing: '这条没有心象卡片，回复照常',
}, cleanups);

/**
 * 云端跑出来的一份评估原文 → 落 buff + 把 innerState 广播给下一轮。
 *
 * 两种形态共用这一处：单独一条 emotion_update 消息（metadata.emotionRaw），或挂在
 * 即时对话最后一条回复的 metadata.amsgEmotionUpdate 上。
 * 解析只认 applyEmotionEvalRaw 这一套（与本地评估路径同一份），别在任何一侧另写一个。
 */
const landCloudEmotionResult = async (charId: string, raw: string): Promise<void> => {
  try {
    const chars = await DB.getAllCharacters();
    const ch = chars.find((c) => c.id === charId);
    if (!ch) return;
    const innerState = await applyEmotionEvalRaw(raw, ch);
    if (innerState) {
      window.dispatchEvent(new CustomEvent('emotion-innerstate-updated', {
        detail: { charId, innerState },
      }));
    }
  } catch (e) {
    console.warn('[flush:emotion_update] apply failed', e);
  }
};

// ─── 情绪评估晚投的补落轮询 ───
// worker 那头评估没赶上回复的顺风车（push 上是 amsgEmotionRef + amsgEmotionPending），
// 结果要等 worker 收尾时才写进旁路存储。这里对着引用键每隔一跳读一次，读到就走
// landCloudEmotionResult 落 buff（与正常路径同一份解析）、熄灯、删云端副本；跳数用尽
// 还没等到才按失败收尾——评估自身在 worker 有 120s 超时，这个窗口盖住它再留余量。
// 每角色最多一个在跑；新一轮的情绪结论到达时旧轮询作废（旧结果落下去会盖掉新 buff）。
const LATE_EMOTION_POLL_INTERVAL_MS = 20_000;
const LATE_EMOTION_POLL_MAX_TRIES = 8;
// value 是各轮询独有的会话对象：tick 的 await 期间被 cancel / 被新一轮顶替时，
// 比对引用就能发现自己已经不是当前那一轮，静默退场。
const lateEmotionPolls = new Map<string, { timer: ReturnType<typeof setTimeout> }>();

export const cancelLateEmotionPoll = (charId: string): void => {
  const entry = lateEmotionPolls.get(charId);
  if (entry) {
    clearTimeout(entry.timer);
    lateEmotionPolls.delete(charId);
  }
};

/** 晚投情绪的补落轮询。intervalMs / maxTries 仅供测试收窄，生产调用不传。 */
export const startLateEmotionPoll = (
  charId: string,
  ref: string,
  charName: string,
  opts?: { intervalMs?: number; maxTries?: number; taskUuid?: string | null },
): void => {
  const intervalMs = opts?.intervalMs ?? LATE_EMOTION_POLL_INTERVAL_MS;
  const maxTries = opts?.maxTries ?? LATE_EMOTION_POLL_MAX_TRIES;
  cancelLateEmotionPoll(charId);
  const namespace = amsgStateNamespace(charId);
  const entry = { timer: undefined as unknown as ReturnType<typeof setTimeout> };
  let tries = 0;
  const tick = async (): Promise<void> => {
    tries += 1;
    let raw: string | null = null;
    try {
      raw = await ActiveMsgClient.readClientStateValue(namespace, ref);
    } catch (error) {
      // 读失败当「还没到」：网络抖一下不该终结这轮补落。
      logAmsg.warn('晚投情绪补落这一跳没读到（下一跳再试）', { charId, ref, error });
    }
    // await 期间被 cancel / 被新一轮顶替 → 静默退场，别把旧结果落到新 buff 上。
    if (isReplyStopped(opts?.taskUuid)) { cancelLateEmotionPoll(charId); return; }
    if (lateEmotionPolls.get(charId) !== entry) return;
    if (raw) {
      lateEmotionPolls.delete(charId);
      await landCloudEmotionResult(charId, raw);
      announceEmotionDone(charId);
      activeMsgTrace('runtime-late-emotion-landed', { charId, tries });
      // 用完即删（同旁路取回的口径）；删不掉下次触发会覆盖，只 warn。
      try {
        await ActiveMsgClient.clearClientStateValue(namespace, ref);
      } catch (error) {
        logAmsg.warn('晚投情绪副本清理失败（下次触发会覆盖）', { charId, ref, error });
      }
      return;
    }
    if (tries >= maxTries) {
      lateEmotionPolls.delete(charId);
      announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
        charId, charName,
        reason: '云端情绪评估最终没等到（副 API 太慢或报错），这一轮不更新',
      });
      announceEmotionDone(charId);
      return;
    }
    entry.timer = setTimeout(() => { void tick(); }, intervalMs);
  };
  // 首跳也等一个间隔：push 刚到那一刻 worker 多半还没写完旁路，立刻读必空。
  entry.timer = setTimeout(() => { void tick(); }, intervalMs);
  lateEmotionPolls.set(charId, entry);
};

/**
 * SW 转来的 error push（即时对话终态失败的直发告知）→ 当场收尾那一轮：落系统消息、
 * 熄灯、销账。与 60s 点名兜底殊途同归——failInstantChatPending 认 uuid，谁先到谁收尾，
 * 晚到的一方对不上账直接走人，不会重复落说明。失败文案与点名路径同一份翻译
 * （describeInstantChatFailure），两条路对用户说同样的话。export 只为单测。
 */
export const handleInstantErrorPushMessage = async (data: unknown): Promise<void> => {
  const meta = (data as { metadata?: Record<string, unknown> } | null)?.metadata;
  const charId = typeof meta?.charId === 'string' && meta.charId ? meta.charId : null;
  const taskUuid = typeof meta?.taskUuid === 'string' && meta.taskUuid ? meta.taskUuid : null;
  // 不是即时对话的失败告知（缺这两个字段）→ 不归这里管
  if (!charId || !taskUuid) return;
  const reason = typeof meta?.reason === 'string' && meta.reason ? meta.reason : null;
  // worker 挂在 push 上的稳定 code（老 worker 没这个字段 → 走通用文案）。带上它，
  // 秒级到达的这条直发告知才和 60s 点名那条说同一句话。
  const errorCode = typeof meta?.errorCode === 'string' && meta.errorCode ? meta.errorCode : undefined;
  const described = reason
    ? describeInstantChatFailure({ reason, ...(errorCode ? { errorCode } : {}) })
    : null;
  await failInstantChatPending(charId, taskUuid, described ?? undefined);
};

/**
 * 分片消息拼不起来时给用户的那句话。
 *
 * 一条推送装不下的内容（长回复、推理模型的思考过程）会被切成分片逐条发出，SW 收齐
 * 还原。`reason` 说的是这一条为什么废了（amsg-sw 2.4.0-next.4 起带；见 shared 的
 * `MULTIPART_FAILURE_REASON`），值得分开说：
 *
 *   - 等超时是**最常见也最无害**的一种——分片在路上、设备刚好离线了，跟用户说
 *     「没等齐」就够，他重开一下多半就好；
 *   - 其余几种（分片对不上、超出本地限额、拼不回来、存储写不进去、本地把分片关了）
 *     说明发送端或链路真出了问题，重开没用，得让用户知道这不是网络抖一下。
 *
 * export 只为单测。
 */
export const describeMultipartFailure = (reason: unknown): string => {
  if (reason === MULTIPART_FAILURE_REASON.TTL_EXPIRED) {
    return '有一条消息没接收完整（分片没在时限内到齐），重开一下试试';
  }
  if (reason === MULTIPART_FAILURE_REASON.STORAGE_FAILED) {
    return '有一条消息没接收完整：本机存储写不进去，清点空间后重试';
  }
  // 剩下的都是「发送端和接收端对不上」这一类，用户自己做不了什么，但要照实说，
  // 别让他以为重开就能好。
  return '有一条消息没接收完整（分片数据有问题），可以让对方重发一次';
};

/**
 * 角色在本地已经不存在了：删角色时远端取消失败留下的残留，或者导入备份之后 id 对不上。
 * 与「暂时读不到」区分开——这种重试多少次都没用，得去把远端那条还在到点跑的任务取消掉。
 */
export class OrphanedCharacterError extends Error {
  constructor(readonly charId: string) {
    super(`character not found for charId=${charId}`);
    this.name = 'OrphanedCharacterError';
  }
}

/** 处理失败重试几次后放弃（放弃 = 退回存原稿保底，见 resolveInboxFailureAction）。 */
export const MAX_INBOX_PROCESS_ATTEMPTS = 3;

export type InboxFailureAction = 'orphan' | 'retry' | 'degrade';

/**
 * 一条 push 处理失败之后该怎么办。
 *
 * 默认是**留着重试**而不是就地存原稿：原稿里的表情 / 卡片 / 转账都还是标记形态，存进
 * 聊天记录后渲染层会把标记剥掉，用户看到的是残缺版，而角色下一轮读历史却会当成
 * 「我已经发过表情、转过账了」——一次暂时的故障就这么变成永久的错误前提。
 * 本地存储的故障通常是暂时的，等一会儿重来一遍就好。
 *
 * 重试到上限还不行，才退回存原稿：那时候多半是真坏了，让用户看到残缺版也好过什么都没有。
 */
export const resolveInboxFailureAction = (
  error: unknown,
  attempts: number,
): InboxFailureAction => {
  if (error instanceof OrphanedCharacterError) return 'orphan';
  return attempts < MAX_INBOX_PROCESS_ATTEMPTS ? 'retry' : 'degrade';
};

/**
 * 已经落库的、属于这条 push 的助手消息。
 *
 * 后处理是逐条落库的（十几处 DB.saveMessage），中途失败时前面几条已经在聊天记录里了。
 * 重试是整条从头再跑，不先把这些清掉就会写重——而重复进了聊天记录是永久的。
 * 认领的依据是每条气泡都继承的 metadata.activeMsg2.messageId（每条 push 唯一，
 * 见 processInboxMessageWithPostProcessing 的 mcdInheritMeta）。
 */
export const findInboxArtifacts = <T extends { role: string; metadata?: any }>(
  messages: T[],
  messageId: string,
): T[] => messages.filter((m) =>
  m.role === 'assistant' && m.metadata?.activeMsg2?.messageId === messageId);

/**
 * 清场时可以删的消息类型——只有「渲染型气泡」：正文、表情包、HTML 卡片。
 *
 * 副作用产物（转账卡 / 戳一戳 / 音乐卡 / 新闻卡 / 日程提示 / 生活卡 / 小红书卡…）一律
 * 留在原地：重试那一趟压根不会再产一遍（副作用要么随 directives 走、本轮不重放，要么像
 * XHS 那样被 disabledXhsSideEffects 关掉），删了就是永久少一张卡——而钱和日程是真的。
 *
 * 白名单制，将来新增的类型默认按「不删」处理：宁可重复一条气泡，也不凭空删掉一张卡。
 */
export const PURGEABLE_ARTIFACT_TYPES: ReadonlySet<string> = new Set(['text', 'emoji', 'html_card']);

/**
 * 把这条 push 上一趟写下的**渲染型气泡**从聊天记录里删掉。
 *
 * 返回两个数，别混为一谈：
 *   - removed：这次真删了几条（只数渲染型气泡）；
 *   - evidence：上一趟到底有没有留下过东西（连副作用产物一起数）。副作用要不要重放看它。
 */
export const purgeInboxArtifacts = async (
  message: ActiveMsg2InboxMessage,
): Promise<{ removed: number; evidence: number }> => {
  const recent = await DB.getRecentMessagesByCharId(message.charId, 200);
  const stale = findInboxArtifacts(recent, message.messageId);
  const purgeable = stale.filter((m) => PURGEABLE_ARTIFACT_TYPES.has(m.type));
  if (purgeable.length > 0) await DB.deleteMessages(purgeable.map((m) => m.id));
  return { removed: purgeable.length, evidence: stale.length };
};

/**
 * 重试前的清场：把上一次跑到一半写进去的气泡删掉，并告诉调用方副作用还要不要重放。
 *
 * 后处理的顺序是「先跑副作用（转账 / 加日程 / 戳一戳 / 排程），再渲染气泡」，
 * 所以**只要看到上一趟留下的任何一条消息，就说明副作用那一步上次已经整段跑完了**。
 * 这时重放等于转两次账、加两次日程，比丢内容严重得多——所以这一趟只补渲染，不带 directives。
 * 一条都没留下才说明上次死在副作用途中，那时 directives 还得照常带上，
 * 否则这条消息的副作用就彻底没了。
 *
 * 「凭据」和「删除对象」是两回事：副作用产物（转账卡等）算凭据但不删——它们跟正文气泡
 * 带着同一个 activeMsg2.messageId，删掉又不重放的话，那张卡就永远回不来了。
 */
const prepareInboxRetry = async (
  message: ActiveMsg2InboxMessage,
): Promise<{ replayDirectives: boolean }> => {
  if (!(message.processAttempts && message.processAttempts > 0)) return { replayDirectives: true };
  const { removed, evidence } = await purgeInboxArtifacts(message);
  if (evidence === 0) return { replayDirectives: true };
  log.warn('重试前清掉上次写了一半的气泡（副作用上次已跑完，本轮不重放，产物留在原地）', {
    messageId: message.messageId,
    removed,
    evidence,
  });
  return { replayDirectives: false };
};

const processInboxMessageWithPostProcessing = async (
  message: ActiveMsg2InboxMessage,
  // 由 flushInboxToChat 按 resolveInboxPersistTimestamp 算好: 离线补收 = sentAt,
  // 在线送达 = undefined (落库走 DB.saveMessage 默认的写库当刻)。
  persistTimestamp?: number,
  replyRun?: ReplyRun,
  skipTypingSignal?: AbortSignal,
): Promise<void> => {
  const replyStep = <T>(operation: () => Promise<T>) => withReplyCancellation(replyRun, operation);
  // 这一趟从云端旁路存储取回来的东西，等整条消息处理成功了再去删（见 OffloadedCleanup）。
  const offloadedCleanups: OffloadedCleanup[] = [];
  const characters = await replyStep(async () => DB.getAllCharacters());
  const char = characters.find(c => c.id === message.charId);
  if (!char) {
    // 一个角色都读不到，多半是本地存储本身出了问题，而不是「这个角色被删了」——
    // 按可重试的普通失败处理，别把还在用的任务当孤儿取消掉。
    if (characters.length === 0) {
      throw new Error(`character lookup returned empty for charId=${message.charId}`);
    }
    throw new OrphanedCharacterError(message.charId);
  }

  // 这是不是一次重试？是的话先清掉上次的半成品，并决定副作用要不要再跑一遍。
  const { replayDirectives } = await replyStep(async () => prepareInboxRetry(message));

  const userProfile: UserProfile = (await replyStep(async () => DB.getUserProfile()))
    ?? { name: 'User', avatar: '', bio: '' };
  // 按角色可见性过滤表情包：后处理落库时靠 emojis.find(e => e.name === name) 反查 URL，
  // 若传全量表情，名字冲突时会把 A 的 [[SEND_EMOJI: x]] 匹配到 B 名下的同名表情，导致
  // A 发出绑定给 B 的表情包。本地聊天路径喂的是 aiVisibleEmojis（已过滤），主动消息路径
  // 之前漏了这步，这里复用同一套过滤收口（与 activeMsgClient.buildCompletePrompt 对齐）。
  const { emojis, categories } = ChatPrompts.filterVisibleEmojis(
    await replyStep(async () => DB.getEmojis()),
    await replyStep(async () => DB.getEmojiCategories()),
    message.charId,
  );
  const contextMsgs = await replyStep(async () => loadCharacterContextMessages(char));

  const apiConfig = loadApiConfigFromLocalStorage();
  const realtimeConfig = loadRealtimeConfigFromLocalStorage();

  // Phase 1: 副作用 (DIARY 写入等) 会调 DB.saveMessage, 它内部已经 fire 'messages-updated' 事件;
  // 但 OSContext 真正驱动 chat UI 重新 reloadMessages 的是 lastMsgTimestamp, 而那个 state 现在
  // 只由 'active-msg-received' handler 改。为了让 push 路径下的 per-chunk 落库也立刻反映到 UI,
  // 用一个独立的 side-channel 事件 'active-msg-progress': OSContext 监听它后只 setLastMsgTimestamp,
  // 不 fire toast / 不增加未读。
  // 单条 inbox message 进来时 fire 一次 'active-msg-received' 即可保证 toast / 未读 / 通知一次发生。
  const dispatchProgress = () => {
    window.dispatchEvent(new CustomEvent('active-msg-progress', {
      detail: { charId: message.charId },
    }));
  };

  // messageIndex 来源: SW 在 saveContentToInbox 把 payload.messageIndex 写到 metadata, 1-based
  // (第 1 条 → messageIndex=1); 没这个字段时 ?? 0 fallback.
  const sessionId: string | undefined = (message as any).sessionId
    || (message.metadata && (message.metadata as any).sessionId);
  const messageIndex: number = (message as any).messageIndex
    ?? (message.metadata && (message.metadata as any).messageIndex)
    ?? 0;
  // 思考链挂在第一条 content push 的 metadata.amsgReasoning 上（太长时挪进 client_state、
  // 只留 amsgReasoningRef，见 worker/amsg/src/index.ts 的 offloadOversizedPush），
  // 只在第一条上取，渲染成第一条 assistant message 的 metadata.thinkingChain。
  // 定时任务由 worker 按 thinkingChainEnabled 决定是否携带；收侧复用同一套落库。
  let reasoningContent: string | undefined;
  if (messageIndex <= 1) {
    const inlineReasoning = (message.metadata as any)?.amsgReasoning;
    const metaReasoning = typeof inlineReasoning === 'string' && inlineReasoning
      ? inlineReasoning
      : await replyStep(async () => fetchOffloadedReasoning(message, offloadedCleanups));
    if (typeof metaReasoning === 'string' && metaReasoning.trim()) {
      reasoningContent = metaReasoning;
    }
  }

  // XHS 工具在 worker 里跑. worker 把 directive 引用到的笔记/xsecToken 随最后一条 push 的
  // metadata.xhsSession 带回来 (稀疏 {idx, note}, idx 1-based, 见 worker/amsg/src/agentic.ts
  // buildXhsSessionPayload), 这里重建成按序号取卡的数组先落库, 下面的恢复块再读回内存单例
  // ——XHS_SHARE / 点赞 / 评论重放才能按序号找到卡片.
  // 装不进一条 push（4KB 密文上限）的时候 worker 会把整份挪进 client_state、只在
  // metadata 留一个 xhsSessionRef 指过来（见 worker/amsg/src/index.ts 的
  // offloadOversizedPush）。这里按键取回，取到就跟内联那份走同一条落库路径。
  // 取不回来时抛错交给上层重试——静默跳过的话，角色说分享了几张、卡片却少几张。
  const xhsSession = (message.metadata && (message.metadata as any).xhsSession)
    || await replyStep(async () => fetchOffloadedXhsSession(message, offloadedCleanups));
  if (sessionId && xhsSession && Array.isArray(xhsSession.notes) && xhsSession.notes.length > 0) {
    try {
      const maxIdx = Math.max(...xhsSession.notes.map((e: any) => Number(e?.idx) || 0));
      const rebuilt: Array<XhsNote | null> = new Array(Math.max(0, maxIdx)).fill(null);
      for (const entry of xhsSession.notes) {
        const i = Number(entry?.idx);
        if (Number.isInteger(i) && i >= 1 && entry?.note) rebuilt[i - 1] = entry.note as XhsNote;
      }
      await replyStep(async () => ActiveMsgStore.saveXhsSessionNotes(sessionId, {
        notes: rebuilt as XhsNote[],
        xsecTokens: Array.isArray(xhsSession.xsecTokens) ? xhsSession.xsecTokens : [],
      }));
    } catch (e) {
      console.warn('[ActiveMsg] persist xhsSession from push failed', sessionId, e);
    }
  }

  // 恢复本 session 工具抓到的 XHS 笔记: 上面落了库, 这里读回内存单例.
  // 跨 SW 唤醒 / 页面回收后内存 ref 被清空, 不恢复的话 [[XHS_SHARE]] / 评论 / 点赞
  // 会因 lastXhsNotesRef 为空而静默掉卡片. 持久化优先于内存 (同 session 时两者等价, 重载后只剩持久化).
  if (sessionId) {
    try {
      const persisted = await replyStep(async () => ActiveMsgStore.getXhsSessionNotes(sessionId));
      if (persisted?.notes?.length) {
        pushLastXhsNotesRef.current = persisted.notes as XhsNote[];
        for (const [noteId, token] of (persisted.xsecTokens || [])) {
          pushXhsCaches.xsecTokenCache.set(noteId, token);
        }
      }
    } catch (e) {
      console.warn('[ActiveMsg] restore xhs session notes failed', sessionId, e);
    }
  }

  // SAR 临时模块生效时，worker 拆完信封把这一段的角色外显随 push 带回来（已按段对齐）；
  // 太大时挪进 client_state、只留 amsgSarSurfaceRef。取回的那份登记进本条的 cleanups，
  // 处理成功后统一删。取不回只 warn、不进重试：外显丢了这一段显示真实回复，可以接受。
  const sarModuleSurface = await replyStep(async () => resolveAmsgSarSurface(
    message.metadata,
    () => fetchOffloadedExtra(message, 'amsgSarSurfaceRef', {
      what: 'SAR 角色外显', whenMissing: '这一段显示真实回复',
    }, offloadedCleanups),
  ));

  await replyStep(async () => applyAssistantPostProcessing(message.body || '', {
    replyRun,
    char,
    userProfile,
    emojis,
    categories,
    realtimeConfig,
    // 日程改动按「角色说这句话的那一刻」判，不是按现在——这条可能在收件箱里躺了一夜，
    // 昨晚的「22:00 改成陪你聊天」不该落到今天的 22:00 上。
    spokenAt: message.sentAt,
    contextMsgs,
    // fullMessages / initialData: worker 不会传过来 (Phase 2 才有续跑), 二轮 LLM 又被关掉,
    // 这两个字段在 skipSecondPassLLM=true 时实际上不会被消费; 给个最小占位避免 undefined NPE。
    fullMessages: [],
    initialData: null,
    historyMsgCount: contextMsgs.length,
    // 把 source / activeMsg2 元数据通过 mcdInheritMeta 继承到每条 assistant message, 这样
    // UI 还能区分 "这条是 push 来的"。
    mcdInheritMeta: {
      source: 'active_msg_2',
      activeMsg2: {
        messageId: message.messageId,
        taskId: message.taskId,
        taskUuid: message.taskUuid,
        messageType: message.messageType,
        messageSubtype: message.messageSubtype,
        avatarUrl: message.avatarUrl,
        sentAt: message.sentAt,
        receivedAt: message.receivedAt,
      },
      // push 自己那份也得铺进去：worker 随这条 push 捎回来、要落到气泡上给用户看的东西
      // （amsgToolTrace 这类）只有这一条路进 metadata，漏了就静默没了。
      // 注意它排在最后，同名字段会盖掉上面那几个固定的——worker 哪天往 push metadata 里
      // 塞了个叫 source / activeMsg2 的字段，重试认领就会跟着歪。
      // SAR 临时模块那几个回程载具键（快照 / 这一段的外显 / USER_SURFACE 原文）剔掉：
      // 外显由下面的 sarModuleSurface 按气泡对齐后写成 metadata.sarModuleSurface，
      // 快照在销账时一次性收尾，都不该永久挂在每个气泡上。
      ...stripAmsgSarTransportKeys(message.metadata),
    },
    xhsCaches: pushXhsCaches,
    lastXhsNotesRef: pushLastXhsNotesRef,
    api: {
      baseUrl: apiConfig.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(apiConfig.apiKey ? { Authorization: `Bearer ${apiConfig.apiKey}` } : {}),
      },
      // effectiveApi 在 push 路径里没人读 — skipSecondPassLLM=true 把所有二轮 LLM 入口都堵了。
      // 留着只为满足 ctx 类型形状; Phase 2 worker 走续跑时也不会让客户端再发 LLM 请求, 所以这里
      // 长期就是个空架子, 不要花精力同步 os_api_presets / os_available_models 等运行时切换。
      effectiveApi: {
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
      },
    },
    hooks: {
      // setMessages 在 React 外面跑, 没法直接 setState, 只 fire 一次 progress 事件让
      // OSContext 推 lastMsgTimestamp, 然后 Chat.tsx 自然 reloadMessages 重新读库。
      setMessages: () => { dispatchProgress(); },
      // push 路径 deliberately 静默 toast — 避免在用户没在 chat 这个角色时狂弹 toast。
      // 如果真要给用户可见反馈, 应该走 'active-msg-received' 那条线 (toast / 未读 / 通知)。
      addToast: (msg: string, type: 'info' | 'success' | 'error') => {
        console.log('[push:toast]', type, msg);
      },
      // 日程改动没落地是个例外：角色的消息里已经写着「那我今晚不睡了」，日程卡却纹丝
      // 不动，用户看到的是两边对不上而没有任何解释。走 active-msg-process-failed——
      // 已有的可见通道，自带每角色 60 秒节流，不会因为一串推送而狂弹。
      notifyScheduleChangeFailed: (note: string) => {
        notifyInboxProcessFailed(message, 'schedule-missed', '后处理', note);
      },
      // musicHooks: 由 MusicProvider 注册到模块级 slot, 与 useChatAI 同一份, 见 MusicContext.loadMusicHooks.
      // slot 未填充时 (理论上 MusicProvider 未 mount, 实际单页应用不会发生) 退化为 undefined,
      // ChatParser 会静默丢弃 MUSIC_ACTION 标签 — 跟 Phase 1 老行为兜底一致, 不会引入新 failure mode.
      // 注意 snapshot 时序: 这里读取的是 push 送达时的 current song, 而不是 AI 当时看到的那帧.
      // 本地 fetch 路径也有相同窗口 (LLM 响应耗时内 current 可能漂移), 接受同一 trade-off.
      musicHooks: loadMusicHooks() ?? undefined,
    },
    skipSecondPassLLM: true,
    // 把 worker hook 塞进 metadata.directives 的副作用结构化重放出来 (POKE/TRANSFER/ADD_EVENT/
    // schedule_message/MUSIC_ACTION/XHS_*). applyAssistantPostProcessing 会反向拼回 tag 喂给
    // chatParser + 内联 XHS handler.
    // 一个 user turn 可能产 N 条 push, directives 只应该
    // replay 一次. worker 把 directives 挂在最后一条 push 上,
    // 这里加 isLastChunk 守卫双保险, 防未来 worker bug 在多条 push 都塞 directives.
    // 老 worker (无 messageIndex/totalMessages 字段) ?? 0 fallback, 0===0 也算 last.
    // replayDirectives=false = 这是重试、且上次已经把副作用跑完了（见 prepareInboxRetry）。
    directives: replayDirectives && isLastChunk(message) ? extractDirectives(message) : [],
    reasoningContent,
    // 这条 push 拆出的每条气泡共用一个时间戳 (跟降级存原稿路径同口径), 见
    // resolveInboxPersistTimestampForMessage。
    messageTimestamp: persistTimestamp,
    // 三种情况跳过拟人打字延迟、一次性回填，共同点是「用户已经读过这句话了，再演一遍
    // 打字过程只剩干等」：
    //   1. 补收：内容几小时前就在云端生成完了，慢放期间用户插的话还会把时间戳倒挂的
    //      口子撑开（见 resolveBackfillTimestamp）。判据是补收路径盖的标记，**不是**
    //      到达时间——那个会被补收自己改写（见 isOutboxBackfill 的说明）。
    //   2. 在收件箱里躺了一阵才被捞出来的。
    //   3. 送达时人不在场：系统通知已经把整句话完整显示过，他是看着通知点进来的。
    // App 在前台时收到的实时消息照旧慢放——那才是「角色正在你眼前打字」的场景。
    instantRender: shouldRenderInstantly(message.metadata, message.receivedAt, Date.now()),
    skipTypingSignal,
    // 交给后处理逐气泡对齐写进 metadata.sarModuleSurface——和本地路径同一处消费。
    sarModuleSurface,
  }));

  // ─── 即时对话（amsg2）的情绪评估结果 ───
  // 云端跟主回复并行跑完的那份，挂在最后一条 push 的 metadata 上（装不下时挪进
  // client_state、只留 amsgEmotionRef，见 worker 的 offloadOversizedPush）。
  // 跟单独一条 emotion_update 消息走同一条消费链：同一个 applyEmotionEvalRaw
  // 落 buff、同一个 'emotion-innerstate-updated' 喂下一轮、同一个 emotionDone
  // 熄灯，不另写第二套解析。
  //
  // 排在正文落库之后：这一条消息的本体是角色说的那句话，情绪只是附赠，
  // 顺序反了的话正文出问题时情绪已经先落了。
  //
  // amsgEmotionDone 是「这一轮的评估已经有结论了」，成败都带：只在有结果时才发信号的话，
  // 评估一失败徽章就得亮到十几分钟后才由安全网熄，而用户看到的是「情绪永远不更新」。
  const emotionDone = (message.metadata as any)?.amsgEmotionDone === true;
  // 晚投标记：评估没赶上这条回复的顺风车，worker 收尾时才把结果写进旁路存储。
  // 此刻旁路键多半还是空的，跳过一次性取回（免得白打一个「被下一轮覆盖了」的 warn），
  // 改为对引用键轮询补落，灯继续亮着。
  const emotionPending = (message.metadata as any)?.amsgEmotionPending === true;
  const inlineEmotionUpdate = (message.metadata as any)?.amsgEmotionUpdate;
  // 这条消息带来了新一轮的情绪结论（成 / 败 / 晚投）→ 上一轮还在跑的补落轮询作废：
  // 旧结果这时再落下去会盖掉新一轮的 buff。
  if (emotionDone || emotionPending || (typeof inlineEmotionUpdate === 'string' && !!inlineEmotionUpdate)) {
    cancelLateEmotionPoll(message.charId);
  }
  const emotionUpdateRaw = typeof inlineEmotionUpdate === 'string' && inlineEmotionUpdate
    ? inlineEmotionUpdate
    : (emotionPending ? null : await replyStep(async () => fetchOffloadedEmotionUpdate(message, offloadedCleanups)));
  if (emotionUpdateRaw) {
    await replyStep(async () => landCloudEmotionResult(message.charId, emotionUpdateRaw));
  } else if (emotionPending) {
    const pendingRef = (message.metadata as any)?.amsgEmotionRef;
    if (typeof pendingRef === 'string' && pendingRef) {
      startLateEmotionPoll(message.charId, pendingRef, message.charName || '', { taskUuid: message.taskUuid });
    } else {
      // 标了 pending 却没给引用键（worker bug）：没法轮询，按「有结论但没结果」收尾。
      announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
        charId: message.charId, charName: message.charName || '',
        reason: '云端情绪评估晚投但缺少引用键（worker 可能有 bug），这一轮不更新',
      });
      announceEmotionDone(message.charId);
    }
  } else if (emotionDone) {
    // 云端跑了但没跑出东西。不静默熄灯——弹一条 toast，否则用户只看到「情绪更新中」灭了、
    // 情绪没变、没有任何解释。worker 捎回来的那句原因（副 API 的状态码 / 模型没输出）
    // 直接给用户看：他自己部署的 worker，「可查日志」对多数人等于没说。
    const workerReason = (message.metadata as any)?.amsgEmotionError;
    // 统一走 announceChatGen（chatGenEvents 的唯一派发出口），别再手写 dispatchEvent。
    announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
      charId: message.charId, charName: message.charName || '',
      reason: typeof workerReason === 'string' && workerReason
        ? `云端情绪评估失败——${workerReason}`
        : '云端情绪评估无输出（副 API 报错或模型没返回内容，可查 worker 日志）',
    });
  }
  if (emotionDone || emotionUpdateRaw) {
    announceEmotionDone(message.charId);
    activeMsgTrace('runtime-emotion-done', {
      sessionId: getInstantSessionId(message),
      messageId: message.messageId,
      charId: message.charId,
    });
  }

  // ─── push 尾段 ───
  // Memory Palace 缓冲区处理在这里跑 (跟本地 fetch 路径 finally 段对齐, 不依赖 React).
  // 情绪评估不在这里跑: 云端已经跟主回复一起跑完, 结果就是上面落的那份.
  await replyStep(async () => runPushTailPipeline(message, char, userProfile));

  // 到这里这条消息才算真的落定（上面任何一步抛错都会让它被压回收件箱重试），
  // 这时候删云端那几份旁路副本才是安全的。不 await：删是让 D1 干净点的收尾动作，
  // 不能让一次网络往返拖住收件箱里后面几条的落库。
  void runOffloadedCleanups(offloadedCleanups);
};

/**
 * 这条 inbox message 是不是它所在 session 的**最后一条 chunk**.
 * messageIndex == totalMessages → 最后一条 ✓
 * 都缺失 (老 worker / proactive push 单 push) → 0 === 0 也认 last
 */
function isLastChunk(message: ActiveMsg2InboxMessage): boolean {
  const mi = Number(message.metadata?.messageIndex ?? 0);
  const tm = Number(message.metadata?.totalMessages ?? 0);
  return mi === tm;
}

/**
 * 认领到新任务之后广播的事件名。detail 只带 charId，监听方（OSContext）自己重读角色、
 * 把新任务合并进内存清单并打脏。事件名和 detail 形状是两侧的约定，改这里要同步改那边。
 */
export const AMSG2_TASKS_ADOPTED_EVENT = 'amsg2-tasks-adopted';

/**
 * 把 worker 带回来的「角色自排任务」补进该角色的本地清单。
 *
 * 幂等: 同 uuid 已经在清单里就不重复加(同一条 push 重放、或者 fire 重跑发了两次都可能撞上).
 * best-effort: 写不进去不影响这条消息本身——任务在远端好好的, 下次面板拉远端清单还能看见,
 * 只是这一刻本地少一行. 为它抛错会把已经收到的消息一起搞挂.
 *
 * 落库之后要广播一声: 这里跑在 React 之外, 只写 IndexedDB 的话内存里那份角色清单还是旧的,
 * 任务面板列不出这条、按任务数 / 凭据 / 订阅这几道门做判断的地方也都看不见它。
 */
async function adoptSelfScheduledTasks(message: ActiveMsg2InboxMessage): Promise<void> {
  const incoming = (message.metadata as any)?.amsgSelfScheduled;
  if (!Array.isArray(incoming) || incoming.length === 0) return;
  const charId = (message.metadata as any)?.charId;
  if (typeof charId !== 'string' || !charId) return;

  try {
    const char = (await DB.getAllCharacters()).find((c) => c.id === charId);
    if (!char) return;
    const existing = char.activeMsg2Config?.tasks ?? [];
    const known = new Set(existing.map((t: ActiveMsg2TaskRecord) => t.taskUuid));
    const added = incoming.filter((t: any) => t?.taskUuid && !known.has(t.taskUuid));
    if (added.length === 0) return;

    await DB.saveCharacter({
      ...char,
      activeMsg2Config: {
        ...(char.activeMsg2Config ?? { enabled: false }),
        tasks: pruneStaleTasks([...existing, ...added], Date.now()),
      },
    });
    console.log('[ActiveMsg] 认领角色自排任务', added.map((t: any) => t.taskUuid));
    // 只在真的新增了任务时才广播（上面 added.length === 0 已经提前 return），
    // 免得同一条 push 重放时白白让 UI 重读一遍角色。
    try {
      window.dispatchEvent(new CustomEvent(AMSG2_TASKS_ADOPTED_EVENT, { detail: { charId } }));
    } catch { /* SSR-safe / not browser, ignore */ }
  } catch (e) {
    console.warn('[ActiveMsg] adopt self-scheduled tasks failed', charId, e);
  }
}

/**
 * 把 worker 带回来的「角色取消 / 改期了既有任务」落到本地清单（amsgTaskMutations，
 * 与 adoptSelfScheduledTasks 对称的消账侧）。
 *
 * 幂等：取消的 uuid 本地已经没有、改期的时间已经一致时都是 no-op（同一条 push 重放安全）。
 * best-effort：失败只 warn——远端行已经删掉 / 改掉了，本地这一刻没跟上只是面板显示旧，
 * 下次对账还能拉平，为它抛错会把已经收到的消息一起搞挂。
 */
async function applyRemoteTaskMutations(message: ActiveMsg2InboxMessage): Promise<void> {
  const raw = (message.metadata as any)?.amsgTaskMutations;
  if (!raw || typeof raw !== 'object') return;
  const cancelled: string[] = Array.isArray(raw.cancelled)
    ? raw.cancelled.filter((u: unknown) => typeof u === 'string' && u)
    : [];
  const renewed: Array<{ taskUuid: string; sendAt: string }> = Array.isArray(raw.renewed)
    ? raw.renewed.filter((r: any) => typeof r?.taskUuid === 'string' && typeof r?.sendAt === 'string')
    : [];
  if (cancelled.length === 0 && renewed.length === 0) return;
  const charId = (message.metadata as any)?.charId;
  if (typeof charId !== 'string' || !charId) return;

  try {
    const char = (await DB.getAllCharacters()).find((c) => c.id === charId);
    const existing = char?.activeMsg2Config?.tasks ?? [];
    if (!char || existing.length === 0) return;

    const gone = new Set(cancelled);
    const renewedAt = new Map(renewed.map((r) => [r.taskUuid, r.sendAt]));
    const next = existing
      .filter((t: ActiveMsg2TaskRecord) => !gone.has(t.taskUuid))
      .map((t: ActiveMsg2TaskRecord) => {
        const sendAt = renewedAt.get(t.taskUuid);
        return sendAt && t.nextSendAt !== sendAt
          ? { ...t, firstSendTime: sendAt, nextSendAt: sendAt }
          : t;
      });
    const changed = next.length !== existing.length
      || next.some((t: ActiveMsg2TaskRecord, i: number) => t !== existing[i]);
    if (!changed) return;

    await DB.saveCharacter({
      ...char,
      activeMsg2Config: { ...(char.activeMsg2Config ?? { enabled: false }), tasks: next },
    });
    console.log('[ActiveMsg] 消账角色取消/改期的任务', { cancelled, renewed });
    // 与认领共用同一个事件：监听方（OSContext）做的是「重读角色」，增删改对它是一回事。
    try {
      window.dispatchEvent(new CustomEvent(AMSG2_TASKS_ADOPTED_EVENT, { detail: { charId } }));
    } catch { /* SSR-safe / not browser, ignore */ }
  } catch (e) {
    console.warn('[ActiveMsg] apply remote task mutations failed', charId, e);
  }
}

/** 把 worker 推给的 directives 从 inbox message metadata 里挖出来; 没有就空数组. */
function extractDirectives(message: ActiveMsg2InboxMessage): PostProcessDirective[] {
  const raw = message.metadata && (message.metadata as any).directives;
  if (!Array.isArray(raw)) return [];
  // 字段形状由 worker classifier 保证 (跟 PostProcessDirective union 一致); 这里只做轻量校验
  // 防 metadata 被改坏. 不识别的 type 不抛错, applyAssistantPostProcessing 内部 default 分支会 warn.
  return raw.filter((d) => d && typeof d === 'object' && typeof (d as any).type === 'string');
}

function getInstantSessionId(message: ActiveMsg2InboxMessage): string | undefined {
  return (message as any).sessionId
    || (message.metadata && (message.metadata as any).sessionId);
}

function getInstantMessageIndex(message: ActiveMsg2InboxMessage): number {
  return Number((message as any).messageIndex ?? (message.metadata as any)?.messageIndex ?? 0);
}

/**
 * 跑 push 路径的尾段: Memory Palace 缓冲区处理 + 通知 UI 重读角色 buff.
 *
 * Memory Palace 直接在这里跑 (pipeline 内部 self-contained, 不依赖 React state).
 */
async function runPushTailPipeline(
  message: ActiveMsg2InboxMessage,
  char: import('../types').CharacterProfile,
  userProfile: UserProfile,
): Promise<void> {
  // 1. Memory Palace
  const mpConfig = loadMemoryPalaceConfigFromLocalStorage();
  const mpEmb = mpConfig?.embedding;
  const mpLLMConfigured = mpConfig?.lightLLM;
  const apiConfig = loadApiConfigFromLocalStorage();
  const mpLLM = (mpLLMConfigured?.baseUrl)
    ? mpLLMConfigured
    : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };

  if ((char as any).memoryPalaceEnabled && mpEmb?.baseUrl && mpEmb?.apiKey && mpLLM.baseUrl) {
    try {
      const recentMsgs = await DB.getRecentMessagesByCharId(char.id, 50);
      // fire-and-forget: pipeline 内部有并发锁 + 水位线检查, 不会抢着跑两份
      void processNewMessagesWithAutoArchive(
        recentMsgs,
        char.id,
        char.name,
        mpEmb,
        mpLLM,
        userProfile?.name || '',
        false,
        (stage) => { console.log('[push:memory-palace]', stage); },
      ).catch((e) => {
        console.warn('[push:memory-palace] processNewMessages failed', e);
      });
    } catch (e) {
      console.warn('[push:memory-palace] tail kickoff failed', e);
    }
  }

  // 2. 情绪评估在 worker 跑 (副 API), 结果随 push 回来由 landCloudEmotionResult 落 buff.
  // 这里不触发客户端 eval (否则 worker + 客户端双跑双扣费).

  // 顺手通过 message 触发 'emotion-updated' (跟 useChatAI line 382 一致), 让 UI 重新读 char.
  // 注意: 这里的 emotion-updated 是给 ChatHeader 的 buff 显示信号, 不是情绪 eval 完成信号 —
  // 真正的 eval 完成由 useChatAI 内 evaluateEmotionBackground 自己 dispatch 同名事件.
  try {
    window.dispatchEvent(new CustomEvent('emotion-updated', { detail: { charId: char.id } }));
  } catch { /* SSR-safe / not browser, ignore */ }
}

/**
 * 「刚送达」与「补收」的分界（毫秒），只用来决定**要不要慢放拟人打字节奏**。
 *
 * 后处理管线每条气泡之间夹 0.5~2 秒 setTimeout，模拟角色正在打字。实时收到时这是对的；
 * 补收的消息早在几小时前就在云端生成完了，再慢放一遍只会让用户干等着一条条冒，
 * 而且这段时间里用户来得及插话，把时间戳倒挂的口子撑开（见 resolveBackfillTimestamp）。
 *
 * 取 2 分钟：前台连收几条排队处理最多几十秒，仍算刚到；而「看到通知再点进来」通常
 * 好几分钟起步，会落到补收那一侧。
 */
export const INBOX_FRESH_DELIVERY_WINDOW_MS = 2 * 60_000;

/**
 * 这条消息是不是从云端账本补收回来的（true = 一次性回填，不演打字）。
 *
 * **判据是补收路径写库时盖的那个标记，不是消息上的到达时间。** 补收在写库时会把整批
 * 消息的到达时间统一改写成「现在」（一次 Date.now() 全批共用），所以拿到达时间去问
 * 「这条是不是刚到的」，答案永远是「刚到」——补收就这么把自己伪装成了实时消息，然后
 * 一条条演打字，而它的内容其实早就在系统通知里被完整读过了。
 * 这个标记只有补收路径带，SW 直送的那份刻意不带（见 outboxPushToInbox）。
 * 纯函数，边界值见 activeMsgRuntime.test.ts。
 */
export const isOutboxBackfill = (metadata: Record<string, any> | undefined): boolean =>
  metadata?.amsgOutboxBackfill === true;

/**
 * 这条 inbox 消息是不是刚落到设备上的（true = 保留打字节奏，false = 一次性回填）。
 *
 * 判据用 receivedAt（消息落到这台设备的时刻）而不是 sentAt：它剔除了云端到设备之间的
 * 网络延迟，问的正是「这条在收件箱里躺了多久没人消费」。receivedAt 缺失/非法时按刚到
 * 处理——宁可多慢放一条补收的，也别把用户正看着的实时消息一次性刷出来。
 * 纯函数，边界值见 activeMsgRuntime.test.ts。
 */
export const isFreshInboxDelivery = (
  receivedAt: number | undefined,
  now: number,
): boolean => {
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || receivedAt <= 0) return true;
  return now - receivedAt <= INBOX_FRESH_DELIVERY_WINDOW_MS;
};

/**
 * 页面最近一次回到前台的时刻（epoch 毫秒）。0 = 这一辈子还没可见过 / 没人报过。
 * 只在内存里，刷新即忘——它要回答的问题也只在本次会话内有意义。
 */
let pageBecameVisibleAt = 0;

/** 页面回到前台了。init 时（当时就可见的话）和每次 visibilitychange 转 visible 时报一次。 */
export const notePageBecameVisible = (at: number = Date.now()): void => {
  pageBecameVisibleAt = at;
};

/**
 * 这条消息落到设备时，用户是不是不在这个页面上（true = 不在，跳过慢放）。
 *
 * 慢放（拟人打字节奏）的意义是「角色正在你眼前打字」。人不在场时，系统通知已经把整句话
 * 完整显示过了，再点进来看它一个字一个字重演一遍，剩下的只有等待。
 *
 * 判据是「送达时刻早于页面最近一次回到前台」：
 *   - App 在前台时收到 → receivedAt 落在这段可见期内 → 在场，保留慢放
 *   - 切后台 / 锁屏时收到，点通知进来 → 回到前台的时刻晚于 receivedAt → 缺席，跳过
 *   - 冷启动（点通知才把 App 拉起来）→ 页面首次可见也晚于 receivedAt → 缺席，跳过
 *
 * 两处保守退让，都倒向「保留慢放」：receivedAt 缺失/非法（老 push 可能不带），以及还没
 * 记录过回到前台的时刻（0）——后者若不挡住，会把每一条消息都判成缺席。
 * 纯函数，边界值见 activeMsgRuntime.test.ts。
 */
export const wasDeliveredWhileAway = (
  receivedAt: number | undefined,
  becameVisibleAt: number = pageBecameVisibleAt,
): boolean => {
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || receivedAt <= 0) return false;
  if (!Number.isFinite(becameVisibleAt) || becameVisibleAt <= 0) return false;
  return receivedAt < becameVisibleAt;
};

/**
 * 这条要不要跳过拟人打字慢放、一次性回填（true = 跳过）。
 *
 * 三条判据任一成立就跳过，共同点是「用户已经读过这句话了，再演一遍打字只剩干等」：
 *   1. 从云端账本补收回来的——内容早就生成完、通知也念过了；
 *   2. 在收件箱里躺过一阵才被捞出来的；
 *   3. 送达那会儿人不在页面上，是看着系统通知点进来的。
 *
 * 第 1 条**必须单独判**，不能指望第 2、3 条顺带捞到：补收在写库时会把整批消息的到达
 * 时间统一改写成「现在」，而第 2、3 条问的都是到达时间——于是它们双双得出「刚到的、
 * 用户还在场」，补收就这么把自己伪装成了实时消息。线上那八条补收回来的消息一条条重演
 * 打字，就是这么来的。
 * 纯函数，边界值见 activeMsgRuntime.test.ts。
 */
export const shouldRenderInstantly = (
  metadata: Record<string, any> | undefined,
  receivedAt: number | undefined,
  now: number,
  becameVisibleAt?: number,
): boolean =>
  isOutboxBackfill(metadata)
  || !isFreshInboxDelivery(receivedAt, now)
  || wasDeliveredWhileAway(receivedAt, becameVisibleAt);

/**
 * 算一条 inbox 消息落库该用的时间戳：一律取 sentAt（云端真正把这句话发出去的那一刻）。
 * 返回 undefined = 不指定，走 DB.saveMessage 默认的写库当刻（Date.now()）。
 *
 * 为什么不按「消息够不够新」二选一：那个判据回答不了「用户在不在场」——到点弹的通知，
 * 用户隔几分钟才点进来，消息就会被标成他点进来的那一刻。而在线送达时 sentAt 距落库
 * 只有几秒，标 sentAt 一样显示「刚刚」，观感没有差别。
 *
 * 标 sentAt 不会打乱聊天流的顺序：气泡位置只看自增 id（db.ts 按 charId 索引游标读、
 * Chat.tsx 的 displayMessages 不排序），timestamp 只决定气泡上显示的那个数字。
 * 唯一要防的是「位置在下、数字往回走」的倒挂，那个交给 resolveBackfillTimestamp
 * 精确判定，实际落库口径以 resolveInboxPersistTimestampForMessage 为准。
 *
 * 为什么不用「用户设定的触发时刻」（occurrenceMs）：云端喂给模型的「现在是几点」用的是
 * 实际开跑那一刻（worker/amsg/src/index.ts），角色正文里提到的时间跟 sentAt 对齐；
 * 云端那份自述日志记的也是 sentAt 口径。
 *
 * 主路径（applyAssistantPostProcessing 逐条落库）与降级存原稿路径共用这一个口径，
 * 别再各算各的。sentAt 缺失/非法（老 push 可能不带）返回 undefined。
 * 纯函数，边界值见 activeMsgRuntime.test.ts。
 */
export const resolveInboxPersistTimestamp = (
  sentAt: number | undefined,
  now: number,
): number | undefined => {
  if (typeof sentAt !== 'number' || !Number.isFinite(sentAt) || sentAt <= 0) return undefined;
  // 时钟偏差导致 sentAt 跑到未来时不采用——别把气泡标到还没到的时间。
  return sentAt > now ? undefined : sentAt;
};

/**
 * 补收的时间戳还能不能用（本地已经有更晚的消息就不能）。
 *
 * 「打开 App」和「后台补投的 push 送到」之间隔着好几秒，用户来得及先说一句。这时候把
 * 补收的消息按 sentAt 落库，聊天流里就会出现：08:01 用户说「早安」，下面紧跟着一条标着
 * 昨晚 23:00 的角色消息（显示顺序按自增 id，时间戳却在往回走）。
 * 本地已有比它更晚的消息 → 退回写库当刻，时间戳跟着显示顺序走，不倒挂。
 * 纯函数，两个方向见单测。
 */
export const resolveBackfillTimestamp = (
  persistTimestamp: number | undefined,
  latestLocalMessageAt: number | undefined,
): number | undefined => {
  if (persistTimestamp === undefined) return undefined;
  if (typeof latestLocalMessageAt !== 'number' || !Number.isFinite(latestLocalMessageAt)) {
    return persistTimestamp;
  }
  return latestLocalMessageAt > persistTimestamp ? undefined : persistTimestamp;
};

/**
 * 一条 inbox 消息最终的落库时间戳：先取 sentAt，再看本地有没有更晚的消息（有就退回
 * 写库当刻，防时间戳倒挂）。
 *
 * 每条都要查一次近史——后处理管线随后也会读同一份（contextMsgs），多这一次游标读可忽略。
 * 查不到近史时沿用 sentAt（宁可标 sentAt，也别把隔夜的消息标成现在）。
 */
const resolveInboxPersistTimestampForMessage = async (
  message: ActiveMsg2InboxMessage,
  now: number,
): Promise<number | undefined> => {
  const persistTimestamp = resolveInboxPersistTimestamp(message.sentAt || message.receivedAt, now);
  if (persistTimestamp === undefined) return undefined;
  try {
    const recent = await DB.getRecentMessagesByCharId(message.charId, 200);
    // 取最大值而不是最后一条：本地消息按自增 id 排，时间戳本来就可能不是单调的。
    const latest = recent.reduce(
      (max, m) => (typeof m.timestamp === 'number' && m.timestamp > max ? m.timestamp : max),
      0,
    );
    return resolveBackfillTimestamp(persistTimestamp, latest || undefined);
  } catch (e) {
    log.warn('查不到本地最新消息时刻，补收时间戳按 sentAt 落', { messageId: message.messageId, error: e });
    return persistTimestamp;
  }
};

/**
 * 重试前等多久（毫秒），按这条消息已经失败的次数取。
 *
 * 这条路上最常见的失败是 IndexedDB 的「将死连接」：App 切后台时系统强关连接，页面刚
 * 解冻就处理推送，正好撞在重建窗口里，`db.transaction()` 同步抛 InvalidStateError
 * （形态见 db.ts 的 onclose 注释——当次失败，下一次调用就自愈）。自愈是毫秒级的，
 * 而推送通知早把这句话完整显示过了，聊天界面再让用户对着「正在输入」等半分钟，
 * 观感上就是「通知都看到了，App 里还没有」。
 *
 * 所以第一档压到 1 秒。真的连着失败再拉长，避免存储持续故障时空转
 * （连挂到 MAX_INBOX_PROCESS_ATTEMPTS 就不重试了，退回存原稿保底）。
 */
export const resolveInboxRetryDelay = (attempts: number): number => {
  const ladder = [1_000, 5_000, 30_000];
  const nth = Number.isFinite(attempts) ? Math.floor(attempts) : 1;
  return ladder[Math.min(Math.max(nth, 1), ladder.length) - 1];
};
let inboxRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 排一次自动重试。
 * 「等下次打开 App」不能当作重试时机——用户不会为一条没出现的消息去重启，
 * 在他一直开着 App 聊天的时候，那条消息就永远躺在收件箱里了。
 */
const scheduleInboxRetry = (attempts: number) => {
  if (inboxRetryTimer != null) return;   // 已经排了就不重复排，一次重试会带上全部积压
  inboxRetryTimer = setTimeout(() => {
    inboxRetryTimer = null;
    void flushInboxToChat('重试');
  }, resolveInboxRetryDelay(attempts));
};

/** 写回收件箱等下次处理（带上失败次数），并排一次自动重试。 */
/**
 * 这一趟冲刷里被写回收件箱、还要再处理一次的消息。
 *
 * 云端账本的销账口径是「这条消息在客户端有着落了」——落库、按重复丢弃、用户明确停止
 * 都算有着落，唯独写回收件箱不算：账一销，下次就再也拉不回来了，而它还没处理完。
 * 所以这里反过来记「没着落的」，冲刷收尾时从本批里刨掉它们再销账。
 *
 * 用模块级集合而不是层层传参：冲刷本身是串行链（flushChain），同一时刻只有一趟在跑，
 * 每趟开头清空即可。
 */
const retainedInboxMessageIds = new Set<string>();

const requeueForRetry = async (message: ActiveMsg2InboxMessage, attempts: number): Promise<void> => {
  retainedInboxMessageIds.add(message.messageId);
  try {
    await ActiveMsgStore.saveInboxMessage({ ...message, processAttempts: attempts });
    scheduleInboxRetry(attempts);
  } catch (reputErr) {
    // 写回也失败，大概率同一根因（存储关停 / 配额满）。消息到此为止，留个明确的日志。
    log.error('requeue failed, message lost', { messageId: message.messageId, error: reputErr });
  }
};

// ─── 多段消息的等齐守卫 ───
//
// 一次生成可能拆成好几条 push（metadata.messageIndex 从 1 数起），Web Push 不保证按序
// 到达。App 开着时每收到一条就 flush 一次，两段落进两批的话 consumeInboxMessages 那次
// 「同批按段序排」根本够不着——聊天记录的显示顺序 = IndexedDB 自增 id = 落库先后，后段
// 先到就永久颠倒，用户看到的是「后半句 + 前半句」。
//
// 所以段序靠后的消息落库前先看一眼：更小的段序是不是都有着落了（在本批里，或者已经
// 落过库）。没有就写回收件箱等几秒再来一次。**必须有上限**——前段真丢了（worker 只发了
// 一半 / 那条 push 被系统丢掉）不能永远扣着后段不给用户看。

/** 段序靠后的消息最多扣住几次；超了按现状放行（顺序可能是乱的，但至少不会消失）。 */
export const MAX_INBOX_ORDER_HOLDS = 3;
/** 扣住之后隔多久再看一眼。前一段通常就在路上，几秒足够。 */
const INBOX_ORDER_HOLD_DELAY_MS = 3_000;

/** messageId → 已经扣住几次。释放（落库 / 放行）时删掉，不会无界增长。 */
const inboxOrderHolds = new Map<string, number>();
let inboxOrderHoldTimer: ReturnType<typeof setTimeout> | null = null;

const scheduleInboxOrderRecheck = () => {
  if (inboxOrderHoldTimer != null) return;   // 已经排了就不重复排，一次重看会带上全部积压
  inboxOrderHoldTimer = setTimeout(() => {
    inboxOrderHoldTimer = null;
    void flushInboxToChat('等齐重看');
  }, INBOX_ORDER_HOLD_DELAY_MS);
};

/**
 * 近史里这个 session 已经落过库的段序。
 *
 * 认领依据跟 findInboxArtifacts 同款——都是后处理落库时由 mcdInheritMeta 继承下来的
 * metadata（这里用 sessionId + messageIndex，那里用 activeMsg2.messageId）。
 * 一条 push 会被拆成好几个气泡，段序相同，去重后返回。
 */
export const findPersistedChunkIndexes = <T extends { role: string; metadata?: any }>(
  messages: T[],
  sessionId: string,
): Set<number> => {
  const indexes = new Set<number>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    if (m.metadata?.sessionId !== sessionId) continue;
    const idx = Number(m.metadata?.messageIndex ?? 0);
    if (Number.isFinite(idx) && idx > 0) indexes.add(idx);
  }
  return indexes;
};

/** 这条消息前面还缺哪几段（1 数到 messageIndex-1，凡是没着落的都算）。 */
export const findMissingChunkIndexes = (messageIndex: number, seen: Set<number>): number[] => {
  const missing: number[] = [];
  for (let i = 1; i < messageIndex; i += 1) {
    if (!seen.has(i)) missing.push(i);
  }
  return missing;
};

/**
 * 前面的分段还没着落 → 写回收件箱、过几秒再看，返回 true 表示这条这次先不处理。
 *
 * 三种情况一律放行（返回 false）：没有 session / 本来就是第一段、前面的段都齐了、
 * 扣到上限了。查近史或写回收件箱失败也放行——扣住的代价是消息迟迟不出现，比顺序错更重。
 */
const holdUntilEarlierChunksLand = async (
  message: ActiveMsg2InboxMessage,
  batch: ActiveMsg2InboxMessage[],
): Promise<boolean> => {
  const sessionId = getInstantSessionId(message);
  const messageIndex = getInstantMessageIndex(message);
  if (!sessionId || messageIndex <= 1) return false;

  let missing: number[];
  try {
    const seen = new Set<number>();
    for (const other of batch) {
      if (other.messageId !== message.messageId && getInstantSessionId(other) === sessionId) {
        seen.add(getInstantMessageIndex(other));
      }
    }
    const recent = await DB.getRecentMessagesByCharId(message.charId, 200);
    for (const idx of findPersistedChunkIndexes(recent, sessionId)) seen.add(idx);
    missing = findMissingChunkIndexes(messageIndex, seen);
  } catch (e) {
    log.warn('等齐守卫查不到近史，这条照常落库', { messageId: message.messageId, error: e });
    inboxOrderHolds.delete(message.messageId);
    return false;
  }

  if (missing.length === 0) {
    inboxOrderHolds.delete(message.messageId);
    return false;
  }

  const holds = (inboxOrderHolds.get(message.messageId) ?? 0) + 1;
  if (holds > MAX_INBOX_ORDER_HOLDS) {
    inboxOrderHolds.delete(message.messageId);
    log.warn('前面的分段一直没来，按现状放行（顺序可能是乱的）', {
      messageId: message.messageId, sessionId, messageIndex, missing,
    });
    activeMsgTrace('runtime-chunk-hold-giveup', {
      sessionId, messageId: message.messageId, messageIndex, missing,
    });
    return false;
  }

  try {
    // 原样写回（不动 processAttempts）——「前面那段还没来」不是处理失败。
    await ActiveMsgStore.saveInboxMessage(message);
    // 还要再来一趟，这一轮不许销账（见 retainedInboxMessageIds）。
    retainedInboxMessageIds.add(message.messageId);
  } catch (e) {
    log.warn('等齐守卫写回收件箱失败，这条照常落库', { messageId: message.messageId, error: e });
    inboxOrderHolds.delete(message.messageId);
    return false;
  }
  inboxOrderHolds.set(message.messageId, holds);
  scheduleInboxOrderRecheck();
  activeMsgTrace('runtime-chunk-hold', {
    sessionId, messageId: message.messageId, messageIndex, missing, holds,
  });
  return true;
};

/**
 * 送达失败发生在哪一段。**每条上报都要带**：不带的话面板上会多出一个空分组，
 * 而空分组恰恰是最需要被看见的那种「不知道哪来的」。
 */
type InboxFailureStage = '收发' | '后处理' | '补收';

/**
 * 告诉用户「有条消息没能正常显示」。
 * push 路径平时是故意不弹 toast 的（用户没在看这个角色时会很吵），但这里是失败提醒，
 * 频率极低且用户需要知道，所以照发——由 OSContext 那侧统一节流。
 */
const notifyInboxProcessFailed = (
  message: ActiveMsg2InboxMessage,
  kind: 'retrying' | 'degraded' | 'swallowed' | 'schedule-missed',
  /**
   * 这条是在哪一段挂的。同一个 kind 有好几个发射点（「重试中」就有三个），不分段的话
   * 面板上只看得到「有多少次失败」，看不出该去查哪条路——取值写死在各个调用点上。
   */
  stage: InboxFailureStage,
  /**
   * 给用户看的那句话，由发起方按具体原因写好。同一个 kind 底下不止一种情况
   * （日程没落地就分「没有对得上的时段」和「格式没认出来」），这里原样带过去，
   * 让 OSContext 讲准确的那句而不是一句盖全部的话。不传就用 kind 的默认文案。
   */
  note?: string,
) => {
  // 送达端唯一的埋点，而且只报失败：成功那条不报，免得攒出一份「谁几点收到过消息」的
  // 时间线（跟「发消息本身不打点」同一条口径，见 docs/analytics.md）。
  // 三个代号都是这个函数入参上写死的取值，角色名 / 内容 / messageId 一概不带
  // （note 是给界面看的人话，同样不进埋点）。
  trackEvent('主动消息送达失败', {
    kind: kind === 'degraded' ? '原文降级'
      : kind === 'swallowed' ? '被跳过'
        : kind === 'schedule-missed' ? '日程没落地'
          : '重试中',
    stage,
  });
  try {
    window.dispatchEvent(new CustomEvent('active-msg-process-failed', {
      detail: { charId: message.charId, charName: message.charName, kind, note },
    }));
  } catch { /* SSR-safe */ }
};

/**
 * 角色已经不在本地了，把它留在远端的任务清掉——否则这条任务会一直到点触发、
 * 一直推给一个不存在的角色。取消不掉也不要紧（网络问题），下一条推过来时还会再试一次。
 */
const cancelOrphanedRemoteTasks = async (charId: string): Promise<void> => {
  try {
    const { targets, failed } = await ActiveMsgClient.cancelAllTasksForChar(charId, []);
    log.warn('清理远端孤儿任务', { charId, targets: targets.length, failed: failed.size });
  } catch (e) {
    log.warn('清理远端孤儿任务失败（下次收到同角色 push 时会再试）', { charId, error: e });
  }
};

/**
 * 收件箱这条消息在处理途中抛了错，按跟后处理失败同一套去向收尾。
 *
 * 后处理管线自己那圈 try/catch 只盖住 applyAssistantPostProcessing 那一小截；查近史去重、
 * 认领角色自排任务、等齐守卫、算落库时间戳这些步骤同样会读本地存储，同样会因
 * IndexedDB 被占 / 配额满而抛错。收件箱已经在 consumeInboxMessages 那一刻被原子取空，
 * 让异常冒出去就等于整批消息凭空蒸发（既不在聊天记录、也不在收件箱、也没有任何提示）。
 *
 * 三条去向沿用 resolveInboxFailureAction：角色没了就去清远端任务，还能重试就压回收件箱，
 * 试到上限则明确告诉用户有一条被跳过了。
 */
const handleInboxStageFailure = async (
  message: ActiveMsg2InboxMessage,
  error: unknown,
): Promise<void> => {
  const attempts = (message.processAttempts ?? 0) + 1;
  const action = resolveInboxFailureAction(error, attempts);

  if (action === 'orphan') {
    log.warn('inbox message 的角色已不存在，丢弃并清理远端孤儿任务', {
      messageId: message.messageId, charId: message.charId,
    });
    await cancelOrphanedRemoteTasks(message.charId);
    return;
  }

  if (action === 'retry') {
    log.warn('处理 inbox message 时抛错，压回收件箱重试', {
      messageId: message.messageId, attempts, error,
    });
    await requeueForRetry(message, attempts);
    notifyInboxProcessFailed(message, 'retrying', '收发');
    return;
  }

  // 试到上限还是抛：本地存储这时候基本是真出问题了。这里不退回存原稿——抛错的位置
  // 未必是「内容还没落库」（可能已经落了一半），再补一份原稿会跟残留气泡并排出现。
  log.error('处理 inbox message 反复抛错，这条跳过', {
    messageId: message.messageId, attempts, error,
  });
  notifyInboxProcessFailed(message, 'swallowed', '收发');
};

/**
 * 这一趟冲刷是谁发起的。
 *
 * 「SW通知」是唯一的实时路径——推送一到就喊页面。其余全是兜底：轮询、回前台、启动、
 * 补收，它们都带着几秒到一分钟不等的固有延迟。所以这个字段实际回答的是
 * 「实时通道还活着吗」：一段时间里的冲刷全由兜底触发，就说明它断了。
 */
export type FlushTrigger =
  | 'SW通知'          // Service Worker 收到推送后喊页面（唯一的实时路径）
  | '点通知进入'      // 用户点系统通知把 App 唤到前台
  | '回到前台'        // 页面重新可见
  | '启动'            // App 冷启动时的兜底排空
  | '重试'            // 上一趟处理失败，定时重来
  | '等齐重看'        // 多段消息扣住后段，隔几秒回头看前段到了没
  | '动作结果'        // 后台动作结果入箱后立即落库，成功才确认云端结果
  | '上线补收'        // 开 App 自动去云端账本捞后台期间漏掉的
  | '手动补收'        // 用户点「找回没收到的消息」
  | '轮询补收'        // 即时对话 60 秒点名顺手把账本上的捞回来
  | '原生收件箱'      // 原生壳把消息塞进收件箱后触发
  | '原生推送'       // 原生壳收到推送后触发
  | '本地巡查'        // 前台每几秒数一眼本地收件箱，自己发现躺着的消息
  | '生成前收件';     // 只处理本轮角色的本地收件箱，不拉云端账本

// ─── 生成前收件与冲刷之间的共享状态（见 prepareInboxBeforeChat）───
/**
 * 此刻有几次生成正停在生成前收件上等。有人在等时整条串行链都跳过打字动画，不分是谁的
 * 消息（挡在前面的别的角色的气泡也得先放完）；等的人走了（收完或超时）就恢复打字节奏。
 */
let inboxPreparationWaiters = 0;
/** 当前正在处理的那条消息的打字等待；冲刷是串行的，同一时刻至多一条。 */
let activeInboxTyping: AbortController | null = null;
/** 有冲刷正在认领收件箱、认领结果还没出来。 */
let inboxClaimsInProgress = 0;
/** 已被认领、还没处理完的消息各属于哪些角色（角色 → 在跑的冲刷趟数）。 */
const inFlightInboxCharacters = new Map<string, number>();

/** 这条消息正等着重试定时器或等齐定时器来处理。 */
const isAwaitingInboxTimer = (message: ActiveMsg2InboxMessage): boolean =>
  (message.processAttempts ?? 0) > 0 || inboxOrderHolds.has(message.messageId);

const flushInboxToChatImpl = async (trigger: FlushTrigger, charId?: string): Promise<string[]> => {
  inboxClaimsInProgress += 1;
  let pendingMessages: ActiveMsg2InboxMessage[];
  try {
    // 生成前收件不碰正在等重试 / 等前段的消息：它们按自己的定时器再处理，
    // 每次点发送都重跑一遍会把重试次数和等齐次数提前耗光。
    pendingMessages = await ActiveMsgStore.consumeInboxMessages(
      charId, trigger === '生成前收件' ? isAwaitingInboxTimer : undefined,
    );
  } finally {
    inboxClaimsInProgress -= 1;
  }
  // 按角色认领却一条没有：什么都没发生，不留 trace（理由同 sweepLocalInbox 的空表）。
  if (charId !== undefined && pendingMessages.length === 0) return [];
  const batchCharIds = new Set(pendingMessages.map((m) => m.charId));
  for (const id of batchCharIds) inFlightInboxCharacters.set(id, (inFlightInboxCharacters.get(id) ?? 0) + 1);
  // 这一趟真正落进聊天流的那几条（见 flushInboxToChat 的返回值说明）。
  const landedMessageIds: string[] = [];
  activeMsgTrace('runtime-flush-start', { count: pendingMessages.length, trigger });
  // 这一趟处理谁「还没着落」的记账从空开始（见 retainedInboxMessageIds）。
  retainedInboxMessageIds.clear();
  // ─── 落库前的 messageId 去重 ───
  // 同一条推送有两条可达的「第二次到达」路径：① outbox 补收先落了库，被推送服务
  // 延迟的原始 Web Push 几分钟后才送达（补收绕过 SW，delivery-dedupe 里没有记录）；
  // ② 补收销账时 best-effort cancelTask 没拦住重试，worker 重跑整个 fire——重叠段号
  // 复用相同 messageId（`msg_task_{行id}@{occurrenceMs}_hook_{i}` 是确定性规则）。
  // 聊天近史里已经有这个 activeMsg2.messageId 的，直接丢弃：不落库、不弹 toast、
  // 不重放 directives。只对首次处理（processAttempts=0）做——重试那几条的半成品
  // 气泡刚被 prepareInboxRetry 清场，近史里查到的正是「该重跑」的证据，不能误杀。
  const persistedIdsByChar = new Map<string, Set<string>>();
  const isAlreadyPersisted = async (charId: string, messageId: string): Promise<boolean> => {
    if (!messageId) return false;
    let ids = persistedIdsByChar.get(charId);
    if (!ids) {
      const recent = await DB.getRecentMessagesByCharId(charId, 200);
      ids = new Set(
        recent
          .map((m: any) => m?.metadata?.activeMsg2?.messageId)
          .filter((id: unknown): id is string => typeof id === 'string' && !!id),
      );
      persistedIdsByChar.set(charId, ids);
    }
    return ids.has(messageId);
  };
  try {
  // consumeInboxMessages 是 "先 ack 后处理" 语义 —— inbox 已经原子地清空。
  // 这里 per-message try/catch: 单条处理抛错 (quota / DB 故障 / postprocess 异常) 不连累
  // 后续条目。Phase 1 改成: 先尝试走 applyAssistantPostProcessing (与本地 fetch 路径
  // 行为对齐 — emoji / 翻译 / HTML / 引用 / chunking 全部复用同一管线); 如果走管线失败,
  // 降级回原来的 "原文一次性 saveMessage" 防止消息丢失。dispatchEvent 始终 fire 一次,
  // 保证 toast / 未读 / 通知语义不变。
  for (const message of pendingMessages) {
    if (isReplyStopped(message.taskUuid)) {
      if (message.taskUuid && (message.metadata as any)?.amsgUsage) {
        settleInstantChatApiLog(message.taskUuid, message.metadata);
      }
      continue;
    }
    const isInstantReply = message.source === 'instant'
      || (message.metadata as any)?.amsgInstantChat === true
      || getInstantChatPending(message.charId)?.uuid === message.taskUuid;
    const replyRun = isInstantReply && message.taskUuid
      ? createReplyRun(message.charId, message.taskUuid) : undefined;
    const replyStep = <T>(operation: () => Promise<T>) => withReplyCancellation(replyRun, operation);
    const typingController = new AbortController();
    activeInboxTyping = typingController;
    if (inboxPreparationWaiters > 0) typingController.abort();
    // 这一层是**整批消息的最后一道防线**：消息在 consumeInboxMessages 那一刻就已经从
    // 收件箱里没了，下面任何一步抛出去的异常都会穿过整个 for 循环，剩下的消息既没落进
    // 聊天记录、也没回到收件箱——用户那边只看到「正在输入…」一直亮到 60s 点名判失败，
    // 角色的回复彻底消失。所以整段都得包住，不能只包后处理那一小截。
    try {
      // 'active-msg-received' 事件里的 sentAt 维持原口径（发送时刻优先）：
      // 它只喂 toast / 未读预览，不进聊天记录，别跟落库口径搅在一起。
      const eventSentAt = message.sentAt || message.receivedAt || Date.now();
      activeMsgTrace('runtime-inbox-message', {
        sessionId: (message as any).sessionId || (message.metadata as any)?.sessionId,
        messageId: message.messageId,
        charId: message.charId,
        messageType: message.messageType,
        bodyChars: typeof message.body === 'string' ? message.body.length : undefined,
        // 这条推送落到设备上的时刻（SW 写收件箱时打的），以及从那一刻起在收件箱里
        // 躺了多久才轮到它。用户抱怨的「通知都看到了，界面半天没字」量的就是这个数：
        // 它跟正文长短无关，纯粹是「没人来捞」的时间。
        receivedAt: message.receivedAt,
        waitedMs: typeof message.receivedAt === 'number' && message.receivedAt > 0
          ? Date.now() - message.receivedAt
          : undefined,
        // 第几段 / 共几段：多段回复的延迟要按段看才有意义。
        chunk: (message.metadata as any)?.messageIndex,
        total: (message.metadata as any)?.totalMessages,
        // 重试过几次（0 = 第一次处理）。
        attempts: message.processAttempts ?? 0,
      });

      // 见上面 isAlreadyPersisted 的注释：这条已经在聊天记录里了（补收先到、真推送迟到，
      // 或重试重跑的重叠段），第二份原样丢弃。
      if (!(message.processAttempts && message.processAttempts > 0)
        && await replyStep(async () => ((message.metadata as any)?.amsgActionResult === true
          && await ActiveMsgStore.hasAppliedActionResult(message.charId, message.messageId))
          || await isAlreadyPersisted(message.charId, message.messageId))) {
        log.warn('这条消息已在聊天记录里（补收先到/重试重跑的第二份），丢弃', { messageId: message.messageId, charId: message.charId });
        activeMsgTrace('runtime-inbox-duplicate-dropped', { messageId: message.messageId, charId: message.charId });
        continue;
      }

      // emotion_update: worker 跑完副 API 情绪评估后推回的 buff 结果. 不渲染成聊天消息, 直接落 buff +
      // 广播 innerState (useChatAI 监听 'emotion-innerstate-updated' → setEvolvedNarrative 喂下一轮).
      // 识别条件用 messageType==='emotion_update' 或 metadata.emotionRaw 存在 —— 后者兜底旧 SW
      // (<1.8.0 不认 emotion_update messageKind, 会把它当 content 存进 inbox, 但 metadata.emotionRaw
      // 仍被 saveContentToInbox 透传进来). 这样情绪落地不依赖 SW 是否升级.
      if (message.messageType === 'emotion_update' || (message.metadata as any)?.emotionRaw) {
        const emotionRaw = (message.metadata as any)?.emotionRaw;
        if (emotionRaw) {
          await replyStep(async () => landCloudEmotionResult(message.charId, String(emotionRaw)));
        } else {
          // worker 端评估失败/空结果时 emotionRaw 是空串（worker 无论成败都推一条用来熄灯）。
          // 过去这里静默跳过 —— 用户只看到「情绪更新中」灭了、情绪没变、无任何报错（真实反馈）。
          // 派发失败事件让 OSContext 弹 toast。2026-07-17+ 的 worker 会把具体原因带在
          // metadata.emotionError（副 API HTTP 状态等）；旧 worker 没这字段就给通用文案。
          const workerReason = (message.metadata as any)?.emotionError;
          announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
            charId: message.charId, charName: '',
            reason: typeof workerReason === 'string' && workerReason
              ? `云端评估失败——${workerReason}`
              : '云端情绪评估无输出（副 API 报错或模型没返回内容，可查 worker 日志）',
          });
        }
        // 无论成功与否都通知 useChatAI 熄灭 "情绪更新中" 徽章 (buff 已落 / 或这轮没结果).
        announceEmotionDone(message.charId);
        activeMsgTrace('runtime-emotion-done', {
          sessionId: (message as any).sessionId || (message.metadata as any)?.sessionId,
          messageId: message.messageId,
          charId: message.charId,
        });
        continue;
      }

      // 角色到点自己给自己排的任务：worker 直接在 D1 建了行，客户端这边并不知道它存在。
      // 先认领任务，再处理正文，让设置页和后续排程都能看见这批任务。
      await replyStep(async () => adoptSelfScheduledTasks(message));
      // 对称的另一半：角色在 fire 里取消 / 改期掉的既有任务，本地清单跟着消账。
      // D1 行已经没了（或换了时间），本地清单跟着更新。
      await replyStep(async () => applyRemoteTaskMutations(message));

      // 推送已经发出，系统通知可能已被用户读到，客户端只负责接收。
      // 是否避让聊天由 Worker 发送前判定；停止回复走独立的 UUID 守卫。
      if (message.source === 'scheduled') {
        activeMsgTrace('runtime-scheduled-delivery-accepted', {
          messageId: message.messageId, charId: message.charId, taskUuid: message.taskUuid,
        });
      }

      // 后段先到仍要等前段，保持原有的保序与有限重试。
      if (await replyStep(async () => holdUntilEarlierChunksLand(message, pendingMessages))) continue;

      // 落库时间戳按「在线送达 vs 离线补收」二选一（undefined = 交给 DB.saveMessage 默认取
      // 写库当刻），主路径与下面的降级存原稿路径共用这一个值，两条路一个口径。
      // sentAt 缺失时退到 receivedAt（老 worker 的 push 可能不带 sentAt）。
      const persistTimestamp = await replyStep(async () => resolveInboxPersistTimestampForMessage(message, Date.now()));

      // 白名单制: AI 文本类型基本封闭 (amsg-shared MESSAGE_TYPE 4 个 + SullyOS 3 个 legacy 别名);
      // 非 AI 类型 (forum / event / system / 未来扩展) 不可枚举, 不进 post-processing 防把它们当 AI 输出乱解析.
      // Phase 1 老白名单只列了 text/assistant/normal, 漏了整个 amsg-shared 集合, 导致所有 push 都
      // 走 raw fallback (post-processing / directive 重放 / emoji / chunking 全部跳过). Round 2 补全.
      const ASSISTANT_TEXT_TYPES = new Set([
        // SullyOS legacy
        'text', 'assistant', 'normal',
        // amsg-shared MESSAGE_TYPE union (instant/fixed/prompted/auto) — 全是 LLM 输出
        'instant', 'fixed', 'prompted', 'auto',
      ]);
      const looksLikeAssistantText = !message.messageType
        || ASSISTANT_TEXT_TYPES.has(message.messageType);

      let routed = false;

      if (looksLikeAssistantText) {
        try {
          await replyStep(async () => processInboxMessageWithPostProcessing(message, persistTimestamp, replyRun, typingController.signal));
          routed = true;
        } catch (postErr) {
          if (replyRun?.signal.aborted || isReplyStopped(message.taskUuid)) continue;
          const attempts = (message.processAttempts ?? 0) + 1;
          const action = resolveInboxFailureAction(postErr, attempts);

          if (action === 'orphan') {
            // 角色都不在了，这条消息没有落点，提醒用户也没有意义。真正该处理的是远端那条
            // 还在到点跑的任务——不取消掉它，以后每到点都会再推一条（而且每次真烧一轮 LLM）。
            log.warn('inbox message 的角色已不存在，丢弃并清理远端孤儿任务', { messageId: message.messageId, charId: message.charId });
            await replyStep(async () => cancelOrphanedRemoteTasks(message.charId));
            continue;
          }

          if (action === 'retry') {
            // 不就地存原稿：残缺版进了聊天记录是永久的，而这类故障通常是暂时的。
            log.warn('post-processing failed, requeue for retry', { messageId: message.messageId, attempts, error: postErr });
            await replyStep(async () => requeueForRetry(message, attempts));
            notifyInboxProcessFailed(message, 'retrying', '后处理');
            continue;
          }

          // 重试到头，退回存原稿保底：用户至少看得到内容，代价是表情 / 卡片 / 副作用都没了，
          // 所以这条要明确告诉用户「可能不完整」，别让它悄悄混进历史。
          // 存原稿前也要清一遍：这一趟同样可能写了几条气泡才挂，不清的话原稿会跟它们并排出现。
          log.error('post-processing failed，重试到上限，退回存原稿', { messageId: message.messageId, attempts, error: postErr });
          try {
            await replyStep(async () => purgeInboxArtifacts(message));
          } catch (purgeErr) {
            log.warn('存原稿前清理半成品失败（原稿照存，可能与残留气泡并存）', { messageId: message.messageId, error: purgeErr });
          }
          notifyInboxProcessFailed(message, 'degraded', '后处理');
        }
      }

      if (!routed) {
        try {
          await replyStep(async () => (replyRun?.saveMessage ?? DB.saveMessage)({
            charId: message.charId,
            role: 'assistant',
            type: 'text',
            content: message.body,
            timestamp: persistTimestamp,
            metadata: {
              source: 'active_msg_2',
              activeMsg2: {
                messageId: message.messageId,
                taskId: message.taskId,
                taskUuid: message.taskUuid,
                messageType: message.messageType,
                messageSubtype: message.messageSubtype,
                avatarUrl: message.avatarUrl,
                sentAt: message.sentAt,
                receivedAt: message.receivedAt,
              },
              // 同主路径：SAR 回程载具键不进气泡；这一段的角色外显原稿整段挂上。
              ...stripAmsgSarTransportKeys(message.metadata),
              ...(() => {
                const sarSurface = readAmsgSarSurface(message.metadata);
                return sarSurface ? { sarModuleSurface: sarSurface } : {};
              })(),
            },
          }));
        } catch (e) {
          if (replyRun?.signal.aborted || isReplyStopped(message.taskUuid)) continue;
          log.warn('saveMessage failed, requeue to inbox', { messageId: message.messageId, error: e });
          retainedInboxMessageIds.add(message.messageId);
          try {
            await replyStep(async () => ActiveMsgStore.saveInboxMessage(message));
          } catch (reputErr) {
            // re-put 也挂了 (大概率同一根因, 比如 quota / DB 关停), 没救了, 至少留个日志
            log.error('requeue failed, message lost', { messageId: message.messageId, error: reputErr });
          }
          // requeue 后跳过这条消息的 dispatchEvent —— UI 不该误以为收到了
          continue;
        }
        // 情绪附赠也要在这里消费：结果就挂在这条 push 的 metadata 上，而全仓库唯一的
        // 消费点在 post-processing 内部——走到降级这条路说明那边失败到头了，光把 metadata
        // 原样抄进聊天记录的话结果永远无人再读：「情绪更新中」徽章亮满十来分钟的安全网，
        // 然后弹「worker 可能是旧版」的假告警，其实结论早就到了本地。best-effort：情绪是
        // 附赠，消费失败不能连累「原稿已落库」这个事实（与上面销账块同一口径）。
        const degradedCleanups: OffloadedCleanup[] = [];
        try {
          const degradedEmotionDone = (message.metadata as any)?.amsgEmotionDone === true;
          // 晚投标记（同主路径口径）：评估没赶上这条 push 的顺风车，结果要等 worker 收尾
          // 才写进旁路存储。此刻旁路键多半还空着，跳过一次性取回（立刻读只会白打一个
          // 「被下一轮覆盖了」的 warn），改为对引用键轮询补落，灯继续亮着。
          const degradedEmotionPending = (message.metadata as any)?.amsgEmotionPending === true;
          const degradedInline = (message.metadata as any)?.amsgEmotionUpdate;
          // 这条消息带来了新一轮的情绪结论（成 / 败 / 晚投）→ 上一轮还在跑的补落轮询作废：
          // 旧结果这时再落下去会盖掉新一轮的 buff（同主路径）。
          if (degradedEmotionDone || degradedEmotionPending || (typeof degradedInline === 'string' && !!degradedInline)) {
            cancelLateEmotionPoll(message.charId);
          }
          const degradedUpdateRaw = typeof degradedInline === 'string' && degradedInline
            ? degradedInline
            : (degradedEmotionPending ? null : await replyStep(async () => fetchOffloadedEmotionUpdate(message, degradedCleanups)));
          if (degradedUpdateRaw) {
            await replyStep(async () => landCloudEmotionResult(message.charId, degradedUpdateRaw));
          } else if (degradedEmotionPending) {
            const degradedPendingRef = (message.metadata as any)?.amsgEmotionRef;
            if (typeof degradedPendingRef === 'string' && degradedPendingRef) {
              // 轮询等到结果就落 buff + 熄灯 + 删云端副本；跳数用尽由它自己报失败收尾。
              startLateEmotionPoll(message.charId, degradedPendingRef, message.charName || '', { taskUuid: message.taskUuid });
            } else {
              // 标了 pending 却没给引用键（worker bug）：没法轮询，按「有结论但没结果」收尾。
              announceChatGen(CHAT_GEN_EVENTS.emotionFailed, {
                charId: message.charId, charName: message.charName || '',
                reason: '云端情绪评估晚投但缺少引用键（worker 可能有 bug），这一轮不更新',
              });
              announceEmotionDone(message.charId);
            }
          }
          if (degradedEmotionDone || degradedUpdateRaw) announceEmotionDone(message.charId);
          // 原稿落了、情绪也消费完了，云端那份才可以删（同主路径口径）。
          void runOffloadedCleanups(degradedCleanups);
        } catch (e) {
          log.warn('降级存原稿路径消费情绪结果失败（原稿已落库，不受影响）', { messageId: message.messageId, error: e });
        }
      }

      // 走到这里 = 这条真的落进聊天流了（主路径落库完 / 降级存了原稿）。上面每一个
      // continue 都是「没上屏」：跟已有的重了、等前面的分段、压回收件箱重试。
      if ((message.metadata as any)?.amsgActionResult === true) {
        // 回执在本地成功落盘后才进入本趟成功名单；写失败由外层重排，不能先 ACK。
        await ActiveMsgStore.markActionResultApplied(message.charId, message.messageId);
      }
      landedMessageIds.push(message.messageId);

      // 不管走 post-processing 还是 raw fallback, 单条 inbox message 触发一次 'active-msg-received',
      // 驱动 toast / 未读 / 通知。body 用原文做预览即可。
      window.dispatchEvent(new CustomEvent('active-msg-received', {
        detail: {
          charId: message.charId,
          charName: message.charName,
          body: message.previewBody || message.body,
          avatarUrl: message.avatarUrl,
          sentAt: eventSentAt,
        },
      }));
      activeMsgTrace('runtime-active-msg-received-dispatched', {
        sessionId: (message as any).sessionId || (message.metadata as any)?.sessionId,
        messageId: message.messageId,
        charId: message.charId,
      });

      // 即时对话的「正在输入…」在这里熄：**欠着的那一轮**（认 taskUuid）的**末段**到了。
      // 只认 uuid、不认「这个角色开口了」：定时任务的主动消息、被顶掉的上一轮迟到的
      // 回复都可能先落地，它们不是用户在等的那一轮——按角色销账的话，60s 点名连同
      // outbox 兜底当场全停，这一轮的推送真丢了就再也没人去补。
      // 认末段（messageIndex >= totalMessages）而不是随便哪一段：第一段就销账的话，
      // 后续段丢在路上时兜底同样全停，用户永远只看到半截回复。段号缺失（单段消息 /
      // 旧 worker）当末段处理，保持旧行为。
      const pendingForChar = getInstantChatPending(message.charId);
      if (pendingForChar && message.taskUuid === pendingForChar.uuid) {
        const segIndex = Number((message.metadata as any)?.messageIndex);
        const segTotal = Number((message.metadata as any)?.totalMessages);
        const isLastSegment = !Number.isFinite(segTotal) || segTotal <= 1
          || (Number.isFinite(segIndex) && segIndex >= segTotal);
        if (isLastSegment && clearInstantChatPending(message.charId)) {
          scheduleNextInstantChatStatusCheck();
          // 「API 调用记录」里那笔（发出去时记的）在这里补完：用量挂在末条推送上，
          // 而这里正好是认末段的地方。
          settleInstantChatApiLog(pendingForChar.uuid, message.metadata as Record<string, any> | null);
          // 随这一轮上云的「任务被作废」回执到这里才真的销账。发出时（worker 回 202）
          // 只是记账：202 仅表示受理，那一轮要是整个失败了，回执得留着下轮重新注入，
          // 否则角色永远不知道自己许过的那条排程已经没了。认 uuid，上一轮迟到的结论
          // 不许销新一轮的账。
          void settleInstantChatExpiredNotices(message.charId, pendingForChar.uuid);
          // 这条回复是从 outbox 补收回来的 = 真推送没送到 = 那条任务行多半正挂在
          // 2/4/6 分钟的重试队列里，跑起来就是同一轮的第二份回复。尽力取消；
          // 正常送达的路不带这个标记（行发完即删，也无从取消），一个多余请求都不发。
          if ((message.metadata as any)?.amsgOutboxBackfill) {
            // 取消失败别静默吞：重试跑起来就是同一轮的第二份回复（重叠段有上面的
            // messageId 去重兜着，多出的段拦不住），至少留下一条可查的痕。
            ActiveMsgClient.cancelTask(pendingForChar.uuid).catch((e) => {
              log.warn('补收销账后取消重试任务失败（若重试已在跑，重复段会被落库去重拦下）', { uuid: pendingForChar.uuid, error: e });
            });
          }
          // 末段先到、中段还丢在路上的乱序场景：销账后 pending 没了，常规兜底不会再看
          // 这一轮——离场前按这轮的 uuid 补扫一次 outbox，把缺的段捡回来。
          void sweepSettledInstantRound(message.charId, pendingForChar.uuid);
          // 挂起没传的 fire_pack（销账前挡板拦下的那些）现在可以走了，别等 60s 回看。
          void flushAmsgState('instant-chat-settled');
          // SAR 临时模块的一轮收尾（USER_SURFACE 写回用户消息、事件快照、推进回合）。
          // 挂在这里是借销账的「同一 uuid 只进一次」防重复推进；内部各项自己兜错，不连累
          // 已落库的消息。
          // 有意为之的取舍：这一轮已经被 failInstantChatPending 判死（60s 点名超时、云端
          // 回报失败等）之后回复才到时，待收记录早没了、走不进这个块——正文照常落库，但
          // 不收尾（不推进回合、不写事件 / 用户外显），按「失败不扣回合」处理。
          await replyStep(async () => settleInstantChatSarModule(message));
        }
      }
    } catch (stageErr) {
      if (replyRun?.signal.aborted || isReplyStopped(message.taskUuid)) continue;
      // 收尾本身不许再抛（它是最后一道防线），抛了就真的什么都不剩了。
      try {
        await handleInboxStageFailure(message, stageErr);
      } catch (handlerErr) {
        log.error('inbox message 处理失败后的收尾也挂了，这条到此为止', {
          messageId: message.messageId, error: handlerErr,
        });
      }
    } finally {
      if (activeInboxTyping === typingController) activeInboxTyping = null;
      try { await replyRun?.settle(); }
      catch (error) { log.error('停止回复的本地收尾失败', { messageId: message.messageId, error }); }
      if (replyRun?.signal.aborted) {
        window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId: message.charId } }));
      }
    }
  }
  } finally {
    for (const id of batchCharIds) {
      const remaining = (inFlightInboxCharacters.get(id) ?? 1) - 1;
      if (remaining > 0) inFlightInboxCharacters.set(id, remaining);
      else inFlightInboxCharacters.delete(id);
    }
    // 有着落的那些去云端账本上销账。这一步是纯收尾：销不掉只是下次会再拉回来一趟，
    // 落库那层的去重会把它挡下，所以不 await、失败也只 warn，不连累已经落库的事实。
    const settled = pendingMessages
      .map((m) => m.messageId)
      .filter((id) => !!id && !retainedInboxMessageIds.has(id));
    retainedInboxMessageIds.clear();
    if (settled.length > 0) {
      void ActiveMsgClient.ackOutboxMessages(settled).catch((e) => {
        log.warn('云端账本销账失败（下次拉回来会被去重挡下）', { count: settled.length, error: e });
      });
    }
  }
  return landedMessageIds;
};

/**
 * 即时对话末段落定后的 SAR 临时模块收尾：读末段上的快照（metadata.amsgSar），USER_SURFACE
 * 原文太大时 worker 挪进了 client_state，这里按引用键取回。取不回只少写用户外显，
 * 不压回收件箱——重试会把回合再推进一次。
 */
const settleInstantChatSarModule = async (message: ActiveMsg2InboxMessage): Promise<void> => {
  try {
    const cleanups: OffloadedCleanup[] = [];
    // 快照太大时 worker 挪进了 client_state、只留 amsgSarRef；取不回就整轮不收尾。
    const snapshot = await resolveAmsgSarSnapshot(
      message.metadata,
      () => fetchOffloadedExtra(message, 'amsgSarRef', {
        what: 'SAR 快照', whenMissing: '这一轮不做 SAR 收尾，回复照常',
      }, cleanups),
    );
    if (!snapshot) {
      void runOffloadedCleanups(cleanups);
      return;
    }
    const inlineUserSurface = (message.metadata as any)?.amsgSarUserSurface;
    const userSurfaceRaw = typeof inlineUserSurface === 'string' && inlineUserSurface
      ? inlineUserSurface
      : await fetchOffloadedExtra(message, 'amsgSarUserSurfaceRef', {
        what: 'SAR 用户外显', whenMissing: '这一轮用户消息不显示外显，回复照常',
      }, cleanups);
    const result = await settleSarModuleAfterCloudReply({
      charId: message.charId,
      snapshot,
      userSurfaceRaw,
    });
    // 用户消息的 metadata 是在正文落库、'active-msg-received' 之后才改的，推一下让聊天界面重读。
    if (result.messagesTouched) {
      window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId: message.charId } }));
    }
    void runOffloadedCleanups(cleanups);
  } catch (error) {
    console.warn('[SAR·cloud] 即时对话 SAR 收尾失败（消息已落库，不受影响）', { messageId: message.messageId, error });
  }
};

/**
 * 一轮即时对话销账后的补扫：再拉一次云端账本。末段先到时中段可能还丢在路上，而销账后
 * 所有按 pending 走的兜底都不会再看这一轮。写进来的段落走原冲刷管线（保序 hold 会把它
 * 插回正确位置）。尽力而为：失败就算了，正常路径什么都扫不到。
 */
const sweepSettledInstantRound = async (charId: string, uuid: string): Promise<void> => {
  const entries = await drainOutboxAndFlush('轮询补收');
  if (entries === null) {
    log.warn('即时对话销账后补扫没读成（缺段只能等下一轮顺带）', { charId, uuid });
  }
};

// 串行化所有 flush. 两个原因:
//   1. 防并发 flush 交错 saveMessage —— 显示顺序 = IndexedDB 自增 id = saveMessage 调用先后
//      (见 db.ts getRecentMessagesByCharId 按 charId 索引游标取, 即 id 顺序), 并发就会乱序.
//   2. 返回的 promise 在"本次及之前排队的 flush"全部完成后才 resolve, 这样调用方能
//      await flushInboxToChat() 保证 round-1 旁白已落库, 再去跑 tool runner (它会触发 round-2),
//      从根上消除跨轮 B 抢在 A 前面入库 (用户看到的 "B+A").
// 每段都吞掉自身异常, 保证链不被一个失败的 flush 卡死.
let flushChain: Promise<unknown> = Promise.resolve();
/**
 * 排空收件箱、把里面的消息冲进聊天流。
 *
 * 返回**这一趟真正落进聊天流**的 messageId 名单。绝大多数调用方不看它（冲刷是纯副作用），
 * 但手动补收要拿它跟自己写进收件箱的名单对一次才敢说「补回了 N 条」——写进收件箱只是
 * 排上队，落库去重、多段等齐都可能把它拦在上屏之前。整趟挂掉时返回空数组
 * （异常在这里吞掉，跟原来一样不外抛）。
 *
 * （导出仅为让 activeMsgRuntime.test.ts 走真库钉「主路径 / 降级路径落库时间戳同口径」，
 *   运行时入口仍是 ActiveMsgRuntime.init 挂的监听器。）
 *
 * trigger 是**必填**的：收件箱里的消息可能被七八条路捞出来，光看「冲刷跑了」分不清是
 * 推送实时喊醒的、还是等满 60 秒被兜底轮询捞的——而这两件事对用户是天壤之别（前者
 * 立刻，后者最坏差一分钟）。设成必填而不是给个默认值，是为了让新加的调用点漏传时
 * 编译就报错，而不是静默记成一个查不出所以然的「未知」。
 */
export const flushInboxToChat = (trigger: FlushTrigger, charId?: string): Promise<string[]> => {
  const next = flushChain.then(async () => {
    try {
      return await flushInboxToChatImpl(trigger, charId);
    } catch (e) {
      log.warn('flushInboxToChat failed', { trigger, error: e });
      return [];
    }
  });
  flushChain = next;
  return next;
};

/**
 * 生成前收件的结果：
 *   - completed：当前角色已到本机的消息都落库了；
 *   - pending：还有消息留在收件箱（多段没到齐被扣住 / 处理失败等重试）；
 *   - timeout：等满 30 秒还没跑完；
 *   - stalled：这一趟已经让上一次生成等到超时、到现在还没跑完，这次不再等。
 */
export type InboxPreparationResult = 'completed' | 'pending' | 'timeout' | 'stalled';
type InboxPreparationOutcome = 'completed' | 'pending';
const inboxPreparations = new Map<string, { done: Promise<InboxPreparationOutcome>; timedOut: boolean }>();
const CHAT_INBOX_WAIT_MS = 30_000;

const runInboxPreparation = async (charId: string): Promise<InboxPreparationOutcome> => {
  // 当前角色在收件箱里的消息；等重试 / 等前段的那些归各自的定时器，这里不动。
  const listMine = async () => (await ActiveMsgStore.countInboxMessages()) <= 0
    ? []
    : (await ActiveMsgStore.listInboxMessages()).filter((m) => m.charId === charId);
  const mine = await listMine();
  // 没有可收的、也没有这个角色的消息正在处理：无事可做，不排队也不留 trace。
  // 别的角色的消息在收件箱里或处理中都不用等——那里面没有这个角色要的东西。
  if (!mine.some((m) => !isAwaitingInboxTimer(m)) && inboxClaimsInProgress === 0 && !inFlightInboxCharacters.has(charId)) {
    if (mine.length === 0) return 'completed';
  } else {
    // 要排到串行链后面等了：正在慢放的那个气泡立刻放完（之后轮到的由 inboxPreparationWaiters 管）。
    activeInboxTyping?.abort();
    await flushInboxToChat('生成前收件', charId);
  }

  const left = (await listMine()).length;
  if (left === 0) return 'completed';
  activeMsgTrace('runtime-before-chat-inbox-pending', { charId, count: left });
  return 'pending';
};

/**
 * 组装下一轮上下文前，尽快接收当前角色已经到本机的消息。
 * 复用串行冲刷和原子认领，不另起并发消费者；等待期间连正在慢放的气泡也立即加速。
 * 只等一趟、最多 30 秒：不串联云端补收，不等重试定时器；等待提示由聊天界面负责。
 * 超时不取消已认领的消息，原管线继续处理。同一角色同时只跑一趟，连点不堆队；
 * 一趟让人等到超时之后，它跑完之前的后续调用不再等（stalled）。
 */
export const prepareInboxBeforeChat = (charId: string): Promise<InboxPreparationResult> => {
  let work = inboxPreparations.get(charId);
  if (work?.timedOut) return Promise.resolve('stalled');
  if (!work) {
    const started = {
      done: runInboxPreparation(charId).catch((error): InboxPreparationOutcome => {
        log.warn('生成前收件没跑成（原收件管线照常处理）', { charId, error });
        return 'pending';
      }),
      timedOut: false,
    };
    work = started;
    inboxPreparations.set(charId, started);
    void started.done.then(() => {
      if (inboxPreparations.get(charId) === started) inboxPreparations.delete(charId);
    });
  }
  const current = work;
  const startedAt = performance.now();
  inboxPreparationWaiters += 1;
  return new Promise<InboxPreparationResult>(resolve => {
    let settled = false;
    const finish = (result: InboxPreparationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inboxPreparationWaiters -= 1;
      resolve(result);
    };
    const timer = setTimeout(() => {
      current.timedOut = true;
      activeMsgTrace('runtime-before-chat-inbox-timeout', { charId, waitedMs: Math.round(performance.now() - startedAt) });
      finish('timeout');
    }, CHAT_INBOX_WAIT_MS);
    void current.done.then(finish);
  });
};

// ─── 前台收件箱守望 ───
//
// Service Worker 把消息存进收件箱后会喊页面一声，但那一声在 iOS 上经常喊不到：App 不在
// 最前台时，SW 拿到的「当前有哪些页面」名单直接是空的，喊了也没人听见，消息就那么躺在
// 库里，没有任何人记得它还没上屏。（线上实测：一轮 8 条推送，8 次全是空名单；同一台
// 设备同一个 SW，页面在前台时探测却是几毫秒就回。）
//
// 所以这里不再等人来喊，改成页面自己隔几秒数一眼收件箱。**库里有没有货，本身就是那个
// 「还有话没传到」的记号**，不需要 SW 额外再留什么标记。SW 那一声从此只是加速：喊到了
// 更快，喊不到也不影响消息能不能上屏。
const LOCAL_INBOX_WATCH_INTERVAL_MS = 3_000;
let localInboxWatchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 数一眼本地收件箱，有货才冲刷。**全程不走网络**——跟「去云端账本捞一圈」
 * （drainOutboxAndFlush，要分页拉、还要逐条查任务状态）完全是两回事，别混。
 *
 * 空表时只有一次 IndexedDB count，所以敢几秒跑一趟；数出来是 0 就直接走人，连 trace
 * 都不记——否则几秒一条空转记录，几分钟就能把排障真正要看的那些顶出缓冲区。
 *
 * （导出仅为让 activeMsgRuntime.test.ts 直接钉住「空表不动手、有货才冲刷」；
 *   运行时入口是下面的 scheduleLocalInboxWatch 和 init 里挂的那两个唤醒事件。）
 */
export const sweepLocalInbox = async (): Promise<void> => {
  try {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const pending = await ActiveMsgStore.countInboxMessages();
    if (pending <= 0) return;
    await flushInboxToChat('本地巡查');
  } catch (e) {
    log.warn('本地收件箱巡查没跑成（下一跳还会再来）', { error: e });
  }
};

/**
 * 把巡查排到下一跳。**不管页面可不可见都排下去**，这是故意的：
 *
 * iOS 会把后台的页面整个挂起，挂起期间定时器不走、事件也不发，恢复时既不保证有
 * visibilitychange 也不保证有别的信号。只要这条链一直排着，页面一旦重新跑起来，被冻住
 * 的那一跳立刻就补上了——正确性不押在「某个事件必须送达」上。不可见时 sweepLocalInbox
 * 自己会走人，浏览器也会把后台定时器节流，空转不费什么。
 *
 * 上一跳跑完才排下一跳（而不是固定间隔硬发），免得冲刷本身慢放二十秒时排队堆积。
 */
const scheduleLocalInboxWatch = (): void => {
  if (localInboxWatchTimer != null) clearTimeout(localInboxWatchTimer);
  localInboxWatchTimer = setTimeout(() => {
    localInboxWatchTimer = null;
    void sweepLocalInbox().finally(() => scheduleLocalInboxWatch());
  }, LOCAL_INBOX_WATCH_INTERVAL_MS);
};

// ─── 补收兜底 + 即时对话状态点名 ────────────────────────────────────────────
// 推送是会静默丢的（换网、代理断流、系统压制、SW 没醒）。云端每条推送发出去之前都在
// 服务端账本上记了一行，客户端落库之后销账，所以「哪些没收下」是查得出来的事实。
//
// 拉账本的时机分两类，别混：
//   1. 上线补收（catchUpMissedPushes）——冷启动、回到前台各一次，带节流。**不看有没有
//      在等回复**。定时主动消息是云端到点自己发的，客户端从来不知道自己在等它，
//      要是只在「欠着回复」时才拉，它的推送丢了就永远没人去捞（那正是这条路存在的理由）。
//   2. 等回复时的点名（runInstantChatStatusCheck）——每 60s 一跳，下结论前必拉一次最新的。
//      **不受节流管**：为省一次往返而跳过，就可能拿着旧账本去判「回复取不回」。
//
// 两类共用 drainOutboxAndFlush，也共用同一个节流时钟——点名拉过之后，紧跟着的上线补收
// 那一趟就会被挡下。
//
// 账本是按用户存的、不分角色，所以一趟就把所有角色欠的都捞回来了，不用逐个角色拉。

/**
 * 两趟上线补收之间至少隔这么久。
 *
 * 挡的是「切标签页回来一次、SW 通知一次、点通知进来一次」这种几秒内连着触发好几回。
 * 取 60s 跟点名周期同档：推送真丢了的话，用户下次上线就该看到，不必更密；而比这更密
 * 的往返只是白付 RTT。手动补收不受这条限制（用户自己知道丢了才点）。
 */
export const OUTBOX_CATCH_UP_MIN_INTERVAL_MS = 60_000;

/** 上一趟账本拉取的时刻（不分入口，点名那几条也记在这儿）。0 = 这个会话还没拉过。 */
let lastOutboxDrainAt = 0;

/** 只给单测用：把节流时钟拨回从没拉过的状态。 */
export const resetOutboxCatchUpThrottleForTesting = (): void => { lastOutboxDrainAt = 0; };

/**
 * 「有 N 条太旧了，没能补回来」——广播出去让 OSContext 弹一句。
 *
 * 只报数量，不报角色名也不报内容：这条路上手里只有账本条目，正文还是密文，而且
 * 一趟可能跨好几个角色。用户需要知道的是「刚才有东西没了、去哪儿看不了」，具体
 * 是哪条本来就已经拿不回来了。
 */
const notifyOutboxStaleDropped = (count: number): void => {
  // 跟送达端其它失败共用一个事件名，只多一个写死的代号。条数不进上报——属性只能是
  // 固定枚举（见 docs/analytics.md），而且这一格要的是「有没有人在丢消息」，不是丢了几条。
  trackEvent('主动消息送达失败', { kind: '超时丢弃', stage: '补收' satisfies InboxFailureStage });
  try {
    window.dispatchEvent(new CustomEvent('active-msg-backfill-stale', { detail: { count } }));
  } catch { /* SSR-safe */ }
};

/**
 * 拉一次云端账本、把补收到的冲刷进聊天流。
 *
 * 返回这一趟读到的全部条目；**读失败返回 null**。两者不能混：「没读成」不构成任何
 * 结论（网络抖一下、请求被掐断都会读失败，回复可能好好地躺在账本上），调用方要拿它下
 * 「回复取不回」的判决时只能认前者。
 *
 * trigger 由调用方给：这个函数被上线补收、手动补收、60 秒点名三条路共用，而排障时
 * 要分的正是「是谁把消息捞回来的」——记成同一个就白记了。
 */
const drainOutboxAndFlush = async (trigger: FlushTrigger): Promise<AmsgOutboxEntry[] | null> => {
  lastOutboxDrainAt = Date.now();
  try {
    const { written, ackNow, entries, staleDropped } = await drainOutbox();
    // 不打算走聊天流的那些当场销账，免得每趟都把它们捞回来。纯收尾，不 await。
    if (ackNow.length > 0) {
      void ActiveMsgClient.ackOutboxMessages(ackNow).catch((e) => {
        log.warn('账本上跳过的条目销账失败（下次会再捞一遍）', { count: ackNow.length, error: e });
      });
    }
    // 保留旧调用接口的计数处理；正文补收已取消年龄丢弃，当前返回 0。
    if (staleDropped > 0) notifyOutboxStaleDropped(staleDropped);
    if (written > 0) await flushInboxToChat(trigger);
    return entries;
  } catch (e) {
    log.warn('补收失败（等下一次时机再试）', { error: e });
    return null;
  }
};

/**
 * 上线就去账本上捞一次漏掉的推送。冷启动、回到前台各调一次。
 *
 * **不看有没有即时对话在等回复**——这正是这个入口存在的全部理由。定时主动消息由云端
 * 到点自己发，客户端没有任何「我在等它」的本地状态，推送在路上丢了（代理断流、推送
 * 服务连不上、SW 没醒）之后，唯一能把内容找回来的地方就是服务端账本。挂在「欠着回复」
 * 上的话，这类消息就是发出去即失踪：worker 日志全绿、任务照常消费、订阅也没被退回，
 * 用户那边只是再也收不到。
 *
 * 返回值只为单测断言与日志：
 *   - 'drained'：这趟真去拉了（读到什么、有没有落库看 drainOutboxAndFlush）；
 *   - 'throttled'：离上一趟不够 OUTBOX_CATCH_UP_MIN_INTERVAL_MS，跳过；
 *   - 'worker-unset'：没配 Worker，一个请求都不发；
 *   - 'failed'：读账本抛了（已在里面 warn 过），下次时机再试。
 */
export const catchUpMissedPushes = async (
  trigger: 'startup' | 'foreground' | 'manual',
): Promise<'drained' | 'throttled' | 'worker-unset' | 'failed'> => {
  // 手动那趟是用户自己发现丢了消息才点的，不受节流管。
  if (trigger !== 'manual'
    && lastOutboxDrainAt > 0
    && Date.now() - lastOutboxDrainAt < OUTBOX_CATCH_UP_MIN_INTERVAL_MS) {
    return 'throttled';
  }

  // 没配过 Worker 的用户一个请求都不该发。不靠 ensureWorkerReady 抛错来兜：那条路每次
  // 回前台都会 warn 一行，控制台会被刷满，而「没配」根本不是异常。
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    if (!config?.workerUrl?.trim()) return 'worker-unset';
  } catch (e) {
    log.warn('读不到主动消息配置，这趟补收先跳过', { error: e });
    return 'failed';
  }

  const entries = await drainOutboxAndFlush(trigger === 'manual' ? '手动补收' : '上线补收');
  return entries === null ? 'failed' : 'drained';
};

/**
 * 用户在设置面板上手动点的补收，不受自动补收的节流限制。
 * 首次与后续、手动与自动都恢复服务端仍保留的正文，并按完整本地历史去重。
 * 返回的 stale 保留接口兼容，普通正文不再因48小时期限被丢弃。
 *
 * `written` 数的是**真的上了屏**的条数，不是写进收件箱的条数：中间还隔着一趟冲刷，
 * 落库去重、多段等齐都会把消息拦在上屏之前。按收件箱那个数报的话，界面会
 * 说「补回 3 条，去聊天里看看」，用户翻遍聊天记录一条也找不到。
 *
 * 这条路不广播 active-msg-backfill-stale：用户正盯着这个按钮等结果，面板会把三个
 * 数字一起说清楚，再弹一条 toast 就是同一件事说两遍。
 *
 * 读账本失败**照常抛**，让面板报错：手动操作没有「下次再说」，用户在等一个明确结果。
 */
export const catchUpMissedPushesManually = async (): Promise<{
  written: number;
  scanned: number;
  stale: number;
}> => {
  lastOutboxDrainAt = Date.now();
  const { written, writtenIds, ackNow, entries, staleDropped } = await drainOutbox({ treatBacklogAsMissed: true });
  if (ackNow.length > 0) {
    void ActiveMsgClient.ackOutboxMessages(ackNow).catch((e) => {
      log.warn('账本上跳过的条目销账失败（下次会再捞一遍）', { count: ackNow.length, error: e });
    });
  }
  // 报给用户的是「上了屏几条」，所以要等冲刷跑完、再拿这一趟落库的名单跟自己写进收件箱
  // 的名单对一次。只认自己那几条：同一趟冲刷可能顺手把收件箱里别人（推送刚写的）留下的
  // 也带走了，那些不是这次补收的功劳。
  const landed = written > 0 ? new Set(await flushInboxToChat('手动补收')) : new Set<string>();
  const persisted = writtenIds.filter((id) => landed.has(id)).length;
  return { written: persisted, scanned: entries.length, stale: staleDropped };
};

let instantChatStatusPollTimer: ReturnType<typeof setTimeout> | null = null;

// ─── 状态查询连续失败的判死线 ───
// 「不按时长宣判」只对**云端还答得上话**的等待成立（pending 是云端亲口说的，等多久都对）。
// 但 worker 被删（未知路由回 HTML 页）、共享密钥被换（401）这类用户自己动过环境的场景，
// 查询这一步会永远抛错——云端的结论永远问不出来，待收记录就永远销不了账：「正在输入…」
// 跨重启常亮、每 60s 空转一跳、该角色的 fire_pack 同步被无限期挂起。联网状态下连续
// 多次问不出话，就把这一轮明确判死并告诉用户去检查 worker 配置，不再无限等。
// 计数按任务 uuid 记，查询成功或换了轮次就清零；断网（navigator.onLine=false）不计数
// ——那是这台设备暂时没网，不是 worker 的错。
const instantStatusCheckFailures = new Map<string, number>();
const INSTANT_STATUS_CHECK_MAX_FAILURES = 5;

/**
 * 页面回到前台了：先记下时刻，再把后台期间攒下的活儿补上。
 *
 * **顺序有要求**：`notePageBecameVisible()` 必须排在 flush 之前。后台期间攒下的那条
 * 消息正是「用户看着通知点进来」的那条，flush 要靠这个时刻判出「送达时人不在场」
 * 才会跳过拟人慢放；反过来的话它会被当成实时消息又演一遍打字，而且不报任何错。
 *
 * 补的这几件事：
 *  - flush：页面被冻结（iOS PWA / 移动端后台）时 SW 那条 postMessage 可能丢失，
 *    消息卡在收件箱里不刷新（「离开后台消息不返回」）。
 *  - 上线补收：后台期间丢掉的推送去账本上捞回来。**不管有没有在等回复**——定时主动
 *    消息丢了的话客户端没有任何本地状态知道它来过（见 catchUpMissedPushes）。自带节流。
 *  - 即时对话点名：欠着回复就立刻点一次，不用再等满 60 秒。后台不排下一跳，周期从这里接上。
 *  - 待写日记：写 Notion/飞书的 fetch 后台会被冻结打断，回前台补打。
 */
export const handlePageBecameVisible = (): void => {
  notePageBecameVisible();
  void (async () => {
    await flushInboxToChat('回到前台');
    void catchUpMissedPushes('foreground');
    void runInstantChatStatusCheck();
    void drainPendingDiaries(loadRealtimeConfigFromLocalStorage(), (charId) => {
      window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId } }));
    });
  })();
};

/**
 * 还欠着回复时，把下一跳点名排到 60s 后；一条都不欠就直接撤掉定时器。
 *
 * 每次待收记录变动都重排一次（受理 / 收到回复 / 判失败都会调）。绝大多数时候一条
 * 待收记录都没有，那时一个定时器都不留，不给所有人加一条轮询。
 */
const scheduleNextInstantChatStatusCheck = () => {
  if (instantChatStatusPollTimer != null) {
    clearTimeout(instantChatStatusPollTimer);
    instantChatStatusPollTimer = null;
  }
  if (listInstantChatPendings().length === 0) return;
  instantChatStatusPollTimer = setTimeout(() => {
    instantChatStatusPollTimer = null;
    void runInstantChatStatusCheck();
  }, INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS);
};

/**
 * 即时对话的「一直等」状态机。客户端不按时长宣判——worker 一次 fire 最长 10 分钟、
 * 生成失败即终止，已入收件箱的回复仍可重试补推（旧 Worker 也可能重试生成）。固定的
 * 客户端超时会抢在云端结论之前把还在路上的
 * 回复判死（甚至顺手 cancel 掉）。这里的做法是：还欠着回复时，前台每 60s 点名问一次
 * 那条任务行：
 *   pending → 继续等（云端还在跑或在排队重试；nextSendAt 过期是重试中的常态，不当信号）；
 *   completed（一次性任务 = 已失败）→ 补收兜底后落一条带 lastError 的失败说明；
 *   gone → 补收兜底后要么已收到（销账在 flush 里做掉了），要么明确告知取不回；
 *   查询失败（网络）→ 什么都不做，等下一跳。
 *
 * 冷启动、回到前台、60s 定时器三个时机都走这一个入口。页面不可见时直接走人，**也不排
 * 下一跳**：后台每分钟醒一次去打网络毫无意义（用户看不见结果，移动端还会被系统掐），
 * 回前台的 visibilitychange 会立刻再点一次名，周期从那时接上。
 *
 * 每一轮下结论前都先拉一次 outbox：到点没收到最常见的原因是推送丢了而不是生成失败，
 * 不拉就报失败的话，用户会为一条其实已经生成好的回复重发一遍（再烧一轮 LLM）。
 */
export const runInstantChatStatusCheck = async (): Promise<void> => {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  const pendings = listInstantChatPendings();
  // 计数器只留还在等的轮次（销账走别的路时这里顺手清，别攒垃圾）。
  const activeUuids = new Set(pendings.map((p) => p.uuid));
  for (const uuid of [...instantStatusCheckFailures.keys()]) {
    if (!activeUuids.has(uuid)) instantStatusCheckFailures.delete(uuid);
  }
  // 账本是按用户存的，一趟就把所有角色欠的都捞回来了——放在循环外拉，几个角色同时
  // 等着回复时也只有一次往返。
  //
  // 这趟不走上线补收那个节流：点名的语义是「下结论之前必须拿最新的账本」，为省一次
  // 往返而跳过，就可能拿着几十秒前的旧结论去判「回复取不回」。冷启动那一刻可能跟
  // 上线补收撞上一次，那是「用户正等着回复」才有的场景，多一次往返换判断可靠，值。
  if (pendings.length > 0) await drainOutboxAndFlush('轮询补收');
  for (const pending of pendings) {
    // 补收那一步如果把回复放进来了，flush 里已经销账了——这一轮就此结束。
    if (getInstantChatPending(pending.charId)?.uuid !== pending.uuid) continue;

    let status: RemoteTaskStatus;
    try {
      status = await ActiveMsgClient.getRemoteTaskStatus(pending.uuid);
    } catch (e) {
      // 设备自己没网不算 worker 的失败——这种失败攒不出「worker 失联」的结论。
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        log.warn('即时对话状态查询失败（设备离线，等下一跳）', { uuid: pending.uuid, error: e });
        continue;
      }
      const count = (instantStatusCheckFailures.get(pending.uuid) ?? 0) + 1;
      if (count < INSTANT_STATUS_CHECK_MAX_FAILURES) {
        instantStatusCheckFailures.set(pending.uuid, count);
        log.warn('即时对话状态查询失败（等下一跳）', { uuid: pending.uuid, count, error: e });
        continue;
      }
      // 联网状态下连问 N 次都问不出话：worker 多半已经不在了（被删 / 密钥换了 / 路由变了）。
      // 明确判死这一轮，别让「正在输入」永亮、fire_pack 同步无限期挂起。
      instantStatusCheckFailures.delete(pending.uuid);
      const lastError = e instanceof Error ? e.message : String(e);
      log.warn('即时对话状态查询连续失败，按云端失联收场', { uuid: pending.uuid, count, error: e });

      // 判死之前先把远端那行了结掉。
      //
      // 这条路跟 completed / gone 不一样：那两条是云端亲口给的结论（行已失败 / 行没了），
      // 没什么可取消的；而这里从头到尾没问出过话，那行完全可能正挂在 2/4/6 分钟的重试
      // 梯子上。不取消就宣判的话，用户照着说明重发一遍，原来那行随后又跑成功——一轮
      // 对话烧两次 LLM，聊天流里冒出两份几乎一样的回复。
      //
      // 取消失败**不改判**：会走到这里的典型场景（worker 被删、共享密钥被换）正是取消
      // 也一样打不通的场景，要求取消成功才准判死，等于把「正在输入…永亮」这个原病重新
      // 请回来。改的是措辞：取消没落地时如实告诉用户那行可能还会自己跑完。
      let taskCancelled = false;
      try {
        await ActiveMsgClient.cancelTask(pending.uuid);
        taskCancelled = true;
      } catch (cancelErr) {
        log.warn('判死前取消远端任务失败（那行可能还会自己跑完并推过来）', {
          uuid: pending.uuid, error: cancelErr,
        });
      }

      await failInstantChatPending(pending.charId, pending.uuid,
        `联系不上云端 worker（连续 ${count} 次状态查询失败：${lastError.slice(0, 120)}）。`
        + 'worker 可能已被删除或共享密钥已变，去「设置 → 主动消息 2.0」重新连接并验证'
        + (taskCancelled ? '' : '；云端那条任务也没能取消，它要是自己跑完了，这一轮的回复稍后可能还会送到'));
      continue;
    }
    instantStatusCheckFailures.delete(pending.uuid);

    if (status.state === 'pending') {
      if (status.retryCount) log.warn('即时对话云端在重试', { uuid: pending.uuid, retryCount: status.retryCount });
      continue;
    }

    // completed / gone：再兜一次账本（落账与删行之间有窗口），仍没有才下结论。
    const entries = await drainOutboxAndFlush('轮询补收');
    if (getInstantChatPending(pending.charId)?.uuid !== pending.uuid) continue;

    // 上游的 completed = 行还在、但已经出了 pending 队列（sent / failed 都算这个码）。
    // 而一次性任务发成功会把行删掉、查出来是 gone——所以还查得到的 completed 行只可能是 failed。
    if (status.state === 'completed') {
      // 行级 lastError（409 捎来的，amsg-server 2.6.0-next.15 起）一起带进去：chat_fail
      // 是 worker 自己写的、拿不到 pushStatus 那个数，而「订阅失效了，去重置」这句最有用
      // 的话正好只有它推得出来。两份说的是同一跳，合起来看才完整。
      let reason = await readInstantChatFailReason(pending.charId, pending.uuid, status.lastError);
      // chat_fail 一条都没留下（isolate 连人带痕一起没了那种）时，只用行上这份。
      if (!reason && status.lastError) {
        reason = describeInstantChatFailure(status.lastError) ?? undefined;
      }
      log.warn('即时对话云端任务已失败', { charId: pending.charId, uuid: pending.uuid, reason });
      await failInstantChatPending(pending.charId, pending.uuid, reason ?? '生成失败（云端没记下原因）');
    } else {
      // 「取不回」的结论 = 行没了 **且账本读到了、里面确实没有这一轮**。账本这一步
      // 没读成（null）的话，结论就建立在一次失败的网络读上——等下一跳再问，
      // 别把一次抖动判成生成失败（用户会重发、再烧一轮，随后补收又把原回复放出来）。
      if (entries === null) {
        log.warn('即时对话云端那行已经没了，但账本没读成——这一跳不下结论', { charId: pending.charId, uuid: pending.uuid });
        continue;
      }
      // gone 不都是「发成功后行被删」：skip-push（模型空输出 / 纯拒答 / 只做副作用）的
      // 一次性行同样被上游当成功消费删掉，worker 在那一刻写过 chat_fail。不读的话给
      // 用户的解释是「云端已处理但回复没能取回」——把「没生成出来」说成了「取不回」。
      const reason = await readInstantChatFailReason(pending.charId, pending.uuid);
      log.warn('即时对话云端那行已经没了，回复也取不回', { charId: pending.charId, uuid: pending.uuid, reason });
      await failInstantChatPending(pending.charId, pending.uuid, reason);
    }
  }
  scheduleNextInstantChatStatusCheck();
};

/**
 * 云端 chat_fail 留痕的一次点名读，翻成给用户看的人话；读不到 / uuid 对不上 / 网络
 * 失败都返回 undefined（这是提示通道，绝不硬失败）。completed 和 gone 两个分支共用：
 * worker 在 fire 收尾失败、过期跳过、以及 skip-push（空输出）三处都会留痕。
 * 记录认 uuid：读到的是别轮的（比如上一轮失败的陈痕）就当没有，报笼统原因。
 *
 * `rowLastError` 是上游写在任务行上的那份（有就传）。两份记的是同一跳，各有各的长处：
 * chat_fail 认得 `empty-generation` 这类只有 SullyOS 这边定义的机器码，行上那份则带着
 * `pushStatus`——推送服务回的状态码只有上游发 push 的那一步知道，worker 的 fire 收尾
 * 钩子上读不到。所以原因用 chat_fail 的，机读字段以行上那份打底。
 */
const readInstantChatFailReason = async (
  charId: string,
  uuid: string,
  rowLastError?: RemoteTaskLastError | null,
): Promise<string | undefined> => {
  try {
    const raw = await ActiveMsgClient.readClientStateValue(
      amsgStateNamespace(charId), AMSG_CHAT_FAIL_KEY,
    );
    const record = parseChatFailRecord(raw);
    if (record?.uuid !== uuid) return undefined;
    return describeInstantChatFailure(
      {
        ...(rowLastError ?? {}),
        at: new Date(record.at).toISOString(),
        reason: record.reason,
        // worker 那份写的是 fire 抛错时错误对象上的 code，跟行上那份同源同义；
        // 它没写（老 worker / 这一档本来就没有 code）时沿用行上那份。
        ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      },
      record.retryCount,
    ) ?? undefined;
  } catch (e) {
    log.warn('即时对话失败原因取不到（报个笼统的）', { uuid, error: e });
    return undefined;
  }
};

// ─── 订阅变化标记（SW 写，这里读/清）────────────────────────────────────────
// 浏览器换掉推送订阅时 SW 的 pushsubscriptionchange 会往 ActiveMsg 库 kv store 写
// 一条固定 key 的标记（见 worker/sw-keep-alive.ts，key 与记录形状两边必须一致）。
// 这里在启动 / 收到 SW 通知时消费它：把新订阅登记到 worker 上那一份用户级订阅
// （ActiveMsgClient.registerPushSubscription），成功才清标记，失败留着下次再试。
// 一次覆盖写就覆盖了全部任务——包括角色自排的那些客户端不知道的任务。

export const PUSH_SUBSCRIPTION_CHANGED_KV_ID = 'push_subscription_changed_v1';
const ACTIVE_MSG_DB_NAME = 'ActiveMsg';
const ACTIVE_MSG_KV_STORE = 'kv';

/**
 * 不带版本号打开 ActiveMsg 库（跟着现有版本走，永不触发升级/降级冲突）。
 * 打开前先让 ActiveMsgStore 把 schema 建到当前版本——对一个不存在的库做无版本号
 * open 会建出没有任何 store 的 v1 空壳，谁先按版本升级谁说了算，kv 可能就没了。
 * 用完即关：这是一条一次性的旁路连接，别跟单例连接池抢着常驻（连接风暴前科见
 * activeMsgStore.ts 注释）。
 */
const withActiveMsgKv = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  await ActiveMsgStore.getGlobalConfig();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ACTIVE_MSG_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(ACTIVE_MSG_KV_STORE, mode);
      const request = run(tx.objectStore(ACTIVE_MSG_KV_STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error || request.error);
      tx.onabort = () => reject(tx.error || new Error('ActiveMsg kv tx aborted'));
    });
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
};

const hasPushSubscriptionChangeMarker = async (): Promise<boolean> =>
  Boolean(await withActiveMsgKv('readonly', (store) => store.get(PUSH_SUBSCRIPTION_CHANGED_KV_ID)));

const clearPushSubscriptionChangeMarker = async (): Promise<void> => {
  await withActiveMsgKv('readwrite', (store) => store.delete(PUSH_SUBSCRIPTION_CHANGED_KV_ID));
};

/**
 * 有「订阅已变化」标记就把新订阅登记上去；返回值只为单测断言。
 *   - 'no-marker'：没有标记（或读标记本身失败——那就等下次，别为一句自检拦启动）；
 *   - 'refreshed'：登记成功，标记已清；
 *   - 'kept'：抛错，标记保留，下次启动或下次 SW 通知再试。
 */
export const refreshPushSubscriptionIfMarked = async (): Promise<'no-marker' | 'refreshed' | 'kept'> => {
  let marked = false;
  try {
    marked = await hasPushSubscriptionChangeMarker();
  } catch (e) {
    log.warn('读取订阅变化标记失败，跳过本次订阅自检', { error: e });
    return 'no-marker';
  }
  if (!marked) return 'no-marker';

  try {
    await ActiveMsgClient.registerPushSubscription();
    await clearPushSubscriptionChangeMarker();
    log.info('订阅变化已登记到 worker');
    return 'refreshed';
  } catch (e) {
    log.warn('登记新的推送订阅失败，标记保留下次再试', { error: e });
    // 订阅换了却登记不上去 = 之后所有到点推送都石沉大海，而用户这侧一点感觉都没有
    // （角色就是不说话了）。只报「发生了」，错误原文里可能带 push endpoint，不带。
    trackEvent('2.0推送订阅自检失败');
    return 'kept';
  }
};

const handleDeepLink = () => {
  const currentUrl = new URL(window.location.href);
  const charId = currentUrl.searchParams.get('activeMsgCharId');
  const openApp = currentUrl.searchParams.get('openApp');

  if (openApp === 'chat' && charId) {
    window.dispatchEvent(new CustomEvent('active-msg-open', {
      detail: { charId },
    }));
  }

  // 参数只要出现过就从地址栏清掉，不管齐不齐——角色 id 留在 URL 里，
  // 收藏、分享、截图都会把它带出去。统计侧另有 data-exclude-search 兜底
  // （见 utils/analytics.ts），这里管的是地址栏本身。
  if (charId !== null || openApp !== null) {
    currentUrl.searchParams.delete('openApp');
    currentUrl.searchParams.delete('activeMsgCharId');
    // Keep same-page navigation markers (for example the browser back guard)
    // while removing only the consumed deep-link parameters from the URL.
    window.history.replaceState(window.history.state, '', currentUrl.toString());
  }
};

export const ActiveMsgRuntime = {
  async init() {
    if (initialized) return;
    initialized = true;

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        const type = event.data?.type;
        if (type) {
          activeMsgTrace('runtime-sw-message', {
            type,
            sessionId: event.data?.sessionId,
            charId: event.data?.charId,
          });
        }
        if (type === 'active-msg-received') {
          void flushInboxToChat('SW通知');
          return;
        }

        // SW 的 pushsubscriptionchange 写完标记后会通知一声：页面开着就立刻消费，
        // 不用等下次启动。真正的判定/清理都在 refreshPushSubscriptionIfMarked 里，
        // 通知丢了也没关系（启动兜底会再查一遍标记）。
        if (type === 'active-msg-subscription-change') {
          void refreshPushSubscriptionIfMarked();
          return;
        }

        // 即时对话终态失败的直发告知（worker 判死那一刻推的 error push）：当场收尾，
        // 不用等 60s 点名。metadata 对不上号的在里面被静默略过。
        if (type === 'active-msg-error') {
          void handleInstantErrorPushMessage(event.data);
          return;
        }

        // 云端后台任务跑完送回来的结果（worker 的 emitResult）。这里是「推送直达」那条腿；
        // 另一条腿是上线补收（drainOutbox），两边指的是同一个分发口。销账不在这里做——
        // 推来的这一份服务端账本上也有一行，等补收那条路照常划掉。所以同一条结果被消化
        // 两次是常态，两条腿还可能同时在跑（推送刚到、页面正好回到前台）：分发口自己排队
        // 串行（见 amsgResults），handler 各自保证重复消化不改坏数据。
        if (type === 'active-msg-result') {
          void dispatchAmsgResult(event.data?.payload);
          return;
        }

        if (type === 'REI_AMSG_PUSH') {
          const subEvent = event.data?.event;
          const payload = event.data?.payload;

          if (subEvent === 'rei-amsg-multipart-expired') {
            logAmsg.warn('multipart expired', payload);
            window.dispatchEvent(new CustomEvent('active-msg-error', {
              detail: { message: describeMultipartFailure(payload?.reason) },
            }));
          }
          return;
        }

        if (type === 'active-msg-open') {
          // 先把 inbox 落库再广播, 用户回到界面时消息已经在了.
          void (async () => {
            await flushInboxToChat('点通知进入');
            window.dispatchEvent(new CustomEvent('active-msg-open', {
              detail: { charId: event.data?.charId },
            }));
          })();
        }
      });
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        // 切走也记一笔。排「消息在收件箱躺了很久」时要回答的是「那段时间页面在干嘛」，
        // 而只记「回来了」的话，前面那段空白到底是页面没在跑、还是在跑但没人喊它，
        // 事后分不出来。
        activeMsgTrace('runtime-page-visibility', { state: document.visibilityState });
        if (document.visibilityState !== 'visible') return;
        handlePageBecameVisible();
      });
      // 冷启动那一下（点通知才把 App 拉起来）没有 visibilitychange 可听，这里补一次：
      // 不补的话「回到前台的时刻」一直是 0，从通知进来的第一条判不出「送达时人不在」。
      if (document.visibilityState === 'visible') notePageBecameVisible();
    }

    // 浏览器把后台页面冻起来 / 解冻。冻结期间 JS 完全不跑，SW 喊过来的消息会排队等
    // 解冻——这跟「SW 压根没喊」在事后看长得一模一样（页面侧都是一段空白），只有这两
    // 个事件能把它们分开。移动端和 iOS 的 PWA 冻得尤其积极。
    // 不是所有浏览器都发这两个事件，收不到就当没有，不影响其它判断。
    if (typeof document !== 'undefined') {
      document.addEventListener('freeze', () => {
        activeMsgTrace('runtime-page-freeze');
      });
      document.addEventListener('resume', () => {
        activeMsgTrace('runtime-page-resume');
      });
    }

    // 页面「刚活过来」的那一下，立刻数一眼收件箱，不用干等守望的下一跳。
    // pageshow：iOS 把 App 挂起后恢复、以及 bfcache 前进/后退时会发，而 visibilitychange
    //   不一定发——线上记录里就有「只见进后台、不见回前台」的断档。
    // focus：切回窗口或标签页。
    // 这两个可能跟 visibilitychange 撞在一起重复触发，但收件箱是「取出即删」、冲刷又都
    // 走同一条串行链，重复最多是多数一次个数，不会把同一条消息演两遍。
    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', () => { void sweepLocalInbox(); });
      window.addEventListener('focus', () => { void sweepLocalInbox(); });
    }

    // 受理一轮即时对话之后（useChatAI 那边写记录 + 广播），把点名周期排上。
    if (typeof window !== 'undefined') {
      window.addEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT, () => scheduleNextInstantChatStatusCheck());
    }

    // 订阅自检兜底：后台期间 SW 收到 pushsubscriptionchange 写了标记、而通知丢失
    // （页面没开着）时，启动这里把它消费掉。fire-and-forget——它要打网络请求，
    // 不能拦着下面的 inbox flush。
    void refreshPushSubscriptionIfMarked();

    // SW→页面通道体检：拍一张注册关系的快照，再用推送真正走的那条路探一次通不通。
    // 这条通道断了之后主动消息不会消失、只会慢几十秒（兜底轮询还在捞），表面上一切
    // 正常，所以必须主动去测——等用户来报的时候，它可能已经坏了好几天。
    // fire-and-forget：探测要等回信，不能拦着下面的冲刷。
    void (async () => {
      try {
        const registration = await captureSwRegistrationSnapshot();
        activeMsgTrace('runtime-sw-registration', { ...registration });
        const probe = await probeSwChannel();
        activeMsgTrace('runtime-sw-channel-probe', { ...probe });
      } catch (e) {
        log.warn('SW 通道体检没做成（不影响功能）', { error: e });
      }
    })();

    // 启动兜底: 先 flush 落库 (含上次被杀进程时卡在 inbox 的消息).
    await flushInboxToChat('启动');
    // 上次不在线时丢掉的推送去账本上捞回来。**这一趟无条件跑**：定时主动消息的推送
    // 丢了之后，本地不会留下任何「有条消息没到」的痕迹，账本是唯一的线索来源
    // （见 catchUpMissedPushes）。没配 Worker 的用户在里面就返回了，不打网络。
    void catchUpMissedPushes('startup');
    // 顺手把后端更新一下（构建换了、或离上次够久才真的发）：版本对不上就直接更新，跟用户
    // 点「更新 Worker」一样；对得上就敲一下让它按指纹自查。前端刚更新往往意味着后端也该更新，
    // 不必干等它 cron 上那几个小时。没配 Worker 的用户在里面就返回了。
    void requestStartupUpdateCheck();
    // 上次会话发出去、回来前进程就没了的那一轮：指示灯靠 localStorage 记录挂回来，
    // 内容靠云端点名那一步补回来（它自带补收，还顺手把 60s 的点名周期排上）。
    if (listInstantChatPendings().length > 0) {
      void runInstantChatStatusCheck();
    }
    void drainPendingDiaries(loadRealtimeConfigFromLocalStorage(), (charId) => {
      window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId } }));
    });
    // 收件箱守望开跑。放在最后：上面那趟启动冲刷已经把积压清干净了，这里接管后续。
    scheduleLocalInboxWatch();
    handleDeepLink();
  },
};
