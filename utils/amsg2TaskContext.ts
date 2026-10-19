// utils/amsg2TaskContext.ts
/**
 * 排程现状块（浏览器侧编排）。
 *
 * useChatAI 每轮组请求时调 collectAmsg2TaskContext，把「常驻能力简介 + 进行中任务 +
 * 未告知的回执」拼成一段 system 背景块。
 * 回执有两种来源，都记在同一本台账（ActiveMsgStore 的 expiredNotices）上：
 *   - 到点没发：云端回的「这次没发」结果，由 amsgFireSkipResultApply 写进来；
 *   - 用户在面板手动取消 / 关掉 2.0：面板调 buildUserCancelledNotices 写进来。
 * 常驻简介总在（角色得随时知道自己能给未来排消息），进行中/回执两段有料才出现。
 * 发送成功后调 ActiveMsgStore.markExpiredNoticesNotified 标记，失败下轮重注（回执不丢）。
 */

import { ActiveMsg2TaskRecord, Amsg2ExpiredNoticeRecord, CharacterProfile } from '../types';
import { ActiveMsgStore } from './activeMsgStore';
import { resolveCharTimeZone } from './timezone';
import { buildAmsg2ChatScheduleBrief } from './amsgFireSchedule';
import {
  AMSG2_SCHEDULE_NOT_YET_NOTE, AMSG2_SCHEDULE_SECRECY_NOTE, currentOccurrenceMs, describeExpirePolicy,
  describeRecurrence, describeTaskMode, formatTaskTime, getPendingTasks, isPendingTask,
  shortTaskId,
} from './amsg2Tasks';

/**
 * 用户在面板里手动取消任务 / 关掉 2.0 时，给角色留的交代。
 *
 * 不留的话，聊天里那句「明早八点叫你～」就永远停在承诺状态：任务其实早没了，角色
 * 下次还接着说「放心我叫你」。所以手动取消也记一条回执，角色下一轮就知道黄了。
 * 只给「还会响」的任务写——已经发过的一次性任务没有承诺可撤，写了纯属噪音。
 */
export function buildUserCancelledNotices(
  charId: string,
  tasks: ActiveMsg2TaskRecord[],
  nowMs: number = Date.now(),
): Amsg2ExpiredNoticeRecord[] {
  return tasks
    .filter((t) => isPendingTask(t, nowMs))
    .map((t) => ({
      // 编号跟「到点没发」的回执分开：同一条任务可能先有一次没发、之后才被手动取消，两件事都得说。
      // 同一条任务重复取消只会命中同一个 id，台账按 id 去重，天然幂等。
      id: `${t.taskUuid}:cancelled`,
      charId,
      occurrenceMs: currentOccurrenceMs(t, nowMs) ?? new Date(t.firstSendTime).getTime(),
      mode: t.mode,
      promptHint: t.promptHint,
      recurrenceType: t.recurrenceType,
      kind: 'user-cancelled' as const,
      createdAt: nowMs,
    }));
}

/** 「到点没发」那一行末尾补的原因。角色自己决定不说的不用再解释。 */
const describeSkipReason = (reason: Amsg2ExpiredNoticeRecord['reason'], target: string): string => {
  switch (reason) {
    case 'declined':
      return '你当时看了对话，决定不说';
    case 'empty-generation':
    case 'side-effects-only':
      return '当时没写出要说的话';
    case 'stale':
      return '到点时服务中断了，过去太久没再补发';
    case 'unanswered-limit':
    case 'min-gap':
    case 'recurring-unanswered':
    case 'daily-limit':
      return `被${target}定的主动消息频率规矩拦下了`;
    default:
      return '';
  }
};

/** 回执条目那一行（到点没发和手动取消长一个样，只是所在的段落不同）。 */
const describeNoticeLine = (
  r: Amsg2ExpiredNoticeRecord,
  charTz: string | undefined,
  target: string,
): string => {
  const recurrence = r.recurrenceType === 'daily' ? '（每日循环的当次）'
    : r.recurrenceType === 'weekly' ? '（每周循环的当次）' : '';
  const reason = r.kind === 'user-cancelled' ? '' : describeSkipReason(r.reason, target);
  return `- [${shortTaskId(r.id)}] 原定 ${formatTaskTime(r.occurrenceMs, charTz)}，${describeTaskMode(r)}${recurrence}`
    + (reason ? `——${reason}` : '');
};

