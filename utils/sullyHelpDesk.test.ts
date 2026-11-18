// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import FAQApp from '../apps/FAQApp';
import { SullyHelpCard } from '../components/chat/SullyHelpCard';
import { AppID } from '../types';
import { ChatParser } from './chatParser';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';
import { safeFetchJson } from './safeApi';
import { sanitizeForNotification, sanitizeIntoSegments } from './sanitize';
import { BUILTIN_SULLY_ID } from './sullyIdentity';
import { INSTALLED_APPS } from '../constants';
import { buildHelpDeskKnowledge } from './sullyHelpDesk';
import { CHAT_INPUT_PREFERENCES_KEY } from './chatInputPreferences';

const { openApp } = vi.hoisted(() => ({ openApp: vi.fn() }));
vi.mock('../context/OSContext', () => ({
    useOS: () => ({
        openApp, isDataLoaded: true, activeCharacterId: 'first',
        characters: [
            { id: 'first', name: '角色甲', systemPrompt: 'PRIVATE-PERSONA', memoryPalaceEnabled: true },
            { id: 'second', name: '角色乙', dialogueApi: { baseUrl: 'https://override.test', apiKey: 'PRIVATE-KEY', model: 'second-model' } },
        ],
        apiConfig: { baseUrl: 'https://example.test/v1', apiKey: 'test-key', model: 'test-model' },
        memoryPalaceConfig: { lightLLM: {}, embedding: {}, rerank: {} }, theme: {},
        realtimeConfig: { weatherCity: 'PRIVATE-CITY' },
    }),
}));
vi.mock('./safeApi', async importOriginal => ({
    ...await importOriginal<typeof import('./safeApi')>(), safeFetchJson: vi.fn(),
}));

it('grants the handoff prompt only to the builtin private chat, including existing renamed profiles', async () => {
    const build = (id: string, name: string) => ChatPrompts.buildSystemPromptParts(
        { id, name, avatar: '', systemPrompt: '自定义人设', description: '', memories: [] },
        { name: '用户', avatar: '', bio: '' }, [], [], [], [],
    );
    const builtin = (await build(BUILTIN_SULLY_ID, '改过名字')).stable;
    expect(builtin).toContain('自定义人设');
    expect(builtin).toContain('手抓糯米机');
    expect(builtin).toContain('可能需要糯米机答疑');
    expect(builtin).toContain('[[find11]]');
    expect(builtin).not.toContain('[[find]]');
    expect((await build('user-created', 'Sully')).stable).not.toContain('[[find11]]');
});

it.each([
    '[[find11]]', '[[find]]', '[[ find 11 ]]', '[ [ f i n d 1 1 ] ]',
    '［［ ＦＩＮＤ　１１ ］］', '【FiNd： 11】', '[find11]', '[[find11]', '[find11]]',
    '[[find11', '[[ f i\nn d 1\n1 ]]', 'FIND11', 'find 11]]',
])('accepts %s in local chat, cloud delivery and notification previews', async command => {
    const text = '我叫 11 号来。\n' + command;
    const preview = '[糯米机答疑 · Sully-11]';
    expect(sanitizeForNotification(text)).toContain(preview);
    expect(sanitizeIntoSegments(text + '\n[[find11]]')).toEqual([
        { raw: '我叫 11 号来。', sanitized: '我叫 11 号来。' },
        { raw: command, sanitized: preview },
    ]);
    const save = vi.spyOn(DB, 'saveMessage').mockResolvedValue(1);
    try {
        expect(await ChatParser.parseAndExecuteActions(text + '\n[[find11]]', BUILTIN_SULLY_ID, '改过名字', vi.fn())).toBe('我叫 11 号来。');
        await ChatParser.parseAndExecuteActions(text, 'user-created', 'Sully', vi.fn());
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith(expect.objectContaining({ charId: BUILTIN_SULLY_ID, type: 'sully_help_card' }));
    } finally { save.mockRestore(); }
});

it.each(['11 号在吗？', 'I can find 11 things.', '说明里写了 find11 这个词。',
    '[[find110]]', '[find 1]', '[[find11号]]', '[find]', 'find', '[[search11]]',
])('keeps ordinary text and unrelated tokens inert: %s', async text => {
    const save = vi.spyOn(DB, 'saveMessage').mockResolvedValue(1);
    try {
        expect(await ChatParser.parseAndExecuteActions(text, BUILTIN_SULLY_ID, 'Sully', vi.fn())).toBe(text);
        expect(save).not.toHaveBeenCalled();
        expect(sanitizeForNotification(text)).not.toContain('糯米机答疑');
        expect(sanitizeIntoSegments(text).some(segment => segment.sanitized.includes('糯米机答疑'))).toBe(false);
    } finally { save.mockRestore(); }
});

