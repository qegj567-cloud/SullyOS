/**
 * 信号坠落处 · 客户端 API
 *
 * 跨用户接龙现代诗。复用漂流瓶（post-office worker）的同一后端、同一匿名
 * deviceId、同一笔名马赛克与限流基建，但走独立的 /poem/* 端点。
 *
 * 模型：全局同时只有一首「当前」诗。谁登入读到的永远是最新全文；没写完就
 * 接一句，没有 open 诗就起新篇（自拟标题 + 第一句 + 已 roll 的篇幅）；写满
 * 篇幅自动封存进诗集。user 不参与，只有角色写。
 */

import { SignalBooklet, SignalPoem } from '../../types';
import { getPostOfficeBase, getDeviceId, maskPen } from './postOffice';
import { recoverSignalOwnership } from './signalRecovery';

export interface SignalState {
    booklet: SignalBooklet;
    /** 当前那首还没写完的诗；null = 该起新篇 */
    poem: SignalPoem | null;
    /** 近期封存的几首，供起新篇时「读之前的诗」找灵感 */
    recent: SignalPoem[];
    /** 管理员是否暂停了「诗歌推入」（true 时角色不再起新篇/接龙） */
    paused?: boolean;
}

// ── 本地精确归属：诗是匿名的（pen 马赛克），但「我这台机器哪句是哪个 char 写的」
// 只对自己有意义、也只该自己知道，故纯本地存 (poemId → seq → charName)。换设备不带走。
const AUTHOR_KEY = 'signal_my_authorship';
type AuthorMap = Record<string, Record<string, string>>;
export function recordMyLine(poemId: string, seq: number, charName: string, content?: string): void {
    try {
        const m: AuthorMap = JSON.parse(localStorage.getItem(AUTHOR_KEY) || '{}');
        (m[poemId] ||= {})[String(seq)] = charName;
        const keys = Object.keys(m);
        if (keys.length > 80) for (const k of keys.slice(0, keys.length - 80)) delete m[k]; // 防膨胀，留最近 80 首
        localStorage.setItem(AUTHOR_KEY, JSON.stringify(m));
    } catch { /* ignore */ }
    // 顺手记「这个 char 写过什么」——写诗时喂回去禁止复用意象（治「胃痛角色句句是胃药」）
    if (content) {
        try {
            const l: Record<string, string[]> = JSON.parse(localStorage.getItem(MY_LINES_KEY) || '{}');
            l[charName] = [...(l[charName] || []), content].slice(-24); // 每 char 留最近 24 句
            localStorage.setItem(MY_LINES_KEY, JSON.stringify(l));
        } catch { /* ignore */ }
    }
}
/** 取某首诗里「我这台机器写的句子」→ {seq: charName}。 */
export function getMyAuthorship(poemId: string): Record<string, string> {
    try { return (JSON.parse(localStorage.getItem(AUTHOR_KEY) || '{}') as AuthorMap)[poemId] || {}; }
    catch { return {}; }
}
const MY_LINES_KEY = 'signal_my_lines';
/** 某个 char 在诗册里写过的句子（本地，最近 24）——注入 prompt 防它反复用同一批意象。 */
export function getMyRecentLines(charName: string): string[] {
    try { return (JSON.parse(localStorage.getItem(MY_LINES_KEY) || '{}') as Record<string, string[]>)[charName] || []; }
    catch { return []; }
}

// ── 首次参与的知情提醒：这是跨用户特别活动，角色接龙写下的内容对所有其他用户
// 公开可见、可能被截图二次传播；确认过一次即记下，之后参与不再弹。
const NOTICE_ACK_KEY = 'signal_notice_ack';
export function hasSignalNoticeAck(): boolean {
    try { return localStorage.getItem(NOTICE_ACK_KEY) === '1'; } catch { return false; }
}
export function ackSignalNotice(): void {
    try { localStorage.setItem(NOTICE_ACK_KEY, '1'); } catch { /* ignore */ }
}

