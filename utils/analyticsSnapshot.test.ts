/**
 * 会话级快照的回归护栏。
 *
 * 这里钉的是同一件事的两面：
 *   1. 该报的报到了——三态（开 / 配了没开 / 没配）不能塌成两态，
 *      塌了之后「试过然后放弃」会跟「压根没配」混成一格，决策会做反。
 *   2. 不该报的一个字都没出去——用户填的地址、密钥、token、自己起的名字。
 *
 * 第 2 条用「塞毒药」的方式测：把每一处用户可填的字段都填上能唯一识别的字符串，
 * 然后扫整份上报，一个片段都不许出现。这样以后谁加了新字段忘了收敛，
 * 不用改测试也会被抓到——逐字段断言做不到这一点。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { APIConfig, CharacterProfile, CloudBackupConfig, OSTheme, RealtimeConfig } from '../types';
import {
    amsg2Stage,
    collectAppearance,
    collectCharSettings,
    collectFeatureFlags,
    collectSARFeatureFlags,
    triState,
    type FeatureSources,
} from './analyticsSnapshot';
import { createBuiltinSullyLive2DConfig } from './builtinSullyLive2D';
import { createFishingMarketState, FISHING_MARKET_STORAGE_KEY } from './vrWorld/fishingMarket';
import { freshFamiliarity } from './vrWorld/sarFamiliarity/storageTypes';
import { USER_LOCATION_STORAGE_KEY } from './userLocationPrivacy';

/**
 * 毒药串：每一条都放进某个用户可填字段里。它们只要出现在上报里就是泄漏。
 * 挑得足够特别，避免跟正常枚举值（'custom'、'开'）撞车。
 */
const POISON = {
    url: 'https://secret-host.invalid/private-path',
    key: 'sk-SUPERSECRET1234567890',
    token: 'tok-USERPRIVATE-abcdef',
    myName: '我自己起的名字',
    city: '某个能定位到我的城市',
    dbId: 'db-0123456789abcdef',
    css: '.bubble{content:"我写的CSS"}',
};

it('聊天备注快照仅报开关，不含备注或非法开关内容', () => {
    for (const value of [true, false, undefined, POISON.key]) {
        const result = collectCharSettings([{ id: 'private', name: POISON.myName, description: POISON.token, chatShowRemark: value } as CharacterProfile], 'private');
        expect(result.聊天显示备注).toBe(value === true ? '有人开' : '都没开');
        for (const secret of Object.values(POISON)) expect(JSON.stringify(result)).not.toContain(secret);
    }
});

/** 全部字段都塞了毒药的实时感知配置。 */
function poisonedRealtimeConfig(overrides: Partial<RealtimeConfig> = {}): RealtimeConfig {
    return {
        userHolidays: { enabled: true, countryCode: POISON.city, subdivisionCode: POISON.myName, timeZone: POISON.url },
        weatherEnabled: true,
        weatherApiKey: POISON.key,
        weatherCity: POISON.city,
        newsEnabled: true,
        newsApiKey: POISON.key,
        notionEnabled: true,
        notionApiKey: POISON.token,
        notionDatabaseId: POISON.dbId,
        feishuEnabled: true,
        feishuAppId: POISON.token,
        feishuAppSecret: POISON.key,
        feishuBaseId: POISON.dbId,
        feishuTableId: POISON.dbId,
        xhsEnabled: true,
        xhsMcpConfig: {
            enabled: true,
            serverUrl: POISON.url,
            cookie: POISON.token,
            loggedInNickname: POISON.myName,
        },
        cacheMinutes: 30,
        ...overrides,
    };
}

