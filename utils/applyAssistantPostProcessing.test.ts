import { describe, it, expect, vi } from 'vitest';
import { applyAssistantPostProcessing, PostProcessCtx, splitSARChatSurfaceBubbles, XhsCaches } from './applyAssistantPostProcessing';
import { DB } from './db';

// 锁住 renderAndPersist normal path 的引用顺延修复:
// 模型把 [[QUOTE:]] 单独写一行 (典型形态: 标签后紧跟 [[SEND_EMOJI:]] / 换行 + 正文),
// chunkText 按换行拆分后引用标签独占一个 chunk — 剥标签后没有正文不落库,
// 修复前解析出的引用目标随这个空 chunk 一起被丢弃, 表现为"引用被后处理吞掉"。
// 修复后引用目标顺延挂到下一条真正落库的文字气泡。

const makeCtx = (charId: string, contextMsgs: any[], emojis: any[] = []): PostProcessCtx => {
    const xhsCaches: XhsCaches = {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
    };
    return {
        char: { id: charId, name: '测试角色' } as any,
        userProfile: { name: '我' } as any,
        emojis,
        contextMsgs,
        fullMessages: [],
        initialData: {},
        historyMsgCount: 0,
        xhsCaches,
        api: {
            baseUrl: 'http://localhost:0',
            headers: {},
            effectiveApi: { baseUrl: 'http://localhost:0', apiKey: '', model: 'test' },
        },
        hooks: {
            setMessages: vi.fn(),
            addToast: vi.fn(),
        },
    };
};

const quotedUserMsg = {
    id: 101,
    charId: 'c-quote',
    role: 'user' as const,
    type: 'text' as const,
    content: '引用我说的话，还有后面一长串内容',
    timestamp: Date.now() - 1000,
};

describe('renderAndPersist 引用解析', () => {
    it('[[QUOTE:]] 单独成行 (后跟 SEND_EMOJI + 正文) 时引用顺延到第一条文字气泡', async () => {
        const charId = `c-quote-${Date.now()}`;
        const raw = '[[QUOTE: 引用我说的话]]\n[[SEND_EMOJI: 有点生气]]\n消失了整整三十六个小时';

        // 表情要真存在，否则走的是「名字对不上落降级文本气泡」那条路，
        // 第一条 text 会变成降级气泡，验不到这里要验的「引用顺延到正文」。
        await applyAssistantPostProcessing(raw, makeCtx(
            charId,
            [{ ...quotedUserMsg, charId }],
            [{ name: '有点生气', url: 'blob:emoji-angry' }],
        ));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('消失了整整三十六个小时');
        // 修复前: replyTo 为 undefined (引用目标随空 chunk 丢失)
        expect(texts[0].replyTo).toBeTruthy();
        expect(texts[0].replyTo!.id).toBe(101);
        expect(texts[0].replyTo!.name).toBe('我');
    }, 20000);

    it('[[QUOTE:]] 与正文同一行时引用仍挂在该气泡 (既有行为不回归)', async () => {
        const charId = `c-quote-inline-${Date.now()}`;
        const raw = '[[QUOTE: 引用我说的话]]你干嘛去了';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('你干嘛去了');
        expect(texts[0].replyTo?.id).toBe(101);
    }, 20000);

    it('引用只挂一次: 顺延目标落到首条气泡后, 后续气泡不带 replyTo', async () => {
        const charId = `c-quote-once-${Date.now()}`;
        const raw = '[[QUOTE: 引用我说的话]]\n第一句话\n第二句话';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.map(m => m.content)).toEqual(['第一句话', '第二句话']);
        expect(texts[0].replyTo?.id).toBe(101);
        expect(texts[1].replyTo).toBeFalsy();
    }, 20000);
});

