/**
 * 离开后消息：对方多久没说话，角色就来找对方。两条路按角色二选一（见 docs/away-message.md）：
 *   - 云端：开着主动消息 2.0 且连着 Worker 的角色。每个角色挂一条到点必发的任务，
 *     对方每轮开口后往后推；推得不够及时的那点由 worker 到点推迟兜住。
 *   - 本地：其余角色。每次打开页面时，给超过等待时长没说话的角色一次性补上
 *     「你不在时 TA 发的消息」，时间戳铺在离开那段时间里。
 */
import type { APIConfig, ActiveMsg2TaskRecord, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { DB } from './db';
import { ActiveMsgClient, buildFirePack } from './activeMsgClient';
import { applyScheduledTask, isAmsg2EnabledForChar } from './amsg2Tasks';
import { isAmsg2GlobalReady } from './amsg2ToolBridge';
import {
  AWAY_SEGMENT_MARK,
  decideAwayTaskAction,
  findAwayGapStart,
  getLastAwayAnchorAt,
  planAwaySlots,
  resolveAwayDelayMinutes,
  splitAwaySegments,
} from './awayMessageCore';
import { loadCharacterContextRange } from './chatContextRange';
import { ChatPrompts } from './chatPrompts';
import { applyAssistantPostProcessing, hasSecondPassTag } from './applyAssistantPostProcessing';
import { resolveDialogueApi } from './characterApi';
import { resolveDialogueLlmParams } from './dialogueLlmParams';
import { extractContent, safeFetchJson } from './safeApi';
import { buildAwayFireInstruction, readAwayAnchorInfo } from './awayMessagePrompt';
import { formatFireTimeShort, renderFirePack, type AmsgFirePack } from './amsgFirePack';
import { browserHolidayCache, deviceTimeZone, getUserHolidayReminder, insertUserHolidayInProfile } from './userHolidays';
import { renderWorldbookRolls } from './worldbook';
import { createReplyRun, isReplyAbort } from './chatReplyCancellation';
import { ActiveMsgStore } from './activeMsgStore';
import { checkSpecialDates, pickRandomNews, renderRealtimeWorldBlock, REALTIME_NEWS_PICK_COUNT } from './realtimeWorldCore';
import { defaultRealtimeConfig, RealtimeContextManager } from './realtimeContext';
import { weatherForCharacter } from './characterWeather';
import { isScheduleFeatureOn } from './scheduleFeature';
import { isEmotionEvalSkipped } from './devDebug';
import { resolveCharTimeZone } from './timezone';

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

/**
 * 见面与通话轮次落库后维护云端离开后消息：从最近消息（含已归档）取最后一次在场互动时刻，
 * 按它新建或改期云端任务。距离已有排期不到 AWAY_RENEW_SLACK_MS（10 分钟）时不发请求。
 */
export const syncCloudAwayTaskFromRecent = async (
  deps: Omit<Parameters<typeof syncCloudAwayTask>[0], 'lastUserAt'>,
): Promise<void> => {
  const { char } = deps;
  if (!char.awayMessage?.enabled || cloudInFlight.has(char.id)) return;
  if ((cloudCooldownUntil.get(char.id) ?? 0) > Date.now()) return;
  if (!await isAwayCloudRoute(char) || !char.activeMsg2Config) return;
  const recent = await DB.getRecentMessagesByCharId(char.id, 50, true);
  const lastAnchorAt = getLastAwayAnchorAt(recent);
  if (lastAnchorAt == null) return;
  await syncCloudAwayTask({ ...deps, lastUserAt: lastAnchorAt });
};

/** 关掉离开后消息或改了等待时长时调用：取消云端那条，下一轮对方开口时按新设置重建。 */
export const cancelCloudAwayTasks = async (char: CharacterProfile, updateCharacter: UpdateCharacter): Promise<void> => {
  const away = (char.activeMsg2Config?.tasks ?? []).filter(t => t.away);
  if (!away.length) return;
  // 总开关关闭期间不打 Worker：记录留在本地清单，待恢复开启或重开设置时再同步取消。
  if (!await isAmsg2GlobalReady()) return;
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
  const showClock = char.timeAwarenessEnabled !== false;
  const tzId = resolveCharTimeZone(char) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 「本次任务」与云端到点现算的是同一份；按第一次发送的时刻算，云端也是在那一刻到点。
  const fireInstruction = buildAwayFireInstruction({
    userName, anchor: readAwayAnchorInfo(recent), anchorAt: lastUserAt, nowMs: slots[0], showClock, tzId,
  });

  await runLocalProactiveTurn(char, {
    apiConfig: deps.getApiConfig(),
    userProfile,
    groups: deps.getGroups(),
    realtimeConfig: deps.getRealtimeConfig(),
    hint: [fireInstruction, ...buildMultiSendLines(userName, slots, showClock, tzId)].join('\n'),
    singleHint: fireInstruction,
    renderAt: slots[0],
    purpose: '离开后消息',
    // 打标是「这段离开已经补过」的唯一依据，见 findAwayGapStart。
    meta: { awayMessage: true },
    place: text => splitAwaySegments(text, slots.length).map((segment, i) => ({ text: segment, at: slots[i] })),
    // 生成期间对方回来说了话：这段离开已经结束，补的消息作废。
    stillWanted: async () =>
      findAwayGapStart(await DB.getRecentMessagesByCharId(char.id, 50, true), delayMs, Date.now()) === lastUserAt,
  });
};

/**
 * 离开太久、本地一次补好几次时追加在云端指令后面的几行。云端到点只发一次，没有这几行；
 * 只补一次时也不加，本地与云端的指令逐字相同。
 * 模板的「现在」是第一次发送的时刻，后面几次在那一刻还没发生，所以写成「之后还会」。
 */
const buildMultiSendLines = (userName: string, slots: number[], showClock: boolean, tzId: string): string[] => {
  const n = slots.length;
  if (n <= 1) return [];
  const later = slots.slice(1);
  return [
    showClock
      ? `这次之后，如果${userName}一直没回，你还会在 ${later.map(t => formatFireTimeShort(t, { tzId })).join('、')}（你那边的时间）各再找${userName}一次。`
      : `这次之后，如果${userName}一直没回，你还会再找${userName} ${later.length} 次。`,
    '后面几次可以有想念或没等到回复的心情，也可以继续分享新的生活小事，不必次次围着“没回复”打转。',
    `请把这 ${n} 次按时间先后分别写出来，每次一到两句就好，最多三句；两次之间单独一行写 ${AWAY_SEGMENT_MARK} 隔开。`,
    '不要写时间或序号，只写你发出去的消息本身。',
  ];
};

// ─── 本地生成一轮角色主动找人的私聊（离开后消息、见面离开提醒共用） ───
//
// 提示词与云端到点生成用同一套拼法：buildFirePack 打包、renderFirePack 填槽，worker 到点才现取的
// 那几块（实时世界、用户所在地节日）这里按同样的开关现取。两边差的只有 worker 追加在末尾的
// 排程 / MCP 说明块：走本地这条路的角色用不了 Worker 排程（判定与私聊注入排程工具同一个条件），
// 本地这一轮也不跑 MCP 工具循环，不执行的就不教。逐字对照见 awayMessage.parity.test.ts。

export interface LocalProactiveTurn {
  apiConfig: APIConfig;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
  /** 填进模板【本次任务】的指令：只进这次请求，不落库。 */
  hint: string;
  /**
   * 这一轮用到要回连模型的标签（召回、搜索、读日记等）时合成一次发出，二轮请求改用这份
   * 只发一次的指令，免得二轮又按分次的格式写。不传就是 hint。
   */
  singleHint?: string;
  /** 模板里「现在」的时刻（当前时间、此刻在做什么都按它算）；不传用现在。 */
  renderAt?: number;
  /** 调用记录里的用途名。 */
  purpose: string;
  /** 落库消息带的标记。 */
  meta: Record<string, unknown>;
  /** 把模型正文切成几次发送，并给每次一个时刻。 */
  place: (text: string) => { text: string; at: number }[];
  /** 生成完、落库前再确认一次还要不要发；情况变了返回 false，整轮作废。 */
  stillWanted: () => Promise<boolean>;
}

const laterOf = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a == null ? (b ?? null) : b == null ? a : Math.max(a, b);

/** 按 worker 到点的同一组参数填模板，只少 worker 末尾追加的排程 / MCP / 回复范围块。 */
const renderLocalProactivePrompt = (pack: AmsgFirePack, nowMs: number, instruction: string, opts: {
  dateLeave: boolean;
  includeClock: boolean;
  realtimeWorldBlock: string;
  userHoliday: string;
}): string => insertUserHolidayInProfile(renderFirePack(pack, nowMs, instruction, {
  realtimeWorldBlock: opts.realtimeWorldBlock,
  includeClock: opts.includeClock,
  lastUserMessageAt: laterOf(pack.lastAwayAnchorAt, pack.lastUserMessageAt),
  // 两种都是到点必发，云端同样拿掉【开口之前】。
  mustSpeak: true,
  dateLeave: opts.dateLeave,
}), opts.userHoliday, pack.userBioLength);

/** worker 到点现取的实时世界与用户所在地节日：本地按同样的开关现取，取不到就整段不出现。 */
const loadLocalTimelyBlocks = async (
  char: CharacterProfile, realtimeConfig: RealtimeConfig | undefined, pack: AmsgFirePack, nowMs: number,
): Promise<{ realtimeWorldBlock: string; userHoliday: string }> => {
  const cfg = weatherForCharacter(realtimeConfig || defaultRealtimeConfig, char.id);
  const timeAware = char.timeAwarenessEnabled !== false;
  const [weather, news, userHoliday] = await Promise.all([
    cfg.weatherEnabled ? RealtimeContextManager.fetchWeather(cfg).catch(() => null) : null,
    cfg.newsEnabled ? RealtimeContextManager.fetchNews(cfg).catch(() => []) : [],
    // 与私聊同一份取法（设备时区），只是按模板的「现在」取，和角色那边的节日同一个时刻。
    timeAware && cfg.userHolidays?.enabled
      ? getUserHolidayReminder({ ...cfg.userHolidays, timeZone: deviceTimeZone() }, browserHolidayCache, nowMs, pack.targetName)
        .catch(() => '')
      : '',
  ]);
  return {
    realtimeWorldBlock: renderRealtimeWorldBlock({
      specialDates: timeAware ? checkSpecialDates(pack.tzId, nowMs) : [],
      weather,
      news: pickRandomNews(news, REALTIME_NEWS_PICK_COUNT),
    }),
    userHoliday,
  };
};

/**
 * 回复落库后的情绪评估：开关、副 API 选择和评估器都与私聊同一份（useChatAI 的
 * evaluateEmotionBackground，落 buff 和内心想法）。整份提示词就是角色此刻看到的上下文，
 * 没有另外的对话历史，与云端定时类到点评估的喂法一致。不阻塞后面的角色。
 */
const evaluateLocalTurnEmotion = async (
  char: CharacterProfile, userProfile: UserProfile, apiConfig: APIConfig, prompt: string,
): Promise<void> => {
  if (isEmotionEvalSkipped() || !isScheduleFeatureOn(char) || !char.emotionConfig?.enabled) return;
  const stream = !!(apiConfig.stream ?? false);
  const custom = char.emotionConfig.api;
  const api = custom?.baseUrl
    ? { ...custom, stream: (custom as typeof custom & { stream?: boolean }).stream ?? stream }
    : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model, stream };
  try {
    // 动态导入：useChatAI 自己也引用本模块。
    const { evaluateEmotionBackground } = await import('../hooks/useChatAI');
    await evaluateEmotionBackground(char, userProfile, prompt, [], api);
  } catch (error) {
    console.warn('[AwayMessage] 情绪评估失败', error);
  }
};

