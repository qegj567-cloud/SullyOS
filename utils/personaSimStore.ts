// 全局「人格模拟」演出生成状态。
// 放在模块作用域而非 CheckPhone 内部，这样：
//   1. 生成中即使离开查手机 App（甚至切到别的 OS App），状态/提示依旧存在；
//   2. PhoneShell 里的全局指示条可以随处显示进度，点一下深链回到演出。
//
// 两个来源：本机生成和生活记录重播共用一格（local）；云端代跑的进度从代跑登记表派生，
// 关掉页面重开还在，每个角色各一份，重播写那一格也盖不掉它。
import { useSyncExternalStore } from 'react';
import type { SimState } from '../apps/PersonaSim';
import type { SimScript } from '../types';
import type { PersonaSimCloudContext } from './cloudGen/landers/personaSim';
import { isCloudGenHintOff, subscribeCloudGenSheet } from './cloudGen/hint';
import { dismissCloudGenJob, listCloudGenJobs, subscribeCloudGenJobs } from './cloudGen/registry';
import type { CloudGenJobRecord } from './cloudGen/types';

export type GlobalSimState = SimState & {
    charId?: string;
    charName?: string;
    /** 云端代跑的那份。hint：Worker 已确认收下且这个功能没选「不再提醒」，小条显示「云端生成」。 */
    cloud?: { jobId: string; notify: boolean; hint: boolean };
};

const IDLE: GlobalSimState = { status: 'idle' };
let local: GlobalSimState = IDLE;
let deepLinkCharId: string | null = null;
/** 云端剧本落地时顺手留一份，同一次打开页面里直接播，不用等内存里的角色刷新。 */
const landedScripts = new Map<string, SimScript>();

// 派生结果按快照缓存：useSyncExternalStore 要求两次变化之间返回同一个对象。
let cloud: GlobalSimState[] | null = null;
let pill: GlobalSimState = IDLE;
const byChar = new Map<string, GlobalSimState>();

const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

function toCloudState(record: CloudGenJobRecord, hintOff: boolean): GlobalSimState | null {
    const ctx = (record.context || {}) as Partial<PersonaSimCloudContext>;
    const base = {
        mode: ctx.mode === 'event' ? 'event' as const : 'daily' as const,
        theme: typeof ctx.theme === 'string' ? ctx.theme : '',
        charId: record.charId, charName: record.charName,
        cloud: { jobId: record.jobId, notify: record.notify, hint: !!record.acceptedAt && !hintOff },
    };
    if (record.status === 'running') return { status: 'loading', ...base };
    if (record.status === 'landed' && typeof ctx.logId === 'string') {
        const script = landedScripts.get(record.jobId);
        return { status: 'ready', ...base, logId: ctx.logId, ...(script ? { script } : {}) };
    }
    return null; // 失败的：提示已经弹过，小条收起
}

function derive(): GlobalSimState[] {
    if (cloud) return cloud;
    const hintOff = isCloudGenHintOff('persona-sim');
    cloud = listCloudGenJobs()
        .filter(record => record.purpose === 'persona-sim')
        .map(record => toCloudState(record, hintOff))
        .filter((s): s is GlobalSimState => !!s);
    const active = [...(local.status === 'loading' || local.status === 'ready' ? [local] : []), ...cloud];
    pill = active.find(s => s.status === 'ready') ?? active.find(s => s.status === 'loading') ?? IDLE;
    byChar.clear();
    return cloud;
}

const invalidate = () => { cloud = null; emit(); };
subscribeCloudGenJobs(invalidate);
// 「不再提醒」的开关变了也会走这里。
subscribeCloudGenSheet(invalidate);

export const personaSimStore = {
    /** 本机生成 / 重播那一格。 */
    get: (): GlobalSimState => local,
    set: (s: GlobalSimState) => { local = s; invalidate(); },
    reset: () => { local = IDLE; invalidate(); },
    /** 全局指示条显示哪一份：有就绪的先报就绪，其次生成中。 */
    pill: (): GlobalSimState => { derive(); return pill; },
    /** 某个角色此刻的状态：本机那一格优先（重播要能播），其次云端就绪、云端生成中。 */
    forChar: (charId: string): GlobalSimState => {
        const states = derive();
        let s = byChar.get(charId);
        if (!s) {
            s = local.charId === charId && local.status !== 'idle' ? local
                : states.find(c => c.charId === charId && c.status === 'ready')
                ?? states.find(c => c.charId === charId) ?? IDLE;
            byChar.set(charId, s);
        }
        return s;
    },
    /** 用户开始播放了：云端那份从登记表收走，本机那份清掉。 */
    consume: (s: GlobalSimState) => {
        if (s.cloud) { landedScripts.delete(s.cloud.jobId); dismissCloudGenJob(s.cloud.jobId); }
        if (s === local) personaSimStore.reset();
    },
    rememberCloudScript: (jobId: string, script: SimScript) => { landedScripts.set(jobId, script); },
    /** 请求查手机直接进入这个角色的演出（全局指示条、云端结果的「进入」都走这里）。 */
    requestOpen: (charId: string) => { deepLinkCharId = charId; emit(); },
    getDeepLink: (): string | null => deepLinkCharId,
    clearDeepLink: () => { if (deepLinkCharId) { deepLinkCharId = null; emit(); } },
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
};

/** 不给 charId 是全局指示条要显示的那份；给了是这个角色的。 */
export function usePersonaSim(charId?: string): GlobalSimState {
    const get = () => charId === undefined ? personaSimStore.pill() : personaSimStore.forChar(charId);
    return useSyncExternalStore(personaSimStore.subscribe, get, get);
}

export function usePersonaSimDeepLink(): string | null {
    return useSyncExternalStore(personaSimStore.subscribe, personaSimStore.getDeepLink, personaSimStore.getDeepLink);
}
