import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SongSheet } from '../types';
import { ContextBuilder } from './context';
import {
    buildLyricNotebookContext,
    extractGeneratedLyricLine,
    getLyricCoWritingStyle,
    LYRIC_CO_WRITING_STYLES,
    SongPrompts,
} from './songPrompts';

const makeSong = (overrides: Partial<SongSheet> = {}): SongSheet => ({
    id: 'song-1',
    title: '站台雨',
    genre: 'pop',
    mood: 'nostalgic',
    collaboratorId: 'char-1',
    lines: [],
    comments: [],
    status: 'draft',
    coverStyle: 'linen',
    createdAt: 1,
    lastActiveAt: 1,
    lyricTemplate: 'short-hook',
    lyricCoWritingStyle: 'adaptive',
    ...overrides,
});

describe('song lyric prompt context', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('shows every fixed-template slot, including blanks and stable line numbers', () => {
        const context = buildLyricNotebookContext(makeSong({
            lines: [{
                id: 'line-3',
                authorId: 'user',
                content: '雨停在旧站台',
                section: 'chorus',
                slotIndex: 2,
                timestamp: 2,
            }],
        }));

        expect(context).toContain('共12句，已填1句，空11句');
        expect(context).toContain('[第1段·副歌 1｜第1-4句｜每句建议6-10字]');
        expect(context).toContain('第1句（段内1/4）：〈待写〉');
        expect(context).toContain('第3句（段内3/4，6字，用户写）：雨停在旧站台');
        expect(context).toContain('[第3段·副歌 2｜第9-12句｜每句建议6-10字]');
    });

    it('uses the custom template rather than silently falling back to free writing', () => {
        const context = buildLyricNotebookContext(makeSong({
            lyricTemplate: 'custom',
            customLyricTemplate: [
                { section: 'intro', lines: 1, chars: '4-6' },
                { section: 'verse', lines: 2, chars: '8-10' },
            ],
        }));

        expect(context).toContain('共3句');
        expect(context).toContain('[第1段·前奏/引入｜第1-1句｜每句建议4-6字]');
        expect(context).toContain('[第2段·主歌｜第2-3句｜每句建议8-10字]');
    });

    it('injects the selected co-writing grammar into the system prompt', () => {
        vi.spyOn(ContextBuilder, 'buildCoreContext').mockReturnValue('CHARACTER CONTEXT');
        const song = makeSong({ lyricCoWritingStyle: 'vocaloid' });
        const prompt = SongPrompts.buildMentorSystemPrompt(
            { id: 'char-1', name: 'C' } as any,
            { name: 'U' } as any,
            song,
            [],
        );

        expect(prompt).toContain('C 的共创风格：Vocaloid');
        expect(prompt).toContain('数字/机械/身体错位等异色意象');
        expect(prompt).toContain('指定第几句时，只重写那一句');
        expect(prompt).toContain('只输出一个合法 JSON 对象');
    });

    it('keeps discussion separate from the notebook and states one current task', () => {
        const prompt = SongPrompts.buildUserMessage(makeSong({
            comments: [{
                id: 'comment-1',
                authorId: 'user',
                type: 'reaction',
                content: '副歌想更克制一点',
                timestamp: 3,
            }],
        }), '只生成第2句', 'chorus');

        expect(prompt).toContain('最近的讨论（仅作对话上下文，不等于歌词）');
        expect(prompt).toContain('用户：副歌想更克制一点');
        expect(prompt).toContain('【本轮唯一任务】\n只生成第2句');
    });

    it('anchors the completion note in the full character context instead of a generic mentor role', async () => {
        const char = { id: 'char-1', name: 'C', systemPrompt: 'CHARACTER CONTEXT WITH RELATIONSHIP' } as any;
        const user = { name: 'U' } as any;
        const systemPrompt = SongPrompts.buildCompletionSystemPrompt(char, user);
        const messages = (await ContextBuilder.buildCharacterRequest({ scene: 'apps.songwriting', char, user }, [
            { role: 'system', content: systemPrompt }, { role: 'user', content: '歌曲已完成' },
        ]));
        expect(JSON.stringify(messages)).toContain('CHARACTER CONTEXT WITH RELATIONSHIP');
        expect(systemPrompt).toContain('不是老师批作业、评委写鉴定');
        expect(systemPrompt).toContain('完整角色设定、你和U的关系、相处方式与既有记忆');
        expect(systemPrompt).toContain('不要使用“作为你的导师”');
    });

    it('keeps the completed song and recent collaboration in the user task', () => {
        const prompt = SongPrompts.buildCompletionPrompt(
            { id: 'char-1', name: 'C' } as any,
            { name: 'U' } as any,
            makeSong({
                lines: [{
                    id: 'line-1',
                    authorId: 'user',
                    content: '雨停在旧站台',
                    section: 'chorus',
                    slotIndex: 0,
                    timestamp: 2,
                }],
                comments: [{
                    id: 'comment-1',
                    authorId: 'char-1',
                    type: 'suggestion',
                    content: '副歌别急着把答案说完。',
                    timestamp: 3,
                }],
            }),
        );

        expect(prompt).toContain('雨停在旧站台');
        expect(prompt).toContain('C：副歌别急着把答案说完。');
        expect(prompt).toContain('直接以C的口吻对U说3-4句话');
        expect(prompt).not.toContain('你是C');
    });

    it('exposes a useful set of distinct co-writing styles', () => {
        expect(LYRIC_CO_WRITING_STYLES).toHaveLength(25);
        expect(new Set(LYRIC_CO_WRITING_STYLES.map(style => style.id)).size).toBe(25);
        expect(getLyricCoWritingStyle('jpop').prompt).toContain('日语翻译腔');
        expect(getLyricCoWritingStyle('kpop').prompt).toContain('Killing Part');
        expect(getLyricCoWritingStyle('hiphop').prompt).toContain('多音节双押或三押');
        expect(getLyricCoWritingStyle('anime-ed').category).toBe('acg');
        expect(getLyricCoWritingStyle('alt-pop').category).toBe('western');
    });

    it('does not overclaim melody-dependent tone matching', () => {
        expect(getLyricCoWritingStyle('cantopop').prompt).toContain('没有逐音旋律或音高走向');
        expect(getLyricCoWritingStyle('cantopop').prompt).toContain('不得声称已完成九声六调适配');
        expect(getLyricCoWritingStyle('guofeng').prompt).toContain('五声调式不直接决定汉字声调');
        expect(getLyricCoWritingStyle('vocaloid').prompt).toContain('不假定必须 180–220');
    });
});

