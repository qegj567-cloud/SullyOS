/**
 * 使用统计（自托管 umami）。
 *
 * 这个文件是「会往外发什么」的唯一出口——想知道 SullyOS 到底上报了什么，
 * 读这一个文件加上全仓库对 trackEvent 的调用就够了，没有别的通道。
 *
 * 四条硬约束，改之前先读完：
 *
 *   1. 只上报「哪个页面被打开了 / 哪个功能被用了一次」，外加一组页面加载快慢的数值
 *      （LCP / INP / CLS / FCP / TTFB，浏览器自己测出来的毫秒数，跟页面内容无关）。
 *      永远不碰对话内容、记忆、
 *      角色设定、用户设定、任何输入框里的文字、任何 API / MCP 配置值。
 *      事件属性只允许固定枚举值（房间名、模式名这种取值集合写死在代码里的东西），
 *      不允许出现任何来自用户输入或模型输出的字符串。
 *
 *   2. 加不加载统计脚本由构建时环境变量决定。两个变量没配齐 → 整个模块空转：
 *      不创建 script 标签、window.umami 不存在、所有上报都是空调用。
 *      自部署实例默认就是这个状态，一个统计请求都不会发。
 *
 *   3. 统计自己不往 localStorage / cookie 写任何记账数据。会话级节流只存内存变量，
 *      标签页一关就没了。localStorage 里只有 os_analytics 一个键，存的是开关本身的
 *      状态（用户偏好），不是追踪状态。
 *
 *   4. 每条出站都要先过 data-before-send 那道闸门（挂在 window 上的一个函数），
 *      开关关着就返回空、当场不发。性能指标是 tracker 自己在页面隐藏时发的，
 *      不走 trackEvent，没有这道闸门的话，会话中途关掉开关拦不住它。
 *
 * 另外刻意关掉了 umami 自动发的页面访问（data-auto-pageview="false"），改成由本模块
 * 显式发一次。tracker 自己会往外发的就只剩性能指标那一条，其余全部经过 trackEvent，
 * 审计时看这一个函数加它的调用点就够。
 */

import { APP_VERSION_TAG } from './buildInfo';
import { RELEASE_CHANNEL, type ReleaseChannel } from './releaseChannel';

/** 统计标签：版本号那半截，canary 构建加后缀。取值只有这两种，同一版同一通道的人完全一样。 */
export const analyticsTag = (channel: ReleaseChannel = RELEASE_CHANNEL): string =>
  channel === 'canary' ? `${APP_VERSION_TAG}-canary` : APP_VERSION_TAG;

// ===== 构建时开关 =====
// 两个都配齐才会加载统计脚本。官方部署在构建环境里配，自部署默认没有。
const SCRIPT_URL = (import.meta.env.VITE_UMAMI_SCRIPT_URL || '').trim();
const WEBSITE_ID = (import.meta.env.VITE_UMAMI_WEBSITE_ID || '').trim();

/** 开关状态存这里，跟 os_theme / os_api_config 一样是本地的用户偏好。 */
const SETTINGS_KEY = 'os_analytics';

/**
 * 出站闸门函数挂在 window 上的名字。umami 只认名字（`window[data-before-send]`），
 * 传不了函数引用，所以必须占一个全局键。
 */
const BEFORE_SEND_HOOK = '__sullyosAnalyticsBeforeSend';

declare global {
  interface Window {
    umami?: {
      track: (name?: string, data?: Record<string, string | number | boolean>) => void;
    };
  }
}

// ===== 开关 =====

/** 默认开启，用户可在设置里关掉（公告口径：默认开 + 随时可关）。 */
export function isAnalyticsEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return true;
    return JSON.parse(raw)?.enabled !== false;
  } catch {
    // 读不出来（隐私模式 / 存储被禁）时按开启算，跟没配置过是同一个状态。
    return true;
  }
}

export function setAnalyticsEnabled(enabled: boolean): void {
  // 关掉时把还没发出去的排队事件一起扔掉，不留到脚本加载完再发。
  if (!enabled && pendingEvents) pendingEvents = [];
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ enabled }));
  } catch {
    // 写不进去就算了：这一次会话内的开关状态由调用方的 React state 保证，
    // 下次启动回落到默认值。不值得为此打断用户。
  }
}

