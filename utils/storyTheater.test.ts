import { ContextBuilder } from './context';
import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message, StoryTheaterPreset, UserProfile } from '../types';
import { STORY_PRESET_SIMPLE_CHOICES } from '../components/date/story/StoryPresetMaker';
import {
    appendStoryAffinityInput,
    appendStoryAffinityInputs,
    appendStoryUserTurn,
    applyStoryPresetChoice,
    BUILTIN_NIGHT_SCREENING_PRESET,
    buildStoryMiniTheaterReminder,
    buildStoryActorMemoryEnvelope,
    buildStoryArchiveMemoryEnvelope,
    buildStoryAffinityAwarenessReminder,
    buildStoryBackstageAftermathReminder,
    buildStoryIdentityGuard,
    buildStoryPrefillInstruction,
    buildStoryMultiAffinityGuide,
    buildStoryWorldbookScanMessages,
    compileStoryPreset,
    prepareStoryGenerationSettings,
    reconcileStoryAffinityScores,
    createBlankStoryPreset,
    createStoryTheaterDraft,
    hasStoryTheaterParticipant,
    dedupeTheaterWorldbooks,
    describeEmptyStoryCompletion,
    describeStoryApiError,
    getStoryPresetPromptGroups,
    getActiveStoryMiniTheaterPrompt,
    getPendingStoryRetryInput,
    isProtectedStoryPrompt,
    isStoryUserLastCompatibilityError,
    storyTimelineTimestampForCharacter,
    parseStoryDisplayBlocks,
    parseStoryMiniTheater,
    parseStoryTheaterPreset,
    normalizeStoryTheater,
    REAL_COMPANION_MEMORY_GUARD,
    RELATIONSHIP_TEXTURE_GUIDE,
    resolveStoryPresetDocument,
    resolveStoryTheaterMask,
    selectStoryArchiveBatch,
    storyTheaterMemoryRecipientIds,
    formatActorRecentMessages,
    formatStoryTheaterExport,
    makeStoryPresetFileName,
    makeStoryTheaterFileName,
} from './storyTheater';

describe('剧情接口报错诊断', () => {
    it('保留上游 400 的具体原因', () => {
        expect(describeStoryApiError(400, { error: { message: 'context_length_exceeded: maximum 32768' } }))
            .toBe('API Error 400：context_length_exceeded: maximum 32768');
        expect(describeStoryApiError(400, { error: '最后一条消息必须是 user' }))
            .toBe('API Error 400：最后一条消息必须是 user');
    });

    it('只在上游明确拒绝末条角色时建议 400 兼容模式', () => {
        expect(isStoryUserLastCompatibilityError('API Error 400: final message role must be user')).toBe(true);
        expect(isStoryUserLastCompatibilityError('API Error 400：最后一条消息必须是 user')).toBe(true);
        expect(isStoryUserLastCompatibilityError('API Error 400: context_length_exceeded')).toBe(false);
    });

    it('空正文会暴露 finish_reason，而不是统一叫用户盲目重试', () => {
        expect(describeEmptyStoryCompletion({ choices: [{ finish_reason: 'length', message: { content: '' } }] }))
            .toContain('已用完输出额度');
        expect(describeEmptyStoryCompletion({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }))
            .toContain('内容过滤');
        expect(describeEmptyStoryCompletion({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }))
            .toContain('finish_reason=stop');
    });
});

describe('剧情原文导出', () => {
    it('按原始楼层顺序导出真实陪伴的完整推进与正文', () => {
        const output = formatStoryTheaterExport(
            { title: '雨夜', premise: '从车站开始', writesToCharacterMemory: true },
            '条条',
            ['林星', 'Noir'],
            [
                { id: 2, charId: 'story', role: 'assistant', type: 'text', content: '<story_text>他撑开伞。</story_text>', timestamp: 2 },
                { id: 1, charId: 'story', role: 'user', type: 'text', content: '走出车站。', timestamp: 1 },
            ] as Message[],
            new Date(2026, 7, 13, 20, 0, 0).getTime(),
        );

        expect(output).toContain('模式：真实时间陪伴');
        expect(output).toContain('角色：林星、Noir');
        expect(output.indexOf('走出车站。')).toBeLessThan(output.indexOf('<story_text>他撑开伞。</story_text>'));
        expect(makeStoryTheaterFileName('雨/夜', new Date(2026, 7, 13).getTime())).toBe('雨_夜_剧情记录_2026-08-13.txt');
        expect(makeStoryPresetFileName('雨/夜：预设')).toBe('雨_夜：预设.json');
    });
});

describe('多人剧情记忆的人称与归属', () => {
    it('把每位角色的召回包进具名专属信封，并阻止把“你”重绑定到面具', () => {
        const result = buildStoryActorMemoryEnvelope('林星', '我记得你那天留下了伞。', '条条', 'Noir');

        expect(result).toContain('林星 的专属既有记忆');
        expect(result).toContain('第一人称“我/我的”，默认指「林星」');
        expect(result).toContain('第二人称“你/你的”');
        expect(result).toContain('原互动对象「条条」');
        expect(result).toContain('不得因此把旧记忆里的“你”从「条条」改绑到当前身份');
        expect(result).toContain('不得归给、共享给或改写成其他角色的亲历记忆');
    });

    it('近期原文显式标出记忆中的你，不把 user 行伪装成当前面具', () => {
        const actor = { id: 'lin', name: '林星' } as CharacterProfile;
        const ts = new Date('2026-11-03T11:22:33Z').getTime();
        const messages = [
            { id: 1, charId: 'lin', role: 'user', type: 'text', content: '把伞递给他。', timestamp: ts },
            { id: 2, charId: 'lin', role: 'assistant', type: 'text', content: '<scene_header><time>2026年3月14日 · 星期六 · 23:40</time></scene_header>我接住了。', timestamp: ts },
        ] as Message[];

        const result = formatActorRecentMessages(actor, messages, '条条', 'Noir');
        expect(result).toContain('林星 最近携带的专属原文上下文');
        expect(result).toContain('- 记忆中的你（条条）：把伞递给他。');
        expect(result).toContain('- 林星：我接住了。');
        expect(result).not.toContain('2026');
        expect(result).not.toContain('<scene_header>');
        expect(result).toContain('不得把下列“记忆中的你”重新解释成当前身份');
    });

    it('把独立剧情向量召回标成共享档案而不是某个角色的脑内记忆', () => {
        const result = buildStoryArchiveMemoryEnvelope('我在雨里等你。');

        expect(result).toContain('本剧情共享档案召回');
        expect(result).toContain('不属于任何一位角色的个人记忆');
        expect(result).toContain('不得擅自把“我/你”归给当前面具或任一角色');
    });
});

