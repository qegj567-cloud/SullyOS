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
import { splitInlineThinking } from './assistantThinking';

/**
 * 工具轮写进历史里的 assistant 占位（空 content + tool_calls 在 Gemini 兼容层会被判
 * INVALID_ARGUMENT）。模型看历史里自己「说过」这句，偶尔会照抄进正文，所以攒回话时要认得它。
 */
export const TOOL_ROUND_PLACEHOLDER = '(调用工具中)';

/** 连着这么多轮主动消息工具一件事都没办成，就逼模型收尾。 */
export const AMSG2_MAX_STALLED_ROUNDS = 2;

/** 排程连着撞墙、或者转到循环上限，且前面工具轮还没写过对白时，末尾追加的收尾提示（不带 tools）。 */
export const AMSG2_WRAP_UP_PROMPT = '[系统消息：主动消息的排程先到此为止，不要再调用工具。'
  + '直接用角色语气回复用户刚才说的话；没排成的事别说成已经安排好了。不要提及工具、排程系统或这条系统消息。]';

/** 前面工具轮已经写过对白时的强制收尾提示：保留已有内容，只允许补完后半句或自然改口，避免整段重写。 */
export const AMSG2_WRAP_UP_CONTINUE_PROMPT = '[系统消息：主动消息的排程先到此为止，不要再调用工具。'
  + '你在前面步骤里写下的话已经保留，不要把说过的内容重写一遍——如果还有没说完的后半句，'
  + '或者需要把没排成的事自然改口圆回来，只接着往下补完；如果前面的话已经完整且没有把没排成的事说死，'
  + '直接留空结束即可。不要提及工具、排程系统或这条系统消息。]';

export const buildAmsg2WrapUpPrompt = (hasLeadIn: boolean): string =>
  hasLeadIn ? AMSG2_WRAP_UP_CONTINUE_PROMPT : AMSG2_WRAP_UP_PROMPT;

/** 工具跑完、模型却一个字没说时，补的那一轮请求末尾追加的话（这一轮不带 tools）。 */
export const AMSG2_EMPTY_REPLY_PROMPT = '[系统消息：工具已经处理完了。现在不要再调用工具，'
  + '直接用角色语气回复用户刚才说的话。不要提及工具、排程系统或这条系统消息。]';

/**
 * 工具轮的正文里，值得当成回话留下来的那部分（内联思考块、空白与占位符均不计入正文）。
 *
 * 部分渠道把 `<think>...</think>` 直接拼在 `message.content` 里；在攒回话和合并去重前先剥离，
 * 才能识别「只输出了思考但未开口」与「两轮思考不同但对白相同」的情形。
 */
export const extractToolRoundLeadIn = (content: unknown): string => {
  if (typeof content !== 'string') return '';
  const withoutThinking = splitInlineThinking(content).content;
  return withoutThinking.split(TOOL_ROUND_PLACEHOLDER).join('').trim();
};

/**
 * 工具轮回塞进对话历史的 `assistant.content`：剥除内联思考块，无角色对白时落占位符，
 * 既满足兼容层非空约束，也避免大段内联思考回流到下一轮上下文。
 */
export const formatToolRoundHistoryContent = (content: unknown): string =>
  extractToolRoundLeadIn(content) || TOOL_ROUND_PLACEHOLDER;

/** 纯结构闭合标签或围栏行，不单独作为台词首尾重叠行吞掉，避免破坏嵌套 HTML 卡片或代码块闭合。 */
const isStructuralTagOnlyLine = (line: string): boolean =>
  /^(?:<\/?[a-zA-Z][^>]*>|\[\/?html\]|```.*)$/i.test(line.trim());

/** 去掉空白与常见标点后的有效字符长度，用于区分短语气词（「好」「嗯」「？」）与完整短句。 */
const meaningfulCharCount = (text: string): number =>
  Array.from(text.replace(/[\s\p{P}\p{S}]/gu, '')).length;

/**
 * 判断前序片段 `earlier` 是否已被后续片段 `later` 完整重抄：
 * - 多行或常规行：`earlier` 的非空行序列作为连续整行子序列出现在 `later` 中；
 * - 单行长句（有效字数 >= 6）：`later` 中某一行完整包含该句（覆盖「把上一轮那句并进更长一句」的情形），
 *   同时避免「好」「？」「……」等短气泡因后文句子里带同字而被误删。
 */
export const isSegmentRepeatedInLater = (earlier: string, later: string): boolean => {
  const subLines = earlier.split('\n').map((l) => l.trim()).filter(Boolean);
  const laterLines = later.split('\n').map((l) => l.trim()).filter(Boolean);
  if (subLines.length === 0 || laterLines.length === 0) return false;
  if (subLines.length <= laterLines.length) {
    for (let start = 0; start <= laterLines.length - subLines.length; start++) {
      let allMatch = true;
      for (let j = 0; j < subLines.length; j++) {
        if (laterLines[start + j] !== subLines[j]) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) return true;
    }
  }
  if (subLines.length === 1 && meaningfulCharCount(subLines[0]) >= 6) {
    return laterLines.some((line) => line.includes(subLines[0]));
  }
  return false;
};

/** 合并相邻两段在首尾逐行重叠的对白（如上一段末尾「晚安」与下一段开头「晚安」）。 */
const appendWithoutBoundaryOverlap = (accLines: string[], nextText: string): void => {
  const nextLines = nextText.split('\n');
  if (accLines.length === 0) {
    accLines.push(...nextLines);
    return;
  }
  const maxOverlap = Math.min(accLines.length, nextLines.length);
  let overlap = 0;
  for (let len = maxOverlap; len >= 1; len--) {
    if (len === 1 && isStructuralTagOnlyLine(nextLines[0])) continue;
    let matched = true;
    for (let i = 0; i < len; i++) {
      if (accLines[accLines.length - len + i].trim() !== nextLines[i].trim()) {
        matched = false;
        break;
      }
    }
    if (matched && nextLines.slice(0, len).some((line) => line.trim().length > 0)) {
      overlap = len;
      break;
    }
  }
  accLines.push(...nextLines.slice(overlap));
};

/**
 * 把工具轮里说过的话和最后一轮的正文拼成一条回复。
 *
 * 后面的轮次若已经按整行（或完整长句）重抄了前面某轮的对白，被包含的那一段不再重复保留；
 * 相邻轮次在衔接处重复抄写的尾行/首行也在拼接时去重。
 */
export const mergeToolRoundLeadIns = (leadIns: string[], finalContent: string): string => {
  const segments = [...leadIns, finalContent]
    .map(extractToolRoundLeadIn)
    .filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const text = segments[i];
    if (kept.includes(text)) continue;
    if (segments.slice(i + 1).some((later) => isSegmentRepeatedInLater(text, later))) continue;
    kept.push(text);
  }
  const mergedLines: string[] = [];
  for (const segment of kept) {
    appendWithoutBoundaryOverlap(mergedLines, segment);
  }
  return mergedLines.join('\n');
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
