import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyAssistantPostProcessing, PostProcessCtx, XhsCaches } from './applyAssistantPostProcessing';
import * as agenticTools from './agenticTools';
import { DB } from './db';

/**
 * 「连不上」不能说成「没有」。
 *
 * agenticTools 把「传输失败」从「查过了没有」里拆了出来（新 reason `unreachable`）。前台这几处
 * 兜底原来只认 not_found，unreachable 掉进同一个分支后，角色会张口就说「那天没写日记」
 * 「没找到那篇笔记」—— 一件根本没查成的事，被它当成结论说出去，之后还会顺着这个假前提聊。
 *
 * 这份测试盯住：unreachable 时角色被告知的是「没查成」，而不是「没有」。
 */

const fetchCalls: Array<{ url: string; body: any }> = [];

const fakeLLMResponse = (content: string) => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
});

beforeEach(() => {
    fetchCalls.length = 0;
    vi.spyOn(globalThis, 'fetch' as any).mockImplementation((async (url: any, init: any) => {
        fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        return fakeLLMResponse('嗯……这次没打开') as any;
    }) as any);
});

afterEach(() => { vi.restoreAllMocks(); });

/** 最后一次二轮请求里，喂给角色的那段系统说明 */
const lastSystemPrompt = (): string => {
    const call = fetchCalls[fetchCalls.length - 1];
    const msgs = call?.body?.messages || [];
    return String(msgs[msgs.length - 1]?.content || '');
};

const makeCtx = (char: any, extra: Partial<PostProcessCtx> = {}): PostProcessCtx => {
    const xhsCaches: XhsCaches = {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
    };
    return {
        char,
        userProfile: { name: '小明' } as any,
        emojis: [],
        contextMsgs: [],
        fullMessages: [{ role: 'user', content: '在吗' }],
        initialData: {},
        historyMsgCount: 1,
        xhsCaches,
        api: {
            baseUrl: 'http://localhost:0',
            headers: {},
            effectiveApi: { baseUrl: 'http://localhost:0', apiKey: '', model: 'test' },
        },
        hooks: { setMessages: vi.fn(), addToast: vi.fn() },
        instantRender: true,
        ...extra,
    };
};

const notionConfig = {
    notionEnabled: true,
    notionApiKey: 'k',
    notionDatabaseId: 'db',
    notionNotesDatabaseId: 'notes-db',
} as any;

const feishuConfig = {
    feishuEnabled: true,
    feishuAppId: 'a',
    feishuAppSecret: 's',
    feishuBaseId: 'b',
    feishuTableId: 't',
} as any;

const xhsConfig = {
    xhsMcpConfig: { enabled: true, serverUrl: 'http://localhost:0' },
} as any;