/** 统计功能在这次构建里是否可用（用来决定设置页要不要显示这个开关）。 */
export function isAnalyticsConfigured(): boolean {
  return Boolean(SCRIPT_URL && WEBSITE_ID);
}

/**
 * The tracker is optional infrastructure. Its send endpoint must never be
 * surfaced as an OS/API failure when an ad blocker or the network blocks it.
 */
export function isAnalyticsRequestUrl(value: string): boolean {
  if (!SCRIPT_URL || !value) return false;
  try {
    const pageBase =
      (typeof window !== 'undefined' && window.location?.href) ||
      'https://sully.invalid/';
    const scriptUrl = new URL(SCRIPT_URL, pageBase);
    const requestUrl = new URL(value, pageBase);
    return (
      requestUrl.origin === scriptUrl.origin &&
      /^\/api\/send\/?$/.test(requestUrl.pathname)
    );
  } catch {
    return false;
  }
}

/** 浏览器有没有开 Do Not Track。开了就整个跳过，连脚本都不加载。 */
function hasDoNotTrack(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const dnt =
    (window as any).doNotTrack ??
    (navigator as any).doNotTrack ??
    (navigator as any).msDoNotTrack;
  return dnt === 1 || dnt === '1' || dnt === 'yes';
}

/**
 * 是不是维护者自己在本地跑（含局域网真机调试）。是的话不统计。
 *
 * 统计不限制域名：有人因为网络原因挂自己的域名反代官方站，那也是真实用户，
 * 得算进来。域名这一层唯一要挡的就是开发机自己——不然跑一次 build + preview，
 * 自己点的每一下都会混进正式数据里。
 *
 * 拿不到 hostname（file:// 打开之类）时按本地算，宁可少发不可错发。
 */