// 历史里引用消息被 buildMessageHistory 渲染成 [xx引用了xx说的「…」，并回复了 ↓]，
// 模型会模仿这个渲染格式而不是规范的 [[QUOTE:]]。修复前这种输出既不被识别成引用、
// 整段方括号还会原样漏进气泡；修复后认作合法引用并剥干净。
describe('renderAndPersist 模仿历史渲染格式的引用兜底', () => {
    it('[我引用了你说的「…」，并回复了 ↓] 单独成行时解析为引用并顺延到正文气泡', async () => {
        const charId = `c-nlquote-${Date.now()}`;
        const raw = '[我引用了你说的「引用我说的话」，并回复了 ↓]\n你干嘛去了';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('你干嘛去了');
        expect(texts[0].replyTo?.id).toBe(101);
        expect(texts[0].replyTo!.name).toBe('我');
    }, 20000);

    it('引用摘要带截断省略号时仍能匹配到原消息', async () => {
        const charId = `c-nlquote-ellipsis-${Date.now()}`;
        const raw = '[用户引用了你之前说的「引用我说的话，还有后面一长…」，并回复了 ↓]\n哈哈这个';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('哈哈这个');
        expect(texts[0].replyTo?.id).toBe(101);
    }, 20000);

    it('与正文同一行时引用挂在该气泡且方括号头不漏进正文', async () => {
        const charId = `c-nlquote-inline-${Date.now()}`;
        const raw = '[你引用了对方说的「引用我说的话」，并回复了 ↓] 这就解释';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('这就解释');
        expect(texts[0].content).not.toContain('引用了');
        expect(texts[0].replyTo?.id).toBe(101);
    }, 20000);

    it('正常含方括号但非引用格式的句子不被误剥', async () => {
        const charId = `c-nlquote-fp-${Date.now()}`;
        const raw = '我看了[那本书]感觉一般';

        await applyAssistantPostProcessing(raw, makeCtx(charId, [{ ...quotedUserMsg, charId }]));

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('我看了[那本书]感觉一般');
        expect(texts[0].replyTo).toBeFalsy();
    }, 20000);
});

// 锁住双语（翻译模式）分支的表情包位置修复:
// 旧实现把所有 [[SEND_EMOJI:]] 先抽出、正文发完后统一追加在最后（且去重），
// 表现为"翻译模式下角色永远最后才发表情包"。修复后表情包按模型写的位置原地插发。
describe('renderAndPersist 双语分支表情包顺序', () => {
    const testEmojis = [
        { id: 1, name: '开心', url: 'https://example.com/happy.png' },
        { id: 2, name: '疑惑', url: 'https://example.com/confused.png' },
    ] as any[];

    const makeBiCtx = (charId: string): PostProcessCtx => {
        const ctx = makeCtx(charId, []);
        ctx.emojis = testEmojis as any;
        ctx.instantRender = true;
        return ctx;
    };

    it('表情包按出现位置插发，不再统一挪到最后', async () => {
        const charId = `c-bi-emoji-${Date.now()}`;
        const raw = [
            '[[SEND_EMOJI: 开心]]',
            '<翻译><原文>Hello there</原文><译文>你好呀</译文></翻译>',
            '[[SEND_EMOJI: 疑惑]]',
            '<翻译><原文>What happened</原文><译文>发生什么了</译文></翻译>',
        ].join('\n');

        await applyAssistantPostProcessing(raw, makeBiCtx(charId));

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(msgs.map(m => m.type)).toEqual(['emoji', 'text', 'emoji', 'text']);
        expect(msgs[0].content).toBe('https://example.com/happy.png');
        expect(msgs[1].content).toBe('Hello there\n%%BILINGUAL%%\n你好呀');
        expect(msgs[2].content).toBe('https://example.com/confused.png');
        expect(msgs[3].content).toBe('What happened\n%%BILINGUAL%%\n发生什么了');
    }, 20000);

    it('同一个表情包出现两次时不去重，两次都发', async () => {
        const charId = `c-bi-emoji-dup-${Date.now()}`;
        const raw = [
            '[[SEND_EMOJI: 开心]]',
            '<翻译><原文>Nice</原文><译文>好耶</译文></翻译>',
            '[[SEND_EMOJI: 开心]]',
        ].join('\n');

        await applyAssistantPostProcessing(raw, makeBiCtx(charId));

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(msgs.map(m => m.type)).toEqual(['emoji', 'text', 'emoji']);
    }, 20000);

    it('混进 <原文>/<译文> 里的表情标签剥出来紧跟该双语气泡发送', async () => {
        const charId = `c-bi-emoji-inline-${Date.now()}`;
        const raw = '<翻译><原文>See you [[SEND_EMOJI: 开心]]</原文><译文>回见</译文></翻译>\n尾巴一句';

        await applyAssistantPostProcessing(raw, makeBiCtx(charId));

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(msgs.map(m => m.type)).toEqual(['text', 'emoji', 'text']);
        expect(msgs[0].content).toBe('See you\n%%BILINGUAL%%\n回见');
        expect(msgs[2].content).toBe('尾巴一句');
    }, 20000);

    it('表情包在最后时仍最后发（既有行为不回归）', async () => {
        const charId = `c-bi-emoji-tail-${Date.now()}`;
        const raw = '<翻译><原文>Bye</原文><译文>拜拜</译文></翻译>\n[[SEND_EMOJI: 疑惑]]';

        await applyAssistantPostProcessing(raw, makeBiCtx(charId));

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(msgs.map(m => m.type)).toEqual(['text', 'emoji']);
    }, 20000);
});