describe('糯米机原生剧情预设边界', () => {
    it('内置 V6.27 已经是精简的原生文档', () => {
        const document = BUILTIN_NIGHT_SCREENING_PRESET.document;
        expect(document.schema).toBe('sullyos.story-preset');
        expect(document.version).toBe(1);
        expect(document.name).toContain('V6.27');
        expect(document.prompts).toHaveLength(130);
        expect(document.prompts.filter(prompt => prompt.enabled)).toHaveLength(53);
        const serialized = JSON.stringify(document);
        expect(serialized).not.toContain('prompt_order');
        expect(serialized).not.toContain('extensions');
        expect(serialized).not.toContain('openai_max_context');
        expect(serialized).not.toContain('{{setvar::');
        expect(serialized).not.toContain('{{getvar::');
    });

    it('默认开启项都有真实发送内容或原生插槽，且关系与组合输出协议没有旧结构冲突', () => {
        const document = BUILTIN_NIGHT_SCREENING_PRESET.document;
        const enabled = document.prompts.filter(prompt => prompt.enabled);
        expect(new Set(document.prompts.map(prompt => prompt.id)).size).toBe(document.prompts.length);
        expect(enabled.every(prompt => Boolean(prompt.marker || prompt.content.trim()))).toBe(true);
        const affinity = document.prompts.find(prompt => prompt.id === 'nmj-v65-affinity-control')!;
        expect(affinity.content).toContain('<affinity_person>');
        expect(affinity.content).toContain('<character_id>');
        expect(affinity.content).toContain('<c_to_u_score>');
        expect(affinity.content).toContain('<trust>');
        expect(affinity.content).toContain('<repair_will>');
        expect(affinity.content).not.toContain('<c_score>');
        expect(affinity.content).not.toContain('<u_score>');
        const scene = document.prompts.find(prompt => prompt.id === 'nmj-v3-scene-header')!;
        expect(scene.content).toContain('幕后与余波”（幕后暗格后紧接镜头债）');
        expect(scene.content).not.toContain('幕后暗格、世界线、镜头债');
        const exit = document.prompts.find(prompt => prompt.id === 'nmj-v3-exit-check')!;
        expect(exit.content).toContain('按 character_id 独立续接 C→U、U→C 与五维状态');
        expect(exit.content).toContain('幕后与余波（幕后暗格 → 镜头债）');
        expect(exit.content).not.toContain('单一“当前 C”');
        expect(exit.content).not.toContain('幕后暗格 → 世界线 → 镜头债');
        const preflight = document.prompts.find(prompt => prompt.id === 'nmj-v616-silent-preflight')!;
        expect(preflight.content).toContain('按 character_id 逐人续接 C→U、U→C 与五维关系混音');
        expect(preflight.content).not.toContain('由酒馆折叠显示');
    });

    it('旧 V6.14 快捷覆盖只继承开关，正文与新增层升级到 V6.27', () => {
        const legacyOverride = {
            ...BUILTIN_NIGHT_SCREENING_PRESET.document,
            name: '糯米鸡｜夜班放映室 V6.14',
            prompts: BUILTIN_NIGHT_SCREENING_PRESET.document.prompts
                .filter(prompt => prompt.id !== 'nmj-v616-silent-preflight')
                .map(prompt => prompt.id === 'nmj-v3-pov-second' ? { ...prompt, enabled: false, content: '旧第二人称正文' }
                    : prompt.id === 'nmj-v3-pov-third' ? { ...prompt, enabled: true, content: '旧第三人称正文' }
                        : prompt),
        };
        const resolved = resolveStoryPresetDocument(BUILTIN_NIGHT_SCREENING_PRESET, legacyOverride);
        expect(resolved.prompts.find(prompt => prompt.id === 'nmj-v3-pov-second')).toMatchObject({ enabled: false });
        expect(resolved.prompts.find(prompt => prompt.id === 'nmj-v3-pov-third')).toMatchObject({ enabled: true });
        expect(resolved.prompts.find(prompt => prompt.id === 'nmj-v3-pov-third')?.content).toContain('本条与“第二人称”误同时开启时，本条优先');
        expect(resolved.prompts.find(prompt => prompt.id === 'nmj-v616-silent-preflight')?.enabled).toBe(true);
    });

    it('拒绝其它应用的 prompt/completion JSON', () => {
        expect(() => parseStoryTheaterPreset(JSON.stringify({ prompts: [], prompt_order: [] }), 'foreign.json')).toThrow('只接受糯米机剧情预设');
        expect(() => parseStoryTheaterPreset(JSON.stringify({ model: 'x', messages: [] }), 'completion.json')).toThrow('只接受糯米机剧情预设');
    });

    it('内置小剧场对外只使用“你”和“角色”的称呼', () => {
        const miniTheaterLabels = STORY_PRESET_SIMPLE_CHOICES.find(choice => choice.label === '小剧场')?.options.map(option => option.label).join(' ') || '';
        expect(miniTheaterLabels).toContain('角色与你');
        expect(miniTheaterLabels).toContain('你和角色们');
        expect(miniTheaterLabels).not.toMatch(/\bAI\b|用户|演员/);
        for (const id of ['nmj-v3-theater-ai', 'nmj-v3-theater-user-sim', 'nmj-v3-theater-group']) {
            const prompt = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.find(item => item.id === id);
            expect(prompt?.name).not.toMatch(/\bAI\b|用户|演员/);
            expect(prompt?.content).not.toMatch(/\bAI\b|用户|演员/);
        }
    });

    it('只导入 sullyos.story-preset 并归一化参数', () => {
        const imported = parseStoryTheaterPreset(JSON.stringify({
            schema: 'sullyos.story-preset',
            version: 1,
            name: '雨夜',
            generation: { temperature: 9, topP: -1, maxTokens: 10 },
            prompts: [{ id: 'p1', name: '规则', enabled: true, role: 'system', content: '你好 {{user}}' }],
        }), 'rain.json', 42);
        expect(imported.format).toBe('sullyos-story-preset');
        expect(imported.document.generation.temperature).toBe(2);
        expect(imported.document.generation.topP).toBe(0);
        expect(imported.document.generation.maxTokens).toBe(256);
        expect(imported.createdAt).toBe(42);
    });
});

