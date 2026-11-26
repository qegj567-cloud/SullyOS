import { beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '../../types';
import {
    advanceConversationEngagement,
    analyzeConversationEngagement,
    clearConversationEngagementState,
    CONVERSATION_ENGAGEMENT_ENGINE_KEY,
    CONVERSATION_ENGAGEMENT_STORAGE_PREFIX,
    loadConversationEngagementState,
    renderConversationEngagementGuidance,
    type ConversationEngagementAnalysis,
} from './conversationEngagement';
import { injectMemoryPalace } from './pipeline';

let nextId = 1;
const history: Message[] = [];
const push = (role: Message['role'], content: string): Message => {
    const item: Message = {
        id: nextId++,
        charId: 'char-engagement',
        role,
        type: 'text',
        content,
        timestamp: nextId * 1000,
    };
    history.push(item);
    return item;
};

describe('M3 v2 Conversation Engagement', () => {
    beforeEach(() => {
        nextId = 1;
        history.length = 0;
        localStorage.clear();
    });

    it('treats an understated personal load as an unfinished disclosure, not a closed comfort request', () => {
        push('user', '我很累，事情很多。');
        const result = advanceConversationEngagement('char-engagement', history);

        expect(result.analysis.conversationAct).toBe('open_disclosure');
        expect(result.analysis.engagementState).toBe('opening');
        expect(result.analysis.interactionMode).toBe('supportive');
        expect(result.analysis.responsePlan).toMatchObject({
            primary: 'acknowledge',
            secondary: 'invite',
        });
        expect(result.analysis.subject.active).toBe(true);
        expect(result.analysis.reasons).toContain('personal_load');

        const guidance = renderConversationEngagementGuidance(result.analysis);
        expect(guidance).toContain('【谈话参与底线】');
        expect(guidance).toContain('目前没有结束信号');
        expect(guidance).toContain('既关注对方此刻的感受，也关注事情本身发生了什么');
        expect(guidance).not.toContain('提前站队');
        expect(guidance).not.toContain('User');
        expect(guidance).toContain('完全由 你 自己的性格决定');
        expect(guidance).toContain('对方正在开启一件还没讲完的事');
        expect(guidance).toContain('不要用“别想了”“都会过去的”');
        expect(guidance).not.toMatch(/最多问一个|不需要用明确问句|不要为了安慰而自动站队/);
        expect(guidance).not.toContain('角色');
        expect(guidance).not.toContain('我很累');
    });

    it.each([
        '桌面上的三个窗口还都停在那里。',
        '这阵子像一直在逆着风走。',
        '刚才那段到现在还悬在半空。',
    ])('opens a meaningful unclosed statement without requiring topic keywords: %s', (content) => {
        push('user', content);
        const result = advanceConversationEngagement('char-engagement', history);

        expect(result.analysis.conversationAct).toBe('open_disclosure');
        expect(result.analysis.engagementState).toBe('opening');
        expect(result.analysis.interactionMode).toBe('exploratory');
        expect(result.analysis.reasons).toContain('open_ended_statement');
        expect(result.analysis.responsePlan).toMatchObject({
            primary: 'acknowledge',
            secondary: 'invite',
        });
        expect(renderConversationEngagementGuidance(result.analysis)).toContain('事情本身发生了什么');
    });

    it.each([
        '帮我把下面这段内容翻译成英文。',
        '这个函数返回什么？',
        '下午好呀。',
    ])('does not turn a direct request, question, or greeting into a disclosure: %s', (content) => {
        push('user', content);
        const result = advanceConversationEngagement('char-engagement', history);

        expect(result.analysis.engagementState).toBe('idle');
        expect(result.analysis.shouldGuide).toBe(false);
        expect(result.analysis.stance.confidence).toBe(0);
        expect(renderConversationEngagementGuidance(result.analysis)).toBe('');
    });

    it('distinguishes a tired status update with an explicit closure from an opening', () => {
        push('user', '今天上班好累，准备睡觉啦。');
        const result = advanceConversationEngagement('char-engagement', history);

        expect(result.analysis.conversationAct).toBe('close');
        expect(result.analysis.engagementState).toBe('idle');
        expect(result.analysis.shouldGuide).toBe(false);
        expect(result.state.activeSubject).toBeUndefined();
        const guidance = renderConversationEngagementGuidance(result.analysis);
        expect(guidance).toBe('');
    });

    it('keeps the same subject through elaboration and a low-information continuation', () => {
        push('user', '我很累，事情很多。');
        const opened = advanceConversationEngagement('char-engagement', history);
        const subjectId = opened.state.activeSubject?.id;

        push('assistant', '我在听。');
        push('user', '主要是今天单位那个事情。');
        const engaged = advanceConversationEngagement('char-engagement', history, opened.state);
        expect(engaged.analysis.engagementState).toBe('engaged');
        expect(engaged.state.activeSubject?.id).toBe(subjectId);
        expect(engaged.analysis.responsePlan.primary).toBe('follow');

        push('assistant', '嗯。');
        push('user', '就是……');
        const continued = advanceConversationEngagement('char-engagement', history, engaged.state);
        expect(continued.analysis.engagementState).toBe('engaged');
        expect(continued.state.activeSubject?.id).toBe(subjectId);
        expect(continued.analysis.responsePlan.explicitQuestionBudget).toBe(0);
        expect(continued.analysis.reasons).toContain('repeated_low_information_turn');
    });

    it('reflects a new development against the active subject instead of restarting the conversation', () => {
        push('user', '之前那些事又有后续了。');
        const opened = advanceConversationEngagement('char-engagement', history);
        push('assistant', '继续。');
        push('user', '今天主任突然又叫了另一个人过去，明明之前说让我负责。');
        const updated = advanceConversationEngagement('char-engagement', history, opened.state);

        expect(updated.analysis.conversationAct).toBe('update');
        expect(updated.analysis.engagementState).toBe('engaged');
        expect(updated.analysis.responsePlan).toMatchObject({ primary: 'reflect', secondary: 'follow' });
        expect(updated.analysis.subject.unresolvedHookKinds).toContain('changed_arrangement');
        expect(updated.analysis.stance.confidence).toBeGreaterThan(opened.analysis.stance.confidence);
    });

    it('moves into resolving and forms only a progressive stance when the user asks for a view', () => {
        push('user', '之前主任说这件事让我负责，今天却突然换了另一个人。');
        const opened = advanceConversationEngagement('char-engagement', history);
        push('assistant', '这里确实出现了变化。');
        push('user', '所以你觉得他是不是根本没打算让我负责？');
        const resolving = advanceConversationEngagement('char-engagement', history, opened.state);

        expect(resolving.analysis.conversationAct).toBe('ask_stance');
        expect(resolving.analysis.engagementState).toBe('resolving');
        expect(['reflect', 'evaluate']).toContain(resolving.analysis.responsePlan.primary);
        expect(resolving.analysis.responsePlan.explicitQuestionBudget).toBe(0);
        expect(renderConversationEngagementGuidance(resolving.analysis)).toContain('这件事已展开到可以表态的阶段');
    });

    it('closes the old subject and opens a new one when the user shifts topics', () => {
        push('user', '单位那件事还有后续。');
        const work = advanceConversationEngagement('char-engagement', history);
        const workId = work.state.activeSubject?.id;
        push('assistant', '你说。');
        push('user', '算了不想这个了，给你看我刚画的东西！');
        const shifted = advanceConversationEngagement('char-engagement', history, work.state);

        expect(shifted.analysis.conversationAct).toBe('shift');
        expect(shifted.analysis.engagementState).toBe('opening');
        expect(shifted.analysis.responsePlan).toMatchObject({ primary: 'close', secondary: 'shift' });
        expect(shifted.state.activeSubject?.id).not.toBe(workId);
        expect(shifted.analysis.subject.changed).toBe(true);
        const guidance = renderConversationEngagementGuidance(shifted.analysis, '阿一');
        expect(guidance).toContain('对方切换了新主题');
        expect(guidance).not.toContain('对方正在开启一件还没讲完的事');
        expect(guidance).toContain('完全由 阿一 自己的性格决定');
    });

    it('enters a new topic directly when there is no old subject to close', () => {
        push('user', '给你看我刚画的东西！');
        const shifted = advanceConversationEngagement('char-engagement', history);

        expect(shifted.analysis.conversationAct).toBe('shift');
        expect(shifted.analysis.responsePlan).toMatchObject({ primary: 'shift' });
        expect(shifted.analysis.responsePlan.secondary).toBeUndefined();
    });

    it('does not revive a closed subject on the next ordinary greeting', () => {
        push('user', '单位那件事还有后续。');
        const opened = advanceConversationEngagement('char-engagement', history);
        push('assistant', '我听着。');
        push('user', '算了，先不说了。');
        const closed = advanceConversationEngagement('char-engagement', history, opened.state);
        expect(closed.analysis.engagementState).toBe('closing');

        push('assistant', '好。');
        push('user', '早上好。');
        const greeting = advanceConversationEngagement('char-engagement', history, closed.state);
        expect(greeting.analysis.engagementState).toBe('idle');
        expect(greeting.state.activeSubject).toBeUndefined();
        expect(greeting.analysis.shouldGuide).toBe(false);
    });

    it('persists per-character state locally and makes duplicate payload builds idempotent', () => {
        push('user', '今天公司来了个特别奇怪的人。');
        const first = analyzeConversationEngagement('char-engagement', history);
        const stored = loadConversationEngagementState('char-engagement');
        const duplicate = analyzeConversationEngagement('char-engagement', history);

        expect(first.engagementState).toBe('opening');
        expect(stored?.activeSubject).toBeDefined();
        expect(duplicate).toEqual(first);
        expect(loadConversationEngagementState('char-engagement')?.activeSubject?.knownFacts).toHaveLength(1);

        clearConversationEngagementState('char-engagement');
        expect(loadConversationEngagementState('char-engagement')).toBeUndefined();
    });

    it('does not carry a subject into a replaced chat history for the same character', () => {
        push('user', '之前那些事又有后续了。');
        const opened = advanceConversationEngagement('char-engagement', history);
        const replacementHistory: Message[] = [{
            id: 999,
            charId: 'char-engagement',
            role: 'user',
            type: 'text',
            content: '早上好。',
            timestamp: Date.now(),
        }];
        const replacement = advanceConversationEngagement(
            'char-engagement',
            replacementHistory,
            opened.state,
        );

        expect(replacement.analysis.engagementState).toBe('idle');
        expect(replacement.state.activeSubject).toBeUndefined();
        expect(replacement.analysis.shouldGuide).toBe(false);
    });

    it('keeps the legacy depth engine available as a runtime fallback', async () => {
        localStorage.setItem(CONVERSATION_ENGAGEMENT_ENGINE_KEY, 'legacy');
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        const trace = await injectMemoryPalace(
            { id: 'char-engagement', memoryPalaceEnabled: false },
            [push('user', '请认真分析这个规则背后的逻辑。')],
            undefined,
            undefined,
            { entryPoint: 'chat_app' },
        );

        expect(trace.deepEngagement?.engine).toBe('legacy_depth');
        expect(trace.deepEngagement?.status).toBe('observed');
    });

    it.each([
        ['P1 overrides P2 and P3', 'opening', true, 'playful', true, 0, '目前没有结束信号'],
        ['P2 overrides P3', 'engaged', false, 'playful', true, 0, '你可以保持轻松或锐评'],
        ['P3 needs previous comfort', 'engaged', false, 'exploratory', true, 0, '不要再重复“抱抱”“别难过”'],
        ['neutral opening has no guard', 'opening', false, 'exploratory', false, 0, ''],
        ['closure signal suppresses P1', 'engaged', true, 'exploratory', false, 1, ''],
        ['judgment does not get P1 or P3', 'resolving', true, 'analytical', true, 0, ''],
        ['closing does not get P1 or P3', 'closing', true, 'reactive', true, 1, ''],
    ] as const)('%s: at most one guard and one anchor', (_label, phase, negative, mode, comfort, closure, expected) => {
        push('user', '之前那件事有后续。');
        const base = advanceConversationEngagement('char-engagement', history).analysis;
        const analysis: ConversationEngagementAnalysis = {
            ...base, engagementState: phase, interactionMode: mode,
            signals: { ...base.signals, negativeEmotion: negative, previousGenericComfort: comfort, closure },
        };
        const guidance = renderConversationEngagementGuidance(analysis, '阿一');
        const guards = ['目前没有结束信号', '你可以保持轻松或锐评', '不要再重复“抱抱”“别难过”'];
        expect(guards.filter(guard => guidance.includes(guard))).toEqual(expected ? [expected] : []);
        // header + base + exactly one anchor + optional guard + footer.
        expect(guidance.trim().split('\n')).toHaveLength(expected ? 5 : 4);
        expect(guidance).toContain('完全由 阿一 自己的性格决定');
        expect(guidance).not.toContain('之前那件事有后续');
    });

    it.each([
        ['抱抱，别难过了。', true],
        ['我会一直在。', true],
        ['不要再说抱抱了。', false],
        ['他只会说“抱抱”。', false],
        ['“抱抱”是刚才引用的原话。', false],
        ['主任在什么场合改的安排？', false],
    ])('detects actual previous comfort, not quoted mentions: %s', (reply, expected) => {
        push('user', '单位那件事还没讲完。');
        const opened = advanceConversationEngagement('char-engagement', history);
        push('assistant', reply);
        push('user', '主要是主任把安排换了。');
        const result = advanceConversationEngagement('char-engagement', history, opened.state);
        expect(result.analysis.signals.previousGenericComfort).toBe(expected);
        expect(renderConversationEngagementGuidance(result.analysis).includes('不要再重复“抱抱”“别难过”')).toBe(expected);
        expect(JSON.stringify(result.analysis)).not.toContain(reply);
    });

    it('scans all bubbles in the last assistant turn, but never crosses a user or image turn', () => {
        push('user', '有件事还没讲完。');
        push('assistant', '抱抱。');
        push('assistant', '我听着。');
        push('user', '主要是主任把安排换了。');
        expect(advanceConversationEngagement('char-engagement', history).analysis.signals.previousGenericComfort).toBe(true);
        push('assistant', '换成什么安排？');
        push('user', '然后换成了另一个方案。');
        expect(advanceConversationEngagement('char-engagement', history).analysis.signals.previousGenericComfort).toBe(false);

        history.length = 0;
        push('assistant', '抱抱。');
        push('user', 'blobref:image').type = 'image';
        push('assistant', 'blobref:emoji').type = 'emoji';
        push('user', '主要是主任把安排换了。');
        expect(advanceConversationEngagement('char-engagement', history).analysis.signals.previousGenericComfort).toBe(false);
    });

    it('refreshes guard signals for edited assistant text and old cached analyses without advancing state', () => {
        push('user', '有件事还没讲完。');
        const reply = push('assistant', '抱抱。');
        push('user', '主要是主任把安排换了。');
        const first = advanceConversationEngagement('char-engagement', history);
        expect(first.analysis.signals.previousGenericComfort).toBe(true);
        reply.content = '我听着。';
        delete first.state.lastAnalysis!.signals.previousGenericComfort;
        delete first.state.lastAnalysis!.signals.negativeEmotion;
        const rebuilt = advanceConversationEngagement('char-engagement', history, first.state);
        expect(rebuilt.analysis.signals.previousGenericComfort).toBe(false);
        expect(rebuilt.state).toBe(first.state);
        expect(rebuilt.state.activeSubject?.knownFacts).toEqual(first.state.activeSubject?.knownFacts);
    });

    it('uses the topic switch anchor rather than opening or closing, with no unfinished-negative guard', () => {
        push('user', '今天单位那件事很烦。');
        const opened = advanceConversationEngagement('char-engagement', history);
        push('assistant', '抱抱。');
        push('user', '不想聊这个了，给你看我刚画的东西。');
        const result = advanceConversationEngagement('char-engagement', history, opened.state);
        const guidance = renderConversationEngagementGuidance(result.analysis);
        expect(guidance).toContain('对方切换了新主题');
        expect(guidance).not.toMatch(/对方正在开启|对方正在收束|目前没有结束信号|不要再重复/);
    });

    it('allows a playful opening, but closing wins over a laughing surface', () => {
        push('user', '刚发现一件特别好玩的事哈哈。');
        const opened = advanceConversationEngagement('char-engagement', history);
        expect(renderConversationEngagementGuidance(opened.analysis)).toContain('你可以保持轻松或锐评');
        push('assistant', '抱抱。');
        push('user', '哈哈，先不聊了。');
        const closed = advanceConversationEngagement('char-engagement', history, opened.state);
        const guidance = renderConversationEngagementGuidance(closed.analysis);
        expect(guidance).toContain('对方正在收束这件事');
        expect(guidance).not.toMatch(/目前没有结束信号|你可以保持轻松或锐评|不要再重复/);
    });

    it('clears corrupt v2 state after a one-turn automatic legacy fallback', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { deepEngagement: true },
        }));
        localStorage.setItem(`${CONVERSATION_ENGAGEMENT_STORAGE_PREFIX}char-engagement`, JSON.stringify({
            version: 2,
            charId: 'char-engagement',
            engagementState: 'engaged',
            interactionMode: 'exploratory',
            activeSubject: { id: 'broken' },
        }));
        const trace = await injectMemoryPalace(
            { id: 'char-engagement', memoryPalaceEnabled: false },
            [push('user', '然后呢。')],
            undefined,
            undefined,
            { entryPoint: 'chat_app' },
        );

        expect(trace.deepEngagement?.engine).toBe('legacy_depth');
        expect(localStorage.getItem(`${CONVERSATION_ENGAGEMENT_STORAGE_PREFIX}char-engagement`)).toBeNull();
    });
});
