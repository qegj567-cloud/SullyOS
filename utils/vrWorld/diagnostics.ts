/**
 * 一键收集排障快照。
 *
 * 起因：彼方出过一次「界面上角色全都显示未接入，调用记录却还在一条条往上涨」的故障。
 * 按代码这两件事不该同时成立，可手机上——尤其是装到主屏的那种——没有控制台，
 * 拿不到任何运行时痕迹，只能靠用户截图猜。
 *
 * 这个函数把判断需要的东西一次凑齐：调度表当前长什么样、内存里的角色状态和落在库里的
 * 那份对不对得上、浏览器还剩多少存储、最近几十轮各自是什么结局。用户点一下复制走即可。
 *
 * **只收状态，不收内容**：角色 id 截成后 6 位，名字、人设、聊天记录、提示词、API key
 * 一概不进快照。API 只记 host、模型名和「key 填没填、多长」。
 */
import type { CharacterProfile, APIConfig } from '../../types';
import { DB } from '../db';
import { getVRApi, getVRApiLog } from './vrApi';
import { getVRThrottleCounts } from './runSession';
import { VRScheduler } from './scheduler';
import { readStorageOverview, formatBytes } from '../storageStats';

/** 页面这次是什么时候起来的——用来看「跑了多久攒出这些记录」。 */
const PAGE_STARTED_AT = Date.now();

/** 调度相关的 localStorage 键，一次全捞出来（彼方 / 主动发消息 / 家园各一套）。 */
const SCHEDULE_KEYS = [
    'vr_schedules', 'vr_last_fire', 'vr_fail_streak',
    'proactive_schedules', 'proactive_last_fire',
    'world_schedules', 'world_last_fire',
];

const tail = (id?: string) => (id ? `…${id.slice(-6)}` : '—');
const at = (ts?: number) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—');
const mins = (ms: number) => `${Math.round(ms / 60000)} 分钟`;

function hostOf(url?: string): string {
    if (!url) return '—';
    try { return new URL(url).host; } catch { return url.slice(0, 40); }
}

/** API 只留「连的是哪儿、用什么模型、key 填没填」，key 本身绝不出现。 */
function apiSummary(label: string, cfg?: APIConfig | null): string {
    if (!cfg?.baseUrl) return `${label}：未配置`;
    const key = cfg.apiKey || '';
    const keyNote = key ? `key 已填（${key.length} 位）` : 'key 是空的';
    return `${label}：${hostOf(cfg.baseUrl)} · ${cfg.model || '未选模型'} · ${keyNote}`;
}

/** localStorage 当场写读删一遍。写不进去或读回来不一样，下面所有调度状态都不可信。 */
function probeLocalStorage(): string {
    const probeKey = '__sullyos_probe__';
    const expected = String(Date.now());
    try {
        localStorage.setItem(probeKey, expected);
        const back = localStorage.getItem(probeKey);
        localStorage.removeItem(probeKey);
        if (back !== expected) return `异常：写进去 ${expected}，读回来是 ${back}`;
        return '正常（写读删都通过）';
    } catch (e: any) {
        return `写不进去：${e?.name || ''} ${e?.message || String(e)}`.trim();
    }
}

/**
 * 浏览器给了多少存储、用了多少、有没有拿到「别清我」的许可。
 *
 * 没拿到持久化许可的站点，在手机存储吃紧时会被系统连数据一起清掉——「一觉醒来设置退回
 * 昨天」多半就是这么来的，所以这两个数值要一起看。
 */
async function probeStorageQuota(): Promise<string> {
    const ov = await readStorageOverview();
    if (!ov.supported) return '这个浏览器不提供存储用量信息';
    const pct = ov.usageBytes != null && ov.quotaBytes ? `${((ov.usageBytes / ov.quotaBytes) * 100).toFixed(1)}%` : '—';
    const persisted = ov.persisted == null
        ? '未知'
        : ov.persisted ? '已获得（系统不会随手清）' : '**没有**（存储吃紧时可能被清掉）';
    return `已用 ${formatBytes(ov.usageBytes)} / 上限 ${formatBytes(ov.quotaBytes)}（${pct}）· 持久化许可：${persisted}`;
}

/**
 * 内存里的角色状态 vs 落在库里的那份。
 *
 * 这一段是冲着那个矛盾去的：界面读的是内存，后台调度判断读的也是内存，两边理应一致；
 * 而库里那份要是和内存对不上，就说明用户改的东西压根没写进去（或者被谁写回了旧值）。
 */
async function compareMemoryAgainstDb(memChars: CharacterProfile[]): Promise<string[]> {
    const lines: string[] = [];
    let dbChars: CharacterProfile[] = [];
    try {
        dbChars = await DB.getAllCharacters();
    } catch (e: any) {
        return [`读不出库里的角色：${e?.message || String(e)}`];
    }
    const dbById = new Map(dbChars.map(c => [c.id, c]));
    const related = memChars.filter(c => c.vrState || dbById.get(c.id)?.vrState);
    if (related.length === 0) return ['没有任何角色配过彼方'];

    for (const mem of related) {
        const db = dbById.get(mem.id);
        const memOn = !!mem.vrState?.enabled;
        const dbOn = !!db?.vrState?.enabled;
        const flag = memOn === dbOn ? '' : '  ← **对不上**';
        lines.push(
            `${tail(mem.id)} 内存=${memOn ? '已接入' : '未接入'} 库里=${db ? (dbOn ? '已接入' : '未接入') : '库里没这个角色'}`
            + ` 间隔=${mem.vrState?.intervalMinutes ?? '—'}分 上次活动=${at(mem.vrState?.lastActiveAt)}`
            + `${mem.vrState?.api?.baseUrl ? ' 角色自带API' : ''}${flag}`
        );
    }
    return lines;
}

