import { describe, it, expect } from 'vitest';
import { DatePrompts, DATE_STYLE_PRESETS, extractObservation, stripObservation, hasObservation, resolveObserveFields, OBSERVE_OPEN, OBSERVE_CLOSE } from './datePrompts';
import type { CharacterProfile, UserProfile, Message, MountedWorldbook } from '../types';
import { buildCharacterResponsePrinciples } from './characterResponsePrinciples';
import { buildChatRequestPayload } from './chatRequestPayload';
import { setElevenLabsModel, setTtsProvider, setVoicePromptOverrides } from './ttsProvider';

const makeChar = (overrides: Partial<CharacterProfile> = {}): CharacterProfile => ({
    id: 'char-1',
    name: '小白',
    avatar: '',
    description: '',
    systemPrompt: '你是小白，一个温柔的角色。',
    memories: [],
    ...overrides,
} as CharacterProfile);

const user: UserProfile = { name: '阿明', bio: '' } as UserProfile;

let msgId = 1;
const makeMsg = (overrides: Partial<Message> = {}): Message => ({
    id: msgId++,
    charId: 'char-1',
    role: 'user',
    type: 'text',
    content: '你好',
    timestamp: Date.now(),
    ...overrides,
});

const sysOf = (messages: Array<{ role: string; content: any }>): string => {
    const sys = messages.find(m => m.role === 'system');
    return typeof sys?.content === 'string' ? sys.content : '';
};
const lastUserOf = (messages: Array<{ role: string; content: any }>) =>
    messages.filter(m => m.role === 'user').slice(-1)[0];

