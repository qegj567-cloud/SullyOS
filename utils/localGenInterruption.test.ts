import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trackEvent = vi.hoisted(() => vi.fn());
vi.mock('./analytics', async importOriginal => ({ ...await importOriginal<typeof import('./analytics')>(), trackEvent }));

type Mod = typeof import('./localGenInterruption');
const REQ_URL = 'https://api.example.com/v1/chat/completions';
const networkError = () => new TypeError('Load failed');

let doc: EventTarget & { visibilityState: string };
let win: EventTarget;

// 每次都换一份新模块和新的页面对象，相当于一次冷启动。
async function boot(): Promise<Mod> {
    vi.resetModules();
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    win = new EventTarget();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    const mod = await import('./localGenInterruption');
    mod.installLocalGenInterruptionWatch();
    return mod;
}
const setVisibility = (state: 'hidden' | 'visible') => {
    doc.visibilityState = state;
    doc.dispatchEvent(new Event('visibilitychange'));
};
const reported = () => trackEvent.mock.calls.filter(([name]) => name === '本机生成被切走打断').map(([, data]) => data);

beforeEach(() => {
    localStorage.clear();
    trackEvent.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('用途白名单', () => {
    it('认得出的用途换成固定标签，毒药串和原型链上的键都只能报「其他」', async () => {
        const { localGenPurposeLabel } = await boot();
        expect(localGenPurposeLabel('聊天回复')).toBe('私聊');
        expect(localGenPurposeLabel('生成自定义应用·小红书')).toBe('查手机');
        expect(localGenPurposeLabel('事件压缩-二次压缩')).toBe('记忆压缩');
        for (const poison of ['sk-POISON https://x', 'constructor', '__proto__', '', undefined, 42]) {
            expect(localGenPurposeLabel(poison)).toBe('其他');
        }
    });

    it('毒药串走完整条「回来后报错」也只报出「其他」', async () => {
        const mod = await boot();
        const req = mod.beginLocalGen({ url: REQ_URL, method: 'POST', purpose: 'sk-POISON https://x' });
        setVisibility('hidden');
        setVisibility('visible');
        mod.endLocalGen(req, networkError());
        expect(reported()).toEqual([{ 用途: '其他', 情形: '回来后报错' }]);
        expect(JSON.stringify(trackEvent.mock.calls)).not.toMatch(/POISON|https?:|example\.com/);
    });

    it('连接测试和非 POST 请求不登记', async () => {
        const mod = await boot();
        expect(mod.beginLocalGen({ url: REQ_URL, method: 'POST', purpose: '测试连接' })).toBeUndefined();
        expect(mod.beginLocalGen({ url: REQ_URL, method: 'GET', purpose: '聊天回复' })).toBeUndefined();
    });
});

describe('回来后报错', () => {
    it('期间进过后台的网络错误报一次', async () => {
        const mod = await boot();
        const req = mod.beginLocalGen({ url: REQ_URL, method: 'POST', purpose: '聊天回复' });
        setVisibility('hidden');
        setVisibility('visible');
        mod.endLocalGen(req, networkError());
        mod.endLocalGen(req, networkError());
        expect(reported()).toEqual([{ 用途: '私聊', 情形: '回来后报错' }]);
    });

    it('期间没进过后台的网络错误不报', async () => {
        const mod = await boot();
        const req = mod.beginLocalGen({ url: REQ_URL, method: 'POST', purpose: '聊天回复' });
        mod.endLocalGen(req, networkError());
        expect(reported()).toEqual([]);
    });

    it('AbortError 不报，即使期间进过后台', async () => {
        const mod = await boot();
        const req = mod.beginLocalGen({ url: REQ_URL, method: 'POST', purpose: '聊天回复' });
        setVisibility('hidden');
        mod.endLocalGen(req, new DOMException('The operation was aborted.', 'AbortError'));
        expect(reported()).toEqual([]);
    });

    it('有 HTTP 状态的失败不报：正常收尾和流里的上游报错都算', async () => {
        const mod = await boot();
        const httpFail = mod.beginLocalGen({ url: REQ_URL, method: 'POST', purpose: '聊天回复' });
        const upstream = mod.beginLocalGen({ url: REQ_URL, method: 'POST', purpose: '聊天回复' });
        setVisibility('hidden');
        setVisibility('visible');
        mod.endLocalGen(httpFail);
        mod.endLocalGen(upstream, Object.assign(new TypeError('overloaded'), { __sullyUpstreamStreamError: true, httpStatus: 529 }));
        expect(reported()).toEqual([]);
    });
});

describe('页面被关', () => {
    it('进后台时有在飞请求就写标记，下次启动按用途补报并清掉标记', async () => {
        const mod = await boot();
        mod.beginLocalGen({ url: REQ_URL, method: 'POST', purpose: '生成当日日程' });
        setVisibility('hidden');
        expect(JSON.parse(localStorage.getItem(mod.LOCAL_GEN_INFLIGHT_KEY)!)).toEqual(['日程']);

        const next = await boot();
        expect(reported()).toEqual([{ 用途: '日程', 情形: '页面被关' }]);
        expect(localStorage.getItem(next.LOCAL_GEN_INFLIGHT_KEY)).toBeNull();
    });

    it('pagehide 也会写标记', async () => {
        const mod = await boot();
        mod.beginLocalGen({ url: REQ_URL, method: 'POST', purpose: '梦境剧本生成' });
        win.dispatchEvent(new Event('pagehide'));
        expect(JSON.parse(localStorage.getItem(mod.LOCAL_GEN_INFLIGHT_KEY)!)).toEqual(['梦境']);
    });

    it('回到前台时清掉标记，重启后不报', async () => {
        const mod = await boot();
        mod.beginLocalGen({ url: REQ_URL, method: 'POST', purpose: '聊天回复' });
        setVisibility('hidden');
        setVisibility('visible');
        expect(localStorage.getItem(mod.LOCAL_GEN_INFLIGHT_KEY)).toBeNull();
        await boot();
        expect(reported()).toEqual([]);
    });

    it('后台期间完成的请求从标记里移掉', async () => {
        const mod = await boot();
        const done = mod.beginLocalGen({ url: REQ_URL, method: 'POST', purpose: '聊天回复' });
        mod.beginLocalGen({ url: REQ_URL, method: 'POST', purpose: '记忆消化' });
        setVisibility('hidden');
        mod.endLocalGen(done);
        expect(JSON.parse(localStorage.getItem(mod.LOCAL_GEN_INFLIGHT_KEY)!)).toEqual(['记忆消化']);
    });

    it('没有在飞请求时进后台不留标记', async () => {
        const mod = await boot();
        setVisibility('hidden');
        expect(localStorage.getItem(mod.LOCAL_GEN_INFLIGHT_KEY)).toBeNull();
    });

    it('标记被改成别的内容，补报时也只报白名单里的标签', async () => {
        localStorage.setItem('sullyos_notice_local_gen_inflight_v1', JSON.stringify(['sk-POISON https://x', '私聊', { a: 1 }]));
        await boot();
        expect(reported()).toEqual([
            { 用途: '其他', 情形: '页面被关' },
            { 用途: '私聊', 情形: '页面被关' },
            { 用途: '其他', 情形: '页面被关' },
        ]);
    });

    it('坏掉的标记静默清掉', async () => {
        localStorage.setItem('sullyos_notice_local_gen_inflight_v1', '{broken');
        const mod = await boot();
        expect(reported()).toEqual([]);
        expect(localStorage.getItem(mod.LOCAL_GEN_INFLIGHT_KEY)).toBeNull();
    });
});

describe('标记键是设备状态', () => {
    it('各用户空间共用、不进备份、不随迁入独立用户', async () => {
        const { LOCAL_GEN_INFLIGHT_KEY } = await import('./localGenInterruption');
        const { isSharedSpaceKey } = await import('./userSpaces');
        const { privateLocalExcluded } = await import('./userSpaceBackup');
        const { canMigrateLocalKey } = await import('./independentUserRemap');
        expect(isSharedSpaceKey(LOCAL_GEN_INFLIGHT_KEY)).toBe(true);
        expect(privateLocalExcluded(LOCAL_GEN_INFLIGHT_KEY)).toBe(true);
        expect(canMigrateLocalKey(LOCAL_GEN_INFLIGHT_KEY)).toBe(false);
    });
});