describe('剧情预设发送器', () => {
    const preset: StoryTheaterPreset = {
        id: 'native',
        name: '顺序测试',
        format: 'sullyos-story-preset',
        createdAt: 1,
        updatedAt: 1,
        document: {
            schema: 'sullyos.story-preset',
            version: 1,
            name: '顺序测试',
            generation: { temperature: 0.7, topP: 0.8, frequencyPenalty: 0.1, presencePenalty: 0.2, maxTokens: 2048 },
            assistantPrefill: '正文：',
            prompts: [
                { id: 'a', name: '开头', enabled: true, role: 'system', content: '为 {{user}} 写 {{group}} 的故事' },
                { id: 'b', name: '演员', enabled: true, role: 'user', content: '', marker: 'characters' },
                { id: 'c', name: '重复演员', enabled: true, role: 'assistant', content: '', marker: 'characters' },
                { id: 'd', name: '关闭', enabled: false, role: 'system', content: '不应发送' },
                { id: 'e', name: '历史', enabled: true, role: 'system', content: '', marker: 'history' },
            ],
        },
    };

    it('默认完整发送预设参数，只有显式兼容开关才省略三项', () => {
        const settings = {
            temperature: 0.9,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
            max_tokens: 8000,
        };
        expect(prepareStoryGenerationSettings(settings)).toEqual(settings);
        expect(prepareStoryGenerationSettings(settings, true)).toEqual({ temperature: 0.9, max_tokens: 8000 });

        expect(prepareStoryGenerationSettings({
            temperature: 0.7,
            top_p: 0.8,
            frequency_penalty: 0.1,
            presence_penalty: 0.2,
            max_tokens: 2048,
        }, true)).toEqual({ temperature: 0.7, max_tokens: 2048 });
    });

    it('遵守顺序、enabled、role、marker 去重、宏和 prefill', () => {
        const result = compileStoryPreset({
            preset,
            userName: '条条',
            characterNames: ['苏利', '糯糯'],
            slots: { actors: 'ACTOR_BLOCK', persona: '', scenario: '', worldBefore: '', worldAfter: '', history: 'HISTORY_BLOCK' },
        });
        const joined = result.messages.map(message => `${message.role}:${message.content}`).join('\n');
        expect(joined).toContain('system:为 条条 写 苏利、糯糯 的故事');
        expect(joined.match(/ACTOR_BLOCK/g)).toHaveLength(1);
        expect(joined).toContain('system:HISTORY_BLOCK');
        expect(joined).not.toContain('不应发送');
        expect(result.assistantPrefill).toEqual({ role: 'assistant', content: '正文：' });
        expect(result.settings).toMatchObject({ temperature: 0.7, top_p: 0.8, max_tokens: 2048 });
    });

    it('把角色设定前世界书放在角色资料前，并兼容缺少槽位的旧预设', () => {
        const result = compileStoryPreset({
            preset,
            userName: '条条',
            characterNames: ['苏利'],
            slots: {
                actors: 'ACTOR_BLOCK',
                persona: '',
                scenario: '',
                worldBefore: 'WORLD_BEFORE_BLOCK',
                worldAfter: '',
                history: '',
            },
        });
        const contents = result.messages.map(message => message.content);
        expect(contents.indexOf('WORLD_BEFORE_BLOCK')).toBeGreaterThanOrEqual(0);
        expect(contents.indexOf('WORLD_BEFORE_BLOCK')).toBeLessThan(contents.indexOf('ACTOR_BLOCK'));

        const blank = createBlankStoryPreset('空白', 1);
        const beforeIndex = blank.document.prompts.findIndex(prompt => prompt.marker === 'world_before');
        const characterIndex = blank.document.prompts.findIndex(prompt => prompt.marker === 'characters');
        expect(beforeIndex).toBeGreaterThanOrEqual(0);
        expect(beforeIndex).toBeLessThan(characterIndex);

        const builtInBeforeIndex = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.findIndex(prompt => prompt.marker === 'world_before');
        const builtInCharacterIndex = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.findIndex(prompt => prompt.marker === 'characters');
        expect(builtInBeforeIndex).toBeLessThan(builtInCharacterIndex);
    });

    it('会把旧预设中放错位置的角色设定前槽位纠正到角色资料之前', () => {
        const misplacedPreset: StoryTheaterPreset = {
            ...preset,
            document: {
                ...preset.document,
                prompts: [
                    { id: 'actor', name: '演员', enabled: true, role: 'user', content: '', marker: 'characters' },
                    { id: 'before', name: '设定前', enabled: true, role: 'user', content: '', marker: 'world_before' },
                ],
            },
        };
        const result = compileStoryPreset({
            preset: misplacedPreset,
            userName: '条条',
            characterNames: ['Noir'],
            slots: { actors: 'ACTOR_BLOCK', persona: '', scenario: '', worldBefore: 'WORLD_BEFORE_BLOCK', worldAfter: '', history: '' },
        });
        const contents = result.messages.map(message => message.content);
        expect(contents.indexOf('WORLD_BEFORE_BLOCK')).toBeLessThan(contents.indexOf('ACTOR_BLOCK'));
        expect(contents.filter(content => content === 'WORLD_BEFORE_BLOCK')).toHaveLength(1);
    });

    it('默认保留原生 assistant prefill，只有显式兼容时才由 user 收尾', () => {
        const prefill = { role: 'assistant' as const, content: '<scene_header>\n' };
        const nativePayload = appendStoryUserTurn([{ role: 'system', content: '规则' }], '继续', prefill);
        expect(nativePayload[nativePayload.length - 1]).toEqual(prefill);

        const compatiblePayload = appendStoryUserTurn([{ role: 'system', content: '规则' }], '继续', prefill, true);
        expect(compatiblePayload[compatiblePayload.length - 1]).toEqual({ role: 'user', content: '继续' });
        expect(compatiblePayload[compatiblePayload.length - 2]).toMatchObject({ role: 'system', content: expect.stringContaining('<scene_header>') });
        expect(buildStoryPrefillInstruction({ role: 'assistant', content: '<scene_header>\n' })).toEqual({
            role: 'system',
            content: expect.stringContaining('<scene_header>'),
        });
        expect(buildStoryPrefillInstruction(undefined)).toBeUndefined();
    });

    it('内置幕后与余波已合为同一发送条目并确实进入最终消息', () => {
        const backstage = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.find(prompt => prompt.id === 'nmj-v48-backstage');
        const legacyDebts = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.find(prompt => prompt.id === 'nmj-v61-shot-debts');
        expect(backstage?.enabled).toBe(true);
        expect(backstage?.name).toContain('幕后与余波');
        expect(backstage?.content).toContain('<backstage>');
        expect(backstage?.content).toContain('<shot_debts>');
        expect(legacyDebts?.enabled).toBe(false);
        const result = compileStoryPreset({
            preset: BUILTIN_NIGHT_SCREENING_PRESET,
            userName: '条条',
            characterNames: ['Noir'],
            slots: { actors: '演员', persona: '用户', scenario: '剧情', worldBefore: '', worldAfter: '', history: '' },
        });
        const payload = result.messages.map(message => message.content).join('\n');
        const preflight = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.find(prompt => prompt.id === 'nmj-v616-silent-preflight')!;
        expect(preflight.enabled).toBe(true);
        expect(payload).toContain('正文前静默完成一次排片检查');
        expect(payload).toContain('呈现合同：人称、条条 执笔权');
        expect(payload).toContain('依照当前启用的人称模式书写的故事正文');
        expect(payload).toContain('true_monologue 只在人物自我解释产生真正裂口时稀有掉落');
        expect(payload).toContain('紧接 </backstage> 后，收录一至三笔');
        expect(payload).toContain('本轮没有真实镜头债时，仅保留空标题并闭合');
        expect(buildStoryBackstageAftermathReminder(BUILTIN_NIGHT_SCREENING_PRESET.document)).toContain('界面只显示一个“幕后与余波”折叠区');
    });
});

