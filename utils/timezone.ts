// 角色自定义时区（异国恋 / 角色身处异国等场景）。
// 与「时间感知强化」完全独立：时间感知管「距离上次聊天多久」的提示词，
// 这里管「角色活在哪个时区」——开启后，注入给该角色的「当前时间 / 消息时间戳 /
// 夜间判断」都按这个时区折算，让 ta 真的活在自己的本地时间里。两者可任意组合。

import { CharacterProfile } from '../types';

/** 常用时区清单（友好中文标签）。用 IANA id，自动处理夏令时。 */
export const COMMON_TIMEZONES: { id: string; label: string }[] = [
    { id: 'Asia/Shanghai', label: '北京 / 上海 (UTC+8)' },
    { id: 'Asia/Tokyo', label: '东京 / 首尔 (UTC+9)' },
    { id: 'Asia/Bangkok', label: '曼谷 / 河内 (UTC+7)' },
    { id: 'Asia/Kolkata', label: '印度 (UTC+5:30)' },
    { id: 'Asia/Dubai', label: '迪拜 (UTC+4)' },
    { id: 'Europe/Moscow', label: '莫斯科 (UTC+3)' },
    { id: 'Europe/Paris', label: '巴黎 / 柏林 / 罗马 (UTC+1/+2)' },
    { id: 'Europe/London', label: '伦敦 (UTC+0/+1)' },
    { id: 'America/Sao_Paulo', label: '圣保罗 (UTC-3)' },
    { id: 'America/New_York', label: '纽约 / 多伦多 (UTC-5/-4)' },
    { id: 'America/Chicago', label: '芝加哥 (UTC-6/-5)' },
    { id: 'America/Denver', label: '丹佛 (UTC-7/-6)' },
    { id: 'America/Los_Angeles', label: '洛杉矶 / 西雅图 (UTC-8/-7)' },
    { id: 'Australia/Sydney', label: '悉尼 (UTC+10/+11)' },
    { id: 'Pacific/Auckland', label: '奥克兰 (UTC+12/+13)' },
];

/** 取角色当前生效的时区 id；未开启自定义时区时返回 undefined（= 跟随本机）。 */
export const resolveCharTimeZone = (
    char?: Pick<CharacterProfile, 'customTimezoneEnabled' | 'customTimezone'> | null,
): string | undefined =>
    char?.customTimezoneEnabled && char.customTimezone ? char.customTimezone : undefined;

/** 时区 id → 友好标签；不在清单里就原样返回 id。 */
export const tzLabel = (tz: string): string =>
    COMMON_TIMEZONES.find(t => t.id === tz)?.label || tz;

/**
 * 时区 id → 一个词的地名，给界面上空间紧张的地方用（如日程卡的时钟角标）。
 * 「纽约 / 多伦多 (UTC-5/-4)」→「纽约」；不在清单里就取 IANA id 的末段。
 */
export const tzShortLabel = (tz: string): string => {
    const label = COMMON_TIMEZONES.find(t => t.id === tz)?.label;
    if (label) return label.split('/')[0].replace(/\s*\(.*$/, '').trim();
    return tz.split('/').pop()?.replace(/_/g, ' ') || tz;
};

/**
 * 返回一个「本地 getter（getHours/getMinutes/getDay/getFullYear…）读出来正好是 `tz`
 * 当地墙上时间」的 Date。tz 为空或非法时，原样返回 base（本机时间）。
 * 这样所有现有用 new Date().getHours() 之类读取的代码都不用改读取方式，只换一下这个源。
 */
export const nowInTimeZone = (tz?: string, base: Date = new Date()): Date => {
    if (!tz) return base;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).formatToParts(base);
        const map: Record<string, string> = {};
        for (const p of parts) map[p.type] = p.value;
        let hour = parseInt(map.hour, 10);
        if (hour === 24) hour = 0; // 某些环境 24:00 表示午夜
        return new Date(
            parseInt(map.year, 10), parseInt(map.month, 10) - 1, parseInt(map.day, 10),
            hour, parseInt(map.minute, 10), parseInt(map.second, 10),
        );
    } catch {
        return base;
    }
};

