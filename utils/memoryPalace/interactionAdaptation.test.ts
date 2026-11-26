import { beforeEach, describe, expect, it } from 'vitest';

import type { CharacterAccommodationPolicy, Message } from '../../types';
import { injectMemoryPalace } from './pipeline';
import {
    analyzeUserInteraction,
    DEFAULT_CHARACTER_ACCOMMODATION,
    INTERACTION_TREND_TURN_LIMIT,
    renderInteractionAdaptationGuidance,
    resolveAccommodationPolicy,
} from './interactionAdaptation';

let nextId = 1;
const message = (role: Message['role'], content: string, timestamp?: number): Message => ({
    id: nextId++,
    charId: 'char-interaction',
    role,
    type: 'text',
    content,
    timestamp: timestamp ?? nextId * 1000,
});

const fullPolicy: CharacterAccommodationPolicy = {
    length: 1,
    rhythm: 1,
    energy: 1,
    punctuation: 1,
    emoji: 1,
};

describe('M2 ChatApp interaction adaptation', () => {
    beforeEach(() => {
        nextId = 1;
        localStorage.clear();
    });

    it('separates a sudden current impulse from the slower user trend', () => {
        const analysis = analyzeUserInteraction([
            message('user', '我前几轮都在比较完整地说明背景、经过和自己的判断，希望慢慢把整件事聊清楚。'),
            message('assistant', '知道了。'),
            message('user', '这里还有一些补充背景，我依然想把细节讲完整以后再一起判断。'),
            message('assistant', '你继续。'),
            message('user', '啊啊啊我过啦！！！🎉🎉'),
        ], fullPolicy);

        expect(analysis.analyzable).toBe(true);
        expect(analysis.hasTrend).toBe(true);
        expect(analysis.impulse.length).toBeLessThan(analysis.trend.length);
        expect(analysis.impulse.energy).toBeGreaterThan(analysis.trend.energy);

        const guidance = renderInteractionAdaptationGuidance(analysis);
        expect(guidance).toContain('这一轮的步伐');
        expect(guidance).toContain('回复长度：明显变短');
        expect(guidance).toContain('情绪能量：明显升高');
        expect(guidance).toContain('自己的性格');
        expect(guidance.split('\n').filter(line => line.startsWith('- '))).toHaveLength(2);
        expect(guidance).not.toMatch(/稍短|少铺垫|收住声量|标点力度|略微增加/);
        expect(guidance).not.toContain('啊啊啊我过啦');
    });

    it('learns the trend only from user messages, never from character replies', () => {
        const calmReplies = analyzeUserInteraction([
            message('user', '前面我说得比较完整，也没有很着急。'),
            message('assistant', '嗯。'),
            message('user', '现在继续说一下'),
        ], fullPolicy);
        const loudReplies = analyzeUserInteraction([
            message('user', '前面我说得比较完整，也没有很着急。'),
            message('assistant', '啊啊啊！！！🎉🎉🎉'),
            message('user', '现在继续说一下'),
        ], fullPolicy);

        expect(loudReplies.trend).toEqual(calmReplies.trend);
        expect(loudReplies.target).toEqual(calmReplies.target);
    });

    it('treats many consecutive bubbles as one turn instead of letting them erase the slow trend', () => {
        const messages: Message[] = [];
        for (let turn = 0; turn < 12; turn += 1) {
            messages.push(message(
                'user',
                `这是第${turn + 1}轮比较完整的说明，我会把背景、过程、自己的感受和判断都慢慢讲清楚。`,
            ));
            messages.push(message('assistant', '我在听。'));
        }
        // 同一轮连发很多短气泡；它应当只占一个趋势样本。
        for (let bubble = 0; bubble < 10; bubble += 1) {
            messages.push(message('user', `补充${bubble + 1}`));
        }
        messages.push(message('assistant', '知道了。'));
        messages.push(message('user', '继续'));

        const analysis = analyzeUserInteraction(messages, fullPolicy);

        expect(INTERACTION_TREND_TURN_LIMIT).toBe(20);
        expect(analysis.hasTrend).toBe(true);
        expect(analysis.trend.length).toBeGreaterThan(0.3);
    });

    it('honors a character policy that disables every adaptation dimension', () => {
        const analysis = analyzeUserInteraction([
            message('user', '之前我一直在很平静地慢慢讲这件事。'),
            message('assistant', '嗯。'),
            message('user', '啊啊啊成啦！！！🎉'),
        ], { length: 0, rhythm: 0, energy: 0, punctuation: 0, emoji: 0 });

        expect(Object.values(analysis.shifts).every(value => value === 0)).toBe(true);
        expect(renderInteractionAdaptationGuidance(analysis)).toBe('');
    });

    it('uses conservative defaults and clamps invalid custom values', () => {
        expect(resolveAccommodationPolicy()).toEqual(DEFAULT_CHARACTER_ACCOMMODATION);
        expect(resolveAccommodationPolicy({ length: 2, energy: -1 })).toMatchObject({
            length: 1,
            energy: 0,
            rhythm: DEFAULT_CHARACTER_ACCOMMODATION.rhythm,
        });
    });

    it('reports at most two signals without mutating analysis or reviving a disabled dimension', () => {
        const analysis = analyzeUserInteraction([
            message('user', '此前我在慢慢讲述一些背景，内容比较长，也并不着急。'),
            message('assistant', '嗯。'),
            message('user', '啊啊啊！！！🎉🎉'),
        ], { ...fullPolicy, length: 0 });
        const before = JSON.stringify(analysis);
        const guidance = renderInteractionAdaptationGuidance(analysis, '阿一');
        expect(guidance).not.toContain('回复长度：');
        expect(guidance).toContain('情绪能量：明显升高');
        expect(guidance).toContain('完全按 阿一 自己的性格');
        expect(guidance.split('\n').filter(line => line.startsWith('- ')).length).toBeLessThanOrEqual(2);
        expect(JSON.stringify(analysis)).toBe(before);
    });

    it('does not inject punctuation or emoji instructions when only those dimensions are enabled', () => {
        const analysis = analyzeUserInteraction([message('user', '啊啊啊！！！🎉🎉')], {
            length: 0, rhythm: 0, energy: 0, punctuation: 1, emoji: 1,
        });
        expect(renderInteractionAdaptationGuidance(analysis)).toBe('');
    });

    it('does not mistake ordinary punctuation-free text for a strong low-energy signal', () => {
        const analysis = analyzeUserInteraction([
            message('user', '我知道了'),
        ]);

        expect(Math.abs(analysis.shifts.energy)).toBeLessThan(0.04);
        expect(renderInteractionAdaptationGuidance(analysis)).not.toContain('情绪能量：明显偏低');
    });

    it('records M2 for ChatApp even when memory palace recall itself is disabled', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { interactionAdaptation: true },
        }));
        const char = {
            id: 'char-interaction',
            name: '测试角色',
            memoryPalaceEnabled: false,
        };

        const trace = await injectMemoryPalace(
            char,
            [message('user', '我过啦！！！')],
            undefined,
            '测试用户',
            { entryPoint: 'chat_app' },
        );

        expect(trace.outcome).toBe('skipped_palace_disabled');
        expect(trace.interactionAdaptation?.status).toBe('observed');
        expect(trace.stages.some(stage => stage.name === 'interaction_adaptation')).toBe(true);
    });

    it('keeps non-ChatApp entry points out of M2', async () => {
        localStorage.setItem('os_memory_palace_config', JSON.stringify({
            featureFlags: { interactionAdaptation: true },
        }));
        const trace = await injectMemoryPalace(
            { id: 'char-interaction', memoryPalaceEnabled: false },
            [message('user', '我过啦！！！')],
            undefined,
            undefined,
            { entryPoint: 'world_home' },
        );

        expect(trace.interactionAdaptation?.status).toBe('out_of_scope');
        expect(trace.stages.some(stage => stage.name === 'interaction_adaptation')).toBe(false);
    });
});
