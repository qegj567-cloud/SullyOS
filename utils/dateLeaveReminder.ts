/**
 * 见面离开提醒：见面对话中途走开超过设定时长，角色在私聊里找对方一次（见 docs/date-leave-reminder.md）。
 *   - 云端：开着主动消息 2.0 且连着 Worker 的角色。人在见面对话里时就备好一条到点必发的任务，
 *     worker 按「见面中」租约把它一路往后推，人一走开（不论在 SullyOS 里走开还是切出去）
 *     租约不再续，到点就发。走开那一刻不用发请求，切到后台后脚本被冻住也不影响。
 *   - 本地：其余角色。在 SullyOS 里走开时开始计时，页面一隐藏就作废，不补发。
 * 同一个角色的操作按调用顺序串行执行：刚备好就撤掉时，撤掉不会抢在新建前面跑完。
 */
import type { APIConfig, ActiveMsg2TaskRecord, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { DB } from './db';
import { ActiveMsgClient } from './activeMsgClient';
import { applyScheduledTask } from './amsg2Tasks';
import { buildDateLeaveInstruction } from './amsgFireSchedule';
import { isAwayCloudRoute, runLocalProactiveTurn } from './awayMessage';

export const DATE_LEAVE_DEFAULT_MINUTES = 5;
export const DATE_LEAVE_MIN_MINUTES = 1;
export const DATE_LEAVE_MAX_MINUTES = 60;

export const resolveDateLeaveDelayMinutes = (char: Pick<CharacterProfile, 'dateLeaveReminder'>): number => {
  const raw = Math.round(Number(char.dateLeaveReminder?.delayMinutes ?? DATE_LEAVE_DEFAULT_MINUTES));
  if (!Number.isFinite(raw)) return DATE_LEAVE_DEFAULT_MINUTES;
  return Math.min(DATE_LEAVE_MAX_MINUTES, Math.max(DATE_LEAVE_MIN_MINUTES, raw));
};

type UpdateCharacter = (
  id: string,
  updates: Partial<CharacterProfile> | ((prev: CharacterProfile) => Partial<CharacterProfile>),
) => void;

export interface DateLeaveDeps {
  char: CharacterProfile;
  apiConfig: APIConfig;
  userProfile: UserProfile | null | undefined;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
  updateCharacter: UpdateCharacter;
}

const chains = new Map<string, Promise<void>>();
const enqueue = (charId: string, step: () => Promise<void>): Promise<void> => {
  const next = (chains.get(charId) ?? Promise.resolve()).then(step).catch(error => {
    console.warn('[DateLeave] 处理失败', error);
  });
  chains.set(charId, next);
  return next;
};

// 刚建好、还没写回角色记录的云端任务。角色快照是调用方那一刻的，可能还没有它。
const knownCloudTasks = new Map<string, string>();
const cloudTaskOf = (char: CharacterProfile): string | undefined =>
  knownCloudTasks.get(char.id) ?? (char.activeMsg2Config?.tasks ?? []).filter(t => t.dateLeave).at(-1)?.taskUuid;

// 本地计时器：页面隐藏就清掉。presentAt 记人最近一次在见面里的时刻，本地生成期间回来了就作废。
const localTimers = new Map<string, ReturnType<typeof setTimeout>>();
const presentAt = new Map<string, number>();

const clearLocal = (charId: string) => {
  const timer = localTimers.get(charId);
  if (timer) clearTimeout(timer);
  localTimers.delete(charId);
};

let visibilityHooked = false;
const hookVisibility = () => {
  if (visibilityHooked || typeof document === 'undefined') return;
  visibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    // 没开 2.0 的角色只在页面开着时提醒：切出 SullyOS 就不再计时，回来也不补。
    if (document.visibilityState === 'hidden') [...localTimers.keys()].forEach(clearLocal);
  });
};

/**
 * 人在见面对话里（进入对话、从挂起恢复、页面回到前台）时调用。
 * 云端：把任务改到「现在 + 等待时长」，远端已经没有就新建；人一直在见面里时 worker 会继续往后推。
 * 本地：撤掉还在走的计时。
 */