function isLocalHostname(): boolean {
  const host = (typeof window !== 'undefined' && window.location?.hostname) || '';
  if (!host) return true;
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

// ===== 加载 =====

let loadAttempted = false;

/**
 * 脚本已插进页面、还没执行完的这段时间里发生的事件。
 *
 * 冷启动时本地数据加载完和统计脚本就绪几乎同时发生，先到的那一半事件以前会被
 * `window.umami?.track` 静默丢掉（实测冷启动快照只覆盖了约一半的页面访问）。
 * 这里先记下，脚本加载完先发页面访问、再按顺序补发。
 *
 * 只在内存里：不落 localStorage / IndexedDB，标签页一关就没了。脚本加载失败、
 * 用户关掉开关时整队清空。设上限是因为加载卡住时不该无限攒。
 */
let pendingEvents: Array<[string, Record<string, string | number | boolean> | undefined]> | null = null;
const MAX_PENDING_EVENTS = 50;

/**
 * 挂上统计脚本并发一次页面访问。在 index.tsx 里启动时调用一次。
 *
 * 下面任意一条成立就直接返回，什么都不做也什么都不创建：
 *   - 构建时没配环境变量（自部署实例）
 *   - 用户在设置里关掉了
 *   - 浏览器开了 DNT
 *   - 本地开发 / 局域网真机调试
 */
export function initAnalytics(): void {
  if (loadAttempted) return;
  if (typeof document === 'undefined') return;
  if (!isAnalyticsConfigured()) return;
  if (!isAnalyticsEnabled()) return;
  if (hasDoNotTrack()) return;
  if (isLocalHostname()) return;
  loadAttempted = true;

  const script = document.createElement('script');
  script.src = SCRIPT_URL;
  script.defer = true;
  script.setAttribute('data-website-id', WEBSITE_ID);
  // 这里刻意不挂 data-domains（umami 的主机名白名单）：挂了的话，挂自己域名
  // 反代官方站的人在浏览器里就被 tracker 挡掉了，一条数据都不会有。开发机
  // 由上面的 isLocalHostname 单独挡。
  // 上面已经自己挡过一次 DNT 了，这里再挂一道：脚本自己也认这个属性，
  // 万一以后加载路径改了，这层不会跟着一起失效。
  script.setAttribute('data-do-not-track', 'true');
  // 页面访问只记路径，URL 查询串和 # 后内容不采集。冷启动点开推送通知时，
  // URL 上挂着 ?openApp=chat&activeMsgCharId=<角色id>（见 sw-keep-alive 的
  // notificationclick），而清参数的 handleDeepLink 排在好几个 await 之后，
  // 赶不上脚本加载完就发的那次页面访问。与其赌时序，不如让 tracker 从源头不收——
  // 角色 id 是稳定标识，进了库就是跨月关联器，一次都不能漏。
  script.setAttribute('data-exclude-search', 'true');
  script.setAttribute('data-exclude-hash', 'true');
  // 关掉 tracker 自动发的页面访问，改由下面那行显式发一次——见文件头注释。
  // 这里用的是 data-auto-pageview 而不是 data-auto-track：后者会把 tracker 的整个
  // 初始化一起跳过，性能指标也就跟着不启动了。代价是 tracker 会挂上它自带的点击上报
  // （只认元素上的 data-umami-event-* 属性），仓库里一个都没有，所以它一条也发不出来——
  // 想让某个按钮自己上报请照旧调 trackEvent，别去挂那个属性，不然就绕过了这里的收敛。
  script.setAttribute('data-auto-pageview', 'false');
  // 真实用户的加载体验：LCP / INP / CLS / FCP / TTFB，由 tracker 在页面隐藏或十秒后
  // 自己发一条，跟着的上下文和页面访问那条一样（也就是被上面两行洗过的路径）。
  script.setAttribute('data-performance', 'true');
  // 每条记录（含性能那条）都带上当时的产品版本号，面板里能按版本切开看。
  // 性能数字尤其需要这个轴——两个版本的数据混在一起，「这次优化到底有没有让首屏变快」
  // 就问不出来了。值写死在 buildInfo 里，同一版的所有人是同一个字符串，不带个人特征，
  // 也就不会给 docs/analytics.md「这是假名，不是匿名」里说的那个关联窗口添新维度。
  // canary 构建挂 `v3.7-canary`，所有数据都能按通道切开（docs/canary-channel.md）。
  script.setAttribute('data-tag', analyticsTag());
  // 出站前的最后一道闸门，见文件头第 4 条。要在脚本插进 DOM 之前挂好。
  (window as unknown as Record<string, unknown>)[BEFORE_SEND_HOOK] = (
    _type: string,
    payload: unknown
  ) => (isAnalyticsEnabled() ? payload : null);
  script.setAttribute('data-before-send', BEFORE_SEND_HOOK);
  pendingEvents = [];
  script.addEventListener('load', () => {
    const queued = pendingEvents ?? [];
    pendingEvents = null;
    window.umami?.track();
    // 排队期间开关可能被关掉；每一条都再问一次，tracker 内部还有 before-send 闸门兜底。
    for (const [name, data] of queued) {
      if (!isAnalyticsEnabled()) break;
      window.umami?.track(name, data);
    }
  });
  script.addEventListener('error', () => {
    pendingEvents = null;
  });
  document.head.appendChild(script);
}

// ===== 上报 =====

/**
 * 上报一次「某个功能被用了」。
 *
 * @param name 功能名，中文，跟公告里写的一致（如「打开见面」）。用户按 F12 看到的
 *             就是这几个字，不用再对照一份英文 slug 表。
 * @param data 该功能自身的枚举选项。取值必须来自代码里写死的固定集合，
 *             不允许传用户输入、角色名、记忆内容或任何配置值。
 */
export function trackEvent(
  name: string,
  data?: Record<string, string | number | boolean>
): void {
  // 没有 window 就直接走人。埋点散在一堆工具模块里，其中有些是跟 worker 共用的叶子，
  // 会在没有 window 的环境里被 import；这里少一道判断就是把「永远安全的空调用」
  // 变成 ReferenceError。`window.umami?.` 只挡得住 umami 没加载，挡不住 window 不存在。
  if (typeof window === 'undefined') return;
  if (!isAnalyticsEnabled()) return;
  if (window.umami) {
    window.umami.track(name, data);
    return;
  }
  // 脚本还在路上就先排队；没在加载（没配、关着、DNT、本地开发、加载失败）时队列是 null，照旧空调用。
  if (pendingEvents && pendingEvents.length < MAX_PENDING_EVENTS) {
    pendingEvents.push([name, data]);
  }
}

// ===== 数据规模档位 =====

/**
 * 已经上报过的规模档位。**只存内存**：标签页一关就没了，
 * 不落 localStorage、不落 IndexedDB、不落 cookie。
 *
 * 「每会话一次」是采集侧的口径，跟统计周期无关——想看月度还是周度，
 * 在 dashboard 的日期范围里框就行，客户端不需要知道有「月」这回事。
 */
const reportedScales = new Set<string>();

/** 每次冷启动只选一组，新增 SAR 槽位也参与同一次选择。 */
const SNAPSHOT_SLOTS = ['data-scale', 'appearance', 'char-settings', 'features', 'sar'] as const;
export type SnapshotSlot = (typeof SNAPSHOT_SLOTS)[number];

/**
 * 五组快照随机选一组：数据规模最多 8、外观 36、角色设置 36、功能 33、SAR 10 个属性。
 * 每次平均约 24 行，避免加宽已有功能事件；未选中的组也不读取数据。
 * 轮转与上报标记只留在内存，不在用户设备保存统计账本。样本量足够时各组均匀出现；
 * 跨组关联仍需要同一 session 多次冷启动，不把多组重新合成一条事件。
 */
const activeSnapshotSlot: SnapshotSlot =
  SNAPSHOT_SLOTS[Math.floor(Math.random() * SNAPSHOT_SLOTS.length)];

/**
 * 这次冷启动轮到的是不是这一组。
 *
 * 取数那侧（analyticsSnapshot 的几个 collector，其中两个要读 IndexedDB）也该先问一句
 * 再动手，没轮到就别白跑。上报函数内部还会再问一次，两处都判不是重复——取数点漏了
 * 只是白费一次 CPU，上报点漏了就是白发一条事件。
 */
export function shouldReportSnapshot(slot: SnapshotSlot): boolean {
  return activeSnapshotSlot === slot;
}

/** 记忆条数档位。区间与公告一致。 */
export function bucketMemoryCount(count: number): string {
  if (count <= 0) return '0';
  if (count <= 100) return '1-100';
  if (count <= 500) return '101-500';
  return '500+';
}

/** 角色数档位。区间与公告一致。 */
export function bucketCharacterCount(count: number): string {
  if (count <= 0) return '0';
  if (count <= 3) return '1-3';
  if (count <= 6) return '4-6';
  if (count <= 10) return '7-10';
  return '11+';
}

/**
 * 单个角色的聊天条数档位（取所有角色里的最大值）。
 * 跟「总条数」问的不是同一件事：总数大可能只是角色多，单角色堆到上万条才是
 * 聊天列表渲染和上下文拼装真正的压力点，虚拟滚动之类的投入看的是这个。
 */
export function bucketMessageCount(count: number): string {
  if (count <= 0) return '0';
  if (count <= 500) return '1-500';
  if (count <= 2000) return '501-2000';
  if (count <= 10000) return '2001-10000';
  return '10000+';
}

/**
 * 重试次数档位。裸计数器是开放整数，不满足「属性只能是固定枚举」这条硬约束，
 * 上报前先分桶。档位按「第 3 次」切，是因为界面上多数重试到第 3 次就会换一套补救手段。
 */
export function bucketRetryCount(count: number): string {
  if (count <= 0) return '0';
  if (count <= 2) return '1-2';
  return '3+';
}

/**
 * 小计数档位（配了几个 MCP 服务器、存了几条 API 预设这类）。
 * 裸计数是开放整数，不满足「属性只能是固定枚举」，上报前先分桶。
 * 1 单独占一档，是因为「只配了一个」和「配了一堆」是两种人：
 * 前者试了一下，后者已经把它当基础设施在用。
 */
export function bucketFewCount(count: number): string {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2-3';
  return '4+';
}

/**
 * 本地存储占用档位。数字来自 navigator.storage.estimate()，
 * 浏览器只回一个字节数，不涉及任何内容。用来判断要不要做数据清理 / 分片。
 */
export function bucketStorageBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 50) return '<50MB';
  if (mb < 200) return '50-200MB';
  if (mb < 1024) return '200MB-1GB';
  return '1GB+';
}

