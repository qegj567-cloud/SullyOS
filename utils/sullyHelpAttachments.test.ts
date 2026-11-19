import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHelpFile, prepareHelpImages, HelpImageError } from './sullyHelpAttachments';
import { askSullyHelpDesk, automaticScope, buildHelpDeskKnowledge, type HelpDeskMessage } from './sullyHelpDesk';
import { selectHelpDeskContext } from './sullyHelpHistory';
import { safeFetchJson } from './safeApi';
import { VISION_API_TEST_IMAGE_DATA_URL } from './visionApi';

vi.mock('./safeApi', async original => ({ ...await original<typeof import('./safeApi')>(), safeFetchJson: vi.fn() }));
vi.mock('./context', () => ({ ContextBuilder: { buildCharacterRequest: async (_: unknown, turns: unknown[]) => turns } }));
const image = { kind: 'image', name: '报错.png', url: VISION_API_TEST_IMAGE_DATA_URL } as const;
const records: HelpDeskMessage[] = [{ role: 'user', content: '哪里出错了？', attachment: image }];
const main = { baseUrl: 'https://main.test', apiKey: 'main-key', model: 'chat' };
const transport = vi.mocked(safeFetchJson);
const response = (content: string) => ({ choices: [{ message: { content } }] });
const ask = (config = main, textOnly = false) => askSullyHelpDesk(config, buildHelpDeskKnowledge([], []), records, null, new AbortController().signal, automaticScope, undefined, textOnly);
afterEach(() => vi.clearAllMocks());

describe('help desk attachments', () => {
    it('carries a bounded, previewable file excerpt and keeps sticker image data out of model input', async () => {
        const file = await readHelpFile(new File(['报错文字'.repeat(2000)], '报错.log', { type: 'text/plain' }));
        expect(file).toMatchObject({ kind: 'file', clipped: true });
        if (file.kind !== 'file') throw new Error('expected text');
        expect(file.text).toHaveLength(3000);
        const turns = selectHelpDeskContext([
            { role: 'user', content: '', attachment: file },
            { role: 'user', content: '', attachment: { ...image, kind: 'sticker', name: '歪头' } },
        ]);
        expect(turns[0].content).toContain('报错文字');
        expect(turns[1]).toEqual({ role: 'user', content: '[表情包：歪头]' });
        expect(JSON.stringify(turns)).not.toContain('data:image');
        const [longQuestion] = selectHelpDeskContext([{ role: 'user', content: '问'.repeat(3500), attachment: file }]);
        expect(longQuestion.content).toContain('[文件：报错.log]\n报错文字');
        expect(longQuestion.content.length).toBeLessThanOrEqual(3500);
        await expect(readHelpFile(new File(['abc'], 'file.zip'))).rejects.toThrow('支持 PNG');
    });

    it('sends recent unanswered images with their own caption and keeps older answered images local', async () => {
        const turns = selectHelpDeskContext([...records, { role: 'assistant', content: '上次答复' }, ...records, { role: 'user', content: '补充' }]);
        const prepared = await prepareHelpImages(turns, main, new AbortController().signal, false);
        expect(prepared.messages[0].content).toEqual(expect.any(String));
        expect(prepared.messages[2].content).toEqual([{ type: 'text', text: '哪里出错了？\n[图片：报错.png]' }, { type: 'image_url', image_url: { url: image.url } }]);
        expect(prepared.messages[3].content).toBe('补充');
    });

    it('offers text-only recovery for rejected images and preserves unrelated service errors', async () => {
        transport.mockRejectedValueOnce(new Error('Unsupported image input'));
        await expect(ask()).rejects.toThrow(HelpImageError);
        transport.mockResolvedValueOnce(response('请贴出报错文字'));
        await expect(ask(main, true)).resolves.toBe('请贴出报错文字');
        expect(String(transport.mock.calls[1][1].body)).not.toContain('data:image');
        transport.mockRejectedValueOnce(new Error('HTTP 429'));
        await expect(ask()).rejects.toThrow('HTTP 429');
    });

    it('uses the configured vision service once, including through a second manual lookup', async () => {
        transport.mockResolvedValueOnce(response('页面提示 Key 无效')).mockResolvedValueOnce(response('[[查手册: 1.1]]')).mockResolvedValueOnce(response('请核对 Key'));
        const config = { ...main, visionApi: { enabled: true, baseUrl: 'https://vision.test', model: 'vision', apiKey: 'vision-key' } };
        await expect(ask(config)).resolves.toBe('请核对 Key');
        expect(transport.mock.calls[0][0]).toContain('vision.test');
        expect(transport.mock.calls[0][4]?.appId).toBe('faq');
        for (const call of transport.mock.calls.slice(1)) {
            expect(call[0]).toContain('main.test');
            expect(String(call[1].body)).toContain('页面提示 Key 无效');
            expect(String(call[1].body)).not.toContain('data:image');
        }
        await expect(prepareHelpImages(records, { ...config, visionApi: { ...config.visionApi, apiKey: '' } }, new AbortController().signal, false)).rejects.toThrow('配置不完整');
    });
});