describe('剧情沙盒辅助逻辑', () => {
    it('allows an existing character mask to start a solo fictional story, but rejects empty or missing participants', () => {
        const entry = { ...createStoryTheaterDraft(), writesToCharacterMemory: false, characterIds: [], mask: { type: 'character' as const, id: 'solo' } };
        const characters = [{ id: 'solo', name: '独白角色' }] as CharacterProfile[];
        expect(hasStoryTheaterParticipant(entry, characters)).toBe(true);
        expect(hasStoryTheaterParticipant(entry, [])).toBe(false);
        expect(hasStoryTheaterParticipant({ ...entry, mask: { type: 'user' } }, characters)).toBe(false);
        expect(hasStoryTheaterParticipant({ ...entry, writesToCharacterMemory: true }, characters)).toBe(false);
        expect(hasStoryTheaterParticipant({ ...entry, mask: { type: 'user' }, characterIds: ['solo'] }, characters)).toBe(true);
    });
    it('新虚构剧场默认不读取记忆，真实陪伴强制摘下面具', () => {
        expect(createStoryTheaterDraft(1)).toMatchObject({ openingMode: 'user', writesToCharacterMemory: false, carryCharacterMemory: false, forceUserLastMessage: false, omitSamplingParams: false });
        const normalized = normalizeStoryTheater({
            ...createStoryTheaterDraft(1),
            openingMode: 'assistant',
            mask: { type: 'character', id: 'a' },
            writesToCharacterMemory: true,
            carryCharacterMemory: false,
        });
        expect(normalized.openingMode).toBe('assistant');
        expect(normalized.omitSamplingParams).toBe(false);
        expect(normalized.mask).toEqual({ type: 'user' });
        expect(normalized.carryCharacterMemory).toBe(true);
        const legacyFictional = normalizeStoryTheater({
            ...createStoryTheaterDraft(1),
            writesToCharacterMemory: false,
            carryCharacterMemory: undefined as unknown as boolean,
        });
        expect(legacyFictional.carryCharacterMemory).toBe(false);
        expect(REAL_COMPANION_MEMORY_GUARD).toContain('不得捏造两人曾经发生过的经历');
        expect(REAL_COMPANION_MEMORY_GUARD).toContain('不得添油加醋');
    });

    it('按世界书 id 去重且不修改角色挂载', () => {
        const first = { id: 'a', title: 'A', content: '一', category: '共同' };
        const duplicate = { id: 'a', title: 'A copy', content: '二', category: '共同' };
        const chars = [
            { id: 'c1', name: '一', mountedWorldbooks: [first] },
            { id: 'c2', name: '二', mountedWorldbooks: [duplicate, { id: 'b', title: 'B', content: '三', category: '共同' }] },
        ] as CharacterProfile[];
        const result = dedupeTheaterWorldbooks(chars);
        expect(result.map(book => book.id)).toEqual(['a', 'b']);
        expect(chars[1].mountedWorldbooks).toHaveLength(2);
    });

    it('不会把不同世界书文件里 sourceUid 相同的条目误判成同一本', () => {
        const chars = [
            { id: 'c1', name: '一', mountedWorldbooks: [{ id: 'a', title: 'A', content: '一', category: '甲', sourceUid: 0 }] },
            { id: 'c2', name: '二', mountedWorldbooks: [{ id: 'b', title: 'B', content: '二', category: '乙', sourceUid: 0 }] },
        ] as CharacterProfile[];

        expect(dedupeTheaterWorldbooks(chars).map(book => book.id).sort()).toEqual(['a', 'b']);
    });

    it('用当前轮输入立即触发关键词世界书，并保持最多二十条扫描窗口', () => {
        const history = Array.from({ length: 25 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `旧消息 ${index}` }));
        const scanMessages = buildStoryWorldbookScanMessages(history, '我现在肘击他');
        const payload = ContextBuilder.buildWorldbookRequest({ books: [{
            id: 'elbow',
            title: '肘击规则',
            content: '触发成功',
            category: '测试',
            key: ['肘击'],
            constant: false,
            position: 1,
        }], history: scanMessages.map(message => ({ role: message.role || 'user', content: message.content })), userName: '条条', charName: '苏利',
            render: slots => [{ role: 'system', content: slots.before + slots.after }],
        });

        expect(scanMessages).toHaveLength(20);
        expect(scanMessages.at(-1)).toEqual({ role: 'user', content: '我现在肘击他' });
        expect(JSON.stringify(payload)).toContain('触发成功');
    });

    it('把同一正文映射到每位角色自己的时间锚点', () => {
        const createdAt = new Date('2026-08-01T10:00:00Z').getTime();
        const output = storyTimelineTimestampForCharacter({
            id: 's', title: 't', premise: '', characterIds: ['a'], writesToCharacterMemory: true,
            characterMemoryDates: { a: '2020-01-02T03:04' }, carryCharacterMemory: true,
            characterContextLimits: {}, archiveAfter: 40, archiveStrategy: 'summary', archives: [],
            selectedWorldbookIds: [], createdAt, updatedAt: createdAt,
        }, 'a', createdAt + 5000);
        expect(output).toBe(new Date('2020-01-02T03:04').getTime() + 5000);
    });

    it('角色面具不会重复出演，但会加入共享记忆接收者', () => {
        const entry = {
            id: 's', title: 't', premise: '', mask: { type: 'character' as const, id: 'a' }, characterIds: ['b'],
            writesToCharacterMemory: true, characterMemoryDates: {}, carryCharacterMemory: true,
            characterContextLimits: {}, archiveAfter: 40, archiveStrategy: 'summary' as const, archives: [],
            selectedWorldbookIds: [], createdAt: 1, updatedAt: 1,
        };
        expect(storyTheaterMemoryRecipientIds(entry)).toEqual(['b', 'a']);
        const mask = resolveStoryTheaterMask(entry.mask, { name: '用户' } as UserProfile, [{ id: 'a', name: '林星', systemPrompt: '冷静', worldview: '雨城' } as CharacterProfile], []);
        expect(mask).toMatchObject({ name: '林星', characterId: 'a', coreInstruction: '冷静', worldview: '雨城' });
    });

    it('仅在最后一条是用户推进时提供中断续跑输入', () => {
        const userMessage = { id: 1, charId: 'story', role: 'user', type: 'text', content: '推开那扇门', timestamp: 1, metadata: { source: 'story_theater' } } as any;
        const assistantMessage = { ...userMessage, id: 2, role: 'assistant', content: '门后亮起灯。' } as any;
        expect(getPendingStoryRetryInput([userMessage])).toBe('推开那扇门');
        expect(getPendingStoryRetryInput([userMessage, assistantMessage])).toBe('');
        expect(getPendingStoryRetryInput([{ ...userMessage, metadata: { ...userMessage.metadata, theaterArchived: true } }])).toBe('');
    });

    it('旧剧情默认保留最近五层，并按归档阈值约束用户设置', () => {
        const legacy = { ...createStoryTheaterDraft(1), archiveAfter: 40, archiveKeepRecent: undefined };
        expect(normalizeStoryTheater(legacy).archiveKeepRecent).toBe(5);
        expect(normalizeStoryTheater({ ...legacy, archiveAfter: 4, archiveKeepRecent: 99 }).archiveKeepRecent).toBe(3);
    });

    it('回复落地后只归档最旧部分，并且不会拆散一轮对话', () => {
        const rows = Array.from({ length: 40 }, (_, index) => ({
            id: index + 1,
            charId: 'story',
            role: index % 2 === 0 ? 'user' : 'assistant',
            type: 'text',
            content: String(index + 1),
            timestamp: index + 1,
            metadata: { source: 'story_theater' },
        } as Message));
        const batch = selectStoryArchiveBatch(rows, 40, 5);
        expect(batch).toHaveLength(34);
        expect(batch.at(-1)?.role).toBe('assistant');
        expect(rows.slice(batch.length)).toHaveLength(6);
        expect(selectStoryArchiveBatch(rows.slice(0, 39), 40, 5)).toEqual([]);
    });
});

