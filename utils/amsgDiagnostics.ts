// 主动消息 2.0 的「体检」判定：把 worker 的 GET /debug 回执翻成一排能直接看的结论，
// 以及把 fetch 抛出来的异常翻成一句知道该去改哪儿的话。
//
// 单独成叶子的原因有两个：
//   1. 这两件事都是纯函数（输入回执 / 异常，输出结论），能脱开浏览器单测，而它们要
//      守的恰恰是「坏了但界面看不出来」这一类问题——没有测试钉住，退化了没人会发现。
//   2. activeMsgClient 要用它，设置面板也要用它，放在任何一边都会让另一边反向依赖。
//
// worker 那侧的对应实现见 worker/amsg/src/index.ts 的 inspectWorkerEnv / inspectStorage /
// judgeTick，改动那三处的输出形状时这份要跟着走。「定时任务」那一行另外读 GET /tick-report
// 的逐条细账，形状和判定在 utils/amsgTickReport.ts。

import type {
  AmsgTickFailureRecord,
  AmsgTickReport,
  AmsgTickReportFailure,
  AmsgTickReportTask,
} from './amsgTickReport';
import { CLOUD_CLEANUP_STAGE } from './amsgTickReport';
import { describeTaskFailureCause } from './amsg2Tasks';
import { describeD1LimitCode } from './amsgD1Limits';

// ─── 失败归类（给使用统计分档用）───
//
// 「连接失败」在图上只有一格的话，地址填错、密钥对不上、D1 没绑、纯断网会长成一个样，
// 而这四种要修的引导完全不同。所以在**抛错的那一刻**按源码里写死的谓词挂一个代号，
// 上报只带这个代号。
//
// 报错原文（可能带 Worker 地址、push endpoint）一个字都不进上报——挂在这里的
// 永远是下面这个联合类型里的字面量之一，不是从异常对象上读出来的任何东西。
// 见 docs/analytics.md 「加新埋点的规矩」第 4 条。
export type AmsgFailKind =
  | '地址没填'
  | '打到网页了'
  | '鉴权失败'
  | '端点不存在'
  | '建表失败'
  | '配置缺失'
  | '网络失败'
  | '权限被拒'
  | '不支持推送'
  | 'worker没配VAPID'
  | '订阅失败'
  | '推送通道不通'
  | '没拿到订阅'
  | '端点僵尸'
  | '其他';

/** 从 Worker 地址里取一个能给人看的域名。取不到（没填 / 填了段不是 URL 的东西）返回空串。 */
export const readWorkerHost = (workerUrl: string | null | undefined): string => {
  const value = workerUrl?.trim();
  if (!value) return '';
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
};

const looksLikeHtmlFallbackError = (message: string) => (
  /HTML/i.test(message) ||
  message.includes(`Unexpected token '<'`) ||
  /<!doctype/i.test(message) ||
  /<html/i.test(message)
);

/**
 * 浏览器把「连不上」报成什么，各家不一样：Chrome/Firefox 是 TypeError: Failed to fetch，
 * Safari 是 TypeError: Load failed，旧 Firefox 还有 NetworkError when attempting to fetch。
 * 三种都得认，漏一种就有一批人只能看到光秃秃的英文。
 */
const looksLikeOfflineError = (message: string, name: string) => (
  name === 'TypeError' ||
  /failed to fetch/i.test(message) ||
  /load failed/i.test(message) ||
  /networkerror/i.test(message)
);

const looksLikeTimeoutError = (message: string, name: string) => (
  name === 'AbortError' ||
  name === 'TimeoutError' ||
  /timed? ?out/i.test(message) ||
  /aborted/i.test(message)
);

export interface AmsgFetchFailureDescription {
  /** 直接显示给用户的整句，含「这是哪一步、坏在哪、去改哪儿」。可能多行。 */
  message: string;
  /** 上报用的代号，永远是 AmsgFailKind 里的字面量。 */
  kind: AmsgFailKind;
}

/**
 * 把 fetch 抛出来的异常翻成人话。
 *
 * 存在的理由：这类异常的原文只有 "Failed to fetch" 五个字，既不说打的是哪儿，也不说
 * 是网络不通还是地址错了。社区里排查这一句花掉过好几天——先怀疑代理平台封号、再怀疑
 * worker 配置、最后才发现只是当时没连上 Cloudflare。所以在这儿一次把三件事说全：
 * 是哪一步、连的是哪个域名、可能的原因分别去哪儿改。
 *
 * 另外必须写明「这条路不通不影响到点推送」：推送是 Cloudflare 直接发给设备的，
 * 跟浏览器能不能连上 worker 是两条路。不写的话用户会以为主动消息整个废了。
 */
export const describeAmsgFetchFailure = (
  error: unknown,
  phase: string,
  workerUrl?: string | null,
): AmsgFetchFailureDescription => {
  const raw = error instanceof Error ? error.message : String(error || 'Unknown error');
  const name = error instanceof Error ? error.name : '';
  const host = readWorkerHost(workerUrl);
  const where = host ? `（${host}）` : '';

  if (looksLikeHtmlFallbackError(raw)) {
    return {
      kind: '打到网页了',
      message: `主动消息 2.0 的${phase}请求没有打到 Worker${where}，而是拿到了一个网页。请确认设置里填的是你部署好的 amsg Worker 地址，不是某个网页地址。`,
    };
  }

  if (looksLikeTimeoutError(raw, name)) {
    return {
      kind: '网络失败',
      message: `主动消息 2.0 的${phase}请求等太久，超时了${where}。多半是当前网络到 Cloudflare 很慢或中途被掐断，稍后重试即可；一直这样的话，换个网络，或者照设置面板里 Worker 地址下面的「直连教程」配一下。\n到点的主动消息推送不走这条路，不受影响。`,
    };
  }

  if (looksLikeOfflineError(raw, name)) {
    return {
      kind: '网络失败',
      message: `连不上你的 Worker${where}，${phase}没能完成。\n这一步是这台设备直接去连 Cloudflare，常见原因有三个：当前网络到 Cloudflare 不通（换个网络，或者照设置面板里 Worker 地址下面的「直连教程」配一下）、Worker 地址填错了、Worker 已经被删掉了。\n到点的主动消息推送是 Cloudflare 直接发给设备的，不走这条路，所以照常收得到。`,
    };
  }

  return { kind: '其他', message: `主动消息 2.0 的${phase}请求失败：${raw}` };
};

