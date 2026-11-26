import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message } from '../../types';
import { injectMemoryPalace } from './pipeline';
import {
    analyzeLocalContext,
    evaluateLocalRecallGate,
    normalizeRecallPlan,
    renderLocalContextGuidance,
    runLightRecallRouter,
} from './recallRouter';

let nextId = 1;
const message = (role: Message['role'], content: string): Message => ({
    id: nextId++,
    charId: 'char-router',
    role,
    type: 'text',
    content,
    timestamp: nextId,
});

describe('Local Context Analyzer', () => {
    beforeEach(() => {
        nextId = 1;
        localStorage.clear();
    });

    const ambiguousContinuations = [
        '我过了',
        '我过啦',
        '我过咯',
        '过了！！',
        '居然过了',
        '草真过了',
        '成啦',
        '搞定',
        '搞定噜',
        '她又来了',
        '她又来啦',
        '又来了属于是',
        '还是那个好',
        '果然没成',
        '搞定了！！',
        '怎么又这样',
        '之前那个呢',
    ];

    it.each(ambiguousContinuations)('routes ambiguous continuation: %s', (content) => {
        const gate = evaluateLocalRecallGate([message('user', content)]);

        expect(gate.analyzable).toBe(true);
        expect(gate.shouldRoute).toBe(true);
        expect(gate.features.missingExplicitArguments).toBe(true);
        expect(gate.features.recentContextSufficient).toBe(false);
    });

    it('routes from combined structure even when the strict result regex misses', () => {
        const gate = evaluateLocalRecallGate([message('user', '我过啦')]);

        expect(gate.features.hasResultPredicate).toBe(false);
        expect(gate.gateContributions.shortness).toBeGreaterThan(0.8);
        expect(gate.gateContributions.missingArguments).toBe(1);
        expect(gate.gateContributions.querySelfSufficiency).toBeLessThan(0.3);
        expect(gate.score).toBeGreaterThanOrEqual(0.62);
        expect(gate.shouldRoute).toBe(true);
    });

    it('routes the real consecutive user burst: 嗯哼 / 我过啦', () => {
        const gate = evaluateLocalRecallGate([
            message('user', '嗯哼'),
            message('user', '我过啦'),
        ]);

        expect(gate.features.hasResultPredicate).toBe(false);
        expect(gate.score).toBeGreaterThanOrEqual(0.62);
        expect(gate.shouldRoute).toBe(true);
    });

    it.each(['好', '嗯哼', '哈哈哈', '谢谢', '晚安'])(
        'does not route a bare short social utterance: %s',
        (content) => {
            const gate = evaluateLocalRecallGate([message('user', content)]);
            expect(gate.shouldRoute).toBe(false);
        },
    );

    it.each([
        '她今天把那个文件给我了',
        '我把那个文件发给客户了',
        '我通过了雾港观测员资格考试',
        '雾港观测员成绩出来了，我过了',
        '你觉得今天上海天气怎么样',
        '她又来上海开会了',
    ])('does not route a self-contained sentence: %s', (content) => {
        const gate = evaluateLocalRecallGate([message('user', content)]);

        expect(gate.shouldRoute).toBe(false);
    });

    it('does not route when recent context already gives one clear antecedent', () => {
        const gate = evaluateLocalRecallGate([
            message('assistant', '雾港观测员成绩出来了吗？'),
            message('user', '我过了'),
        ]);

        expect(gate.shouldRoute).toBe(false);
        expect(gate.features.recentContextSufficient).toBe(true);
        expect(gate.reasons).toContain('recent_context_sufficient');
    });

    it('still routes when recent context lists competing antecedents', () => {
        const gate = evaluateLocalRecallGate([
            message('assistant', '考试和面试都有消息了吗？'),
            message('user', '我过了'),
        ]);

        expect(gate.shouldRoute).toBe(true);
        expect(gate.features.recentContextAnchorCount).toBeGreaterThan(1);
        expect(gate.features.recentContextSufficient).toBe(false);
    });

    it('does not analyze an image-only current turn', () => {
        const image = { ...message('user', 'data:image/png;base64,AAAA'), type: 'image' as const };
        const gate = evaluateLocalRecallGate([image]);

        expect(gate.analyzable).toBe(false);
        expect(gate.shouldRoute).toBe(false);
        expect(gate.reasons).toEqual(['no_current_user_text']);
    });

    it('normalizes the future light-LLM plan and rejects month scope', () => {
        const plan = normalizeRecallPlan({
            route: true,
            confidence: 1.4,
            queries: [
                { text: ' 雾港观测员成绩 ', scope: 'memory', weight: 0.9, source: 'reference' },
                { text: '考试结果事件盒', scope: 'event_box', weight: 3, source: 'event_update' },
                { text: '去年整月', scope: 'month', weight: 1, source: 'continuation' },
            ],
        });

        expect(plan).toEqual({
            route: true,
            confidence: 1,
            queries: [
                { text: '雾港观测员成绩', scope: 'memory', weight: 0.9, source: 'reference' },
                { text: '考试结果事件盒', scope: 'event_box', weight: 1, source: 'event_update' },
            ],
        });
    });

    it('forces route=false when a model gives no executable queries', () => {
        expect(normalizeRecallPlan({ route: true, confidence: 0.8, queries: [] })).toEqual({
            route: false,
            confidence: 0.8,
            queries: [],
        });
    });

    it('runs the local analyzer only for ChatApp when the flag is on', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { recallRouter: true },
        }));
        const char = { id: 'char-router', memoryPalaceEnabled: false };
        const recent = [message('user', '我过了')];

        const chatTrace = await injectMemoryPalace(char, recent, undefined, undefined, { entryPoint: 'chat_app' });
        const vrTrace = await injectMemoryPalace(char, recent, undefined, undefined, { entryPoint: 'vr_world' });

        expect(chatTrace.contextAnalyzer?.shouldGuide).toBe(true);
        expect(chatTrace.contextAnalyzer?.signals.resultUpdate).toBe(1);
        expect(chatTrace.recallResolver).toEqual({ status: 'deferred' });
        expect(chatTrace.stages.some(stage => stage.name === 'context_analyzer')).toBe(true);
        expect(vrTrace.contextAnalyzer).toBeUndefined();
        expect(vrTrace.recallResolver).toEqual({ status: 'out_of_scope' });
        expect(vrTrace.stages.some(stage => stage.name === 'context_analyzer')).toBe(false);
    });

    it('does not spend gate work while the feature flag is off', async () => {
        const trace = await injectMemoryPalace(
            { id: 'char-router', memoryPalaceEnabled: false },
            [message('user', '我过了')],
            undefined,
            undefined,
            { entryPoint: 'chat_app' },
        );

        expect(trace.contextAnalyzer).toBeUndefined();
        expect(trace.recallResolver).toEqual({ status: 'disabled' });
        expect(trace.stages.some(stage => stage.name === 'context_analyzer')).toBe(false);
    });

    it('renders a behavioral context hint without naming a guessed event', () => {
        const analysis = analyzeLocalContext([message('user', '我过啦')]);
        const hint = renderLocalContextGuidance(analysis);

        expect(hint).toContain('结果落地或进展更新');
        expect(hint).toContain('已召回记忆');
        expect(hint).not.toContain('雾港观测员');
        expect(hint).toContain('不要擅自补成唯一答案');
    });

    it.each(['好', '嗯哼', '谢谢', '我通过了雾港观测员资格考试'])(
        'does not render context guidance for a self-contained or social utterance: %s',
        (content) => {
            expect(renderLocalContextGuidance(analyzeLocalContext([message('user', content)]))).toBe('');
        },
    );
});

