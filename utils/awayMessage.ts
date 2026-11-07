/**
 * 离开后消息：对方多久没说话，角色就来找对方。两条路按角色二选一（见 docs/away-message.md）：
 *   - 云端：开着主动消息 2.0 且连着 Worker 的角色。每个角色挂一条到点必发的任务，
 *     对方每轮开口后往后推；推得不够及时的那点由 worker 到点推迟兜住。
 *   - 本地：其余角色。每次打开页面时，给超过等待时长没说话的角色一次性补上
 *     「你不在时 TA 发的消息」，时间戳铺在离开那段时间里。
 */
import type { APIConfig, ActiveMsg2TaskRecord, CharacterProfile, GroupProfile, Message, RealtimeConfig, UserProfile } from '../types';
import { DB } from './db';
import { ActiveMsgClient } from './activeMsgClient';
import { applyScheduledTask, isAmsg2EnabledForChar } from './amsg2Tasks';
import { isAmsg2GlobalReady } from './amsg2ToolBridge';
import {
  AWAY_SEGMENT_MARK,
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
import { resolveCharTimeZone } from './timezone';
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

const formatCharClock = (ms: number, tz: string | undefined): string =>
  new Date(ms).toLocaleString('zh-CN', {
    timeZone: tz, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });

const buildLocalHint = (char: CharacterProfile, userName: string, lastUserAt: number, slots: number[]): string => {
  const n = slots.length;
  const showClock = char.timeAwarenessEnabled !== false;
  const tz = resolveCharTimeZone(char);
  const when = showClock
    ? `${userName}最后一次跟你说话是在 ${formatCharClock(lastUserAt, tz)}，之后一直没再找你。这段时间里你主动给${userName}发过 ${n} 次消息，分别在 ${slots.map(t => formatCharClock(t, tz)).join('、')}（你那边的时间）。`
    : `${userName}已经有好一阵子没跟你说话了。这段时间里你主动给${userName}发过 ${n} 次消息。`;
  return `[系统提示（非${userName}发言）: ${when}`
    + `请把这 ${n} 次分别写出来：按时间先后，每次一到三句，像真人随手发的私聊，后面几次可以带着前面没等到回复的心情。`
    + (n > 1 ? `两次之间单独一行写 ${AWAY_SEGMENT_MARK} 隔开。` : '')
    + '不要写时间、序号或旁白，只写你发出去的消息本身。]';
};

const generateLocalAwayMessages = async (char: CharacterProfile, deps: LocalAwayDeps): Promise<void> => {
  const delayMs = resolveAwayDelayMinutes(char) * 60_000;
  const now = Date.now();
  const recent = await DB.getRecentMessagesByCharId(char.id, 50, true);
  const lastUserAt = findAwayGapStart(recent, delayMs, now);
  if (lastUserAt == null) return;
  const userProfile = deps.getUserProfile();
  const api = resolveDialogueApi(deps.getApiConfig(), char);
  if (!userProfile || !api.baseUrl) return;

  // 时刻不早于最后一条消息：显示顺序看 id，时间戳倒挂会让气泡上的钟跳回去。
  const lastMsgAt = recent.at(-1)?.timestamp ?? lastUserAt;
  const slots = planAwaySlots(lastUserAt, delayMs, now).map(t => Math.max(t, lastMsgAt + 1));
  const userName = userProfile.name || '对方';

  const range = await loadCharacterContextRange(char);
  const { emojis, categories } = ChatPrompts.filterVisibleEmojis(await DB.getEmojis(), await DB.getEmojiCategories(), char.id);
  // 提示只进这一次请求，不落库：它不是谁说过的话。
  const hint = {
    id: -1, charId: char.id, role: 'user', type: 'text', timestamp: now,
    content: buildLocalHint(char, userName, lastUserAt, slots),
    metadata: { proactiveHint: true, hidden: true },
  } as Message;
  const history = [...range.messages, hint];
  const groups = deps.getGroups();
  const realtimeConfig = deps.getRealtimeConfig();
  const payload = await buildChatRequestPayload({
    char, userProfile, groups, emojis, categories,
    historyMsgs: history,
    contextLimit: history.length,
    recallEntryPoint: 'proactive_chat',
    realtimeConfig,
    musicSnapshot: loadMusicPlaybackSnapshot(),
    htmlMode: { enabled: !!(char as any).htmlModeEnabled, customPrompt: (char as any).htmlModeCustomPrompt },
    visionApiConfig: deps.getApiConfig().visionApi,
  });

  const baseUrl = api.baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey || 'sk-none'}` };
  const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: api.model, messages: payload.fullMessages, temperature: api.temperature ?? 0.85, stream: false }),
  }, 2, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: '离开后消息' });
  const segments = splitAwaySegments(extractContent(data), slots.length);
  if (!segments.length) return;

  // 生成期间对方回来说了话：这段离开已经结束，补的消息作废。
  if (findAwayGapStart(await DB.getRecentMessagesByCharId(char.id, 50, true), delayMs, Date.now()) !== lastUserAt) return;

  const notifyProgress = () => window.dispatchEvent(new CustomEvent('active-msg-progress'));
  for (let i = 0; i < segments.length; i++) {
    await applyAssistantPostProcessing(segments[i], {
      char, userProfile, emojis, categories, realtimeConfig, groups,
      spokenAt: slots[i],
      contextMsgs: range.messages,
      fullMessages: [],
      initialData: null,
      historyMsgCount: range.messages.length,
      // 打标是「这段离开已经补过」的唯一依据，见 findAwayGapStart。
      mcdInheritMeta: { awayMessage: true },
      xhsCaches: {
        xsecTokenCache: new Map(), noteTitleCache: new Map(), commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(), commentParentIdCache: new Map(),
      },
      api: { baseUrl, headers, effectiveApi: { baseUrl, apiKey: api.apiKey, model: api.model } },
      hooks: { setMessages: notifyProgress, addToast: () => {} },
      instantRender: true,
      skipSecondPassLLM: true,
      messageTimestamp: slots[i],
    });
  }
  const preview = segments.join(' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  // 未读、提示和系统通知沿用主动消息送达那一套。
  window.dispatchEvent(new CustomEvent('active-msg-received', {
    detail: { charId: char.id, charName: char.name, body: preview },
  }));
};