describe('DatePrompts.buildSessionPayload', () => {
    const baseInput = (char: CharacterProfile) => ({
        char,
        userProfile: user,
        allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 开场白' }), makeMsg({ content: '我来了' })],
        emojis: [],
        userText: '我来了',
        variant: 'send' as const,
    });

    it('adds v4 audio directions inside VN dialogue while preserving the sprite and voice emotion channels', async () => {
        setTtsProvider('elevenlabs');
        setElevenLabsModel('eleven_v4');
        try {
            const { messages } = await DatePrompts.buildSessionPayload(baseInput(makeChar({ dateVoiceEnabled: true })));
            const sys = sysOf(messages);
            expect(sys).toContain('ElevenLabs v4');
            expect(sys).toContain('Audio Tags');
            expect(sys).toContain('放在台词引号内部');
            expect(sys).toContain('[v:xxx]');
            setVoicePromptOverrides({ dateVoice: '只按用户的见面语音规则' });
            const custom = await DatePrompts.buildSessionPayload(baseInput(makeChar({ dateVoiceEnabled: true })));
            expect(sysOf(custom.messages)).toContain('只按用户的见面语音规则');
            expect(sysOf(custom.messages)).not.toContain('ElevenLabs v4');
        } finally {
            setTtsProvider('minimax');
            setElevenLabsModel(undefined);
            setVoicePromptOverrides(undefined);
        }
    });

    it('默认注入电影感风格块，不注入人称块', async () => {
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(makeChar()));
        const sys = sysOf(messages);
        expect(sys).toContain('风格：电影感');
        expect(sys).toContain('Visual Novel Mode');
        expect(sys).not.toContain('叙事人称');
    });

    it('按 dateStyleConfig.style 切换风格块', async () => {
        for (const preset of DATE_STYLE_PRESETS) {
            const char = makeChar({ dateStyleConfig: { style: preset.id } });
            const { messages } = await DatePrompts.buildSessionPayload(baseInput(char));
            expect(sysOf(messages)).toContain(`风格：${preset.label}`);
        }
    });

    it('pov=third-name 注入双名字人称规则', async () => {
        const char = makeChar({ dateStyleConfig: { pov: 'third-name' } });
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(char));
        const sys = sysOf(messages);
        expect(sys).toContain('叙事人称');
        expect(sys).toContain('小白看向阿明');
    });

    it('pov=third-you / first-you 注入对应示例', async () => {
        const thirdYou = await DatePrompts.buildSessionPayload(baseInput(makeChar({ dateStyleConfig: { pov: 'third-you' } })));
        expect(sysOf(thirdYou.messages)).toContain('小白看向你');
        const firstYou = await DatePrompts.buildSessionPayload(baseInput(makeChar({ dateStyleConfig: { pov: 'first-you' } })));
        expect(sysOf(firstYou.messages)).toContain('我看向你');
    });

    it('extra 自定义补充原样进入提示词', async () => {
        const char = makeChar({ dateStyleConfig: { extra: '不要写心理活动，多写对话。' } });
        const { messages } = await DatePrompts.buildSessionPayload(baseInput(char));
        const sys = sysOf(messages);
        expect(sys).toContain('额外要求');
        expect(sys).toContain('不要写心理活动，多写对话。');
    });

    it('细节深挖默认开启：方法块进 system，聚焦线索进末尾 note；关闭后两者都消失', async () => {
        const on = await DatePrompts.buildSessionPayload(baseInput(makeChar()));
        expect(sysOf(on.messages)).toContain('深挖，别填充');
        expect(lastUserOf(on.messages).content).toContain('本轮线索');

        const off = await DatePrompts.buildSessionPayload(baseInput(makeChar({ dateStyleConfig: { digDeeper: false } })));
        expect(sysOf(off.messages)).not.toContain('深挖，别填充');
        expect(lastUserOf(off.messages).content).not.toContain('本轮线索');
        // ContextBuilder 的全 App 通用精简版（表达底线）不受 digDeeper 开关影响，常驻
        expect(sysOf(off.messages)).toContain('表达底线');
    });

    it('本轮 user 带 System Note，末尾 system 收束角色原则；reroll 的 note 不同', async () => {
        const send = await DatePrompts.buildSessionPayload(baseInput(makeChar()));
        expect(send.messages[0].role).toBe('system');
        const lastSend = lastUserOf(send.messages);
        expect(lastSend.role).toBe('user');
        expect(lastSend.content).toContain('我来了');
        expect(lastSend.content).toContain('System Note');
        expect(lastSend.content).not.toContain('Reroll');

        const reroll = await DatePrompts.buildSessionPayload({ ...baseInput(makeChar()), variant: 'reroll' });
        const lastReroll = lastUserOf(reroll.messages);
        expect(lastReroll.content).toContain('Reroll');
        for (const result of [send, reroll]) {
            expect(result.messages.slice(-1)[0].role).toBe('system');
            expect(result.messages.slice(-1)[0].content).toContain('面对面的角色与回应');
        }
    });

    it('没有模块状态时，Date system prompt 不增加 SAR 文本或输出容器', async () => {
        const { messages } = await DatePrompts.buildSessionPayload({
            ...baseInput(makeChar({ vrState: { enabled: true, intervalMinutes: 120 } })),
            userProfile: { ...user, vrState: { enabled: true } },
        });
        const sys = sysOf(messages);
        expect(sys).not.toContain('### SAR 临时模块');
        expect(sys).not.toContain('<SAR_MODULE_OUTPUT>');
    });
});

describe('跨场景角色原则', () => {
    it('ChatApp 与见面发送、重生成、开场共用完整的表达原则，且只注入一次', async () => {
        const char = makeChar();
        const allMsgs = [makeMsg({ content: '今天不想出门，就坐会儿吧。' })];
        const shared = buildCharacterResponsePrinciples(char.name, user.name);
        const chat = await buildChatRequestPayload({
            char, userProfile: user, groups: [], emojis: [], categories: [],
            historyMsgs: allMsgs, contextLimit: 20,
        });
        const send = await DatePrompts.buildSessionPayload({
            char, userProfile: user, allMsgs, emojis: [], userText: allMsgs[0].content, variant: 'send',
        });
        const reroll = await DatePrompts.buildSessionPayload({
            char, userProfile: user, allMsgs, emojis: [], userText: allMsgs[0].content, variant: 'reroll',
        });
        const peek = (await DatePrompts.buildPeekPayload({ char, userProfile: user, allMsgs, emojis: [] }));
        for (const messages of [chat.fullMessages, send.messages, reroll.messages, peek.messages]) {
            const text = messages.map(m => m.content).join('\n');
            expect(text.split(shared)).toHaveLength(2);
            expect(messages.slice(-1)[0].content).toContain(shared);
        }
        expect(lastUserOf(send.messages).content).toContain(allMsgs[0].content);
        expect(lastUserOf(reroll.messages).content).toContain('不必加强情绪或推进关系');
        expect(peek.messages.slice(-1)[0].content).toContain('不新增用户的到场动作');
    });

    it.each(DATE_STYLE_PRESETS)('$id 文风下仍保留人物差异、用户自主权和稳定情绪', async preset => {
        const char = makeChar({ dateStyleConfig: { style: preset.id, digDeeper: false } });
        const { messages } = await DatePrompts.buildSessionPayload({
            char, userProfile: user, allMsgs: [makeMsg()], emojis: [], userText: '你好', variant: 'send',
        });
        expect(sysOf(messages)).toContain(`风格：${preset.label}`);
        expect(sysOf(messages)).toContain('[normal] 用于确实平静或中性的状态，不是默认占位符');
        expect(sysOf(messages)).toContain('同一情绪延续时，相邻行可以重复标签');
        expect(sysOf(messages)).toContain('不为了凑标签种类制造情绪');
        const tail = messages.slice(-1)[0].content;
        expect(tail).toContain('文风只决定怎样描写');
        expect(tail).toContain('不必变成统一的温柔口吻');
        expect(tail).toContain('不替对方写下接受、回应或关系升级');
        expect(tail).toContain('推测保留不确定');
        expect(tail).toContain('已有亲密和热烈也可以自然延续');
    });
});