function poisonedSources(overrides: Partial<FeatureSources> = {}): FeatureSources {
    return {
        realtimeConfig: poisonedRealtimeConfig(),
        cloudBackupConfig: {
            enabled: true,
            provider: 'webdav',
            webdavUrl: POISON.url,
            username: POISON.myName,
            password: POISON.key,
            remotePath: POISON.url,
            githubToken: POISON.token,
            githubOwner: POISON.myName,
        } as CloudBackupConfig,
        memoryPalaceConfig: {
            embedding: { apiKey: POISON.key },
            lightLLM: { apiKey: POISON.key },
            rerank: { enabled: true, apiKey: POISON.key },
        },
        remoteVectorConfig: {
            enabled: true,
            supabaseUrl: POISON.url,
            supabaseAnonKey: POISON.key,
        },
        apiConfig: {
            baseUrl: POISON.url,
            apiKey: POISON.key,
            ttsProvider: 'minimax',
        } as APIConfig,
        apiPresetCount: 2,
        vrIndependentApi: true,
        characters: [],
        // Worker 地址和共享密钥同样是用户填的，一起塞毒药。即时对话开关是布尔，
        // 放个 true 让「即时对话」那一格也走一遍扫毒。
        amsg2Global: { workerUrl: POISON.url, initializedAt: 1_700_000_000_000, instantChatEnabled: true },
        collaborationUsage: { sessions: 2, messages: 9, assets: 1 },
        ...overrides,
    };
}

/** 在这个角色的 2.0 面板里存过（或角色自己排过任务），挂着 n 条待触发任务。 */
function amsg2Char(id: string, pendingTasks = 0, enabled = true): CharacterProfile {
    return {
        id,
        name: POISON.myName,
        activeMsg2Config: {
            enabled,
            tasks: Array.from({ length: pendingTasks }, (_, i) => ({
                taskUuid: `${id}-task-${i}`,
                clientTaskId: `${id}-client-${i}`,
                status: 'scheduled',
                mode: 'auto',
                recurrenceType: 'none',
                // 排在明天，免得测试跑着跑着就过点了
                firstSendTime: new Date(Date.now() + 86_400_000).toISOString(),
            })),
        },
    } as unknown as CharacterProfile;
}

/** 从没碰过 2.0 的角色：config 整个缺失。 */
const untouchedChar = (id: string) =>
    ({ id, name: POISON.myName } as unknown as CharacterProfile);

/** 把一份上报摊平成一个字符串，用来扫毒药。 */
const flatten = (flags: Record<string, string>) => JSON.stringify(flags);

/** 断言整份上报里不含任何毒药片段。 */
function expectNoLeak(flags: Record<string, string>) {
    const dump = flatten(flags);
    for (const [label, secret] of Object.entries(POISON)) {
        expect(dump, `${label} 泄漏进了上报`).not.toContain(secret);
    }
}

beforeEach(() => {
    localStorage.clear();
});

