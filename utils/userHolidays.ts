/** User-local public holidays. Shared by browser and amsg; never infer a user's actual work schedule. */
import countries from '../presets/holidays/countries.json';
import china2026 from '../presets/holidays/cn-2026.json';
import { nowInTimeZone } from './timezone';
import { getLocalDateKey } from './localDate';
import { MALAYSIA_HOLIDAY_REGIONS, malaysiaHolidayRegion } from './malaysiaHolidayRegions';

export interface UserHolidayConfig {
    introChoice?: 'configure' | 'configured' | 'declined';
    enabled: boolean;
    countryCode: string;
    subdivisionCode?: string;
    /** Device timezone, captured by browser when syncing to worker. Never the character's timezone. */
    timeZone?: string;
}
export interface HolidayDay { date: string; name: string; off: boolean; regions?: string[] }
export interface HolidayCalendar { country: string; year: number; days: HolidayDay[]; fetchedAt: number }
export interface HolidayCache {
    read(key: string): Promise<unknown>;
    write(key: string, calendar: HolidayCalendar): Promise<unknown>;
}
export const HOLIDAY_CACHE_PREFIX = 'user_holidays_v1_';
export const HOLIDAY_NOTICE_KEY = 'sullyos_user_holidays_intro_v1';
const HOLIDAY_SETTINGS_FOCUS = 'sullyos_user_holidays_settings_focus';
export function requestHolidaySettings() { try { sessionStorage.setItem(HOLIDAY_SETTINGS_FOCUS, '1'); } catch { /* Settings still opens */ } }
export function hasHolidaySettingsRequest(): boolean {
    try { return sessionStorage.getItem(HOLIDAY_SETTINGS_FOCUS) === '1'; } catch { return false; }
}
export function consumeHolidaySettings(): boolean {
    try { const requested = sessionStorage.getItem(HOLIDAY_SETTINGS_FOCUS) === '1'; sessionStorage.removeItem(HOLIDAY_SETTINGS_FOCUS); return requested; } catch { return false; }
}
export function hasChosenHolidayIntro(): boolean {
    try {
        const config = JSON.parse(localStorage.getItem('os_realtime_config') || '{}').userHolidays;
        return !!config?.introChoice || config?.enabled === true;
    } catch { return true; } // Storage unavailable: do not repeatedly interrupt startup.
}
// Nager v3 does not serve MY; countries with a dedicated provider belong here too.
export const HOLIDAY_COUNTRIES = [...countries, { countryCode: 'MY', name: 'Malaysia' }];
export function holidayCountryName(code: string): string {
    try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code) || code; }
    catch { return HOLIDAY_COUNTRIES.find(c => c.countryCode === code)?.name || code; }
}
export const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const memory = new Map<string, HolidayCalendar>();
const inFlight = new Map<string, Promise<HolidayCalendar | null>>();
const retryAfter = new Map<string, number>();
const DAY = 86400000;
const cleanName = (name: unknown) => typeof name === 'string' ? name.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 80).trim() : '';
const validDate = (date: unknown): date is string => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);