/**
 * 回执的两个段落（到点没发 / 用户手动取消）。给角色的交代完全不同（前者可以续期
 * 补上，后者是用户不要了），分成两段说。
 * 完整排程现状块和「回执单独成块」（即时对话云端路径）共用这一份文案。
 */
const buildNoticeSections = (
  expired: Amsg2ExpiredNoticeRecord[],
  charTz: string | undefined,
  target: string,
): string[] => {
  const parts: string[] = [];
  const skipped = expired.filter((r) => r.kind !== 'user-cancelled');
  const userCancelled = expired.filter((r) => r.kind === 'user-cancelled');

  if (skipped.length) {
    parts.push('到点没发出去：');
    for (const r of skipped) {
      parts.push(describeNoticeLine(r, charTz, target));
    }
    parts.push([
      '这几条的处理由你判断，三选一：',
      '1. 就地消化：只在当前时间与话题都合适时自然带进对话——先想「现在提这个还合不合适」（早安任务拖到晚上就别再道早安），不要因为看到这份回执就强行转移当前话题。',
      '2. 另约时间：这些回执不是待执行任务。还想之后专门说，用 schedule_active_message 新排一条一次性任务；循环任务的后续节奏照旧，不要拿回执编号改期或取消。',
      '3. 放弃：已经没意义就只字不提。',
    ].join('\n'));
  }

  if (userCancelled.length) {
    parts.push('已被手动取消：');
    for (const r of userCancelled) {
      parts.push(describeNoticeLine(r, charTz, target));
    }
    parts.push('这几条是用户直接取消的，相关约定不再生效，自然接受即可、不必向用户求证，也别再拿它们许诺。还想在别的时间说的话，用 schedule_active_message 重新排一条。');
  }

  return parts;
};

/**
 * 回执单独成块（即时对话云端路径用）。
 *
 * 云端自己渲染排程清单，并用共用的 buildAmsg2ChatScheduleBrief 提供聊天能力简介；chat 段里
 * 只欠回执这一样——所以这里不带常驻简介、不带进行中清单，避免和到点渲染的那份撞车。
 * 没有回执时返回 null，整块不出现（与本地「有料才出现」同一个做法）。
 */
export function buildAmsg2NoticesText(
  expired: Amsg2ExpiredNoticeRecord[],
  charTz: string | undefined,
  targetName?: string,
): string | null {
  if (!expired.length) return null;
  const target = targetName?.trim() || '对方';
  return [
    '【你的主动消息排程·仅你可见】',
    ...buildNoticeSections(expired, charTz, target),
    AMSG2_SCHEDULE_SECRECY_NOTE.replace('用户', target),
  ].join('\n');
}

/** 纯拼文案，方便单测。常驻简介总在，进行中/回执两段有料才各自出现。 */
export function buildAmsg2TaskContextText(
  pending: ActiveMsg2TaskRecord[],
  expired: Amsg2ExpiredNoticeRecord[],
  nowMs: number = Date.now(),
  /**
   * 角色的时间参照系（没开自定义时区时为 undefined，跟着设备走）。
   * 位置参数不设默认值：这一段是给角色看的，调用方必须显式想过时间该按谁的钟写。
   */
  charTz: string | undefined,
  /**
   * 本轮工具循环里刚排出来的任务 uuid。
   *
   * 工具循环第二轮起这份清单是现算的，里面混着「本来就有的」和「角色刚排的」。不点名
   * 的话角色分不清，容易当成别人排的、再排一条一样的——现场那次「一句『等会找我』排出
   * 5 条」就有这一份。空集合等于没传：首轮那份是排程前的快照，不该凭空长出提醒。
   */
  createdThisTurn?: ReadonlySet<string>,
  /** ChatApp 当前用户名；空值回退为「对方」。 */
  targetName?: string,
  /** 「用户给你定的规矩」（amsgLimits.buildLimitsBrief），紧跟常驻简介。 */
  limitsBrief?: string,
): string {
  const target = targetName?.trim() || '对方';
  const isNewThisTurn = (taskUuid: string) => !!createdThisTurn?.has(taskUuid);
  const hasNewThisTurn = pending.some((t) => isNewThisTurn(t.taskUuid));
  const parts: string[] = ['【你的主动消息排程·仅你可见】', buildAmsg2ChatScheduleBrief(target)];
  if (limitsBrief) parts.push(limitsBrief);

  if (pending.length) {
    parts.push('进行中：');
    for (const t of pending) {
      // 循环任务写「下一次」的时间。写 firstSendTime 的话，一条每天的任务在角色眼里
      // 是个好几天前的时刻，它会当成已经过去的排程，然后在对话里说漏嘴或重复排一条。
      const occurrenceMs = currentOccurrenceMs(t, nowMs);
      parts.push(`- [${shortTaskId(t.taskUuid)}] ${formatTaskTime(occurrenceMs ?? t.firstSendTime, charTz)} ${describeRecurrence(t.recurrenceType)}`
        + ` · ${describeTaskMode(t)} · ${describeExpirePolicy(t.expirePolicy)}`
        + (isNewThisTurn(t.taskUuid) ? ' · 本轮刚排的' : ''));
    }
    parts.push('（想调整就用 schedule/cancel/renew 工具；内容方向变了用 cancel + schedule 重建。'
      + (hasNewThisTurn ? '标着「本轮刚排的」是你这次回复里已经排好的，别再排一条一样的。' : '')
      + '）');
    // 只在有任务时说：一条都没排的时候没有可催的事，白占一行还提醒模型「催」这件事存在。
    parts.push(AMSG2_SCHEDULE_NOT_YET_NOTE);
  }

  parts.push(...buildNoticeSections(expired, charTz, target));

  // 约束放在块尾，管住上面每一种形态。挂在某一段里的话，只有进行中任务的那次就是裸奔的：
  // 短 id、「到点看情况」这些系统腔会被角色当成可以复述的内容念出来。
  parts.push(AMSG2_SCHEDULE_SECRECY_NOTE.replace('用户', target));

  return parts.join('\n');
}