it('can retrieve operations for each registered app and keep a short follow-up on topic', () => {
    const lookup = buildHelpDeskKnowledge([], []);
    for (const app of INSTALLED_APPS) {
        expect(lookup([{ role: 'user', content: app.name }]), app.name).toContain('【' + app.name + '】');
    }
    const text = lookup([{ role: 'user', content: '为什么他不记得？' }, { role: 'user', content: '那我该去哪里看？' }]);
    expect(text).toContain('【记忆宫殿】');
    expect(text).toContain('小眼睛');
    expect(text).not.toContain('【音乐】');
    expect(lookup([{ role: 'user', content: '卡片没出来，指令原样显示' }])).toContain('【掉格式】');
    expect(lookup([{ role: 'user', content: '我想知道怎么放一首歌' }])).toContain('【音乐】');
});

it.each([
    ['只有角色卡的截图能导入吗', '神经链接', '原始 PNG'],
    ['明明聊过，那个月的小眼睛关掉还有月度总结吗', '记忆宫殿', '月度精炼常驻'],
    ['收藏一整段对话，原话删了还能翻吗', 'Message', '仍能读快照'],
    ['通话挂起和重新拨号有什么区别', '电话', '再拨号会新开一通'],
    ['为什么群员按顺序发言，后面的人知道前面说了啥吗', '群聊', '后面的人能接上本轮前面的发言'],
    ['怎么换房间中央小人的立绘', '小小窝', '透明立绘'],
    ['用 TA 的手机活一次，怎么继续上次的进度', '查手机', '生成即归档'],
    ['怎么把微博关注流刷到更早的帖子', '哔哔', '加载更多'],
    ['我临时走开了，怎么回到约会现场', '见面', '见面中'],
    ['只想在一个角色面前换头像和身份', '档案', '在 TA 面前的我'],
    ['去年的流水也能一起导出 CSV 吗', '存钱罐', '「全部」'],
    ['保存了自己的日记，TA 怎么还没写另一页', '交换日记', '写好后点交换'],
    ['马甲发的推荐帖可以分享到群里吗', 'Spark', '目标聊天收到社交卡片'],
    ['教材 PDF 扫描件里面只有图片怎么上课', '自习室', 'OCR'],
    ['能不能出试卷，交卷后再问以前做错的题', '自习室', '练习册里可翻旧卷'],
    ['D20 怎么决定玩家行动？想回退这一段', 'TRPG', '重新推演'],
    ['共写的小说要怎么把几个章节发给另一个人', '笔友会', '历史章节多选'],
    ['歌词已经写完了，怎么变成音频放到音乐专辑', '写歌', '成功后自动加入音乐 App'],
    ['移除书籍分类会把书和批注一起删了吗', '彼方', '书移回未分类、批注保留'],
    ['已经完成的待办没看到监督人的评价', '时光契约', '完成履历'],
    ['调插入深度，为什么关键词还是没触发', '世界书', '不会增加关键词扫描范围'],
    ['热榜能看新闻原文吗', '热点', '带原文链接'],
    ['怎么找客服查另一个角色的设置', '使用帮助', '选择排查角色'],
    ['我收藏过的图片算备份么，还能让他点评照片吗', '相册', '保存原图引用'],
    ['如何把真实账号之前的帖子认领到这个角色', '自由活动', '从真实账号认领旧帖子'],
    ['囤图可以传本地文件还是要发图片链接', '小红书图库', 'HTTP(S) 图片链接'],
    ['领来的美化分享码怎么只给一个角色用', '外观', '核对应用角色'],
    ['换设备怎么用 WebDAV 恢复个人备份', '设置', '先测试连接'],
    ['我设置了三个不同好感度的选项，到底谁来选', '攻略本', '角色根据性格选择一项'],
    ['城市里点了吃瓜围观会浪费一个回合吗', '都市人生', '围观会推进一轮'],
    ['七道默契题做完还能重看答卷吗', '特别时光', '结果页可回顾答卷'],
    ['歌词总是比歌声慢，怎么单独调这一首', '音乐', '歌词对轴'],
    ['PSD 的图层怎么分成部件', '捏脸·开发', '顶层组对应类目'],
])('finds the workflow behind “%s”', (question, chapter, detail) => {
    const result = buildHelpDeskKnowledge([], [])([{ role: 'user', content: question }]);
    const pages = result.split(/^【/m).slice(2);
    expect(pages.length).toBeLessThanOrEqual(4);
    expect(pages.find(page => page.startsWith(chapter + '】'))).toContain(detail);
    expect(result).not.toContain('核对：');
});

