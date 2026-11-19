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
import { appendHelpRecord, CONSULTATION_IDLE_MS, currentConsultation, loadHelpHistory, newConsultation, rememberConsultation, selectHelpDeskContext, type HelpRecord } from './sullyHelpHistory';
import { askSullyHelpDesk, buildHelpDeskKnowledge, helpDeskCatalog, automaticScope, helpTopicLabel, isAvailableHelpScope } from './sullyHelpDesk';
import { CHAT_INPUT_PREFERENCES_KEY } from './chatInputPreferences';
import { MEMORY_PALACE_WATERLINE_PRESETS } from './memoryPalace/waterline';
import { EVENT_BOX_COMPRESSION_THRESHOLD, EVENT_BOX_SEAL_THRESHOLD } from './memoryPalace/types';

const { openApp } = vi.hoisted(() => ({ openApp: vi.fn() }));
vi.mock('../context/OSContext', () => ({
    useOS: () => ({
        openApp, isDataLoaded: true, activeCharacterId: 'first',
        characters: [
            { id: 'first', name: '角色甲', systemPrompt: 'PRIVATE-PERSONA', memoryPalaceEnabled: true },
            { id: 'second', name: '角色乙', dialogueApi: { baseUrl: 'https://override.test', apiKey: 'PRIVATE-KEY', model: 'second-model' } },
        ],
        apiConfig: { baseUrl: 'https://example.test/v1', apiKey: 'test-key', model: 'test-model' },
        memoryPalaceConfig: { lightLLM: {}, embedding: {}, rerank: { enabled: true, topN: 8 } }, theme: {},
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
    expect(builtin).toContain('一户一只');
    expect(builtin).toContain('11 号是你的同事，是另一只猫');
    expect(builtin).toContain('Sully-08 在 Discord（DC）陪大家玩');
    expect(builtin).toContain('Sully-09 负责维护社区');
    expect(builtin).toContain('Sully-10 是看大门的社区答题猫');
    expect(builtin).toContain('手抓糯米机');
    expect(builtin).toContain('可能需要糯米机答疑');
    expect(builtin).toContain('[[find11]]');
    expect(builtin).not.toContain('[[find]]');
    const namesake = (await build('user-created', 'Sully')).stable;
    expect(namesake).not.toContain('[[find11]]');
    expect(namesake).not.toContain('11 号是你的同事');
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
        expect(lookup([{ role: 'user', content: app.name }]), app.name).toContain('【' + helpTopicLabel(app.name) + '】');
    }
    const text = lookup([{ role: 'user', content: '为什么他不记得？' }, { role: 'user', content: '那我该去哪里看？' }]);
    expect(text).toContain('【记忆宫殿】');
    expect(text).toContain('小眼睛');
    expect(text).not.toContain('【音乐】');
    expect(lookup([{ role: 'user', content: '卡片没出来，指令原样显示' }])).toContain('【掉格式】');
    expect(lookup([{ role: 'user', content: '我想知道怎么放一首歌' }])).toContain('【音乐】');
});

it('keeps the saved Message topic and omits unreleased apps from selectable and readable material', () => {
    const lookup = buildHelpDeskKnowledge([], []);
    const chat = { category: 'app', topic: 'Message' } as const;
    expect(isAvailableHelpScope(chat)).toBe(true);
    expect(lookup([], chat)).toContain('当前咨询：Message（聊天）');
    const allIds = helpDeskCatalog.flatMap(page => page.areas.map(area => area.id));
    for (const topic of ['手账', 'QQ 桥', '模拟浏览器']) {
        const scope = { category: 'app', topic } as const;
        expect(isAvailableHelpScope(scope)).toBe(false);
        const reading = lookup.prepare([{ role: 'user', content: topic + '在哪开？' }], scope);
        expect(reading.prompt).toContain('当前咨询：自动找入口');
        expect(reading.prompt).not.toMatch(/手账|QQ\s*桥|模拟浏览器|NapCat|Brave 真实搜索/i);
        expect(reading.lookup(allIds.slice(-2)).prompt).not.toContain(topic);
    }
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
    ['怎么找客服查另一个角色的设置', '使用帮助', '「指定角色」→ 从名单里选一个角色'],
    ['我收藏过的图片算备份么，还能让他点评照片吗', '相册', '保存原图引用'],
    ['如何把真实账号之前的帖子认领到这个角色', '自由活动', '从真实账号认领旧帖子'],
    ['囤图可以传本地文件还是要发图片链接', '小红书图库', 'HTTP(S) 图片链接'],
    ['领来的美化分享码怎么只给一个角色用', '外观', '核对应用角色'],
    ['朋友给了我一个美化码，在哪里输', '外观', '导入装扮 → 用码领取'],
    ['我想要气泡下面的外挂字幕，在哪里调字的颜色', '掉格式', '字幕设置与预览'],
    ['怎么让这一个角色知道伦敦的天气', '实时感知', '按角色设置城市'],
    ['不想让他知道我家在哪，怎么把家隐藏起来', '实时感知', '把当前位置设为隐藏地点'],
    ['怎么让某一个角色换模型', '神经链接', '为角色使用独立 API'],
    ['自动回复的开关在哪', 'Message', '发完后自动生成回复'],
    ['同一个 API 地址怎么复制预设换模型', '设置', '保存副本'],
    ['表情包都裂了，在哪刷新清掉失效的？', 'Message', '清除失效表情'],
    ['我想给一个角色分配专属表情包，在哪开', 'Message', '设置可见角色'],
    ['角色能看到表情包的图吗，还是只看到名字', 'Message', '只传文字'],
    ['表情包怎么下载整个分类的动图原图？', 'Message', '下载分类全部原图'],
    ['表情包在本机存的是什么格式，图床挂了还能用吗？', 'Message', '原图字节'],
    ['全自动记忆在哪开', '记忆宫殿', '保存副 API 配置'],
    ['哪里可以手动安排明天的主动消息', '主动消息 2.0', '新建定时任务'],
    ['从其他网址迁入能单独放一个用户吗', '设置', '从其他网址 / App 迁入独立用户'],
    ['怎么把悬浮球找回来', '桌面', '悬浮球复位抢救'],
    ['我怎么把小说上传给彼方里的角色读', '彼方', '书库 → 上架'],
    ['群聊手动整理话题盒要点哪个按钮', '群聊', '立即整理当前可归档内容'],
    ['怎么把世界书挂到角色身上', '世界书', '扩展设定 (Worldbooks)'],
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
    expect(pages.find(page => page.startsWith(helpTopicLabel(chapter) + '】'))).toContain(detail);
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

it('gives the selected memory system current storage, reading and recall rules even on a short follow-up', () => {
    const lookup = buildHelpDeskKnowledge([], []);
    const scope = { category: 'system', topic: '角色记忆系统' } as const;
    const areas = helpDeskCatalog.find(page => page.title === scope.topic)!.areas;
    const text = areas.map(({ label }) => lookup([{ role: 'user', content: label }], scope)).join('\n');
    expect(text).toContain('【角色记忆系统】');
    for (const preset of Object.values(MEMORY_PALACE_WATERLINE_PRESETS)) {
        expect(text).toContain(preset.hotZoneSize + ' / ' + preset.bufferThreshold);
    }
    expect(text).toContain('整理最早 85 条');
    expect(text).toContain('这个月的日度详细条目');
    expect(text).toContain('无需再等 100 或 200 条新聊天');
    expect(text).toContain('最多 15 个名额');
    expect(text).toContain('额外名额默认 5，可设 1–20');
    expect(text).toContain('活跃片段达到 ' + EVENT_BOX_COMPRESSION_THRESHOLD + ' 条');
    expect(text).toContain('累计事件片段达到 ' + EVENT_BOX_SEAL_THRESHOLD + ' 条');
    expect(text).toContain('私聊「＋ → 记忆链接」');
    expect(text).not.toMatch(/finalScore|hybridSearch|pipeline\.ts/);
});

it('keeps the requested operation through consecutive short navigation questions', () => {
    const lookup = buildHelpDeskKnowledge([], []);
    const questions = ['小手机上美化分享码在哪里输？', '这个在哪开？', '然后呢？', '下一步点哪？'];
    for (let count = 2; count <= questions.length; count++) {
        const result = lookup(questions.slice(0, count).map(content => ({ role: 'user', content })));
        expect(result.split(/^【/m)[2]).toMatch(/^外观】[\s\S]*领取并载入预设/);
    }
});

it('opens from chat, looks up missing areas once, and resumes the same local questions after failure or reopening', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const transport = vi.mocked(safeFetchJson);
    const button = (name: string) => [...host.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent?.trim()) === name)!;
    const click = async (name: string) => act(async () => button(name).click());
    const observe = async (assert: () => void) => vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        assert();
    });
    const ask = async (value: string) => {
        await act(async () => {
            const field = host.querySelector('textarea')!;
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
            field.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const field = host.querySelector('textarea')!;
        for (const options of [{ isComposing: true }, { shiftKey: true }]) {
            const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });
            await act(async () => { field.dispatchEvent(key); });
            expect(key.defaultPrevented).toBe(false);
            expect(field.value).toBe(value);
        }
        await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
        await observe(() => expect(button('生成回复').disabled).toBe(false));
    };
    const response = (text: string) => ({ choices: [{ message: { content: text } }] });
    const payload = (index: number) => JSON.parse(String(transport.mock.calls[index][1].body)).messages;
    try {
        await DB.deleteAsset('sully-11-history-v1');
        await act(async () => root.render(React.createElement(SullyHelpCard)));
        expect(host.querySelector('img')?.getAttribute('src')).toBe('sully/sully-11.png');
        await act(async () => host.querySelector('button')!.click());
        expect(openApp).toHaveBeenCalledWith(AppID.FAQ);
        await act(async () => root.render(React.createElement(FAQApp)));
        await observe(() => expect(button('具体 App').disabled).toBe(false));
        expect(host.querySelector('[role="log"] img')?.getAttribute('src')).toBe('sully/sully-11.png');
        await ask('发完消息怎么让角色回复？');
        expect(transport).not.toHaveBeenCalled();
        transport.mockResolvedValueOnce(response('<think>internal</think>点闪电按钮。'));
        await click('生成回复');
        await observe(() => expect(host.querySelector('.s11-turn.assistant')?.textContent).toBe('点闪电按钮。'));
        expect(transport.mock.calls[0][0]).toBe('https://example.test/v1/chat/completions');
        expect(transport.mock.calls[0][4]).toMatchObject({ appId: 'faq', charName: 'Sully-11' });
        const first = payload(0)[0].content;
        expect(first).toContain('你是 Sully-11');
        expect(first).toContain('各家的 Sully 各有自己的聊天和记忆');
        expect(first).toContain('Sully-10 是看大门的社区答题猫');
        expect(first).not.toContain('你是住在眼前这位用户家里的那只 Sully');
        expect(first).toContain('【手册目录】');
        expect(first).toContain('闪电按钮');
        expect(first).toContain('"记忆宫殿":true');
        expect(first).not.toMatch(/PRIVATE-|test-key|example\.test/);
        await ask('闪电在哪？');
        localStorage.setItem(CHAT_INPUT_PREFERENCES_KEY, JSON.stringify({ autoReply: true }));
        transport.mockRejectedValueOnce(new Error('连接失败'));
        await click('生成回复');
        await observe(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('连接失败'));
        transport.mockResolvedValueOnce(response('看顶部标题栏。'));
        await click('生成回复');
        await observe(() => expect(host.querySelectorAll('.s11-turn.assistant')).toHaveLength(2));
        expect(payload(2).slice(1)).toEqual([
            { role: 'user', content: '发完消息怎么让角色回复？' }, { role: 'assistant', content: '点闪电按钮。' }, { role: 'user', content: '闪电在哪？' },
        ]);
        expect(payload(2)[0].content).toContain('"自动回复":true');
        const select = host.querySelector<HTMLSelectElement>('form select')!;
        await act(async () => { select.value = 'second'; select.dispatchEvent(new Event('change', { bubbles: true })); });
        await ask('我用的什么模型？');
        transport.mockResolvedValueOnce(response('你选中了角色独立 API。'));
        await click('生成回复');
        await observe(() => expect(host.querySelector('.s11-turn.assistant')?.textContent).toContain('独立 API'));
        expect(payload(3)).toHaveLength(2);
        expect(payload(3)[0].content).toContain('second-model');
        expect(payload(3)[0].content).not.toMatch(/PRIVATE-|override\.test/);
        expect(button('指定角色').getAttribute('aria-pressed')).toBe('true');
        await click('所有角色');
        expect(host.querySelector('form select')).toBeNull();
        expect(host.querySelector('.s11-config p')?.textContent).toContain('只查看所有角色共用的设置');
        await ask('大家的自动回复开了吗？');
        transport.mockResolvedValueOnce(response('自动回复已开启。'));
        await click('生成回复');
        await observe(() => expect(host.querySelector('.s11-turn.assistant')?.textContent).toContain('自动回复已开启'));
        expect(payload(4)[0].content).toContain('"自动回复":true');
        expect(payload(4)[0].content).not.toContain('second-model');
        await click('指定角色');
        expect(host.querySelector<HTMLSelectElement>('form select')?.value).toBe('second');
        expect(host.querySelector('.s11-turn.assistant')?.textContent).toContain('角色独立 API');
        await click('功能目录');
        await click('社区规则');
        await act(async () => host.querySelector<HTMLButtonElement>('.s11-catalog-row')!.click());
        expect(host.querySelector('.s11-welcome h2')?.textContent).toBe('Discord 社区规则');
        expect(host.querySelector('.s11-welcome p')?.textContent).toContain('社区、招募与维护');
        expect(host.querySelector('form select')).toBeNull();
        expect(host.querySelector('.s11-config')).toBeNull();
        await ask('有人在别的频道问原生功能，该怎么办？');
        const community = helpDeskCatalog.find(p => p.category === 'community')!;
        const rule = community.areas.find(a => a.label.startsWith('禁言'))!;
        const donation = community.areas.find(a => a.label.startsWith('免费'))!;
        transport.mockResolvedValueOnce(response('[[查手册: ' + rule.id + ',' + donation.id + ']]'));
        transport.mockResolvedValueOnce(response('看社区的管理规则。'));
        await click('生成回复');
        await observe(() => expect(host.querySelector('.s11-turn.assistant')?.textContent).toContain('管理规则'));
        expect(host.querySelector('.s11-compact h2')?.textContent).toBe('Discord 社区规则');
        expect(transport).toHaveBeenCalledTimes(7);
        const read = payload(6);
        expect(read).toHaveLength(2);
        expect(read[0].content).toContain('【手册目录】');
        expect(read[0].content).toContain('禁言 3 天');
        expect(read[0].content).toContain('赞赏不改变');
        expect(read[0].content).not.toMatch(/【本轮设置摘要】|second-model|【记忆宫殿】/);
        await appendHelpRecord({ id: 'hidden-legacy', scope: { category: 'app', topic: '手账' }, characterId: 'first', role: 'user', content: '旧咨询' });
        await act(async () => root.render(null));
        await act(async () => root.render(React.createElement(FAQApp)));
        await click('问 Sully-11');
        await observe(() => expect(host.querySelector('.s11-turn.assistant')?.textContent).toContain('管理规则'));
        await click('最近咨询');
        expect(host.querySelectorAll('.s11-catalog-row')).toHaveLength(4);
        expect(host.textContent).toContain('自动找入口 · 所有角色');
        expect(host.textContent).not.toContain('旧咨询');
        await click('新咨询');
        expect(host.querySelectorAll('.s11-turn')).toHaveLength(0);
        await click('最近咨询');
        const archived = [...host.querySelectorAll<HTMLButtonElement>('.s11-catalog-row')].find(row => row.textContent?.includes('管理规则'))!;
        expect(archived.textContent).toContain('已归档');
        await act(async () => archived.click());
        expect(host.querySelector('.s11-turn.assistant')?.textContent).toContain('管理规则');
        await ask('继续刚才这段');
        const saved = await loadHelpHistory();
        expect(saved.at(-1)?.consultationId).toBe(saved.find(row => row.content === '看社区的管理规则。')?.consultationId);
    } finally {
        localStorage.removeItem(CHAT_INPUT_PREFERENCES_KEY);
        await act(async () => root.unmount());
        await DB.deleteAsset('sully-11-history-v1');
        host.remove();
    }
});

