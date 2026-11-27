import { beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { DB } from './db';
import { acceptRevision, loadRevisionTurn } from './chatTurnRevision';
import { previewTurnRevision } from './chatTurnGeneration';
import { safeFetchJson } from './safeApi';
import { loadCharacterContextMessages } from './chatContextRange';
import { exportUserSpaces, importUserSpaces } from './userSpaceBackup';
import { saveUserSpaces } from './userSpaces';
import type { Message } from '../types';

vi.mock('./safeApi', async importOriginal => ({
    ...await importOriginal<typeof import('./safeApi')>(), safeFetchJson: vi.fn(),
}));
const char = { id: 'calibration', name: '测试角色', systemPrompt: 'PRIVATE_PERSONA', avatar: '' } as any;
const user = { name: '测试用户', bio: 'PRIVATE_BIO', avatar: '' };
const settings = { char, userProfile: user, apiConfig: {baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture'},
    emojis: [{name: '抱抱', url: 'https://fixture.invalid/sticker.png'}], categories: [], groups: [],
    translationConfig: { enabled: true, sourceLang: '日语', targetLang: '中文' }};
const save = (role: Message['role'], content: string, metadata?: any) =>
    DB.saveMessage({ charId: char.id, role, type: 'text', content, metadata });
function model(content: string) {
    vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content }, finish_reason: 'stop' }] });
}
const run = (mode: 'format' | 'reroll', guidance = '') =>
    previewTurnRevision(settings, mode, guidance, new AbortController().signal);
beforeEach(async () => {
    vi.clearAllMocks();
    await DB.clearMessages(char.id);
    await DB.deleteAsset(`mp_hwm_v1_${char.id}`);
    await DB.saveCharacter(char);
    await DB.saveUserProfile(user);
    await save('user', 'PRIVATE_HISTORY');
});

