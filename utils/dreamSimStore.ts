// 全局「梦境」生成状态，按角色各一份。
// 放在模块作用域而非 DreamTheater 内部，这样：
//   1. 生成中即使离开小屋 App（甚至切到别的 OS App），状态/提示依旧存在；
//   2. PhoneShell 里的全局指示条可以随处显示进度，点一下深链回到那场梦。
// 两个来源合在一起：本机生成的进度放在内存里；云端生成的由代跑登记表和「还没看的梦」
// （cloudGen/pending）推出来，刷新页面后照样在。按角色分开：B 开始做梦不会冲掉 A 那场还没看的梦。
import { useSyncExternalStore } from 'react';
import type { DreamScript } from '../types';
import { isCloudGenHintOff, subscribeCloudGenSheet } from './cloudGen/hint';
import { clearCloudGenPending, readCloudGenPending } from './cloudGen/pending';
import { dismissCloudGenJob, listCloudGenJobs, subscribeCloudGenJobs } from './cloudGen/registry';

export type DreamGenState =
    | { status: 'idle' }
    // cloudSheet：这份在云端跑、Worker 已收下且没选「不再提醒」→ 胶囊写「云端生成 · 梦境」，点开说明页
    | { status: 'loading'; charId: string; charName: string; cloudSheet?: { notify: boolean } }
    | { status: 'ready'; charId: string; charName: string; script: DreamScript }
    | { status: 'error'; charId: string; charName: string };

/** cloudJobId：这份来自哪次代跑，看过之后连登记表那条一起收走。 */
export type DreamSimEntry = Exclude<DreamGenState, { status: 'idle' }> & { cloudJobId?: string };

export type GlobalDreamState = (DreamGenState | DreamSimEntry) & {
    deepLink?: boolean; // 用户点了全局指示条，请求小屋直接进入那场梦
};

/** 云端落地、还没看的梦。没通过校验的不进这里，登记表标 failed，打开时走原来的报错界面。 */
export type DreamCloudPending = { jobId: string; charName: string; script: DreamScript };

const IDLE: DreamGenState = { status: 'idle' };

const pendingEntry = (charId: string, p: DreamCloudPending): DreamSimEntry =>
    ({ status: 'ready', charId, charName: p.charName, script: p.script, cloudJobId: p.jobId });

/** 从代跑登记表推出每个角色的云端状态（还没看的梦优先）。 */
const fromCloud = (): Map<string, DreamSimEntry> => {
    const out = new Map<string, DreamSimEntry>();
    for (const r of listCloudGenJobs()) {
        if (r.purpose !== 'dream') continue;
        const pending = readCloudGenPending<DreamCloudPending>('dream', r.charId);
        const base = { charId: r.charId, charName: r.charName, cloudJobId: r.jobId };
        if (pending) out.set(r.charId, pendingEntry(r.charId, pending));
        else if (r.status === 'running') out.set(r.charId, {
            ...base, status: 'loading',
            ...(r.acceptedAt && !isCloudGenHintOff('dream') ? { cloudSheet: { notify: r.notify } } : {}),
        });
        else if (r.status === 'failed') out.set(r.charId, { ...base, status: 'error' });
        // landed 而没有 pending = 已经看过（或 pending 被清掉），什么也不显示
    }
    return out;
};

const local = new Map<string, DreamSimEntry>();
let deepLinkCharId: string | null = null;
let snapshot: { byChar: Map<string, DreamSimEntry>; featured: GlobalDreamState } | null = null;
const listeners = new Set<() => void>();

const compute = () => {
    // 同一角色本机那份优先：上传那几秒本机记着 loading，此时登记表里也有一条还没收下的
    const byChar = new Map([...fromCloud(), ...local]);
    const all = [...byChar.values()];
    const linked = deepLinkCharId ? byChar.get(deepLinkCharId) : undefined;
    // 要深链的那份已经没了：作废，免得这个角色下次再有梦时小屋自己跳进去
    if (!linked) deepLinkCharId = null;
    // 指示条只露一个：好了的优先，其次在做的
    const featured: GlobalDreamState = linked ? { ...linked, deepLink: true }
        : all.find(e => e.status === 'ready') ?? all.find(e => e.status === 'loading') ?? IDLE;
    return { byChar, featured };
};
const snap = () => (snapshot ??= compute());
const invalidate = () => { snapshot = null; listeners.forEach(l => l()); };

subscribeCloudGenJobs(invalidate);
subscribeCloudGenSheet(invalidate); // 「本功能不再提醒」改了，胶囊文案跟着变

export const dreamSimStore = {
    /** 指示条与小屋深链用的那一份。 */
    get: (): GlobalDreamState => snap().featured,
    getFor: (charId: string): DreamGenState => snap().byChar.get(charId) ?? IDLE,
    /** 本机生成的进度。 */
    set: (entry: DreamSimEntry) => { local.set(entry.charId, entry); invalidate(); },
    clear: (charId: string) => { if (local.delete(charId)) invalidate(); },
    /**
     * DreamTheater 打开这个角色时取走一场好了的（或失败了的）梦：本机的、云端还没看的都算，
     * 取走即清掉，和原来内存里那份一样只播一次。还在做的不动，返回 null。
     * 云端的直接读 pending：登记表那条过了保留期，还没看的梦照样在。
     */
    consume: (charId: string): DreamSimEntry | null => {
        const mine = local.get(charId);
        if (mine && mine.status !== 'loading') { local.delete(charId); invalidate(); return mine; }
        const pending = readCloudGenPending<DreamCloudPending>('dream', charId);
        if (pending) {
            clearCloudGenPending('dream', charId);
            dismissCloudGenJob(pending.jobId);
            invalidate();
            return pendingEntry(charId, pending);
        }
        const cloud = fromCloud().get(charId);
        if (cloud?.status === 'error' && cloud.cloudJobId) { dismissCloudGenJob(cloud.cloudJobId); return cloud; }
        return null;
    },
    requestOpen: (charId?: string) => {
        const target = charId ?? (snap().featured.status === 'idle' ? null : (snap().featured as DreamSimEntry).charId);
        if (target) { deepLinkCharId = target; invalidate(); }
    },
    clearDeepLink: () => { if (deepLinkCharId) { deepLinkCharId = null; invalidate(); } },
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
};

export function useDreamSim(): GlobalDreamState {
    return useSyncExternalStore(dreamSimStore.subscribe, dreamSimStore.get, dreamSimStore.get);
}

export function useDreamSimFor(charId: string): DreamGenState {
    const get = () => dreamSimStore.getFor(charId);
    return useSyncExternalStore(dreamSimStore.subscribe, get, get);
}
