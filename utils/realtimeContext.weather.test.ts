import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    RealtimeContextManager,
    fetchOpenMeteoWeather,
    defaultRealtimeConfig,
    type RealtimeConfig,
} from './realtimeContext';

// 天气双源策略：有 OWM key 走 OWM，失败 / 没 key 回落免费的 Open-Meteo。
// Open-Meteo 路径 = geocoding（中文城市名 → 坐标）+ forecast（WMO code → 中文描述）。

function jsonResponse(body: any, ok = true, status = 200) {
    return {
        ok,
        status,
        // safeResponseJson 会读 content-type 判断响应体是不是 JSON，缺了会直接抛
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify(body),
    } as any;
}

const GEO_BEIJING = {
    results: [{ latitude: 39.9042, longitude: 116.4074, name: '北京市' }],
};

const METEO_CURRENT = {
    current: {
        temperature_2m: 21.3,
        apparent_temperature: 19.8,
        relative_humidity_2m: 55,
        weather_code: 61,
    },
};

const OWM_RESPONSE = {
    main: { temp: 20.6, feels_like: 19.2, humidity: 60 },
    weather: [{ description: '多云', icon: '03d' }],
    name: 'Beijing',
};

function makeConfig(overrides: Partial<RealtimeConfig>): RealtimeConfig {
    return { ...defaultRealtimeConfig, weatherEnabled: true, ...overrides };
}

beforeEach(() => {
    RealtimeContextManager.clearCache();
    vi.restoreAllMocks();
});

describe('fetchOpenMeteoWeather', () => {
    it('中文城市名 → geocoding → forecast，WMO code 映射成中文描述', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce(jsonResponse(GEO_BEIJING))
            .mockResolvedValueOnce(jsonResponse(METEO_CURRENT));

        const weather = await fetchOpenMeteoWeather('北京');

        expect(weather).toEqual({
            temp: 21, feelsLike: 20, humidity: 55,
            description: '小雨', icon: '10d', city: '北京市',
        });
        const geoUrl = vi.mocked(fetch).mock.calls[0][0] as string;
        expect(geoUrl).toContain('geocoding-api.open-meteo.com');
        expect(geoUrl).toContain(encodeURIComponent('北京'));
        const forecastUrl = vi.mocked(fetch).mock.calls[1][0] as string;
        expect(forecastUrl).toContain('latitude=39.9042');
    });

    it('同城市第二次调用命中 geocoding 缓存，只打 forecast', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce(jsonResponse(GEO_BEIJING))
            .mockResolvedValue(jsonResponse(METEO_CURRENT));

        await fetchOpenMeteoWeather('缓存城');
        await fetchOpenMeteoWeather('缓存城');

        const geoCalls = vi.mocked(fetch).mock.calls
            .filter(c => (c[0] as string).includes('geocoding-api'));
        expect(geoCalls.length).toBe(1);
    });

    it('城市找不到时抛错', async () => {
        global.fetch = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
        await expect(fetchOpenMeteoWeather('不存在的地方')).rejects.toThrow('找不到城市');
    });

    it('未知 WMO code 描述兜底为「未知」', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce(jsonResponse(GEO_BEIJING))
            .mockResolvedValueOnce(jsonResponse({
                current: { ...METEO_CURRENT.current, weather_code: 42 },
            }));
        const weather = await fetchOpenMeteoWeather('未知码城');
        expect(weather.description).toBe('未知');
    });
});

describe('RealtimeContextManager.fetchWeather 双源策略', () => {
    it('没填 key 时直接走 Open-Meteo', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce(jsonResponse(GEO_BEIJING))
            .mockResolvedValueOnce(jsonResponse(METEO_CURRENT));

        const weather = await RealtimeContextManager.fetchWeather(
            makeConfig({ weatherApiKey: '', weatherCity: '北京' }));

        expect(weather?.description).toBe('小雨');
        const urls = vi.mocked(fetch).mock.calls.map(c => c[0] as string);
        expect(urls.some(u => u.includes('openweathermap'))).toBe(false);
    });

    it('填了 key 优先走 OWM', async () => {
        global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(OWM_RESPONSE));

        const weather = await RealtimeContextManager.fetchWeather(
            makeConfig({ weatherApiKey: 'k123', weatherCity: 'Beijing' }));

        expect(weather).toEqual({
            temp: 21, feelsLike: 19, humidity: 60,
            description: '多云', icon: '03d', city: 'Beijing',
            source: 'owm',
        });
        expect(vi.mocked(fetch).mock.calls[0][0]).toContain('openweathermap');
    });

    it('OWM 挂了自动回落 Open-Meteo（不再直接返回 null）', async () => {
        global.fetch = vi.fn()
            .mockResolvedValueOnce(jsonResponse({}, false, 503)) // OWM 不稳定
            .mockResolvedValueOnce(jsonResponse(GEO_BEIJING))
            .mockResolvedValueOnce(jsonResponse(METEO_CURRENT));

        const weather = await RealtimeContextManager.fetchWeather(
            makeConfig({ weatherApiKey: 'k123', weatherCity: '北京' }));

        expect(weather?.description).toBe('小雨');
        expect(weather?.city).toBe('北京市');
    });

    it('weatherEnabled=false 或城市为空时返回 null 且不发请求', async () => {
        global.fetch = vi.fn();
        expect(await RealtimeContextManager.fetchWeather(
            makeConfig({ weatherEnabled: false }))).toBeNull();
        expect(await RealtimeContextManager.fetchWeather(
            makeConfig({ weatherCity: '' }))).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('两个源都挂时返回 null 不抛错', async () => {
        global.fetch = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
        const weather = await RealtimeContextManager.fetchWeather(
            makeConfig({ weatherApiKey: '', weatherCity: '北京' }));
        expect(weather).toBeNull();
    });
});
