// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WeatherSourceSettings from '../components/settings/WeatherSourceSettings';
import { clearGeocodeCache, type FreeWeatherSource } from './realtimeWorldCore';

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
let fetchMock: ReturnType<typeof vi.fn>;
const wttr = { current_condition: [{ temp_C: '15', FeelsLikeC: '13', humidity: '73', weatherCode: '116' }] };
const json = (body: unknown) => ({ ok: true, text: async () => JSON.stringify(body) });
const result = vi.fn();
beforeEach(() => {
    clearGeocodeCache();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); result.mockClear();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (city = '成都', apiKey = '') => act(() => root.render(React.createElement(WeatherSourceSettings, { city, apiKey, value: 'open-meteo', onChange: vi.fn(), onTestResult: result })));
const click = async (text: string) => act(async () => { [...host.querySelectorAll('button')].find(button => button.textContent === text)!.click(); });

it('留空显示两个免费源和各自测试按钮；预览使用自动切换', async () => {
    render();
    expect(host.querySelectorAll('input[type=radio]')).toHaveLength(2);
    expect(host.querySelector<HTMLInputElement>('input[value="open-meteo"]')!.checked).toBe(true);
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await click('测试源 1');
    expect(host.querySelector('[data-weather-status="open-meteo"]')!.textContent).toContain('连接失败');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(json(wttr));
    await click('测试源 2');
    expect(host.querySelector('[data-weather-status="wttr"]')!.textContent).toContain('免费源 2 · wttr.in');
    // 两个测试结果互不覆盖。
    expect(host.querySelector('[data-weather-status="open-meteo"]')!.textContent).toContain('连接失败');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(json(wttr));
    await click('预览天气（自动切换）');
    expect(host.querySelector('[data-weather-status="preview"]')!.textContent).toContain('已从免费源 1 · Open-Meteo自动切换');
    expect(host.querySelector('[data-weather-status="preview"]')!.textContent).toContain('成都，局部多云，15°C');
    expect(result.mock.calls).toEqual([[false], [true], [true]]);
});

it('选择免费源 2 后预览直接走源 2', async () => {
    function Demo() {
        const [value, onChange] = useState<FreeWeatherSource>('open-meteo');
        return React.createElement(WeatherSourceSettings, { city: '成都', apiKey: '', value, onChange });
    }
    act(() => root.render(React.createElement(Demo)));
    act(() => host.querySelector<HTMLInputElement>('input[value="wttr"]')!.click());
    fetchMock.mockResolvedValueOnce(json(wttr));
    await click('预览天气（自动切换）');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('wttr.in');
    expect(host.querySelector('[data-weather-status="preview"]')!.textContent).not.toContain('自动切换');
});

it('填 Key 后显示 OWM 测试，清空后恢复免费源选择', async () => {
    render('成都', 'key');
    expect(host.querySelectorAll('input[type=radio]')).toHaveLength(0);
    fetchMock.mockResolvedValueOnce(json({ main: { temp: 20, feels_like: 18, humidity: 70 }, weather: [{ description: '晴', icon: '01d' }], name: '成都' }));
    await click('测试 OpenWeatherMap');
    expect(fetchMock.mock.calls[0][0]).toContain('openweathermap');
    render('成都', '  ');
    expect(host.querySelectorAll('input[type=radio]')).toHaveLength(2);
    expect(host.querySelector('[data-weather-status="owm"]')).toBeNull();
});

it('修改城市后不显示旧请求的迟到结果，空白城市不发请求', async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render();
    await click('测试源 2');
    expect(host.querySelector<HTMLButtonElement>('button:disabled')).not.toBeNull();
    render('London');
    await act(async () => { resolve(json(wttr)); });
    expect(host.querySelector('[data-weather-status="wttr"]')).toBeNull();
    expect(result).not.toHaveBeenCalled();
    render(' ');
    await click('预览天气（自动切换）');
    expect(host.textContent).toContain('请先填写城市');
    expect(fetchMock).toHaveBeenCalledTimes(1);
});