describe('剧场输出展示解析', () => {
    it('隐藏协议标签并拆成可读区块', () => {
        const blocks = parseStoryDisplayBlocks([
            '<scene_header><time>深夜</time><place>客厅</place></scene_header>',
            '<story_text>林星把手机扣在桌上。</story_text>',
            '<backstage><mind_weather><owner>林星</owner><surface>松了一口气</surface><undertow>仍在紧张</undertow></mind_weather></backstage>',
            '<world_line><world_line_title>小喇叭</world_line_title><world_event>冰箱响了一声。</world_event></world_line>',
            '<shot_debts><debt><origin>迟疑</origin><unpaid>真相未说</unpaid><trigger>下次见面</trigger></debt></shot_debts>',
        ].join('\n'));
        expect(blocks.map(block => block.kind)).toEqual(['scene', 'story', 'backstage', 'worldline', 'debts']);
        const visible = blocks.map(block => block.text).join('\n');
        expect(visible).toContain('表层反应：松了一口气');
        expect(visible).toContain('尚未偿还：真相未说');
        expect(visible).not.toMatch(/<\/?[a-z_]+/i);
    });

    it('未知或未闭合标签也不会原样暴露', () => {
        const visible = parseStoryDisplayBlocks('<odd_box>正文<broken>余波 &lt;surface&gt;编码标签&lt;/surface&gt;').map(block => block.text).join('\n');
        expect(visible).toContain('正文');
        expect(visible).toContain('余波');
        expect(visible).not.toContain('<');
    });

    it('旧版关系温度仍只展示原先允许的角色侧记录', () => {
        const visible = parseStoryDisplayBlocks('<affinity_panel><c_score>62</c_score><c_delta>+2</c_delta><c_note>他主动留下</c_note><u_score>77</u_score><u_delta>-3</u_delta><u_note>用户自己的说明</u_note><relation_note>仍有余温</relation_note><relation_fragment>他把门留了一条缝。</relation_fragment></affinity_panel>')
            .map(block => block.text)
            .join('\n');
        expect(visible).toContain('关系温度：62');
        expect(visible).toContain('本轮变化：+2');
        expect(visible).toContain('关系天气：仍有余温');
        expect(visible).toContain('关系碎片：他把门留了一条缝。');
        expect(visible).not.toContain('77');
        expect(visible).not.toContain('-3');
        expect(visible).not.toContain('用户自己的说明');
        expect(visible).not.toContain('面具');
    });

    it('新版多人关系面板把双向温度与五个维度转换为前端可读字段', () => {
        const visible = parseStoryDisplayBlocks('<affinity_panel><affinity_person><character_id>lin</character_id><character_name>林星</character_name><c_to_u_score>68</c_to_u_score><c_to_u_delta>+2</c_to_u_delta><c_to_u_note>她留下来听完了</c_to_u_note><u_to_c_score>74</u_to_c_score><u_to_c_delta>-1</u_to_c_delta><u_to_c_note>他仍在回避</u_to_c_note><awareness_state>未察觉</awareness_state><trust>71</trust><security>62</security><possessive_pull>55</possessive_pull><emotional_pressure>66</emotional_pressure><repair_will>80</repair_will><state_note>想靠近，又决定先把话说明白</state_note><relation_note>有余温，也有裂口</relation_note></affinity_person></affinity_panel>')
            .map(block => block.text)
            .join('\n');
        expect(visible).toContain('人物：林星');
        expect(visible).toContain('角色对你的温度：68');
        expect(visible).toContain('你对角色的温度：74');
        expect(visible).toContain('信任：71');
        expect(visible).toContain('安全感：62');
        expect(visible).toContain('占有拉力：55');
        expect(visible).toContain('情绪压强：66');
        expect(visible).toContain('修复意愿：80');
        expect(visible).not.toContain('<affinity_person>');
    });

    it('把小剧场的嵌套 name/text 合并为连续消息，而不是逐标签拆卡', () => {
        const block = parseStoryDisplayBlocks('<mini_theater><mt_title>内存粉碎机</mt_title><mt_system>系统后台：进程活跃</mt_system><mt_ai><name>系统合规模块</name><text>检测到异常。</text></mt_ai><mt_user><name>Noir</name><text>闭嘴。</text></mt_user></mini_theater>')[0];
        expect(block.kind).toBe('theater');
        expect(block.theater).toEqual({
            title: '内存粉碎机',
            system: '系统后台：进程活跃',
            messages: [
                { side: 'left', name: '系统合规模块', text: '检测到异常。' },
                { side: 'right', name: 'Noir', text: '闭嘴。' },
            ],
        });
        expect(block.text).not.toContain('人物：');
        expect(block.text).not.toContain('右侧：');
    });

    it('容忍缺失消息闭合标签和未闭合的 mini_theater 外层', () => {
        const direct = parseStoryMiniTheater('<mt_title>故障频道</mt_title><mt_ai><name>AI</name><text>仍在运行</text><mt_user><name>Noir</name><text>停止。</text>');
        expect(direct.messages).toHaveLength(2);
        expect(direct.messages[1]).toMatchObject({ side: 'right', name: 'Noir', text: '停止。' });
        const block = parseStoryDisplayBlocks('正文。<mini_theater><mt_title>未闭合频道</mt_title><mt_ai><name>AI</name><text>收到</text>');
        expect(block.map(item => item.kind)).toEqual(['story', 'theater']);
        expect(block[1].theater?.messages[0].text).toBe('收到');
    });
});