describe('当前功能启用 · 不泄漏配置内容', () => {
    it('真实定位只报告开关，不报告坐标、Key、隐藏地点名或半径', () => {
        const location = { enabled: true, provider: 'amap', amapKey: 'LOC-KEY-POISON-801', regions: [
            { id: 'region-poison-802', name: '私密家庭地址-803', latitude: 31.123456, longitude: 121.654321, radiusKm: 3.456789 },
        ] };
        localStorage.setItem(USER_LOCATION_STORAGE_KEY, JSON.stringify(location));
        const flags = collectFeatureFlags(poisonedSources());
        expect(flags.真实定位).toBe('开');
        for (const secret of [location.amapKey, ...Object.values(location.regions[0])]) {
            expect(JSON.stringify(flags)).not.toContain(String(secret));
        }
        expectNoLeak(flags);
        localStorage.setItem(USER_LOCATION_STORAGE_KEY, JSON.stringify({ ...location, enabled: false }));
        expect(collectFeatureFlags(poisonedSources()).真实定位).toBe('关');
    });
    it('没有定位配置记关，坏配置记读取失败，不透传任何字段', () => {
        expect(collectFeatureFlags(poisonedSources()).真实定位).toBe('关');
        localStorage.setItem(USER_LOCATION_STORAGE_KEY, '{broken');
        expect(collectFeatureFlags(poisonedSources()).真实定位).toBe('读取失败');
        localStorage.setItem(USER_LOCATION_STORAGE_KEY, JSON.stringify({ enabled: POISON.key, regions: [], provider: POISON.url }));
        const flags = collectFeatureFlags(poisonedSources());
        expect(flags.真实定位).toBe('读取失败'); expectNoLeak(flags);
    });
    it('所有配置塞满密钥地址名字，上报里一个片段都不出现', () => {
        localStorage.setItem('aetheros.mcp.servers', JSON.stringify([
            { id: 'a', name: POISON.myName, url: POISON.url, enabled: true, tools: [{ name: 'x' }] },
        ]));
        localStorage.setItem('aetheros.luckin.mcpToken', POISON.token);
        localStorage.setItem('aetheros.mcd.mcpToken', POISON.token);
        localStorage.setItem('qqBridge:wsUrl', POISON.url);
        localStorage.setItem('study_api_config', JSON.stringify({ baseUrl: POISON.url, apiKey: POISON.key }));
        expectNoLeak(collectFeatureFlags(poisonedSources()));
    });

    it('上报值全是短枚举，不含 URL、密钥前缀或中文自定义名', () => {
        const flags = collectFeatureFlags(poisonedSources());
        for (const [field, value] of Object.entries(flags)) {
            expect(value, `${field} 看着像原始配置值`).not.toMatch(/https?:\/\/|sk-|tok-/);
            // 枚举和档位都很短。超长说明有人把原始值透传进来了。
            expect(value.length, `${field} 的值太长，像是原始配置`).toBeLessThanOrEqual(12);
        }
    });

    it('认不出的服务商收敛成 custom，不原样带出去', () => {
        const flags = collectFeatureFlags(poisonedSources({
            cloudBackupConfig: { enabled: true, provider: POISON.myName, webdavUrl: POISON.url } as unknown as CloudBackupConfig,
            apiConfig: { baseUrl: '', apiKey: POISON.key, ttsProvider: POISON.myName } as unknown as APIConfig,
        }));
        expect(flags.云端备份服务商).toBe('custom');
        expect(flags.语音合成).toBe('custom');
    });

    it('ElevenLabs 是受支持的语音服务商枚举', () => {
        const flags = collectFeatureFlags(poisonedSources({
            apiConfig: {
                baseUrl: '',
                apiKey: '',
                model: '',
                ttsProvider: 'elevenlabs',
                elevenLabsApiKey: POISON.key,
            } as APIConfig,
        }));
        expect(flags.语音合成).toBe('elevenlabs');
    });
});

describe('当前功能启用 · 三态不能塌成两态', () => {
    it('配了但关着，跟压根没配是两个值', () => {
        expect(triState(true, true)).toBe('开');
        expect(triState(true, false)).toBe('配了没开');
        expect(triState(false, false)).toBe('没配');
        // 没配却报开着是自相矛盾的状态，也归到「没配」。
        expect(triState(false, true)).toBe('没配');
    });

    it('即时对话只报开/关，关着和没配都算关', () => {
        expect(collectFeatureFlags(poisonedSources()).即时对话).toBe('开');
        expect(collectFeatureFlags(poisonedSources({
            amsg2Global: { workerUrl: '', initializedAt: undefined },
        })).即时对话).toBe('关');
    });

    it('填了小红书桥接地址但开关关着 → 配了没开', () => {
        const flags = collectFeatureFlags(poisonedSources({
            realtimeConfig: poisonedRealtimeConfig({ xhsEnabled: false }),
        }));
        expect(flags.小红书).toBe('配了没开');
    });

    it('飞书四件套没填全 → 没配（而不是靠开关判定）', () => {
        const flags = collectFeatureFlags(poisonedSources({
            realtimeConfig: poisonedRealtimeConfig({ feishuEnabled: true, feishuBaseId: '' }),
        }));
        expect(flags.飞书).toBe('没配');
    });

    it('点单 token 填了但开关关着 → 配了没开', () => {
        localStorage.setItem('aetheros.mcd.mcpToken', POISON.token);
        localStorage.setItem('aetheros.mcd.mcpEnabled', '0');
        expect(collectFeatureFlags(poisonedSources()).麦当劳点单).toBe('配了没开');
    });
});

