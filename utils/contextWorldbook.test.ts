import { describe, expect, it, vi } from 'vitest';
import { ContextBuilder } from './context';
import type { CharacterProfile, MountedWorldbook, UserProfile } from '../types';

const user = { name: '用户甲', bio: '' } as UserProfile;
const char = (books: MountedWorldbook[]): CharacterProfile => ({
    id: 'worldbook-core', name: '角色甲', avatar: '', description: '', systemPrompt: '角色正文', memories: [],
    mountedWorldbooks: books,
} as CharacterProfile);
const book = (id: string, extra: Partial<MountedWorldbook> = {}): MountedWorldbook => ({
    id, title: id, content: `WB_${id}_正文`, constant: true, position: 4, ...extra,
});

describe('ContextBuilder 世界书公共契约', () => {
    it.each([true, false])('详细记忆=%s：默认上下文包含全部七个位置的常驻世界书且只出现一次', async detailed => {
        const books = Array.from({ length: 7 }, (_, position) => book(String(position), {
            position: position as MountedWorldbook['position'],
        }));
        const result = (await ContextBuilder.buildCoreContext(char(books), user, detailed));
        books.forEach(b => expect(result.split(b.content)).toHaveLength(2));
    });

    it('同一个入口返回核心文本与按深度注入的完整消息，无需调用方再处理世界书', async () => {
        const character = char([book('fixed', { position: 1 }), book('depth')]);
        const result = (await ContextBuilder.buildCharacterContext({ scene: 'chat.private', char: character, user, history: [] }));
        expect(result.coreContext).toContain('WB_fixed_正文');
        expect(result.coreContext).not.toContain('WB_depth_正文');
        expect(result.messages[1]).toEqual({ role: 'system', content: 'WB_depth_正文' });
        expect(JSON.stringify(result.messages).split('WB_depth_正文')).toHaveLength(2);
    });

    it('兜底仍遵守禁用、概率、关键词与宏替换，不无条件激活', async () => {
        const character = char([
            book('disabled', { disable: true }), book('zero', { useProbability: true, probability: 0 }),
            book('keyword', { constant: false, key: ['灯塔'], content: '{{char}}和{{user}}在灯塔' }),
        ]);
        const empty = (await ContextBuilder.buildCoreContext(character, user));
        expect(empty).not.toContain('在灯塔');
        const active = (await ContextBuilder.buildCoreContext(character, user, true, undefined, undefined, {
            worldbookMessages: [{ role: 'user', content: '灯塔' }],
        }));
        expect(active).toContain('角色甲和用户甲在灯塔');
        expect(active).not.toContain('WB_disabled_正文');
        expect(active).not.toContain('WB_zero_正文');
    });

    it('群聊共有条目在共享上下文出现一次，成员上下文只保留自己独有条目', async () => {
        const shared = book('shared');
        const a = char([shared, book('private')]);
        const b = { ...char([shared]), id: 'other', name: '角色乙' };
        const scene = ContextBuilder.buildGroupSharedScene([a, b], user, [], 'chat.private');
        const core = (await ContextBuilder.buildCoreContext(a, user, true, undefined, {
            skipWorldbookIds: scene.sharedWorldbookIds,
        }));
        expect(scene.text.split(shared.content)).toHaveLength(2);
        expect(core).not.toContain(shared.content);
        expect(core).toContain('WB_private_正文');
    });
});

it('概率只抽样一次，核心正文和历史使用同一轮解析结果', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0.2).mockReturnValue(0.9);
    try {
        const result = (await ContextBuilder.buildCharacterContext({
            scene: 'chat.private',
            char: char([book('chance', { probability: 50, useProbability: true })]), user, history: [],
        }));
        expect(random).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(result.messages)).toContain('WB_chance_正文');
    } finally { random.mockRestore(); }
});

it('同深度按 order 升序且同序稳定，不同深度按原始历史定位，保留三种消息角色', async () => {
    const history = Object.freeze([
        Object.freeze({ role: 'user', content: 'H0' }),
        Object.freeze({ role: 'assistant', content: 'H1' }),
        Object.freeze({ role: 'user', content: 'H2' }),
        Object.freeze({ role: 'assistant', content: 'H3' }),
    ]);
    const result = (await ContextBuilder.buildCharacterContext({
        scene: 'chat.private',
        char: char([
            book('late', { depth: 2, order: 30, role: 2 }),
            book('early', { depth: 2, order: 10, role: 0 }),
            book('tie', { depth: 2, order: 10, role: 1 }),
            book('tail', { depth: 0, order: 1, role: 2 }),
            book('head', { depth: 99, order: 99, role: 0 }),
        ]), user, history: [...history],
    }));
    expect(result.history.map(m => [m.role, m.content])).toEqual([
        ['system', 'WB_head_正文'], ['user', 'H0'], ['assistant', 'H1'],
        ['system', 'WB_early_正文'], ['user', 'WB_tie_正文'], ['assistant', 'WB_late_正文'],
        ['user', 'H2'], ['assistant', 'H3'], ['assistant', 'WB_tail_正文'],
    ]);
    expect(history.map(m => m.content)).toEqual(['H0', 'H1', 'H2', 'H3']);
});

