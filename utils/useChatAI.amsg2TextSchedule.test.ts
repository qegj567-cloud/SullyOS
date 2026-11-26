// 本地生成路径上，主动消息 2.0 排程工具跟随「原生 tools」开关的回归守卫。
//
// 开关开着：schedule / cancel / renew 以原生工具声明，和改动前一模一样。
// 开关关着（用户判断过中转拒 tools）：和云端一样只教 schedule 的正文协议，
// 不教取消和改期；角色写在正文里的调用由前台代为执行，语法不显示给用户。
// 只开 2.0、没配 MCP 时中转拒 tools，也要能降级到正文协议，不能整轮报错。
//
// 纯函数部分直接测行为；hook 里的接线跑不起来（Node 环境、没装 jsdom），沿用
// amsgInstantChat.wiring.test.ts 的做法读源码钉接线。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  amsg2TaskContextForMode,
  buildDialogueRequestBase,
  buildFakedToolResultsMessage,
  withoutMcpCompatTeaching,
  buildRejectedToolsFallbackBody,
  maskAmsg2ScheduleSyntaxForPreview,
  resolveAmsg2ToolMode,
  resolveFinalScheduleText,
  resolveToolLoopWrapUp,
  shouldRescueEmptyToolLoop,
  stripAmsg2ScheduleSyntax,
  takeAmsg2TextScheduleCalls,
} from '../hooks/useChatAI';
import {
  AMSG_FIRE_CANCEL_TOOL,
  AMSG_FIRE_RENEW_TOOL,
  buildFireScheduleBlock,
  buildFireScheduleHowTo,
} from './amsgFireSchedule';
import { buildAmsg2Tools } from './amsg2ToolBridge';
import { resolveAmsgLimits } from './amsgLimits';
import { buildMcpRejectedToolsFallbackBody } from './mcpToolBridge';
import { buildToolLoopWrapUpPrompt, TOOL_LOOP_FINAL_ROUND_PROMPT } from './toolLoopFinalRound';
import { dialogueMaxTokens } from './characterApi';
import { isAnthropicEndpoint } from './llmEndpoint';
import { shouldSendThinkingParams } from './thinkingGate';
import { AMSG2_WRAP_UP_PROMPT } from './amsg2ToolLoop';

const TIME = { nowMs: Date.UTC(2026, 10, 23, 4, 0), tz: { tzId: 'Asia/Shanghai' } };
const CALL = 'schedule_active_message({"send_at":"2026-11-23T20:00:00","prompt_hint":"问问考试"})';

const src = readFileSync(fileURLToPath(new URL('../hooks/useChatAI.ts', import.meta.url)), 'utf8');

describe('排程工具的形态跟着「原生 tools」开关走', () => {
  it('2.0 没开 → off；开着且开关开 → native；开着但开关关 → text', () => {
    expect(resolveAmsg2ToolMode(false, true)).toBe('off');
    expect(resolveAmsg2ToolMode(false, false)).toBe('off');
    expect(resolveAmsg2ToolMode(true, true)).toBe('native');
    expect(resolveAmsg2ToolMode(true, false)).toBe('text');
  });

  it('正文协议说明就是云端 buildFireScheduleBlock(\'text\') 里那一句，且不教取消和改期', () => {
    const howTo = buildFireScheduleHowTo('text', TIME);
    const cloudText = buildFireScheduleBlock('text', { ...TIME, context: 'chat' });
    const cloudNative = buildFireScheduleBlock('native', { ...TIME, context: 'chat' });
    expect(cloudText.split('\n')).toContain(howTo);
    expect(cloudNative).not.toContain(howTo);
    expect(howTo).toContain('schedule_active_message({"send_at":');
    expect(howTo).not.toContain(AMSG_FIRE_CANCEL_TOOL);
    expect(howTo).not.toContain(AMSG_FIRE_RENEW_TOOL);
  });

  it('排程现状块：原生模式原样不动，正文模式在块尾补上语法说明', () => {
    const base = '【你的主动消息排程·仅你可见】\n简介';
    expect(amsg2TaskContextForMode(base, 'native', TIME)).toBe(base);
    expect(amsg2TaskContextForMode(base, 'off', TIME)).toBe(base);
    expect(amsg2TaskContextForMode(base, 'text', TIME)).toBe(`${base}\n${buildFireScheduleHowTo('text', TIME)}`);
  });

  it('最后一轮不教语法：正文模式也原样返回排程现状块', () => {
    const base = '【你的主动消息排程·仅你可见】\n简介';
    expect(amsg2TaskContextForMode(base, 'text', TIME, true)).toBe(base);
    expect(amsg2TaskContextForMode(base, 'text', TIME, false)).toBe(`${base}\n${buildFireScheduleHowTo('text', TIME)}`);
  });
});

