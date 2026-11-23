// 聊天工具循环里「角色看得到什么排程」的接线守卫。
//
// 仓库的 vitest 是纯 Node 环境（没装 jsdom），useChatAI 是个绑死 React 的大 hook，
// 跑不起来测行为，所以沿用 activeMsgClient.wiring.test.ts 的做法做**源码级**断言。
// 它验证不了运行时时序，只防「接线被误删/改回去」这一种回归。
//
// 钉的是同一件事的两半：
//   1. 工具循环的第二轮起，请求体不能从「加排程块之前」的那份消息重新起步；
//   2. 排程块要每轮现算贴末尾，而不是把首轮那份旧快照一路带下去。
// 两半都塌的时候，角色刚排完任务、下一轮看到的清单却是空的，于是把同一条再排一遍
// ——现场表现就是一句「等会找我」排出 5 条一模一样的任务。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  fileURLToPath(new URL('../hooks/useChatAI.ts', import.meta.url)),
  'utf8',
);

describe('排程现状块每轮现算', () => {
  it('有一个统一的贴块入口，而不是散在各处手拼', () => {
    expect(src).toContain('const withAmsg2TaskContext =');
  });

  it('首轮请求也走这个入口（不再把块写死进 baseReqBody.messages）', () => {
    // 写死进 baseReqBody.messages 的话，工具循环里那份就永远是排程前的旧清单。
    expect(src).not.toMatch(/baseReqBody\.messages\s*=\s*\[\s*\n?\s*\.\.\.baseReqBody\.messages,\s*\n?\s*\{\s*role:\s*'system',\s*content:\s*taskContext\.text/);
    expect(src).toMatch(/messages:\s*withAmsg2TaskContext\(baseReqBody\.messages\)/);
  });

  it('工具循环的后续请求也现算一次（本轮刚排的任务立刻进清单）', () => {
    // 收尾路径还要往这份消息里追加「停止调用工具」，所以先落局部变量再放进 body；
    // 仍必须保证局部变量来自每轮现算，而不是复用首轮旧快照。
    // 第二个参数是「这一跳是不是最后一轮」（最后一轮不教正文语法），清单照样现算。
    expect(src).toMatch(/const followMessages = withAmsg2TaskContext\(loopMessages, forceWrapUp\)/);
    expect(src).toMatch(/messages:\s*followMessages/);
  });

  it('本轮新建的任务会被点名，传进渲染函数', () => {
    expect(src).toContain('amsg2CreatedThisTurn');
    expect(src).toMatch(/buildAmsg2TaskContextText\([\s\S]{0,200}amsg2CreatedThisTurn/);
  });
});

describe('工具循环的消息起点', () => {
  // 三个循环（麦当劳 / 瑞幸 / 通用）都可能执行主动消息 2.0 的排程工具——代码注释里
  // 明写了「排程工具与点单工具会在同一批 tool_calls 里出现」，所以三处得一致。
  it('三处 loopMessages 都从 baseReqBody.messages 起步', () => {
    const starts = src.match(/let loopMessages = \[\.\.\.[A-Za-z.]+\]/g) ?? [];
    expect(starts.length).toBe(3);
    for (const line of starts) {
      expect(line).toContain('baseReqBody.messages');
    }
  });

  it('MCP 正文兜底那条也一样', () => {
    expect(src).toMatch(/textLoopMessages = \[\.\.\.baseReqBody\.messages\]/);
  });

  it('工具轮回塞历史先剥内联思考、收尾提示区分前序是否已开口、额度说明用聊天语境、保留说话轮心象', () => {
    expect(src).toContain('formatToolRoundHistoryContent(data.choices[0].message.content)');
    expect(src).not.toContain("data.choices[0].message.content || '(调用工具中)'");
    // 收尾提示由 resolveToolLoopWrapUp 选，是否已开口经 hasLeadIn 传进去。
    expect(src).toContain('hasLeadIn: amsg2LeadIns.length > 0 || displayedMcpLeadIns.size > 0');
    // 空回补救把 MCP 已落库的开场白也算作「开过口」。
    expect(src).toContain('leadInCount: amsg2LeadIns.length + displayedMcpLeadIns.size');
    expect(src).toContain('effectivePostProcessData');
    expect(src).toContain('parseSARModuleReplyRounds');
    expect(src).toMatch(/buildLimitsBrief\(\{[\s\S]{0,360}context:\s*'chat'/);
  });
});