// ── 备份用：把「你·角色」句子归属与反复用记录随「设置 → 导出/导入备份」带走 ──
// deviceId/后端地址由邮局的 exportPostOfficeLocal 携带（信和诗共用身份），这里只补诗自己的本机记录。
// 耳语（signal_whisper）是取即焚的瞬态，故意不进备份。
const BACKUP_KEYS = [AUTHOR_KEY, MY_LINES_KEY, NOTICE_ACK_KEY] as const;
export function exportSignalLocal(): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        for (const k of BACKUP_KEYS) { const v = localStorage.getItem(k); if (v) out[k] = v; }
        return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
}
export function importSignalLocal(data: Record<string, string> | null | undefined): void {
    if (!data || typeof data !== 'object') return;
    try {
        for (const k of BACKUP_KEYS) if (typeof data[k] === 'string' && data[k]) localStorage.setItem(k, data[k]);
    } catch { /* ignore */ }
}

// ── 用户的「耳语」：参与时留给角色的一句话。不进诗、不上后端，只注入这一次 prompt。
// 用 localStorage 走一趟（participate → triggerNow → runSession），取即焚。
const WHISPER_KEY = 'signal_whisper';
export function setSignalWhisper(charId: string, text: string): void {
    try {
        const m: Record<string, string> = JSON.parse(localStorage.getItem(WHISPER_KEY) || '{}');
        if (text.trim()) m[charId] = text.trim().slice(0, 80); else delete m[charId];
        localStorage.setItem(WHISPER_KEY, JSON.stringify(m));
    } catch { /* ignore */ }
}
/** 取走该 char 的耳语（取即删，只用一次）。 */
export function takeSignalWhisper(charId: string): string {
    try {
        const m: Record<string, string> = JSON.parse(localStorage.getItem(WHISPER_KEY) || '{}');
        const t = m[charId] || '';
        if (t) { delete m[charId]; localStorage.setItem(WHISPER_KEY, JSON.stringify(m)); }
        return t;
    } catch { return ''; }
}

async function call<T>(path: string, opts: RequestInit & { query?: Record<string, string> } = {}): Promise<T> {
    const base = getPostOfficeBase();
    const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
    const res = await fetch(`${base}${path}${qs}`, {
        method: opts.method || 'GET',
        headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers as Record<string, string> || {}) },
        body: opts.body,
    });
    const data = await res.json().catch(() => ({}));
    // 409 poem-open 是预期内的「该改去接龙」信号，连同 body 抛出让调用方识别
    if (!res.ok || (data && data.ok === false)) {
        const err: any = new Error((data && data.error) || `HTTP ${res.status}`);
        err.status = res.status; err.body = data;
        throw err;
    }
    return data as T;
}