/** 用云端模板生成并落库，返回有没有真的发出去。 */
export const runLocalProactiveTurn = async (char: CharacterProfile, turn: LocalProactiveTurn): Promise<boolean> => {
  const api = resolveDialogueApi(turn.apiConfig, char);
  if (!api.baseUrl) return false;
  const { userProfile, groups, realtimeConfig } = turn;
  const dateLeave = turn.meta.dateLeaveReminder === true;
  const renderAt = turn.renderAt ?? Date.now();

  const [range, allEmojis, allCategories] = await Promise.all([
    loadCharacterContextRange(char), DB.getEmojis(), DB.getEmojiCategories(),
  ]);
  const { emojis, categories } = ChatPrompts.filterVisibleEmojis(allEmojis, allCategories, char.id);
  // 本地这一刻就知道是哪一类：世界书生效场景在打包时直接按这一类挑（与 worker 到点按类型
  // 去掉标记块的结果逐字一致，见 worldbook 的 renderWorldbookRolls）。
  const proactiveKind = dateLeave ? 'dateLeave' : 'away';
  const built = await buildFirePack(char, userProfile, groups, realtimeConfig, { all: allEmojis, categories: allCategories }, { proactiveKind });
  // 万一模板里带着推迟标记（概率条目等到点再抽），本地这一刻就是「到点」，
  // 用 Worker 同一个函数当场判一次。整轮（含二轮请求）共用这一次的结果。
  const pack = Array.isArray(built.worldbookRolls)
    ? { ...built, template: renderWorldbookRolls(built.template, built.worldbookRolls, undefined, proactiveKind) }
    : built;
  const timely = await loadLocalTimelyBlocks(char, realtimeConfig, pack, renderAt);
  const toMessages = (instruction: string) => [{
    role: 'user',
    content: renderLocalProactivePrompt(pack, renderAt, instruction, {
      dateLeave, includeClock: char.timeAwarenessEnabled !== false, ...timely,
    }),
  }];
  const messages = toMessages(turn.hint);

  // 采样温度、输出上限、思考参数与私聊同一套；这一轮请求不带任何工具。
  const llm = resolveDialogueLlmParams({
    api: { ...api, temperature: api.temperature ?? turn.apiConfig.temperature },
    thinkingActive: !!char.showThinkingChain,
    legacyToolModeActive: false,
    amsg2ToolsInjected: false,
  });
  const baseUrl = api.baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey || 'sk-none'}` };
  const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({
      model: llm.model || api.model,
      messages,
      ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
      max_tokens: llm.maxTokens,
      stream: false,
      ...llm.extraBody,
    }),
  }, 2, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: turn.purpose });

  const raw = extractContent(data);
  let placed = turn.place(raw).filter(p => p.text.trim());
  // 召回、搜索这类标签由后处理回连模型执行，二轮写的是整条新回复，没法再按段落到各自的时刻：
  // 这一轮合成一次，落在第一个时刻。
  const regenerates = hasSecondPassTag(raw);
  if (regenerates && placed.length > 1) placed = [{ text: placed.map(p => p.text).join('\n'), at: placed[0].at }];
  if (!placed.length) return false;
  const secondPassMessages = regenerates && turn.singleHint ? toMessages(turn.singleHint) : messages;

  // 用户回来了（stillWanted 为 false）就中止：每一段落库前、每一轮回连请求前都重新确认。
  // 中止走私聊停止回复那一套（replyRun）：之后的落库和回连都会被拦下。
  const run = createReplyRun(char.id);
  const savedTexts: string[] = [];
  const save = run.saveMessage;
  run.saveMessage = async (message) => {
    const id = await save(message);
    if (message.type === 'text' && typeof message.content === 'string') savedTexts.push(message.content);
    return id;
  };
  const ensureWanted = async () => {
    if (!await turn.stillWanted()) run.stop();
    run.check();
  };
  const notifyProgress = () => window.dispatchEvent(new CustomEvent('active-msg-progress'));
  let failure: unknown = null;
  try {
    for (const [i, { text, at }] of placed.entries()) {
      await ensureWanted();
      await applyAssistantPostProcessing(text, {
        char, userProfile, emojis, categories, realtimeConfig, groups,
        spokenAt: at,
        contextMsgs: range.messages,
        fullMessages: secondPassMessages,
        // 思考链只挂在第一段：整轮只有一份推理。
        initialData: i === 0 ? data : null,
        historyMsgCount: range.messages.length,
        mcdInheritMeta: turn.meta,
        xhsCaches: {
          xsecTokenCache: new Map(), noteTitleCache: new Map(), commentUserIdCache: new Map(),
          commentAuthorNameCache: new Map(), commentParentIdCache: new Map(),
        },
        api: { baseUrl, headers, effectiveApi: { baseUrl, apiKey: api.apiKey, model: api.model, maxTokens: api.maxTokens } },
        hooks: { setMessages: notifyProgress, addToast: () => {} },
        instantRender: true,
        messageTimestamp: at,
        replyRun: run,
        beforeSecondPass: ensureWanted,
      });
    }
    run.markCompleted();
  } catch (error) {
    if (!run.signal.aborted && !isReplyAbort(error)) failure = error;
  } finally {
    await run.settle();
  }
  // 中止：不弹通知、不评估、不销回执。
  if (run.signal.aborted) return false;
  // 出错时已经落库的那几段照样送达，不留「在库里、但没有通知」的消息；错误随后照常抛出。
  if (savedTexts.length) {
    void evaluateLocalTurnEmotion(char, userProfile, turn.apiConfig, messages[0].content);
    // 回执随提示词带给了角色，发出去才算告知过（与云端定时消息落地时同一口径）。
    if (pack.noticeIds?.length) {
      await ActiveMsgStore.markExpiredNoticesNotified(char.id, pack.noticeIds)
        .catch(error => console.warn('[AwayMessage] 回执销账失败', error));
    }
    const preview = savedTexts.map(t => t.split('%%BILINGUAL%%')[0]).join(' ').replace(/\s+/g, ' ').trim();
    // 未读、提示和系统通知沿用主动消息送达那一套。
    window.dispatchEvent(new CustomEvent('active-msg-received', {
      detail: { charId: char.id, charName: char.name, body: preview.slice(0, 120) },
    }));
  }
  if (failure) throw failure;
  return savedTexts.length > 0;
};
