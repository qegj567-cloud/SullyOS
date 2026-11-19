import AwarenessSwitch from './AwarenessSwitch';
import React, { useEffect, useState } from 'react';
import { browserHolidayCache, deviceTimeZone, HOLIDAY_COUNTRIES, holidayCountryName, loadHolidayCalendar, renderUserHoliday, type HolidayCalendar, type UserHolidayConfig } from '../../utils/userHolidays';
import { getLocalDateKey } from '../../utils/localDate';
import { MALAYSIA_HOLIDAY_REGIONS, malaysiaHolidayRegion } from '../../utils/malaysiaHolidayRegions';

const countryOptions = HOLIDAY_COUNTRIES.map(c => ({ code: c.countryCode, name: c.name, label: holidayCountryName(c.countryCode) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));

export default function UserHolidaySettings({ value, onChange }: { value: UserHolidayConfig; onChange: (value: UserHolidayConfig) => void }) {
    const [calendar, setCalendar] = useState<HolidayCalendar | null>(null);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    useEffect(() => {
        let active = true;
        setCalendar(null);
        if (!value.enabled || !value.countryCode) { setLoading(false); return; }
        setLoading(true);
        loadHolidayCalendar(value.countryCode, new Date().getFullYear(), browserHolidayCache).then(data => {
            if (active) { setCalendar(data); setLoading(false); }
        }).catch(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [value.enabled, value.countryCode]);
    const regions = value.countryCode === 'MY' ? MALAYSIA_HOLIDAY_REGIONS.map(r => r.code)
        : [...new Set(calendar?.days.flatMap(d => d.regions || []) || [])].sort();
    const today = calendar ? renderUserHoliday(value, getLocalDateKey(new Date()), calendar.days) : '';
    const needle = search.trim().toLowerCase();
    return <section className="space-y-3">
        <label className="flex items-center justify-between gap-3 text-sm font-bold text-amber-800">
            <span>节假日感知</span>
            <AwarenessSwitch aria-label="开启节假日感知" checked={value.enabled} onChange={e => onChange({ ...value, enabled: e.target.checked })} />
        </label>
        {value.enabled && <>
            <p className="text-xs text-amber-800/70 leading-relaxed">选择你生活的国家／地区。假期或调休补班时，在用户信息中加一句提醒，聊天、见面等场景共用；普通日期不额外提示。</p>
            <input aria-label="搜索国家或地区" placeholder="搜索国家／地区" value={search} onChange={e => setSearch(e.target.value)} className="w-full bg-white border border-amber-100 rounded-xl px-3 py-2 text-sm" />
            <select aria-label="生活所在国家或地区" value={value.countryCode} onChange={e => onChange({ ...value, countryCode: e.target.value, subdivisionCode: undefined, timeZone: deviceTimeZone() })} className="w-full bg-white border border-amber-100 rounded-xl px-3 py-2 text-sm">
                <option value="">请选择国家／地区</option>
                {countryOptions.filter(c => c.code === value.countryCode || c.label.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle) || c.code.toLowerCase().includes(needle)).map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
            {regions.length > 0 && <label className="block text-xs text-amber-900 space-y-1">
                <span>{value.countryCode === 'MY' ? '州属／联邦直辖区（可选）' : '地区范围（可选，ISO 地区代码）'}</span>
                <select aria-label="节假日地区范围" value={value.subdivisionCode || ''} onChange={e => onChange({ ...value, subdivisionCode: e.target.value || undefined })} className="w-full bg-white rounded-xl px-3 py-2 text-sm">
                    <option value="">只感知全国公共假期</option>
                    {value.subdivisionCode && !regions.includes(value.subdivisionCode) && <option value={value.subdivisionCode}>{value.subdivisionCode}（已保存）</option>}
                    {regions.map(code => {
                        const region = value.countryCode === 'MY' ? malaysiaHolidayRegion(code) : undefined;
                        return <option key={code} value={code}>{region ? `${region.name} · ${region.english}` : code}</option>;
                    })}
                </select>
            </label>}
            <p className="text-xs text-amber-800/70 leading-relaxed">日期跟随你的设备时区（{deviceTimeZone()}），与角色时区分开。实际休息以你的排班、日程为准；角色关闭时间感知时也不会收到这条提醒。</p>
            {value.countryCode && <div role="status" className="text-xs text-amber-900 leading-relaxed">
                {loading ? '正在读取年度日历…' : calendar ? <>
                    <div>已载入 {calendar.year} 年日历{value.countryCode === 'CN' ? '（含调休补班）' : ''}</div>
                    <div className="mt-1">{today || '今天没有匹配的公共假期或调休补班记录，不增加提醒。'}</div>
                </> : <div>暂时没有可用的年度数据，不会推测放假安排。</div>}
            </div>}
            <p className="text-[10px] text-amber-800/60">{value.countryCode === 'MY'
                ? '马来西亚使用 Malaysia Holiday API 整理的政府公告数据。建议选择州属以匹配当地假期；仅提醒数据源已收录的日期，不自行推算补假或临时安排。'
                : '中国年度安排据国务院公告整理，其他国家／地区使用 Nager.Date；未选地区时不包含仅在部分地区适用的假期。'}</p>
        </>}
    </section>;
}
