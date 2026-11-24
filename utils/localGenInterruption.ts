/**
 * 对照组埋点：本机直连模型的生成请求，有多常因为用户切走页面被打断。
 * 全局 fetch 拦截器（context/OSContext.tsx）在每条本机对话生成请求开始和结束时各调一次；
 * appEntry.tsx 冷启动时挂监听，并把上次留下的标记补报成「页面被关」。
 * 只上报固定枚举：用途走下面的白名单，认不出的一律「其他」；报错原文、URL、模型名都不进上报。
 */
import { trackEvent } from './analytics';
import { classifyFetchFailure, type FetchFailureKind } from './networkFailureDiagnosis';

export const LOCAL_GEN_INTERRUPTED_EVENT = '本机生成被切走打断';
/** 进后台那一刻还在飞的本机生成用途。sullyos_notice_ 前缀让各用户空间共用；属于设备状态，不进备份。 */
export const LOCAL_GEN_INFLIGHT_KEY = 'sullyos_notice_local_gen_inflight_v1';

/** 用途标签 → 调用点实际传的 purpose 字面量。新入口要统计就在这里登记。 */
const PURPOSES_BY_LABEL = {
    私聊: [
        '聊天回复', '排程后补充回复', '排程工具续写', '排程工具兼容重试', 'MCP 工具续写', 'MCP 工具收尾回复',
        'MCP tools 兼容重试', 'Claude 中转兼容重试', '点单后补充回复', '瑞幸点单回复', '瑞幸点单续写', '麦当劳点餐回复',
    ],
    日程: ['生成当日日程', '进化意识流'],
    人格模拟: ['生成人格模拟剧本'],
    梦境: ['梦境剧本生成'],
    见面: ['见面开场', '见面对话', '重随见面开场', '重随见面回复', '剧情见面开场', '剧情见面生成', '重随剧情见面'],
    哔哔: ['刷新动态', '刷新评论', '评论接话'],
    查手机: [
        '查手机AI生成', '生成聊天记录', '扫描通讯录联系人', '生成通话记录', '生成购物订单', '生成外卖记录',
        '生成朋友圈动态', '生成手机应用数据', '生成TA的AI会话', 'AI会话摘要', 'TA的AI助手回复', 'TA的AI会话续写',
        '酒馆角色卡开场', '联系人私聊回复', '跨角色私聊互动',
    ],
    记忆提取: ['记忆提取', '群记忆提取'],
    记忆压缩: ['事件压缩', '事件压缩-二次压缩'],
    记忆消化: ['记忆消化'],
    门牌整理: ['门牌整理'],
    记忆归档: ['单日记忆归档', '单日记忆强制归档', '批量记忆总结', '月度核心记忆提炼'],
    小剧场: ['小剧场生成'],
    交换日记: ['交换日记回信'],
} as const;

type KnownLabel = keyof typeof PURPOSES_BY_LABEL;
export type LocalGenLabel = KnownLabel | '其他';

const ALL_LABELS: readonly LocalGenLabel[] = [...Object.keys(PURPOSES_BY_LABEL) as KnownLabel[], '其他'];
const LABEL_BY_PURPOSE = new Map<string, KnownLabel>(
    (Object.keys(PURPOSES_BY_LABEL) as KnownLabel[]).flatMap(label => PURPOSES_BY_LABEL[label].map(purpose => [purpose, label] as const)),
);

export function localGenPurposeLabel(purpose: unknown): LocalGenLabel {
    if (typeof purpose !== 'string') return '其他';
    // 查手机自定义应用把应用名拼在用途后面，只认前缀。
    if (purpose.startsWith('生成自定义应用·')) return '查手机';
    return LABEL_BY_PURPOSE.get(purpose) ?? '其他';
}

export interface LocalGenRequest { label: LocalGenLabel; url: string; hiddenCountAtStart: number }

let hiddenCount = 0;
const inFlight = new Set<LocalGenRequest>();
/** 只有进后台那一刻在飞的才进标记：后台期间新开的请求不写（请求开始时不碰 localStorage）。 */
let markedAtHide = new Set<LocalGenRequest>();

function writeMarker(): void {
    try {
        if (markedAtHide.size) localStorage.setItem(LOCAL_GEN_INFLIGHT_KEY, JSON.stringify([...markedAtHide].map(r => r.label)));
        else localStorage.removeItem(LOCAL_GEN_INFLIGHT_KEY);
    } catch { /* 写不进只是少一条统计 */ }
}

// 页面随时可能在后台被杀，标记必须在进后台这一刻同步写好。
function snapshotInFlight(): void {
    markedAtHide = new Set(inFlight);
    writeMarker();
}

/** 连接测试、拉模型列表这类不是生成，不统计。 */
export function beginLocalGen(input: { url: string; method: string; purpose: unknown }): LocalGenRequest | undefined {
    if (input.method.toUpperCase() !== 'POST' || input.purpose === '测试连接') return undefined;
    const request: LocalGenRequest = { label: localGenPurposeLabel(input.purpose), url: input.url, hiddenCountAtStart: hiddenCount };
    inFlight.add(request);
    return request;
}

// 只算没拿到可用响应的断连；AbortError 是代码主动中止，unknown 多半是本地处理出错。
const NETWORK_KINDS: ReadonlySet<FetchFailureKind> = new Set(['blocked', 'timeout', 'offline']);

/** 请求收尾时调一次；只有请求抛错时传 error。有 HTTP 状态的失败（含流里的上游报错）按正常收尾处理。 */
export function endLocalGen(request: LocalGenRequest | undefined, error?: unknown): void {
    if (!request || !inFlight.delete(request)) return;
    if (markedAtHide.delete(request)) writeMarker();
    if (error === undefined || request.hiddenCountAtStart === hiddenCount) return;
    if ((error as { __sullyUpstreamStreamError?: unknown } | null)?.__sullyUpstreamStreamError) return;
    if (!NETWORK_KINDS.has(classifyFetchFailure({ url: request.url, error }))) return;
    trackEvent(LOCAL_GEN_INTERRUPTED_EVENT, { 用途: request.label, 情形: '回来后报错' });
}

function reportClosedInBackground(): void {
    let raw: string | null;
    try {
        raw = localStorage.getItem(LOCAL_GEN_INFLIGHT_KEY);
        if (raw === null) return;
        localStorage.removeItem(LOCAL_GEN_INFLIGHT_KEY);
    } catch { return; }
    let stored: unknown;
    try { stored = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(stored)) return;
    // 标记是本机可改的数据：条数设上限，取值重新对一遍白名单再报。
    for (const item of stored.slice(0, 20)) {
        trackEvent(LOCAL_GEN_INTERRUPTED_EVENT, { 用途: ALL_LABELS.find(label => label === item) ?? '其他', 情形: '页面被关' });
    }
}

let installed = false;

// shortcut: 多个标签页共用一个标记键，另开标签页会把还活着的后台页误报成「页面被关」；要按页区分时改成每页一个键。
export function installLocalGenInterruptionWatch(): void {
    if (installed || typeof document === 'undefined' || typeof window === 'undefined') return;
    installed = true;
    reportClosedInBackground();
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            hiddenCount += 1;
            snapshotInFlight();
        } else {
            markedAtHide.clear();
            writeMarker();
        }
    });
    window.addEventListener('pagehide', snapshotInFlight);
}