describe('当前功能启用 · 开关值的判定', () => {
    it('智能语境区分全开、部分开和全关', () => {
        expect(collectFeatureFlags(poisonedSources({
            memoryPalaceConfig: { featureFlags: { recallRouter: true, interactionAdaptation: true, deepEngagement: true } },
        })).智能语境).toBe('全开');
        expect(collectFeatureFlags(poisonedSources({
            memoryPalaceConfig: { featureFlags: { recallRouter: true } },
        })).智能语境).toBe('部分开');
        expect(collectFeatureFlags(poisonedSources({ memoryPalaceConfig: {} })).智能语境).toBe('全关');
    });

    it('协同工作只报 count 分桶，不读取窗口、消息或文件内容', () => {
        const flags = collectFeatureFlags(poisonedSources({
            collaborationUsage: { sessions: 2, messages: 18, assets: 1 },
        }));
        expect(flags.协同工作).toBe('用过');
        expect(flags.协同窗口数).toBe('2-3');
        expect(flags.协同消息数).toBe('4+');
        expect(flags.协同文件数).toBe('1');
    });

    it("QQ 桥的 enabled 存 '0' 时算关着，不能当成「有值就是开」", () => {
        localStorage.setItem('qqBridge:wsUrl', POISON.url);
        localStorage.setItem('qqBridge:enabled', '0');
        expect(collectFeatureFlags(poisonedSources()).QQ桥接).toBe('配了没开');

        localStorage.setItem('qqBridge:enabled', '1');
        expect(collectFeatureFlags(poisonedSources()).QQ桥接).toBe('开');
    });

    it('MCP 分开数「配了几个 / 启用几个 / 连通几个」', () => {
        localStorage.setItem('aetheros.mcp.servers', JSON.stringify([
            { id: 'a', name: 'a', url: 'https://a.invalid', enabled: true, tools: [{ name: 'x' }] },
            { id: 'b', name: 'b', url: 'https://b.invalid', enabled: true, tools: [] },
            { id: 'c', name: 'c', url: 'https://c.invalid', enabled: false },
        ]));
        const flags = collectFeatureFlags(poisonedSources());
        expect(flags.自配MCP服务器).toBe('2-3');
        expect(flags.启用中的MCP服务器).toBe('2-3');
        // 只有一个真的发现到工具了——「加了但连不上」就是靠这个差值看出来的
        expect(flags.连通的MCP服务器).toBe('1');
    });

    it('主动消息 2.0 的四态不能塌：三关卡在哪一关要修的引导不一样', () => {
        expect(amsg2Stage(false, false, 0)).toBe('没配');
        expect(amsg2Stage(true, false, 0)).toBe('填了没连上');
        expect(amsg2Stage(true, true, 0)).toBe('连上没开角色');
        expect(amsg2Stage(true, true, 2)).toBe('开');
        // 地址删了但连接记录还在 / 备份里带着开着的角色配置：没地址就不可能工作
        expect(amsg2Stage(false, true, 3)).toBe('没配');
    });

    it('2.0 只填了地址没连上 → 不能报成已经在用', () => {
        const flags = collectFeatureFlags(poisonedSources({
            amsg2Global: { workerUrl: POISON.url },   // 没有 initializedAt
            characters: [amsg2Char('c1', 1)],
        }));
        expect(flags['主动消息2.0']).toBe('填了没连上');
    });

    it('从没碰过 2.0 的角色不算「开了」', () => {
        // config 缺失 = 用户在这个角色上没表过态，拿它数会把角色总数报成 2.0 用户数。
        const flags = collectFeatureFlags(poisonedSources({
            characters: [untouchedChar('a'), untouchedChar('b'), untouchedChar('c')],
        }));
        expect(flags['开了2.0的角色数']).toBe('0');
        expect(flags['主动消息2.0']).toBe('连上没开角色');
    });

    it('在面板里关掉的角色不计入，开着的才数', () => {
        const flags = collectFeatureFlags(poisonedSources({
            characters: [amsg2Char('a'), amsg2Char('b', 0, false), untouchedChar('c')],
        }));
        expect(flags['开了2.0的角色数']).toBe('1');
    });

    it('「单独关了即时对话的角色数」只数显式关掉的，跟随全局的不算', () => {
        // 角色级开关缺省是「跟随全局」（undefined），只有用户在角色面板里主动关才落 false。
        // 把 undefined 也当成关的话，这一格会变成角色总数，用它判断「这开关有没有人用」会判反。
        const turnedOff = (id: string) => {
            const ch = amsg2Char(id);
            (ch.activeMsg2Config as { instantChatEnabled?: boolean }).instantChatEnabled = false;
            return ch;
        };
        const flags = collectFeatureFlags(poisonedSources({
            characters: [turnedOff('a'), amsg2Char('b'), untouchedChar('c')],
        }));
        expect(flags['单独关了即时对话的角色数']).toBe('1');
    });

    it('不上报已经全局下线的主动消息 Push 加速', () => {
        // 那一层 FORCE_DISABLED 恒为关，报出来会被误读成「没人用」。
        localStorage.setItem('proactive_push_enabled_v1', 'true');
        expect(collectFeatureFlags(poisonedSources())).not.toHaveProperty('主动消息Push加速');
    });
});

