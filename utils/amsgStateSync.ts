/**
 * 主动消息 2.0「满血」的前端状态同步层。
 *
 * 打脏入口不止聊完一轮（useChatAI）：改人设 / 改记忆 / 删改消息 / 面板取消任务这些会
 * 改变 fire_pack 内容的落库路径也会调 markAmsgStateDirty（大多汇在 OSContext 的
 * updateCharacter 落库点），打脏后立即把所有脏角色的 fire_pack 批量上传 worker 的
 * client_state；切后台（visibilitychange→hidden）也冲刷一次——iOS 只给几秒存活窗口，
 * 必须一次请求写完。
 *
 * 只对「已排程 AI 模式 amsg2 任务」的角色生效，其余 markDirty 直接忽略。
 *
 * 脏标记有一份极轻量的 localStorage 底账（只存 charId 数组，不存快照本体）：打脏时写入、
 * 上传成功后移除。请求还没落地（在飞、或躺在退避重排里）就被杀进程的话，下次启动 OSContext 调 resumePendingAmsgStateSync
 * 按底账重建快照补传一次——否则那次改动云端永远不知道，角色到点带旧上下文说话。
 *
 * 上传失败会**退避重试**，不能一失败就把快照丢掉：云端那份 fire_pack 是到点时角色
 * 唯一的上下文来源，刷不上去就意味着角色带着旧上下文发消息（提的「最近聊的事」其实是
 * 上一次同步成功时的状态，顺带 lastUserMessageAt 也旧，worker 侧防穿帮闸的锚点判定
 * 跟着失真）。而最容易失败的恰恰是切后台那次冲刷，也正是「睡前聊完 → 关 App → 凌晨
 * 触发」这条最常见的路径。
 *
 * 它和排程时那次上传的区别只在失败的处理方式：排程那次是硬要求（失败就让整个排程失败，
 * 见 activeMsgClient 的 putClientStateOrThrow），这里退避重试几次，实在传不上去就等
 * 下一轮聊天重新打脏标记。
 *
 * 云端还有一份 tool_config（工具凭据 / MCP 服务器 / 代理地址），走的是同一套退避 + 底账，
 * 入口是 syncAmsgToolConfig（见文件下半部分）。它不像 fire_pack 那样每轮聊天重传，
 * 所以那一次传丢了就得靠自己补。
 */

import { APIConfig, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { ActiveMsgClient, isLlmCredentialsReady, owesInstantChatReply } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { stampStateUpdatedAt } from './amsgStateClock';
import { hasActiveAiTask } from './amsg2Tasks';
import { AmsgChatPresence, CHAT_PRESENCE_HEARTBEAT_MS } from './amsgChatPresence';
import {
  buildCharChatCredRow,
  buildCharEmotionCredRow,
  knownCredIds,
  parseCharCredId,
  pickChangedCredRows,
  type LlmCredentialRow,
} from './amsgLlmCredentials';
import { trackEvent } from './analytics';
import { DB } from './db';

/** 失败重试的退避起点，逐次翻倍（30s → 60s → 120s）。 */
const RETRY_BASE_MS = 30_000;
/**
 * 角色欠着即时对话回复时，它的快照挂起不传（见 flushAmsgState 里的挂起段）；
 * 隔这么久再来看一眼账销了没有——销账走的是「回复到了 / 判失败」那几条路，
 * 它们不会替这边触发冲刷。
 */
const INSTANT_DEFER_RECHECK_MS = 60_000;
/** 连续失败几次后放手，等下一轮聊天重新打脏标记——避免离线时无限重排。 */
const MAX_RETRIES = 3;
const HEADER = '[AmsgStateSync]';

export interface AmsgSyncSnapshot {
  char: CharacterProfile;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig?: RealtimeConfig;
}

// charId → 最新快照。同角色多轮聊天只留最后一份，flush 永远用最新状态拼模板。
const dirty = new Map<string, AmsgSyncSnapshot>();
const stateEpochs = new Map<string, number>();
const snapshotEpochs = new WeakMap<AmsgSyncSnapshot, number>();
const isCurrentSnapshot = (snapshot: AmsgSyncSnapshot) =>
  snapshotEpochs.get(snapshot) === (stateEpochs.get(snapshot.char.id) ?? 0);

/** 停用/恢复使旧队列失效，旧请求的失败回调也不能重新塞回去。 */
export const discardAmsgPendingState = (charId: string): void => {
  stateEpochs.set(charId, (stateEpochs.get(charId) ?? 0) + 1);
  dirty.delete(charId);
  writePendingCharIds(readPendingCharIds().filter(id => id !== charId));
};
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let lifecycleBound = false;
let retryCount = 0;
/** 「退避打光了还是没传上去」每次会话只上报一次。 */
let staleStateReported = false;

// ─── 打脏后的合并窗口 ───
// 一轮聊天不止打一次脏，而且**不在同一个 tick**：收尾在 finally 里、情绪 buff 落库在
// 副 API 回来后的事件回调里、记忆写入又是一拨；用户连删几条消息更是一次操作一个 tick。
// 微任务合并只能收拢同 tick 的连环调用，上面这些各自触发一次「重读 200 条近史 + 重建
// 系统提示词 + gzip + 加密 + PUT ~40KB」的完整冲刷。这里给一个短的固定合并窗口：
// 第一次打脏起 1.5s 内的都并进同一次上传。数据丢失窗口不回退——底账（persistDirtyMark）
// 在打脏那一刻就写了，切后台有 visibilitychange 的立即冲刷，杀进程有启动补传。
/** 打脏合并窗口（固定窗口不顺延：持续打脏也保证 1.5s 内必冲一次）。 */
export const FLUSH_DEBOUNCE_MS = 1_500;
let flushDebounceTimer: ReturnType<typeof setTimeout> | null = null;
/** 冲刷进行中又有人打脏，这次传完得再跑一轮（丢弃的话那份快照就永远躺在队列里了）。 */
let reflushRequested = false;

const queueFlush = () => {
  if (flushDebounceTimer != null) return;
  flushDebounceTimer = setTimeout(() => {
    flushDebounceTimer = null;
    void flushAmsgState('dirty');
  }, FLUSH_DEBOUNCE_MS);
};

// ─── 脏标记轻量持久化 ───
// 内存队列在「打脏 → 请求还没落地（在飞或在退避重排里）就被杀进程」时会整个蒸发，
// 重开 App 也不补传。这里只把 charId 记进 localStorage 当底账
// （快照本体下次启动从 DB 重建，存本体只会留一份过期数据）。
export const AMSG2_PENDING_SYNC_LS_KEY = 'amsg2_pending_sync_char_ids';

const readPendingCharIds = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(AMSG2_PENDING_SYNC_LS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const writePendingCharIds = (ids: string[]) => {
  // 存储满 / 隐私模式写不进去就算了：底账只是兜底，失败不能影响内存队列正常同步。
  try {
    if (ids.length === 0) localStorage.removeItem(AMSG2_PENDING_SYNC_LS_KEY);
    else localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify(ids));
  } catch { /* 见上 */ }
};

const persistDirtyMark = (charId: string) => {
  const ids = readPendingCharIds();
  if (!ids.includes(charId)) writePendingCharIds([...ids, charId]);
};

/**
 * 一批快照处理完（上传成功 / 判定无处可传）后清底账。
 * 只清「内存里已经不脏」的：上传期间同角色又被打脏的话，新标记不能被这批的收尾抹掉。
 */
const prunePersistedMarks = (batch: AmsgSyncSnapshot[]) => {
  const settled = new Set(batch.map((s) => s.char.id).filter((id) => !dirty.has(id)));
  if (settled.size === 0) return;
  writePendingCharIds(readPendingCharIds().filter((id) => !settled.has(id)));
};

const bindLifecycleListener = () => {
  if (lifecycleBound || typeof document === 'undefined') return;
  lifecycleBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && dirty.size > 0) {
      void flushAmsgState('hidden');
    }
  });
};