describe('本轮校准', () => {
    it('只发送显示格式和本轮，采用后再存双语和表情，文字备份恢复只见定稿', async () => {
        saveUserSpaces([{ id: 'default', name: '测试用户' }]);
        const id = await save('assistant', '<原文>またね<译文>再见 [表情 抱抱]');
        await DB.saveAssetRaw(`voice_msg_${id}`, { originalText: '旧语音' });
        model(JSON.stringify({ edits: [{ index: 0, replacement: '<翻译><原文>またね</原文><译文>再见</译文></翻译>\n[[SEND_EMOJI: 抱抱]]' }] }));
        const draft = await run('format', '只修复标签');
        const request = JSON.parse(String(vi.mocked(safeFetchJson).mock.calls[0][1].body)).messages;
        expect(JSON.stringify(request)).not.toMatch(/PRIVATE_|sticker\.png/);
        expect(JSON.stringify(request)).toContain('只修复标签');
        expect((await DB.getMessageById(id))!.content).toContain('[表情 抱抱]');
        expect(await DB.getAssetRaw(`voice_msg_${id}`)).toBeTruthy();
        await acceptRevision(draft);
        expect(await DB.saveMessageVoiceIfCurrent(draft.originals[0], {originalText:'迟到的旧语音'})).toBe(false);
        expect(await DB.getAssetRaw(`voice_msg_${id}`)).toBeFalsy();
        const accepted = (await loadCharacterContextMessages(char)).slice(-2);
        expect(accepted.map(m => [m.type, m.content])).toEqual([
            ['text', 'またね\n%%BILINGUAL%%\n再见'], ['emoji', settings.emojis[0].url]]);
        const zip = await JSZip.loadAsync(await (await exportUserSpaces('text_only', 'current')).arrayBuffer());
        await DB.updateMessage(id, '模拟清空');
        await importUserSpaces(zip);
        expect((await DB.getMessageById(id))?.content).toBe(accepted[0].content);
        expect((await DB.getMessageById(accepted[1].id))?.metadata?.stickerName).toBe('抱抱');
    });

    it('重写读到上一条用户输入和方向，旧回复、方向和候选都不追加到聊天', async () => {
        const oldId = await save('assistant', 'DISCARDED_ORIGINAL');
        model('候选第一句\n候选第二句');
        const preview = await run('reroll', '解释告别的原因');
        const calls = vi.mocked(safeFetchJson).mock.calls;
        const request = String(calls[calls.length-1][1].body);
        expect(request).toContain('PRIVATE_HISTORY');
        expect(request).toContain('解释告别的原因');
        const messages = JSON.parse(request).messages;
        expect(JSON.stringify(messages.slice(0, -1))).not.toContain('DISCARDED_ORIGINAL');
        expect(messages.at(-1).content).toContain('DISCARDED_ORIGINAL');
        expect(messages.at(-1).content).toContain('用户对新版的期望');
        expect((await loadRevisionTurn(char.id)).map(m => m.content)).toEqual(['DISCARDED_ORIGINAL']);
        await acceptRevision(preview);
        expect(await DB.getMessageById(oldId)).toBeNull();
        expect((await loadCharacterContextMessages(char)).map(m => m.content)).toEqual(['PRIVATE_HISTORY', '候选第一句', '候选第二句']);
    });

    it('单句重写只更新选中的气泡，保留相邻气泡和语音', async () => {
        const first = await save('assistant', '第一句');
        const target = await save('assistant', '第二句');
        await DB.saveAssetRaw('voice_msg_' + first, { originalText: '第一句' });
        model('换一句');
        const preview = await previewTurnRevision(settings, 'reroll', '', new AbortController().signal, [target]);
        expect(await acceptRevision(preview)).toEqual([target]);
        expect((await loadRevisionTurn(char.id)).map(row => [row.id, row.content])).toEqual([[first, '第一句'], [target, '换一句']]);
        expect(await DB.getAssetRaw('voice_msg_' + first)).toBeTruthy();
    });

    it('多选按原顺序替换，跳过中间未选的消息', async () => {
        const first = await save('assistant', '一');
        const middle = await save('assistant', '二');
        const last = await save('assistant', '三');
        model('第一句新版\n第三句新版');
        const preview = await previewTurnRevision(settings, 'reroll', '', new AbortController().signal, [last, first]);
        const prompt = JSON.parse(String(vi.mocked(safeFetchJson).mock.calls.at(-1)![1].body)).messages.at(-1).content;
        expect(prompt).toContain('只替换第 1、3 个气泡');
        expect(prompt).toContain('自行判断');
        expect(await acceptRevision(preview)).toEqual([first, last]);
        expect((await loadRevisionTurn(char.id)).map(row => [row.id, row.content])).toEqual([
            [first, '第一句新版'], [middle, '二'], [last, '第三句新版'],
        ]);
    });

    it.each(['new message', 'edit', 'archive'] as const)('refuses stale preview after %s', async change => {
        const id = await save('assistant', '原版');
        const originals = await loadRevisionTurn(char.id);
        if (change === 'new message') await save('user', '下一轮');
        if (change === 'edit') await DB.updateMessage(id, '其他窗口的修改');
        if (change === 'archive') await DB.saveAssetRaw(`mp_hwm_v1_${char.id}`, { msgId: id });
        await expect(acceptRevision({originals, mode:'reroll', bubbles:[{type:'text',content:'过期候选'}]})).rejects.toThrow(/变化|归档/);
        expect((await DB.getMessageById(id))?.content).not.toBe('过期候选');
    });
    it('isolates adjacent runs and keeps every cloud delivery receipt when bubbles collapse', async () => {
        await save('assistant', '另一轮', { chatTurnId: 'old' });
        const receipts = ['msg_task_1@89_hook_0', 'msg_task_1@89_hook_1'];
        for (const messageId of receipts) await save('assistant', '这轮', { source: 'active_msg_2', activeMsg2: {messageId} });
        const originals = await loadRevisionTurn(char.id);
        expect(originals).toHaveLength(2);
        await acceptRevision({originals, mode:'reroll', bubbles:[{type:'text',content:'新版'}]});
        expect(await DB.findPersistedActiveMessageIds(char.id, receipts)).toEqual(new Set(receipts));
    });
    it('clears pure prompt leakage and still acknowledges a replayed cloud chunk', async () => {
        const messageId = 'msg_task_2@103_hook_0';
        await save('assistant', '<schedule>后台排程提示</schedule>', {activeMsg2: {messageId}});
        model('{"edits":[{"index":0,"replacement":""}]}');
        const result = await run('format');
        expect(result.bubbles).toEqual([]);
        await acceptRevision(result);
        expect((await loadCharacterContextMessages(char)).map(row => row.role)).toEqual(['user']);
        expect(await DB.findPersistedActiveMessageIds(char.id, [messageId])).toEqual(new Set([messageId]));
    });
    it('rejects malformed patches without touching the source', async () => {
        const id = await save('assistant', '原版');
        model('{"edits":[{"index":2,"replacement":"越界"}]}');
        await expect(run('format')).rejects.toThrow('对应到原气泡');
        expect((await DB.getMessageById(id))?.content).toBe('原版');
    });
});