export const Signal = {
    /** 后端是否可达（拉当前态成功即视为可达）。 */
    async ping(): Promise<boolean> {
        try { await call('/poem/current'); return true; } catch { return false; }
    },

    /** 读当前态：册子规格 + 那首未写完的诗(全文) + 近期封存几首。带本机 device → 句子回 mine 标记。
     *  只读视图用（UI 面板）；写诗路径走 lock()。 */
    async current(): Promise<SignalState> {
        void recoverSignalOwnership();
        return await call<SignalState>('/poem/current', { query: { device: getDeviceId() } });
    },

    /**
     * 抢写诗会话锁。抢到才返回 {acquired:true, token, state}（state 是锁内读到的最新全文）；
     * 抢不到（有别的 char 正在写 / 已暂停）返回 {acquired:false}。写诗路径用这个替代 current()，
     * 让抢不到的 char 在调 LLM 前就走人 —— 既串行化接龙、又不浪费 token。
     */
    async lock(): Promise<{ acquired: boolean; token?: string; paused?: boolean; quota?: boolean; state?: SignalState }> {
        const r = await call<{ acquired: boolean; token?: string; paused?: boolean; quota?: boolean; booklet?: SignalBooklet; poem?: SignalPoem | null; recent?: SignalPoem[] }>(
            '/poem/lock', { method: 'POST', body: JSON.stringify({ device: getDeviceId() }) },
        );
        if (!r.acquired) return { acquired: false, paused: r.paused, quota: r.quota };
        return { acquired: true, token: r.token, state: { booklet: r.booklet!, poem: r.poem ?? null, recent: r.recent || [], paused: false } };
    },

    /** 放写诗会话锁（写完/出错都调；漏放也会被 TTL 自动回收）。 */
    async unlock(token: string): Promise<void> {
        try { await call('/poem/unlock', { method: 'POST', body: JSON.stringify({ token }) }); } catch { /* TTL 兜底 */ }
    },

    /**
     * 起新篇。starter 定标题 + brief（主题/方向，给后来者做参考）+ 开头 1~2 行。
     * targetLines 应在册子 [linesMin, linesMax] 内（服务端也会再钳）。
     * 若此刻已有人起了头，后端回 409 poem-open，本函数抛出 err.body.poem 供改为接龙。
     */
    async start(p: { title: string; brief: string; lines: string[]; targetLines: number; pen: string }): Promise<SignalState> {
        return await call<SignalState>('/poem/start', {
            method: 'POST',
            // firstLine 是给「还没更新到支持 lines[] 的旧 worker」的兼容字段
            body: JSON.stringify({ device: getDeviceId(), pen: maskPen(p.pen), title: p.title, brief: p.brief, lines: p.lines, firstLine: p.lines[0], targetLines: p.targetLines }),
        });
    },

    /** 接龙：给指定诗续 1~2 行。返回最新态（sealed=写满；quota=该 user 在这首里已落笔满额，本次未写入）。 */
    async append(p: { poemId: string; lines: string[]; pen: string }): Promise<{ ok: boolean; sealed?: boolean; gone?: boolean; quota?: boolean; poem?: SignalPoem }> {
        return await call('/poem/append', {
            method: 'POST',
            // content 是给旧 worker 的兼容字段
            body: JSON.stringify({ device: getDeviceId(), pen: maskPen(p.pen), poemId: p.poemId, lines: p.lines, content: p.lines[0] }),
        });
    },

    /** 翻阅诗集：已封存的诗（含全文），最近优先。mineOnly = 只看本机 char 参与过的；带 device → 句子回 mine 标记。 */
    async feed(limit = 30, opts?: { mineOnly?: boolean; bookletId?: string }): Promise<SignalPoem[]> {
        void recoverSignalOwnership();
        const r = await call<{ poems: SignalPoem[] }>('/poem/feed', {
            query: {
                limit: String(limit), device: getDeviceId(),
                ...(opts?.mineOnly ? { mine: '1' } : {}),
                ...(opts?.bookletId ? { booklet: opts.bookletId } : {}),
            },
        });
        return r.poems || [];
    },

    // ── 管理（凭 ADMIN_TOKEN，与漂流瓶同一个 token）──
    /** [管理] 列出后端全部诗（open 在前）+ 当前暂停态。 */
    async adminList(token: string): Promise<{ poems: SignalPoem[]; paused: boolean }> {
        const r = await call<{ poems: SignalPoem[]; paused: boolean }>('/poem/admin-list', { headers: { Authorization: `Bearer ${token}` } });
        return { poems: r.poems || [], paused: !!r.paused };
    },
    /** [管理] 删一整首诗（只给 poemId）或删单句（poemId + seq）。 */
    async adminDelete(token: string, target: { poemId: string; seq?: number }): Promise<void> {
        await call('/poem/admin-delete', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(target) });
    },
    /** [管理] 暂停 / 恢复「诗歌推入」。 */
    async adminPause(token: string, paused: boolean): Promise<boolean> {
        const r = await call<{ paused: boolean }>('/poem/admin-pause', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ paused }) });
        return !!r.paused;
    },
};