/**
 * 打脏的两种理由。
 *
 * 分开是因为下面那道门对它们不是一个答案：门问的是「这个角色有没有待触发的 AI 任务」，
 * 没有就不必把 fire_pack 传上去（省一次几十 KB 的上行）。对「内容更新了」这是对的——
 * 反正没人会读那份旧的，下次真要用时排程会重传一份新的。
 *
 * 但「用户删掉了内容」不一样：云端那份 fire_pack 里存着最近 30 条对话原文，用户在
 * 聊天里把历史清了，那份原文却因为这道门被留在 D1 里，而且角色命名空间在 worker 侧
 * 没有 TTL、之后也不会再有人来刷新它——那就是永久留着。所以这种脏要么刷新，要么清掉，
 * 不能悄悄丢掉。
 */
export type AmsgDirtyReason =
  /** 内容变了，云端那份该跟着刷新（默认）。 */
  | 'refresh'
  /** 用户删掉了内容，云端那份必须作废：刷不上去就把它清掉。 */
  | 'invalidate';

/** 一轮聊完（或角色资料变更后）打脏标记；非 amsg2 AI 任务角色直接忽略。 */
export const markAmsgStateDirty = (
  snapshot: AmsgSyncSnapshot,
  reason: AmsgDirtyReason = 'refresh',
) => {
  const config = snapshot.char.activeMsg2Config;
  if (!config?.enabled || !hasActiveAiTask(config)) {
    if (reason === 'invalidate') void invalidateCharCloudState(snapshot.char.id);
    return;
  }

  const queuedSnapshot = { ...snapshot };
  snapshotEpochs.set(queuedSnapshot, stateEpochs.get(snapshot.char.id) ?? 0);
  dirty.set(snapshot.char.id, queuedSnapshot);
  persistDirtyMark(snapshot.char.id);
  bindLifecycleListener();
  queueFlush();
};

/**
 * 把云端那份角色上下文清掉。用在「用户删了内容、而这个角色又轮不到重传」的时候。
 *
 * 只清 client_state，不碰凭据行、不碰任务表：这不是在注销一个角色，只是让云端那份
 * 停在旧内容上的快照消失。清完不补——真要用的时候（排程、即时对话）都会重新传一份，
 * 那份才是带着用户新意愿的。
 *
 * 尽力而为：清不掉只记一行。这条路是收拾残留，失败不该打断用户正在做的事（清空聊天
 * 记录本身已经在本地生效了）。
 */
export const invalidateCharCloudState = async (charId: string): Promise<void> => {
  try {
    const workerUrl = (await ActiveMsgStore.getGlobalConfig()).workerUrl?.trim();
    if (!workerUrl) return;
    await ActiveMsgClient.clearCharClientState(charId);
  } catch (error) {
    console.warn(`${HEADER} 作废云端角色上下文失败（本地删除不受影响）`, charId, error);
  }
};

/**
 * 全局素材变了（表情库这类不属于某个角色的东西）：每个角色的 fire_pack 里都烤着一份
 * 打包那会儿的快照，所以逐个打脏。门在 markAmsgStateDirty 里，没开主动消息的角色自己会被筛掉。
 *
 * 表情库尤其要紧：角色到点发的 [[SEND_EMOJI]] 引用的是包里那份清单，用户删了 / 改了名字
 * 之后云端还照着旧清单说话，客户端反查不到就只能落降级文本气泡。
 */
export const markAmsgStateDirtyForAll = (scope: {
  characters: CharacterProfile[];
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
}) => {
  for (const char of scope.characters) {
    markAmsgStateDirty({
      char,
      userProfile: scope.userProfile,
      groups: scope.groups,
      realtimeConfig: scope.realtimeConfig,
    });
  }
};