// ─── /debug 回执 → 一排看得懂的结论 ───

/** worker 自检里「能跑但有一块是哑的」那类提醒。 */
export interface AmsgConfigWarning { code: string; message: string }

/**
 * 表结构自查没跑成时，worker 给出的归类代号（worker/amsg/src/index.ts 的
 * classifySchemaProbeError；改那边的档位这份要跟着走）。
 *
 * 分档全是为了「用户该做什么」：unsupported 点一下更新就好，denied 是后端自己的
 * 毛病、点什么都没用，timeout 再体检一次多半就过。
 */
export type AmsgSchemaProbeError = 'unsupported' | 'denied' | 'timeout' | 'other';

/** GET /debug 回执里用得上的那部分（worker/amsg/src/index.ts）。 */
export interface AmsgDebugReport {
  config: { ok: boolean; missing: string[]; message: string; warnings: AmsgConfigWarning[] };
  storage: {
    reachable: boolean;
    /** null = worker 查不了这一项（不等于「齐了」）。老 worker 只报 boolean。 */
    schemaReady?: boolean | null;
    /** 上面那项查不了时是为什么。缺字段 = 老 worker 不报这一项，只能笼统说一句。 */
    schemaError?: AmsgSchemaProbeError | null;
    missingTables?: string[];
    missingColumns?: string[];
    pushSubscriptionRegistered?: boolean;
    /**
     * 推送到底推没推出去。三态由 parseAmsgDebugReport 收敛，**认下来的回执里一定有值**
     * ——界面不用猜「缺字段」是什么意思。可选只是为了让「库根本读不到」那种桩不用凑
     * 一个没有意义的值；那种时候上面几行早就红了，压根走不到这一项。
     */
    pushDelivery?: AmsgPushDeliveryProbe;
    pendingTasks?: number;
    overdueTasks?: number;
    oldestOverdueMinutes?: number | null;
    error?: string;
  };
  /**
   * cron 在不在按时处理任务。unknown = 手上没有待发任务，无从判断。
   * stalled = 有任务真卡住了（没人来领，或者领了没下文）；failing = 没卡住，但有任务在
   * 失败重试、或者这次开跑晚得不正常；healthy = 都在正常处理。
   */
  tick: 'unknown' | 'idle' | 'healthy' | 'failing' | 'stalled';
  server: { version: string | null; featureCount: number } | null;
  vapidPublicKey: string | null;
}

/**
 * 认一份 /debug 回执，形状对不上返回 null。
 *
 * 宽容不了的地方在于：没有这个端点的 worker 回什么的都有（404 的 JSON、Cloudflare 的
 * 错误页、代理塞回来的一段 HTML）。只看 success 就采信的话，会把一台好 worker 判成
 * 「哪儿都是红的」——那比不体检还糟，用户照着提示改哪儿都改不对。
 */
export const parseAmsgDebugReport = (body: unknown): AmsgDebugReport | null => {
  const data = (body as { success?: unknown; data?: Record<string, any> } | null)?.data;
  if (!data || typeof data !== 'object') return null;
  const config = data.config;
  const storage = data.storage;
  if (typeof config?.ok !== 'boolean' || !Array.isArray(config.missing)) return null;
  if (typeof storage?.reachable !== 'boolean') return null;

  return {
    config: {
      ok: config.ok,
      missing: config.missing.filter((item: unknown): item is string => typeof item === 'string'),
      message: typeof config.message === 'string' ? config.message : '',
      warnings: Array.isArray(config.warnings)
        ? config.warnings.filter((item: any) => typeof item?.code === 'string' && typeof item?.message === 'string')
        : [],
    },
    storage: { ...storage, pushDelivery: normalizePushDeliveryProbe(storage.pushDelivery) },
    tick: ['idle', 'healthy', 'failing', 'stalled'].includes(data.tick) ? data.tick : 'unknown',
    server: data.server && typeof data.server === 'object'
      ? { version: data.server.version ?? null, featureCount: Number(data.server.featureCount) || 0 }
      : null,
    vapidPublicKey: typeof data.vapidPublicKey === 'string' ? data.vapidPublicKey : null,
  };
};

// ─── 推送服务说「这条订阅已经没了」───
//
// 这是「登记状态全绿、到点一条都不来」的最后一块拼图。浏览器手里有订阅、Worker 上
// 也登记着同一条 endpoint——两边都自洽，但那条 endpoint 在推送服务（FCM/Mozilla/
// Apple）那侧早就作废了，推过去只会换回一个 410。这件事只有推送服务知道，前端和
// Worker 自己都查不出来。
//
// 事实由上游 amsg-server 产生并结构化保存（投递失败时把推送服务回的状态码写进任务的
// last_error），Worker 的 /debug 把它读出来，这份文件只负责把它翻成红绿灯和人话。
// 状态码怎么认在 worker/amsg/src/index.ts，那儿离数据最近。

/** 认出来的那一次「订阅已失效」。 */
export interface AmsgPushGoneFailure {
  /** 推送服务回的状态码：410 = 已注销/过期，404 = 端点根本不存在。 */
  status: number;
  /** 这次失败记录的时刻（epoch 毫秒）。 */
  atMs: number;
}

/**
 * 「推送投递情况」这一项的三种结局。
 *
 * `probed: false` 的两档都**不是**「没问题」：`unsupported` 是这台 Worker 上跑的后端
 * 还不查这一项（老 bundle），`failed` 是查了没查成。界面必须照实说查不了——在唯一能
 * 拆穿「全绿但一条不来」的地方给假绿灯，比没有这项检查更糟。
 */
export type AmsgPushDeliveryProbe =
  | { probed: false; reason: 'unsupported' | 'failed' }
  | { probed: true; gone: AmsgPushGoneFailure | null; registeredAtMs: number | null };