describe('校准不得开启日程或情绪', () => {
    const switches = (c: any) => ({ scheduleFeatureEnabled: c.scheduleFeatureEnabled, scheduleStyle: c.scheduleStyle, emotionConfig: c.emotionConfig });
    it.each([
        { scheduleFeatureEnabled: false, emotionConfig: { enabled: false } },
        { scheduleFeatureEnabled: false, scheduleStyle: '生活系', emotionConfig: { enabled: true } },
        { scheduleFeatureEnabled: true, scheduleStyle: '生活系', emotionConfig: { enabled: false } },
        { scheduleFeatureEnabled: false },
    ])('预览和采用保留原开关 %j', async configuration => {
        const original = { ...char, ...configuration };
        const before = structuredClone(original);
        await DB.saveCharacter(original);
        await save('assistant', '原回复');
        model('候选回复');
        const preview = await previewTurnRevision({ ...settings, char: original }, 'reroll', '', new AbortController().signal);
        expect(original).toEqual(before);
        expect(switches((await DB.getAllCharacters()).find(c => c.id === char.id))).toEqual(switches(before));
        await acceptRevision(preview);
        expect(switches((await DB.getAllCharacters()).find(c => c.id === char.id))).toEqual(switches(before));
    });
    it('采用旧预览不能覆盖预览期间关闭的开关', async () => {
        const enabled = { ...char, scheduleFeatureEnabled: true, emotionConfig: { enabled: true } };
        await DB.saveCharacter(enabled);
        await save('assistant', '原回复');
        model('候选回复');
        const preview = await previewTurnRevision({ ...settings, char: enabled }, 'reroll', '', new AbortController().signal);
        const disabled = { ...enabled, scheduleFeatureEnabled: false, emotionConfig: { enabled: false } };
        await DB.saveCharacter(disabled);
        await acceptRevision(preview);
        expect(switches((await DB.getAllCharacters()).find(c => c.id === char.id))).toEqual(switches(disabled));
    });
});


describe('校准重写遵守心象开关', () => {
    const reasoningResponse = () => vi.mocked(safeFetchJson).mockResolvedValue({ choices: [{ message: { content: '新版正文', reasoning_content: '不应泄漏的思考' }, finish_reason: 'stop' }] });
    it.each([false, undefined, true])('生成与落库遵守心象设置 %s', async enabled => {
        const role = { ...char, showThinkingChain: enabled };
        await DB.saveCharacter(role);
        await save('assistant', '原正文');
        reasoningResponse();
        const preview = await previewTurnRevision({ ...settings, char: role, thinkingChain: { enabled: !!enabled } }, 'reroll', '', new AbortController().signal);
        expect(preview.bubbles[0].metadata?.thinkingChain).toBe(enabled ? '不应泄漏的思考' : undefined);
        await acceptRevision(preview);
        const rows = await loadRevisionTurn(char.id);
        expect(rows[0].content).toBe('新版正文');
        expect(rows[0].metadata?.thinkingChain).toBe(enabled ? '不应泄漏的思考' : undefined);
        expect((await DB.getAllCharacters()).find(c => c.id === char.id)?.showThinkingChain).toBe(enabled);
    });
    it('预览后关闭心象，采用时不再存入候选心象', async () => {
        const role = { ...char, showThinkingChain: true };
        await DB.saveCharacter(role);
        await save('assistant', '原正文');
        reasoningResponse();
        const preview = await previewTurnRevision({ ...settings, char: role, thinkingChain: { enabled: true } }, 'reroll', '', new AbortController().signal);
        expect(preview.bubbles[0].metadata?.thinkingChain).toBeTruthy();
        await DB.saveCharacter({ ...role, showThinkingChain: false });
        await acceptRevision(preview);
        expect((await loadRevisionTurn(char.id))[0].metadata?.thinkingChain).toBeUndefined();
    });
});
