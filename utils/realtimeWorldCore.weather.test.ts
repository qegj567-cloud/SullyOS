import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearGeocodeCache, fetchOpenMeteoWeather, fetchWeatherWithFallback, fetchWeatherOrThrow, fetchWeatherFromSource, fetchWttrWeather } from './realtimeWorldCore';

const geo = { results: [{ latitude: 39.9075, longitude: 116.39723, name: '北京' }] };
const meteo = { current: { temperature_2m: 21.3, apparent_temperature: 19.8, relative_humidity_2m: 55, weather_code: 61 } };
const wttr = { current_condition: [{ temp_C: '15', FeelsLikeC: '13', humidity: '73', weatherCode: '116', weatherDesc: [{ value: 'Partly cloudy' }] }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    clearGeocodeCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('两个免费源的选择、测试与自动切换', () => {
    it('免费源 1 的天气域名连不上时，预览自动使用源 2 并标明实际来源', async () => {
        fetchMock.mockResolvedValueOnce(json(geo)).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(json(wttr));
        expect(await fetchWeatherOrThrow('成都')).toMatchObject({ temp: 15, feelsLike: 13, humidity: 73, description: '局部多云', city: '成都', source: 'wttr', fallbackFrom: 'open-meteo' });
        expect(fetchMock.mock.calls.map(call => new URL(call[0]).hostname)).toEqual(['geocoding-api.open-meteo.com', 'api.open-meteo.com', 'wttr.in']);
    });

    it('源 1 的城市接口也不可达时，源 2 独立按城市查询', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(json(wttr));
        expect((await fetchWeatherWithFallback('成都'))?.source).toBe('wttr');
        expect(new URL(fetchMock.mock.calls[1][0]).pathname).toBe('/' + encodeURIComponent('成都'));
    });

    it('选择源 2 后不先碰 Open-Meteo；源 2 的天气代码转换为中文', async () => {
        fetchMock.mockResolvedValueOnce(json(wttr));
        expect(await fetchWeatherOrThrow('London', '', 'wttr')).toMatchObject({ city: 'London', source: 'wttr', description: '局部多云' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('https://wttr.in/London?format=j1&lang=zh');
    });

    it('源 2 失败后仅回落一次源 1', async () => {
        fetchMock.mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json(geo)).mockResolvedValueOnce(json(meteo));
        expect(await fetchWeatherOrThrow('北京', '', 'wttr')).toMatchObject({ source: 'open-meteo', fallbackFrom: 'wttr', temp: 21 });
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('有 Key 时仍先用 OWM，失败后按免费源偏好回落', async () => {
        fetchMock.mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(json(wttr));
        expect(await fetchWeatherOrThrow('成都', 'key', 'wttr')).toMatchObject({ source: 'wttr', fallbackFrom: 'owm' });
        expect(new URL(fetchMock.mock.calls[0][0]).hostname).toBe('api.openweathermap.org');
        expect(new URL(fetchMock.mock.calls[1][0]).hostname).toBe('wttr.in');
    });

    it('单源测试失败就报失败，不被另一源的成功掩盖', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(fetchWeatherFromSource('成都', 'open-meteo')).rejects.toThrow('城市查询连接失败');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('全部失败时预览保留两源原因，聊天返回 null', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(json({}, 503)));
        await expect(fetchWeatherOrThrow('成都')).rejects.toThrow(/Open-Meteo.*503.*wttr.in.*503/);
        expect(await fetchWeatherWithFallback('成都')).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('首选源的城市与天气共享时间预算，超时后仍留时间给备用源', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(json(geo)), 3_000)))
            .mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(json(wttr));
        const pending = fetchWeatherOrThrow('成都');
        await vi.advanceTimersByTimeAsync(4_000);
        expect((await pending).source).toBe('wttr');
        expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('两个源都挂起也会在后台总预算内结束', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation(() => new Promise(() => {}));
        const pending = fetchWeatherWithFallback('成都');
        await vi.advanceTimersByTimeAsync(8_000);
        expect(await pending).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls.every(call => call[1].signal.aborted)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([null, '', 'not-a-number'])('备用源缺失温度 %s 时拒绝结果', async temp => {
        fetchMock.mockResolvedValueOnce(json({ current_condition: [{ ...wttr.current_condition[0], temp_C: temp }] }));
        await expect(fetchWttrWeather('成都')).rejects.toThrow('数据不完整');
    });

    it.each(['', ' ', '.', '..', 'https://example.com', '@example.com'])('备用源不把 %s 变成按 IP 定位', async city => {
        await expect(fetchWttrWeather(city)).rejects.toThrow();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('免费天气实际失败路径', () => {
    it('城市全称没有结果时重试简称，并按原输入缓存成功结果', async () => {
        fetchMock.mockResolvedValueOnce(json({ generationtime_ms: 0.1 }))
            .mockResolvedValueOnce(json(geo))
            .mockImplementation(() => Promise.resolve(json(meteo)));
        expect((await fetchOpenMeteoWeather(' 北京市 ')).temp).toBe(21);
        expect((await fetchOpenMeteoWeather('北京市')).temp).toBe(21);
        const urls = fetchMock.mock.calls.map(call => new URL(call[0]));
        expect(urls.filter(url => url.hostname.startsWith('geocoding')).map(url => url.searchParams.get('name')))
            .toEqual(['北京市', '北京']);
    });

    it('已经能找到的市名保持原样，不截断海外地名', async () => {
        fetchMock.mockResolvedValueOnce(json({ results: [{ latitude: 34.9667, longitude: 136.6167, name: '四日市' }] }))
            .mockResolvedValueOnce(json(meteo));
        expect((await fetchOpenMeteoWeather('四日市')).city).toBe('四日市');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('全称和简称都不存在时停止，不查询其他城市天气', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(json({})));
        await expect(fetchOpenMeteoWeather('不存在市')).rejects.toThrow('找不到城市');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('城市接口网络失败时说明失败阶段，不当成无结果继续换城市查询', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(fetchOpenMeteoWeather('北京市')).rejects.toThrow('Open-Meteo 城市查询连接失败');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('天气限流显示 HTTP 状态和重试提示', async () => {
        fetchMock.mockResolvedValueOnce(json(geo)).mockResolvedValueOnce(json({}, 429));
        await expect(fetchOpenMeteoWeather('北京')).rejects.toThrow('Open-Meteo 天气服务 HTTP 429，请求过多');
    });

    it('天气连接挂起时中止请求并结束等待，即使 fetch 不响应中止信号', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValueOnce(json(geo)).mockImplementationOnce(() => new Promise(() => {}));
        const pending = expect(fetchOpenMeteoWeather('北京')).rejects.toThrow('Open-Meteo 天气服务超时');
        await vi.advanceTimersByTimeAsync(8_000);
        await pending;
        expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('收到响应头后响应体卡住，同样受超时限制', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValue({ ok: true, text: () => new Promise(() => {}) });
        const pending = expect(fetchOpenMeteoWeather('北京')).rejects.toThrow('Open-Meteo 城市查询超时');
        await vi.advanceTimersByTimeAsync(8_000);
        await pending;
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([{}, { current: { ...meteo.current, temperature_2m: null } }])(
        '缺失天气字段时不伪造为 0°C 或 NaN', async body => {
            fetchMock.mockResolvedValueOnce(json(geo)).mockResolvedValueOnce(json(body));
            await expect(fetchOpenMeteoWeather('北京')).rejects.toThrow('天气数据不完整');
        },
    );

    it('无效城市坐标不会发起天气请求或污染缓存', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(json({ results: [{ name: '北京', latitude: null, longitude: 116 }] })));
        await expect(fetchOpenMeteoWeather('北京')).rejects.toThrow('城市数据不完整');
        await expect(fetchOpenMeteoWeather('北京')).rejects.toThrow('城市数据不完整');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls.every(call => String(call[0]).includes('geocoding-api'))).toBe(true);
    });

    it('只有空格的 Key 视为留空，不请求 OWM', async () => {
        fetchMock.mockResolvedValueOnce(json(geo)).mockResolvedValueOnce(json(meteo));
        expect(await fetchWeatherWithFallback(' 北京 ', '  ')).not.toBeNull();
        expect(fetchMock.mock.calls.some(call => String(call[0]).includes('openweathermap'))).toBe(false);
    });

    it('空白城市不发请求', async () => {
        expect(await fetchWeatherWithFallback('   ', 'key')).toBeNull();
        await expect(fetchOpenMeteoWeather('   ')).rejects.toThrow('请先填写城市');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('OWM 卡住时仍能在超时后回落免费天气', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementationOnce(() => new Promise(() => {}))
            .mockResolvedValueOnce(json(geo)).mockResolvedValueOnce(json(meteo));
        const pending = fetchWeatherWithFallback('北京', 'key');
        await vi.advanceTimersByTimeAsync(8_000);
        expect((await pending)?.description).toBe('小雨');
        expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});