/**
 * 存储水位档位：本机数据占掉了浏览器给的配额的多少。
 * 光看字节数判断不了「会不会被系统清掉」——同样 800MB，桌面 Chrome 配额几十 GB
 * 无所谓，iOS Safari 只给 1GB 出头就是随时挨清。跟「持久化许可」放在同一条里，
 * 才框得出「快满了、又没拿到许可」这批最该被催备份的人。
 */
export function bucketStorageWatermark(usageBytes: number, quotaBytes: number): string {
  const ratio = usageBytes / quotaBytes;
  if (ratio < 0.25) return '<25%';
  if (ratio < 0.5) return '25-50%';
  if (ratio < 0.8) return '50-80%';
  return '80%+';
}

/**
 * 上报数据规模档位，每次会话最多一次。
 *
 * 全部是区间，没有一项是精确值，也没有一项来自内容本身——
 * 聊天条数是问 IndexedDB 要的 count()，存储占用是浏览器给的字节数。
 */
export function trackDataScaleOnce(params: {
  characterCount: number;
  memoryCount: number;
  maxMemoryCount: number;
  maxMessageCount: number;
  storageBytes: number | null;
  storageQuotaBytes: number | null;
  persistedStorage: boolean | null;
  standalone: boolean;
}): void {
  if (!shouldReportSnapshot('data-scale')) return;
  if (reportedScales.has('data-scale')) return;
  reportedScales.add('data-scale');
  trackEvent('数据规模', {
    角色数: bucketCharacterCount(params.characterCount),
    记忆条数: bucketMemoryCount(params.memoryCount),
    单角色最大记忆条数: bucketMemoryCount(params.maxMemoryCount),
    单角色最大聊天条数: bucketMessageCount(params.maxMessageCount),
    // 浏览器不给配额信息时（Safari 部分版本、隐私模式）这一项直接缺席，不猜、不填 0。
    ...(params.storageBytes === null ? {} : { 本地存储占用: bucketStorageBytes(params.storageBytes) }),
    // 占了配额的百分之多少。配额读不到、或者浏览器回了个 0（隐私模式下有这种），
    // 这一项就缺席：拿 0 去除会算出 Infinity，直接变成一条假的「80%+」。
    ...(params.storageBytes === null || !params.storageQuotaBytes
      ? {}
      : { 存储水位: bucketStorageWatermark(params.storageBytes, params.storageQuotaBytes) }),
    // 有没有拿到「系统别清我」的许可。跟上面的占用放同一条，才能看出
    // 「数据大且没许可」这批高危用户有多少；查不了的浏览器同样缺席，不猜。
    ...(params.persistedStorage === null ? {} : { 持久化许可: params.persistedStorage ? '已获得' : '未获得' }),
    全屏运行: params.standalone ? '是' : '否',
  });
}