describe('SAR Chat 特殊格式气泡对齐', () => {
    it('把内置翻译块还原成最终落库的一条双语气泡', () => {
        const raw = [
            '<翻译><原文>もう知らない。</原文><译文>不管你了。</译文></翻译>',
            '<翻译><原文>勝手にして。</原文><译文>随你便。</译文></翻译>',
        ].join('\n');
        expect(splitSARChatSurfaceBubbles(raw)).toEqual([
            'もう知らない。\n%%BILINGUAL%%\n不管你了。',
            '勝手にして。\n%%BILINGUAL%%\n随你便。',
        ]);
    });

    it('把语音与字幕保持为一个原子气泡，也不拆同泡括号翻译', () => {
        const raw = [
            '<语音 emotion="angry">Enough.\nDo not do that again.</语音><字幕>够了。别再这样。</字幕>',
            'もう知らない。（不管你了。）',
        ].join('\n');
        const chunks = splitSARChatSurfaceBubbles(raw);
        expect(chunks).toHaveLength(2);
        expect(chunks[0]).toContain('<语音 emotion="angry">');
        expect(chunks[0]).toContain('<字幕>够了。别再这样。</字幕>');
        expect(chunks[1]).toBe('もう知らない。（不管你了。）');
    });

    it('双语 canonical 与双语 surface 按整泡写入 metadata，不按 XML 换行串位', async () => {
        const charId = `c-sar-bi-${Date.now()}`;
        const canonical = [
            '<翻译><原文>I did not mean that.</原文><译文>我不是那个意思。</译文></翻译>',
            '<翻译><原文>Stop laughing.</原文><译文>别笑了。</译文></翻译>',
        ].join('\n');
        const surface = [
            '<翻译><原文>Pray, mistake me not.</原文><译文>还请阁下莫要误会。</译文></翻译>',
            '<翻译><原文>Cease thy laughter.</原文><译文>休要再笑。</译文></翻译>',
        ].join('\n');
        const ctx = makeCtx(charId, []);
        ctx.instantRender = true;
        ctx.sarModuleSurface = {
            version: 1,
            runId: 'sar-test',
            moduleId: 'court',
            moduleTitle: '王庭贵族协议',
            target: 'character',
            phase: 'active',
            surface,
            canonicalField: 'content',
            surfaceField: 'metadata.sarModuleSurface.surface',
        };

        await applyAssistantPostProcessing(canonical, ctx);

        const texts = (await DB.getRecentMessagesByCharId(charId, 20))
            .filter(message => message.role === 'assistant' && message.type === 'text');
        expect(texts.map(message => message.content)).toEqual([
            'I did not mean that.\n%%BILINGUAL%%\n我不是那个意思。',
            'Stop laughing.\n%%BILINGUAL%%\n别笑了。',
        ]);
        expect(texts.map(message => message.metadata?.sarModuleSurface?.surface)).toEqual([
            'Pray, mistake me not.\n%%BILINGUAL%%\n还请阁下莫要误会。',
            'Cease thy laughter.\n%%BILINGUAL%%\n休要再笑。',
        ]);
    }, 20000);
});