/** 认出 /debug 回执里那一段的形状。缺字段 = 老 bundle 不报这一项。 */
const normalizePushDeliveryProbe = (raw: unknown): AmsgPushDeliveryProbe => {
  if (raw === undefined) return { probed: false, reason: 'unsupported' };
  // worker 查不成时显式回 null（老库还没有 last_error 列、查询被拒）。
  if (!raw || typeof raw !== 'object') return { probed: false, reason: 'failed' };
  const value = raw as { gone?: any; registeredAtMs?: unknown };
  const status = Number(value.gone?.status);
  const atMs = Number(value.gone?.atMs);
  return {
    probed: true,
    gone: Number.isFinite(status) && Number.isFinite(atMs) ? { status, atMs } : null,
    registeredAtMs: Number.isFinite(Number(value.registeredAtMs)) ? Number(value.registeredAtMs) : null,
  };
};

/** 一行体检结论的严重程度。bad = 现在就是坏的，warn = 能跑但有一块是哑的。 */
export type AmsgDiagnosticLevel = 'ok' | 'warn' | 'bad' | 'unknown';

/** 一行结论底下的一条细目（比如「定时任务」那一行里的每一条任务）。 */
export interface AmsgDiagnosticItem {
  /** 一句或一小段人话。 */
  text: string;
  /** 报错原文。界面上默认收着，点「原文」才展开——截图发给别人排查时用得上。 */
  raw?: string;
}

export interface AmsgDiagnosticRow {
  key: string;
  label: string;
  level: AmsgDiagnosticLevel;
  /** 一句话：坏在哪、去哪儿改。ok 的行写现状即可。 */
  detail: string;
  /** 逐条细目，按「先看哪条」排好。没有就不带这个字段。 */
  items?: AmsgDiagnosticItem[];
}

/** 拉体检的结果。连不上时带上已经翻成人话的原因，那本身就是第一行结论。 */
export type AmsgDiagnosticsProbe =
  | { reachable: true; report: AmsgDebugReport }
  | { reachable: false; reason: string; /** 旧 worker 没有这个端点，不是坏了 */ unsupported?: boolean };

/** 拉定时任务细账（GET /tick-report）的结果。拿不到时带一句已经翻成人话的原因。 */
export type AmsgTickReportResult =
  | { ok: true; report: AmsgTickReport }
  | { ok: false; reason: string };

export interface AmsgDiagnosticsInput {
  probe: AmsgDiagnosticsProbe;
  /** 这台设备的浏览器有没有推送订阅（本地事实，worker 那侧看不到）。 */
  localPushSubscribed?: boolean;
  /** 当前选择的推送模式：第三方推送不需要浏览器 VAPID。 */
  pushMode?: 'web-push' | 'third-party';
  /** 把 epoch 毫秒写成给人看的时间；不传按本机习惯格式化（单测注入固定格式用）。 */
  formatTime?: (atMs: number) => string;
  /** 定时任务的逐条细账。没拉（null / 不传）时「定时任务」那一行只按 /debug 的两个数说话。 */
  tickReport?: AmsgTickReportResult | null;
  /** 用户在面板上把后台任务暂停了。这时任务到点不发是意料之中，不能报成触发器坏了。 */
  cronPaused?: boolean;
  /**
   * 判定用的「现在」（epoch 毫秒，单测注入用）。不传时用细账回执里 Worker 的时钟，
   * 没有细账才用本机时钟：任务上的时刻全是 Worker 写的，拿设备时钟去减，设备钟一跑偏
   * 「晚了几分钟」就跟着歪。
   */
  nowMs?: number;
}

const defaultFormatTime = (atMs: number): string => new Date(atMs).toLocaleString();

/** 「重置订阅」在哪儿、点了会发生什么。几处文案共用一句，别各写各的。 */
export const PUSH_RESET_HINT = '去设置页的「推送订阅状态」点「重置订阅」重建一条——它会退订、重订、再覆盖登记回 Worker，点一次就够。';

const WORKER_TOO_OLD_HINT = '这台 Worker 上跑的后端还不查「推送有没有真的送出去」，所以「到点了但一条都不来」这种坏法它看不出来。点上面的「更新 Worker」换成新版就能查了。';

export interface AmsgPushDeliveryVerdict {
  level: 'bad' | 'warn';
  /** 发生了什么。几处共用，不带「去哪儿修」。 */
  what: string;
  /** 体检那一行的完整说法：发生了什么 + 该去哪儿点哪个按钮。 */
  detail: string;
}

/**
 * 上一次推送到底有没有被推送服务判成「订阅失效」，以及那笔账现在还算不算数。
 * 没问题（查过了、没发生过 / 是重置之前的旧账）返回 null。
 *
 * 体检的「这台设备」和设置页的推送订阅面板共用这一份判定：两处各写一套的话，
 * 用户会看到一个红一个绿，而这正是他唯一能拿来判断该不该重置订阅的依据。
 *
 * @param formatTime 把 epoch 毫秒写成给人看的时间；不传按本机习惯格式化。
 */
export const judgePushDeliveryFailure = (
  probe: AmsgPushDeliveryProbe | null | undefined,
  formatTime: (atMs: number) => string = defaultFormatTime,
): AmsgPushDeliveryVerdict | null => {
  if (!probe) return null;

  // 查不了不是「没问题」。报 warn 而不是红：这时并没有任何证据说明推送坏了，
  // 但也绝不能给绿灯——它恰恰是唯一能拆穿「全绿但一条不来」的那一项。
  if (!probe.probed) {
    const what = probe.reason === 'unsupported'
      ? '这次没查「推送有没有真的送出去」'
      : '「推送有没有真的送出去」这一项没查成（后端读不到任务的失败记录）';
    return {
      level: 'warn',
      what,
      detail: probe.reason === 'unsupported' ? WORKER_TOO_OLD_HINT : `${what}。到点却收不到消息的话，${PUSH_RESET_HINT}`,
    };
  }

  const { gone, registeredAtMs } = probe;
  if (!gone) return null;

  const when = formatTime(gone.atMs);
  const what = `${when} 那次推送被推送服务退回来了，理由是「这条订阅已经失效」（${gone.status}）`;

  // 登记时刻问不到就没法分辨新旧账。报 warn 不报红：重置过订阅的人不该被一条
  // 永远消不掉的红灯追着跑，但也不能给绿灯——那正是这条要拆穿的假象。
  if (registeredAtMs == null) {
    const uncertain = '这次问不到 Worker 上那行订阅是什么时候登记的，没法确认它是不是重置之前的旧账';
    return {
      level: 'warn',
      what: `${what}。${uncertain}`,
      detail: `${what}。${uncertain}；最近没重置过的话，${PUSH_RESET_HINT}`,
    };
  }

  // 那之后订阅换过一条了：这笔是上一条订阅的旧账，服务端只在失败时写、成功不会清。
  if (gone.atMs <= registeredAtMs) return null;

  const stillBroken = `${what}，而 Worker 上登记的还是它——到点的消息全都推不出去`;
  return { level: 'bad', what: stillBroken, detail: `${stillBroken}。${PUSH_RESET_HINT}` };
};