it('角色设定前后的位置优先于 order，同位置按 order 排序', async () => {
    const result = (await ContextBuilder.buildCharacterContext({
        scene: 'chat.private',
        char: char([
            book('afterLate', { position: 1, order: 20 }),
            book('before', { position: 0, order: 999 }),
            book('afterEarly', { position: 1, order: 1 }),
        ]), user,
    }));
    const text = result.coreContext;
    expect(text.indexOf('WB_before_正文')).toBeLessThan(text.indexOf('角色正文'));
    expect(text.indexOf('角色正文')).toBeLessThan(text.indexOf('WB_afterEarly_正文'));
    expect(text.indexOf('WB_afterEarly_正文')).toBeLessThan(text.indexOf('WB_afterLate_正文'));
});

it('显式空历史不会回退旧扫描材料；扫描深度与注入深度相互独立', async () => {
    const character = char([book('key', { constant: false, key: ['灯塔'], scanDepth: 1, depth: 99 })]);
    const result = (await ContextBuilder.buildCharacterContext({
        scene: 'chat.private',
        char: character, user, history: [],
        timeOptions: { worldbookMessages: [{ content: '灯塔' }] },
    }));
    expect(JSON.stringify(result.messages)).not.toContain('WB_key_正文');
    const missed = (await ContextBuilder.buildCharacterContext({
        scene: 'chat.private',
        char: character, user, history: [{ role: 'user', content: '灯塔' }, { role: 'assistant', content: '你好' }],
    }));
    expect(JSON.stringify(missed.messages)).not.toContain('WB_key_正文');
    const active = (await ContextBuilder.buildCharacterContext({
        scene: 'chat.private',
        char: character, user, history: [{ role: 'user', content: '灯塔' }],
    }));
    expect(active.history[0].content).toBe('WB_key_正文');
});

it('自定义预设：深度不计规则消息，depth=0 在本轮用户之后、assistant预填之前', () => {
    const h0 = { role: 'user', content: '旧输入' };
    const h1 = { role: 'assistant', content: '旧回复' };
    const pending = { role: 'user', content: '新输入' };
    const messages = ContextBuilder.buildWorldbookRequest({
        scene: 'chat.private',
        books: [book('one', { depth: 1 }), book('zero', { depth: 0, role: 1 })],
        charName: '角色甲', userName: '用户甲', history: [h0, h1, pending],
        render: () => [
            { role: 'system', content: '角色规则' }, h0, h1,
            { role: 'system', content: '额外预设规则' }, pending,
            { role: 'assistant', content: '预填充' },
        ],
    });
    expect(messages.map(m => m.content)).toEqual([
        '角色规则', '旧输入', '旧回复', '额外预设规则', 'WB_one_正文', '新输入', 'WB_zero_正文', '预填充',
    ]);
    expect(messages[6].role).toBe('user');
});

it('群聊共有世界书只触发一次，私有条目保留角色归属与宏，深度仍按群消息定位', () => {
    const shared = book('shared', { depth: 0, useProbability: true, probability: 50 });
    const a = char([shared, book('own', { depth: 1, content: '{{char}}独有设定', role: 2 })]);
    const b = { ...char([shared]), id: 'b', name: '角色乙' };
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    try {
        const messages = ContextBuilder.buildGroupWorldbookRequest({
            scene: 'chat.private',
            members: [a, b], user, history: [{ role: 'user', content: '群消息' }],
            render: (_slots, history) => [{ role: 'system', content: '群角色资料' }, ...history],
        });
        expect(random).toHaveBeenCalledTimes(1);
        expect(messages[1]).toMatchObject({ role: 'assistant' });
        expect(messages[1].content).toContain('角色甲独有设定');
        expect(messages[1].content).not.toContain('角色乙');
        expect(messages[2].content).toBe('群消息');
        expect(JSON.stringify(messages).split('WB_shared_正文')).toHaveLength(2);
    } finally { random.mockRestore(); }
});