// 回归守卫：ctx.messageTimestamp 要一路透传到每条 DB.saveMessage。
// 修复前 15 处落库都不传 timestamp、一律取写库当刻——主动消息离线补收时昨晚的消息
// 显示成今天中午。修复后调用方（activeMsgRuntime）可以把 worker 发送时刻传进来，
// 同一轮拆出的多条气泡（文字 / 表情）共用同一个时间戳。
describe('messageTimestamp 落库时间戳透传', () => {
    const testEmojis = [
        { id: 1, name: '开心', url: 'https://example.com/happy.png' },
    ] as any[];

    it('传了 messageTimestamp → 文字与表情多条气泡全部落这个时间戳', async () => {
        const charId = `c-msgts-${Date.now()}`;
        const ctx = makeCtx(charId, []);
        ctx.emojis = testEmojis as any;
        ctx.instantRender = true;
        const sentAt = Date.now() - 13 * 3_600_000; // 昨晚发的，今天才补收
        ctx.messageTimestamp = sentAt;
        const raw = '昨晚看到流星了\n[[SEND_EMOJI: 开心]]\n你猜我许了什么愿';

        await applyAssistantPostProcessing(raw, ctx);

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(msgs.map(m => m.type)).toEqual(['text', 'emoji', 'text']);
        // 修复前这里挂：timestamp 是写库当刻（≈ 现在），不是传入的 sentAt
        for (const m of msgs) expect(m.timestamp).toBe(sentAt);
    }, 20000);

    it('不传 messageTimestamp → 维持默认写库当刻（既有行为不回归）', async () => {
        const charId = `c-msgts-default-${Date.now()}`;
        const ctx = makeCtx(charId, []);
        ctx.instantRender = true;
        const before = Date.now();

        await applyAssistantPostProcessing('刚想起来跟你说个事', ctx);

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(msgs.length).toBeGreaterThan(0);
        for (const m of msgs) expect(m.timestamp).toBeGreaterThanOrEqual(before);
    }, 20000);
});

