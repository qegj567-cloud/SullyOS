/**
 * 使用统计的回归护栏。
 *
 * 这里钉的每一条都是对外公开承诺过的行为，退化了不会有人在界面上看出来，
 * 只会在别人按 F12 抓包时暴露。所以宁可测得啰嗦一点。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { APP_VERSION } from './buildInfo';

const SCRIPT_URL = 'https://umami.example.com/script.js';
const WEBSITE_ID = '00000000-0000-0000-0000-000000000000';

/** 规模上报的基线参数，用例只覆盖自己关心的那一项。 */
const SCALE = {
    characterCount: 1,
    memoryCount: 1,
    maxMemoryCount: 1,
    maxMessageCount: 1,
    storageBytes: 0,
    storageQuotaBytes: 1024 * 1024 * 1024,
    persistedStorage: false,
    standalone: false,
};

interface FakeScript {
    src: string;
    defer: boolean;
    attrs: Record<string, string>;
    setAttribute(k: string, v: string): void;
    addEventListener(type: string, fn: () => void): void;
    fire(type: string): void;
}

/** 记下所有被 appendChild 进 head 的 script。 */
let appended: FakeScript[] = [];
/** window.umami?.track 收到的调用。 */
let tracked: Array<[string | undefined, unknown]> = [];

function define(name: string, value: unknown) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function installFakeDom(
    opts: { doNotTrack?: string | null; withUmami?: boolean; hostname?: string } = {}
) {
    appended = [];
    tracked = [];

    const createScript = (): FakeScript => {
        const listeners: Record<string, Array<() => void>> = {};
        return {
            src: '',
            defer: false,
            attrs: {},
            setAttribute(k, v) { this.attrs[k] = v; },
            addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
            fire(type) { (listeners[type] || []).forEach(fn => fn()); },
        };
    };

    define('document', {
        createElement: (tag: string) => {
            if (tag !== 'script') throw new Error(`unexpected createElement(${tag})`);
            return createScript();
        },
        head: { appendChild: (el: FakeScript) => { appended.push(el); } },
    });

    // Node 里 navigator 是只读 getter，直接赋值会抛，得用 defineProperty 盖掉。
    define('navigator', { doNotTrack: opts.doNotTrack ?? null });
    define('window', {
        doNotTrack: opts.doNotTrack ?? null,
        // 默认给一个线上域名。用例想测本地开发那道早退时自己传 hostname。
        location: { hostname: opts.hostname ?? 'sully-os-nu.vercel.app' },
        ...(opts.withUmami
            ? { umami: { track: (name?: string, data?: unknown) => { tracked.push([name, data]); } } }
            : {}),
    });
}

/**
 * 五组快照的槽位顺序，跟 analytics.ts 里的 SNAPSHOT_SLOTS 一致。
 * 不用手动核对是否同步：那边顺序一改，「五个槽位各报各的」那条就会挂。
 */
const SLOT_ORDER = ['data-scale', 'appearance', 'char-settings', 'features', 'sar'] as const;
type Slot = (typeof SLOT_ORDER)[number];

/** 每个用例都要重新 import：环境变量是在模块加载那一刻读死的。 */
async function loadModule(configured: boolean, slot: Slot = 'data-scale') {
    vi.resetModules();
    vi.stubEnv('VITE_UMAMI_SCRIPT_URL', configured ? SCRIPT_URL : '');
    vi.stubEnv('VITE_UMAMI_WEBSITE_ID', configured ? WEBSITE_ID : '');
    // 模块加载那一刻会掷一次骰子，决定这次冷启动报五组快照里的哪一组。用例要能稳定
    // 测到指定的那组，这里把骰子按住，import 完就松手——别影响到用例自己的代码。
    const dice = vi.spyOn(Math, 'random').mockReturnValue(SLOT_ORDER.indexOf(slot) / SLOT_ORDER.length);
    try {
        return await import('./analytics');
    } finally {
        dice.mockRestore();
    }
}

beforeEach(() => {
    localStorage.clear();
    installFakeDom();
});

afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as any).document;
    delete (globalThis as any).window;
    delete (globalThis as any).navigator;
});