/** 调度表里每一条：间隔多久、上次什么时候触发、按理这会儿该不该动。 */
function describeSchedules(): string[] {
    let schedules: Record<string, { charId: string; intervalMs: number }> = {};
    let lastFire: Record<string, number> = {};
    try {
        schedules = JSON.parse(localStorage.getItem('vr_schedules') || '{}');
        lastFire = JSON.parse(localStorage.getItem('vr_last_fire') || '{}');
    } catch { return ['调度表解析失败（内容不是合法 JSON）']; }

    const ids = Object.keys(schedules);
    if (ids.length === 0) return ['调度表是空的'];
    const now = Date.now();
    return ids.map(id => {
        const s = schedules[id];
        const fired = lastFire[id] || 0;
        const since = fired ? now - fired : 0;
        const due = fired > 0 && since >= s.intervalMs;
        return `${tail(id)} 间隔=${mins(s.intervalMs)} 上次触发=${at(fired)}`
            + `（${fired ? `${mins(since)}前` : '没记录'}）→ 这会儿${due ? '**判定该触发**' : '不该触发'}`;
    });
}

/** 最近几十轮各自是什么结局。诊断行（拦下 / 跳过 / 暂停）也在里面。 */
function describeRecentLog(log: Awaited<ReturnType<typeof getVRApiLog>>): string[] {
    if (log.length === 0) return ['还没有任何记录'];
    return log.slice(0, 40).map(l => {
        const when = at(l.ts);
        if (l.kind) return `${when} [${l.kind}] ${tail(l.charId)} ${l.note || ''}`;
        const enabled = l.charEnabled === undefined ? '' : ` 发起时=${l.charEnabled ? '已接入' : '**未接入**'}`;
        const err = l.error ? ` err=${l.error.slice(0, 60)}` : '';
        return `${when} [调用] ${tail(l.charId)} ${l.room || '—'} ${l.ok ? '成功' : '失败'} ${(l.ms / 1000).toFixed(1)}s${enabled}${err}`;
    });
}

/** 主动消息 2.0 排着的任务。只记类型和时刻，内容一个字都不带。 */
function describeAmsgTasks(memChars: CharacterProfile[]): string[] {
    const lines: string[] = [];
    for (const c of memChars) {
        const tasks = c.activeMsg2Config?.tasks || [];
        if (tasks.length === 0) continue;
        lines.push(`${tail(c.id)} 共 ${tasks.length} 条：`);
        for (const t of tasks.slice(0, 8)) {
            lines.push(`  · ${t.mode}/${t.recurrenceType} ${t.status} 下次=${t.nextSendAt || t.firstSendTime || '—'}`
                + ` 来源=${t.source}${t.lastError ? ` err=${t.lastError.slice(0, 40)}` : ''}`);
        }
    }
    return lines.length ? lines : ['没有角色排着主动消息任务'];
}

/** 收一份快照，返回可以直接粘出去的纯文本。 */
export async function collectVRDiagnostics(memChars: CharacterProfile[], chatApi?: APIConfig | null): Promise<string> {
    const [vrApi, log, quota] = await Promise.all([
        getVRApi().catch(() => null),
        getVRApiLog().catch(() => []),
        probeStorageQuota(),
    ]);
    const memVsDb = await compareMemoryAgainstDb(memChars);
    const standalone = (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone) ? '是（主屏图标打开）' : '否（浏览器标签里）';
    const throttles = getVRThrottleCounts();
    const throttleLines = Object.keys(throttles).length
        ? Object.entries(throttles).map(([id, n]) => `${tail(id)} 被拦下 ${n} 次`)
        : ['没有被拦下过（正常）'];

    const storageDump = SCHEDULE_KEYS.map(k => {
        const v = localStorage.getItem(k);
        return `${k} = ${v === null ? '（没有这个键）' : v}`;
    });

    const failStreaks = memChars
        .filter(c => VRScheduler.getFailStreak(c.id) > 0)
        .map(c => `${tail(c.id)} 连续失败 ${VRScheduler.getFailStreak(c.id)} 次`);

    return [
        '===== SullyOS·糯米机 彼方排障快照 =====',
        `收集时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        `时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
        `独立窗口：${standalone}`,
        `本次页面已运行：${mins(Date.now() - PAGE_STARTED_AT)}`,
        `浏览器：${navigator.userAgent.slice(0, 120)}`,
        '',
        '--- 存储健康 ---',
        `localStorage 自检：${probeLocalStorage()}`,
        `存储用量：${quota}`,
        '',
        '--- 内存 vs 库里（对不上 = 改的东西没写进去） ---',
        ...memVsDb,
        '',
        '--- 调度表 ---',
        ...describeSchedules(),
        '',
        '--- 最小间隔闸 ---',
        ...throttleLines,
        '',
        '--- 连续失败计数 ---',
        ...(failStreaks.length ? failStreaks : ['都是 0']),
        '',
        '--- API（不含 key 本身） ---',
        apiSummary('彼方独立', vrApi),
        apiSummary('聊天默认', chatApi),
        `角色自带 API 的：${memChars.filter(c => c.vrState?.api?.baseUrl).length} 个`,
        '',
        '--- 主动消息任务 ---',
        ...describeAmsgTasks(memChars),
        '',
        '--- 调度相关的本地存储原文 ---',
        ...storageDump,
        '',
        `--- 最近 ${Math.min(log.length, 40)} 条记录 ---`,
        ...describeRecentLog(log),
        '===== 快照结束 =====',
    ].join('\n');
}