describe('renderAndPersist XHS mimicked-card fallback', () => {
    it('restores the five-line history format as xhs_card and preserves surrounding text', async () => {
        const charId = `c-xhs-mimic-${Date.now()}`;
        const ctx = makeCtx(charId, []);
        const title = '\u5ba0\u7269\u6c34\u6bcd\u53ef\u4ee5\u6478\u5417\uff1f';
        const author = '\u6eba\u6c34\u6d77\u8707\u76ae';
        ctx.instantRender = true;
        ctx.lastXhsNotesRef = {
            current: [{
                noteId: 'note-jellyfish',
                title,
                desc: '\u7f13\u5b58\u91cc\u7684\u5b8c\u6574\u7b80\u4ecb',
                likes: 2156,
                collects: 488,
                commentCount: 55,
                shareCount: 175,
                author,
                authorId: 'author-1',
                xsecToken: 'token-1',
                coverUrl: 'https://example.test/jellyfish.jpg',
            }],
        };
        const raw = [
            '\u8fd9\u4e2a\u8fd8\u633a\u6709\u610f\u601d',
            '[\u4f60\u5206\u4eab\u4e86\u5c0f\u7ea2\u4e66\u7b14\u8bb0]',
            `\u6807\u9898: ${title}`,
            `\u4f5c\u8005: ${author}`,
            '\u4e92\u52a8: 2156\u8d5e 488\u6536\u85cf 55\u8bc4\u8bba 175\u5206\u4eab',
            '\u7b80\u4ecb: \u4eba\u5de5\u7e41\u6b96\u7684\u5ba0\u7269\u6c34\u6bcd\u5927\u90e8\u5206\u65e0\u6bd2',
            '\u4f60\u770b\u8fd9\u53ea\u662f\u4e0d\u662f\u5f88\u79bb\u8c31',
        ].join('\n');

        await applyAssistantPostProcessing(raw, ctx);

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        const cards = msgs.filter(m => m.type === 'xhs_card');
        const text = msgs.filter(m => m.type === 'text').map(m => m.content).join('\n');
        expect(cards).toHaveLength(1);
        expect(cards[0].metadata?.xhsNote).toMatchObject({
            noteId: 'note-jellyfish',
            title,
            author,
            xsecToken: 'token-1',
            coverUrl: 'https://example.test/jellyfish.jpg',
        });
        expect(text).toContain('\u8fd9\u4e2a\u8fd8\u633a\u6709\u610f\u601d');
        expect(text).toContain('\u4f60\u770b\u8fd9\u53ea\u662f\u4e0d\u662f\u5f88\u79bb\u8c31');
        expect(text).not.toContain('\u4f60\u5206\u4eab\u4e86\u5c0f\u7ea2\u4e66\u7b14\u8bb0');
        expect(text).not.toContain('\u6807\u9898:');
        expect(text).not.toContain('\u4e92\u52a8:');
    }, 20000);

    it('recovers consecutive cards when the next marker is glued to the previous description', async () => {
        const charId = `c-xhs-mimic-glued-${Date.now()}`;
        const ctx = makeCtx(charId, []);
        ctx.instantRender = true;
        ctx.lastXhsNotesRef = {
            current: [
                {
                    noteId: 'note-doll',
                    title: '只需发照片定制人偶可撕拉盲盒',
                    desc: '完整盲盒简介',
                    likes: 11,
                    collects: 0,
                    commentCount: 0,
                    shareCount: 0,
                    author: 'StoyTuned小铺',
                    authorId: 'author-doll',
                    coverUrl: 'https://example.test/doll.jpg',
                },
                {
                    noteId: 'note-couple-app',
                    title: '情侣必备的治愈系app',
                    desc: '完整应用简介',
                    likes: 991,
                    collects: 0,
                    commentCount: 0,
                    shareCount: 0,
                    author: '小猫女士',
                    authorId: 'author-cat',
                    coverUrl: 'https://example.test/couple.jpg',
                },
            ],
        };
        const raw = [
            '[你分享了小红书笔记]',
            '标题: 只需发照片定制人偶可撕拉盲盒',
            '作者: StoyTuned小铺',
            '互动: 11赞 0收藏 0评论 0分享',
            '简介: 无[你分享了小红书笔记]',
            '标题: 情侣必备的治愈系app',
            '作者: 小猫女士',
            '互动: 991赞 0收藏 0评论 0分享',
            '简介: 无',
        ].join('\n');

        await applyAssistantPostProcessing(raw, ctx);

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        const cards = msgs.filter(m => m.type === 'xhs_card');
        const leakedText = msgs.filter(m => m.type === 'text').map(m => m.content).join('\n');
        expect(cards).toHaveLength(2);
        expect(cards.map(card => card.metadata?.xhsNote?.noteId)).toEqual(['note-doll', 'note-couple-app']);
        expect(cards.map(card => card.metadata?.xhsNote?.coverUrl)).toEqual([
            'https://example.test/doll.jpg',
            'https://example.test/couple.jpg',
        ]);
        expect(leakedText).not.toContain('分享了小红书笔记');
        expect(leakedText).not.toContain('991赞');
    }, 20000);
});

