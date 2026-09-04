import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message, UserProfile } from '../types';
import { normalizeMessageContent } from './messageFormat';
import {
    SAR_MODULE_AFTERGLOW_TURNS,
    alignSARChatSurfaceChunks,
    advanceSARModuleRuntime,
    buildSARModulePrompt,
    createSARModuleSurfaceMeta,
    getSARModuleRuntimePlan,
    installSARModuleOnCharacter,
    installSARModuleOnUser,
    isSARChatActionOnlyChunk,
    parseSARModuleReply,
    resolveSARModuleSpeechSource,
} from './vrWorld/sarModuleRuntime';
import { SAR_MODULE_CATALOG } from './vrWorld/sarModuleShop';

const module = SAR_MODULE_CATALOG[0];
const baseChar = { id: 'c1', name: '凯', vrState: { enabled: true, intervalMinutes: 120 } } as CharacterProfile;
const baseUser = { name: 'U', avatar: '', bio: '', vrState: { enabled: true } } as UserProfile;

describe('SAR module runtime', () => {
    it('uses 10 successful turns for character and 5 for user', () => {
        expect(installSARModuleOnCharacter(module, 1).remainingTurns).toBe(10);
        expect(installSARModuleOnUser(module, baseChar, 1).remainingTurns).toBe(5);
    });

    it('enters three-turn afterglow and then disappears', () => {
        let state = { ...installSARModuleOnCharacter(module, 1), remainingTurns: 1 };
        state = advanceSARModuleRuntime(state)!;
        expect(state.phase).toBe('afterglow');
        expect(state.afterglowTurns).toBe(SAR_MODULE_AFTERGLOW_TURNS);
        state = advanceSARModuleRuntime(state)!;
        expect(state.afterglowTurns).toBe(2);
        state = advanceSARModuleRuntime(state)!;
        expect(state.afterglowTurns).toBe(1);
        expect(advanceSARModuleRuntime(state)).toBeUndefined();
    });

    it('requests one response envelope and parses canonical separately from display pollution', () => {
        const runtime = installSARModuleOnCharacter(module, 1);
        const char = { ...baseChar, vrState: { ...baseChar.vrState!, sarModule: runtime } } as CharacterProfile;
        const plan = getSARModuleRuntimePlan(char, baseUser);
        const prompt = buildSARModulePrompt(char, baseUser, 'chat');
        expect(prompt).toContain('<SAR_MODULE_OUTPUT>');
        expect(prompt).toContain('能察觉的外来装置');
        expect(prompt).toContain('不能毫无察觉地照常聊天');
        expect(prompt).toContain('纯括号动作/旁白气泡必须原位逐字复制');
        const parsed = parseSARModuleReply(`
<SAR_MODULE_OUTPUT>
<CHAR_TRUE>这么晚了，你怎么还不睡？</CHAR_TRUE>
<CHAR_SURFACE>夜都深了，你怎么还不歇息？</CHAR_SURFACE>
<USER_SURFACE></USER_SURFACE>
</SAR_MODULE_OUTPUT>`, plan);
        expect(parsed.canonical).toBe('这么晚了，你怎么还不睡？');
        expect(parsed.assistantSurface).toBe('夜都深了，你怎么还不歇息？');
        expect(createSARModuleSurfaceMeta(runtime, parsed.assistantSurface!)).toMatchObject({
            canonicalField: 'content',
            surfaceField: 'metadata.sarModuleSurface.surface',
        });
    });

    it('falls back to raw canonical content when a model ignores the envelope', () => {
        const runtime = installSARModuleOnCharacter(module, 1);
        const char = { ...baseChar, vrState: { ...baseChar.vrState!, sarModule: runtime } } as CharacterProfile;
        const parsed = parseSARModuleReply('普通回复', getSARModuleRuntimePlan(char, baseUser));
        expect(parsed).toEqual({ canonical: '普通回复', enveloped: false });
    });

    it('keeps remembering and reacting after the first affected turn', () => {
        const runtime = advanceSARModuleRuntime(installSARModuleOnCharacter(module, 1))!;
        const char = { ...baseChar, vrState: { ...baseChar.vrState!, sarModule: runtime } } as CharacterProfile;
        const prompt = buildSARModulePrompt(char, baseUser, 'chat');
        expect(prompt).toContain('始终记得是U对自己使用了模块');
        expect(prompt).toContain('每轮都要在真实回应中留下至少一个');
        expect(prompt).toContain('不是冷冰冰的转换底稿');
    });

    it('does not let an omitted parenthesized action consume the next polluted speech bubble', () => {
        const canonical = [
            '（盯着屏幕看了两秒，尾巴重重拍了一下椅背。）',
            '算了——本专属大比格犬大人有大量，不跟你计较。',
            '我原本不是想这么说的。',
        ];
        const surfaceWithoutAction = [
            '罢了……本专属犬君宰相肚里能撑船，不与你计较。',
            '此言并非吾之本意。',
        ];
        expect(isSARChatActionOnlyChunk(canonical[0])).toBe(true);
        expect(alignSARChatSurfaceChunks(canonical, surfaceWithoutAction)).toEqual([
            undefined,
            surfaceWithoutAction[0],
            surfaceWithoutAction[1],
        ]);

        const copiedAction = ['（盯着屏幕看了两秒。）', ...surfaceWithoutAction];
        expect(alignSARChatSurfaceChunks(canonical, copiedAction)).toEqual([
            undefined,
            surfaceWithoutAction[0],
            surfaceWithoutAction[1],
        ]);
    });

    it('distinguishes bilingual/custom translations from standalone action bubbles', () => {
        expect(isSARChatActionOnlyChunk('（把杯子推到你手边。）')).toBe(true);
        expect(isSARChatActionOnlyChunk('（把杯子推到你手边。）\n%%BILINGUAL%%\n（Pushes the cup toward you.）')).toBe(true);
        expect(isSARChatActionOnlyChunk('もう知らない。（不管你了。）')).toBe(false);
        expect(isSARChatActionOnlyChunk('Stop that. (别闹了。)')).toBe(false);
    });

    it('uses the temporary surface as the TTS source without replacing canonical memory text', () => {
        const runtime = installSARModuleOnCharacter(module, 1);
        const message = {
            content: '<语音>你别闹。</语音><字幕>你别闹。</字幕>',
            metadata: {
                sarModuleSurface: createSARModuleSurfaceMeta(
                    runtime,
                    '<语音>阁下莫要胡闹。</语音><字幕>阁下莫要胡闹。</字幕>',
                ),
            },
        } as Pick<Message, 'content' | 'metadata'>;
        expect(resolveSARModuleSpeechSource(message)).toContain('阁下莫要胡闹');
        expect(message.content).toContain('你别闹');
    });

    it('lets Date rewrite the whole free-form user input while preserving actions and canonical meaning', () => {
        const userRuntime = installSARModuleOnUser(module, baseChar, 1);
        const user = { ...baseUser, vrState: { enabled: true, sarModule: userRuntime } } as UserProfile;
        const prompt = buildSARModulePrompt(baseChar, user, 'date');
        expect(prompt).toContain('用户本轮整段输入');
        expect(prompt).toContain('动作与事件含义必须保留');
        expect(prompt).toContain('<USER_SURFACE>');
        expect(prompt).toContain('真实意图、事实、行动、记忆与关系判断必须保持不变');
    });

    it('feeds summaries canonical content plus a temporary-surface guard, never the polluted display as truth', () => {
        const runtime = installSARModuleOnCharacter(module, 1);
        const message = {
            id: 1,
            charId: 'c1',
            role: 'assistant',
            type: 'text',
            timestamp: 1,
            content: '我其实很高兴见到你。',
            metadata: {
                sarModuleSurface: createSARModuleSurfaceMeta(runtime, '烦死了，谁想见你啊！'),
            },
        } as Message;
        const normalized = normalizeMessageContent(message, '凯', 'U');
        expect(normalized).toContain('我其实很高兴见到你。');
        expect(normalized).not.toContain('烦死了，谁想见你啊！');
        expect(normalized).toContain('不代表真实内心');
    });
});