export const armDateLeaveReminder = (deps: DateLeaveDeps): Promise<void> => {
  const { char } = deps;
  presentAt.set(char.id, Date.now());
  clearLocal(char.id);
  if (!char.dateLeaveReminder?.enabled) return Promise.resolve();
  return enqueue(char.id, async () => {
    if (!deps.userProfile || !char.activeMsg2Config || !await isAwayCloudRoute(char)) return;
    const sendAt = new Date(Date.now() + resolveDateLeaveDelayMinutes(char) * 60_000).toISOString();
    const existing = cloudTaskOf(char);
    if (existing) {
      const { updated } = await ActiveMsgClient.updatePendingTasksRemote([existing], { nextSendAt: sendAt });
      if (updated > 0) return;
      // 远端已经没有了（上次走开时发过了，或者被取消了）：往下新建。
    }
    const result = await ActiveMsgClient.scheduleCharacterTask({
      char,
      config: char.activeMsg2Config,
      task: {
        mode: 'auto', firstSendTime: sendAt, recurrenceType: 'none', expirePolicy: 'force',
        dateLeave: { delayMinutes: resolveDateLeaveDelayMinutes(char) },
      },
      userProfile: deps.userProfile,
      groups: deps.groups,
      realtimeConfig: deps.realtimeConfig,
      apiConfig: deps.apiConfig,
    });
    knownCloudTasks.set(char.id, result.uuid);
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
      dateLeave: true,
    };
    deps.updateCharacter(char.id, prev => prev.activeMsg2Config ? {
      activeMsg2Config: {
        ...prev.activeMsg2Config,
        // 每个角色只留一条：旧的已经发过或不在了。
        tasks: applyScheduledTask((prev.activeMsg2Config.tasks ?? []).filter(t => !t.dateLeave), created, {}, Date.now()),
      },
    } : {});
  });
};

/** 在 SullyOS 里走开（见面被挂起）时调用。云端那条已经备好了，这里只管本地计时。 */
export const startLocalDateLeaveTimer = (deps: DateLeaveDeps, leftAt = Date.now()): Promise<void> => {
  const { char } = deps;
  if (!char.dateLeaveReminder?.enabled) return Promise.resolve();
  return enqueue(char.id, async () => {
    if (await isAwayCloudRoute(char)) return;
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    hookVisibility();
    clearLocal(char.id);
    const delayMs = resolveDateLeaveDelayMinutes(char) * 60_000;
    localTimers.set(char.id, setTimeout(() => {
      localTimers.delete(char.id);
      void enqueue(char.id, () => fireLocal(deps, leftAt));
    }, Math.max(0, leftAt + delayMs - Date.now())));
  });
};

/**
 * 这次见面不需要提醒了：主动结束见面、在私聊里对这个角色开口、关掉这项设置。
 * 没有待发的提醒时不发任何请求。
 */
export const disarmDateLeaveReminder = (deps: Pick<DateLeaveDeps, 'char' | 'updateCharacter'>): Promise<void> => {
  const { char } = deps;
  clearLocal(char.id);
  if (!cloudTaskOf(char) && !chains.has(char.id)) return Promise.resolve();
  return enqueue(char.id, async () => {
    const uuid = cloudTaskOf(char);
    knownCloudTasks.delete(char.id);
    if (!uuid) return;
    // 取消失败不重试：走开后开过口的，worker 到点看到私聊盖掉了见面租约会自己作废。
    try { await ActiveMsgClient.cancelTask(uuid); } catch (error) { console.warn('[DateLeave] 取消云端任务失败', error); }
    deps.updateCharacter(char.id, prev => prev.activeMsg2Config ? {
      activeMsg2Config: {
        ...prev.activeMsg2Config,
        tasks: (prev.activeMsg2Config.tasks ?? []).filter(t => !t.dateLeave),
      },
    } : {});
  });
};

/** 走开之后对方在私聊里说过话：这次离开已经结束。 */
const spokeSince = async (charId: string, since: number): Promise<boolean> =>
  (await DB.getRecentMessagesByCharId(charId, 20, true))
    .some(m => m.role === 'user' && m.timestamp > since);

const fireLocal = async (deps: DateLeaveDeps, leftAt: number) => {
  const { char, userProfile } = deps;
  if (!userProfile || document.visibilityState !== 'visible' || await spokeSince(char.id, leftAt)) return;
  const userName = userProfile.name || '对方';
  await runLocalProactiveTurn(char, {
    apiConfig: deps.apiConfig,
    userProfile,
    groups: deps.groups,
    realtimeConfig: deps.realtimeConfig,
    hint: `[系统提示（非${userName}发言）: ${buildDateLeaveInstruction()}\n只写你发出去的消息本身，不要写时间、序号或旁白。]`,
    purpose: '见面离开提醒',
    meta: { dateLeaveReminder: true },
    place: text => [{ text: text.trim(), at: Date.now() }],
    // 生成期间回到了见面、开了口、或者切出了 SullyOS，都作废。
    stillWanted: async () => (presentAt.get(char.id) ?? 0) <= leftAt
      && document.visibilityState === 'visible' && !await spokeSince(char.id, leftAt),
  });
};