it('retains local history after 200 and rejects a duplicate or outdated response', async () => {
    await DB.deleteAsset('sully-11-history-v1');
    const record = (n: number): HelpRecord => ({ id: String(n), role: 'user', content: '消息 ' + n, scope: automaticScope, characterId: 'a' });
    const seed = Array.from({ length: 199 }, (_, i) => record(i));
    await DB.saveAssetRaw('sully-11-history-v1', seed);
    await Promise.all([appendHelpRecord(record(199)), appendHelpRecord({ ...record(200), scope: { category: 'community', topic: 'Discord 社区规则' } })]);
    await appendHelpRecord(record(199));
    await appendHelpRecord({ ...record(201), role: 'assistant' }, '198');
    let rows = await loadHelpHistory();
    expect(rows).toHaveLength(201);
    expect(rows.map(r => r.id)).toContain('0');
    expect(rows.map(r => r.id)).not.toContain('201');
    rows = await appendHelpRecord({ ...record(202), role: 'assistant' }, '199');
    expect(rows).toHaveLength(202);
    expect(rows.at(-1)?.id).toBe('202');
    await DB.deleteAsset('sully-11-history-v1');
});

it('resumes before the idle deadline, archives at the deadline and never reads beyond 200 turns', () => {
    vi.useFakeTimers();
    try {
        const first = newConsultation();
        rememberConsultation(first);
        vi.setSystemTime(first.lastActive + CONSULTATION_IDLE_MS - 1);
        expect(currentConsultation([]).id).toBe(first.id);
        vi.setSystemTime(first.lastActive + CONSULTATION_IDLE_MS);
        expect(currentConsultation([]).id).not.toBe(first.id);
        const rows = Array.from({ length: 201 }, (_, i) => ({ role: 'user' as const, content: i === 0 ? '秘密口令是蓝莓' : i === 200 ? '秘密口令是什么' : '日常' }));
        expect(JSON.stringify(selectHelpDeskContext(rows))).not.toContain('蓝莓');
    } finally { vi.useRealTimers(); localStorage.removeItem('sully-11-current-consultation'); }
});

