import { beforeEach, expect, it, vi } from 'vitest';
import { getCurrentPositionSmart } from './geo';
import { saveUserLocationConfig } from './userLocation';
import { USER_LOCATION_STORAGE_KEY } from './userLocationPrivacy';
import { buildChatRequestPayload } from './chatRequestPayload';
import { ContextBuilder } from './context';
import { ChatPrompts } from './chatPrompts';
import { RealtimeContextManager, defaultRealtimeConfig } from './realtimeContext';

vi.mock('./geo', async original => ({ ...await original<typeof import('./geo')>(), getCurrentPositionSmart: vi.fn() }));
const char = { id: 'geo-char', name: '阿泽', timeAwarenessEnabled: false, scheduleFeatureEnabled: false } as any;
const user = { name: '小雨' } as any;
const config = { enabled: true, regions: [{ id: 'home', name: '家', latitude: 31.2304, longitude: 121.4737, radiusKm: 3 }] };
beforeEach(() => {
    vi.clearAllMocks(); saveUserLocationConfig(config);
    vi.mocked(getCurrentPositionSmart).mockResolvedValue({ latitude: 31.2304, longitude: 121.4737, accuracy: 10 });
});

it.each([false, true])('local/instant-worker chat carries only the private label in live context (worker=%s)', async timelyByWorker => {
    const payload = await buildChatRequestPayload({ char, userProfile: user, groups: [], emojis: [], categories: [],
        recallEntryPoint: 'chat_app', timelyByWorker, contextLimit: 10,
        historyMsgs: [{ id: 1, charId: char.id, role: 'user', type: 'text', content: '在吗', timestamp: 1 }],
    });
    const sent = JSON.stringify(payload.fullMessages);
    expect(sent).toContain('小雨现在的定位在家附近');
    expect(sent).not.toContain('31.2304'); expect(sent).not.toContain('121.4737');
    expect(sent).toContain('小雨当前的位置');
    expect(sent).toContain('作为辅助参考背景信息，具体以小雨的说明为准');
    expect(String(payload.fullMessages[0].content)).not.toContain('小雨当前的位置');
    expect(sent).not.toContain('不推断对方在做什么');
    expect(sent).not.toContain('不要追问或猜测隐私区域');
});

it('explicit realtime call/date context can know the private range; fictional and non-conversation builds do not locate', async () => {
    const normal = await ContextBuilder.buildCharacterRequest({ char, user, timeOptions: { conversational: true, includeUserLocation: true } }, [{ role: 'user', content: '你好' }]);
    expect(JSON.stringify(normal)).toContain('在家附近');
    vi.mocked(getCurrentPositionSmart).mockClear();
    const fictional = await ContextBuilder.buildCharacterRequest({ char, user, timeOptions: { skipTimeAwareness: true, includeUserLocation: true } }, [{ role: 'user', content: '故事继续' }]);
    expect(JSON.stringify(fictional)).not.toContain('小雨当前的位置');
    await ContextBuilder.buildCharacterRequest({ char, user }, [{ role: 'user', content: '整理日记' }]);
    expect(getCurrentPositionSmart).not.toHaveBeenCalled();
});

