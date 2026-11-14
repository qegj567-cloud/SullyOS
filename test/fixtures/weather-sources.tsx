import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import WeatherSourceSettings from '../../components/settings/WeatherSourceSettings';
import { normalizeFreeWeatherSource, type FreeWeatherSource } from '../../utils/realtimeWorldCore';

// 默认用模拟天气验收故障切换；只有 ?live=1 时才查询明确填写的城市，不取设备定位。
if (!new URLSearchParams(location.search).has('live')) {
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('open-meteo.com')) throw new TypeError('Failed to fetch');
        if (url.startsWith('https://wttr.in/')) return new Response(JSON.stringify({ current_condition: [{ temp_C: '15', FeelsLikeC: '13', humidity: '73', weatherCode: '116' }] }));
        return originalFetch(input, init);
    };
}
function Demo() {
    const [city, setCity] = useState('成都');
    const [apiKey, setApiKey] = useState('');
    const [value, setValue] = useState<FreeWeatherSource>(() => normalizeFreeWeatherSource(localStorage.getItem('qa-weather-source')));
    const [saved, setSaved] = useState(false);
    return <main><h1 className="text-xl font-bold my-5">实时感知</h1><section className="bg-emerald-50/50 rounded-2xl p-4 space-y-3">
        <h2 className="text-sm font-bold text-emerald-700">天气感知</h2>
        <label className="block text-xs">OpenWeatherMap API Key（可选）<input aria-label="天气 Key" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="留空可选免费源 1 / 2，无需注册" className="block w-full bg-white border border-emerald-200 rounded-xl px-3 py-2 mt-1" /></label>
        <label className="block text-xs">默认天气城市<input aria-label="默认天气城市" value={city} onChange={e => setCity(e.target.value)} className="block w-full bg-white border border-emerald-200 rounded-xl px-3 py-2 mt-1" /></label>
        <WeatherSourceSettings city={city} apiKey={apiKey} value={value} onChange={v => { setValue(v); setSaved(false); }} />
    </section><button className="w-full my-4 py-3 rounded-xl bg-violet-500 text-white text-sm font-bold" onClick={() => { localStorage.setItem('qa-weather-source', value); setSaved(true); }}>{saved ? '已保存' : '保存配置'}</button></main>;
}
createRoot(document.getElementById('root')!).render(<Demo />);