describe('构建时门禁', () => {
    it('没配环境变量时，一个 script 标签都不创建', async () => {
        const a = await loadModule(false);
        expect(a.isAnalyticsConfigured()).toBe(false);
        a.initAnalytics();
        expect(appended).toHaveLength(0);
    });

    it('只配了一半也不算配好', async () => {
        vi.resetModules();
        vi.stubEnv('VITE_UMAMI_SCRIPT_URL', SCRIPT_URL);
        vi.stubEnv('VITE_UMAMI_WEBSITE_ID', '');
        const a = await import('./analytics');
        expect(a.isAnalyticsConfigured()).toBe(false);
        a.initAnalytics();
        expect(appended).toHaveLength(0);
    });

    it('没配环境变量时，trackEvent 是纯空调用，不抛', async () => {
        installFakeDom({ withUmami: false });
        const a = await loadModule(false);
        expect(() => a.trackEvent('打开见面')).not.toThrow();
        expect(tracked).toHaveLength(0);
    });
});

describe('统计请求识别', () => {
    it('只识别统计站自己的发送端点', async () => {
        const a = await loadModule(true);
        expect(a.isAnalyticsRequestUrl('https://umami.example.com/api/send')).toBe(true);
        expect(a.isAnalyticsRequestUrl('https://umami.example.com/api/send/')).toBe(true);
        expect(a.isAnalyticsRequestUrl('https://umami.example.com/api/other')).toBe(false);
        expect(a.isAnalyticsRequestUrl('https://api.example.com/api/send')).toBe(false);
    });

    it('未配置统计时不误判同路径的业务请求', async () => {
        const a = await loadModule(false);
        expect(a.isAnalyticsRequestUrl('https://stats.friedsully.com/api/send')).toBe(false);
    });
});

describe('tracker 标签', () => {
    it('属性齐全：DNT、关掉自动发的页面访问、开性能指标', async () => {
        const a = await loadModule(true);
        a.initAnalytics();

        expect(appended).toHaveLength(1);
        const el = appended[0];
        expect(el.src).toBe(SCRIPT_URL);
        expect(el.defer).toBe(true);
        expect(el.attrs['data-website-id']).toBe(WEBSITE_ID);
        expect(el.attrs['data-do-not-track']).toBe('true');
        expect(el.attrs['data-auto-pageview']).toBe('false');
        expect(el.attrs['data-performance']).toBe('true');
    });

    it('打上产品版本号，而且只打版本号那半截', async () => {
        // 标签是拿来在面板里按版本切分数据的（尤其是性能数字，两版混着看等于没看），
        // 所以要短到能当筛选项用——代号和括号留给设置页展示，别进标签。
        const a = await loadModule(true);
        a.initAnalytics();

        const tag = appended[0].attrs['data-tag'];
        expect(tag).toBe(APP_VERSION.split(' ')[0]);
        expect(tag).toMatch(/^v[\d.]+$/);
    });

    it('不挂 data-auto-track —— 挂了性能指标整个不启动', async () => {
        // umami 的 tracker 是 `if (autoTrack) init()`，而性能指标的观测器在 init 里面挂。
        // 挂上 data-auto-track="false" 就等于把 data-performance 一起关掉，
        // 而且是静默的：标签属性看着齐全，Performance 面板永远空着。
        // 「不自动发页面访问」这件事由 data-auto-pageview 单独负责。
        const a = await loadModule(true);
        a.initAnalytics();

        expect(appended[0].attrs['data-auto-track']).toBeUndefined();
    });

    it('不挂域名白名单 —— 挂自己域名反代官方站的人也要算进来', async () => {
        // data-domains 是 umami tracker 在浏览器里自己判的白名单：hostname 不在名单里
        // 就直接 return，连请求都不发。挂上它等于把所有走反代的人静默丢掉。
        // 开发机由「本地开发不进正式数据」那条单独挡，不靠这个属性顺带。
        const a = await loadModule(true);
        a.initAnalytics();

        expect(appended).toHaveLength(1);
        expect(appended[0].attrs['data-domains']).toBeUndefined();
    });

    it('不采集 URL 查询串和 hash —— 推送深链会把角色 id 挂在参数上', async () => {
        // 冷启动点开推送通知时，URL 是 ?openApp=chat&activeMsgCharId=<角色id>，
        // 清参数的 handleDeepLink 跑在好几个 await 之后，赶不上脚本加载完就发的页面访问。
        // 所以必须让 tracker 从源头不收参数，而不是赌清理的时序。
        const a = await loadModule(true);
        a.initAnalytics();

        expect(appended[0].attrs['data-exclude-search']).toBe('true');
        expect(appended[0].attrs['data-exclude-hash']).toBe('true');
    });

    it('脚本加载完才发页面访问，且只发一次', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        a.initAnalytics();
        expect(tracked).toHaveLength(0);

        appended[0].fire('load');
        expect(tracked).toEqual([[undefined, undefined]]);
    });

    it('重复调用 initAnalytics 不会挂第二个标签', async () => {
        const a = await loadModule(true);
        a.initAnalytics();
        a.initAnalytics();
        expect(appended).toHaveLength(1);
    });
});