const DB_MISSING_HINT = 'Worker 没有绑定 D1 数据库。多半是部署第一步填完 Database ID 之后没点那个「Add」就直接 Deploy 了。回 Cloudflare 的 Settings → Bindings 加一条 D1 database，变量名填大写的 DB。';
const MASTER_KEY_MISSING_HINT = 'Worker 上没有 AMSG_MASTER_KEY。去 Settings → Variables and secrets 添加，类型一定要选 Secret——选成 Text 的话下次部署就会消失。';
const SCHEMA_STALE_HINT = '换过 Worker 版本后，已经存在的表不会自己长出新列，定时任务每分钟都会因为读不到它们而挂掉（界面上一切正常，就是一条都不发）。点上面的「重新连接并验证」补一次。';

/**
 * 表结构没查成时，各档分别该跟用户说什么。
 *
 * 每一句都要落到「要不要紧 + 该做什么」上。以前这里只有一句「查不了，不知道」——
 * 原因躺在 Cloudflare 日志里，用户看不到，隔着屏幕也问不出来，只能一路猜。
 */
const SCHEMA_PROBE_HINTS: Record<AmsgSchemaProbeError, string> = {
  denied: '查表结构时被数据库挡了一道：Cloudflare 在库里放了一张自己的内部表，不让 Worker 读，自查就断在那儿了。表齐没齐这次没查出来，但主动消息的收发不受影响。等后端更新到修好这处的版本就会自己恢复。',
  unsupported: '这台 Worker 上跑的后端代码还没有「查自己表结构」这个本事，齐没齐问不出来。点上面的「更新 Worker」换成新版就能查了。',
  timeout: '查表结构时数据库没在时限内回话，这次没查出来。多半是 D1 刚被唤醒（隔几小时的头一次请求常这样），过一会儿再体检一次通常就好了。',
  other: '这台 Worker 查不了自己的表结构，齐没齐不知道。要是主动消息到点不响，先点一次上面的「重新连接并验证」把表补齐。',
};

// ─── 「定时任务」那一行：/debug 的两个数 + /tick-report 的逐条细账 ───
//
// 光靠 /debug 只知道「几条到点没发、最老的晚了多久」，只够说一句笼统的「定时触发器
// 可能没在跑」。可同样是晚了四十分钟，可能是在等第三次重试（原因明明白白
// 记在任务上）、可能是一开跑就被 Cloudflare 掐掉、也可能是用户自己把后台任务暂停了——
// 照那一句去 Cloudflare 翻触发器，三种里有两种翻不出任何东西。
// 所以这一行先给一句总的结论，再逐条说每条任务现在算哪种情况，报错原文收在底下。

const MINUTE_MS = 60_000;

/** 失败记录在这个时间以内算「刚出的事」，够把这一行提成 warn。 */
const RECENT_FAILURE_MS = 60 * MINUTE_MS;

/**
 * 再早的失败记录一律不提。Worker 那边本来也只留一天，列太老的账只会让人以为现在还坏着；
 * 一小时到一天之间的，只在这一行本来就不正常时陪着列出来，帮着看是不是同一个毛病。
 */
const FAILURE_LOOKBACK_MS = 24 * 60 * MINUTE_MS;

/** 没有细账可看时的那句笼统说法。两种坏法都点到，让人至少知道去哪儿看日志。 */
const TICK_STALLED_GENERIC_HINT = '定时触发器可能没在跑，或者每分钟那一跳在报错——去 Cloudflare 的 Workers → 你的 Worker → Observability 看日志。';

/** 任务一直没人来领、Worker 又什么报错都没留下时，最可能的原因和该去哪儿看。 */
const TICK_TRIGGER_MISSING_HINT = '多半是定时触发器没在跑：去 Cloudflare 的 Workers → 你的 Worker → Settings → Trigger events 看看有没有 * * * * *，再到 Observability 看日志。';

const parseIsoMs = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** 两个时刻隔了几整分钟。时钟有点偏时可能算出负数，一律按 0 算。 */
const minutesBetween = (fromMs: number, toMs: number): number =>
  Math.max(0, Math.floor((toMs - fromMs) / MINUTE_MS));

/** 补上句号；原话自己已经带了句末标点的（英文报错常见）不再叠一个。 */
const endSentence = (text: string): string => {
  const trimmed = text.trim();
  return /[。！？.!?…]$/.test(trimmed) ? trimmed : `${trimmed}。`;
};

/**
 * 这条任务在列表里怎么称呼。
 *
 * 解不开任务内容时（主密钥换过之类）连名字都拿不到，也得有个主语，不然一句话开头就是冒号。
 * 名字是英文的话跟后面的中文之间空一格，中文名直接连着写。
 */
const describeTaskOwner = (task: { contactName: string | null; kind: string | null; messageType: string | null }): string => {
  const name = task.contactName || '某个角色';
  const gap = /[\x21-\x7e]$/.test(name) ? ' ' : '';
  if (task.kind) return `${name}${gap}的后台任务`;
  if (task.messageType === 'instant') return `${name}${gap}的即时回复`;
  return name;
};

interface TickTaskContext {
  nowMs: number;
  formatIso: (iso: string) => string;
  /** 每分钟那一跳自己此刻正在报错。卡住的任务就不必再猜触发器了，原因在那条报错里。 */
  tickFailureOngoing: boolean;
  cronPaused: boolean;
}