describe('正文里的排程调用', () => {
  it('抠出调用参数，剩下的是可以给用户看的话', () => {
    const { calls, rest } = takeAmsg2TextScheduleCalls(`好呀，晚上我来问你\n${CALL}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ send_at: '2026-11-23T20:00:00', prompt_hint: '问问考试' });
    expect(rest).toBe('好呀，晚上我来问你');
  });

  it('没有调用时原样返回（一个字符都不动）', () => {
    const text = '  就是普通的一句话  \n';
    expect(takeAmsg2TextScheduleCalls(text)).toEqual({ calls: [], rest: text });
    expect(stripAmsg2ScheduleSyntax(text)).toBe(text);
  });

  it('最终正文剥掉排程语法', () => {
    expect(stripAmsg2ScheduleSyntax(`晚安\n${CALL}`)).toBe('晚安');
    expect(stripAmsg2ScheduleSyntax(CALL)).toBe('');
  });

  it('流式预览：完整调用剥掉，没写完的调用和刚冒头的工具名也不闪出来', () => {
    expect(maskAmsg2ScheduleSyntaxForPreview(`晚安\n${CALL}`)).toBe('晚安');
    expect(maskAmsg2ScheduleSyntaxForPreview('晚安\nschedule_active_message({"send_at":"2026-11')).toBe('晚安\n');
    expect(maskAmsg2ScheduleSyntaxForPreview('晚安\nschedule_ac')).toBe('晚安\n');
    expect(maskAmsg2ScheduleSyntaxForPreview('晚安呀')).toBe('晚安呀');
  });
});

describe('最终正文里剩下的工具调用', () => {
  const mcpResolve = new Map([['ask_question', {
    server: { id: 's1', name: 'wiki', url: 'https://wiki.example.com/mcp', tools: [] },
    toolName: 'ask_question',
    tool: { name: 'ask_question', description: '问知识库', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  }]]) as any;

  it('正文模式：最后一轮写出的排程与 MCP 调用都不执行，从显示文本里剥掉并报数', () => {
    expect(resolveFinalScheduleText(`晚安\n${CALL}`, 'text', null))
      .toEqual({ content: '晚安', unexecuted: 1, unexecutedMcp: 0 });
    expect(resolveFinalScheduleText(`晚安\nask_question({"q":"明天天气"})`, 'text', mcpResolve))
      .toEqual({ content: '晚安', unexecuted: 0, unexecutedMcp: 1 });
    expect(resolveFinalScheduleText('晚安', 'text', mcpResolve))
      .toEqual({ content: '晚安', unexecuted: 0, unexecutedMcp: 0 });
  });

  it('原生 / 未开 2.0：排程语法没教过也剥掉、报数，不执行（与云端同一口径，回归守卫）', () => {
    expect(resolveFinalScheduleText(`晚安\n${CALL}`, 'native', mcpResolve))
      .toEqual({ content: '晚安', unexecuted: 1, unexecutedMcp: 0 });
    expect(resolveFinalScheduleText(`晚安\n${CALL}`, 'off', null))
      .toEqual({ content: '晚安', unexecuted: 1, unexecutedMcp: 0 });
    // 行内代码里的是在讲语法，照原文保留。
    expect(resolveFinalScheduleText(`写法是 \`${CALL}\``, 'off', null))
      .toEqual({ content: `写法是 \`${CALL}\``, unexecuted: 0, unexecutedMcp: 0 });
  });
});