/**
 * 把没传上去的快照放回待传队列。
 * 同角色已经有更新的快照时保留新的——旧快照的唯一价值就是「比云端那份新」，
 * 已经被更新的一份取代后再塞回去只会让下次上传倒退。
 */
const requeue = (batch: AmsgSyncSnapshot[]) => {
  for (const snapshot of batch) {
    if (isCurrentSnapshot(snapshot) && !dirty.has(snapshot.char.id)) dirty.set(snapshot.char.id, snapshot);
  }
};

/** 把所有脏角色的 fire_pack 批量上传。失败退避重排，快照留在队列里等下次。 */
export const flushAmsgState = async (reason: string): Promise<void> => {
  // 这次冲刷把队列带走了，还挂着的合并窗口就不用再响一次（响了也只是空跑一趟）。
  // 顺手把句柄归零：不归零的话，外部触发的冲刷（hidden / resume / 测试清理）之后
  // 队列里再打的脏会以为已有窗口在等，实际那个 timer 早没了。
  if (flushDebounceTimer != null) { clearTimeout(flushDebounceTimer); flushDebounceTimer = null; }
  // 工具凭据欠着的话顺手一起补：它和 fire_pack 一样是「云端那份过时了」，
  // 而且冲刷时机（切后台 / 聊完一轮）正是网络多半又通了的时候。
  void runToolConfigSync(`flush:${reason}`);
  // LLM 凭据行同理，而且它欠着的后果更硬：云端那份还是旧 Key 的话，已排程的任务
  // 到点全部 401。
  void runLlmCredentialSync(`flush:${reason}`);
  // 已经有一次在飞：这次的脏数据留在队列里，等那次落地后由 finally 补跑（直接 return
  // 的话，上传期间打的脏就此搁浅，等不到任何人来传）。
  if (flushing) { reflushRequested = true; return; }
  // 队列空 = 没有欠着的快照，之前那串失败也就翻篇了，退避计数跟着归零。
  if (dirty.size === 0) { retryCount = 0; return; }
  if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
  // 欠着即时对话回复（含 POST 还在飞、202 未回）的角色这次挂起不传：那一轮的 fire_pack
  // 是 POST /instant-chat 带上去的、多一段 chat（worker 到点全靠它拿这轮的对话），
  // 常规重建的包没有 chat 段，现在覆盖上去的话 worker 到点只会硬失败（fire_pack 里
  // 没有 chat 段）。判定用 activeMsgClient 那份共用的 owesInstantChatReply——排程那条路
  // （scheduleCharacterTask 建任务前也要写 fire_pack）跟这里必须是同一把尺。
  // 快照连底账一起留在队列里，销账后的下一次冲刷（含下面那个定时回看）照传不误。
  const deferredIds = new Set([...dirty.keys()].filter(owesInstantChatReply));
  if (deferredIds.size === dirty.size) {
    // 全都欠着回复：这次一个都传不了，排个回看就走（retryTimer 刚在上面清空过，直接排）。
    scheduleDeferredRecheck();
    return;
  }
  flushing = true;
  const batch = [...dirty.values()].filter((snapshot) => !deferredIds.has(snapshot.char.id));
  try {
    const globalConfig = await ActiveMsgStore.getGlobalConfig();
    if (!globalConfig.workerUrl?.trim()) {
      // 没配 worker = 这些快照没有去处，不是「传失败」，清掉即可（连底账一起，
      // 挂起的那些同样没有去处）。
      const all = [...dirty.values()];
      dirty.clear();
      prunePersistedMarks(all);
      return;
    }

    const currentBatch = batch.filter(isCurrentSnapshot);
    if (!currentBatch.length) return;
    for (const snapshot of currentBatch) dirty.delete(snapshot.char.id);
    await ActiveMsgClient.syncCharFirePacks(currentBatch.map((snapshot) => ({
      char: snapshot.char,
      isCurrent: () => isCurrentSnapshot(snapshot),
      config: snapshot.char.activeMsg2Config!,
      userProfile: snapshot.userProfile,
      groups: snapshot.groups,
      realtimeConfig: snapshot.realtimeConfig,
    })));
    retryCount = 0;
    // 传上去了才清底账；失败路径不清——底账就是给「重试没等到就被杀」兜底的。
    prunePersistedMarks(batch);
  } catch (error) {
    requeue(batch);
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * 2 ** retryCount;
      retryCount += 1;
      console.warn(`${HEADER} flush(${reason}) 失败，${Math.round(delay / 1000)}s 后重试（第 ${retryCount}/${MAX_RETRIES} 次）`, error);
      if (retryTimer != null) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { void flushAmsgState('retry'); }, delay);
    } else {
      // 重排到头了（多半是离线）。快照留在队列里：下次打脏标记 / 切后台都会再试，
      // 在那之前云端仍是上一份，角色到点会带旧上下文——所以这条要吼出来。
      console.error(`${HEADER} flush(${reason}) 连续 ${MAX_RETRIES} 次失败，云端 fire_pack 仍是上一份（角色到点会用旧上下文）`, error);
      // 用户这一侧完全无感：不报错、不提示，只是角色到点说的话对不上最近发生的事。
      // 每次会话最多报一次（一轮退避打完才会走到这儿，但一次会话可以有好几轮）。
      if (!staleStateReported) {
        staleStateReported = true;
        trackEvent('2.0云端状态同步失败');
      }
      retryCount = 0;
    }
  } finally {
    flushing = false;
    if (reflushRequested) {
      reflushRequested = false;
      // 两种情况不用补跑：队列空（上面那批把它一起带走了）；已经排了退避重传
      // （重传本来就带上队列里的全部快照，此刻再打一次只是立刻重蹈覆辙，还白吃一次退避额度）。
      // 失败也不是一律不补跑：退避打光那条路不留 timer，此时飞行中打的脏会当场补跑一次
      // 并重开一轮退避——有新数据值得再试，且退避上限管着，不会变成死循环。
      if (dirty.size > 0 && retryTimer == null) void flushAmsgState('reflush');
    }
    // 还有挂起（欠即时对话回复）的快照时排个回看，销账后把它们传掉。
    if (deferredIds.size > 0 && retryTimer == null) scheduleDeferredRecheck();
  }
};

