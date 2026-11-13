/**
 * 离开后消息的纯逻辑：本地版判「这次上线要不要补」、怎么分时刻、怎么切模型输出，
 * 以及云端任务要不要往后推。不碰 DB / 网络，方便单测。说明见 docs/away-message.md。
 */
import type { CharacterProfile } from '../types';

export const AWAY_DELAY_OPTIONS = [30, 60, 90, 120, 180, 240, 360] as const;
export const DEFAULT_AWAY_DELAY_MINUTES = 90;

/** 本地版一次最多补几次（每次可以是好几个气泡）。 */
export const MAX_AWAY_SEGMENTS = 3;

/** 模型输出里分隔「不同时刻发的消息」的标记，单独占一行。 */
export const AWAY_SEGMENT_MARK = '[[NEXT]]';

/** 云端任务的排期离目标时刻差不到这么多就不去改它：差的那点由 worker 到点推迟兜住。 */
export const AWAY_RENEW_SLACK_MS = 10 * 60_000;

export const resolveAwayDelayMinutes = (char: Pick<CharacterProfile, 'awayMessage'>): number => {
  const minutes = char.awayMessage?.delayMinutes;
  return typeof minutes === 'number' && minutes > 0 ? minutes : DEFAULT_AWAY_DELAY_MINUTES;
};

interface MessageLike {
  role: string;
  timestamp: number;
  metadata?: Record<string, any> | null;
}

// 线下见面与实时通话只在双方同时在场时产生。线上 assistant 消息必须跳过，免得主动消息、
// 见面离开提醒或手机卡片把离开计时重置；而见面开场白、重随回复、通话挂断记录，以及用户删掉
// 自己的推进词后留下的见面/通话正文，都代表那个时刻双方刚互动过。后续若新增实时在场渠道，
// 或把某类见面/通话记录改成后台自动生成，需要同步调整这里的来源集合。
const IN_PERSON_SOURCES = new Set(['date', 'call', 'call-end-popup']);

export const isAwayActivityAnchor = (message: MessageLike): boolean => {
  if (message.metadata?.proactiveHint) return false;
  const source = message.metadata?.source;
  if (typeof source === 'string' && IN_PERSON_SOURCES.has(source)) return true;
  return message.role === 'user';
};

/** 最近一次在场互动的时刻（供云端排程与 fire_pack 快照共用，消息按时间升序传入）。 */
export const getLastAwayAnchorAt = (messages: MessageLike[]): number | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAwayActivityAnchor(messages[i])) return messages[i].timestamp;
  }
  return null;
};

/**
 * 本地版：消息按时间升序传入。最后一次互动（用户发言，或线下见面/通话记录）已经超过等待时长、
 * 且那之后还没补过离开后消息时，返回那次互动的时刻；否则 null。一次离开只补一次，再次互动后重新计时。
 */
export const findAwayGapStart = (messages: MessageLike[], delayMs: number, nowMs: number): number | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.metadata?.awayMessage) return null;
    if (isAwayActivityAnchor(m)) {
      return nowMs - m.timestamp >= delayMs ? m.timestamp : null;
    }
  }
  return null;
};

/**
 * 本地版：离开期间角色「发过消息」的几个时刻。离开越久次数越多（每过一个等待时长一次，
 * 最多 MAX_AWAY_SEGMENTS 次），第一次落在等待时长刚满的时候，其余均匀铺到现在之前。
 */
export const planAwaySlots = (lastUserAt: number, delayMs: number, nowMs: number): number[] => {
  const start = lastUserAt + delayMs;
  const end = Math.max(start, nowMs - 60_000);
  const count = Math.min(MAX_AWAY_SEGMENTS, Math.max(1, Math.floor((nowMs - lastUserAt) / delayMs)));
  return Array.from({ length: count }, (_, i) => Math.round(start + ((end - start) * i) / count));
};

/** 按 AWAY_SEGMENT_MARK 切开模型输出：去掉空段，多出来的并进最后一段。 */
export const splitAwaySegments = (raw: string, maxSegments: number): string[] => {
  const parts = raw.split(AWAY_SEGMENT_MARK).map(s => s.trim()).filter(Boolean);
  if (parts.length <= maxSegments) return parts;
  return [...parts.slice(0, maxSegments - 1), parts.slice(maxSegments - 1).join('\n')];
};

/**
 * 云端版：这一轮该怎么处理已有的那条任务。
 * - 'keep'：排期已经够晚（离目标不到 AWAY_RENEW_SLACK_MS），不发请求；
 * - 'renew'：有记录但排早了，原地改期；
 * - 'create'：没有记录。
 */
export const decideAwayTaskAction = (
  recordSendAtMs: number | null,
  targetMs: number,
  nowMs: number,
): 'keep' | 'renew' | 'create' => {
  if (recordSendAtMs == null) return 'create';
  if (recordSendAtMs > nowMs && recordSendAtMs >= targetMs - AWAY_RENEW_SLACK_MS) return 'keep';
  return 'renew';
};