describe('脚本就绪前的事件', () => {
    /** 模拟 tracker 执行完：window.umami 出现，再触发 load。 */
    function scriptLoaded() {
        (globalThis as any).window.umami = {
            track: (name?: string, data?: unknown) => { tracked.push([name, data]); },
        };
        appended[0].fire('load');
    }

    it('脚本加载前触发的事件，加载完按顺序补发，页面访问排在最前', async () => {
        // 冷启动时本地数据常比统计脚本先就绪，以前这一半事件会被静默丢掉。
        const a = await loadModule(true);
        a.initAnalytics();
        a.trackEvent('数据规模', { 角色数: '1-3' });
        a.trackEvent('打开见面');
        expect(tracked).toHaveLength(0);

        scriptLoaded();
        expect(tracked).toEqual([
            [undefined, undefined],
            ['数据规模', { 角色数: '1-3' }],
            ['打开见面', undefined],
        ]);
    });

    it('排队期间关掉开关，排着的事件一条都不补发', async () => {
        const a = await loadModule(true);
        a.initAnalytics();
        a.trackEvent('打开见面');
        a.setAnalyticsEnabled(false);
        a.trackEvent('打开记忆宫殿');

        scriptLoaded();
        expect(tracked.filter(([name]) => name !== undefined)).toEqual([]);
    });

    it('脚本加载失败就清空队列，之后也不再攒', async () => {
        const a = await loadModule(true);
        a.initAnalytics();
        a.trackEvent('打开见面');
        appended[0].fire('error');
        a.trackEvent('打开记忆宫殿');

        scriptLoaded();
        expect(tracked).toEqual([[undefined, undefined]]);
    });

    it('加载卡住时最多攒 50 条', async () => {
        const a = await loadModule(true);
        a.initAnalytics();
        for (let i = 0; i < 60; i++) a.trackEvent(`事件${i}`);

        scriptLoaded();
        expect(tracked).toHaveLength(1 + 50);
        expect(tracked[50][0]).toBe('事件49');
    });
});

describe('用户关掉开关', () => {
    it('关掉之后启动，脚本压根不加载', async () => {
        const a = await loadModule(true);
        a.setAnalyticsEnabled(false);
        a.initAnalytics();
        expect(appended).toHaveLength(0);
    });

    it('会话中途关掉，tracker 自己发的性能指标也当场停', async () => {
        // 性能指标是 tracker 在页面隐藏 / 十秒后自己发的，不经过 trackEvent，
        // 那边的开关判断拦不到它。唯一的拦截点就是 data-before-send 这道闸门。
        const a = await loadModule(true);
        a.initAnalytics();

        const hookName = appended[0].attrs['data-before-send'];
        expect(hookName).toBeTruthy();
        const beforeSend = (globalThis as any).window[hookName] as (
            type: string,
            payload: unknown
        ) => unknown;
        expect(typeof beforeSend).toBe('function');

        const payload = { website: WEBSITE_ID, lcp: 1200 };
        expect(beforeSend('performance', payload)).toBe(payload);

        a.setAnalyticsEnabled(false);
        expect(beforeSend('performance', payload)).toBeNull();
    });

    it('会话中途关掉，后续 trackEvent 立刻停', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);

        a.trackEvent('打开见面');
        expect(tracked).toHaveLength(1);

        a.setAnalyticsEnabled(false);
        a.trackEvent('打开记忆宫殿');
        expect(tracked).toHaveLength(1);
    });

    it('默认是开启的（公告口径：默认开 + 随时可关）', async () => {
        const a = await loadModule(true);
        expect(a.isAnalyticsEnabled()).toBe(true);
    });
});

