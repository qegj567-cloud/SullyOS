// 回归守卫：本地聊天的工具循环以前只拿最后一轮的正文当回复。Claude 常在调排程工具的
// 同一轮就把话写了，工具结果回来后下一轮只出一两个 token——用户收到的就是一次空回
// （2026-09-23 现场：排程成功之后那轮只出了 2 个 token）。排程连着被打回时模型又会换个
// 参数一轮轮接着排，转到上限还是空回。下面钉住「话要留下来」和「撞墙就收尾」两件事。
import { describe, it, expect } from 'vitest';

import {
  AMSG2_MAX_STALLED_ROUNDS,
  buildAmsg2WrapUpPrompt,
  createAmsg2StallTracker,
  extractToolRoundLeadIn,
  formatToolRoundHistoryContent,
  mergeToolRoundLeadIns,
  TOOL_ROUND_PLACEHOLDER,
} from './amsg2ToolLoop';

describe('工具轮里说过的话', () => {
  it('最后一轮空着 → 回复就是工具轮里写下的话', () => {
    expect(mergeToolRoundLeadIns(['好，那你先去吃饭～\n吃完跟我说'], '')).toBe('好，那你先去吃饭～\n吃完跟我说');
  });

  it('工具轮和最后一轮都写了（如先应一声再报失败） → 按顺序完整保留', () => {
    expect(mergeToolRoundLeadIns(['好的，我去整。'], '失败啦，回头再帮你定～')).toBe('好的，我去整。\n失败啦，回头再帮你定～');
    expect(mergeToolRoundLeadIns(['那你先去'], '回来找我')).toBe('那你先去\n回来找我');
  });

  it('最后一轮把前面的话又抄了一遍 → 不重复', () => {
    expect(mergeToolRoundLeadIns(['那你先去'], '那你先去\n回来找我')).toBe('那你先去\n回来找我');
    expect(mergeToolRoundLeadIns(['那你先去', '那你先去'], '')).toBe('那你先去');
  });

  it('内联 <think> 不同但角色对白相同 → 先剥思考再去重，不把同一句话发两遍', () => {
    expect(mergeToolRoundLeadIns(
      ['<think>先给他排个明早的提醒</think>\n好呀，早点休息，晚安～'],
      '<think>提醒已经排上了，收个尾</think>\n好呀，早点休息，晚安～',
    )).toBe('好呀，早点休息，晚安～');
    expect(mergeToolRoundLeadIns(
      ['<thinking>第一轮思考</thinking>好的，我去整。'],
      '<thinking>排程撞上限了</thinking>好的，我去整。\n哎呀名额满了，你明早自己定个闹钟哈。',
    )).toBe('好的，我去整。\n哎呀名额满了，你明早自己定个闹钟哈。');
  });

  it('只输出了内联 <think> 没说对白 → 当空正文处理，历史回塞落占位符', () => {
    expect(extractToolRoundLeadIn('<think>已经在上一轮说完了，直接结束</think>')).toBe('');
    expect(formatToolRoundHistoryContent('<think>先调工具</think>')).toBe(TOOL_ROUND_PLACEHOLDER);
    expect(formatToolRoundHistoryContent('<think>先调工具</think>\n好的，我去整。')).toBe('好的，我去整。');
    expect(mergeToolRoundLeadIns(
      ['<think>排个提醒</think>晚安呀～'],
      '<think>已经说完了不用再补</think>',
    )).toBe('晚安呀～');
  });

  it('相邻轮次首尾重叠抄写同一行 → 衔接处只留一份，但不误吞纯闭合结构行', () => {
    expect(mergeToolRoundLeadIns(
      ['好呀，那你先去忙～\n等你回来'],
      '等你回来\n记得喝水',
    )).toBe('好呀，那你先去忙～\n等你回来\n记得喝水');

    expect(mergeToolRoundLeadIns(
      ['[html]<div class="outer"><div class="inner">上半卡</div>'],
      '</div>[/html]',
    )).toBe('[html]<div class="outer"><div class="inner">上半卡</div>\n</div>[/html]');
  });

  it('短语气词或单标点气泡（「好」「？」「……」），后文句子出现同字也不被误删', () => {
    expect(mergeToolRoundLeadIns(['好'], '好啦，明早你自己定个闹钟哈')).toBe('好\n好啦，明早你自己定个闹钟哈');
    expect(mergeToolRoundLeadIns(['？'], '怎么突然让我半夜三点叫你？')).toBe('？\n怎么突然让我半夜三点叫你？');
    expect(mergeToolRoundLeadIns(['……'], '……名额已经满啦。')).toBe('……\n……名额已经满啦。');
  });

  it('历史里的占位被模型照抄进正文时不当回话', () => {
    expect(extractToolRoundLeadIn(TOOL_ROUND_PLACEHOLDER)).toBe('');
    expect(extractToolRoundLeadIn(null)).toBe('');
    expect(mergeToolRoundLeadIns([TOOL_ROUND_PLACEHOLDER], `${TOOL_ROUND_PLACEHOLDER}嗯`)).toBe('嗯');
  });

  it('强制收尾提示区分前序轮是否已写出对白：已写过时不命令从头重答', () => {
    const fresh = buildAmsg2WrapUpPrompt(false);
    expect(fresh).toContain('直接用角色语气回复用户刚才说的话');

    const continued = buildAmsg2WrapUpPrompt(true);
    expect(continued).toContain('不要把说过的内容重写一遍');
    expect(continued).toContain('直接留空结束即可');
    expect(continued).not.toContain('直接用角色语气回复用户刚才说的话');
  });
});

describe('排程连着撞墙就收尾', () => {
  const rejected = { tool: 'schedule_active_message', status: 'rejected' as const, reason: 'min_gap' };
  const done = { tool: 'schedule_active_message', status: 'done' as const };

  it(`连着 ${AMSG2_MAX_STALLED_ROUNDS} 轮都没办成 → 该收尾了`, () => {
    const tracker = createAmsg2StallTracker();
    expect(tracker.record([rejected])).toBe(false);
    expect(tracker.record([{ ...rejected, status: 'duplicate' as const }])).toBe(true);
  });

  it('中间办成过一件 → 重新数', () => {
    const tracker = createAmsg2StallTracker();
    tracker.record([rejected]);
    expect(tracker.record([rejected, done])).toBe(false);
    expect(tracker.record([rejected])).toBe(false);
  });

  it('这一轮没调主动消息工具（只调了别的） → 不算数', () => {
    const tracker = createAmsg2StallTracker();
    tracker.record([rejected]);
    expect(tracker.record([])).toBe(false);
    expect(tracker.stalledRounds).toBe(1);
  });
});