it('新 App 只传角色和消息即可加载七个位置，系统规则不触发关键词、不计深度', async () => {
    const character = char([
        ...[0, 1, 2, 3, 5, 6].map(position => book(String(position), { position: position as MountedWorldbook['position'] })),
        book('depth', { depth: 1, role: 2 }),
        book('keyword', { constant: false, key: ['规则关键词'] }),
    ]);
    const image = { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }] };
    const messages = (await ContextBuilder.buildCharacterRequest({ scene: 'chat.private', char: character, user }, [
        { role: 'system', content: '规则关键词' }, { role: 'assistant', content: '旧回复' }, image,
    ]));
    for (const id of ['0', '1', '2', '3', '5', '6', 'depth']) {
        expect(JSON.stringify(messages).split(`WB_${id}_正文`)).toHaveLength(2);
    }
    expect(JSON.stringify(messages)).not.toContain('WB_keyword_正文');
    expect(messages.slice(-2)).toEqual([{ role: 'assistant', content: 'WB_depth_正文' }, image]);
    expect(messages[messages.length - 1]).toBe(image);
});

it('单次生成与空消息同样保留深度条目的角色，概率每次请求仅抽一次', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    try {
        const character = char([book('once', { role: 1, depth: 4, useProbability: true, probability: 50 })]);
        const messages = (await ContextBuilder.buildCharacterRequest({ scene: 'chat.private', char: character, user }, [{ role: 'user', content: '生成任务' }]));
        expect(random).toHaveBeenCalledTimes(1);
        expect(messages.slice(1)).toEqual([{ role: 'user', content: 'WB_once_正文' }, { role: 'user', content: '生成任务' }]);
        const empty = (await ContextBuilder.buildCharacterRequest({ scene: 'chat.private', char: character, user }, []));
        expect(empty[1]).toEqual({ role: 'user', content: 'WB_once_正文' });
        expect(random).toHaveBeenCalledTimes(2);
    } finally { random.mockRestore(); }
});

describe('世界书生效场景筛选', () => {
    const trpgOnly = book('trpg', { position: 1, scenes: ['apps.trpg'] });
    const everywhere = book('all', { position: 1 });

    it('限定跑团的条目不进见面请求，进跑团请求；不传场景时不筛', async () => {
        const character = char([trpgOnly, everywhere]);
        const date = JSON.stringify(await ContextBuilder.buildCharacterRequest({ char: character, user, scene: 'offline.date' }, []));
        expect(date).not.toContain('WB_trpg_正文');
        expect(date).toContain('WB_all_正文');
        const trpg = JSON.stringify(await ContextBuilder.buildCharacterRequest({ char: character, user, scene: 'apps.trpg' }, []));
        expect(trpg).toContain('WB_trpg_正文');
        expect(await ContextBuilder.buildCoreContext(character, user)).toContain('WB_trpg_正文');
        expect(await ContextBuilder.buildCoreContext(character, user, true, undefined, undefined, { worldbookScene: 'offline.date' }))
            .not.toContain('WB_trpg_正文');
    });

    it('被场景筛掉的概率条目不占抽签', async () => {
        const random = vi.spyOn(Math, 'random').mockReturnValue(0.1);
        try {
            const character = char([book('chance', { useProbability: true, probability: 50, scenes: ['apps.trpg'] })]);
            await ContextBuilder.buildCharacterRequest({ char: character, user, scene: 'offline.date' }, []);
            expect(random).not.toHaveBeenCalled();
        } finally { random.mockRestore(); }
    });

    it('自定义布局、多人布局、群聊共享块与预览都按场景筛', () => {
        const render = (slots: { before: string; after: string }, history: { role: string; content: any }[]) =>
            [{ role: 'system', content: slots.before + slots.after }, ...history];
        const custom = ContextBuilder.buildWorldbookRequest({
            books: [trpgOnly], charName: '角色甲', userName: '用户甲', history: [], render, scene: 'offline.date',
        });
        expect(JSON.stringify(custom)).not.toContain('WB_trpg_正文');
        const a = char([trpgOnly]);
        const b = { ...char([trpgOnly]), id: 'b', name: '角色乙' };
        const group = ContextBuilder.buildGroupWorldbookRequest({ members: [a, b], user, history: [], render, scene: 'group.groupChat' });
        expect(JSON.stringify(group)).not.toContain('WB_trpg_正文');
        expect(ContextBuilder.buildGroupSharedScene([a, b], user, [], 'group.groupChat').text).not.toContain('WB_trpg_正文');
        expect(ContextBuilder.buildGroupSharedScene([a, b], user, [], 'apps.trpg').text).toContain('WB_trpg_正文');
        // 统计预览里不属于本场景的条目照样列出、标成 otherScene，只是不计入。
        expect(ContextBuilder.inspectWorldbooks(a, user, [], 'offline.date').map(b => b.status)).toEqual(['otherScene']);
        expect(ContextBuilder.inspectWorldbooks(a, user, [], 'apps.trpg').map(b => b.status)).not.toContain('otherScene');
    });
});