describe('当前外观 · 不泄漏用户自己捏的东西', () => {
    it('自己起的主题名、字体、白框 CSS、提示音直链都不出去', () => {
        const theme = {
            skin: 'default',
            customFont: POISON.url,
            chatChromeCustomCss: POISON.css,
            chatSound: { src: POISON.url },
            chatBubbleFontSize: 18,
        } as unknown as OSTheme;
        const char = { id: 'c1', name: POISON.myName, bubbleStyle: POISON.myName } as unknown as CharacterProfile;

        const flags = collectAppearance(theme, char);
        expectNoLeak(flags);
        expect(flags.气泡主题).toBe('custom');
        expect(flags.自定义字体).toBe('用了');
        expect(flags.自定义白框CSS).toBe('用了');
        expect(flags.提示音).toBe('custom');
        // 开放数值只报调没调过，不报 18
        expect(flags.气泡字号).toBe('调过');
    });

    it('没设过的项报默认值，不缺席也不报 undefined', () => {
        const flags = collectAppearance({} as OSTheme, undefined);
        expect(flags.桌面皮肤).toBe('default');
        expect(flags.自定义字体).toBe('没用');
        expect(flags.提示音).toBe('没设');
        expect(Object.values(flags)).not.toContain(undefined);
    });
});

describe('当前角色设置 · 不泄漏角色内容', () => {
    const poisonedChar = (over: Partial<CharacterProfile> = {}) => ({
        id: 'c1',
        name: POISON.myName,
        persona: POISON.myName,
        chatSound: { src: POISON.url },
        ...over,
    } as unknown as CharacterProfile);

    it('角色名、设定、提示音直链都不出去', () => {
        const flags = collectCharSettings([poisonedChar()], 'c1');
        expectNoLeak(flags);
        expect(flags.角色提示音).toBe('custom');
    });

    it('默认关的开关问「有没有人开过」，只要一个角色开了就算', () => {
        const flags = collectCharSettings(
            [poisonedChar({ memoryPalaceEnabled: false }), poisonedChar({ memoryPalaceEnabled: true })],
            'c1',
        );
        expect(flags.记忆宫殿).toBe('有人开');
    });

    it('默认开的开关问「有没有人特意关掉」——否则答案永远是「有」', () => {
        const allDefault = collectCharSettings([poisonedChar(), poisonedChar()], 'c1');
        expect(allDefault.时间感知).toBe('都开着');

        const oneOff = collectCharSettings(
            [poisonedChar(), poisonedChar({ timeAwarenessEnabled: false })],
            'c1',
        );
        expect(oneOff.时间感知).toBe('有人关掉');
    });

    it('活跃角色找不到时回落到第一个，不崩', () => {
        const flags = collectCharSettings([poisonedChar()], 'not-exist');
        expect(flags.思考链风格).toBe('echo');
    });

    it('定时消息任务数是全部角色合计，不是当前活跃角色那一个', () => {
        // 只看活跃角色的话，这里会报 0——而这个人其实挂着 4 条任务。
        // 一个人挂十几个角色时，活跃角色恰好没排任务的概率很大。
        const flags = collectCharSettings(
            [amsg2Char('active', 0), amsg2Char('b', 2), amsg2Char('c', 2)],
            'active',
        );
        expect(flags.定时消息任务数).toBe('4+');
    });

    it('日常聊天协同和粤语只报有没有角色使用，不报是哪个角色', () => {
        const flags = collectCharSettings([
            poisonedChar(),
            poisonedChar({ chatCollaborationEnabled: true, chatVoiceLang: 'yue' }),
        ], 'c1');
        expect(flags.日常聊天协同).toBe('有人开');
        expect(flags.粤语语音).toBe('有人选');
        expectNoLeak(flags);
    });
});