describe('reserved Recall Resolver protocol', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const config = {
        baseUrl: 'https://light.example/v1',
        apiKey: 'test-key',
        model: 'light-model',
    };

    it('normalizes a routed plan from the light model', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({
                route: true,
                confidence: 0.86,
                queries: [{
                    text: '雾港观测员成绩',
                    scope: 'event_box',
                    weight: 0.9,
                    source: 'event_update',
                }],
            }) } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await runLightRecallRouter([
            message('assistant', '考试和面试都有消息了吗？'),
            message('user', '我过了'),
        ], config, '测试角色', '测试用户');

        expect(result.status).toBe('routed');
        expect(result.plan.queries).toEqual([{
            text: '雾港观测员成绩',
            scope: 'event_box',
            weight: 0.9,
            source: 'event_update',
        }]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const request = fetchMock.mock.calls[0][1] as RequestInit;
        const body = JSON.parse(String(request.body));
        expect(body.stream).toBe(false);
        expect(body.messages[1].content).toContain('我过了');
    });

    it('does not accept a low-confidence model guess', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            choices: [{ message: { content: JSON.stringify({
                route: true,
                confidence: 0.3,
                queries: [{ text: '某个考试', scope: 'memory', weight: 1 }],
            }) } }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

        const result = await runLightRecallRouter([message('user', '我过了')], config);

        expect(result.status).toBe('low_confidence');
        expect(result.plan.route).toBe(true);
    });

    it('times out without retrying', async () => {
        const fetchMock = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await runLightRecallRouter([message('user', '她又来了')], config, undefined, undefined, 10);

        expect(result.status).toBe('timeout');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