describe('日记 / 笔记：连不上 ≠ 那天没写', () => {
    it('READ_DIARY unreachable → 说「没查成」，不说「那天没写日记」', async () => {
        vi.spyOn(agenticTools, 'runReadDiary').mockResolvedValue({
            ok: false, reason: 'unreachable', date: '2026-08-01',
        } as any);

        await applyAssistantPostProcessing(
            '我翻翻那天的日记\n[[READ_DIARY: 2026-08-01]]',
            makeCtx({ id: `c-rd-${Date.now()}`, name: '阿一' }, { realtimeConfig: notionConfig }),
        );

        const prompt = lastSystemPrompt();
        expect(prompt).toContain('没查成');
        // 修复前: 掉进 not_found 分支, 角色被告知「那天没有写日记」
        expect(prompt).not.toContain('没有写日记');
    });

    it('FS_READ_DIARY unreachable → 同样只说没查成', async () => {
        vi.spyOn(agenticTools, 'runFsReadDiary').mockResolvedValue({
            ok: false, reason: 'unreachable', date: '2026-08-01',
        } as any);

        await applyAssistantPostProcessing(
            '[[FS_READ_DIARY: 2026-08-01]]',
            makeCtx({ id: `c-fsrd-${Date.now()}`, name: '阿一' }, { realtimeConfig: feishuConfig }),
        );

        const prompt = lastSystemPrompt();
        expect(prompt).toContain('没查成');
        expect(prompt).not.toContain('没有写日记');
    });

    it('READ_NOTE unreachable → 说「没查成」，不说「没有找到」', async () => {
        vi.spyOn(agenticTools, 'runReadNote').mockResolvedValue({
            ok: false, reason: 'unreachable', keyword: '旅行计划',
        } as any);

        await applyAssistantPostProcessing(
            '[[READ_NOTE: 旅行计划]]',
            makeCtx({ id: `c-rn-${Date.now()}`, name: '阿一' }, { realtimeConfig: notionConfig }),
        );

        const prompt = lastSystemPrompt();
        expect(prompt).toContain('没查成');
        // 修复前: 掉进 not_found 分支 →「但没有找到」
        expect(prompt).not.toContain('但没有找到');
    });

    it('真的 not_found 时按查过了交回（不回归）', async () => {
        vi.spyOn(agenticTools, 'runReadDiary').mockResolvedValue({
            ok: false, reason: 'not_found', date: '2026-08-01',
        } as any);

        await applyAssistantPostProcessing(
            '[[READ_DIARY: 2026-08-01]]',
            makeCtx({ id: `c-rd-nf-${Date.now()}`, name: '阿一' }, { realtimeConfig: notionConfig }),
        );

        // 查过了、确实没有：按「跑过了」交回结果，不套「没跑成」那句
        const prompt = lastSystemPrompt();
        expect(prompt).toContain('拿回了下面这些');
        expect(prompt).toContain('"reason":"not_found"');
        expect(prompt).not.toContain('没能跑起来');
        expect(prompt).toContain('没有写日记');
    });
});

describe('小红书：连不上时别当无事发生', () => {
    it('XHS_DETAIL unreachable → 交回「没跑起来」，而不是只删标记', async () => {
        vi.spyOn(agenticTools, 'runXhsDetail').mockResolvedValue({
            ok: false, reason: 'unreachable', noteId: 'note-1', message: '连接被拒绝',
        } as any);

        await applyAssistantPostProcessing(
            '我看看这条\n[[XHS_DETAIL: note-1]]',
            makeCtx(
                { id: `c-xd-${Date.now()}`, name: '阿一', xhsEnabled: true },
                { realtimeConfig: xhsConfig },
            ),
        );

        // 修复前: ok:false 直接删标记, 一次二轮都不发, 角色说完"我看看这条"就没下文了
        expect(fetchCalls.length).toBe(1);
        const prompt = lastSystemPrompt();
        expect(prompt).toContain('没能跑起来');
        expect(prompt).toContain('加载失败');
        expect(prompt).toContain('note-1');
    });

    it('XHS_MY_PROFILE unreachable → 交代「打不开」，并明说什么都没看到', async () => {
        // 正常路径优先读本地角色主页；只有本地索引也读不了时，
        // 才会回退到真实账号主页并进入 unreachable 分支。
        vi.spyOn(DB, 'getXhsOwnedPosts').mockRejectedValueOnce(new Error('本地角色主页读取失败'));
        vi.spyOn(agenticTools, 'runXhsMyProfile').mockResolvedValue({
            ok: false, reason: 'unreachable',
        } as any);

        await applyAssistantPostProcessing(
            '我看看我的小红书\n[[XHS_MY_PROFILE]]',
            makeCtx(
                { id: `c-xp-${Date.now()}`, name: '阿一', xhsEnabled: true },
                { realtimeConfig: xhsConfig },
            ),
        );

        // 修复前: 静默丢标记, 零二轮
        expect(fetchCalls.length).toBe(1);
        const prompt = lastSystemPrompt();
        expect(prompt).toContain('没能跑起来');
        expect(prompt).toContain('看到了什么');
        expect(prompt).toContain('不要描述任何笔记');
    });
});