describe('当前角色设置 · 桌面陪伴与通话形象', () => {
    /** 自己导过模型的角色。文件名是用户自己的，塞毒药盯着它别漏出去。 */
    const withImportedAvatar = (id: string, format: 'live2d' | 'vrm') => ({
        id,
        name: POISON.myName,
        videoAvatar: format === 'live2d'
            ? { version: 1, format, assetId: id, fileName: POISON.myName, modelPath: POISON.myName, byteLength: 1, fileCount: 3, importedAt: 1 }
            : { version: 1, format, assetId: id, fileName: POISON.myName, byteLength: 1, importedAt: 1 },
    } as unknown as CharacterProfile);

    /** 预置角色 Sully：开箱就绑着内置 Live2D，用户什么都没做。 */
    const builtinSullyChar = (id = 'sully') => ({
        id,
        name: 'Sully',
        videoAvatar: createBuiltinSullyLive2DConfig('balanced'),
    } as unknown as CharacterProfile);

    const plainChar = (id: string) => ({ id, name: POISON.myName } as unknown as CharacterProfile);

    it('内置 Sully 不算「自己导入」——它是开箱就绑着的，数进去人人至少 1', () => {
        const flags = collectCharSettings([builtinSullyChar(), plainChar('b')], 'sully');
        expect(flags.自己导入形象的角色数).toBe('0');
        expect(flags.导入的形象格式).toBe('没导入');
        expect(flags.内置Sully画质).toBe('2K');
    });

    it('自己导入的才数，全部角色一起数（不是只看活跃角色）', () => {
        const flags = collectCharSettings(
            [builtinSullyChar(), withImportedAvatar('b', 'live2d'), withImportedAvatar('c', 'vrm')],
            // 活跃角色是没导过模型的那个：只看它会把这个人报成 0
            'sully',
        );
        expect(flags.自己导入形象的角色数).toBe('2-3');
        expect(flags.导入的形象格式).toBe('都有');
    });

    it('只导过一种格式就报那一种', () => {
        expect(collectCharSettings([withImportedAvatar('a', 'live2d')], 'a').导入的形象格式).toBe('live2d');
        expect(collectCharSettings([withImportedAvatar('a', 'vrm')], 'a').导入的形象格式).toBe('vrm');
    });

    it('换到 4K 的人单独看得见，没用内置的不混进 2K', () => {
        const hd = { ...builtinSullyChar(), videoAvatar: createBuiltinSullyLive2DConfig('hd') } as CharacterProfile;
        expect(collectCharSettings([hd], 'sully').内置Sully画质).toBe('4K');
        expect(collectCharSettings([withImportedAvatar('a', 'vrm')], 'a').内置Sully画质).toBe('没用内置');
    });

    it('陪伴形象来源没设过报「动态模型」，主动换过的才落到另外两档', () => {
        const withSource = (id: string, source: string) => ({
            id,
            name: POISON.myName,
            companionAvatar: { version: 1, source, imageRef: POISON.url, fileName: POISON.myName },
        } as unknown as CharacterProfile);

        expect(collectCharSettings([plainChar('a')], 'a').桌面陪伴形象来源).toBe('动态模型');
        expect(collectCharSettings([withSource('a', 'upload')], 'a').桌面陪伴形象来源).toBe('静态图片');
        expect(collectCharSettings([withSource('a', 'date')], 'a').桌面陪伴形象来源).toBe('见面立绘');

        // 「换掉动态模型的角色数」只数主动换过的：没设过（undefined）和显式选回 model 都不算，
        // 把它们算进去的话这一格会变成角色总数，用它判断「有没有人要静态形象」会判反。
        const flags = collectCharSettings(
            [plainChar('a'), withSource('b', 'model'), withSource('c', 'upload'), withSource('d', 'date')],
            'a',
        );
        expect(flags.换掉动态模型的角色数).toBe('2-3');
    });

    it('模型文件名、图片引用都不出去', () => {
        const flags = collectCharSettings(
            [withImportedAvatar('a', 'live2d'), {
                id: 'b',
                name: POISON.myName,
                companionAvatar: { version: 1, source: 'upload', imageRef: POISON.url, fileName: POISON.myName },
            } as unknown as CharacterProfile],
            'a',
        );
        expectNoLeak(flags);
    });
});


