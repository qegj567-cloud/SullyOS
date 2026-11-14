import React, { useEffect, useId, useRef, useState } from 'react';
import { fetchWeatherFromSource, fetchWeatherOrThrow, WEATHER_SOURCE_LABELS, type FreeWeatherSource, type WeatherSource } from '../../utils/realtimeWorldCore';

type TestTarget = WeatherSource | 'preview';
type TestStatus = { busy?: boolean; ok?: boolean; text: string };
interface Props {
    city: string;
    apiKey: string;
    value: FreeWeatherSource;
    onChange: (source: FreeWeatherSource) => void;
    onTestResult?: (ok: boolean) => void;
}

export default function WeatherSourceSettings({ city, apiKey, value, onChange, onTestResult }: Props) {
    const group = useId();
    const [statuses, setStatuses] = useState<Partial<Record<TestTarget, TestStatus>>>({});
    const generation = useRef(0);
    const busy = useRef(new Set<TestTarget>());
    useEffect(() => {
        generation.current++;
        busy.current.clear();
        setStatuses({});
        return () => { generation.current++; };
    }, [city, apiKey, value]);

    const test = async (target: TestTarget) => {
        if (busy.current.has(target)) return;
        const setStatus = (status: TestStatus) => setStatuses(previous => ({ ...previous, [target]: status }));
        if (!city.trim()) { setStatus({ ok: false, text: '请先填写城市' }); return; }
        const atStart = generation.current;
        busy.current.add(target);
        setStatus({ busy: true, text: target === 'preview' ? '正在获取天气…' : '正在测试…' });
        try {
            const weather = target === 'preview'
                ? await fetchWeatherOrThrow(city, apiKey, value)
                : await fetchWeatherFromSource(city, target, apiKey);
            if (generation.current !== atStart) return;
            const source = WEATHER_SOURCE_LABELS[weather.source!];
            const switched = weather.fallbackFrom ? `已从${WEATHER_SOURCE_LABELS[weather.fallbackFrom]}自动切换。` : '';
            setStatus({ ok: true, text: `${switched}${source}：${weather.city}，${weather.description}，${weather.temp}°C（体感 ${weather.feelsLike}°C）` });
            onTestResult?.(true);
        } catch (error) {
            if (generation.current !== atStart) return;
            setStatus({ ok: false, text: `连接失败：${error instanceof Error ? error.message : '请稍后重试'}` });
            onTestResult?.(false);
        } finally {
            if (generation.current === atStart) busy.current.delete(target);
        }
    };
    const status = (target: TestTarget) => statuses[target] && <p role="status" data-weather-status={target} className={`text-xs leading-5 break-words ${statuses[target]?.ok === false ? 'text-rose-600' : 'text-emerald-700'}`}>{statuses[target]?.text}</p>;
    const button = (target: TestTarget, label: string, full = false) => <button type="button" disabled={statuses[target]?.busy} onClick={() => void test(target)} className={`${full ? 'w-full' : 'shrink-0'} min-h-10 px-3 py-2 bg-emerald-100 text-emerald-700 text-xs font-bold rounded-xl disabled:opacity-50`}>{statuses[target]?.busy ? '查询中…' : label}</button>;

    return <div className="space-y-3">
        {!apiKey.trim() ? <fieldset className="space-y-2">
            <legend className="text-xs font-bold text-emerald-800 mb-2">首选免费天气源</legend>
            {(['open-meteo', 'wttr'] as const).map((source, index) => <div key={source} className="rounded-xl border border-emerald-200 bg-white/80 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                    <label className="flex min-w-0 items-center gap-2 text-xs text-slate-700 cursor-pointer">
                        <input type="radio" name={group} value={source} checked={value === source} onChange={() => onChange(source)} className="accent-emerald-600" />
                        <span><strong className="block">免费源 {index + 1}{index === 0 ? '（默认）' : ''}</strong><span className="text-slate-500">{source === 'wttr' ? 'wttr.in' : 'Open-Meteo'}</span></span>
                    </label>
                    {button(source, `测试源 ${index + 1}`)}
                </div>
                {status(source)}
            </div>)}
            <p className="text-[11px] leading-5 text-slate-500">两者均无需 Key。预览和聊天先用所选源，失败时自动尝试另一个；单源测试只检查对应服务。</p>
        </fieldset> : <div className="space-y-2">{button('owm', '测试 OpenWeatherMap', true)}{status('owm')}<p className="text-[11px] leading-5 text-slate-500">优先使用已填写的 Key，失败后自动尝试免费天气源。</p></div>}
        {button('preview', '预览天气（自动切换）', true)}
        {status('preview')}
    </div>;
}