describe('Do Not Track', () => {
    it('浏览器开了 DNT，脚本一样不加载', async () => {
        installFakeDom({ doNotTrack: '1' });
        const a = await loadModule(true);
        a.initAnalytics();
        expect(appended).toHaveLength(0);
    });

    it('DNT 的判定跟开关无关，不需要用户自己去关', async () => {
        installFakeDom({ doNotTrack: 'yes' });
        const a = await loadModule(true);
        expect(a.isAnalyticsEnabled()).toBe(true);
        a.initAnalytics();
        expect(appended).toHaveLength(0);
    });
});

describe('本地开发不进正式数据', () => {
    // 统计不限制域名（反代官方站的人也要算进来），所以开发机得自己挡住，
    // 否则跑一次 build + preview 就把维护者自己的点击混进库里了。
    const 本地地址 = ['localhost', 'app.localhost', '127.0.0.1', '::1', '[::1]', '192.168.1.7', '10.0.0.3', '172.20.0.5'];

    for (const hostname of 本地地址) {
        it(`${hostname} 上不加载脚本`, async () => {
            installFakeDom({ hostname });
            const a = await loadModule(true);
            a.initAnalytics();
            expect(appended).toHaveLength(0);
        });
    }

    it('拿不到 hostname（file:// 打开）时也不加载', async () => {
        installFakeDom({ hostname: '' });
        const a = await loadModule(true);
        a.initAnalytics();
        expect(appended).toHaveLength(0);
    });

    it('陌生的公网域名照常统计 —— 这才是走反代的用户', async () => {
        installFakeDom({ hostname: 'sully.someone-else.com' });
        const a = await loadModule(true);
        a.initAnalytics();
        expect(appended).toHaveLength(1);
    });
});