describe('generated lyric response hardening', () => {
    it('extracts one lyric from a valid inspiration response', () => {
        expect(extractGeneratedLyricLine(JSON.stringify({
            type: 'inspiration',
            reaction: '这一句可以收紧。',
            example_lines: ['雨把站牌擦得很旧'],
            explanation: '承接上一句。',
        }))).toBe('雨把站牌擦得很旧');
    });

    it('recovers a lyric string from JSON truncated after example_lines', () => {
        const truncated = '{"type":"inspiration","reaction":"好","example_lines":["灯灭以后影子还醒着"],"explanation":"';
        expect(extractGeneratedLyricLine(truncated)).toBe('灯灭以后影子还醒着');
    });

    it('rejects JSON fragments before a lyric field instead of saving metadata', () => {
        expect(extractGeneratedLyricLine('{\n  "type": "inspiration",\n  "reaction":')).toBeNull();
        expect(extractGeneratedLyricLine('{"type":"inspiration","reaction":"让我想想"')).toBeNull();
    });

    it('accepts a plain one-line fallback but rejects explanations and multi-line prose', () => {
        expect(extractGeneratedLyricLine('“咖啡凉在没说完的清晨”')).toBe('咖啡凉在没说完的清晨');
        expect(extractGeneratedLyricLine('歌词：咖啡凉在没说完的清晨')).toBeNull();
        expect(extractGeneratedLyricLine('这句可以这样写：\n咖啡凉在没说完的清晨')).toBeNull();
    });

    it('rejects structured fields masquerading as a lyric candidate', () => {
        expect(extractGeneratedLyricLine(JSON.stringify({
            type: 'inspiration',
            content: '{"type":"inspiration","reaction":',
        }))).toBeNull();
        expect(extractGeneratedLyricLine(JSON.stringify({
            type: 'inspiration',
            example_lines: ['example_lines: ["并不存在的歌词"]'],
        }))).toBeNull();
    });
});