/**
 * 上报「当前在用的是哪套外观」，每次会话最多一次。
 *
 * 这个跟「应用了某个预设」是两回事，别拿后者代替它：
 * 「应用」是流量，只在有人点那一下才响；半年前设好之后再没动过的人永远不出现。
 * 拿流量表决定砍哪个预设会砍反——表里全是爱折腾的人，最稳定的长期用户隐形。
 * 这个事件是存量：每次会话为「我现在用的这套」投一票，那张表才是「多少人在用哪个」。
 *
 * 所有取值都必须是内置预设的 id。用户自己捏的一律传 'custom'，绝不能传他起的名字。
 */
export function trackCurrentAppearanceOnce(params: Record<string, string>): void {
  if (!shouldReportSnapshot('appearance')) return;
  if (reportedScales.has('appearance')) return;
  reportedScales.add('appearance');
  trackEvent('当前外观', params);
}

/**
 * 把一个可能被用户自定义的值收敛成可上报的枚举。
 * 命中内置清单就报那个 key，否则一律报 'custom' —— 用户填的 URL、上传的文件、
 * 自己起的名字都归到这一个值里，原文一个字都不出去。
 */
export function presetOrCustom(
  value: string | undefined | null,
  builtinKeys: readonly string[],
  fallback = 'default'
): string {
  if (!value) return fallback;
  return builtinKeys.includes(value) ? value : 'custom';
}