describe('手机端预设分层', () => {
    it('默认版包含可关闭的小剧场区间', () => {
        const theater = STORY_PRESET_SIMPLE_CHOICES.find(choice => choice.label === '小剧场');
        expect(theater?.options[0]).toEqual({ label: '关闭' });
        expect(theater?.ids).toContain('nmj-v3-theater-ai');
        expect(theater?.ids).toContain('nmj-v6-side-channel-wrong-reel');
    });

    it('把 V6.27 合并为九个大区并锁定角色与世界', () => {
        const groups = getStoryPresetPromptGroups(BUILTIN_NIGHT_SCREENING_PRESET.document);
        expect(groups.map(group => group.key)).toEqual(['startup', 'input', 'sources', 'story', 'tone', 'camera', 'output', 'extras', 'exit']);
        expect(groups.find(group => group.key === 'sources')?.protected).toBe(true);
        const sourcePrompts = BUILTIN_NIGHT_SCREENING_PRESET.document.prompts.filter(prompt => groups.find(group => group.key === 'sources')?.promptIds.includes(prompt.id));
        expect(sourcePrompts.every(isProtectedStoryPrompt)).toBe(true);
    });

    it('默认选项会互斥切换且不触碰其它条目', () => {
        const document = BUILTIN_NIGHT_SCREENING_PRESET.document;
        const ids = ['nmj-v3-pov-second', 'nmj-v3-pov-third'];
        const next = applyStoryPresetChoice(document, ids, 'nmj-v3-pov-third');
        expect(next.prompts.find(prompt => prompt.id === 'nmj-v3-pov-second')?.enabled).toBe(false);
        expect(next.prompts.find(prompt => prompt.id === 'nmj-v3-pov-third')?.enabled).toBe(true);
        expect(next.prompts.find(prompt => prompt.id === 'nmj-v3-house-rules')?.enabled).toBe(true);
    });

    it('应用小剧场后会生成临近本轮输入的强制执行提示', () => {
        const choice = STORY_PRESET_SIMPLE_CHOICES.find(item => item.label === '小剧场')!;
        const document = applyStoryPresetChoice(BUILTIN_NIGHT_SCREENING_PRESET.document, choice.ids, 'nmj-v3-theater-ai');
        expect(getActiveStoryMiniTheaterPrompt(document)?.id).toBe('nmj-v3-theater-ai');
        const reminder = buildStoryMiniTheaterReminder(document, '条条', ['林星']);
        expect(reminder).toContain('本轮结尾模块');
        expect(reminder).toContain('不得因其它输出规则而省略');
        expect(reminder).toContain('不得把“… / ...');
        expect(reminder).toContain('<mt_ai><name>左侧显示名</name><text>完整消息</text></mt_ai>');
        expect(reminder).toContain('</mini_theater>');
        expect(reminder).not.toContain('{{user}}');
    });

    it('默认版暴露的每一种小剧场都能落到同一个可渲染协议', () => {
        const choice = STORY_PRESET_SIMPLE_CHOICES.find(item => item.label === '小剧场')!;
        for (const id of choice.ids) {
            const document = applyStoryPresetChoice(BUILTIN_NIGHT_SCREENING_PRESET.document, choice.ids, id);
            expect(getActiveStoryMiniTheaterPrompt(document)?.id).toBe(id);
            const reminder = buildStoryMiniTheaterReminder(document, '条条', ['林星', 'Noir']);
            expect(reminder).toContain('<mini_theater>');
            expect(reminder).toContain('<mt_title>');
            expect(reminder).toContain('<name>左侧显示名</name><text>完整消息</text>');
            expect(reminder).toContain('</mini_theater>');
        }
    });
});

