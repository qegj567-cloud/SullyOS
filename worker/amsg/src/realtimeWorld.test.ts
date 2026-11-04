/**
 * worker 侧「到点现拉外面的世界」的回归测试。
 *
 * 守的是几个一眼就穿帮的点：
 *   - 角色关掉时间感知，主动消息里也不能冒出今日节日（这个开关以前只在前台生效）
 *   - 这一段绝不能自带「当前真实时间」——时间由 fire_pack 的槽位填，两处都出就是两个钟
 *   - 拉不到就整段不要，不留半截；有快照就别重拉
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { buildRealtimeWorldBlock, AMSG_HOTNEWS_SNAPSHOT_KEY, AMSG_WEATHER_SNAPSHOT_KEY } from './realtimeWorld';
import type { AmsgToolConfig } from '../../../utils/amsgToolPack';

/** 上海时间 2026-12-25 12:00（圣诞节，用来验节日那一行）。 */
const NOW = Date.parse('2026-12-25T04:00:00Z');
const TZ = 'Asia/Shanghai';

const cfg = (extra: Partial<AmsgToolConfig> = {}): AmsgToolConfig => ({
    v: 1,
    proxyWorkerUrl: 'https://proxy.example.com',
    weatherEnabled: false,
    newsEnabled: false,
    notionEnabled: false,
    feishuEnabled: false,
    ...extra,
});

const weatherSnapshot = (city: string, fetchedAt: number) => ({
    key: AMSG_WEATHER_SNAPSHOT_KEY,
    value: JSON.stringify({
        city,
        data: { temp: 3, feelsLike: 1, humidity: 40, description: '小雪', icon: '13d', city },
        fetchedAt,
    }),
});

const hotNewsSnapshot = (id: string, platforms: string[], titles: string[], fetchedAt = NOW) => ({
    key: AMSG_HOTNEWS_SNAPSHOT_KEY,
    value: JSON.stringify({
        id, platforms, fetchedAt,
        items: titles.map((t) => ({ title: t, source: '微博' })),
    }),
});

const run = (args: {
    toolConfig: AmsgToolConfig;
    timeAwarenessEnabled?: boolean;
    globalRows?: Array<{ key: string; value: string }>;
    writeState?: any;
}) => buildRealtimeWorldBlock({
    toolConfig: args.toolConfig,
    timeAwarenessEnabled: args.timeAwarenessEnabled ?? true,
    tzId: TZ,
    nowMs: NOW,
    globalRows: args.globalRows ?? [],
    globalNamespace: 'amsg:global',
    writeState: args.writeState,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('时间感知开关跟到后台', () => {
    it('开着 → 今日节日照给（天气热搜没开也成段）', async () => {
        const out = await run({ toolConfig: cfg() });
        expect(out).toContain('🎉 今日特殊: 圣诞节');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('关掉 → 一个字都不提今天是什么日子', async () => {
        // 回归守卫：这个开关以前只在前台生效，主动消息照样在圣诞节问候。
        const out = await run({ toolConfig: cfg(), timeAwarenessEnabled: false });
        expect(out).toBe('');
    });

    it('关掉时间感知但开着天气 → 有天气没节日', async () => {
        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海' }),
            timeAwarenessEnabled: false,
            globalRows: [weatherSnapshot('上海', NOW)],
        });
        expect(out).toContain('实时天气');
        expect(out).not.toContain('今日特殊');
    });
});

describe('这一段永远不带自己的钟', () => {
    it('渲染结果里没有「当前真实时间」', async () => {
        // 时间由 fire_pack 的 AMSG_SLOT_CURRENT_TIME 填。这里再出一次，
        // 同一份提示词里就有两个钟，角色会照着其中一个说错话。
        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海' }),
            globalRows: [weatherSnapshot('上海', NOW)],
        });
        expect(out).toContain('真实世界感知系统');
        expect(out).not.toContain('当前真实时间');
    });
});