/** 一条到点还没发出去的任务，现在是什么情况。判定是 Worker 做的，这里只负责说成人话。 */
const describeTickTask = (task: AmsgTickReportTask, ctx: TickTaskContext): AmsgDiagnosticItem => {
  const { nowMs, formatIso } = ctx;
  const owner = describeTaskOwner(task);
  const nextSendMs = parseIsoMs(task.nextSendAt);
  const lateMinutes = nextSendMs === null ? null : minutesBetween(nextSendMs, nowMs);
  const parts: string[] = [
    lateMinutes === null
      ? `${owner}：${task.nextSendAt} 该发。`
      : `${owner}：${formatIso(task.nextSendAt)} 该发，${lateMinutes < 1 ? '刚到点' : `已经晚了 ${lateMinutes} 分钟`}。`,
  ];

  const lastErrorLine = task.lastError
    ? `上一次失败：${endSentence(describeTaskFailureCause(task.lastError))}`
    : '';
  const startedMs = parseIsoMs(task.lastStartedAt);

  if (task.state === 'retry-wait') {
    const failed = task.retryCount > 0 ? `已经失败 ${task.retryCount} 次` : '失败过';
    const retryAt = task.retryAfter ? `${formatIso(task.retryAfter)} 再试` : '等一会儿再试';
    parts.push(`${failed}，${retryAt}。`, lastErrorLine);
  } else if (task.state === 'sending') {
    if (task.lateStart && startedMs !== null) {
      // 「可以开跑」取到点时刻和重试时刻里更晚的那个：重试期间到点时刻是不往后推的。
      const readySinceMs = Math.max(nextSendMs ?? -Infinity, parseIsoMs(task.retryAfter) ?? -Infinity);
      const gap = Number.isFinite(readySinceMs) ? `到点 ${minutesBetween(readySinceMs, startedMs)} 分钟后` : '到点好一阵之后';
      parts.push(`正在发，但这次是${gap}才开始的，前面那段时间没留下任何记录：可能之前开跑过、半路被 Cloudflare 掐掉了，也可能那几分钟定时触发器没在跑。`);
    } else {
      const agoMinutes = startedMs === null ? null : minutesBetween(startedMs, nowMs);
      parts.push(agoMinutes === null ? '正在发。' : agoMinutes < 1 ? '正在发（刚开始）。' : `正在发（${agoMinutes} 分钟前开始的）。`);
    }
    parts.push(lastErrorLine);
  } else if (task.unfinishedAttempt) {
    const when = task.lastStartedAt ? `${formatIso(task.lastStartedAt)} ` : '';
    parts.push(`${when}开始发过，但没发完，也没留下失败原因。多半是跑到一半被 Cloudflare 掐掉了（比如 CPU 时间或运行时长超限），原话只在 Cloudflare 的 Workers → 你的 Worker → Observability 日志里。`);
    // 行上的失败记录早于这次开跑，说的是再往前那一次。
    if (task.lastError) parts.push(`再往前那次失败：${endSentence(describeTaskFailureCause(task.lastError))}`);
  } else if (task.queuedBehind) {
    parts.push('同一个角色的另一条任务正在发，这条在排队。', lastErrorLine);
  } else if (task.stuck) {
    parts.push(lastErrorLine ? `${lastErrorLine}之后到了重试时间，也一直没开始发。` : '到点后一直没开始发。');
    parts.push(ctx.cronPaused
      ? '后台任务暂停着，恢复后会一起补发。'
      : ctx.tickFailureOngoing
        ? '原因见下面那条整轮报错。'
        : `Worker ${lastErrorLine ? '那之后' : ''}没留下任何报错，${TICK_TRIGGER_MISSING_HINT}`);
  } else {
    parts.push(lastErrorLine ? `${lastErrorLine}马上会再试一次。` : '马上就会发。');
  }

  const raw = task.lastError && task.lastError.reason !== 'stale' ? task.lastError.reason : undefined;
  return { text: parts.filter(Boolean).join(''), ...(raw ? { raw } : {}) };
};

/** 整轮报错挂在哪一步。键是 Worker 记下的阶段代号（见 amsgTickReport 的 AmsgTickFailureRecord.stage）。 */
const TICK_STAGE_TEXT: Record<string, string> = {
  config: '读配置那一步',
  tick: '整轮处理任务那一步',
  [CLOUD_CLEANUP_STAGE]: '清理云端数据那一步',
  claim_failed: '给任务占位写库那一步',
  retry_update_failed: '记失败原因写库那一步',
  stale_update_failed: '处理过期任务写库那一步',
};

const describeTickStage = (stage: string): string => {
  // 发完之后的收尾有好几种（删行、推进排期……），代号都是这个前缀加后缀。
  if (stage.startsWith('post_send_cleanup_failed')) return '发完之后写库那一步';
  return TICK_STAGE_TEXT[stage] || `「${stage}」那一步`;
};

/** 认得出来的整轮报错，顺带说一句该怎么办。认不出来的只给原文，不瞎猜。 */
const describeTickFailureRemedy = (failure: AmsgTickFailureRecord): string => {
  const limitText = describeD1LimitCode(failure.code);
  if (limitText) return limitText;
  if (/no such (column|table)/i.test(failure.message)) {
    return '表结构跟现在的代码对不上，点上面的「重新连接并验证」补一次。';
  }
  if (failure.name === 'VapidNotConfigured') {
    return 'Worker 上没配推送凭据（VAPID），去 Settings → Variables and secrets 补上。';
  }
  if (/timed? ?out/i.test(`${failure.name} ${failure.message}`)) {
    return '数据库这一下没响应，偶尔一次没关系，一直这样再来看。';
  }
  return '';
};

