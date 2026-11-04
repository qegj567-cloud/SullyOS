import {weatherForCharacter} from '../../../utils/characterWeather';
/**
 * 到点现拉「外面的世界」：今日节日 + 实时天气 + 热搜，填进 fire_pack 的
 * AMSG_SLOT_REALTIME_WORLD 槽位。
 *
 * 为什么不跟着模板一起烤进来：那一段抬头写着「以下信息来自真实世界」，措辞比任何
 * 免责声明都硬。照着打包那一刻的读数说话，就是大晴天叫人带伞、隔天还在祝节日快乐、
 * 同一批旧闻当成「最近真实发生」说上三遍。所以留槽位、到点现拉。
 *
 * 取数与成段渲染都用 utils/realtimeWorldCore（浏览器那边聊天时走的是同一份），
 * 这个文件只管两件事：把结果按时段 / 按城市缓存进 client_state，别每条主动消息都
 * 重拉一遍；以及给整个取数过程封顶——拉不到、拉超时都只是少这一段，消息照常发。
 */

import {
  checkSpecialDates,
  fetchHotNews,
  fetchWeatherWithFallback,
  getHotNewsSlot,
  pickRandomNews,
  renderRealtimeWorldBlock,
  resolveHotNewsPlatforms,
  sameHotNewsPlatforms,
  REALTIME_NEWS_PICK_COUNT,
  type NewsItem,
  type WeatherData,
} from '../../../utils/realtimeWorldCore';
import type { AmsgToolConfig } from '../../../utils/amsgToolPack';
import { getUserHolidayReminder } from '../../../utils/userHolidays';

/** 两份快照都放全局命名空间：天气按城市、热榜按时段，本来就是所有角色共用一份。 */
export const AMSG_WEATHER_SNAPSHOT_KEY = 'world_weather';
export const AMSG_HOTNEWS_SNAPSHOT_KEY = 'world_hotnews';

/** 天气快照的保鲜期，与前台默认的缓存时长一致。 */
const WEATHER_TTL_MS = 30 * 60 * 1000;

/**
 * 拉不到时旧读数还能顶多久 —— 天气 3 小时、热榜 24 小时，再旧就整段不要。
 *
 * 顶一会儿是划算的（半小时前的气温也比只字不提强），但这一段抬头写着「以下信息来自
 * 真实世界」：接口连挂三天就会顶着这块招牌播三天前的那场雨、聊三天前的同一批热搜。
 * 「拉不到就整段消失」本来就是这条链的红线，旧读数也得守着它。
 */
const WEATHER_FALLBACK_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const HOTNEWS_FALLBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 热榜按「国内现在几点」分时段。worker 跑在 UTC 上，不指定时区的话「今日上午」
 * 会跟榜单自己的作息差好几个时段。
 */
const HOTNEWS_SLOT_TZ = 'Asia/Shanghai';

/** 存进快照的热榜条数。每次触发只随机抽几条注入，留这些够换着说很多轮了。 */
const HOTNEWS_KEEP = 60;

/**
 * 整个取数的时间封顶。主动消息后面还要跑 LLM、可能还要跑几轮工具，
 * 不能让一个卡住的热榜站把这次触发拖到超时。
 */
const FETCH_BUDGET_MS = 10_000;

type StateRow = { key: string; value: string };
type WriteState = (
  namespace: string,
  entries: Array<{ key: string; value: string | null; updatedAt?: number }>,
) => Promise<unknown>;

interface WeatherSnapshot {
  city: string;
  data: WeatherData;
  fetchedAt: number;
}

interface HotNewsSnapshot {
  /** getHotNewsSlot 的时段 id，形如 2026-08-02#5。 */
  id: string;
  platforms: string[];
  items: NewsItem[];
  fetchedAt: number;
}

