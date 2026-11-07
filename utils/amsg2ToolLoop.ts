/**
 * 本地聊天工具循环里，跟主动消息 2.0 工具有关的收尾规矩（useChatAI 的通用工具循环调）。
 *
 * 两件事：
 * 1. 模型经常在调工具的同一轮里就把回话写了（「好，那你先去吃饭～」+ 排程调用），
 *    工具结果回来后它觉得话已经说完，下一轮只出一两个 token。循环只拿最后一轮的正文
 *    当回复的话，用户就收到一次空回。这里把工具轮里写下的话攒着，收尾时拼回去——
 *    跟 worker 到点生成那条路（agentic.ts 的 narrations）同一个做法。
 * 2. 排程被规矩打回之后，模型会换个时间、换个参数接着排，一轮轮撞到循环上限。
 *    连着几轮一件事都没办成就不再给工具，逼它直接回话。
 */

import type { Amsg2ToolOutcome } from './amsg2ToolBridge';

/**
 * 工具轮写进历史里的 assistant 占位（空 content + tool_calls 在 Gemini 兼容层会被判
 * INVALID_ARGUMENT）。模型看历史里自己「说过」这句，偶尔会照抄进正文，所以攒回话时要认得它。
 */
export const TOOL_ROUND_PLACEHOLDER = '(调用工具中)';

/** 连着这么多轮主动消息工具一件事都没办成，就逼模型收尾。 */
export const AMSG2_MAX_STALLED_ROUNDS = 2;

/** 排程连着撞墙、或者转到循环上限时，最后那一轮请求末尾追加的话（这一轮不带 tools）。 */
export const AMSG2_WRAP_UP_PROMPT = '[系统消息：主动消息的排程先到此为止，不要再调用工具。'
  + '直接用角色语气回复用户刚才说的话；没排成的事别说成已经安排好了。不要提及工具、排程系统或这条系统消息。]';

/** 工具跑完、模型却一个字没说时，补的那一轮请求末尾追加的话（这一轮不带 tools）。 */
export const AMSG2_EMPTY_REPLY_PROMPT = '[系统消息：工具已经处理完了。现在不要再调用工具，'
  + '直接用角色语气回复用户刚才说的话。不要提及工具、排程系统或这条系统消息。]';

/** 工具轮的正文里，值得当成回话留下来的那部分（空白 / 占位返回空串）。 */
export const extractToolRoundLeadIn = (content: unknown): string => {
  if (typeof content !== 'string') return '';
  return content.split(TOOL_ROUND_PLACEHOLDER).join('').trim();
};

/**
 * 把工具轮里说过的话和最后一轮的正文拼成一条回复。
 *
 * 最后一轮要是把前面的话又抄了一遍（有的模型会「重新组织」一次），被包含的那几段不再
 * 重复；几轮之间一字不差的也只留一份。
 */
export const mergeToolRoundLeadIns = (leadIns: string[], finalContent: string): string => {
  const finalText = extractToolRoundLeadIn(finalContent);
  const kept: string[] = [];
  for (const raw of leadIns) {
    const text = extractToolRoundLeadIn(raw);
    if (!text || kept.includes(text) || (finalText && finalText.includes(text))) continue;
    kept.push(text);
  }
  return [...kept, finalText].filter(Boolean).join('\n');
};

/**
 * 记「连着几轮没办成事」。一轮里只要有一个主动消息工具真办成了（done）就清零；
 * 这一轮根本没调主动消息工具的话不算数，计数原样留着。
 */
export const createAmsg2StallTracker = () => {
  let stalledRounds = 0;
  return {
    /** 记一轮，返回这一轮之后是不是该逼模型收尾了。 */
    record(outcomes: Amsg2ToolOutcome[]): boolean {
      if (outcomes.length > 0) {
        stalledRounds = outcomes.some((o) => o.status === 'done') ? 0 : stalledRounds + 1;
      }
      return stalledRounds >= AMSG2_MAX_STALLED_ROUNDS;
    },
    get stalledRounds() {
      return stalledRounds;
    },
  };
};