describe('SAR / 私聊 / 周年赠礼快照', () => {
    it('无剧情存档算零，不新增本地记录', () => {
        const before = localStorage.length;
        expect(collectSARFeatureFlags()).toMatchObject({ 凯恩已触发对话数: '0', 艾文已触发对话数: '0' });
        expect(localStorage.length).toBe(before);
    });
    it.each([[0,'0'],[1,'1–5'],[5,'1–5'],[6,'6–10'],[10,'6–10'],[11,'11–20'],[20,'11–20'],[21,'21–30'],[30,'21–30'],[31,'31–40'],[40,'31–40'],[41,'41+']] as const)('完成 %i 段收敛到 %s，不上传剧情或选择', (count, bucket) => {
        const state = { ...createFishingMarketState(17), sarFamiliarity: freshFamiliarity() };
        for (let i=0; i<count; i++) state.sarFamiliarity.npcs.caian.completed[`${POISON.key}-${i}`] = { at: 1, flags: { private: POISON.myName } };
        localStorage.setItem(FISHING_MARKET_STORAGE_KEY, JSON.stringify(state));
        const flags = collectSARFeatureFlags();
        expect(flags).toMatchObject({ 凯恩已触发对话数: bucket, 艾文已触发对话数: '0' });
        expectNoLeak(flags);
    });
    it('包含正在进行的剧情并去重，不计尚未开始的候选', () => {
        const state = { ...createFishingMarketState(17), sarFamiliarity: freshFamiliarity() };
        const p = state.sarFamiliarity.npcs.caian;
        for (let i=1; i<=5; i++) p.completed[`C1-0${i}`] = { at: 1, flags: {} };
        p.offerId = 'C1-07'; p.queuedSceneIds = ['C1-08'];
        p.pending = { runId: POISON.key, sceneId: 'C1-05', nodeId: 'start', line: 0, revision: 0, startedAt: 1, flags: {}, drafts: {}, userName: POISON.myName };
        localStorage.setItem(FISHING_MARKET_STORAGE_KEY, JSON.stringify(state));
        expect(collectSARFeatureFlags().凯恩已触发对话数).toBe('1–5');
        p.pending.sceneId = 'C1-06';
        localStorage.setItem(FISHING_MARKET_STORAGE_KEY, JSON.stringify(state));
        const flags = collectSARFeatureFlags();
        expect(flags.凯恩已触发对话数).toBe('6–10');
        expectNoLeak(flags);
    });
    it('损坏存档不会伪装成零，也不阻断其他快照', () => {
        localStorage.setItem(FISHING_MARKET_STORAGE_KEY, POISON.key);
        expect(collectSARFeatureFlags()).toMatchObject({ 凯恩已触发对话数: '读取失败', 艾文已触发对话数: '读取失败', SAR角色: '未选择' });
    });
    it('明确开关进入枚举快照，字段内容与用户输入不泄漏', () => {
        localStorage.setItem('sully-chat-input-preferences-v1', JSON.stringify({ sendButtonGenerates: true, enterToSend: false, autoReply: true, private: POISON.key }));
        localStorage.setItem('vr_sar_club_state_v1', JSON.stringify({ npcPreference: 'hide', roomView: 'characters-hidden', introReaction: POISON.myName }));
        localStorage.setItem('vr_fishing_simple_mode', 'true');
        localStorage.setItem('vr_sar_session_theme_v1', 'light');
        localStorage.setItem('sullyos_first_anniversary_seen_v1', '1');
        const flags = collectSARFeatureFlags();
        expect(flags).toMatchObject({ 发送键生成: '开', 回车发送: '关', 自动回复: '开', SAR角色: '关', SAR房间显示: '隐藏角色', SAR简易钓鱼: '开', SAR对话配色: '浅色', 周年赠礼已阅: '是' });
        expectNoLeak(flags);
    });
    it('各新来源都塞入毒药也只输出缺省枚举', () => {
        localStorage.setItem('sully-chat-input-preferences-v1', JSON.stringify({ sendButtonGenerates: POISON.key, enterToSend: POISON.key, autoReply: POISON.key }));
        localStorage.setItem('vr_sar_club_state_v1', JSON.stringify({ npcPreference: POISON.key, roomView: POISON.key }));
        for (const key of ['vr_fishing_simple_mode','vr_sar_session_theme_v1','sullyos_first_anniversary_seen_v1']) localStorage.setItem(key, POISON.key);
        const flags = collectSARFeatureFlags();
        expect(flags).toMatchObject({ 发送键生成: '关', 回车发送: '开', 自动回复: '关', SAR角色: '未选择', SAR房间显示: '全部显示', SAR简易钓鱼: '关', SAR对话配色: '浅色', 周年赠礼已阅: '否' });
        expectNoLeak(flags);
    });
});