/** 排一个「即时对话销账后回来传挂起快照」的回看。占用 retryTimer 这一个槽。 */
const scheduleDeferredRecheck = () => {
  retryTimer = setTimeout(() => { void flushAmsgState('instant-chat-deferred'); }, INSTANT_DEFER_RECHECK_MS);
};

/**
 * 启动补传：上次会话打过脏、但没等到上传就被杀进程的角色，按 localStorage 底账重建
 * 快照再传一次。OSContext 在启动数据加载完成后调用，characters 传的就是刚从 DB 读回
 * 的全量角色（快照数据源 = DB），上传复用 markDirty → flush → syncCharFirePacks 原路。
 *
 * 残留的 charId 可能已经删角色 / 关掉 amsg2 / 任务全发完了——这些直接静默清除底账：
 * 找不到的角色没得传，markDirty 的门拒掉的角色也不该再赖在底账里。
 */
export const resumePendingAmsgStateSync = (scope: {
  characters: CharacterProfile[];
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig?: RealtimeConfig;
  /** 启动时那份聊天 API 配置；缺了就补不了 LLM 凭据行的欠账（其余照常补）。 */
  apiConfig?: APIConfig;
}) => {
  // 工具凭据的欠账也在这儿补。底账只记「欠着一次」，凭据本体不落 localStorage
  // （那等于把 token 又抄一份到别的地方），补传用启动时这份最新配置——它本来就是
  // 云端此刻该有的那一份。重试沿用原保存版本，已冲突的版本等待用户核对后新保存。
  if (hasPersistedToolConfigMark()) {
    const saved = readToolConfigSyncVersion();
    queueToolConfigSnapshot(scope.realtimeConfig, saved?.updatedAt ?? stampStateUpdatedAt(), saved?.conflict === true);
  }
  // 每次启动对齐主 API，覆盖下线前留下的副 API；失败仍沿用欠账与退避重试。
  if (scope.apiConfig) syncAmsgLlmCredentials(scope.apiConfig);

  const pending = readPendingCharIds();
  if (pending.length === 0) return;

  // 先整个清掉：还该传的角色下面 markDirty 会把 id 重新写回去，不该传的就此了账。
  writePendingCharIds([]);
  for (const charId of pending) {
    const char = scope.characters.find((c) => c.id === charId);
    if (!char) continue; // 角色已删除，静默跳过
    markAmsgStateDirty({
      char,
      userProfile: scope.userProfile,
      groups: scope.groups,
      realtimeConfig: scope.realtimeConfig,
    });
  }
  // 当场冲刷，不等 markDirty 排的那个微任务——这份欠账已经拖了一次进程生死了。
  if (dirty.size > 0) void flushAmsgState('resume');
};

// ─── 同角色活跃会话租约（Heartbeat）───
// 一轮真实用户消息进入生成流程时启动：立即写一次 chat_presence，之后每 15s 续租，
// 成功/失败/中断后停止本地续租，远端值靠 45s TTL 自然失效。它只代表「正在和这个角色
// 交互」，不是 App 在线状态——切后台就停续租，别让一个闲置可见标签页无限续租。

interface ChatPresenceLease {
  timer: ReturnType<typeof setInterval>;
  /** 本轮最新的「最近一条真实用户消息」时间戳；续租时读它，不吃闭包里的陈旧值。 */
  lastUserMessageAt: number | null;
}

// charId → 心跳租约。同一 char 只保留一个 timer（重入只刷新 lastUserMessageAt）。
const chatPresenceLeases = new Map<string, ChatPresenceLease>();

/**
 * 实时感知配置（工具凭据）改动后，把云端的两份状态一起对齐。
 *
 * 云端有两份东西依赖这套凭据，必须同进同退：
 *   1. tool_config —— 凭据本身；
 *   2. fire_pack 里的系统提示词 —— 它是**按当时的配置裁剪过**的，没配的工具连说明都不注入
 *      （见 chatPrompts 的 notionEnabled / feishuEnabled / searchEnabled 门控）。
 *
 * 只更前者会留下一个窗口：云端提示词还在教角色用 Notion 日记，凭据已经被关掉了，角色到点
 * 照着旧提示词调工具，拿回 not_configured。所以两个动作合成一个入口，调用方无法只做一半。
 *
 * 谁需要刷新由 markAmsgStateDirty 内部的门决定（没开 2.0 / 没有待触发 AI 任务的角色直接
 * 忽略），所以这里可以无脑把全部角色递进来。
 */
export const syncAmsgToolConfigAndPrompts = (
  realtimeConfig: RealtimeConfig,
  scope: { characters: CharacterProfile[]; userProfile: UserProfile; groups: GroupProfile[] },
) => {
  // 上传失败不打断保存：本地配置已经生效，云端那份由 syncAmsgToolConfig 自己退避重传，
  // 传不上去也留着底账等下次启动补（fire_pack 那种「下一轮聊天顺手带上」的便车，
  // tool_config 是坐不了的——冲刷只传 fire_pack）。
  syncAmsgToolConfig(realtimeConfig);
  for (const char of scope.characters) {
    markAmsgStateDirty({ char, userProfile: scope.userProfile, groups: scope.groups, realtimeConfig });
  }
  void flushAmsgState('tool-config-change');
};

// ─── 工具凭据（tool_config）的重试与底账 ───
// fire_pack 每轮聊天都会重传，掉一次下一轮就补上；tool_config 不吃这条便车——它只在
// 用户保存配置那一刻传一次，那一次失败就再没有人会补。而它偏偏是有对外副作用的一份：
// 用户删掉的 MCP 服务器、换掉的 token，云端还是旧的，worker 半夜照旧带着旧凭据直连。
// 所以这里给它配上和 fire_pack 同款的退避重试 + localStorage 底账。