// push 路径上 LIFE / NEWS_CARD 的副作用改走 worker classifier 的 directive 通道
// (life_record / news_card)。这里钉的是重放这一段: directive → 拼回原 tag →
// ChatParser.parseAndExecuteActions 执行, 跟本地 fetch 路径同一份代码。
describe('directive 重放: life_record / news_card', () => {
    it('news_card directive → 落一张 news_card 消息, 正文不留标签', async () => {
        const charId = `c-newscard-${Date.now()}`;
        const ctx = makeCtx(charId, []);
        ctx.skipSecondPassLLM = true;
        ctx.directives = [{ type: 'news_card', body: '微博|某某官宣' }];

        await applyAssistantPostProcessing('刷到条新闻，你看过没', ctx);

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        const cards = msgs.filter(m => m.type === 'news_card');
        expect(cards).toHaveLength(1);
        expect(cards[0].metadata?.title).toBe('某某官宣');
        expect(cards[0].metadata?.source).toBe('微博');
        const text = msgs.filter(m => m.type === 'text').map(m => m.content).join('\n');
        expect(text).toContain('刷到条新闻，你看过没');
        expect(text).not.toContain('NEWS_CARD');
    }, 20000);

    it('life_record directive → 落一张 life_card, 正文不留标签', async () => {
        const charId = `c-liferecord-${Date.now()}`;
        await DB.saveCharacter({
            id: charId,
            name: '测试角色',
            lifeRecordEnabled: true,
        } as any);

        const ctx = makeCtx(charId, []);
        ctx.skipSecondPassLLM = true;
        ctx.directives = [{ type: 'life_record', body: 'MED|布洛芬' }];

        await applyAssistantPostProcessing('记得吃药哦', ctx);

        const msgs = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        const cards = msgs.filter(m => m.type === 'life_card');
        expect(cards).toHaveLength(1);
        expect(cards[0].metadata?.module).toBe('med');
        const text = msgs.filter(m => m.type === 'text').map(m => m.content).join('\n');
        expect(text).toContain('记得吃药哦');
        expect(text).not.toContain('LIFE');
    }, 20000);
});

// 表情名对不上时不能静默丢：后台主动消息会把每个 [[SEND_EMOJI]] 切成独立一条 push，
// 丢了就是整条 0 气泡 —— 而系统横幅（[表情：x]）和未读数照常，用户点进去是空的。
describe('SEND_EMOJI 名字对不上', () => {
    it('落一条降级文本气泡，文案与横幅一致', async () => {
        const charId = `c-emoji-miss-${Date.now()}`;

        await applyAssistantPostProcessing('[[SEND_EMOJI: 查无此表情]]', makeCtx(charId, []));

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(bubbles).toHaveLength(1);
        expect(bubbles[0].type).toBe('text');
        expect(bubbles[0].content).toBe('[表情：查无此表情]');
    }, 20000);

    it('名字对得上时照常落表情气泡', async () => {
        const charId = `c-emoji-hit-${Date.now()}`;

        await applyAssistantPostProcessing(
            '[[SEND_EMOJI: 笑死]]',
            makeCtx(charId, [], [{ name: '笑死', url: 'blob:emoji-lol' }]),
        );

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(bubbles).toHaveLength(1);
        expect(bubbles[0].type).toBe('emoji');
        expect(bubbles[0].content).toBe('blob:emoji-lol');
    }, 20000);

    it('模型误写“分类名: 表情名”时恢复为当前可见分类里的真实表情', async () => {
        const charId = `c-emoji-category-prefix-${Date.now()}`;
        const ctx = makeCtx(charId, [], [{
            name: '亲亲额头',
            url: 'blob:emoji-kiss-forehead',
            categoryId: 'cat-dull-cat',
        }]);
        ctx.categories = [{ id: 'cat-dull-cat', name: '呆猫' }];
        ctx.instantRender = true;

        await applyAssistantPostProcessing('[[SEND_EMOJI: 呆猫: 亲亲额头]]', ctx);

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(bubbles).toHaveLength(1);
        expect(bubbles[0].type).toBe('emoji');
        expect(bubbles[0].content).toBe('blob:emoji-kiss-forehead');
    }, 20000);

    it('纯名称精确匹配优先，不误伤本来就包含冒号的表情名', async () => {
        const charId = `c-emoji-colon-name-${Date.now()}`;
        const ctx = makeCtx(charId, [], [
            { name: '呆猫: 亲亲额头', url: 'blob:emoji-exact-colon', categoryId: 'cat-other' },
            { name: '亲亲额头', url: 'blob:emoji-prefixed-fallback', categoryId: 'cat-dull-cat' },
        ]);
        ctx.categories = [
            { id: 'cat-other', name: '其他猫' },
            { id: 'cat-dull-cat', name: '呆猫' },
        ];
        ctx.instantRender = true;

        await applyAssistantPostProcessing('[[SEND_EMOJI: 呆猫: 亲亲额头]]', ctx);

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(bubbles).toHaveLength(1);
        expect(bubbles[0].type).toBe('emoji');
        expect(bubbles[0].content).toBe('blob:emoji-exact-colon');
    }, 20000);

    it('分类前缀存在歧义时不猜 URL，仍保留降级文本', async () => {
        const charId = `c-emoji-category-ambiguous-${Date.now()}`;
        const ctx = makeCtx(charId, [], [
            { name: '挥手', url: 'blob:emoji-wave-a', categoryId: 'cat-a' },
            { name: '挥手', url: 'blob:emoji-wave-b', categoryId: 'cat-b' },
        ]);
        ctx.categories = [
            { id: 'cat-a', name: '小猫' },
            { id: 'cat-b', name: '小猫' },
        ];
        ctx.instantRender = true;

        await applyAssistantPostProcessing('[[SEND_EMOJI: 小猫: 挥手]]', ctx);

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(bubbles).toHaveLength(1);
        expect(bubbles[0].type).toBe('text');
        expect(bubbles[0].content).toBe('[表情：小猫: 挥手]');
    }, 20000);
});