/** 把某个时间戳折算成 `tz` 当地墙上时间对应的时间戳（用于历史消息时间戳显示）。 */
export const tsInTimeZone = (ts: number, tz?: string): number =>
    tz ? nowInTimeZone(tz, new Date(ts)).getTime() : ts;

/**
 * `nowInTimeZone` 的逆运算：把一段「角色当地的墙上时间」文本换算回真实时刻。
 *
 * 角色写 `[schedule_message | 2026-07-26 21:00:00 | ...]` 时，它唯一看得到的钟是
 * 自己时区的（prompt 里注入的就是角色当地时间）。直接 `new Date(文本)` 会按**设备**
 * 时区解释，异国恋角色的定时消息会整体偏一个时差——角色想约今晚，实际可能已经过期。
 *
 * tz 为空时行为与 `new Date(文本)` 完全一致。文本非法时返回 NaN，交给调用方判。
 */
export const wallClockToTimestamp = (wallClockText: string, tz?: string): number => {
    // 'YYYY-MM-DD HH:MM:SS' 里的空格换成 T，避免个别引擎把它当非法格式
    const asDeviceLocal = new Date(wallClockText.trim().replace(' ', 'T')).getTime();
    if (!tz || Number.isNaN(asDeviceLocal)) return asDeviceLocal;

    // 找真实时刻 t，使 nowInTimeZone(tz, t) 读出来正好是这串墙上时间。
    // 先按当前猜测算一次时差再修正；跑两轮是为了让夏令时切换附近也收敛。
    let t = asDeviceLocal;
    for (let i = 0; i < 2; i++) {
        const drift = nowInTimeZone(tz, new Date(t)).getTime() - asDeviceLocal;
        if (drift === 0) break;
        t -= drift;
    }
    return t;
};

/** 注入聊天 prompt 的时差提示（异国恋核心）。tz 为空时返回空串。 */
export const tzAwarenessNote = (tz?: string): string => {
    if (!tz) return '';
    return `\n⏳ 注意：你身处「${tzLabel(tz)}」时区，上面的「当前时间」是你那边的本地时间。`
        + `对方（用户）可能在不同的时区，你们之间存在时差——聊天时把这点考虑进去`
        + `（比如你这边已是深夜要睡了，对方那边也许才下午）。\n`;
};

/**
 * 「距离上次互动多久」统一口径（供 buildCoreContext 注入，查手机/人际关系等无内联消息流的
 * 路径共用同一份措辞，替代各 App 各写一份的 getTimeGapHint）。
 * 纯时长，与时区无关（间隔是绝对差值）。lastTs 为空返回空串。
 * 聊天内联那份（ChatPrompts.getTimeGapHint）刻意保留：它贴在最后一条消息后、带深夜判断，位置语义更好。
 */
export const interactionGapNote = (lastTs?: number, nowTs: number = Date.now()): string => {
    if (!lastTs) return '';
    const diffMs = nowTs - lastTs;
    if (diffMs < 0) return '';
    const mins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(hours / 24);
    if (mins < 5) return `⌛ 你和对方刚刚还在联系。\n`;
    const span = mins < 60 ? `${mins} 分钟` : hours < 24 ? `${hours} 小时` : `${days} 天`;
    const feel = days >= 1 ? '已经有一阵子没联系了' : '不久前刚联系过';
    return `⌛ 距离你和对方上次联系，已经过去 ${span}（${feel}）——请把这种体感自然带入当下的状态与心情。\n`;
};

// 同一份社交材料的阅读时间与发表时间都按阅读者时区显示。
export function socialReadingClock(timeZone?: string) {
    const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
    let formatter: Intl.DateTimeFormat;
    try { formatter = new Intl.DateTimeFormat('zh-CN', { ...options, timeZone }); }
    catch { formatter = new Intl.DateTimeFormat('zh-CN', options); }
    return (timestamp?: number) => timestamp && Number.isFinite(new Date(timestamp).getTime())
        ? formatter.format(timestamp) : '时间未知';
}