it('keeps matching older support turns while bounding model context and stripping storage metadata', () => {
    const history: HelpRecord[] = Array.from({ length: 40 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: i === 2 ? '查询歪掉的歌词对轴' : i === 3 ? '打开播放页里的歌词对轴' : '另一个话题',
        id: String(i), scope: automaticScope, characterId: 'a',
    }));
    history.push({ ...history[2], id: '40', content: '之前的歌词对轴在哪？' });
    const context = selectHelpDeskContext(history);
    expect(context).toContainEqual({ role: 'assistant', content: '打开播放页里的歌词对轴' });
    expect(context.length).toBeLessThanOrEqual(11);
    expect(context.every(message => Object.keys(message).length === 2)).toBe(true);
    expect(selectHelpDeskContext(history.map(r => ({...r, content: '字'.repeat(3500)}))).reduce((n,r) => n + r.content.length, 0)).toBeLessThanOrEqual(6000);
});

it('makes only catalogued areas readable, with two automatic and at most two additional sections', () => {
    const knowledge = buildHelpDeskKnowledge([], []);
    const all = helpDeskCatalog.flatMap(p => p.areas.map(a => a.id));
    const reading = knowledge.prepare([{ role: 'user', content: '自动回复在哪？' }]);
    const sections = (s: string) => [...s.matchAll(/^(\d+\.\d+) /gm)].map(m => m[1]);
    const auto = sections(reading.prompt);
    expect(auto.length).toBeLessThanOrEqual(2);
    const others = all.filter(id => !auto.includes(id));
    expect(sections(reading.lookup(others).prompt)).toEqual(expect.arrayContaining(others.slice(0, 2)));
    expect(sections(reading.lookup(others).prompt).length).toBeLessThanOrEqual(4);
    expect(sections(reading.lookup(['999.99', '../../secret']).prompt)).toEqual(auto);
    const discord = knowledge.prepare([], { category: 'community', topic: 'Discord 社区规则' });
    expect(discord.lookup([all[0]]).titles).toEqual([]);
});