// 模型偶尔会照抄历史/UI 里的人类可读单括号摘要，而不是 prompt 要求的双括号机器指令。
// 这三条锁住真实后处理结果，保证普通聊天与主动消息共用的管线都能自愈。
describe('动作指令单括号掉格式兜底', () => {
    it('[表情：name] 恢复为真实表情气泡', async () => {
        const charId = `c-emoji-single-${Date.now()}`;
        const ctx = makeCtx(charId, [], [{ name: '小狗泪丧', url: 'blob:emoji-dog-cry' }]);
        ctx.instantRender = true;

        await applyAssistantPostProcessing('[表情：小狗泪丧]', ctx);

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        expect(bubbles).toHaveLength(1);
        expect(bubbles[0].type).toBe('emoji');
        expect(bubbles[0].content).toBe('blob:emoji-dog-cry');
    }, 20000);

    it('[ACTION:TRANSFER|...] 恢复为转账卡，正文不留标签', async () => {
        const charId = `c-transfer-single-${Date.now()}`;
        const ctx = makeCtx(charId, []);
        ctx.instantRender = true;

        await applyAssistantPostProcessing('[ACTION:TRANSFER|to=user|amount=13]\n给你买西瓜汁', ctx);

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        const cards = bubbles.filter(m => m.type === 'transfer');
        expect(cards).toHaveLength(1);
        expect(cards[0].metadata?.amount).toBe('13');
        expect(bubbles.filter(m => m.type === 'text').map(m => m.content)).toEqual(['给你买西瓜汁']);
    }, 20000);

    it('[生活记录：支出 ...] 恢复为生活记录卡并写入支出', async () => {
        const charId = `c-life-summary-${Date.now()}`;
        await DB.saveCharacter({ id: charId, name: '测试角色', lifeRecordEnabled: true } as any);
        const ctx = makeCtx(charId, []);
        ctx.instantRender = true;

        await applyAssistantPostProcessing('[生活记录：支出 13（西瓜汁-单括号回归）]', ctx);

        const bubbles = (await DB.getRecentMessagesByCharId(charId, 50)).filter(m => m.role === 'assistant');
        const cards = bubbles.filter(m => m.type === 'life_card');
        expect(cards).toHaveLength(1);
        expect(cards[0].metadata?.module).toBe('expense');
        expect(cards[0].metadata?.summary).toBe('支出 13（西瓜汁-单括号回归）');
        expect(bubbles.filter(m => m.type === 'text')).toHaveLength(0);
    }, 20000);
});

