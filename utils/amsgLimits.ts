/**
 * 主动消息的「频率与额度」：用户给每个角色定的上限，以及这些上限怎么落到代码里的闸。
 *
 * 角色在主动消息上有不少自由度——自己给自己排下一条、挑时间、挑要不要每天重复。这份
 * 模块管的是这些自由的边界：边界由用户定，用户没定的用这里的默认值。每一项都是代码里
 * 实打实拦住的硬闸（排程时打回、到点时跳过），提示词只负责把「还剩多少额度」告诉角色，
 * 让它在额度内自己挑时机，而不是靠一句劝告去指望它自觉。
 *
 * 上限的原始值住在角色的 activeMsg2Config 上（面板写），两边各自解析成生效值：
 *   - 客户端：前台工具桥、面板建任务直接读 config；
 *   - worker：读客户端同步上去的 `limits` 记录（每角色一份，见 buildAmsgLimitsRecord）。
 * 两边都过 resolveAmsgLimits，默认值只在这里定义一次。
 *
 * 零运行时依赖（worker bundle 会打进这份代码），只有纯函数和常量。
 */

import type { ActiveMsg2CharacterConfig } from '../types';

// ─── 默认值 ───

/** 你没回时，角色最多连着主动找你几次（0 = 不限）。一次可以是好几段气泡。 */
export const DEFAULT_MAX_UNANSWERED_SENDS = 3;
/** 角色自己排的两次主动消息之间至少隔多少分钟（0 = 不额外限制）。 */
export const DEFAULT_MIN_SEND_GAP_MINUTES = 10;
/** 每天最多主动发几次（0 = 不限）。默认不限：这是用户想管钱包时才去开的那道闸。 */
export const DEFAULT_DAILY_SEND_CAP = 0;
/** 重复的消息连续几次没回就先停（0 = 不停）。 */
export const DEFAULT_RECURRING_STOP_AFTER = 3;
/** 同时最多排好几次（用户和角色共用这些名额，重复的只占一个）。 */
export const DEFAULT_MAX_ACTIVE_TASKS = 5;
/** 设置里能选到的「同时排好几次」上限。 */
export const MAX_ACTIVE_TASKS_CEILING = 10;

/** 用户在面板上能调的那几项（都挂在 ActiveMsg2CharacterConfig 上，没设 = 用默认值）。 */
export type AmsgPacingSettings = Pick<
  ActiveMsg2CharacterConfig,
  | 'maxUnansweredSends'
  | 'minSendGapMinutes'
  | 'dailySendCap'
  | 'recurringStopAfter'
  | 'maxActiveTasks'
  | 'allowSelfRecurring'
  | 'allowSelfForce'
>;

/** 所有上限字段名，拷贝 / 挑字段时用这一份，别在各处手抄。 */
export const AMSG_PACING_FIELDS = [
  'maxUnansweredSends',
  'minSendGapMinutes',
  'dailySendCap',
  'recurringStopAfter',
  'maxActiveTasks',
  'allowSelfRecurring',
  'allowSelfForce',
] as const satisfies ReadonlyArray<keyof AmsgPacingSettings>;

export const pickPacingSettings = (
  source: Partial<AmsgPacingSettings> | null | undefined,
): AmsgPacingSettings => {
  const out: AmsgPacingSettings = {};
  if (!source) return out;
  for (const field of AMSG_PACING_FIELDS) {
    if (source[field] !== undefined) (out as Record<string, unknown>)[field] = source[field];
  }
  return out;
};

/** 解析后的生效值。「不限」一律是 Infinity，闸里直接比大小就行。 */
export interface AmsgLimits {
  maxUnansweredSends: number;
  /** 毫秒；0 = 不额外限制（到点的技术下限 1 分钟另算）。 */
  minSendGapMs: number;
  dailySendCap: number;
  recurringStopAfter: number;
  maxActiveTasks: number;
  allowSelfRecurring: boolean;
  allowSelfForce: boolean;
}