it('scheduled fire-pack templates say unknown without capturing device data, even after a foreground lookup', async () => {
    const foreground = await buildChatRequestPayload({ char, userProfile: user, groups: [], emojis: [], categories: [],
        recallEntryPoint: 'chat_app', contextLimit: 10, historyMsgs: [],
    });
    expect(JSON.stringify(foreground.fullMessages)).toContain('在家附近');
    vi.mocked(getCurrentPositionSmart).mockClear();
    const parts = await ChatPrompts.buildSystemPromptParts(char, user, [], [], [], [], undefined, undefined, undefined, false, undefined, undefined, { forFirePack: true, includeUserLocation: true });
    const template = parts.stable + parts.volatileState + parts.recencyTail;
    expect(template).toContain('小雨现在的定位未知，作为辅助参考背景信息，具体以小雨的说明为准');
    for (const secret of ['家附近', '31.2304', '121.4737', '不推断', '不要追问']) expect(template).not.toContain(secret);
    expect(getCurrentPositionSmart).not.toHaveBeenCalled();
});
it('scheduled templates omit location when it is disabled or settings cannot be read', async () => {
    const build = async () => {
        const parts = await ChatPrompts.buildSystemPromptParts(char, user, [], [], [], [], undefined, undefined, undefined, false, undefined, undefined, { forFirePack: true });
        return parts.stable + parts.volatileState + parts.recencyTail;
    };
    saveUserLocationConfig({ ...config, enabled: false });
    expect(await build()).not.toContain('小雨当前的位置');
    localStorage.setItem(USER_LOCATION_STORAGE_KEY, '{broken');
    expect(await build()).not.toContain('小雨当前的位置');
    expect(getCurrentPositionSmart).not.toHaveBeenCalled();
});
it('local live location sits immediately after weather and before news, exactly once', async () => {
    const weather = vi.spyOn(RealtimeContextManager, 'fetchWeather').mockResolvedValue({ city: '演示市', description: '晴', temp: 20, feelsLike: 20, humidity: 50 } as any);
    const news = vi.spyOn(RealtimeContextManager, 'fetchNews').mockResolvedValue([{ title: '演示热点' }]);
    try {
        const parts = await ChatPrompts.buildSystemPromptParts(char, user, [], [], [], [], {
            ...defaultRealtimeConfig, weatherEnabled: true, newsEnabled: true,
            feishuEnabled: false, feishuAppId: '', feishuAppSecret: '', feishuBaseId: '', feishuTableId: '',
            xhsEnabled: false,
        }, undefined, undefined, false, undefined, undefined, { includeUserLocation: true });
        const text = parts.volatileState;
        expect(text.indexOf('实时天气')).toBeLessThan(text.indexOf('小雨现在的定位在家附近'));
        expect(text.indexOf('小雨现在的定位在家附近')).toBeLessThan(text.indexOf('演示热点'));
        expect(text.match(/小雨现在的定位在家附近/g)).toHaveLength(1);
    } finally { weather.mockRestore(); news.mockRestore(); }
});

it.each([false,true])('blocks non-selected characters before device access in local/instant chat (%s)',async timelyByWorker=>{
    saveUserLocationConfig({...config,characterIds:['someone-else']});
    const payload=await buildChatRequestPayload({char,userProfile:user,groups:[],emojis:[],categories:[],recallEntryPoint:'chat_app',timelyByWorker,contextLimit:10,historyMsgs:[]});
    expect(JSON.stringify(payload.fullMessages)).not.toContain('小雨当前的位置');
    const context=await ContextBuilder.buildCharacterRequest({char,user,timeOptions:{conversational:true,includeUserLocation:true}},[{role:'user',content:'在吗'}]);
    expect(JSON.stringify(context)).not.toContain('小雨当前的位置');
    expect(getCurrentPositionSmart).not.toHaveBeenCalled();
});
it('uses the selected city in local chat without changing the global default',async()=>{
    const weather=vi.spyOn(RealtimeContextManager,'fetchWeather').mockResolvedValue(null);
    try {
        const realtimeConfig={...defaultRealtimeConfig,weatherEnabled:true,weatherCity:'北京',weatherCities:{[char.id]:'London'}};
        await buildChatRequestPayload({char,userProfile:user,groups:[],emojis:[],categories:[],realtimeConfig,recallEntryPoint:'chat_app',contextLimit:10,historyMsgs:[]});
        expect(weather).toHaveBeenCalledWith(expect.objectContaining({weatherCity:'London'}));expect(realtimeConfig.weatherCity).toBe('北京');
    } finally {weather.mockRestore();}
});