// 主动消息把「角色说出口」和「客户端落库」拉开了距离：一条 push 可以在收件箱里躺一夜。
// 日程改动必须按说出口那一刻判，所以 ctx 上有个 spokenAt，由 activeMsgRuntime 传
// push 的 sentAt。这条钉的是**接线**（ctx 字段真的被日程那一步读到了），
// 判定规则本身在 scheduleChange.test.ts 里钉。
describe('ctx.spokenAt — 日程改动按说出口那一刻判', () => {
    const dateKeyOf = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const seedSchedule = async (charId: string, when: Date) => {
        const key = dateKeyOf(when);
        await DB.saveDailySchedule({
            id: `${charId}_${key}`,
            charId,
            date: key,
            generatedAt: new Date(when.getFullYear(), when.getMonth(), when.getDate(), 8).getTime(),
            slots: [
                { startTime: '08:00', activity: '起床' },
                { startTime: '22:00', activity: '睡觉' },
            ],
        } as any);
        return key;
    };

    const tag = '[[ACTION:CHANGE_SCHEDULE | 22:00 | 陪你聊天]]';

    it('传了昨天的 spokenAt → 今天的表不动（隔夜 push 补收）', async () => {
        const charId = 'c-spoken-at-stale';
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const todayKey = await seedSchedule(charId, new Date());
        await seedSchedule(charId, yesterday);

        const ctx = makeCtx(charId, []);
        await applyAssistantPostProcessing(`睡不着，陪你聊会儿。\n${tag}`, {
            ...ctx,
            spokenAt: yesterday.getTime(),
        });

        const today = await DB.getDailySchedule(charId, todayKey);
        expect(today?.slots[1].activity).toBe('睡觉');
    });

    it('不传 spokenAt（本地聊天）→ 按现在判，照常落库', async () => {
        const charId = 'c-spoken-at-live';
        const now = new Date();
        const todayKey = await seedSchedule(charId, now);

        const ctx = makeCtx(charId, []);
        await applyAssistantPostProcessing(`那今晚不睡了。\n${tag}`, ctx);

        const today = await DB.getDailySchedule(charId, todayKey);
        // 22:00 之前跑：那条是未来，可改；22:00 之后跑：那条是当前时段，也可改。
        expect(today?.slots[1].activity).toBe('陪你聊天');
    });

    // 隔夜补收整批不落，是日历日门槛按设计工作，不是失败。走告知通道的话，用户会收到
    // 一条红色的「没能改上」，而送达其实成功了；主动消息那侧还会把它记进「送达失败」，
    // 指标从此混着一堆正常结果。
    it('隔夜那批不落地时不走告知通道（那不是失败）', async () => {
        const charId = 'c-spoken-at-crossday-silent';
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await seedSchedule(charId, new Date());
        await seedSchedule(charId, yesterday);

        const ctx = makeCtx(charId, []);
        const notifyScheduleChangeFailed = vi.fn();
        await applyAssistantPostProcessing(`睡不着，陪你聊会儿。\n${tag}`, {
            ...ctx,
            spokenAt: yesterday.getTime(),
            hooks: { ...ctx.hooks, notifyScheduleChangeFailed },
        });

        expect(notifyScheduleChangeFailed).not.toHaveBeenCalled();
        expect(ctx.hooks.addToast).not.toHaveBeenCalled();
    });

    // 反向守卫：真没落地（今天的表里没有对得上的时段）照旧要说，而且要把具体原因
    // 带出去——那个 note 是界面上那句话的来源，吞掉的话三种原因会塌成同一句。
    it('今天的表里没有对得上的时段时，带着原因走告知通道', async () => {
        const charId = 'c-spoken-at-noslot';
        await seedSchedule(charId, new Date());

        const ctx = makeCtx(charId, []);
        const notifyScheduleChangeFailed = vi.fn();
        await applyAssistantPostProcessing(
            '换个时间。\n[[ACTION:CHANGE_SCHEDULE | 03:15 | 陪你聊天]]',
            { ...ctx, hooks: { ...ctx.hooks, notifyScheduleChangeFailed } },
        );

        expect(notifyScheduleChangeFailed).toHaveBeenCalledTimes(1);
        expect(notifyScheduleChangeFailed.mock.calls[0][0]).toContain('没有找到对得上的时段');
    });
});