/**
 * 「N 或不限」类的数值：0 = 不限（Infinity），没设 / 坏值 = 默认，其余取正整数并封顶。
 * 默认值本身是 0 的那一项（每日上限），没设时同样落到不限。
 */
const resolveCount = (value: unknown, fallback: number, ceiling: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback === 0 ? Infinity : fallback;
  }
  if (value === 0) return Infinity;
  if (value < 1) return fallback === 0 ? Infinity : fallback;
  return Math.min(ceiling, Math.floor(value));
};

/** 用户设置 → 生效上限（连发上限单独导出，老调用方还在用这一个）。 */
export const resolveMaxUnansweredSends = (value: unknown): number =>
  resolveCount(value, DEFAULT_MAX_UNANSWERED_SENDS, 99);

export const resolveAmsgLimits = (
  settings: Partial<AmsgPacingSettings> | null | undefined,
): AmsgLimits => {
  const s = settings ?? {};
  const gap = s.minSendGapMinutes;
  const gapMinutes = typeof gap === 'number' && Number.isFinite(gap) && gap >= 0
    ? Math.min(24 * 60, Math.floor(gap))
    : DEFAULT_MIN_SEND_GAP_MINUTES;
  const tasks = s.maxActiveTasks;
  return {
    maxUnansweredSends: resolveMaxUnansweredSends(s.maxUnansweredSends),
    minSendGapMs: gapMinutes * 60_000,
    dailySendCap: resolveCount(s.dailySendCap, DEFAULT_DAILY_SEND_CAP, 999),
    recurringStopAfter: resolveCount(s.recurringStopAfter, DEFAULT_RECURRING_STOP_AFTER, 99),
    // 任务名额没有「不限」这一档：挂太多等于把「同时有几件事在后台排队」这件事交出去了。
    maxActiveTasks: typeof tasks === 'number' && Number.isFinite(tasks) && tasks >= 1
      ? Math.min(MAX_ACTIVE_TASKS_CEILING, Math.floor(tasks))
      : DEFAULT_MAX_ACTIVE_TASKS,
    allowSelfRecurring: s.allowSelfRecurring === true,
    allowSelfForce: s.allowSelfForce === true,
  };
};

// ─── 云端那份记录 ───

/**
 * 每角色一份，住在 `amsg:char:<id>` 命名空间的这个 key 上。
 *
 * 单独成一份而不是塞进 fire_pack：fire_pack 只在「有待发任务、聊完一轮」时才重传，
 * 用户在面板改了上限要等下一次重传才生效——角色在云端给自己排、手机还没收到的那些
 * 任务，会一直按旧上限跑。这份记录小，保存设置时单独立刻传；每次传 fire_pack 也顺手
 * 带一份（见 activeMsgClient 的 buildCharStateEntries），两条路都认同一个构造函数。
 */
export const AMSG_LIMITS_KEY = 'limits';

export interface AmsgLimitsRecord extends AmsgPacingSettings {
  v: 1;
  /**
   * 这个角色的主动消息 2.0 开没开（写入那一刻的 isAmsg2EnabledForChar）。
   *
   * fire_pack 上也有同名字段，但 fire_pack 要等下一次重传才更新。用户关掉 2.0 时先把这份
   * 小记录写成 false 再去取消任务：取消扫完之后才冒出来的自排任务（正在跑的那一轮顺手
   * 排的），到点时 worker 读到 false 就直接跳过，一个 token 都不花。
   */
  selfScheduleEnabled: boolean;
}

export const buildAmsgLimitsRecord = (
  config: Partial<AmsgPacingSettings> | null | undefined,
  selfScheduleEnabled: boolean,
): AmsgLimitsRecord => ({
  v: 1,
  selfScheduleEnabled,
  ...pickPacingSettings(config),
});

