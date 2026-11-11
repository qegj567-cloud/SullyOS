/**
 * 离开后消息：对方多久没说话，角色就来找对方。两条路按角色二选一（见 docs/away-message.md）：
 *   - 云端：开着主动消息 2.0 且连着 Worker 的角色。每个角色挂一条到点必发的任务，
 *     对方每轮开口后往后推；推得不够及时的那点由 worker 到点推迟兜住。
 *   - 本地：其余角色。每次打开页面时，给超过等待时长没说话的角色一次性补上
 *     「你不在时 TA 发的消息」，时间戳铺在离开那段时间里。
 */
import type { APIConfig, ActiveMsg2TaskRecord, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { DB } from './db';
import { ActiveMsgClient } from './activeMsgClient';
import { applyScheduledTask, isAmsg2EnabledForChar } from './amsg2Tasks';
import { isAmsg2GlobalReady } from './amsg2ToolBridge';
import {
  decideAwayTaskAction,
  findAwayGapStart,
  planAwaySlots,
  resolveAwayDelayMinutes,
  splitAwaySegments,
} from './awayMessageCore';
import { loadCharacterContextRange } from './chatContextRange';
import { ChatPrompts } from './chatPrompts';
import { buildChatRequestPayload } from './chatRequestPayload';
import { applyAssistantPostProcessing } from './applyAssistantPostProcessing';
import { resolveDialogueApi } from './characterApi';
import { extractContent, safeFetchJson } from './safeApi';
import { buildLocalAwayHint } from './awayMessagePrompt';
import { loadMusicPlaybackSnapshot } from '../context/MusicContext';

/** 失败后这么久内不再试，免得每次切回前台都白调一次。 */
const FAILURE_COOLDOWN_MS = 10 * 60_000;

type UpdateCharacter = (
  id: string,
  updates: Partial<CharacterProfile> | ((prev: CharacterProfile) => Partial<CharacterProfile>),
) => void;

/** 这个角色走云端（开着 2.0 且配了 Worker）还是本地。 */
export const isAwayCloudRoute = async (char: CharacterProfile): Promise<boolean> =>
  isAmsg2EnabledForChar(char) && await isAmsg2GlobalReady();

// ─── 云端 ───

const cloudInFlight = new Set<string>();
const cloudCooldownUntil = new Map<string, number>();

const awaySendAtMs = (task: ActiveMsg2TaskRecord): number | null => {
  const ms = Date.parse(task.nextSendAt ?? task.firstSendTime);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * 每轮聊天开始时调用（不用 await）：把云端那条离开后消息排到「对方最后一次开口 + 等待时长」。
 * 已有任务排得够晚就什么都不发；排早了原地改期；远端已经没有（发过了 / 被取消）就新建。
 */
export const syncCloudAwayTask = async (deps: {
  char: CharacterProfile;
  lastUserAt: number;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
  apiConfig: APIConfig;
  updateCharacter: UpdateCharacter;
}): Promise<void> => {
  const { char } = deps;
  if (!char.awayMessage?.enabled || cloudInFlight.has(char.id)) return;
  if ((cloudCooldownUntil.get(char.id) ?? 0) > Date.now()) return;
  if (!await isAwayCloudRoute(char) || !char.activeMsg2Config) return;

  cloudInFlight.add(char.id);
  try {
    const delayMinutes = resolveAwayDelayMinutes(char);
    const now = Date.now();
    const targetMs = Math.max(deps.lastUserAt + delayMinutes * 60_000, now + 60_000);
    const sendAt = new Date(targetMs).toISOString();
    const record = (char.activeMsg2Config.tasks ?? []).filter(t => t.away).at(-1);
    const action = decideAwayTaskAction(record ? awaySendAtMs(record) : null, targetMs, now);
    if (action === 'keep') return;

    if (action === 'renew' && record) {
      const { updated, failed } = await ActiveMsgClient.updatePendingTasksRemote([record.taskUuid], { nextSendAt: sendAt });
      if (updated > 0) {
        deps.updateCharacter(char.id, prev => prev.activeMsg2Config ? {
          activeMsg2Config: {
            ...prev.activeMsg2Config,
            tasks: (prev.activeMsg2Config.tasks ?? []).map(t => t.taskUuid === record.taskUuid ? { ...t, nextSendAt: sendAt } : t),
          },
        } : {});
        return;
      }
      if (failed.length) throw new Error('离开后消息改期失败');
      // 远端已经没有这条了（发过了或被取消）：往下新建。
    }

    const result = await ActiveMsgClient.scheduleCharacterTask({
      char,
      config: char.activeMsg2Config,
      task: { mode: 'auto', firstSendTime: sendAt, recurrenceType: 'none', expirePolicy: 'force', away: { delayMinutes } },
      userProfile: deps.userProfile,
      groups: deps.groups,
      realtimeConfig: deps.realtimeConfig,
      apiConfig: deps.apiConfig,
    });
    const created: ActiveMsg2TaskRecord = {
      taskUuid: result.uuid,
      clientTaskId: result.clientTaskId,
      mode: 'auto',
      firstSendTime: result.firstSendAt,
      recurrenceType: 'none',
      expirePolicy: 'force',
      source: 'user',
      status: 'scheduled',
      createdAt: Date.now(),
      away: true,
    };
    deps.updateCharacter(char.id, prev => prev.activeMsg2Config ? {
      activeMsg2Config: {
        ...prev.activeMsg2Config,
        // 旧的那条已经发过或不在了，换成新的；每个角色只留一条。
        tasks: applyScheduledTask((prev.activeMsg2Config.tasks ?? []).filter(t => !t.away), created, {}, Date.now()),
      },
    } : {});
  } catch (error) {
    console.warn('[AwayMessage] 云端任务同步失败', error);
    cloudCooldownUntil.set(char.id, Date.now() + FAILURE_COOLDOWN_MS);
  } finally {
    cloudInFlight.delete(char.id);
  }
};

/** 关掉离开后消息或改了等待时长时调用：取消云端那条，下一轮对方开口时按新设置重建。 */
export const cancelCloudAwayTasks = async (char: CharacterProfile, updateCharacter: UpdateCharacter): Promise<void> => {
  const away = (char.activeMsg2Config?.tasks ?? []).filter(t => t.away);
  if (!away.length) return;
  const cancelled = new Set<string>();
  for (const task of away) {
    try {
      await ActiveMsgClient.cancelTask(task.taskUuid);
      cancelled.add(task.taskUuid);
    } catch (error) {
      console.warn('[AwayMessage] 取消云端任务失败', error);
    }
  }
  updateCharacter(char.id, prev => prev.activeMsg2Config ? {
    activeMsg2Config: {
      ...prev.activeMsg2Config,
      tasks: (prev.activeMsg2Config.tasks ?? []).filter(t => !cancelled.has(t.taskUuid)),
    },
  } : {});
};

// ─── 本地 ───

export interface LocalAwayDeps {
  getCharacters: () => CharacterProfile[];
  getApiConfig: () => APIConfig;
  getUserProfile: () => UserProfile | null | undefined;
  getGroups: () => GroupProfile[];
  getRealtimeConfig: () => RealtimeConfig;
  /** 用户正在和这个角色见面 / 通话：这时不补线上消息。 */
  isBusyWith: (charId: string) => boolean;
}

let localRunning = false;
const localCooldownUntil = new Map<string, number>();

/** 打开页面 / 切回前台时调用：逐个给该补的角色补上离开期间的消息。 */
export const runLocalAwayMessages = async (deps: LocalAwayDeps): Promise<void> => {
  if (localRunning) return;
  localRunning = true;
  try {
    for (const char of deps.getCharacters().filter(c => c.awayMessage?.enabled)) {
      if ((localCooldownUntil.get(char.id) ?? 0) > Date.now() || deps.isBusyWith(char.id)) continue;
      try {
        if (await isAwayCloudRoute(char)) continue;
        await generateLocalAwayMessages(char, deps);
      } catch (error) {
        console.warn(`[AwayMessage] ${char.name} 的离开后消息生成失败`, error);
        localCooldownUntil.set(char.id, Date.now() + FAILURE_COOLDOWN_MS);
      }
    }
  } finally {
    localRunning = false;
  }
};

const generateLocalAwayMessages = async (char: CharacterProfile, deps: LocalAwayDeps): Promise<void> => {
  const delayMs = resolveAwayDelayMinutes(char) * 60_000;
  const now = Date.now();
  const recent = await DB.getRecentMessagesByCharId(char.id, 50, true);
  const lastUserAt = findAwayGapStart(recent, delayMs, now);
  if (lastUserAt == null) return;
  const userProfile = deps.getUserProfile();
  if (!userProfile) return;

  // 时刻不早于最后一条消息：显示顺序看 id，时间戳倒挂会让气泡上的钟跳回去。
  const lastMsgAt = recent.at(-1)?.timestamp ?? lastUserAt;
  const slots = planAwaySlots(lastUserAt, delayMs, now).map(t => Math.max(t, lastMsgAt + 1));
  const userName = userProfile.name || '对方';

  await runLocalProactiveTurn(char, {
    apiConfig: deps.getApiConfig(),
    userProfile,
    groups: deps.getGroups(),
    realtimeConfig: deps.getRealtimeConfig(),
    hint: buildLocalAwayHint(char, userName, lastUserAt, slots, recent, now),
    purpose: '离开后消息',
    // 打标是「这段离开已经补过」的唯一依据，见 findAwayGapStart。
    meta: { awayMessage: true },
    place: text => splitAwaySegments(text, slots.length).map((segment, i) => ({ text: segment, at: slots[i] })),
    // 生成期间对方回来说了话：这段离开已经结束，补的消息作废。
    stillWanted: async () =>
      findAwayGapStart(await DB.getRecentMessagesByCharId(char.id, 50, true), delayMs, Date.now()) === lastUserAt,
  });
};

// ─── 本地生成一轮角色主动找人的私聊（离开后消息、见面离开提醒共用） ───

export interface LocalProactiveTurn {
  apiConfig: APIConfig;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
  /** 本轮提示：只进这次请求，不落库。 */
  hint: string;
  /** 调用记录里的用途名。 */
  purpose: string;
  /** 落库消息带的标记。 */
  meta: Record<string, unknown>;
  /** 把模型正文切成几次发送，并给每次一个时刻。 */
  place: (text: string) => { text: string; at: number }[];
  /** 生成完、落库前再确认一次还要不要发；情况变了返回 false，整轮作废。 */
  stillWanted: () => Promise<boolean>;
}

/** 用聊天同一套上下文生成并落库，返回有没有真的发出去。 */
export const runLocalProactiveTurn = async (char: CharacterProfile, turn: LocalProactiveTurn): Promise<boolean> => {
  const api = resolveDialogueApi(turn.apiConfig, char);
  if (!api.baseUrl) return false;
  const { userProfile, groups, realtimeConfig } = turn;

  const range = await loadCharacterContextRange(char);
  const { emojis, categories } = ChatPrompts.filterVisibleEmojis(await DB.getEmojis(), await DB.getEmojiCategories(), char.id);
  const payload = await buildChatRequestPayload({
    char, userProfile, groups, emojis, categories,
    historyMsgs: range.messages,
    contextLimit: Math.max(1, range.messages.length),
    recallEntryPoint: 'proactive_chat',
    realtimeConfig,
    musicSnapshot: loadMusicPlaybackSnapshot(),
    htmlMode: { enabled: !!(char as any).htmlModeEnabled, customPrompt: (char as any).htmlModeCustomPrompt },
    visionApiConfig: turn.apiConfig.visionApi,
  });

  // 在所有原文范围筛选之后注入本轮任务；负数假 ID 会被水位线、窗口或用户断点滤掉。
  // 只加到 API 请求，不落库、不占历史条数，也不让范围外原文混入。保留末尾的人格提示。
  payload.fullMessages.splice(payload.volatileTailIndex >= 0 ? payload.volatileTailIndex : payload.fullMessages.length, 0, {
    role: 'user', content: turn.hint,
  });

  const baseUrl = api.baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey || 'sk-none'}` };
  const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: api.model, messages: payload.fullMessages, temperature: api.temperature ?? 0.85, stream: false }),
  }, 2, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: turn.purpose });
  const placed = turn.place(extractContent(data)).filter(p => p.text.trim());
  if (!placed.length || !await turn.stillWanted()) return false;

  const notifyProgress = () => window.dispatchEvent(new CustomEvent('active-msg-progress'));
  for (const { text, at } of placed) {
    await applyAssistantPostProcessing(text, {
      char, userProfile, emojis, categories, realtimeConfig, groups,
      spokenAt: at,
      contextMsgs: range.messages,
      fullMessages: [],
      initialData: null,
      historyMsgCount: range.messages.length,
      mcdInheritMeta: turn.meta,
      xhsCaches: {
        xsecTokenCache: new Map(), noteTitleCache: new Map(), commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(), commentParentIdCache: new Map(),
      },
      api: { baseUrl, headers, effectiveApi: { baseUrl, apiKey: api.apiKey, model: api.model } },
      hooks: { setMessages: notifyProgress, addToast: () => {} },
      instantRender: true,
      skipSecondPassLLM: true,
      messageTimestamp: at,
    });
  }
  const preview = placed.map(p => p.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  // 未读、提示和系统通知沿用主动消息送达那一套。
  window.dispatchEvent(new CustomEvent('active-msg-received', {
    detail: { charId: char.id, charName: char.name, body: preview },
  }));
  return true;
};