describe('原生 / 未开 2.0 时最后一轮写出的 MCP 正文调用', () => {
  const mcpResolve = new Map([['ask_question', {
    server: { id: 's1', name: 'wiki', url: 'https://wiki.example.com/mcp', tools: [] },
    toolName: 'ask_question',
    tool: { name: 'ask_question', description: '问知识库', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  }]]) as any;
  const text = '晚安\nask_question({"q":"明天天气"})';

  it('工具阶段收过尾：不执行，从显示文本剥掉并报数', () => {
    expect(resolveFinalScheduleText(text, 'native', mcpResolve, true)).toEqual({ content: '晚安', unexecuted: 0, unexecutedMcp: 1 });
    expect(resolveFinalScheduleText(text, 'off', mcpResolve, true)).toEqual({ content: '晚安', unexecuted: 0, unexecutedMcp: 1 });
  });

  it('没收过尾：不看也不动（MCP 正文兜底照常处理）', () => {
    expect(resolveFinalScheduleText(text, 'native', mcpResolve, false)).toEqual({ content: text, unexecuted: 0, unexecutedMcp: 0 });
  });

  it('3.6b 在原生循环收尾之后不再跑，它自己收尾也算收尾；收尾判定传给最终正文', () => {
    expect(src).toContain("if (mcpToolResolve && amsg2ToolMode !== 'text' && !toolPhaseClosed) {");
    expect(src).toContain('resolveFinalScheduleText(finalRoundContentRaw, amsg2ToolMode, mcpToolResolve, toolPhaseClosed)');
    const mcpTextLoop = src.slice(src.indexOf('// 3.6b MCP 掉格式容错'), src.indexOf('// 3.6c'));
    expect(mcpTextLoop.match(/toolPhaseClosed = true;/g) ?? []).toHaveLength(2);
  });
});

describe('工具循环的收尾规则', () => {
  it('收尾提示住在零依赖叶子模块里（worker 引同一个常量）', () => {
    const leaf = readFileSync(fileURLToPath(new URL('./toolLoopFinalRound.ts', import.meta.url)), 'utf8');
    expect(leaf).not.toMatch(/^\s*import\s/m);
    expect(TOOL_LOOP_FINAL_ROUND_PROMPT).toContain('不能再调用任何工具');
    // 不逼模型「直接给最终回复」：那样它会把说过的话再说一遍。说完了可以什么都不补。
    expect(TOOL_LOOP_FINAL_ROUND_PROMPT).not.toContain('最终回复');
    expect(TOOL_LOOP_FINAL_ROUND_PROMPT).toContain('留空');
  });

  it('最后一轮什么都没补、前面几轮有正文：不补救，前面那些就是输出', () => {
    expect(shouldRescueEmptyToolLoop({ toolRounds: 3, leadInCount: 1, finalContent: '' })).toBe(false);
    expect(shouldRescueEmptyToolLoop({ toolRounds: 3, leadInCount: 0, finalContent: '好，我记下了' })).toBe(false);
  });

  it('整个循环一句正文都没有：走空回补救（收尾过也一样）', () => {
    expect(shouldRescueEmptyToolLoop({ toolRounds: 2, leadInCount: 0, finalContent: '  ' })).toBe(true);
    expect(shouldRescueEmptyToolLoop({ toolRounds: 2, leadInCount: 0, finalContent: '(调用工具中)' })).toBe(true);
    // 没跑过工具、或最后还挂着 tool_calls（循环在别处接着处理）时不归它管。
    expect(shouldRescueEmptyToolLoop({ toolRounds: 0, leadInCount: 0, finalContent: '' })).toBe(false);
    expect(shouldRescueEmptyToolLoop({ toolRounds: 2, leadInCount: 0, finalContent: '', finalHasToolCalls: true })).toBe(false);
  });

  it('进入最后一轮：收尾、用统一的收尾提示（排程独占时也一样）', () => {
    for (const scheduleOnly of [true, false]) {
      expect(resolveToolLoopWrapUp({ round: 5, maxLoops: 6, hasLeadIn: false, scheduleOnly }))
        .toEqual({ kind: 'hard-limit', prompt: TOOL_LOOP_FINAL_ROUND_PROMPT });
    }
  });

  it('非最后一轮、没卡住：不收尾，请求照旧', () => {
    expect(resolveToolLoopWrapUp({ round: 0, maxLoops: 6, hasLeadIn: false }))
      .toEqual({ kind: 'none', prompt: null });
    expect(resolveToolLoopWrapUp({ round: 4, maxLoops: 6, hasLeadIn: true, scheduleOnly: true }))
      .toEqual({ kind: 'none', prompt: null });
  });

  it('卡住收尾保留各自的提示：同参重复 > MCP 没新结果 > 排程连着撞墙', () => {
    expect(resolveToolLoopWrapUp({ round: 0, maxLoops: 6, hasLeadIn: false, mcpRepeated: true, mcpStalled: true }).kind).toBe('mcp-repeated');
    expect(resolveToolLoopWrapUp({ round: 0, maxLoops: 6, hasLeadIn: false, mcpStalled: true, amsg2Stalled: true }).kind).toBe('stalled');
    expect(resolveToolLoopWrapUp({ round: 0, maxLoops: 6, hasLeadIn: false, amsg2Stalled: true, scheduleOnly: true }))
      .toEqual({ kind: 'amsg2-stalled', prompt: AMSG2_WRAP_UP_PROMPT });
    // 混着别的工具时排程撞墙，用统一收尾提示（原来这里用的就是「已到安全上限」那句）。
    expect(resolveToolLoopWrapUp({ round: 0, maxLoops: 6, hasLeadIn: false, amsg2Stalled: true, scheduleOnly: false }))
      .toEqual({ kind: 'amsg2-stalled', prompt: TOOL_LOOP_FINAL_ROUND_PROMPT });
  });
});

describe('中转拒 tools 时的降级请求体', () => {
  const amsg2Tools = buildAmsg2Tools(resolveAmsgLimits(undefined), TIME);
  const mcpTool = {
    type: 'function',
    function: { name: 'ask_question', description: '问知识库', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  };
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tool_choice: 'auto' };

  it('只有 MCP 工具时与原来的 MCP 兼容请求体完全一致', () => {
    const withMcp = { ...body, tools: [mcpTool] };
    expect(buildRejectedToolsFallbackBody(withMcp)).toEqual(buildMcpRejectedToolsFallbackBody(withMcp));
  });

  it('只有排程工具时：去掉 tools，不再追加 MCP 兼容说明', () => {
    const out = buildRejectedToolsFallbackBody({ ...body, tools: amsg2Tools });
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(out.messages).toEqual(body.messages);
  });

  it('MCP 与排程同在：兼容说明只列 MCP 工具，排程三件套不混进去', () => {
    const out = buildRejectedToolsFallbackBody({ ...body, tools: [mcpTool, ...amsg2Tools] });
    expect(out.tools).toBeUndefined();
    const compat = out.messages.at(-1).content as string;
    expect(compat).toContain('ask_question');
    for (const t of amsg2Tools) expect(compat).not.toContain(t.function.name);
  });
});

describe('useChatAI 的接线', () => {
  it('原生模式的路径不变：排程工具仍整套声明，thinking 门看的是本轮带没带原生工具', () => {
    expect(src).toContain("if (amsg2ToolMode === 'native') {");
    expect(src).toMatch(/amsg2ToolsInjected:\s*amsg2ToolMode === 'native'/);
    expect(src).toMatch(/\.\.\.buildAmsg2Tools\(resolveAmsgLimits\(char\.activeMsg2Config\), \{/);
  });

  it('开关读的是同一个「原生 tools」设置', () => {
    expect(src).toMatch(/resolveAmsg2ToolMode\(amsg2ScheduleEnabled, getMcpUseNativeTools\(\)\)/);
  });

  it('正文模式有排程的检测-执行-回喂循环，执行走原生那条同一个执行器与卡住计数', () => {
    expect(src).toContain("if (amsg2ToolMode === 'text') {");
    expect(src).toContain('takeAmsg2TextScheduleCalls(');
    expect(src).toContain('executeAmsg2Call(AMSG_FIRE_SCHEDULE_TOOL,');
    expect(src).toMatch(/const scheduleTextStall = createAmsg2StallTracker\(\)/);
    expect(src).toMatch(/scheduleTextStall\.record\(/);
  });

  it('流式预览任何模式都扣住排程语法；工具轮开场白里的调用剥掉', () => {
    expect(src).toMatch(/computeStreamPreviewBubbles\(maskAmsg2ScheduleSyntaxForPreview\(fullText\)\)/);
    expect(src).toMatch(/amsg2LeadIns\.map\(stripAmsg2ScheduleSyntax\)/);
    expect(src).not.toMatch(/if \(amsg2ToolMode === 'text'\) \{\s*const cleanedLeadIns/);
  });

  it('点单类原生工具轮里写的排程也代为执行（三个原生循环都接上）', () => {
    const hits = src.match(/await runScheduleTextInToolRound\(data\.choices\?\.\[0\]\?\.message\?\.content, loopMessages, it\)/g) ?? [];
    expect(hits).toHaveLength(3);
  });

  it('正文模式由一个循环同时认 MCP 与排程的正文调用（续写里冒出的 MCP 调用也执行）', () => {
    const section = src.slice(src.indexOf('// 3.6c'), src.indexOf('// DEBUG: Log full API response'));
    expect(section).toContain('extractTextFakedMcpCalls(');
    expect(section).toContain('executeFakedMcpCall(');
    expect(section).toContain('takeAmsg2TextScheduleCalls(');
    // 原来那个 MCP 正文兜底只在非正文模式下跑，原生 / 未开 2.0 时行为不变。
    expect(src).toContain("if (mcpToolResolve && amsg2ToolMode !== 'text' && !toolPhaseClosed) {");
  });

  it('最后一轮写出的调用剥掉、留 trace', () => {
    expect(src).toContain('resolveFinalScheduleText(finalRoundContentRaw, amsg2ToolMode, mcpToolResolve, toolPhaseClosed)');
    expect(src).toContain("event: 'amsg2-text-schedule-unexecuted'");
  });

  it('最后一轮的请求不带工具、不教语法：原生循环与正文循环都走同一个收尾判定', () => {
    expect(src.match(/resolveToolLoopWrapUp\(\{/g) ?? []).toHaveLength(2);
    // 原生循环：收尾那一跳删掉 tools，排程现状块按最后一轮渲染（正文模式下不带语法）。
    expect(src).toContain('const followMessages = withAmsg2TaskContext(loopMessages, forceWrapUp)');
    // 正文循环：收尾那一跳同样按最后一轮渲染。
    expect(src).toContain("withAmsg2TaskContext(textLoopHistory, textWrapUp.kind !== 'none')");
    // 原生循环收尾过，正文循环不再接着执行。
    expect(src).toMatch(/!toolPhaseClosed && it < maxTextLoops/);
    // 「已到安全上限」那几句已经合并进统一常量。
    expect(src).not.toContain('已到这次回复的安全上限');
    // 两个循环的空回补救都走同一个判定，不再因为收尾过就跳过。
    // 原生循环、正文循环、点单小程序续写三处。
    expect(src.match(/shouldRescueEmptyToolLoop\(\{/g) ?? []).toHaveLength(3);
    expect(src).not.toMatch(/wrapUpKind === 'none'\s*\n\s*&& amsg2LeadIns\.length === 0/);
  });

  it('只开 2.0 没配 MCP 时，中转拒 tools 也走降级并切到正文协议', () => {
    expect(src).toMatch(/payload\.flags\.mcpChatActive \|\| amsg2ToolMode === 'native'/);
    expect(src).toContain('buildRejectedToolsFallbackBody(');
    expect(src).toMatch(/if \(amsg2ToolMode === 'native'\) amsg2ToolMode = 'text';/);
  });
});

describe('对话请求的模型参数（改用 resolveDialogueLlmParams 后逐字不变）', () => {
  // 改动前 useChatAI 里那段原样抄下来，当作对照。
  const legacy = (o: any) => {
    const userTemp = o.api.temperature ?? o.fallbackTemperature ?? 0.85;
    const body: any = {
      model: o.api.model, messages: o.messages, temperature: userTemp,
      max_tokens: dialogueMaxTokens(o.api), stream: o.stream,
    };
    if (body.max_tokens > 1024 && shouldSendThinkingParams({
      thinkingActive: o.thinkingActive, legacyToolModeActive: o.legacyToolModeActive,
      amsg2ToolsInjected: o.amsg2ToolsInjected, model: body.model || '',
    })) {
      const m: string = body.model || '';
      if (!isAnthropicEndpoint(o.api.baseUrl) && /^claude-/i.test(m) && !/-thinking$/i.test(m)) body.model = `${m}-thinking`;
      const budget = Math.min(4000, body.max_tokens - 1);
      body.thinking = { type: 'enabled', budget_tokens: budget };
      body.reasoning_effort = 'medium';
      body.extra_body = { ...(body.extra_body || {}), thinking: { type: 'enabled', budget_tokens: budget } };
      delete body.temperature;
      delete body.top_p;
    }
    return body;
  };

  it('各种组合下请求体 JSON 与改动前一字不差', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    let cases = 0;
    for (const baseUrl of ['https://api.anthropic.com/v1', 'https://proxy.example.com/v1'])
      for (const model of ['claude-sonnet-4', 'claude-x-thinking', 'gpt-4o', 'gemini-2.5-pro', undefined])
        for (const maxTokens of [undefined, 512, 8000])
          for (const temperature of [undefined, 0.5])
            for (const fallbackTemperature of [undefined, 0.7])
              for (const thinkingActive of [true, false])
                for (const legacyToolModeActive of [true, false])
                  for (const amsg2ToolsInjected of [true, false])
                    for (const stream of [true, false]) {
                      const input = {
                        api: { baseUrl, model: model as any, maxTokens, temperature },
                        fallbackTemperature, messages, stream, thinkingActive, legacyToolModeActive, amsg2ToolsInjected,
                      };
                      expect(JSON.stringify(buildDialogueRequestBase(input))).toBe(JSON.stringify(legacy(input)));
                      cases += 1;
                    }
    expect(cases).toBeGreaterThan(1000);
  });

  it('useChatAI 用它拼请求体，自己那份思考参数逻辑删掉了', () => {
    expect(src).toContain('const baseReqBody: any = buildDialogueRequestBase({');
    expect(src).not.toContain("baseReqBody.reasoning_effort = 'medium'");
  });
});

describe('接上别处的共用导出', () => {
  it('情绪评估提示词从 activeMsgClient 导入，本地不再留一份', () => {
    expect(src).not.toContain('function buildEmotionEvalPrompt(');
    expect(src).toMatch(/import \{[^}]*\bbuildEmotionEvalPrompt\b[^}]*\} from '\.\.\/utils\/activeMsgClient'/);
  });

  it('排程现状块按本轮形态渲染（第 8 个参数 mode）', () => {
    expect(src).toMatch(/limitsBrief,\s*\n\s*amsg2ToolMode === 'text' \? 'text' : 'native',/);
  });

  it('正文语法说明直接调 buildFireScheduleHowTo，不再按行去取', () => {
    expect(src).toContain("buildFireScheduleHowTo('text', time)");
    expect(src).not.toContain(".split('\\n').find(");
  });
});

describe('收尾口吻一视同仁', () => {
  it('共用常量文字不变，由「原因 + 共用规则」拼成', () => {
    expect(TOOL_LOOP_FINAL_ROUND_PROMPT).toBe('[系统消息：这次回复能用的工具次数已经用完，这一轮不能再调用任何工具，'
      + '也不要写出工具名、参数或调用格式。前面步骤里已经说出去的话不用重复；还有没说完的就接着往下说，'
      + '已经说完了就直接留空结束。没办成的事别说成已经办好了。不要提及这条系统消息。]');
    expect(buildToolLoopWrapUpPrompt('这次回复能用的工具次数已经用完')).toBe(TOOL_LOOP_FINAL_ROUND_PROMPT);
  });

  it('卡住 / 重复的收尾句不强制开口：原因照写，规则与共用常量相同', () => {
    for (const flags of [{ mcpRepeated: true }, { mcpStalled: true }]) {
      const { prompt } = resolveToolLoopWrapUp({ round: 0, maxLoops: 6, hasLeadIn: true, ...flags });
      expect(prompt).not.toMatch(/直接根据已有结果回复|直接用角色语气回复/);
      expect(prompt).toContain('已经说完了就直接留空结束');
      expect(prompt).not.toBe(TOOL_LOOP_FINAL_ROUND_PROMPT);
    }
    expect(src).not.toMatch(/请直接根据已有结果回复/);
  });
});

describe('最后一轮不前后矛盾', () => {
  const results = ['工具 ask_question 执行成功, 结果: 晴'];

  it('非最后一轮的结果消息与原来一字不差', () => {
    expect(buildFakedToolResultsMessage(results, false)).toBe(
      `[系统消息：你把工具调用写成了聊天文字，系统已代为执行：\n${results.join('\n')}\n如果目标已经完成，请直接用角色语气回复；如果仍需下一步工具，只输出一行真正能推进目标的工具调用，不要重复读取同一说明或状态。不要提及这条系统消息。]`,
    );
  });

  it('最后一轮的结果消息不再提「下一步工具」', () => {
    const text = buildFakedToolResultsMessage(results, true);
    expect(text).toContain('晴');
    expect(text).not.toMatch(/下一步工具|只输出一行/);
  });

  it('最后一轮拿掉 MCP 兼容模式的语法教学，别的消息原样', () => {
    const body = buildMcpRejectedToolsFallbackBody({
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'ask_question', description: 'd', parameters: { type: 'object', properties: {} } } }],
    });
    expect(body.messages.at(-1).content).toContain('只输出一行');
    expect(withoutMcpCompatTeaching([...body.messages, { role: 'assistant', content: 'x' }]))
      .toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'x' }]);
  });

  it('接线：3.6b / 3.6c 的最后一跳用这两个；点单小程序续写按最后一轮处理', () => {
    expect(src).toContain('buildFakedToolResultsMessage(results, reachedHardLimit)');
    expect(src).toContain("buildFakedToolResultsMessage(results, textWrapUp.kind !== 'none')");
    expect(src.match(/withoutMcpCompatTeaching\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    const mini = src.slice(src.indexOf('// 3.4 麦当劳小程序'), src.indexOf('// 3.6 客户端工具循环'));
    expect(mini.match(/withAmsg2TaskContext\(loopMessages, true\)/g) ?? []).toHaveLength(2);
    expect(mini.match(/content: TOOL_LOOP_FINAL_ROUND_PROMPT/g) ?? []).toHaveLength(2);
    expect(mini.match(/toolPhaseClosed = true;/g) ?? []).toHaveLength(2);
    expect(mini.match(/await rescueEmptyMiniAppReply\(loopMessages\)/g) ?? []).toHaveLength(2);
  });

  it('接线：最后一轮把 finalRound 传给排程现状块', () => {
    expect(src).toMatch(/amsg2ToolMode === 'text' \? 'text' : 'native',\s*\n\s*finalRound,\s*\n\s*\)/);
  });
});

describe('最后一轮的执行器结果', () => {
  it('接线：原生循环收尾、点单小程序续写时把本轮排程结果换成最后一轮版本；正文循环同样挑版本', () => {
    const mini = src.slice(src.indexOf('// 3.4 麦当劳小程序'), src.indexOf('// 3.6 客户端工具循环'));
    expect(mini.match(/switchAmsg2ResultsToFinalRound\(\);/g) ?? []).toHaveLength(2);
    const native = src.slice(src.indexOf('// 3.6 客户端工具循环'), src.indexOf('// 3.6b MCP 掉格式容错'));
    expect(native).toContain('if (forceWrapUp) switchAmsg2ResultsToFinalRound();');
    expect(native).toContain('amsg2RoundResults.length = 0;');
    expect(src).toContain('isFinalHop ? scheduled.finalResults : scheduled.results');
  });
});