/** 读回来的记录；形状不对返回 null（worker 按默认值走——默认值本身就是偏严的那一侧）。 */
export const parseAmsgLimitsRecord = (value: string | null | undefined): AmsgLimitsRecord | null => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AmsgLimitsRecord> | null;
    if (parsed && typeof parsed === 'object' && parsed.v === 1
      && typeof parsed.selfScheduleEnabled === 'boolean') {
      return parsed as AmsgLimitsRecord;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

// ─── 每日计数 ───

/**
 * 今天这个角色主动发了几次（每角色一份，worker 每次发完累加）。
 *
 * 按**用户那边**的日期算：这是用户的钱包闸，「今天」得是用户自己的今天，跟角色活在
 * 哪个时区无关。换日了就从零数起，不用清。
 */
export const AMSG_DAILY_SENDS_KEY = 'daily_sends';

export interface AmsgDailySends {
  v: 1;
  /** 用户时区下的日期 YYYY-MM-DD。 */
  day: string;
  /** 这一天主动发出去的次数（一次 = 一条主动消息，分几段气泡也只算一次）。 */
  sends: number;
  /**
   * 这一天后台调了几次模型（含失败、含被判空没发出去的那几次）。
   * 上游从 amsg-server 新版起才报这个数，老版本上没有，这一项就一直不出现。
   */
  llmCalls?: number;
  /**
   * 今天已经算过「发了一次」的那几次触发（`<clientTaskId>@<触发时刻>`，只留最近几条）。
   * 同一次触发失败重跑时不再多算一次。
   */
  counted?: string[];
}

/** counted 最多留几条：同一次触发的重跑都挨得很近，留一小截就够认出来。 */
const DAILY_COUNTED_KEEP = 20;

/** nowMs 在某个时区下的日期 YYYY-MM-DD（Intl 算，禁手搓时差）。 */
export const dayKeyInZone = (nowMs: number, tzId: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tzId, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
};

export const parseDailySends = (value: string | null | undefined): AmsgDailySends | null => {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AmsgDailySends> | null;
    if (parsed && typeof parsed === 'object' && parsed.v === 1
      && typeof parsed.day === 'string' && typeof parsed.sends === 'number') {
      return parsed as AmsgDailySends;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

/** 某一天已经主动发了几次（记录是别的日子的 = 0）。 */
export const sendsOnDay = (record: AmsgDailySends | null, day: string): number =>
  record && record.day === day ? record.sends : 0;

/**
 * 累加一次。换日了从零起算。
 *
 * 带了 sentId 的「发了一次」按触发去重：同一次触发重跑（前一跳部分失败）只算一次。
 * 模型调用次数不去重——重跑那一跳确实又花了一次钱。
 */
export const bumpDailySends = (
  record: AmsgDailySends | null,
  day: string,
  add: { sends?: number; llmCalls?: number; sentId?: string },
): AmsgDailySends => {
  const base: AmsgDailySends = record && record.day === day ? record : { v: 1, day, sends: 0 };
  const alreadyCounted = !!add.sentId && (base.counted ?? []).includes(add.sentId);
  const sends = base.sends + (alreadyCounted ? 0 : add.sends ?? 0);
  const llmCalls = add.llmCalls
    ? (base.llmCalls ?? 0) + add.llmCalls
    : base.llmCalls;
  const counted = add.sentId && add.sends && !alreadyCounted
    ? [...(base.counted ?? []), add.sentId].slice(-DAILY_COUNTED_KEEP)
    : base.counted;
  return {
    v: 1,
    day,
    sends,
    ...(llmCalls !== undefined ? { llmCalls } : {}),
    ...(counted ? { counted } : {}),
  };
};

// ─── 两条之间的间隔 ───

/**
 * 按间隔要求，从 fromMs 起往后找第一个能排的时刻：离 busy 里每个时刻都至少隔 gapMs。
 * busy 是已经排着的那些触发时刻（以及刚发出去的那一条）。
 */
export const earliestSlotAfter = (fromMs: number, gapMs: number, busy: number[]): number => {
  if (gapMs <= 0) return fromMs;
  const sorted = [...busy].filter(Number.isFinite).sort((a, b) => a - b);
  let slot = fromMs;
  // slot 只会往后挪，busy 是有限集合，挪不动的那一轮就收敛了。
  for (let moved = true; moved;) {
    moved = false;
    for (const b of sorted) {
      if (Math.abs(slot - b) < gapMs) {
        slot = b + gapMs;
        moved = true;
      }
    }
  }
  return slot;
};

/** sendAtMs 和 busy 里哪个时刻挨得太近（没有就 null）。 */
export const findGapConflict = (sendAtMs: number, gapMs: number, busy: number[]): number | null => {
  if (gapMs <= 0) return null;
  return busy.find((b) => Number.isFinite(b) && Math.abs(sendAtMs - b) < gapMs) ?? null;
};

/**
 * 到点那道间隔闸的宽限。
 *
 * 排程时的间隔是拿「这条开始生成的时刻」算的，而上一条记进日志的时刻是它真发出去的
 * 那一刻——中间隔着一次生成（十几秒到一两分钟），再加上定时器一分钟一跳的误差。不留
 * 这点余量的话，一条正好卡着间隔排下的消息到点会被自己的上一条判成「太近」。
 */
export const FIRE_GAP_TOLERANCE_MS = 3 * 60_000;

/** 分钟数说成人话：90 → 「1 小时 30 分钟」。 */
export const describeMinutes = (minutes: number): string => {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
};

// ─── 角色排程时的规矩 ───

/**
 * 角色自排的硬间隔，不随用户设置放开：跟已排的任务、上一次主动消息相差 2 分钟以内（含 2 分钟）
 * 一律打回。send_at 精确到分，「不到 3 分钟」就是「2 分钟以内」。
 * 用户把间隔设成 0 是「不介意连着找我」，不是「同一时刻排好几条」。
 */
export const SELF_SCHEDULE_HARD_GAP_MS = 3 * 60_000;

export type SelfScheduleRecurrence = 'none' | 'daily' | 'weekly';
export type SelfScheduleExpirePolicy = 'expire' | 'force';

export interface SelfScheduleRuleInput {
  limits: AmsgLimits;
  sendAtMs: number;
  recurrence: SelfScheduleRecurrence;
  expirePolicy: SelfScheduleExpirePolicy;
  /**
   * 离得太近就不行的那些时刻：已经排着的任务的下一次触发，加上「用户没回之后角色
   * 最近一次主动发出去的时刻」（到点生成时这一条本身也算，它正在发）。
   */
  busy: number[];
  /** 最早能从哪一刻起排（现在 + 技术下限）。算「最早能排到几点」用。 */
  earliestMs: number;
  /** 把时刻说成角色那边的钟（打回文案用）。 */
  formatTime: (ms: number) => string;
}

export type SelfScheduleRuleResult =
  | { ok: true; expirePolicy: SelfScheduleExpirePolicy }
  | { ok: false; reason: 'recurring_not_allowed' | 'min_gap'; message: string };

/**
 * 角色自己排一条主动消息之前，按用户定的规矩过一遍。前台工具桥和到点生成里的排程
 * 工具共用这一份，两个入口说同一套话。
 *
 * 「到点必发」没开时不打回、直接按普通的排：这是把一条消息改成更安静的那一种，角色
 * 不需要为此再来一轮；回话里会写明排成了哪种，它看得见。
 */
export const checkSelfScheduleRules = (input: SelfScheduleRuleInput): SelfScheduleRuleResult => {
  const { limits } = input;
  if (input.recurrence !== 'none' && !limits.allowSelfRecurring) {
    return {
      ok: false,
      reason: 'recurring_not_allowed',
      message: '用户没有让你排每天/每周重复的消息，这次只能排一次性的（去掉 recurrence 再排）。',
    };
  }
  const userGapApplies = limits.minSendGapMs >= SELF_SCHEDULE_HARD_GAP_MS;
  const gapMs = Math.max(limits.minSendGapMs, SELF_SCHEDULE_HARD_GAP_MS);
  const conflict = findGapConflict(input.sendAtMs, gapMs, input.busy);
  if (conflict !== null) {
    const earliest = earliestSlotAfter(Math.max(input.earliestMs, input.sendAtMs), gapMs, input.busy);
    return {
      ok: false,
      reason: 'min_gap',
      message: userGapApplies
        ? `离 ${input.formatTime(conflict)} 那次太近了：用户定了两次主动消息之间至少隔 ${describeMinutes(Math.round(limits.minSendGapMs / 60_000))}。`
          + `要排的话最早 ${input.formatTime(earliest)}；没那么要紧的话，这次就别排了。`
        : `${input.formatTime(conflict)} 前后已经有一次主动消息了，同一时刻不能再排一条。`
          + '如果是同一件事，它已经排着，不用再排；要换时间或内容，改原来那条（renew / cancel）。',
    };
  }
  return {
    ok: true,
    expirePolicy: input.expirePolicy === 'force' && !limits.allowSelfForce ? 'expire' : input.expirePolicy,
  };
};

// ─── 告诉角色的那几句 ───

export interface LimitsBriefInput {
  limits: AmsgLimits;
  /** 用户没回期间已经主动找了 / 排了几次（前台聊天时用户刚开口，传 0）。 */
  committedSends: number;
  /** 现在挂着几个排程任务（算任务名额）。 */
  activeTasks: number;
  /** 下一条最早能排到几点（已经按间隔算好、说成角色那边的钟）；没有间隔要求时不传。 */
  earliestText?: string;
  /** 今天还能再主动找几次（到点生成时才知道；前台不传）。 */
  dailyRemaining?: number;
}

/**
 * 「用户给你定的规矩」那一段：只列跟排程有关、而且真在限制它的几条，说成事实。
 * 超出的系统会直接打回——把额度摆在它面前，比让它排了再被打回省一轮。
 */
export const buildLimitsBrief = (input: LimitsBriefInput): string => {
  const { limits } = input;
  const lines: string[] = [];
  // 额度只报「已用/上限」：说成「还能再排 N 次」读起来像在催它把名额用掉。
  if (Number.isFinite(limits.maxUnansweredSends)) {
    const used = Math.min(limits.maxUnansweredSends, Math.max(0, input.committedSends));
    lines.push(`- 对方没回期间的主动联系：已用 ${used}/${limits.maxUnansweredSends} 次（一次可以说好几句；排好还没发的也算）`
      + (used < limits.maxUnansweredSends ? '。' : '，已满，等对方回复后才能再排。'));
  }
  if (limits.minSendGapMs > 0) {
    lines.push(`- 两次主动找对方之间至少隔 ${describeMinutes(Math.round(limits.minSendGapMs / 60_000))}`
      + (input.earliestText ? `，这次最早排到 ${input.earliestText}。` : '。'));
  }
  if (input.dailyRemaining !== undefined && Number.isFinite(limits.dailySendCap)) {
    const remaining = Math.min(limits.dailySendCap, Math.max(0, input.dailyRemaining));
    lines.push(`- 今天的主动联系：已用 ${limits.dailySendCap - remaining}/${limits.dailySendCap} 次`
      + (remaining > 0 ? '。' : '，已满，要排就排到明天。'));
  }
  lines.push(`- 排程任务：挂着 ${input.activeTasks}/${limits.maxActiveTasks} 个。`);
  if (!limits.allowSelfRecurring) lines.push('- 只能排一次性的，不能排每天/每周重复的。');
  if (!limits.allowSelfForce) lines.push('- 排的消息到点碰上对方正在聊天会自动作罢（转成你在聊天里自然带出），没有「到点必发」。');
  return ['用户给你定的规矩（系统照着执行：超出的排不上，排上了到点也不发）：', ...lines].join('\n');
};