/**
 * 把排程块插进本轮要发的消息数组：紧挨易变尾段**之前**，而不是贴数组尾巴。
 *
 * 「回到你自己」钢印焊在 volatileTail 末尾，靠 recency 抢模型开口前的最后一眼
 * （chatRequestPayload 的 volatileTailIndex 就是给这种块定位用的）。这一块贴在它后面
 * 的那阵子，模型最后读到的是一份带 promptHint 原文的待办清单，于是把排在今晚的任务
 * 当成本轮就该办的事——用户侧的表现是「说了今天要看书，之后每轮结尾都问看到哪了」。
 *
 * 插入点落在本轮用户消息之后，而前缀缓存的断点比它更靠前，所以命中率一个 token 都不动。
 * volatileTailIndex 为 -1（prompt build 跳过 / dev 的 system 合并开关）时退回贴尾：
 * 位置不理想，但块本身不能丢——角色得知道自己名下有哪些任务，否则会重复排。
 */
export function insertAmsg2TaskContextBlock<T>(
  messages: T[],
  block: T,
  volatileTailIndex: number,
): T[] {
  if (volatileTailIndex < 0 || volatileTailIndex > messages.length) return [...messages, block];
  return [...messages.slice(0, volatileTailIndex), block, ...messages.slice(volatileTailIndex)];
}

export interface Amsg2TaskContextResult {
  text: string;
  /** 本轮注入的回执 id（到点没发的 + 用户手动取消的），发送成功后 markExpiredNoticesNotified。 */
  expiredIds: string[];
  /**
   * 本轮要告知的回执原始记录。
   *
   * 工具循环里每发一次请求都要按最新任务清单重渲染这一块，而回执这半边一轮只该读
   * 一次（同一轮里中途新到的回执留给下一轮）。把记录交出去，后续轮次直接拿它配上新的
   * pending 调 buildAmsg2TaskContextText 就行，不用再碰台账。
   */
  notices: Amsg2ExpiredNoticeRecord[];
}

export async function collectAmsg2TaskContext(
  char: CharacterProfile,
  targetName?: string,
): Promise<Amsg2TaskContextResult> {
  const config = char.activeMsg2Config;
  const now = Date.now();

  const unnotified = (await ActiveMsgStore.getExpiredNotices(char.id)).filter((r) => !r.notifiedAt);
  const pending = getPendingTasks(config, now);
  return {
    // 时间按角色的钟写：这一段是给角色看的，到点 worker 渲染的那份也是角色时区，
    // 两边对不上的话，纽约角色会在同一轮里读到差一个时差的两个「同一条任务」。
    text: buildAmsg2TaskContextText(
      pending, unnotified, now, resolveCharTimeZone(char), undefined, targetName,
    ),
    expiredIds: unnotified.map((r) => r.id),
    notices: unnotified,
  };
}
