/**
 * 离开后消息的提示词说法（worker 到点填 fire_pack 的任务指令槽；本地版走同一份模板渲染）：
 * 按最后一次在场互动的类型
 * （线上发言 / 线下见面 / 通话挂断）换说法，3 小时内刚见过面时切到「刚分开」的语境。
 *
 * 会被打进 worker bundle，只许依赖同样零浏览器依赖的叶子模块。
 */
import type { Message } from '../types';
import { isAwayActivityAnchor } from './awayMessageCore';
import { formatFireTimeShort } from './amsgFirePack';

const DATE_AFTERGLOW_MS = 3 * 60 * 60_000;

type AwayMessageLike = Pick<Message, 'role' | 'timestamp' | 'metadata'>;

/**
 * 离开计时起点的类型信息。本地从消息现读；云端打包时摘出来随 fire_pack 带上，
 * worker 到点按触发时刻判「刚分开」。
 */
export interface AwayAnchorInfo {
  /** 最后一次在场互动的来源（'date' / 'call' / 'call-end-popup'）；线上发言为 null。 */
  source: string | null;
  /** 最后一条真实记录是见面正文时它的时刻，否则 null。 */
  lastDateAt: number | null;
}

export const readAwayAnchorInfo = (recent: AwayMessageLike[]): AwayAnchorInfo => {
  const lastAnchor = [...recent].reverse().find(isAwayActivityAnchor);
  const source = typeof lastAnchor?.metadata?.source === 'string' ? lastAnchor.metadata.source : null;
  const lastReal = [...recent].reverse().find(m => m.role !== 'system' && !m.metadata?.proactiveHint);
  return { source, lastDateAt: lastReal?.metadata?.source === 'date' ? lastReal.timestamp : null };
};

export const isJustMetOffline = (info: AwayAnchorInfo, now: number): boolean =>
  info.lastDateAt != null && now >= info.lastDateAt && now - info.lastDateAt < DATE_AFTERGLOW_MS;

/** 「上次在场互动是什么、之后没在线上聊过」那一句，不带句末标点（两条路接的尾巴不同）。 */
const describeAwayGap = (
  source: string | null, userName: string, anchorAt: number | null, showClock: boolean, tzId: string,
): string => {
  const isCall = source === 'call' || source === 'call-end-popup';
  if (!showClock || anchorAt == null) {
    if (source === 'date') return `线下分开后这段时间${userName}没有在线上给你发消息`;
    if (isCall) return `通话结束后这段时间${userName}没有在线上给你发消息`;
    return `这段时间${userName}没有再在线上给你发消息`;
  }
  const anchorClock = formatFireTimeShort(anchorAt, { tzId });
  if (source === 'date') return `你和${userName}上一次在线下互动是在 ${anchorClock}，分开后还没有在线上聊过`;
  if (isCall) return `你和${userName}上一次通话是在 ${anchorClock}，挂断后还没有在线上聊过`;
  return `${userName}最后一次在线上给你发消息是在 ${anchorClock}`;
};

const proactiveLine = (userName: string) =>
  `${userName}此刻并没有发来新消息，是你自己想起了${userName}，拿起手机主动找对方。`;

const moodLine = (userName: string, justMetOffline: boolean) => justMetOffline
  ? `你和${userName}刚刚在线下见过面，现在暂时分开了。请从这份见面后的心情出发：可以回味上下文里已有的见面细节、补一句当时没说出口的话、关心对方到家了没，或者刚分开就有点想念。不要表现得像很久没联系，也不要对刚才的见面毫不知情；如果具体细节已不在可见上下文里，不要编造，表达分别后的心情即可。`
  : `你自己的生活也在继续：可以分享随手拍的照片、刚看到的趣事、突然想到的冷知识，吐槽天气、食物或见闻，接上之前聊过的话，或者单纯想找${userName}聊两句。结合你的人设和当时的生活自然选，不用每一类都写。`;

/**
 * 云端离开后消息到点时的「本次任务」指令。云端到点只发一次，所以没有分次那几行；
 * 关了时间感知时不报钟、也不报隔了多久（与本地同一个开关）。
 */
export const buildAwayFireInstruction = (input: {
  userName: string;
  anchor: AwayAnchorInfo;
  /** 最后一次在场互动的时刻；没有任何记录时为 null。 */
  anchorAt: number | null;
  nowMs: number;
  showClock: boolean;
  tzId: string;
}): string => [
  `${describeAwayGap(input.anchor.source, input.userName, input.anchorAt, input.showClock, input.tzId)}。`,
  proactiveLine(input.userName),
  '这次一定要发出消息：结合你们最后聊到哪儿、你自己这会儿在做什么，像真人一样自然地发一到三句私聊。',
  moodLine(input.userName, isJustMetOffline(input.anchor, input.nowMs)),
  '不要像系统提醒，也不要提「多少分钟」这种计时。',
].join('\n');