export const AMSG2_PENDING_TOOL_CONFIG_LS_KEY = 'amsg2_pending_tool_config';
const TOOL_CONFIG_SYNC_VERSION_KEY = 'amsg2_pending_tool_config_version';

/** 待上传的那份配置。undefined 也是合法载荷（= 什么都没配），所以另用 flag 表示「欠着」。 */
let pendingToolConfig: RealtimeConfig | undefined;
let hasPendingToolConfig = false;
let toolConfigSyncing = false;
let pendingToolConfigVersion = 0;
let toolConfigConflict = false;
let toolConfigRetryCount = 0;
let toolConfigRetryTimer: ReturnType<typeof setTimeout> | null = null;

const writeToolConfigMark = (pending: boolean) => {
  // 存储满 / 隐私模式写不进去就算了：底账只是给「重试没等到就被杀」兜底的。
  try {
    if (pending) {
      localStorage.setItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY, '1');
      // 只存版本和冲突状态，凭据仍从原设置读取。
      localStorage.setItem(TOOL_CONFIG_SYNC_VERSION_KEY, JSON.stringify({ updatedAt: pendingToolConfigVersion, conflict: toolConfigConflict }));
    } else {
      localStorage.removeItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY);
      localStorage.removeItem(TOOL_CONFIG_SYNC_VERSION_KEY);
    }
  } catch { /* 见上 */ }
};

const hasPersistedToolConfigMark = (): boolean => {
  try { return localStorage.getItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY) === '1'; } catch { return false; }
};

const readToolConfigSyncVersion = (): { updatedAt: number; conflict: boolean } | null => {
  try {
    const saved = JSON.parse(localStorage.getItem(TOOL_CONFIG_SYNC_VERSION_KEY) || 'null');
    return Number.isSafeInteger(saved?.updatedAt) && saved.updatedAt > 0 ? saved : null;
  } catch { return null; }
};

const runToolConfigSync = async (reason: string): Promise<void> => {
  if (!hasPendingToolConfig || toolConfigSyncing || toolConfigConflict) return;
  toolConfigSyncing = true;
  // 记下这次传的是哪一份：上传期间用户又改了配置的话，清账不能把新的那份一起清掉。
  const snapshot = pendingToolConfig;
  const version = pendingToolConfigVersion;
  try {
    const globalConfig = await ActiveMsgStore.getGlobalConfig();
    if (!globalConfig.workerUrl?.trim()) {
      // 没配 worker = 这份凭据没有去处，不是「传失败」，连底账一起清掉。
      hasPendingToolConfig = false;
      pendingToolConfig = undefined;
      writeToolConfigMark(false);
      return;
    }
    await ActiveMsgClient.syncToolConfig(snapshot, { updatedAt: version });
    if (pendingToolConfigVersion === version) {
      hasPendingToolConfig = false;
      pendingToolConfig = undefined;
      writeToolConfigMark(false);
    }
    toolConfigRetryCount = 0;
  } catch (error) {
    if ((error as { code?: string })?.code === 'TOOL_CONFIG_CONFLICT') {
      if (pendingToolConfigVersion === version) {
        toolConfigConflict = true;
        writeToolConfigMark(true);
        console.warn(`${HEADER} 工具配置版本冲突，保留待同步状态，等待核对后重新保存。`);
        try { window.dispatchEvent(new CustomEvent('amsg-tool-config-conflict')); } catch { /* 非浏览器环境 */ }
      }
      return;
    }
    if (toolConfigRetryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * 2 ** toolConfigRetryCount;
      toolConfigRetryCount += 1;
      console.warn(`${HEADER} tool_config(${reason}) 上传失败，${Math.round(delay / 1000)}s 后重试（第 ${toolConfigRetryCount}/${MAX_RETRIES} 次）`, error);
      if (toolConfigRetryTimer != null) clearTimeout(toolConfigRetryTimer);
      toolConfigRetryTimer = setTimeout(() => { toolConfigRetryTimer = null; void runToolConfigSync('retry'); }, delay);
    } else {
      // 退避打光了（多半是离线）。底账留着：下次启动 / 下次冲刷继续补。
      console.error(`${HEADER} tool_config(${reason}) 连续 ${MAX_RETRIES} 次失败，云端仍是上一份工具配置（后台可能带着已被删掉的服务器或旧 token 调工具）`, error);
      toolConfigRetryCount = 0;
    }
  } finally {
    toolConfigSyncing = false;
    if (hasPendingToolConfig && pendingToolConfigVersion !== version) {
      if (toolConfigRetryTimer != null) { clearTimeout(toolConfigRetryTimer); toolConfigRetryTimer = null; }
      toolConfigRetryCount = 0;
      void runToolConfigSync('newer-config');
    }
  }
};

/**
 * 工具凭据上云的唯一入口（实时感知保存、MCP 配置变更、代理地址改动都走它）。
 * 立即传一次，失败退避重试，并在 localStorage 留底账等启动 / 下次冲刷补传。
 */
const queueToolConfigSnapshot = (realtimeConfig: RealtimeConfig | undefined, updatedAt: number, conflict: boolean): void => {
  // 保存独立快照，同一个设置对象被原地修改也不能改变正在发送的版本。
  pendingToolConfig = realtimeConfig === undefined ? undefined : structuredClone(realtimeConfig);
  pendingToolConfigVersion = updatedAt;
  toolConfigConflict = conflict;
  hasPendingToolConfig = true;
  toolConfigRetryCount = 0;
  if (toolConfigRetryTimer != null) { clearTimeout(toolConfigRetryTimer); toolConfigRetryTimer = null; }
  writeToolConfigMark(true);
  if (conflict) {
    try { window.dispatchEvent(new CustomEvent('amsg-tool-config-conflict')); } catch { /* 非浏览器环境 */ }
  }
  void runToolConfigSync('change');
};