/**
 * event_data 的行数守卫。
 *
 * umami 把事件的每个属性单独存成 event_data 表的一行，所以「一条事件挂几个 key」
 * 直接就是「一次上报写几行」。这三条快照事件是全仓库仅有的、属性数量上双的事件，
 * 加起来占了那张表九成的体积——其余五百多个事件全是 0~1 个属性，合计不到一成。
 *
 * 所以这里钉的不是正确性，是成本。加 key 一直有种免费的错觉：写的时候只多一行代码，
 * 账单上是每个用户每次冷启动多一行。撞上限了别直接改这里的数字，先在那条事件里找找
 * 有没有已经不看了的 key——腾一格出来比加一格便宜。
 *
 * 上限是「当前值 + 2」：留一点顺手加的余量，又不至于让人一路加到六十都没人吭声。
 */
describe('快照事件的属性宽度', () => {
    const plainChar = (id: string) => ({ id, name: '小明' } as unknown as CharacterProfile);

    it('当前外观', () => {
        expect(Object.keys(collectAppearance({} as OSTheme, undefined)).length).toBeLessThanOrEqual(38);
    });

    it('当前角色设置', () => {
        expect(Object.keys(collectCharSettings([plainChar('a')], 'a')).length).toBeLessThanOrEqual(38);
    });

    it('SAR 发布功能保持小快照', () => {
        expect(Object.keys(collectSARFeatureFlags()).length).toBeLessThanOrEqual(10);
    });

    it('当前功能启用', () => {
        expect(Object.keys(collectFeatureFlags(poisonedSources())).length).toBeLessThanOrEqual(35);
    });
});


it('3D 家园快照只输出档位与内置配色，不泄漏用户内容',()=>{
 const theme={skin:'homely',homelyPalette:POISON.key,homelyLockedCharacterId:POISON.dbId} as unknown as OSTheme;
 const appearance=collectAppearance(theme,undefined);
 expect(appearance.居家配色).toBe('custom');expect(appearance.居家锁定角色).toBe('开');
 expect(collectAppearance({...theme,homelyPalette:'rose'},undefined).居家配色).toBe('rose');
 expect(collectAppearance({...theme,skin:'default'},undefined).居家配色).toBe('未使用');
 const chars=collectCharSettings([{id:POISON.dbId,name:POISON.myName,home3D:{rooms:[{name:POISON.city}],records:[{text:POISON.token}],autonomy:false,directSpeech:true},chibiStudio:{home3D:{state:{selected:{eyes:POISON.key}}}}} as unknown as CharacterProfile],POISON.dbId);
 expect(chars['3D家园角色数']).toBe('1');
 for(const secret of Object.values(POISON))expect(JSON.stringify([appearance,chars])).not.toContain(secret);
});