describe('规模档位', () => {
    it('记忆条数的档位边界跟公告一致', async () => {
        const a = await loadModule(true);
        expect(a.bucketMemoryCount(0)).toBe('0');
        expect(a.bucketMemoryCount(1)).toBe('1-100');
        expect(a.bucketMemoryCount(100)).toBe('1-100');
        expect(a.bucketMemoryCount(101)).toBe('101-500');
        expect(a.bucketMemoryCount(500)).toBe('101-500');
        expect(a.bucketMemoryCount(501)).toBe('500+');
    });

    it('角色数的档位边界跟公告一致', async () => {
        const a = await loadModule(true);
        expect(a.bucketCharacterCount(0)).toBe('0');
        expect(a.bucketCharacterCount(3)).toBe('1-3');
        expect(a.bucketCharacterCount(4)).toBe('4-6');
        expect(a.bucketCharacterCount(7)).toBe('7-10');
        expect(a.bucketCharacterCount(10)).toBe('7-10');
        expect(a.bucketCharacterCount(11)).toBe('11+');
    });

    it('单角色聊天条数的档位边界', async () => {
        const a = await loadModule(true);
        expect(a.bucketMessageCount(0)).toBe('0');
        expect(a.bucketMessageCount(1)).toBe('1-500');
        expect(a.bucketMessageCount(500)).toBe('1-500');
        expect(a.bucketMessageCount(501)).toBe('501-2000');
        expect(a.bucketMessageCount(2000)).toBe('501-2000');
        expect(a.bucketMessageCount(2001)).toBe('2001-10000');
        expect(a.bucketMessageCount(10000)).toBe('2001-10000');
        expect(a.bucketMessageCount(10001)).toBe('10000+');
    });

    it('重试次数按 3 次切档 —— 裸计数器不许直接上报', async () => {
        const a = await loadModule(true);
        expect(a.bucketRetryCount(0)).toBe('0');
        expect(a.bucketRetryCount(1)).toBe('1-2');
        expect(a.bucketRetryCount(2)).toBe('1-2');
        expect(a.bucketRetryCount(3)).toBe('3+');
        expect(a.bucketRetryCount(99)).toBe('3+');
    });

    it('本地存储占用的档位边界', async () => {
        const a = await loadModule(true);
        const MB = 1024 * 1024;
        expect(a.bucketStorageBytes(0)).toBe('<50MB');
        expect(a.bucketStorageBytes(50 * MB - 1)).toBe('<50MB');
        expect(a.bucketStorageBytes(50 * MB)).toBe('50-200MB');
        expect(a.bucketStorageBytes(200 * MB)).toBe('200MB-1GB');
        expect(a.bucketStorageBytes(1024 * MB)).toBe('1GB+');
    });

    it('存储水位的档位边界', async () => {
        const a = await loadModule(true);
        const GB = 1024 * 1024 * 1024;
        expect(a.bucketStorageWatermark(0, GB)).toBe('<25%');
        expect(a.bucketStorageWatermark(0.25 * GB, GB)).toBe('25-50%');
        expect(a.bucketStorageWatermark(0.5 * GB, GB)).toBe('50-80%');
        expect(a.bucketStorageWatermark(0.8 * GB, GB)).toBe('80%+');
        expect(a.bucketStorageWatermark(GB, GB)).toBe('80%+');
    });

    it('每次会话最多报一次，重复调用不再发', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);

        a.trackDataScaleOnce({ ...SCALE, characterCount: 5, memoryCount: 300 });
        a.trackDataScaleOnce({ ...SCALE, characterCount: 6, memoryCount: 900 });

        expect(tracked).toHaveLength(1);
        expect(tracked[0][0]).toBe('数据规模');
        expect((tracked[0][1] as any)['角色数']).toBe('4-6');
        expect((tracked[0][1] as any)['记忆条数']).toBe('101-500');
    });

    it('只发区间，不发精确值', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        a.trackDataScaleOnce({
            characterCount: 7,
            memoryCount: 412,
            maxMemoryCount: 388,
            maxMessageCount: 6431,
            storageBytes: 137_428_992,
            storageQuotaBytes: 2_147_483_648,
            persistedStorage: true,
            standalone: true,
        });

        const payload = JSON.stringify(tracked[0][1]);
        for (const raw of ['412', '388', '6431', '137428992', '2147483648']) {
            expect(payload).not.toContain(raw);
        }
    });

    it('持久化许可只报「已获得 / 未获得」两个写死的值', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        a.trackDataScaleOnce({ ...SCALE, persistedStorage: true });
        expect((tracked[0][1] as any)['持久化许可']).toBe('已获得');
    });

    it('查不了持久化状态的浏览器，这一项缺席而不是当成「未获得」', async () => {
        // 查不了 ≠ 没拿到。混为一谈会把 Safari 那批人全算成裸奔，结论直接反过来。
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        a.trackDataScaleOnce({ ...SCALE, persistedStorage: null });
        expect(tracked[0][1] as any).not.toHaveProperty('持久化许可');
    });

    it('浏览器不给存储配额时，这一项直接缺席，不拿 0 顶上', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        a.trackDataScaleOnce({ ...SCALE, storageBytes: null });

        expect(Object.keys(tracked[0][1] as object)).not.toContain('本地存储占用');
    });

    it('读不到配额上限时，水位这一项缺席', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        a.trackDataScaleOnce({ ...SCALE, storageBytes: 100, storageQuotaBytes: null });

        expect(tracked[0][1] as any).not.toHaveProperty('存储水位');
    });

    it('配额报成 0 时也缺席 —— 别拿 0 去除算出一条假的「80%+」', async () => {
        // 隐私模式下有浏览器会回 quota: 0。除零得 Infinity，落进最高档，
        // 结论就成了「这批人全都快满了」，正好反过来。
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        a.trackDataScaleOnce({ ...SCALE, storageBytes: 100, storageQuotaBytes: 0 });

        expect(tracked[0][1] as any).not.toHaveProperty('存储水位');
    });

    it('全屏运行只有是/否两个值', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        a.trackDataScaleOnce({ ...SCALE, standalone: false });
        expect((tracked[0][1] as any)['全屏运行']).toBe('否');
    });

    it('节流标记不落 localStorage —— 统计不给自己记账', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        a.trackDataScaleOnce({ ...SCALE, characterCount: 2, memoryCount: 10 });

        const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
        expect(keys).not.toContain('umami.disabled');
        // 唯一允许出现的键是开关本身（用户偏好），而且这次没动过开关，所以应该一个键都没有。
        expect(keys).toHaveLength(0);
    });
});