export const syncAmsgToolConfig = (realtimeConfig: RealtimeConfig | undefined): void => {
  queueToolConfigSnapshot(realtimeConfig, stampStateUpdatedAt(), false);
};

// ─── LLM 凭据行（credRefs）的重传 ───
//
// 云端那张凭据表和 tool_config 处境一样：只在用户改配置那一刻传一次，那一次丢了就再没
// 人补。而它比 tool_config 更要命——传不上去意味着**已排程的任务到点还在用旧 Key**，
// 换 Key 之后每条主动消息都是 401。所以退避重试 + localStorage 底账整套跟着 tool_config
// 那份走，连触发时机（每次冲刷顺手补一次、启动时按底账补一次）都是同一批。
//
// 重算哪几行：底账里记着的那些（= 真的用过的那些）。只重算「值是持久化配置的纯函数」的
// 两种用途——`chat`（定时主动消息）与 `emotion`（情绪评估）。`instant` 那一行不在这里
// 重算：它的 model 是每一轮聊天的请求体终值（claude 系开思考时带 -thinking 后缀），
// 靠这里的配置推不出来；那一行由每次发消息的路径自己按当轮终值覆盖（值没变就不发请求）。

export const AMSG2_PENDING_CRED_SYNC_LS_KEY = 'amsg2_pending_llm_creds';

/** 待重传用的那份聊天配置。凭据本体不落 localStorage，底账只记「欠着一次」。 */
let pendingCredApiConfig: APIConfig | undefined;
let hasPendingCredSync = false;
let credSyncing = false;
let credRetryCount = 0;
let credRetryTimer: ReturnType<typeof setTimeout> | null = null;

const writeCredSyncMark = (pending: boolean) => {
  // 存储满 / 隐私模式写不进去就算了：底账只是给「重试没等到就被杀」兜底的。
  try {
    if (pending) localStorage.setItem(AMSG2_PENDING_CRED_SYNC_LS_KEY, '1');
    else localStorage.removeItem(AMSG2_PENDING_CRED_SYNC_LS_KEY);
  } catch { /* 见上 */ }
};

/**
 * 按底账里记着的 credId，用当前配置重算出这几行现在该是什么值。
 * 角色已删 / 凭据配不齐的那些直接跳过——没得算，也不该拿一份残缺的去覆盖云端。
 */
export const buildCredentialRowsToResync = async (
  apiConfig: APIConfig,
  characters?: CharacterProfile[],
): Promise<LlmCredentialRow[]> => {
  const wanted = knownCredIds()
    .map(parseCharCredId)
    .filter((parsed): parsed is { charId: string; purpose: 'chat' | 'emotion' } =>
      !!parsed && (parsed.purpose === 'chat' || parsed.purpose === 'emotion'));
  const all = characters ?? await DB.getAllCharacters();
  // 备份恢复 / 换设备时可能没有本地凭据底账，仍需覆盖云端旧副 API。
  for (const char of all) {
    if (char.activeMsg2Config?.enabled && !wanted.some((item) => item.charId === char.id && item.purpose === 'chat')) {
      wanted.push({ charId: char.id, purpose: 'chat' });
    }
  }
  const byId = new Map(all.map((char) => [char.id, char]));
  const rows: LlmCredentialRow[] = [];
  for (const { charId, purpose } of wanted) {
    const char = byId.get(charId);
    if (!char) continue;
    const row = purpose === 'chat'
      ? buildCharChatCredRow(char, char.activeMsg2Config, apiConfig)
      : buildCharEmotionCredRow(charId, char.emotionConfig?.api, apiConfig);
    if (row) rows.push(row);
  }
  return rows;
};

const runLlmCredentialSync = async (reason: string): Promise<void> => {
  if (!hasPendingCredSync || credSyncing) return;
  credSyncing = true;
  // 记下这次算的是哪一份：上传期间用户又改了配置的话，清账不能把新的那份一起清掉。
  const snapshot = pendingCredApiConfig;
  try {
    const globalConfig = await ActiveMsgStore.getGlobalConfig();
    // 没配 Worker / 没有 API 快照时没有同步目标，清掉底账。
    if (!globalConfig.workerUrl?.trim() || !snapshot) {
      hasPendingCredSync = false;
      pendingCredApiConfig = undefined;
      writeCredSyncMark(false);
      return;
    }
    if (await isLlmCredentialsReady()) {
      const rows = await buildCredentialRowsToResync(snapshot);
      if (pickChangedCredRows(rows).length > 0) await ActiveMsgClient.putLlmCredentials(rows);
    }
    // 老 Worker 的内联任务也要迁移；新 Worker 的引用任务只更新引用，不塞内联字段。
    const refresh = await ActiveMsgClient.refreshApiCredentialsForPendingTasks(snapshot);
    if (refresh.failed > 0) throw new Error(`${refresh.failed} 个任务的 API 凭据尚未同步`);
    if (pendingCredApiConfig === snapshot) {
      hasPendingCredSync = false;
      pendingCredApiConfig = undefined;
      writeCredSyncMark(false);
    }
    credRetryCount = 0;
  } catch (error) {
    if (credRetryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * 2 ** credRetryCount;
      credRetryCount += 1;
      console.warn(`${HEADER} llm_credentials(${reason}) 上传失败，${Math.round(delay / 1000)}s 后重试（第 ${credRetryCount}/${MAX_RETRIES} 次）`, error);
      if (credRetryTimer != null) clearTimeout(credRetryTimer);
      credRetryTimer = setTimeout(() => { void runLlmCredentialSync('retry'); }, delay);
    } else {
      // 退避打光了（多半是离线）。底账留着：下次启动 / 下次冲刷继续补。
      console.error(`${HEADER} llm_credentials(${reason}) 连续 ${MAX_RETRIES} 次失败，云端凭据仍是上一份（已排程的任务到点会用旧 Key）`, error);
      credRetryCount = 0;
    }
  } finally {
    credSyncing = false;
    // 上传途中又切了 API：旧请求结束后立刻接着传最新一份，不能等下次启动。
    if (hasPendingCredSync && pendingCredApiConfig !== snapshot) {
      if (credRetryTimer != null) { clearTimeout(credRetryTimer); credRetryTimer = null; }
      credRetryCount = 0;
      void runLlmCredentialSync('newer-config');
    }
  }
};