describe('本轮关系备注', () => {
    it('只把填写内容附在模型输入里并转义用户文本', () => {
        const modelInput = appendStoryAffinityInput('推开门。', { delta: 4, reason: '因为他 <留下> & 等我' });
        expect(modelInput).toContain('<delta>+4</delta>');
        expect(modelInput).toContain('<reason>因为他 &lt;留下&gt; &amp; 等我</reason>');
        expect(modelInput).toContain('<awareness>unnoticed</awareness>');
        expect(appendStoryAffinityInput('推开门。', { delta: 0, reason: '' })).toBe('推开门。');
    });

    it('多人关系备注按角色分别发送并要求逐人输出双向五维面板', () => {
        const modelInput = appendStoryAffinityInputs('继续。', [
            { characterId: 'lin', characterName: '林星', delta: 2, reason: '他接住了话', awareness: 'noticed' },
            { characterId: 'noir', characterName: 'Noir', delta: -1, reason: '他又在回避', awareness: 'unnoticed' },
        ]);
        expect(modelInput).toContain('<u_affinity_updates>');
        expect(modelInput).toContain('<character_id>lin</character_id>');
        expect(modelInput).toContain('<character_id>noir</character_id>');
        expect(modelInput.match(/<u_affinity>/g)).toHaveLength(2);
        const guide = buildStoryMultiAffinityGuide([{ id: 'lin', name: '林星' }, { id: 'noir', name: 'Noir' }]);
        expect(guide).toContain('禁止共享数值');
        expect(guide).toContain('<affinity_person>');
        expect(guide).toContain('<character_name>角色名</character_name>');
        expect(guide).toContain('<c_to_u_score>50</c_to_u_score>');
        expect(guide).toContain('<trust>50</trust>');
        expect(guide).toContain('<repair_will>50</repair_will>');
        expect(guide).toContain('不得用某个角色的变化影响另一位角色');
    });

    it('第三人称最终锚点明确“你”属于用户侧，而不是生成回复的一方', () => {
        const thirdPerson = applyStoryPresetChoice(
            BUILTIN_NIGHT_SCREENING_PRESET.document,
            ['nmj-v3-pov-second', 'nmj-v3-pov-third'],
            'nmj-v3-pov-third',
        );
        const guard = buildStoryIdentityGuard(thirdPerson, '条条', ['林星', 'Noir']);
        expect(guard).toContain('用户侧剧情身份：条条');
        expect(guard).toContain('关系协议中的 U 只指「条条」');
        expect(guard).toContain('生成回复的一方不属于故事人物');
        expect(guard).toContain('旁白中的“你／你的”必须改掉');
        expect(guard).toContain('角色对白里对「条条」说“你”是正常称呼');
        expect(guard).toContain('剧场时间线锚点');
        expect(guard).toContain('推进剧情到X天后');
        expect(guard).toContain('不得覆盖本剧场的时间线');
    });

    it('已察觉要求角色在当幕自然反应，未察觉只保留氛围', () => {
        const noticed = buildStoryAffinityAwarenessReminder({ delta: 3, reason: '他留下来了', awareness: 'noticed' }, 'Noir');
        expect(noticed).toContain('角色完全透视');
        expect(noticed).toContain('Noir明确知道');
        expect(noticed).toContain('准确幅度');
        expect(noticed).toContain('必须给出一次');
        const unnoticed = buildStoryAffinityAwarenessReminder({ delta: -2, reason: '感到失望', awareness: 'unnoticed' }, 'Noir');
        expect(unnoticed).toContain('角色未察觉');
        expect(unnoticed).toContain('叙事氛围');
        expect(unnoticed).toContain('不覆盖用户对其他角色单独设置的察觉状态');
    });

    it('满值后保持数值底座，允许关系质地继续变化', () => {
        expect(RELATIONSHIP_TEXTURE_GUIDE).toContain('95—100');
        expect(RELATIONSHIP_TEXTURE_GUIDE).toContain('<relation_fragment>');
        expect(RELATIONSHIP_TEXTURE_GUIDE).toContain('不写散乱 Markdown');
    });

    it('绝对关系值由前端按上一轮加减 delta，纠正模型把 41 - 1 算成 42', () => {
        const previous = '<affinity_panel><affinity_person><character_id>lin</character_id><character_name>林星</character_name><c_to_u_score>60</c_to_u_score><u_to_c_score>41</u_to_c_score></affinity_person></affinity_panel>';
        const generated = '<affinity_panel><affinity_person><character_id>lin</character_id><character_name>林星</character_name><c_to_u_score>64</c_to_u_score><c_to_u_delta>+2</c_to_u_delta><u_to_c_score>42</u_to_c_score><u_to_c_delta>-1</u_to_c_delta></affinity_person></affinity_panel>';
        const reconciled = reconcileStoryAffinityScores(
            generated,
            previous,
            [{ characterId: 'lin', characterName: '林星', delta: -1, reason: '有些失望' }],
            [{ id: 'lin', name: '林星' }],
        );
        expect(reconciled).toContain('<c_to_u_score>62</c_to_u_score>');
        expect(reconciled).toContain('<u_to_c_score>40</u_to_c_score>');
        expect(reconciled).toContain('<u_to_c_delta>-1</u_to_c_delta>');
        expect(reconciled).not.toContain('<u_to_c_score>42</u_to_c_score>');
    });

    it('多人关系分别复算，未填写的角色保持上一轮 U→C', () => {
        const previous = '<affinity_panel><affinity_person><character_id>a</character_id><character_name>A</character_name><c_to_u_score>50</c_to_u_score><u_to_c_score>31</u_to_c_score></affinity_person><affinity_person><character_id>b</character_id><character_name>B</character_name><c_to_u_score>70</c_to_u_score><u_to_c_score>80</u_to_c_score></affinity_person></affinity_panel>';
        const generated = '<affinity_panel><affinity_person><character_id>a</character_id><character_name>A</character_name><c_to_u_score>49</c_to_u_score><c_to_u_delta>-2</c_to_u_delta><u_to_c_score>34</u_to_c_score><u_to_c_delta>+3</u_to_c_delta></affinity_person><affinity_person><character_id>b</character_id><character_name>B</character_name><c_to_u_score>72</c_to_u_score><c_to_u_delta>+1</c_to_u_delta><u_to_c_score>79</u_to_c_score><u_to_c_delta>-1</u_to_c_delta></affinity_person></affinity_panel>';
        const reconciled = reconcileStoryAffinityScores(
            generated,
            previous,
            [{ characterId: 'a', characterName: 'A', delta: 3, reason: '更信任了' }],
            [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
        );
        expect(reconciled).toContain('<c_to_u_score>48</c_to_u_score>');
        expect(reconciled).toContain('<u_to_c_score>34</u_to_c_score>');
        expect(reconciled).toContain('<c_to_u_score>71</c_to_u_score>');
        expect(reconciled).toContain('<u_to_c_score>80</u_to_c_score>');
        expect(reconciled).toContain('<u_to_c_delta>+0</u_to_c_delta>');
    });
});