it('switches workflows when a new question names a different operation', () => {
    const result = buildHelpDeskKnowledge([], [])([
        { role: 'user', content: '扫描件怎么出试卷？' },
        { role: 'assistant', content: '先识别 PDF 的文字。' },
        { role: 'user', content: '给三个选项设好感度是我选还是他选？' },
    ]);
    expect(result).toContain('【攻略本】');
    expect(result).not.toContain('【自习室】');
});

it('opens the help tab from chat, uses the handbook for follow-ups, and keeps a failed question for retry', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const transport = vi.mocked(safeFetchJson);
    transport.mockResolvedValueOnce({ choices: [{ message: { content: '<think>internal</think>点闪电按钮。' } }] });
    const submit = async (text: string) => {
        const nextCall = transport.mock.calls.length + 1;
        const field = host.querySelector('textarea')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => {
            host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(nextCall));
        });
    };
    try {
        await act(async () => root.render(React.createElement(SullyHelpCard)));
        await act(async () => host.querySelector('button')!.click());
        expect(openApp).toHaveBeenCalledWith(AppID.FAQ);
        await act(async () => root.render(React.createElement(FAQApp)));
        expect(host.querySelector('[aria-pressed="true"]')?.textContent).toContain('问 Sully-11');
        expect(transport).not.toHaveBeenCalled();
        await submit('发完消息怎么让角色回复？');
        const [url, init, , , meta] = transport.mock.calls[0];
        expect(url).toBe('https://example.test/v1/chat/completions');
        const { messages } = JSON.parse(String(init.body));
        expect(messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
        expect(messages[0].content).toContain('工号 11');
        expect(messages[0].content).toContain('闪电按钮');
        expect(messages[0].content).toContain('【Message】');
        expect(messages[0].content).toContain('"记忆宫殿":true');
        expect(messages[0].content).toContain('"自动回复":false');
        expect(messages[0].content).toContain('test-model');
        expect(messages[0].content).not.toMatch(/PRIVATE-|角色乙|second-model|example\.test/);
        expect(messages[0].content).not.toContain('test-key');
        expect(meta).toMatchObject({ appId: 'faq', charName: 'Sully-11' });
        expect(host.querySelector('[role="log"]')?.textContent).toContain('点闪电按钮。');
        expect(host.querySelector('[role="log"]')?.textContent).not.toContain('internal');
        const tab = (label: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === label)!;
        await act(async () => tab('常见问题').click());
        await act(async () => tab('问 Sully-11').click());
        localStorage.setItem(CHAT_INPUT_PREFERENCES_KEY, JSON.stringify({ autoReply: true }));
        transport.mockRejectedValueOnce(new Error('连接失败'));
        await submit('闪电在哪？');
        expect(host.querySelector('textarea')?.value).toBe('闪电在哪？');
        expect(host.querySelector('[role="alert"]')?.textContent).toBe('连接失败');
        transport.mockResolvedValueOnce({ choices: [{ message: { content: '看顶部标题栏右边。' } }] });
        await submit('闪电在哪？');
        expect(JSON.parse(String(transport.mock.calls[2][1].body)).messages.slice(1)).toEqual([
            { role: 'user', content: '发完消息怎么让角色回复？' },
            { role: 'assistant', content: '点闪电按钮。' },
            { role: 'user', content: '闪电在哪？' },
        ]);
        expect(JSON.parse(String(transport.mock.calls[2][1].body)).messages[0].content).toContain('"自动回复":true');
        const select = host.querySelector('select')!;
        await act(async () => {
            select.value = 'second';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        transport.mockResolvedValueOnce({ choices: [{ message: { content: '你选中了角色独立 API。' } }] });
        await submit('我用的什么模型？');
        const second = JSON.parse(String(transport.mock.calls[3][1].body)).messages;
        expect(second).toHaveLength(2);
        expect(second[0].content).toContain('second-model');
        expect(second[0].content).toContain('"自动回复":true');
        expect(second[0].content).not.toMatch(/PRIVATE-|override\.test/);
    } finally {
        localStorage.removeItem(CHAT_INPUT_PREFERENCES_KEY);
        await act(async () => root.unmount());
        host.remove();
    }
});