/**
 * 聊天 API / 情绪评估 API 改过之后，把云端那几行凭据对齐的唯一入口。
 *
 * 立即传一次，失败退避重试，并在 localStorage 留底账等启动 / 下次冲刷补传。
 * 老 worker 没有凭据表，仍通过 refreshApiCredentialsForPendingTasks 逐条补刷。
 */
export const syncAmsgLlmCredentials = (apiConfig: APIConfig): void => {
  pendingCredApiConfig = apiConfig;
  hasPendingCredSync = true;
  credRetryCount = 0;
  if (credRetryTimer != null) { clearTimeout(credRetryTimer); credRetryTimer = null; }
  writeCredSyncMark(true);
  void runLlmCredentialSync('change');
};

// ─── 清空 Worker 地址前的收尾 ───

/**
 * 「Worker 地址被清空」的判定。
 *
 * 地址一空，前端这边的同步全停了，但 D1 里的任务还在：cron 每分钟照常消费、照烧 LLM
 * 照推送（推送订阅也还在），只是内容越来越对不上——用户以为自己关掉了一切，实际只是
 * 把自己变成了看不见的那一方。所以这一步不能静悄悄地存下去。
 */
export const isWorkerUrlCleared = (prevUrl: string | undefined, nextUrl: string | undefined): boolean =>
  Boolean(prevUrl?.trim()) && !nextUrl?.trim();

/**
 * 取消远端**全部**任务（清空 Worker 地址时用，此时还没换地址，读写的都是旧那台）。
 *
 * 「全部」是字面意思，正在跑的即时对话也一起取消，跟角色级的
 * ActiveMsgClient.cancelAllTasksForChar（那边刻意放过即时对话的行）不是一把尺 ——
 * 两个调用方（清空 Worker 地址、清空云端数据）要的都是「我不跟这台 worker 来往了」：
 * 地址一清，回复推回来这边也接不住了；云端数据一清，角色上下文没了，那一跳到点也只会
 * 硬失败，留着它只是多一条要等 7 天才自动消失的失败行。所以这里不给调用方开过滤的口子。
 *
 * 尽力而为：逐条取消，单条失败记数继续跑完其余的；清单都读不到（网络 / 鉴权）就
 * 回 listed:false，交给调用方提示用户「远端可能还挂着」。
 */
export const cancelAllRemoteAmsgTasks = async (): Promise<{
  total: number; failed: number; listed: boolean;
}> => {
  let uuids: string[];
  try {
    uuids = (await ActiveMsgClient.listAllTasks())
      .map((task: { uuid?: unknown }) => task?.uuid)
      .filter((uuid): uuid is string => typeof uuid === 'string' && !!uuid);
  } catch (error) {
    console.warn(`${HEADER} 清空地址前读不到远端任务清单，无法确认还剩几条`, error);
    return { total: 0, failed: 0, listed: false };
  }
  let failed = 0;
  for (const uuid of uuids) {
    try { await ActiveMsgClient.cancelTask(uuid); } catch { failed += 1; }
  }
  return { total: uuids.length, failed, listed: true };
};

/** 「清空云端数据」逐项的结果，界面照着它说清楚哪几样清干净了、哪几样没有。 */
export interface AmsgCloudWipeResult {
  /** 任务表：读到清单才有数，listed:false 表示清单压根读不出来。 */
  tasks: { total: number; failed: number; listed: boolean };
  /** 角色上下文清掉的条目数；这一步失败时是 null。 */
  stateDeleted: number | null;
  /** 工具凭据有没有当场补传回去（它没有别的补写时机）。 */
  toolConfigRestored: boolean;
  /**
   * LLM 凭据表清掉的行数；这一步失败时是 null。
   * 不当场补回去：这几行由排程 / 发消息那两条路按需重建（本地指纹底账已经一起划掉了）。
   */
  llmCredentialsDeleted: number | null;
  /** 推送订阅的去向：重新登记了 / 删掉了不再登记 / 没弄成。 */
  push: 'reregistered' | 'deleted' | 'failed';
}

/**
 * 清空这个用户在 worker D1 里的全部数据：已排程的任务、同步上去的角色上下文与
 * 工具凭据、登记的 LLM 凭据行、推送订阅登记。设置页「清空云端数据」按钮走的就是这里。
 *
 * 四样各清各的，**一步失败不短路后面几步**。这一条是这个函数存在的意义：换过
 * AMSG_MASTER_KEY 之后，旧密文全解不开，而「列任务」恰恰要逐条解密（GET /messages），
 * 于是它必然是最先炸的那一步；偏偏这时候最需要被清掉的是 client_state（不清的话
 * 读它的接口一直报错）。串行短路的话用户会一样都清不成，正好卡在最需要它的场景里。
 *
 * 任务清单读不出来时不用另想办法：解不开的任务到点会失败，worker 每轮 cron 都会删掉
 * 7 天前的失败任务，它们会自己消失。
 *
 * @param options.pushRegistered 本机当前有没有推送订阅。有就覆盖登记一份新的
 *   （worker 上按 user_id 存单行，PUT 一次就顶掉旧行，不用先删、也就没有「删完没
 *   登记上」的裸奔窗口）；没有就只把云端那行删掉，不去申请通知权限。
 * @param options.restoreToolConfig 清完要不要把全局工具凭据补传回去。默认补——
 *   设置页那个按钮清完之后 App 还在用，不补的话已排程的任务到点会一直硬失败。
 *   「重置全部数据」传 false：那边本地马上就要删库，补上去的一行谁也不会再读。
 */