const describeTickFailure = (failure: AmsgTickFailureRecord, formatIso: (iso: string) => string): AmsgDiagnosticItem => {
  const stage = describeTickStage(failure.stage);
  const head = failure.count > 1
    ? `Worker 每分钟那一跳${failure.ongoing ? '一直在' : '之前'}报错：${formatIso(failure.firstAt)} 到 ${formatIso(failure.lastAt)} 连着 ${failure.count} 次，卡在${stage}。`
    : `Worker 每分钟那一跳${failure.ongoing ? '刚刚' : '之前'}报了一次错（${formatIso(failure.lastAt)}），卡在${stage}。`;
  const delivery = failure.stage === CLOUD_CLEANUP_STAGE ? '消息照常投递，不受它影响。' : '';
  return {
    text: `${head}${delivery}${describeTickFailureRemedy(failure)}`,
    raw: `${failure.name}: ${failure.message}${failure.code ? ` (${failure.code})` : ''}`,
  };
};

/** 最近彻底没发出去的一次。 */
const describeRecentFailure = (failure: AmsgTickReportFailure, formatIso: (iso: string) => string): AmsgDiagnosticItem => {
  const owner = describeTaskOwner(failure);
  // 「哪一次」比「什么时候记的」更贴用户想知道的事，跟任务卡片那行同一个取法。
  const when = failure.error.occurrence || failure.error.at;
  const outcome = failure.outcome === 'skipped'
    ? '没发出去，这次跳过了，下次到点照常'
    : '没发出去，不会再补发了';
  const head = when ? `${owner}：${formatIso(when)} 那次${outcome}。` : `${owner}：最近有一次${outcome}。`;
  const raw = failure.error.reason !== 'stale' ? failure.error.reason : undefined;
  return {
    text: `${head}原因：${endSentence(describeTaskFailureCause(failure.error))}`,
    ...(raw ? { raw } : {}),
  };
};

/** 失败重试 / 开跑晚了的那几条，合起来一句话。 */
const summarizeFailingTasks = (tasks: AmsgTickReportTask[], truncatedNote: string): string => {
  const retrying = tasks.filter((task) => task.state === 'retry-wait' || task.lastError).length;
  const late = tasks.filter((task) => task.lateStart).length;
  const what = retrying && late
    ? `有 ${retrying} 条任务在失败重试，${late} 条这次开始发得比平时晚`
    : retrying
      ? `有 ${retrying} 条任务在失败重试`
      : late
        ? `有 ${late} 条任务这次开始发得比平时晚`
        : '有任务到点没按时发出去';
  return `${what}，逐条情况在下面${truncatedNote}。`;
};

/**
 * 「定时任务」这一行。
 *
 * 严重程度只看证据：真卡住了、或者每分钟那一跳此刻正在报错，才报红；在失败重试、
 * 刚报过错、最近一小时有没发出去的，报 warn；用户自己暂停了后台任务，任务攒着是
 * 意料之中，同样只报 warn，而且不许说成触发器坏了。
 */
const buildTickRow = (debugReport: AmsgDebugReport, input: AmsgDiagnosticsInput): AmsgDiagnosticRow => {
  const { storage, tick } = debugReport;
  const formatTime = input.formatTime || defaultFormatTime;
  const formatIso = (iso: string) => {
    const ms = parseIsoMs(iso);
    return ms === null ? iso : formatTime(ms);
  };
  const tickReport = input.tickReport?.ok ? input.tickReport.report : null;
  const reportFailedReason = input.tickReport && !input.tickReport.ok ? input.tickReport.reason : null;
  const nowMs = input.nowMs ?? parseIsoMs(tickReport?.now) ?? Date.now();

  const storageOverdue = storage.overdueTasks || 0;
  const stalledMinutes = storage.oldestOverdueMinutes ?? null;
  const listedTasks = tickReport?.tasks ?? [];
  // 有细账就按细账数，跟下面列出来的条数对得上；没列全时取两边大的那个。
  const overdue = listedTasks.length
    ? (tickReport?.truncated ? Math.max(storageOverdue, listedTasks.length) : listedTasks.length)
    : storageOverdue;
  const truncatedNote = tickReport?.truncated && listedTasks.length
    ? `（太多了，只列了前 ${listedTasks.length} 条）`
    : '';
  const cronPaused = Boolean(input.cronPaused);
  const pausedWithTasks = cronPaused && ((storage.pendingTasks ?? 0) > 0 || storageOverdue > 0 || listedTasks.length > 0);

  const tickFailure = tickReport?.tickFailure ?? null;
  const tickFailureAtMs = parseIsoMs(tickFailure?.lastAt);
  const tickFailureRecent = Boolean(
    tickFailure && !tickFailure.ongoing && tickFailureAtMs !== null && nowMs - tickFailureAtMs <= RECENT_FAILURE_MS,
  );
  // 清理云端数据那一段出错不拦投递：照样列出来，但不按「消息发不出去」定级。
  const cleanupFailing = Boolean(tickFailure?.ongoing && tickFailure.stage === CLOUD_CLEANUP_STAGE);
  const tickBlocked = Boolean(tickFailure?.ongoing) && !cleanupFailing;
  const tickFailureWithinDay = Boolean(
    tickFailure && (tickFailure.ongoing || tickFailureAtMs === null || nowMs - tickFailureAtMs <= FAILURE_LOOKBACK_MS),
  );

  // 时刻读不出来的失败记录还是列（Worker 那边已经只给最近一天的），只是不拿它提级。
  const dayFailures = (tickReport?.recentFailures ?? []).filter((failure) => {
    const atMs = parseIsoMs(failure.error.at) ?? parseIsoMs(failure.error.occurrence);
    return atMs === null || nowMs - atMs <= FAILURE_LOOKBACK_MS;
  });
  const hourFailures = new Set(dayFailures.filter((failure) => {
    const atMs = parseIsoMs(failure.error.at);
    return atMs !== null && nowMs - atMs <= RECENT_FAILURE_MS;
  }));

  const level: AmsgDiagnosticLevel = tickBlocked || (tick === 'stalled' && !cronPaused)
    ? 'bad'
    : pausedWithTasks || tick === 'stalled' || tick === 'failing' || cleanupFailing || tickFailureRecent || hourFailures.size > 0
      ? 'warn'
      : tick === 'unknown'
        ? 'unknown'
        : 'ok';

  const lateText = stalledMinutes === null ? '' : ` ${stalledMinutes} 分钟`;
  const detail = pausedWithTasks
    ? (storageOverdue || listedTasks.length
      ? `后台任务暂停中，有 ${overdue} 条到点的任务等恢复后一起补发。`
      : `后台任务暂停中，${storage.pendingTasks ?? 0} 条待发任务到点了也先攒着，恢复后一起补发。`)
    : tickBlocked
      ? (overdue
        ? `Worker 每分钟那一跳在报错，有 ${overdue} 条任务到点还没发出去。报错原话和逐条情况在下面。`
        : 'Worker 每分钟那一跳在报错，原话在下面。')
      : tick === 'stalled'
        ? (listedTasks.length
          ? `有 ${overdue} 条任务到点还没发出去，逐条情况在下面${truncatedNote}。`
          : `有 ${storageOverdue} 条任务到点${lateText}还没发出去。${TICK_STALLED_GENERIC_HINT}`)
        : tick === 'failing'
          ? (listedTasks.length
            ? summarizeFailingTasks(listedTasks, truncatedNote)
            : `有 ${storageOverdue} 条任务到点${lateText}还没发出去。Worker 在处理，但中间失败过，或者开始得比平时晚。`)
          : cleanupFailing
            ? 'Worker 清理云端数据那一步在报错，消息照常投递。原话在下面。'
            : tickFailureRecent
              ? 'Worker 每分钟那一跳前一阵报过错，现在没再报。'
              : hourFailures.size > 0
                ? `最近一小时有 ${hourFailures.size} 次到点没发出去，原因在下面。`
                : tick === 'healthy'
                  ? `${storage.pendingTasks ?? 0} 条待发任务，都在按时处理。`
                  : tick === 'idle'
                    ? '现在没有待发任务。'
                    : '手上没有待发任务，暂时看不出定时器在不在跑。';

  const items: AmsgDiagnosticItem[] = [];
  if (reportFailedReason && (level === 'bad' || level === 'warn')) {
    // 没拿到细账时上面那句只能说得笼统，至少让人知道为什么没有逐条的。
    items.push({ text: reportFailedReason });
  }
  if (tickReport) {
    const ctx: TickTaskContext = { nowMs, formatIso, tickFailureOngoing: tickBlocked, cronPaused };
    items.push(...listedTasks.map((task) => describeTickTask(task, ctx)));
    if (tickFailure && (tickFailure.ongoing || tickFailureRecent || (level !== 'ok' && tickFailureWithinDay))) {
      items.push(describeTickFailure(tickFailure, formatIso));
    }
    items.push(...dayFailures
      .filter((failure) => hourFailures.has(failure) || level !== 'ok')
      .map((failure) => describeRecentFailure(failure, formatIso)));
  }

  return {
    key: 'tick',
    label: '定时任务',
    level,
    detail,
    ...(items.length ? { items } : {}),
  };
};