describe('天气快照', () => {
    it('同城半小时内 → 直接复用，不发请求', async () => {
        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海' }),
            globalRows: [weatherSnapshot('上海', NOW - 10 * 60_000)],
        });
        expect(out).toContain('🌤️ 【上海实时天气】');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('快照过期 → 重拉并写回', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({
            main: { temp: 5.4, feels_like: 2.2, humidity: 55 },
            weather: [{ description: '多云', icon: '03d' }],
            name: '上海',
        }), { status: 200 }));
        const writeState = vi.fn().mockResolvedValue({});

        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海', weatherApiKey: 'owm-key' }),
            globalRows: [weatherSnapshot('上海', NOW - 60 * 60_000)],
            writeState,
        });

        expect(out).toContain('气温 5°C（体感 2°C）');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [ns, rows] = writeState.mock.calls[0];
        expect(ns).toBe('amsg:global');
        expect(rows[0].key).toBe(AMSG_WEATHER_SNAPSHOT_KEY);
    });

    it('拉失败但手上有同城旧读数 → 先用旧的，且不写回（下次重试）', async () => {
        const writeState = vi.fn().mockResolvedValue({});
        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海', weatherApiKey: 'owm-key' }),
            globalRows: [weatherSnapshot('上海', NOW - 60 * 60_000)],
            writeState,
        });
        expect(out).toContain('小雪');
        expect(writeState).not.toHaveBeenCalled();
    });

    // 顶一小会儿可以，顶三天不行：这一段抬头写着「以下信息来自真实世界」，
    // 接口连挂几天就会顶着这块招牌一直播那场早就停了的雨。
    it('拉失败且旧读数超过保鲜上限 → 整段不说天气', async () => {
        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海', weatherApiKey: 'owm-key' }),
            globalRows: [weatherSnapshot('上海', NOW - 5 * 60 * 60_000)],
            timeAwarenessEnabled: false,
        });
        expect(out).toBe('');
    });

    it('拉失败且旧读数是别的城市 → 宁可不说天气', async () => {
        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海', weatherApiKey: 'owm-key' }),
            globalRows: [weatherSnapshot('北京', NOW)],
            timeAwarenessEnabled: false,
        });
        expect(out).toBe('');
    });
});

describe('热榜快照', () => {
    it('同时段同平台 → 复用，不发请求', async () => {
        const out = await run({
            toolConfig: cfg({ newsEnabled: true, newsPlatforms: ['weibo'] }),
            // 上海 12-25 12:00 落在 slot 3（午后）
            globalRows: [hotNewsSnapshot('2026-12-25#3', ['weibo'], ['某某官宣'])],
        });
        expect(out).toContain('- 某某官宣（微博）');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('平台配置变了 → 快照作废，重新拉', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({
            data: [{ title: '新的热搜', url: 'https://x' }],
        }), { status: 200 }));
        const writeState = vi.fn().mockResolvedValue({});

        const out = await run({
            toolConfig: cfg({ newsEnabled: true, newsPlatforms: ['zhihu'] }),
            globalRows: [hotNewsSnapshot('2026-12-25#3', ['weibo'], ['旧的'])],
            writeState,
        });

        expect(out).toContain('新的热搜');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(writeState.mock.calls[0][1][0].key).toBe(AMSG_HOTNEWS_SNAPSHOT_KEY);
    });

    it('拉不到 → 退回上个时段的，不留空段', async () => {
        const out = await run({
            toolConfig: cfg({ newsEnabled: true, newsPlatforms: ['weibo'] }),
            globalRows: [hotNewsSnapshot('2026-12-25#2', ['weibo'], ['上个时段的'])],
        });
        expect(out).toContain('上个时段的');
    });

    it('拉不到且快照是隔天的 → 整段不说热搜（那不叫「最近发生的事」了）', async () => {
        const out = await run({
            toolConfig: cfg({ newsEnabled: true, newsPlatforms: ['weibo'] }),
            globalRows: [hotNewsSnapshot('2026-12-23#3', ['weibo'], ['前天的'], NOW - 30 * 60 * 60_000)],
            timeAwarenessEnabled: false,
        });
        expect(out).toBe('');
    });
});

describe('全拉挂也不断链', () => {
    it('天气热搜都开、都拉不到、又关了时间感知 → 空串（槽位被抹平）', async () => {
        const out = await run({
            toolConfig: cfg({
                weatherEnabled: true, weatherCity: '上海', weatherApiKey: 'k',
                newsEnabled: true, newsPlatforms: ['weibo'],
            }),
            timeAwarenessEnabled: false,
        });
        expect(out).toBe('');
    });

    it('写快照失败不连累这次触发', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({
            main: { temp: 5, feels_like: 2, humidity: 55 },
            weather: [{ description: '多云', icon: '03d' }],
            name: '上海',
        }), { status: 200 }));
        const writeState = vi.fn().mockRejectedValue(new Error('D1 挂了'));

        const out = await run({
            toolConfig: cfg({ weatherEnabled: true, weatherCity: '上海', weatherApiKey: 'k' }),
            writeState,
        });
        expect(out).toContain('实时天气');
    });
});

it('selects a character city on the worker and never borrows another city’s cached weather',async()=>{
    const args={toolConfig:cfg({weatherEnabled:true,weatherCity:'北京',weatherCities:{a:'London'}}),timeAwarenessEnabled:false,tzId:TZ,nowMs:NOW,globalRows:[weatherSnapshot('London',NOW)],globalNamespace:'amsg:global'};
    expect(await buildRealtimeWorldBlock({...args,charId:'a'})).toContain('London');expect(fetchMock).not.toHaveBeenCalled();
    expect(await buildRealtimeWorldBlock({...args,charId:'b'})).not.toContain('London');expect(fetchMock).toHaveBeenCalled();
});