export const wipeAmsgCloudData = async (
  realtimeConfig: RealtimeConfig | undefined,
  options: { pushRegistered: boolean; restoreToolConfig?: boolean },
): Promise<AmsgCloudWipeResult> => {
  // 先收任务：清空过程中就不会再有任务到点触发，跑到一半的状态不至于被现场读走。
  const tasks = await cancelAllRemoteAmsgTasks();

  let stateDeleted: number | null = null;
  let toolConfigRestored = false;
  try {
    const cleared = await ActiveMsgClient.clearClientState(realtimeConfig, {
      restoreToolConfig: options.restoreToolConfig,
    });
    stateDeleted = cleared.deleted;
    toolConfigRestored = cleared.toolConfigRestored;
  } catch (error) {
    console.warn(`${HEADER} 清空云端状态失败`, error);
  }

  // 凭据表：和上面几样一样自成一步，前面哪一步炸了都照清。老 worker 上没有这张表，
  // 那时这一步会失败——它本来就没东西可清，报出来即可，不影响别的几样。
  let llmCredentialsDeleted: number | null = null;
  try {
    llmCredentialsDeleted = await ActiveMsgClient.deleteLlmCredentials({ all: true });
  } catch (error) {
    console.warn(`${HEADER} 清空云端 LLM 凭据失败`, error);
  }

  let push: AmsgCloudWipeResult['push'] = 'failed';
  try {
    if (options.pushRegistered) {
      await ActiveMsgClient.registerPushSubscription();
      push = 'reregistered';
    } else {
      await ActiveMsgClient.deleteRemotePushSubscription();
      push = 'deleted';
    }
  } catch (error) {
    console.warn(`${HEADER} 推送订阅收尾失败`, error);
  }

  return { tasks, stateDeleted, toolConfigRestored, llmCredentialsDeleted, push };
};

/** wipeAmsgCloudDataForReset 的结果，failed 时带上 worker 地址供界面转告用户。 */
export type AmsgResetCloudWipe =
  /** 压根没配过 worker，云端一个字节都没写过。 */
  | { status: 'skipped' }
  | { status: 'cleared' }
  | { status: 'failed'; workerUrl: string; detail: string };

/**
 * 「重置全部数据」专用的云端收尾：不补传工具凭据、不重新登记推送，清完就是清完。
 *
 * 为什么判「清干净了没有」只看任务和角色上下文这两样：前者不清会继续到点跑、继续烧
 * 用户的 API 额度，后者是聊天原文，这两样留下来才是用户真正在意的。凭据行和推送订阅
 * 没清成只当一笔账记着——老 worker 上根本没有凭据表，那一步注定失败，拿它当判据会把
 * 一批压根没东西可清的人堵在重置门口。
 */
export const wipeAmsgCloudDataForReset = async (): Promise<AmsgResetCloudWipe> => {
  let workerUrl = '';
  try {
    workerUrl = (await ActiveMsgStore.getGlobalConfig()).workerUrl?.trim() || '';
  } catch {
    // 连本地配置都读不到，等于无从判断有没有云端；按没有处理，别为它拦下重置。
    return { status: 'skipped' };
  }
  if (!workerUrl) return { status: 'skipped' };

  const result = await wipeAmsgCloudData(undefined, {
    pushRegistered: false,
    restoreToolConfig: false,
  });

  const reasons: string[] = [];
  if (!result.tasks.listed) reasons.push('读不到云端任务清单');
  else if (result.tasks.failed > 0) reasons.push(`${result.tasks.failed} 个定时任务没取消掉`);
  if (result.stateDeleted === null) reasons.push('角色上下文没清掉');
  if (reasons.length === 0) return { status: 'cleared' };
  return { status: 'failed', workerUrl, detail: reasons.join('、') };
};

const writeChatPresence = (charId: string, lastUserMessageAt: number | null) => {
  const presence: AmsgChatPresence = {
    v: 1,
    charId,
    activeAt: Date.now(),
    lastUserMessageAt,
  };
  // 写入失败只 warn：心跳故障不能打断正常聊天，下一次 interval 继续尝试；远端 45s TTL 兜底。
  ActiveMsgClient.syncChatPresence(charId, presence).catch((error) => {
    console.warn(`${HEADER} 活跃会话租约写入失败（45s TTL 自然失效）`, error);
  });
};

/** 一轮真实用户消息进入生成流程时启动租约：立即写一次，之后每 15s 续租。 */
export const startAmsgChatPresence = (charId: string, lastUserMessageAt: number | null) => {
  writeChatPresence(charId, lastUserMessageAt);

  const existing = chatPresenceLeases.get(charId);
  if (existing) {
    // 已有 timer：只刷新本轮最新的 lastUserMessageAt，复用同一个心跳。
    existing.lastUserMessageAt = lastUserMessageAt;
    return;
  }

  const timer = setInterval(() => {
    // 切后台不再续租：一个闲置可见标签页不该无限续租；回前台下一轮真实消息重建。
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const lease = chatPresenceLeases.get(charId);
    if (!lease) return;
    writeChatPresence(charId, lease.lastUserMessageAt);
  }, CHAT_PRESENCE_HEARTBEAT_MS);
  chatPresenceLeases.set(charId, { timer, lastUserMessageAt });
};

/** 停止本地续租（不发「离线」写入，远端靠 45s TTL 自然失效）。 */
export const stopAmsgChatPresence = (charId: string) => {
  const lease = chatPresenceLeases.get(charId);
  if (lease) {
    clearInterval(lease.timer);
    chatPresenceLeases.delete(charId);
  }
};