/**
 * 回归守卫：五组快照事件轮流报，一次页面加载只出一组。
 *
 * 外观、角色设置、功能启用是主要属性开销；SAR 发布状态参与同一次抽签，
 * 不额外上报一条，也不扩大已有功能事件。
 *
 * 所以「一次只出一组」是这几条事件的成本底线，不是可有可无的优化。哪天有人为了让
 * 交叉分析好做一点，把某一组挪出轮转变成每次都报，这里就会挂。
 */
describe('快照事件的槽位轮转', () => {
    /** 五组挨个调一遍，返回实际发出去的事件名。 */
    const fireAll = (a: Awaited<ReturnType<typeof loadModule>>) => {
        a.trackDataScaleOnce({ ...SCALE });
        a.trackCurrentAppearanceOnce({ 深色模式: '开' });
        a.trackCurrentCharSettingsOnce({ 记忆宫殿: '有人开' });
        a.trackCurrentFeaturesOnce({ 天气: '开' });
        a.trackCurrentSARFeaturesOnce({ 自动回复: '开' });
        return tracked.map(([name]) => name);
    };

    it('一次页面加载只报一组，另外四组静默跳过', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true, 'appearance');
        expect(fireAll(a)).toEqual(['当前外观']);
    });

    it('五个槽位各报各的那一条，没有哪组被永久锁死', async () => {
        const expected = ['数据规模', '当前外观', '当前角色设置', '当前功能启用', '当前SAR与聊天输入'];
        for (let i = 0; i < SLOT_ORDER.length; i++) {
            installFakeDom({ withUmami: true });
            const a = await loadModule(true, SLOT_ORDER[i]);
            expect(fireAll(a)).toEqual([expected[i]]);
        }
    });

    it.each(['features', 'sar'] as const)('轮到的 %s 仍然一次会话只报一次', async slot => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true, slot);
        const report = slot === 'sar' ? a.trackCurrentSARFeaturesOnce : a.trackCurrentFeaturesOnce;
        report({ 天气: '开' });
        report({ 天气: '关' });
        expect(tracked).toHaveLength(1);
    });
});

describe('自定义值收敛', () => {
    const BUILTIN = ['chime', 'ding', 'pop'];

    it('内置 key 原样报', async () => {
        const a = await loadModule(true);
        expect(a.presetOrCustom('ding', BUILTIN)).toBe('ding');
    });

    it('用户填的直链 / 上传的音频 / 自起的名字，一律收敛成 custom', async () => {
        const a = await loadModule(true);
        for (const v of [
            'https://example.com/我的私人音效.mp3',
            'data:audio/mpeg;base64,SUQzBAAAAAA',
            '给小明同学的专属提示音',
        ]) {
            expect(a.presetOrCustom(v, BUILTIN)).toBe('custom');
        }
    });

    it('没设过就报默认值，不报空串', async () => {
        const a = await loadModule(true);
        expect(a.presetOrCustom(undefined, BUILTIN, '没设')).toBe('没设');
        expect(a.presetOrCustom('', BUILTIN, '没设')).toBe('没设');
    });

    it('微调数值只报调没调过，具体数字不出门', async () => {
        const a = await loadModule(true);
        expect(a.tweakedOrDefault(undefined)).toBe('默认');
        expect(a.tweakedOrDefault(0)).toBe('默认');
        expect(a.tweakedOrDefault(17)).toBe('调过');
        expect(a.tweakedOrDefault(-3)).toBe('调过');
    });
});