export function parseHolidayCalendar(country: string, year: number, raw: any, now: number): HolidayCalendar | null {
    if (country === 'MY') {
        // Fetch the unfiltered annual endpoint: only it includes state_codes.
        // Empty/unpublished years are unavailable, never an authoritative no-holiday calendar.
        if (raw?.meta?.year !== year || !Array.isArray(raw.data) || !raw.data.length) return null;
        const states = new Map<string, string>(MALAYSIA_HOLIDAY_REGIONS.map(r => [r.sourceCode, r.code]));
        if (!raw.data.every((d: any) => validDate(d?.date) && d.date.startsWith(`${year}-`) && cleanName(d.name)
            && Array.isArray(d.state_codes) && d.state_codes.length > 0
            && d.state_codes.every((code: unknown) => typeof code === 'string' && states.has(code)))) return null;
        return { country, year, fetchedAt: now, days: raw.data.map((d: any) => {
            const regions = [...new Set<string>(d.state_codes.map((code: string) => states.get(code)!))];
            // Federal designation alone is insufficient: Deepavali, for example, excludes Sarawak.
            return { date: d.date, name: cleanName(d.name), off: true,
                ...(regions.length === states.size ? {} : { regions }) };
        }) };
    }
    if (country === 'CN') {
        // No annual announcement yet is unknown, not an empty official work calendar.
        if (raw?.year !== year || !Array.isArray(raw.papers) || !raw.papers.length || !Array.isArray(raw.days)) return null;
        if (!raw.days.every((d: any) => validDate(d?.date) && cleanName(d?.name) && typeof d?.isOffDay === 'boolean')) return null;
        return { country, year, fetchedAt: now, days: raw.days.map((d: any) => ({ date: d.date, name: cleanName(d.name), off: d.isOffDay })) };
    }
    if (!Array.isArray(raw) || !raw.every(d => validDate(d?.date) && d.countryCode === country && Array.isArray(d.types))) return null;
    return { country, year, fetchedAt: now, days: raw
        .filter(d => d.types.includes('Public') && cleanName(d.localName || d.name) && (d.global === true || Array.isArray(d.counties)))
        .map(d => ({ date: d.date, name: cleanName(d.localName || d.name), off: true,
            ...(d.global === true ? {} : { regions: d.counties.filter((v: unknown) => typeof v === 'string') }) })) };
}

function validCached(raw: any, country: string, year: number): raw is HolidayCalendar {
    return raw?.country === country && raw.year === year && Number.isFinite(raw.fetchedAt) && Array.isArray(raw.days)
        && raw.days.every((d: any) => validDate(d?.date) && typeof d.name === 'string' && d.name === cleanName(d.name)
            && typeof d.off === 'boolean' && (d.regions === undefined || (Array.isArray(d.regions) && d.regions.every((r: unknown) => typeof r === 'string'))));
}

export const browserHolidayCache: HolidayCache = {
    async read(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
    async write(key, data) { try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* quota / private mode */ } },
};

export function readUserHolidayConfig(): UserHolidayConfig | undefined {
    try { return JSON.parse(localStorage.getItem('os_realtime_config') || '{}').userHolidays; } catch { return undefined; }
}

/** Shared synchronous context builders only read prepared calendars, never block prompt assembly on network. */
export function getCachedUserHolidayReminder(userName?: string, config = readUserHolidayConfig(), now = Date.now()): string {
    if (!config?.enabled || !HOLIDAY_COUNTRIES.some(c => c.countryCode === config.countryCode)) return '';
    const local = new Date(now); // This entry is browser-only: date follows the device, not the character.
    const year = local.getFullYear();
    const date = getLocalDateKey(local);
    let today: HolidayDay[] = [];
    const years = config.countryCode === 'CN' && local.getMonth() === 11 ? [year, year + 1] : [year];
    for (const y of years) {
        const key = `${HOLIDAY_CACHE_PREFIX}${config.countryCode}_${y}`;
        let calendar = config.countryCode === 'CN' && y === 2026 ? parseHolidayCalendar('CN', y, china2026, now) : memory.get(key);
        if (!calendar) {
            try { const raw = JSON.parse(localStorage.getItem(key) || 'null'); if (validCached(raw, config.countryCode, y)) calendar = raw; } catch { /* unavailable */ }
        }
        const matches = calendar?.days.filter(d => d.date === date) || [];
        if (matches.length) today = matches;
    }
    return renderUserHoliday(config, date, today, userName);
}

/**
 * 云端现取的用户所在地节日，插到「互动对象」段 bio 后面，与本地 buildCoreContext 同位同格式。
 *
 * bio 里可能有空行，光找「之后第一个空行」会插进 bio 中间，所以打包时带上 bio 的长度
 * （fire_pack.userBioLength）按长度跳过。旧包没带长度时退回插在段标题下面。
 * 找不到「互动对象」段就不插：本地那种情形（群聊共享场景之类）也没有这一行，追加到整串
 * 末尾只会排到「回到你自己」之后。
 */