/**
 * 把体检结果排成一列，顺序就是「该先修哪个」。
 *
 * 每一行只回答一个问题，且都是靠自己能改的：连不连得上 → 库绑没绑 → 密钥有没有 →
 * 表建没建全 → 推送凭据配没配 → 这台设备登记了没 → 定时任务在不在跑。
 * 前面的行是坏的时候，后面那些查不出结论的一律报 unknown，不假装绿。
 */
export const buildAmsgDiagnosticRows = (input: AmsgDiagnosticsInput): AmsgDiagnosticRow[] => {
  const { probe, localPushSubscribed } = input;

  if (!probe.reachable) {
    const unknownRest = (key: string, label: string): AmsgDiagnosticRow => ({
      key, label, level: 'unknown', detail: '连上 Worker 之后才能查。',
    });
    return [
      {
        key: 'reachable',
        label: 'Worker 可达',
        level: probe.unsupported ? 'warn' : 'bad',
        detail: probe.reason,
      },
      unknownRest('database', '数据库绑定'),
      unknownRest('masterKey', '主密钥'),
      unknownRest('schema', '数据表'),
      unknownRest('pushCredential', '推送凭据'),
      unknownRest('pushDevice', '这台设备'),
      unknownRest('tick', '定时任务'),
    ];
  }

  const { config, storage } = probe.report;
  const rows: AmsgDiagnosticRow[] = [];

  rows.push({
    key: 'reachable',
    label: 'Worker 可达',
    level: 'ok',
    detail: probe.report.server?.version ? `后端版本 ${probe.report.server.version}` : '连得上。',
  });

  const dbMissing = config.missing.includes('DB');
  rows.push({
    key: 'database',
    label: '数据库绑定',
    level: dbMissing ? 'bad' : 'ok',
    detail: dbMissing ? DB_MISSING_HINT : '已绑定 D1。',
  });

  const masterKeyMissing = config.missing.includes('AMSG_MASTER_KEY');
  const masterKeyFormat = config.warnings.find((item) => item.code === 'MASTER_KEY_FORMAT');
  rows.push({
    key: 'masterKey',
    label: '主密钥',
    level: masterKeyMissing ? 'bad' : masterKeyFormat ? 'warn' : 'ok',
    detail: masterKeyMissing ? MASTER_KEY_MISSING_HINT : masterKeyFormat?.message || '已配置。',
  });

  // 库都没绑的话，下面这些查出来必然是「什么都没有」，报红会把人往错的方向引。
  if (dbMissing || !storage.reachable) {
    rows.push({
      key: 'schema',
      label: '数据表',
      level: dbMissing ? 'unknown' : 'bad',
      detail: dbMissing
        ? '先把 D1 绑上再看这一项。'
        : `连得上 Worker，但读不了它的数据库${storage.error ? `（${storage.error}）` : ''}。`,
    });
  } else if (storage.schemaReady === null) {
    // Worker 连得上、库也读得到，但它比对不出表结构（比如那句查询本身被拒了）。
    // 这一档过去混在「正常」里——而这一项存在的全部意义就是查出表结构漂移，
    // 漂移时 cron 每分钟静默失败、界面处处正常，这里再给一个假绿灯就彻底没人能发现了。
    rows.push({
      key: 'schema',
      label: '数据表',
      level: 'unknown',
      detail: SCHEMA_PROBE_HINTS[storage.schemaError || 'other'],
    });
  } else {
    const missingTables = storage.missingTables || [];
    const missingColumns = storage.missingColumns || [];
    const schemaBad = missingTables.length > 0 || missingColumns.length > 0;
    // 明说了不够用（false）却一项都没点到名 = 自查本身没跑成，而主表确实不在：库还是空的。
    // 只数这两个数组的话，一个一张表都没建的空库会显示成全绿——一键部署完还没点连接时
    // 正好是这个组合（表没建 + 自查被内部表拒掉）。
    const emptyDatabase = storage.schemaReady === false && !schemaBad;
    rows.push({
      key: 'schema',
      label: '数据表',
      level: schemaBad || emptyDatabase ? 'bad' : 'ok',
      detail: emptyDatabase
        ? '库里还一张表都没有。点上面的「重新连接并验证」建一次。'
        : missingTables.length
          ? `缺表：${missingTables.join('、')}。点上面的「重新连接并验证」会自动建好（可能要点两次）。`
          : missingColumns.length
            ? `表结构是旧的，缺列：${missingColumns.join('、')}。${SCHEMA_STALE_HINT}`
            : '表和列都齐了。',
    });
  }

  const vapidWarning = config.warnings.find((item) => item.code === 'VAPID_MISSING');
  const isThirdPartyPush = input.pushMode === 'third-party';
  rows.push({
    key: 'pushCredential',
    label: '推送凭据',
    level: vapidWarning && !isThirdPartyPush ? 'bad' : 'ok',
    // 这是最难自己查出来的一种坏法：任务建得成、界面全绿，到点一条都推不出去。
    detail: isThirdPartyPush
      ? (vapidWarning ? '当前使用第三方推送 App，无需配置 VAPID 密钥。' : '使用第三方推送 App（VAPID 也已配置）。')
      : (vapidWarning ? vapidWarning.message : 'VAPID 已配齐。'),
  });

  const remoteRegistered = storage.pushSubscriptionRegistered === true;
  // 两边都登记着，也不等于推得出去：那条 endpoint 可能在推送服务那侧早就作废了。
  // 只有投递结果知道这件事，登记状态是绿的时候更要看它——「全绿但一条不来」就是
  // 这么来的。云端压根没登记时不看这个：那时该修的是上一层，说两件事只会分散注意力。
  const deliveryVerdict = remoteRegistered
    ? judgePushDeliveryFailure(storage.pushDelivery, input.formatTime)
    : null;
  rows.push({
    key: 'pushDevice',
    label: '这台设备',
    level: !localPushSubscribed ? 'bad' : !remoteRegistered ? 'bad' : deliveryVerdict?.level || 'ok',
    detail: isThirdPartyPush
      ? !localPushSubscribed
        ? '还没填写有效的第三方推送 Token，请在上方填写并点击「保存并登记推送」。'
        : !remoteRegistered
          ? '第三方推送 Token 已填写，但还没登记到 Worker——请点击「保存并登记推送」。'
          : deliveryVerdict?.detail
            || '第三方推送通道已登记到 Worker。可点击「发送测试通知」确认手机能否收到横幅。'
      : !localPushSubscribed
        ? '这台设备还没订阅推送，点下面的「开启通知与推送」。'
        : !remoteRegistered
          ? '浏览器订阅好了，但 Worker 上没有登记收件设备——到点的消息发不出去。点下面的「开启通知与推送」补登记一次。'
          : deliveryVerdict?.detail
            || '浏览器已订阅，Worker 上也登记了收件设备，最近一次推送也没被退回来。换设备或换浏览器之后要在新的那台上再点一次「开启通知与推送」。',
  });

  rows.push(buildTickRow(probe.report, input));

  return rows;
};