describe('角色开关汇总', () => {
    it('默认关的功能：问有没有人开过', async () => {
        const a = await loadModule(true);
        expect(a.anyCharToggle([undefined, false, undefined], false)).toBe('都没开');
        expect(a.anyCharToggle([undefined, true, false], false)).toBe('有人开');
    });

    it('默认开的功能：问有没有人特意关掉，而不是有没有人开着', async () => {
        const a = await loadModule(true);
        // 全是 undefined = 谁都没动过 = 都还开着。
        // 要是这里按「有没有人开着」问，答案永远是「有」，等于没信息。
        expect(a.anyCharToggle([undefined, undefined], true)).toBe('都开着');
        expect(a.anyCharToggle([undefined, false], true)).toBe('有人关掉');
    });

    it('一个角色都没有时不会误判', async () => {
        const a = await loadModule(true);
        expect(a.anyCharToggle([], false)).toBe('都没开');
        expect(a.anyCharToggle([], true)).toBe('都开着');
    });
});

describe('会话内发送条数', () => {
    /** 让 fake document 支持 visibilitychange，并能手动切到后台。 */
    function withVisibility() {
        const listeners: Array<() => void> = [];
        const doc = (globalThis as any).document;
        doc.visibilityState = 'visible';
        doc.addEventListener = (type: string, fn: () => void) => {
            if (type === 'visibilitychange') listeners.push(fn);
        };
        return () => {
            doc.visibilityState = 'hidden';
            listeners.forEach((fn) => fn());
            doc.visibilityState = 'visible';
        };
    }

    it('档位边界', async () => {
        const a = await loadModule(true);
        expect(a.bucketSessionMessages(0)).toBe('0');
        expect(a.bucketSessionMessages(10)).toBe('1-10');
        expect(a.bucketSessionMessages(11)).toBe('11-50');
        expect(a.bucketSessionMessages(50)).toBe('11-50');
        expect(a.bucketSessionMessages(200)).toBe('51-200');
        expect(a.bucketSessionMessages(201)).toBe('200+');
    });

    it('发消息本身一个请求都不发 —— 不产生时间线', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        withVisibility();

        for (let i = 0; i < 30; i++) a.noteMessageSent();
        expect(tracked).toHaveLength(0);
    });

    it('切到后台才报一次，只发区间', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        const goHidden = withVisibility();

        for (let i = 0; i < 30; i++) a.noteMessageSent();
        goHidden();

        expect(tracked).toEqual([['私聊会话发送条数', { 条数: '11-50' }]]);
    });

    it('反复切来切去，档位没变就不重复报', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        const goHidden = withVisibility();

        a.noteMessageSent();
        goHidden();
        goHidden();
        goHidden();
        expect(tracked).toHaveLength(1);

        // 跨到下一档才会再报一次
        for (let i = 0; i < 20; i++) a.noteMessageSent();
        goHidden();
        expect(tracked).toHaveLength(2);
        expect(tracked[1]).toEqual(['私聊会话发送条数', { 条数: '11-50' }]);
    });

    it('一条都没发过的会话，连监听器都不装，一个点都不产生', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        const goHidden = withVisibility();

        goHidden();
        expect(tracked).toHaveLength(0);
    });
});

describe('上报出口', () => {
    it('window.umami 不存在时静默跳过，不抛', async () => {
        installFakeDom({ withUmami: false });
        const a = await loadModule(true);
        expect(() => a.trackEvent('打开调试面板')).not.toThrow();
    });

    it('压根没有 window 时也不抛 —— 埋点散在工具模块里，有的会在非浏览器环境被 import', async () => {
        const a = await loadModule(true);
        // 显式抹掉浏览器全局，模拟 worker / Node 里 import 到带埋点的叶子模块。
        delete (globalThis as any).window;
        delete (globalThis as any).document;
        delete (globalThis as any).navigator;

        expect(() => a.trackEvent('触发翻译白屏护栏')).not.toThrow();
        expect(() => a.initAnalytics()).not.toThrow();
    });

    it('事件名和枚举属性原样透传', async () => {
        installFakeDom({ withUmami: true });
        const a = await loadModule(true);
        a.trackEvent('打开记忆宫殿房间', { 房间: '情感空间' });
        expect(tracked).toEqual([['打开记忆宫殿房间', { 房间: '情感空间' }]]);
    });
});