/** 快照读出来形状不对就当没有——重拉一次的代价远小于拿脏数据去说话。 */
const parseSnapshot = <T>(rows: StateRow[], key: string, ok: (v: any) => boolean): T | null => {
  const raw = rows.find((r) => r.key === key)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return ok(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
};

/**
 * 给一个取数任务封顶：到点还没回来就用兜底值继续。
 * 被丢下的那个 promise 单独接住，别变成 unhandled rejection 把 worker 吵醒。
 */
const withBudget = async <T>(job: Promise<T>, ms: number, fallback: T, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = job.catch((e) => {
    console.warn(`[amsg:world] ${label} 拉取失败`, e);
    return fallback;
  });
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[amsg:world] ${label} 超过 ${ms}ms 没回来，这次先不带这一段`);
      resolve(fallback);
    }, ms);
  });
  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** 天气：同城半小时内复用快照，过期或换城市才真去拉。 */
const loadWeather = async (
  cfg: AmsgToolConfig,
  nowMs: number,
  globalRows: StateRow[],
  pendingWrites: Array<{ key: string; value: string }>,
): Promise<WeatherData | null> => {
  const city = cfg.weatherCity?.trim();
  if (!city) return null;

  const snap = parseSnapshot<WeatherSnapshot>(globalRows, AMSG_WEATHER_SNAPSHOT_KEY,
    (v) => v && typeof v.city === 'string' && v.data && typeof v.fetchedAt === 'number');
  if (snap && snap.city === city && nowMs - snap.fetchedAt < WEATHER_TTL_MS) {
    console.log('[amsg:world] 天气命中快照', { city, ageMin: Math.round((nowMs - snap.fetchedAt) / 60000) });
    return snap.data;
  }

  const fresh = await fetchWeatherWithFallback(city, cfg.weatherApiKey);
  if (fresh) {
    pendingWrites.push({
      key: AMSG_WEATHER_SNAPSHOT_KEY,
      value: JSON.stringify({ city, data: fresh, fetchedAt: nowMs } satisfies WeatherSnapshot),
    });
    return fresh;
  }
  // 拉不到就用手上这份旧的：半小时前的气温也比「今天天气怎么样都不知道」强，
  // 而且不写快照，下次触发会再试一次。城市换过了、或者旧得过头了就宁可不说。
  if (snap && snap.city === city && nowMs - snap.fetchedAt <= WEATHER_FALLBACK_MAX_AGE_MS) {
    console.warn('[amsg:world] 天气拉取失败，先用上一次的读数', { city });
    return snap.data;
  }
  return null;
};

/** 热榜：同一时段 + 同一批平台复用快照，换时段才真去拉。 */
const loadHotNews = async (
  cfg: AmsgToolConfig,
  nowMs: number,
  globalRows: StateRow[],
  pendingWrites: Array<{ key: string; value: string }>,
): Promise<NewsItem[]> => {
  const platforms = resolveHotNewsPlatforms(cfg.newsPlatforms);
  const slot = getHotNewsSlot({ tz: HOTNEWS_SLOT_TZ, now: new Date(nowMs) });

  const snap = parseSnapshot<HotNewsSnapshot>(globalRows, AMSG_HOTNEWS_SNAPSHOT_KEY,
    (v) => v && typeof v.id === 'string' && Array.isArray(v.items) && Array.isArray(v.platforms)
      && typeof v.fetchedAt === 'number');
  if (snap && snap.id === slot.id && snap.items.length > 0 && sameHotNewsPlatforms(snap.platforms, platforms)) {
    console.log('[amsg:world] 热榜命中快照', { slot: slot.id, count: snap.items.length });
    return snap.items;
  }

  const fresh = await fetchHotNews(platforms, 12, HOTNEWS_KEEP);
  if (fresh.length > 0) {
    pendingWrites.push({
      key: AMSG_HOTNEWS_SNAPSHOT_KEY,
      value: JSON.stringify({ id: slot.id, platforms, items: fresh, fetchedAt: nowMs } satisfies HotNewsSnapshot),
    });
    return fresh;
  }
  // 一条都没拉到：用上个时段的顶一下，且不写快照，下次触发重试。
  // 隔天的旧闻不顶——那时候「最近发生的事」已经不是最近了。
  if (snap && snap.items.length > 0 && nowMs - snap.fetchedAt <= HOTNEWS_FALLBACK_MAX_AGE_MS) {
    console.warn('[amsg:world] 热榜拉取失败，先用上个时段的', { was: snap.id, want: slot.id });
    return snap.items;
  }
  return [];
};

/**
 * 组这次触发要注入的「真实世界感知」那一段。
 *
 * 返回空串 = 这次什么都没有（功能没开 / 全拉挂了），槽位被抹平，
 * 提示词读起来跟没有这回事一样，绝不半截。
 *
 * 注意这里不给「当前时间」那一行：时间由 fire_pack 自己的 AMSG_SLOT_CURRENT_TIME 填，
 * 两边都出就是一份提示词两个钟。
 */
type RealtimeWorldArgs = {
  charId?: string;
  userName?: string;
  toolConfig: AmsgToolConfig;
  /** 角色的时间感知开关（tool_pack 带上来的）：关掉就连今日节日一起不给。 */
  timeAwarenessEnabled: boolean;
  /** 角色的时区，判「今天几号」用。 */
  tzId: string;
  nowMs: number;
  /** onBeforeFire 已经读过的 amsg:global 行，直接复用，不再多查一次。 */
  globalRows: StateRow[];
  globalNamespace: string;
  writeState?: WriteState;
};

export const buildUserHolidayBlock = async (args: RealtimeWorldArgs): Promise<string> => {
  const { toolConfig: cfg, nowMs, globalRows } = args;
  if (!args.timeAwarenessEnabled || !cfg.userHolidays?.timeZone) return '';
  return getUserHolidayReminder(cfg.userHolidays, {
    async read(key) {
      try { return JSON.parse(globalRows.find(row => row.key === key)?.value || 'null'); } catch { return null; }
    },
    async write(key, data) { await args.writeState?.(args.globalNamespace, [{ key, value: JSON.stringify(data) }]); },
  }, nowMs, args.userName);
};

export const buildRealtimeWorldBlock = async (args: RealtimeWorldArgs): Promise<string> => {
  const { nowMs, globalRows } = args;
  const cfg = weatherForCharacter(args.toolConfig, args.charId);

  const specialDates = args.timeAwarenessEnabled ? checkSpecialDates(args.tzId, nowMs) : [];
  if (!cfg.weatherEnabled && !cfg.newsEnabled) {
    // 天气热搜都没开，只剩节日：有就单说一句，没有就整段不要。
    return renderRealtimeWorldBlock({ specialDates });
  }

  const pendingWrites: Array<{ key: string; value: string }> = [];
  const [weather, news] = await withBudget(
    Promise.all([
      cfg.weatherEnabled ? loadWeather(cfg, nowMs, globalRows, pendingWrites) : Promise.resolve(null),
      cfg.newsEnabled ? loadHotNews(cfg, nowMs, globalRows, pendingWrites) : Promise.resolve([] as NewsItem[]),
    ]),
    FETCH_BUDGET_MS,
    [null, [] as NewsItem[]] as [WeatherData | null, NewsItem[]],
    '实时世界',
  );

  // 快照写回是 best-effort：写不进去只是下次还得重拉，不能连累这次触发。
  if (pendingWrites.length > 0 && typeof args.writeState === 'function') {
    try {
      await args.writeState(args.globalNamespace, pendingWrites);
    } catch (e) {
      console.warn('[amsg:world] 快照写回失败（下次触发会重拉）', e);
    }
  }

  const block = renderRealtimeWorldBlock({
    specialDates,
    weather,
    news: pickRandomNews(news, REALTIME_NEWS_PICK_COUNT),
  });
  console.log('[amsg:world] 本次注入', {
    节日: specialDates.length,
    天气: weather ? weather.city : '无',
    热点池: news.length,
    整段字数: block.length,
  });
  return block;
};