describe('OBSERVE 观测协议', () => {
    const block = `${OBSERVE_OPEN}
时间｜傍晚六点过，天刚擦黑
地点｜便利店门口的塑料凳上
状态｜有点疲惫，但见到你眼神亮了一下
细节｜指尖无意识地敲着关东煮的纸杯
${OBSERVE_CLOSE}`;

    it('开关打开时注入观测块提示词，关闭时不注入', async () => {
        const on = await DatePrompts.buildSessionPayload({
            char: makeChar({ dateObserve: { enabled: true } }),
            userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 开场' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        expect(sysOf(on.messages)).toContain('观测协议');
        expect(sysOf(on.messages)).toContain(OBSERVE_OPEN);

        const off = await DatePrompts.buildSessionPayload({
            char: makeChar(),
            userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 开场' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        expect(sysOf(off.messages)).not.toContain('观测协议');
    });

    it('自定义维度：hint 注入提示词，label 只改 HUD（线格式仍用固定中文 key）', async () => {
        const { messages } = await DatePrompts.buildSessionPayload({
            char: makeChar({ dateObserve: {
                enabled: true,
                fields: { state: { label: '心情指数', hint: '用一个温度词概括此刻心情' } },
            } }),
            userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 开场' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        const sys = sysOf(messages);
        expect(sys).toContain('用一个温度词概括此刻心情'); // 自定义 hint 进了提示词
        expect(sys).toContain('状态｜');                    // 线格式字段名仍是固定的「状态」
        expect(sys).not.toContain('心情指数｜');            // 自定义 label 不进线格式（避免解析失配）
    });

    it('禁用某维度后，提示词里不再出现该字段', async () => {
        const { messages } = await DatePrompts.buildSessionPayload({
            char: makeChar({ dateObserve: { enabled: true, fields: { detail: { enabled: false } } } }),
            userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 开场' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        const sys = sysOf(messages);
        expect(sys).toContain('观测协议');
        expect(sys).toContain('时间｜');
        expect(sys).not.toContain('细节｜');
    });

    it('四个维度全部禁用时不注入观测块', async () => {
        const { messages } = await DatePrompts.buildSessionPayload({
            char: makeChar({ dateObserve: { enabled: true, fields: {
                time: { enabled: false }, place: { enabled: false }, state: { enabled: false }, detail: { enabled: false },
            } } }),
            userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 开场' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        expect(sysOf(messages)).not.toContain('观测协议');
    });

    it('resolveObserveFields 合并默认+自定义并过滤禁用', () => {
        const char = makeChar({ name: '阿狸', dateObserve: { enabled: true, fields: {
            place: { label: '坐标' }, detail: { enabled: false },
        } } });
        const fields = resolveObserveFields(char.dateObserve, char.name);
        expect(fields.map(f => f.key)).toEqual(['time', 'place', 'state']); // detail 被过滤
        expect(fields.find(f => f.key === 'place')!.display).toBe('坐标');   // 自定义展示标签
        expect(fields.find(f => f.key === 'place')!.label).toBe('地点');     // 线格式字段名不变
        expect(fields.find(f => f.key === 'place')!.hint).toContain('阿狸'); // {name} 已替换
    });

    it('追加自定义维度：hint 进提示词、label 进线格式与硬性要求', async () => {
        const { messages } = await DatePrompts.buildSessionPayload({
            char: makeChar({ dateObserve: {
                enabled: true,
                custom: [{ id: 'c1', label: '穿着', hint: '今天穿了什么、整不整齐', enabled: true }],
            } }),
            userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 开场' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        const sys = sysOf(messages);
        expect(sys).toContain('穿着｜');
        expect(sys).toContain('今天穿了什么、整不整齐');
        expect(sys).toContain('「穿着」'); // 出现在「标签必须原样用」清单里
    });

    it('extractObservation 解析自定义维度到 extra（需传 custom）', () => {
        const fields = [{ id: 'c1', label: '穿着', enabled: true }];
        const full = `${OBSERVE_OPEN}\n时间｜黄昏\n地点｜天台\n穿着｜松垮的灰色卫衣\n${OBSERVE_CLOSE}\n[normal] 嗨。`;
        const { observation, rest } = extractObservation(full, { custom: fields });
        expect(observation!.time).toBe('黄昏');
        expect(observation!.extra?.c1).toBe('松垮的灰色卫衣');
        expect(rest).toBe('[normal] 嗨。');
        // 不传 custom 时，自定义行不会被解析成字段（留在 rest 或被忽略）
        const noCustom = extractObservation(full);
        expect(noCustom.observation!.extra?.c1).toBeUndefined();
    });

    it('回退层也能吃自定义维度（凑够 2 个维度）', () => {
        const fields = [{ id: 'c1', label: '天气', enabled: true }];
        const t = `天气｜下着小雨\n状态｜缩着脖子\n[normal] 快进来。`;
        const { observation, rest } = extractObservation(t, { lenient: true, custom: fields });
        expect(observation!.extra?.c1).toBe('下着小雨');
        expect(observation!.state).toBe('缩着脖子');
        expect(rest).toBe('[normal] 快进来。');
    });

    it('禁用 / 空标签的自定义维度不参与注入与解析', async () => {
        const char = makeChar({ dateObserve: { enabled: true, custom: [
            { id: 'c1', label: '穿着', enabled: false },
            { id: 'c2', label: '', enabled: true },
        ] } });
        const { messages } = await DatePrompts.buildSessionPayload({
            char, userProfile: user, allMsgs: [makeMsg({ role: 'assistant', content: '[normal] 开场' }), makeMsg({ content: 'hi' })],
            emojis: [], userText: 'hi', variant: 'send',
        });
        expect(sysOf(messages)).not.toContain('穿着｜');
        expect(resolveObserveFields(char.dateObserve, char.name).filter(f => f.isCustom)).toHaveLength(0);
    });

    it('extractObservation 解析四字段并剥出正文', () => {
        const full = `${block}\n[normal] 抬眼看你。\n[happy] "你来啦。"`;
        const { observation, rest } = extractObservation(full);
        expect(observation).not.toBeNull();
        expect(observation!.time).toContain('傍晚六点');
        expect(observation!.place).toContain('便利店');
        expect(observation!.state).toContain('疲惫');
        expect(observation!.detail).toContain('纸杯');
        expect(rest).toContain('[normal] 抬眼看你。');
        expect(rest).not.toContain(OBSERVE_OPEN);
        expect(rest).not.toContain('时间｜');
    });

    it('解析对半角竖线/英文 key/冒号容错', () => {
        const alt = `${OBSERVE_OPEN}\nTIME: dusk\nplace | a rooftop\n状态：calm\nDETAIL：a slow breath\n${OBSERVE_CLOSE}`;
        const { observation } = extractObservation(alt);
        expect(observation!.time).toBe('dusk');
        expect(observation!.place).toBe('a rooftop');
        expect(observation!.state).toBe('calm');
        expect(observation!.detail).toBe('a slow breath');
    });

    it('没有观测块时原样返回，observation 为 null', () => {
        const plain = '[normal] 普通的一行。\n[happy] "嗨。"';
        const { observation, rest } = extractObservation(plain);
        expect(observation).toBeNull();
        expect(rest).toBe(plain);
        expect(hasObservation(observation)).toBe(false);
    });

    it('stripObservation 去块保正文；hasObservation 判定有效性', () => {
        expect(stripObservation(`${block}\n[normal] 正文`)).toBe('[normal] 正文');
        expect(hasObservation({ time: '黄昏' })).toBe(true);
        expect(hasObservation({})).toBe(false);
        expect(hasObservation(null)).toBe(false);
    });

    // ── 鲁棒性：模型掉格式时的各种降级路径 ──
    describe('掉格式容错', () => {
        it('换括号风格【】/<>/[] 仍能严格提取', () => {
            for (const [open, close] of [['【OBSERVE】', '【/OBSERVE】'], ['<观测>', '</观测>'], ['[OBSERVE]', '[/OBSERVE]']]) {
                const t = `${open}\n时间｜清晨\n地点｜阳台\n状态｜没睡醒\n细节｜揉眼睛\n${close}\n[normal] 早。`;
                const { observation, rest } = extractObservation(t, { lenient: true });
                expect(observation, `${open} 应被识别`).not.toBeNull();
                expect(observation!.place).toBe('阳台');
                expect(rest).toBe('[normal] 早。');
            }
        });

        it('丢了闭合定界符：靠回退层从开头连续字段行还原', () => {
            const t = `${OBSERVE_OPEN}\n时间｜午后\n地点｜旧书店\n状态｜慵懒\n细节｜指尖划过书脊\n[normal] 你也来了。\n[happy] "找什么书？"`;
            const { observation, rest } = extractObservation(t, { lenient: true });
            expect(observation).not.toBeNull();
            expect(observation!.time).toBe('午后');
            expect(observation!.detail).toBe('指尖划过书脊');
            expect(rest.startsWith('[normal] 你也来了。')).toBe(true);
            expect(rest).not.toContain('时间｜');
            expect(rest).not.toContain(OBSERVE_OPEN);
        });

        it('完全没定界符 + markdown 加粗 / 列表符 / 半角冒号：回退层照样吃', () => {
            const t = `**时间**：黄昏\n- 地点: 天台\n状态｜风很大\n细节｜头发被吹乱\n\n[normal] 抓住栏杆。`;
            const { observation, rest } = extractObservation(t, { lenient: true });
            expect(observation).not.toBeNull();
            expect(observation!.time).toBe('黄昏');
            expect(observation!.place).toBe('天台');
            expect(observation!.state).toBe('风很大');
            expect(rest).toBe('[normal] 抓住栏杆。');
        });

        it('回退层未开启（lenient=false）时不强行解析，避免误伤', () => {
            const t = `时间｜午后\n地点｜旧书店\n[normal] 正文。`;
            const { observation, rest } = extractObservation(t);
            expect(observation).toBeNull();
            expect(rest).toBe(t);
        });

        it('只有 1 个字段不触发回退（防止正文里偶发的"状态：…"被误吞）', () => {
            const t = `状态：他看起来在想事情\n[normal] 走神了。`;
            const { observation, rest } = extractObservation(t, { lenient: true });
            expect(observation).toBeNull();
            expect(rest).toBe(t);
        });

        it('正文中部出现 field 样式的旁白不被回退层吞掉（只扫开头连续段）', () => {
            const t = `[normal] 她开口。\n时间｜其实没人知道现在几点\n地点｜也无所谓`;
            const { observation, rest } = extractObservation(t, { lenient: true });
            expect(observation).toBeNull();
            expect(rest).toBe(t);
        });
    });
});

describe('见面里的世界书', () => {
    const wb = (overrides: Partial<MountedWorldbook>): MountedWorldbook => ({
        id: 'wb', title: '条目', content: '条目正文', category: '测试', ...overrides,
    });
    const history = () => [
        makeMsg({ role: 'assistant', content: '[normal] 开场白' }),
        makeMsg({ content: '第二句' }),
        makeMsg({ role: 'assistant', content: '[happy] 第三句' }),
        makeMsg({ content: '我来了' }),
    ];
    const sessionInput = (char: CharacterProfile, userText = '我来了') => ({
        char, userProfile: user, allMsgs: history(), emojis: [], userText, variant: 'send' as const,
    });
    const contents = (messages: Array<{ content: any }>) => messages.map(m => String(m.content));

    it('会话：「聊天记录指定深度」条目按深度插进对话，本轮 user 消息算最后一条', async () => {
        const char = makeChar({
            mountedWorldbooks: [
                wb({ id: 'tail', content: '深度零的文风', position: 4, depth: 0, role: 0 }),
                wb({ id: 'deep', content: '深度二的思考要求', position: 4, depth: 2, role: 0 }),
            ],
        });
        const { messages } = await DatePrompts.buildSessionPayload(sessionInput(char));
        const texts = contents(messages);

        // 深度 0 紧随本轮 user；收尾原则不参与对话深度计数。
        const tailIndex = texts.indexOf('深度零的文风');
        const tail = messages[tailIndex];
        expect(tail).toEqual({ role: 'system', content: '深度零的文风' });
        expect(messages[tailIndex - 1].content).toContain('System Note');
        expect(messages[tailIndex + 1].content).toContain('面对面的角色与回应');

        // 深度 2：插在倒数第 2 条对话之前（[开场白, 第二句, 第三句, 本轮] → 第三句前）
        const deepIndex = texts.indexOf('深度二的思考要求');
        expect(messages[deepIndex].role).toBe('system');
        expect(texts[deepIndex + 1]).toContain('第三句');

        // 不会混进 system prompt 里重复一份
        expect(sysOf(messages)).not.toContain('深度零的文风');
        expect(sysOf(messages)).not.toContain('深度二的思考要求');
    });

    it('会话：关键词条目能被历史或本轮输入触发，没提到就不注入', async () => {
        const char = makeChar({
            mountedWorldbooks: [
                wb({ id: 'from-history', content: '钟楼的设定', constant: false, key: ['第三句'], scanDepth: 4 }),
                wb({ id: 'from-input', content: '月亮的设定', constant: false, key: ['月亮'], scanDepth: 4 }),
                wb({ id: 'depth-kw', content: '雨天的状态', constant: false, key: ['下雨'], position: 4, depth: 0 }),
                wb({ id: 'miss', content: '海边的设定', constant: false, key: ['海边'], scanDepth: 4 }),
            ],
        });
        const { messages } = await DatePrompts.buildSessionPayload(sessionInput(char, '今晚月亮好圆，还下雨了'));
        const sys = sysOf(messages);
        expect(sys).toContain('钟楼的设定');
        expect(sys).toContain('月亮的设定');
        expect(sys).not.toContain('海边的设定');
        expect(contents(messages)).toContain('雨天的状态');
        expect(contents(messages).join('\n')).not.toContain('海边的设定');
    });

    it('开场感知：深度条目和关键词条目同样生效', async () => {
        const char = makeChar({
            mountedWorldbooks: [
                wb({ id: 'tail', content: '深度零的文风', position: 4, depth: 0 }),
                wb({ id: 'deep', content: '深度四的提醒', position: 4, depth: 4, role: 1 }),
                wb({ id: 'kw', content: '钟楼的设定', constant: false, key: ['第三句'], scanDepth: 4 }),
            ],
        });
        const { messages } = await DatePrompts.buildPeekPayload({ char, userProfile: user, allMsgs: history(), emojis: [] });
        // 开场感知保留实际历史边界；扫描材料不再压成单条任务消息。
        const deepIndex = messages.findIndex(m => m.content === '深度四的提醒');
        const tailIndex = messages.findIndex(m => m.content === '深度零的文风');
        expect(deepIndex).toBe(1);
        expect(messages[deepIndex].role).toBe('user');
        expect(messages[deepIndex + 1].content).toContain('开场白');
        expect(messages[tailIndex - 1].content).toContain('我来了');
        expect(messages[tailIndex + 1].content).toContain('Start sensing');
        expect(sysOf(messages)).toContain('钟楼的设定');
    });
});

describe('DatePrompts.buildPeekPayload', async () => {
    it('让他靠近读取同一份上下文与世界书，只改变开场发起者，保留用户自主权', async () => {
        const char = makeChar({ mountedWorldbooks: [{
            id: 'place', title: '常去的店', content: '在街角书店见面', category: '地点', constant: true,
        }] });
        const input = { char, userProfile: user, allMsgs: [makeMsg({ content: '我还在书店等你。' })], emojis: [] };
        const approach = await DatePrompts.buildPeekPayload(input);
        const invite = await DatePrompts.buildPeekPayload({ ...input, openingMode: 'invite' });
        for (const { messages } of [approach, invite]) {
            expect(JSON.stringify(messages)).toContain('我还在书店等你。');
            expect(sysOf(messages)).toContain('在街角书店见面');
            expect(lastUserOf(messages).content).toContain('不强制续接上一句话');
        }
        expect(lastUserOf(approach.messages).content).toContain('用户正在悄悄靠近');
        expect(lastUserOf(invite.messages).content).toContain('由你主动以合理的方式');
        expect(lastUserOf(invite.messages).content).not.toContain('用户正在悄悄靠近');
        expect(invite.messages.slice(-1)[0].content).toContain('不代写用户反应');
        expect(invite.messages.slice(-1)[0].content).not.toContain('用户尚未走近');
    });
    it('描写风格短语跟随风格预设；extra 追加进指令', async () => {
        const char = makeChar({ dateStyleConfig: { style: 'plain', extra: '环境描写多一点。' } });
        const { messages } = await DatePrompts.buildPeekPayload({
            char, userProfile: user, allMsgs: [makeMsg()], emojis: [],
        });
        const userMsg = lastUserOf(messages).content as string;
        expect(userMsg).toContain('简洁白描');
        expect(userMsg).toContain('环境描写多一点。');
        // peek 刻意保持第三人称旁观，不注入 pov 人称块
        expect(userMsg).toContain('第三人称');
    });

    it('历史里的卡片消息被压成摘要，原始 HTML/JSON 不进 prompt', async () => {
        const rawHtml = '<div style="color:red">巨大的原始HTML</div>';
        const msgs = [
            makeMsg({ type: 'html_card' as any, role: 'assistant', content: `[HTML卡片] ${rawHtml}`, metadata: { htmlTextPreview: '一张卡片' } }),
            makeMsg({ content: '看到了' }),
        ];
        const { messages } = (await DatePrompts.buildPeekPayload({
            char: makeChar(), userProfile: user, allMsgs: msgs, emojis: [],
        }));
        const userMsg = lastUserOf(messages).content as string;
        expect(userMsg).not.toContain(rawHtml);
        expect(JSON.stringify(messages)).toContain('一张卡片');
    });
});

 describe('见面世界书注入回归', () => {
    const book = (id: string, overrides: Record<string, unknown> = {}) => ({
        id, title: id, content: `WB_${id}`, constant: true, position: 4 as const,
        depth: 4, role: 0 as const, ...overrides,
    });
    const history = () => Array.from({ length: 6 }, (_, i) => makeMsg({
        role: i % 2 ? 'user' : 'assistant', content: `记录${i}`,
    }));

    it.each(['send', 'reroll'] as const)('%s: 两本 depth=4/system 均完整进入实际请求且顺序稳定', async variant => {
        const char = makeChar({ mountedWorldbooks: [book('D'), book('E')] });
        const { messages } = await DatePrompts.buildSessionPayload({
            char, userProfile: user, allMsgs: history(), emojis: [], userText: '记录5', variant,
        });
        const d = messages.findIndex(m => m.content === 'WB_D');
        expect(d).toBe(3); // 顶层 system + 前两条历史
        expect(messages[d]).toEqual({ role: 'system', content: 'WB_D' });
        expect(messages[d + 1]).toEqual({ role: 'system', content: 'WB_E' });
        expect(messages.slice(d + 2, -1)).toHaveLength(4);
        expect(JSON.stringify(messages).match(/WB_D/g)).toHaveLength(1);
    });

    it('短历史也注入；depth=0 保留消息角色与宏，不把 VN 指令追加给世界书', async () => {
        const char = makeChar({ mountedWorldbooks: [book('D'), book('Z', {
            depth: 0, role: 2, content: '{{char}}与{{user}}',
        })] });
        const { messages } = await DatePrompts.buildSessionPayload({
            char, userProfile: user, allMsgs: [makeMsg()], emojis: [], userText: '你好', variant: 'send',
        });
        expect(messages[1]).toEqual({ role: 'system', content: 'WB_D' });
        expect(messages[2].content).toContain('你好\n\n(System Note:');
        expect(messages[3]).toEqual({ role: 'assistant', content: '小白与阿明' });
    });

    it('所有位置都用本轮对话匹配关键词，禁用/未命中不注入，系统指令不参与匹配', async () => {
        const char = makeChar({ mountedWorldbooks: [
            ...[0, 1, 2, 3, 4, 5, 6].map(position => book(`P${position}`, {
                position, constant: false, key: ['灯塔'],
            })),
            book('disabled', { disable: true }),
            book('miss', { constant: false, key: ['不存在'] }),
            book('instruction', { constant: false, key: ['System Note'] }),
            book('principles', { constant: false, key: ['面对面的角色与回应'] }),
        ] });
        const result = await DatePrompts.buildSessionPayload({
            char, userProfile: user, allMsgs: [makeMsg({ content: '灯塔' })],
            emojis: [], userText: '灯塔', variant: 'send',
        });
        const json = JSON.stringify(result.messages);
        for (let i = 0; i < 7; i++) expect(json).toContain(`WB_P${i}`);
        for (const id of ['disabled', 'miss', 'instruction', 'principles']) expect(json).not.toContain(`WB_${id}`);
    });

    it('感知开场由公共上下文带入深度条目，并支持关键词匹配', async () => {
        const { messages } = await DatePrompts.buildPeekPayload({
            char: makeChar({ mountedWorldbooks: [book('D'), book('K', {
                position: 1, constant: false, key: ['记录5'],
            })] }), userProfile: user, allMsgs: history(), emojis: [],
        });
        expect(messages[0].content).toContain('WB_K');
        expect(messages.find(m => m.content === 'WB_D')?.role).toBe('system');
        expect(JSON.stringify(messages).split('WB_D')).toHaveLength(2);
    });

    it('关闭线下时间感知时，感知与会话都不泄漏今日日程、神经链接记忆日期或记忆宫殿现实日期标注', async () => {
        const char = makeChar({
            dateTimeAwarenessEnabled: false,
            scheduleConfig: { enabled: true, style: 'conscious' },
            refinedMemories: { '2026-10': '一起在旧书店躲雨' },
            activeMemoryMonths: ['2026-10'],
            memories: [{ id: 'm1', date: '2026-10-14', summary: '借走了一本诗集', mood: 'warm' }],
            memoryPalaceEnabled: true,
            memoryPalaceInjection: [
                '### 记忆宫殿 (Memory Palace)',
                '📌 **便利贴（近期重要事项）**',
                '- [2026年11月3日（今天）] 记得还书（对应日期：2026年11月4日）（剩余 5 天）',
                '**[客厅 · 共同经历]** (2026年11月2日（昨天）, 重要性: 4)',
                '在车站挥手告别（对应日期：2026年11月2日）',
                '**[书房 · 重要事件]** 📦 **事件盒：雨夜**',
                '_整合回忆_ (2026年10月30日（4天前）, 重要性 5, 已压缩 1 次)',
                '两人在屋檐下聊到很晚',
                '_新增片段_：',
                '- [2026年11月1日（前天）] 约好下次去海边（对应日期：2026年11月1日）',
            ].join('\n'),
        });
        const peek = await DatePrompts.buildPeekPayload({
            char, userProfile: user, allMsgs: [makeMsg({ content: '推开书店的门。' })], emojis: [],
        });
        const session = await DatePrompts.buildSessionPayload({
            char, userProfile: user, allMsgs: [makeMsg({ content: '推开书店的门。' })], emojis: [], userText: '推开书店的门。', variant: 'send',
        });

        for (const payload of [peek.messages, session.messages]) {
            const text = payload.map(m => String(m.content)).join('\n');
            expect(text).toContain('一起在旧书店躲雨');
            expect(text).toContain('在车站挥手告别');
            expect(text).toContain('两人在屋檐下聊到很晚');
            expect(text).toContain('约好下次去海边');
            expect(text).not.toContain('2026-10');
            expect(text).not.toContain('2026-10-14');
            expect(text).not.toContain('2026年11月');
            expect(text).not.toContain('2026年10月');
            expect(text).not.toContain('对应日期');
            expect(text).not.toContain('剩余 5 天');
            expect(text).not.toContain('你今天的完整日程');
        }
        expect(sysOf(session.messages)).toContain('借走了一本诗集');
        expect(lastUserOf(peek.messages).content).not.toContain('如果刚聊完');
        expect(lastUserOf(peek.messages).content).toContain('根据最近记录中的剧情进展');
    });
});