it.each([
    automaticScope,
    { category: 'app', topic: 'Message' } as const,
    { category: 'system', topic: '角色记忆系统' } as const,
    { category: 'community', topic: 'Discord 社区规则' } as const,
])('keeps referral and joining guidance available before and after lookup in $topic', scope => {
    const reading = buildHelpDeskKnowledge([], []).prepare([{ role: 'user', content: '都试过了，还是卡在这里。' }], scope);
    for (const prompt of [reading.prompt, reading.lookup([]).prompt]) {
        expect(prompt).toContain('手册能解决就直接带用户操作');
        expect(prompt).toContain('Discord → SullyOS 区 →「Bug反馈与疑问咨询」');
        expect(prompt).toContain('还拿不准是不是 Bug 也可以问');
        expect(prompt).toContain('别承诺免罚');
        expect(prompt).toContain('去小红书搜作者「糯糯糯糯五」');
        expect(prompt).toContain('按当期说明加入');
    }
});

it('offers a usable referral if the model repeats a lookup after its last turn', async () => {
    const command = { choices: [{ message: { content: '[[查手册: 1.1]]' } }] };
    vi.mocked(safeFetchJson).mockResolvedValueOnce(command).mockResolvedValueOnce(command);
    const answer = await askSullyHelpDesk(
        { baseUrl: 'https://example.test/v1', model: 'test-model', apiKey: '' },
        buildHelpDeskKnowledge([], []), [{ role: 'user', content: '按步骤都试过了，还能去哪里问？' }],
        null, new AbortController().signal, automaticScope,
    );
    expect(answer).toContain('「Bug反馈与疑问咨询」');
    expect(answer).toContain('糯糯糯糯五');
    expect(answer).not.toContain('[[查手册');
});