export function insertUserHolidayInProfile(prompt: string, reminder: string, userBioLength?: number): string {
    if (!reminder) return prompt;
    const heading = '### 互动对象 (User)\n';
    const headingAt = prompt.indexOf(heading);
    if (headingAt < 0) return prompt;
    const bioLabel = '- 设定/备注: ';
    const bioAt = prompt.indexOf(bioLabel, headingAt);
    const bioEnd = bioAt >= 0 && typeof userBioLength === 'number' ? bioAt + bioLabel.length + userBioLength : -1;
    if (bioEnd >= 0 && prompt.startsWith('\n\n', bioEnd)) {
        return `${prompt.slice(0, bioEnd + 2)}- ${reminder}\n\n${prompt.slice(bioEnd + 2)}`;
    }
    return prompt.replace(heading, `${heading}- ${reminder}\n`);
}

export async function loadHolidayCalendar(country: string, year: number, cache?: HolidayCache, now = Date.now()): Promise<HolidayCalendar | null> {
    if (!HOLIDAY_COUNTRIES.some(c => c.countryCode === country) || !Number.isInteger(year) || year < 2000 || year > 2200) return null;
    // The published 2026 CN schedule works offline, including make-up working weekends.
    if (country === 'CN' && year === 2026) return parseHolidayCalendar(country, year, china2026, now);
    const key = `${HOLIDAY_CACHE_PREFIX}${country}_${year}`;
    let saved = memory.get(key);
    if (!saved && cache) {
        try { const raw = await cache.read(key); if (validCached(raw, country, year)) saved = raw; } catch { /* best effort */ }
    }
    if (saved && now >= saved.fetchedAt && now - saved.fetchedAt < DAY) return saved;
    if ((retryAfter.get(key) || 0) > now) return saved || null;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const job = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
            const url = country === 'CN'
                ? `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`
                : country === 'MY' ? `https://malaysia-holiday.dydxsoft.my/api/v1/holidays?year=${year}`
                : `https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`;
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) throw new Error('holiday unavailable');
            const fresh = parseHolidayCalendar(country, year, await res.json(), now);
            if (!fresh) throw new Error('holiday unconfirmed');
            memory.set(key, fresh);
            try { await cache?.write(key, fresh); } catch { /* best effort */ }
            return fresh;
        } catch {
            retryAfter.set(key, now + 3600000);
            // Only this country's same annual calendar can be reused; never substitute another year.
            return saved || null;
        } finally { clearTimeout(timer); }
    })();
    inFlight.set(key, job);
    try { return await job; } finally { inFlight.delete(key); }
}

export function renderUserHoliday(config: UserHolidayConfig, date: string, days: HolidayDay[], userName?: string): string {
    const matches = days.filter(d => d.date === date && (!d.regions || (!!config.subdivisionCode && d.regions.includes(config.subdivisionCode))));
    if (!matches.length) return '';
    const working = matches.some(d => !d.off);
    const names = [...new Set(matches.filter(d => d.off === !working).map(d => cleanName(d.name)))].join('、');
    const regionName = config.countryCode === 'MY' ? malaysiaHolidayRegion(config.subdivisionCode || '')?.name : undefined;
    const region = config.subdivisionCode ? `（${regionName || config.subdivisionCode}）` : '';
    const person = cleanName(userName) || '用户';
    return `${person}所在地${holidayCountryName(config.countryCode)}${region} ${date} 为${names}${working ? '调休补班日' : '公共假期'}，实际休息与否以${person}自己的日程和说明为准。`;
}

export async function getUserHolidayReminder(config?: UserHolidayConfig, cache?: HolidayCache, now = Date.now(), userName?: string): Promise<string> {
    if (!config?.enabled || !config.countryCode) return '';
    const local = nowInTimeZone(config.timeZone, new Date(now));
    const year = local.getFullYear();
    const calendars = await Promise.all([
        loadHolidayCalendar(config.countryCode, year, cache, now),
        // CN next year's New Year announcement can change December's schedule.
        config.countryCode === 'CN' && local.getMonth() === 11 ? loadHolidayCalendar('CN', year + 1, cache, now) : null,
    ]);
    const days = new Map<string, HolidayDay[]>();
    for (const calendar of calendars) {
        if (!calendar) continue;
        const grouped = new Map<string, HolidayDay[]>();
        for (const day of calendar.days) grouped.set(day.date, [...(grouped.get(day.date) || []), day]);
        for (const [date, values] of grouped) days.set(date, values);
    }
    const date = getLocalDateKey(local);
    return renderUserHoliday(config, date, days.get(date) || [], userName);
}