/** 开放数值的微调项，只报「调过没调过」，不报具体数值。 */
export function tweakedOrDefault(value: number | undefined | null): string {
  return value ? '调过' : '默认';
}

/**
 * 逐角色的布尔开关，汇总成一句话。
 *
 * 按默认值分开问，否则问错方向就等于没信息：默认关的功能问「有没有人开过」，
 * 默认开的功能问「有没有人特意关掉」——后者要是也问「有没有人开着」，
 * 答案永远是「有」。
 */
export function anyCharToggle(values: Array<boolean | undefined>, defaultOn: boolean): string {
  if (defaultOn) {
    return values.some((v) => v === false) ? '有人关掉' : '都开着';
  }
  return values.some((v) => v === true) ? '有人开' : '都没开';
}

/** 每次会话最多一次，报当前活跃角色的选择 + 全部角色的开关汇总。 */
export function trackCurrentCharSettingsOnce(params: Record<string, string>): void {
  if (!shouldReportSnapshot('char-settings')) return;
  if (reportedScales.has('char-settings')) return;
  reportedScales.add('char-settings');
  trackEvent('当前角色设置', params);
}

/**
 * 上报「现在开着哪些功能」，每次会话最多一次。
 *
 * 跟「当前外观」同样是存量事件，理由也一样：外部服务这类配置配一次就长期生效，
 * 只看「打开过配置页」这种流量点的话，半年前配好再没动过的人永远不出现，
 * 拿来判断「这功能有没有人要」会判反。
 *
 * 取值全部由 utils/analyticsFeatures.ts 收敛成枚举和档位——地址、密钥、token、
 * 账号名、服务器名一个字都不进这里。
 */
export function trackCurrentFeaturesOnce(params: Record<string, string>): void {
  if (!shouldReportSnapshot('features')) return;
  if (reportedScales.has('features')) return;
  reportedScales.add('features');
  trackEvent('当前功能启用', params);
}

/** SAR / 私聊输入 / 周年赠礼，与其他快照互斥，每会话最多一次。 */
export function trackCurrentSARFeaturesOnce(params: Record<string, string>): void {
  if (!shouldReportSnapshot('sar')) return;
  if (reportedScales.has('sar')) return;
  reportedScales.add('sar');
  trackEvent('当前SAR与聊天输入', params);
}

// ===== 本次会话聊了多少 =====
//
// 刻意不做成「每发一条打一个点」。那样服务端会攒出一份带时间戳的发送流水，
// 哪怕一个字的内容都没有，「谁在几点连着发了多少条」照样还原得出来——
// 对一个陪伴类 App 来说这是很私密的行为数据，也超出了对外说的口径。
//
// 这里只在页面切到后台时报一次**区间**，而且档位没变就不再报。
// 一次会话最多 5 条（跨过几个档位就报几次），看得出「大家一次坐下来聊多久」，
// 换不出任何时间线。一条没发过的会话不会安装监听器，也就一个点都不产生。

let sessionMessageCount = 0;
let lastReportedSessionBucket: string | null = null;
let sessionReporterInstalled = false;

/** 单次会话发送条数档位。 */
export function bucketSessionMessages(count: number): string {
  if (count <= 0) return '0';
  if (count <= 10) return '1-10';
  if (count <= 50) return '11-50';
  if (count <= 200) return '51-200';
  return '200+';
}

function reportSessionMessages(): void {
  const bucket = bucketSessionMessages(sessionMessageCount);
  // 档位没变就不重复报——切来切去也只会产生跨档那几次。
  if (bucket === lastReportedSessionBucket) return;
  lastReportedSessionBucket = bucket;
  trackEvent('私聊会话发送条数', { 条数: bucket });
}

/**
 * 记一次「用户发了条消息」。**只加内存里的计数，不发任何请求**——
 * 真正上报发生在页面切走时，且只发区间。
 */
export function noteMessageSent(): void {
  sessionMessageCount += 1;
  if (sessionReporterInstalled) return;
  if (typeof document === 'undefined') return;
  sessionReporterInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') reportSessionMessages();
  });
}