/** 一排结论里最严重的那一档，用来给面板定基调。 */
export const summarizeAmsgDiagnostics = (rows: AmsgDiagnosticRow[]): AmsgDiagnosticLevel => {
  if (rows.some((row) => row.level === 'bad')) return 'bad';
  if (rows.some((row) => row.level === 'warn')) return 'warn';
  if (rows.some((row) => row.level === 'unknown')) return 'unknown';
  return 'ok';
};

// ─── 即时对话：开不了的话卡在哪一道 ───

/**
 * 即时对话三道门里最先没过的那一道。
 *
 * 代号写死在这儿，设置页拿它选提示文案、使用统计拿它当属性——**两处共用同一个判定**。
 * 各算各的话，黄字说的和上报里的早晚各说各话，而这条路上的每一次分歧都只能靠用户
 * 自己来报（他看到的是「开关点不动」，我们看到的是「没人开」）。
 */
export type InstantChatBlocker = '没连上Worker' | '没开推送' | 'Worker太旧';

export interface InstantChatGateInput {
  /** 连接并验证成功过（全局配置的 initializedAt）。 */
  connected: boolean;
  /** 这台设备订阅了推送。 */
  pushSubscribed: boolean;
  /** 这台 Worker 认 `POST /instant-chat`（GET /config-check 的 instantChat 标志）。 */
  workerSupportsInstantChat: boolean;
}

/**
 * 按「先补哪个」的顺序返回第一道没过的门，三道全过返回 null。
 *
 * 顺序不是随便排的：没连上就谈不上推送，没推送权限就算发得出去也收不回来，
 * 最后才是 Worker 太旧、端点根本不存在。
 */
export const resolveInstantChatBlocker = (input: InstantChatGateInput): InstantChatBlocker | null => {
  if (!input.connected) return '没连上Worker';
  if (!input.pushSubscribed) return '没开推送';
  if (!input.workerSupportsInstantChat) return 'Worker太旧';
  return null;
};

/** 每道门对应的那句话（设置页开关下面的黄字）。 */
export const INSTANT_CHAT_BLOCKER_HINTS: Record<InstantChatBlocker, string> = {
  '没连上Worker': '先在上面把 Worker 连上。',
  '没开推送': '先开启通知与推送：回复是靠推送送回来的，没有权限就变成发得出、收不到。',
  'Worker太旧': 'Worker 上跑的代码还起不了这条路（缺起跳器，或者还是旧版）。点上面的「更新 Worker」，更新完这里会自己恢复。开着也不会走云端——那台 Worker 上是发一条挂一条，这段时间聊天先在本地生成。',
};
