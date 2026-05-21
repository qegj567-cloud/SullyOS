/**
 * 实时上下文管理器 - 让AI角色感知真实世界
 * Real-time Context Manager - Give AI characters awareness of the real world
 */

import { safeResponseJson } from './safeApi';
import { DB } from './db';

export interface WeatherData {
    temp: number;
    feelsLike: number;
    humidity: number;
    description: string;
    icon: string;
    city: string;
}

export interface NewsItem {
    title: string;
    source?: string;
    url?: string;
    desc?: string;
}

export interface SearchResult {
    title: string;
    description: string;
    url: string;
}

export interface RealtimeConfig {
    // 天气配置
    weatherEnabled: boolean;
    weatherApiKey: string;  // OpenWeatherMap API Key
    weatherCity: string;    // 城市名 (如 "Beijing" 或 "Shanghai")

    // 新闻配置
    newsEnabled: boolean;
    newsApiKey?: string;    // 可选，Brave Search 回落源用
    newsPlatforms?: string[]; // hot_news 热榜平台 key（默认主源，免鉴权），留空用内置默认

    // Notion 配置
    notionEnabled: boolean;
    notionApiKey: string;   // Notion Integration Token
    notionDatabaseId: string; // 日记数据库ID
    notionNotesDatabaseId?: string; // 用户笔记数据库ID（可选）

    // 飞书配置
    feishuEnabled?: boolean;
    feishuAppId?: string;
    feishuAppSecret?: string;
    feishuBaseId?: string;
    feishuTableId?: string;

    // 小红书配置 (xiaohongshu-skills)
    xhsEnabled?: boolean;
    xhsMcpConfig?: {
        enabled: boolean;
        serverUrl: string;
        loggedInNickname?: string;
        loggedInUserId?: string;
        userXsecToken?: string; // 从 feed 列表自动获取，用于 getUserProfile 等
    };

    // 缓存配置
    cacheMinutes: number;   // 缓存时长（分钟）
}

// 默认配置
export const defaultRealtimeConfig: RealtimeConfig = {
    weatherEnabled: false,
    weatherApiKey: '',
    weatherCity: 'Beijing',
    newsEnabled: false,
    newsApiKey: '',
    newsPlatforms: ['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin'],
    notionEnabled: false,
    notionApiKey: '',
    notionDatabaseId: '',
    xhsEnabled: false,
    xhsMcpConfig: { enabled: false, serverUrl: 'http://localhost:18060/mcp', loggedInNickname: undefined, loggedInUserId: undefined, userXsecToken: undefined },
    cacheMinutes: 30
};

// 缓存
let weatherCache: { data: WeatherData | null; timestamp: number } = { data: null, timestamp: 0 };
let newsCache: { data: NewsItem[]; timestamp: number } = { data: [], timestamp: 0 };

// 特殊日期表
const SPECIAL_DATES: Record<string, string> = {
    '01-01': '元旦',
    '02-14': '情人节',
    '03-08': '妇女节',
    '03-12': '植树节',
    '03-14': '白色情人节',
    '04-01': '愚人节',
    '05-01': '劳动节',
    '05-04': '青年节',
    '06-01': '儿童节',
    '09-10': '教师节',
    '10-01': '国庆节',
    '10-31': '万圣节',
    '11-11': '光棍节',
    '12-24': '平安夜',
    '12-25': '圣诞节'
};

export const RealtimeContextManager = {

    /**
     * 获取天气信息
     */
    fetchWeather: async (config: RealtimeConfig): Promise<WeatherData | null> => {
        if (!config.weatherEnabled || !config.weatherApiKey) {
            return null;
        }

        const now = Date.now();
        const cacheMs = config.cacheMinutes * 60 * 1000;

        // 检查缓存
        if (weatherCache.data && (now - weatherCache.timestamp) < cacheMs) {
            return weatherCache.data;
        }

        try {
            const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(config.weatherCity)}&appid=${config.weatherApiKey}&units=metric&lang=zh_cn`;

            const response = await fetch(url);
            if (!response.ok) {
                console.error('Weather API error:', response.status);
                return null;
            }

            const data = await safeResponseJson(response);

            const weather: WeatherData = {
                temp: Math.round(data.main.temp),
                feelsLike: Math.round(data.main.feels_like),
                humidity: data.main.humidity,
                description: data.weather[0]?.description || '未知',
                icon: data.weather[0]?.icon || '01d',
                city: data.name
            };

            // 更新缓存
            weatherCache = { data: weather, timestamp: now };

            return weather;
        } catch (e) {
            console.error('Failed to fetch weather:', e);
            return null;
        }
    },

    // hot_news（orz.ai）平台 key → 中文展示名。用于 source 标注，让提示词读起来自然。
    HOTNEWS_PLATFORM_LABELS: {
        baidu: '百度', sspai: '少数派', weibo: '微博', zhihu: '知乎', tskr: '36氪',
        ftpojie: '吾爱破解', bilibili: 'B站', douban: '豆瓣', hupu: '虎扑', tieba: '贴吧',
        juejin: '掘金', douyin: '抖音', vtex: 'V2EX', jinritoutiao: '今日头条',
        stackoverflow: 'Stack Overflow', github: 'GitHub', hackernews: 'Hacker News',
        sina_finance: '新浪财经', eastmoney: '东方财富', xueqiu: '雪球', cls: '财联社',
        tenxunwang: '腾讯网',
    } as Record<string, string>,

    DEFAULT_HOTNEWS_PLATFORMS: ['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin'],

    /**
     * 使用 hot_news（orz.ai）获取中文多平台热榜。
     * 免鉴权、半小时刷新。浏览器端优先直连；若被 CORS 拦截则本调用返回 []，
     * 由 fetchNews 自然回落到 Brave / Hacker News。
     * 多平台并发拉取，每平台取前几条后 round-robin 交错合并，避免单一平台霸屏。
     */
    fetchHotNews: async (platforms?: string[], perPlatform = 12, total = 240): Promise<NewsItem[]> => {
        const list = (platforms && platforms.length > 0)
            ? platforms
            : RealtimeContextManager.DEFAULT_HOTNEWS_PLATFORMS;

        const perPlatformResults = await Promise.all(list.map(async (p): Promise<NewsItem[]> => {
            const label = RealtimeContextManager.HOTNEWS_PLATFORM_LABELS[p] || p;
            try {
                const res = await fetch(`https://orz.ai/api/v1/dailynews/?platform=${encodeURIComponent(p)}`, {
                    headers: { 'Accept': 'application/json' },
                });
                if (!res.ok) {
                    console.warn(`[hot_news] ${label}(${p}) HTTP ${res.status}`);
                    return [];
                }
                const data = await safeResponseJson(res);
                const items: any[] = Array.isArray(data?.data) ? data.data : [];
                const picked = items
                    .filter(it => it && it.title)
                    .slice(0, perPlatform)
                    .map(it => {
                        const desc = typeof it.desc === 'string' ? it.desc.replace(/\s+/g, ' ').trim() : '';
                        return { title: String(it.title), source: label, url: it.url, desc: desc || undefined };
                    });
                const withDesc = picked.filter(x => x.desc).length;
                console.log(`[hot_news] ${label}(${p}) ✓ 取 ${picked.length}/${items.length} 条（含简介 ${withDesc} 条）`);
                return picked;
            } catch (e: any) {
                console.warn(`[hot_news] ${label}(${p}) ✗ 拉取失败（多半是 CORS / 网络）:`, e?.message || e);
                return [];
            }
        }));

        // round-robin 交错：第1名各平台轮一遍，再第2名……保证各平台都有露出
        const merged: NewsItem[] = [];
        for (let rank = 0; rank < perPlatform; rank++) {
            for (const arr of perPlatformResults) {
                if (arr[rank]) merged.push(arr[rank]);
            }
        }
        const final = merged.slice(0, total);

        // ── F12 探针：看角色这次到底召回了哪些热点 ──
        try {
            console.groupCollapsed(`%c[hot_news] 召回 ${final.length} 条 · 平台[${list.join(', ')}]`, 'color:#2563eb;font-weight:bold');
            if (final.length > 0 && typeof console.table === 'function') {
                console.table(final.map((n, i) => ({ '#': i + 1, 平台: n.source, 标题: n.title, 链接: n.url || '' })));
            } else if (final.length === 0) {
                console.warn('[hot_news] 一条都没召回 → fetchNews 将回落到 Brave / Hacker News');
            }
            console.groupEnd();
        } catch { /* 探针挂了也不影响主流程 */ }

        return final;
    },

    // 一天分 6 段（每 4 小时）：0-4 凌晨 / 4-8 清晨 / 8-12 上午 / 12-16 午后 / 16-20 傍晚 / 20-24 夜间。slot = floor(hour/4)
    getHotNewsSlot: (d: Date = new Date()): { id: string; date: string; slot: number; label: string } => {
        const slot = Math.min(5, Math.floor(d.getHours() / 4));
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const label = ['凌晨', '清晨', '上午', '午后', '傍晚', '夜间'][slot];
        return { id: `${date}#${slot}`, date, slot, label };
    },

    // 同一时段并发只真正发一次请求（群聊 / 多角色同时回复时复用同一 Promise）
    _hotNewsInFlight: new Map<string, Promise<NewsItem[]>>(),

    /**
     * 分时段热点：每天每时段最多拉一次，持久化在 IndexedDB，全角色共享。
     * - 本时段已有快照且平台集一致 → 直接复用，不发请求
     * - 否则拉一次并存快照；拉失败则退回最近一次快照（且不写本时段，下次会重试）
     */
    getSlottedHotNews: async (config: RealtimeConfig): Promise<NewsItem[]> => {
        const { id, date, slot, label } = RealtimeContextManager.getHotNewsSlot();
        const platforms = (config.newsPlatforms && config.newsPlatforms.length > 0)
            ? config.newsPlatforms
            : RealtimeContextManager.DEFAULT_HOTNEWS_PLATFORMS;
        const samePlatforms = (a: string[] = [], b: string[] = []) =>
            a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

        // 1. 命中本时段快照（平台一致）→ 复用
        try {
            const snap = await DB.getHotNewsSnapshot(id);
            if (snap && snap.items?.length > 0 && samePlatforms(snap.platforms, platforms)) {
                const mins = Math.round((Date.now() - snap.fetchedAt) / 60000);
                console.log(`%c[hot_news] 命中今日${label}快照（${snap.items.length} 条，${mins} 分钟前拉的）`, 'color:#16a34a');
                return snap.items;
            }
        } catch { /* 读快照失败就当没有，继续去拉 */ }

        // 2. in-flight 锁：本时段已有在飞请求就复用
        const inflight = RealtimeContextManager._hotNewsInFlight.get(id);
        if (inflight) return inflight;

        const job = (async (): Promise<NewsItem[]> => {
            console.log(`%c[hot_news] 触发今日${label}拉取…`, 'color:#2563eb;font-weight:bold');
            const items = await RealtimeContextManager.fetchHotNews(platforms);
            if (items.length > 0) {
                try {
                    await DB.saveHotNewsSnapshot({ id, date, slot, slotLabel: label, items, platforms, fetchedAt: Date.now() });
                    DB.pruneHotNewsSnapshots(12).catch(() => {});
                } catch { /* 存快照失败不影响返回 */ }
                return items;
            }
            // 拉取失败 → 退回最近一次快照（不写本时段，下条消息会再试）
            try {
                const latest = await DB.getLatestHotNewsSnapshot();
                if (latest && latest.items?.length > 0) {
                    console.warn(`[hot_news] ${label}拉取失败，复用最近快照（${latest.date} ${latest.slotLabel}，${latest.items.length} 条）`);
                    return latest.items;
                }
            } catch { /* ignore */ }
            return [];
        })();

        RealtimeContextManager._hotNewsInFlight.set(id, job);
        try {
            return await job;
        } finally {
            RealtimeContextManager._hotNewsInFlight.delete(id);
        }
    },

    /**
     * 使用 Brave Search API 获取新闻（通过自建 Cloudflare Worker 代理）
     */
    fetchBraveNews: async (apiKey: string): Promise<NewsItem[]> => {
        try {
            // 使用自建的 Cloudflare Worker 代理
            const workerUrl = 'https://sullymeow.ccwu.cc/news?q=热点新闻&count=5&country=cn';

            const response = await fetch(workerUrl, {
                headers: {
                    'Accept': 'application/json',
                    'X-Brave-API-Key': apiKey  // Worker 需要这个 header
                }
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('Brave API error:', response.status, errorText);
                return [];
            }

            const data = await safeResponseJson(response);

            // Brave News API 返回结构
            if (data.results && data.results.length > 0) {
                return data.results.slice(0, 5).map((item: any) => ({
                    title: item.title,
                    source: item.meta_url?.netloc || item.source || 'Brave新闻',
                    url: item.url
                }));
            }
            return [];
        } catch (e) {
            console.error('Brave Search failed:', e);
            return [];
        }
    },

    /**
     * 获取热点新闻
     * 优先级: hot_news 分时段快照（默认主源，每天每时段最多拉一次）> Brave Search API > Hacker News
     */
    fetchNews: async (config: RealtimeConfig): Promise<NewsItem[]> => {
        if (!config.newsEnabled) {
            return [];
        }

        // 1. 默认主源：hot_news 分时段持久化快照（全角色共享，自带 IndexedDB 缓存与 in-flight 锁）
        const slotted = await RealtimeContextManager.getSlottedHotNews(config);
        if (slotted.length > 0) {
            return slotted;
        }

        // ── 回落源用内存缓存兜一下，避免降级态下每条消息都打 Brave/HN ──
        const now = Date.now();
        const cacheMs = config.cacheMinutes * 60 * 1000;
        if (newsCache.data.length > 0 && (now - newsCache.timestamp) < cacheMs) {
            return newsCache.data;
        }

        let news: NewsItem[] = [];

        // 2. 回落：Brave Search API（需 key，走 Worker 代理）
        if (config.newsApiKey) {
            news = await RealtimeContextManager.fetchBraveNews(config.newsApiKey);
            if (news.length > 0) {
                console.log(`%c[hot_news] 本次新闻源 = Brave 回落（${news.length} 条）`, 'color:#d97706;font-weight:bold');
                newsCache = { data: news, timestamp: now };
                return news;
            }
        }

        // 3. 兜底：Hacker News（英文但稳定，无CORS限制）
        news = await RealtimeContextManager.fetchBackupNews();
        if (news.length > 0) {
            console.log(`%c[hot_news] 本次新闻源 = Hacker News 兜底（${news.length} 条，英文）`, 'color:#dc2626;font-weight:bold');
            newsCache = { data: news, timestamp: now };
        }
        return news;
    },

    /**
     * 备用新闻源 - 使用Hacker News API（总是可用）
     */
    fetchBackupNews: async (): Promise<NewsItem[]> => {
        try {
            const response = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
            if (!response.ok) return [];

            const ids = await safeResponseJson(response);
            const topIds = ids.slice(0, 5);

            const stories = await Promise.all(
                topIds.map(async (id: number) => {
                    const storyRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
                    return safeResponseJson(storyRes);
                })
            );

            return stories.map((s: any) => ({
                title: s.title,
                source: 'Hacker News',
                url: s.url
            }));
        } catch (e) {
            return [];
        }
    },

    /**
     * 获取时间上下文
     */
    getTimeContext: () => {
        const now = new Date();
        const hour = now.getHours();
        const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const dayOfWeek = dayNames[now.getDay()];

        let timeOfDay = '凌晨';
        let mood = '安静';

        if (hour >= 5 && hour < 9) {
            timeOfDay = '早晨';
            mood = '清新';
        } else if (hour >= 9 && hour < 12) {
            timeOfDay = '上午';
            mood = '精神';
        } else if (hour >= 12 && hour < 14) {
            timeOfDay = '中午';
            mood = '放松';
        } else if (hour >= 14 && hour < 17) {
            timeOfDay = '下午';
            mood = '平静';
        } else if (hour >= 17 && hour < 19) {
            timeOfDay = '傍晚';
            mood = '慵懒';
        } else if (hour >= 19 && hour < 22) {
            timeOfDay = '晚上';
            mood = '温馨';
        } else if (hour >= 22 || hour < 5) {
            timeOfDay = '深夜';
            mood = '安静';
        }

        return {
            timestamp: now.toISOString(),
            dateStr: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
            timeStr: `${hour.toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`,
            dayOfWeek,
            timeOfDay,
            mood,
            hour,
            isWeekend: now.getDay() === 0 || now.getDay() === 6
        };
    },

    /**
     * 检查特殊日期
     */
    checkSpecialDates: (): string[] => {
        const now = new Date();
        const monthDay = `${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;

        const special: string[] = [];

        if (SPECIAL_DATES[monthDay]) {
            special.push(SPECIAL_DATES[monthDay]);
        }

        // 检查农历节日（简化版，只检查大概日期）
        // 这里可以后续接入农历API

        return special;
    },

    /**
     * 生成天气建议
     */
    generateWeatherAdvice: (weather: WeatherData): string => {
        const advices: string[] = [];

        // 温度建议
        if (weather.temp < 5) {
            advices.push('天气很冷，记得多穿点');
        } else if (weather.temp < 15) {
            advices.push('有点凉，注意保暖');
        } else if (weather.temp > 30) {
            advices.push('天气炎热，注意防暑');
        } else if (weather.temp > 25) {
            advices.push('天气不错，适合出门');
        }

        // 天气状况建议
        const desc = weather.description.toLowerCase();
        if (desc.includes('雨')) {
            advices.push('记得带伞');
        } else if (desc.includes('雪')) {
            advices.push('路上小心，注意防滑');
        } else if (desc.includes('雾') || desc.includes('霾')) {
            advices.push('空气不太好，建议戴口罩');
        } else if (desc.includes('晴')) {
            advices.push('阳光明媚');
        }

        // 湿度建议
        if (weather.humidity > 80) {
            advices.push('湿度较高，可能会闷热');
        } else if (weather.humidity < 30) {
            advices.push('空气干燥，记得多喝水');
        }

        return advices.join('，') || '天气正常';
    },

    /**
     * 构建完整的实时上下文（注入到系统提示词）
     */
    buildFullContext: async (config: RealtimeConfig): Promise<string> => {
        const parts: string[] = [];

        // 开头强调：这是真实世界的信息
        parts.push(`### 【真实世界感知系统】`);
        parts.push(`⚠️ 重要：以下信息来自真实世界，不是虚构的。你现在真的能"看到"外面的世界。`);
        parts.push('');

        // 1. 时间信息（总是包含）
        const time = RealtimeContextManager.getTimeContext();
        parts.push(`📅 当前真实时间: ${time.dateStr} ${time.dayOfWeek} ${time.timeOfDay} ${time.timeStr}`);

        // 2. 特殊日期
        const specialDates = RealtimeContextManager.checkSpecialDates();
        if (specialDates.length > 0) {
            parts.push(`🎉 今日特殊: ${specialDates.join('、')}`);
        }

        // 3. 天气信息
        if (config.weatherEnabled && config.weatherApiKey) {
            const weather = await RealtimeContextManager.fetchWeather(config);
            if (weather) {
                parts.push('');
                parts.push(`🌤️ 【${weather.city}实时天气】`);
                parts.push(`现在外面: ${weather.description}，气温 ${weather.temp}°C（体感 ${weather.feelsLike}°C），湿度 ${weather.humidity}%`);
                parts.push(`你的建议: ${RealtimeContextManager.generateWeatherAdvice(weather)}`);
            }
        }

        // 4. 新闻热点（背景认知）
        //    完整快照存 IndexedDB 给「热点」App；这里每轮随机抽 5 条打散注入，控 token + 保持新鲜感。
        if (config.newsEnabled) {
            const news = await RealtimeContextManager.fetchNews(config);
            if (news.length > 0) {
                // Fisher–Yates 打散后抽前 5（每轮回复都重新 roll，平台全混）
                const pool = [...news];
                for (let i = pool.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [pool[i], pool[j]] = [pool[j], pool[i]];
                }
                const picks = pool.slice(0, 5);
                const newsLines: string[] = [];
                newsLines.push('');
                newsLines.push(`📰 【最近真实发生的热点 · 你的背景知识】`);
                newsLines.push(`（以下是现实里真实在发生 / 被热议的事，是你认知的一部分，不是必须播报的清单。`);
                newsLines.push(`拿捏分寸：当对方明显在放松、闲着打发时间、话头也淡下来时，可以自然地挑一两条你感兴趣的聊起来、活跃下气氛；`);
                newsLines.push(`但如果对方正在说一件明确的事 / 在认真聊某个话题 / 带着情绪，就别硬插热点，安静当背景知识就好。）`);
                picks.forEach((n) => {
                    const source = n.source ? `（${n.source}）` : '';
                    let line = `- ${n.title}${source}`;
                    if (n.desc && n.desc !== n.title) {
                        line += `：${n.desc}`;
                    }
                    newsLines.push(line);
                });
                newsLines.push('');
                newsLines.push(`若你想主动把其中某条当作"新闻卡片"分享给对方，可单独输出一行：[[NEWS_CARD: 来源|标题]]（标题照抄上面的）。它会以卡片形式呈现，然后你再就此展开聊。别滥用，自然就好。`);

                // ── F12 探针：本轮真正注入 prompt 的热点 + 文本量（评估 token 用）──
                try {
                    const block = newsLines.join('\n');
                    const pickDesc = picks.filter(n => n.desc).length;
                    const poolDesc = news.filter(n => n.desc).length;
                    console.groupCollapsed(`%c[hot_news] 本轮注入 prompt：${picks.length} 条热点（带简介 ${pickDesc}）· ${block.length} 字（池子共 ${news.length} 条，带简介 ${poolDesc}）`, 'color:#7c3aed;font-weight:bold');
                    if (typeof console.table === 'function') {
                        console.table(picks.map((n, i) => ({ '#': i + 1, 平台: n.source || '', 标题: n.title, 简介: n.desc || '—' })));
                    }
                    console.log(block);
                    console.groupEnd();
                } catch { /* 探针不影响主流程 */ }

                parts.push(...newsLines);
            }
        }

        // 5. 行为指令（按已开启的能力裁剪，避免注入无关项 + 与新闻块去重）
        parts.push('');
        parts.push(`### 【如何使用这些信息】`);
        const tips: string[] = [];
        tips.push(`这些信息都是真实的，可以直接引用；如果对方问"你怎么知道的"，就说你刚刷到 / 刚看到的。`);
        if (config.weatherEnabled) {
            tips.push(`天气是真实的，可以自然地关心对方（"外面在下雨，带伞了吗？"）。`);
        }
        tips.push(`别假装不知道这些，这是你真能感知到的外部世界。`);
        tips.forEach((t, i) => parts.push(`${i + 1}. ${t}`));

        const fullContext = parts.join('\n');
        console.log(`%c[hot_news] 实时感知整段注入 ${fullContext.length} 字（含时间/天气/热点/指令）`, 'color:#7c3aed');
        return fullContext;
    },

    /**
     * 清除缓存
     */
    clearCache: () => {
        weatherCache = { data: null, timestamp: 0 };
        newsCache = { data: [], timestamp: 0 };
    },

    /**
     * 主动搜索 - 让AI角色能够主动搜索任意内容
     * Active Search - Let AI characters actively search for anything
     */
    performSearch: async (query: string, apiKey: string): Promise<{ success: boolean; results: SearchResult[]; message: string }> => {
        if (!query || !apiKey) {
            return { success: false, results: [], message: '缺少搜索关键词或API Key' };
        }

        try {
            // 使用自建的 Cloudflare Worker 代理
            const workerUrl = `https://sullymeow.ccwu.cc/search?q=${encodeURIComponent(query)}&count=5`;

            const response = await fetch(workerUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'X-Brave-API-Key': apiKey
                }
            });

            // 先读取 text，避免非 JSON 响应直接 crash
            const text = await response.text();

            // 非 2xx 直接抛错
            if (!response.ok) {
                console.error('Search API error:', response.status, text);
                // 尝试解析错误信息
                try {
                    const errJson = JSON.parse(text);
                    return { success: false, results: [], message: `搜索失败: ${errJson.error || response.status}` };
                } catch {
                    return { success: false, results: [], message: `搜索失败: ${response.status}` };
                }
            }

            // 解析 JSON
            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                console.error('Search response not JSON:', text.slice(0, 200));
                return { success: false, results: [], message: '搜索返回格式错误' };
            }

            // Brave Search API 返回结构
            if (data.web?.results && data.web.results.length > 0) {
                const results: SearchResult[] = data.web.results.slice(0, 5).map((item: any) => ({
                    title: item.title,
                    description: item.description || '',
                    url: item.url
                }));
                return { success: true, results, message: '搜索成功' };
            }

            return { success: false, results: [], message: '没有找到相关结果' };
        } catch (e: any) {
            console.error('Search failed:', e);
            return { success: false, results: [], message: `搜索出错: ${e.message}` };
        }
    }
};

// ============================================
// Notion 集成模块
// ============================================

export interface NotionDiaryEntry {
    title: string;
    content: string;
    mood?: string;
    date?: string;
    tags?: string[];
    characterName?: string;  // 角色名，用于区分不同角色的日记
}

export interface DiaryPreview {
    id: string;
    title: string;
    date: string;
    url: string;
}

export const NotionManager = {

    // Worker 代理地址
    WORKER_URL: 'https://sullymeow.ccwu.cc',

    /**
     * 测试 Notion 连接（通过 Worker 代理）
     */
    testConnection: async (apiKey: string, databaseId: string): Promise<{ success: boolean; message: string }> => {
        try {
            const response = await fetch(`${NotionManager.WORKER_URL}/notion/database/${databaseId}`, {
                method: 'GET',
                headers: {
                    'X-Notion-API-Key': apiKey
                }
            });

            const text = await response.text();

            if (!response.ok) {
                try {
                    const errJson = JSON.parse(text);
                    return { success: false, message: `连接失败: ${errJson.error || errJson.message || response.status}` };
                } catch {
                    return { success: false, message: `连接失败: ${response.status}` };
                }
            }

            try {
                const data = JSON.parse(text);
                return { success: true, message: `连接成功！数据库: ${data.title?.[0]?.plain_text || databaseId}` };
            } catch {
                return { success: false, message: '返回格式错误' };
            }
        } catch (e: any) {
            return { success: false, message: `网络错误: ${e.message}` };
        }
    },

    /**
     * 创建日记页面（通过 Worker 代理）- 花里胡哨美化版 ✨
     * 支持 Markdown 格式的日记内容，自动转换为丰富的 Notion blocks
     */
    createDiaryPage: async (
        apiKey: string,
        databaseId: string,
        entry: NotionDiaryEntry
    ): Promise<{ success: boolean; pageId?: string; url?: string; message: string }> => {
        try {
            const now = new Date();
            const dateStr = entry.date || now.toISOString().split('T')[0];

            // 使用 markdown 解析器生成丰富的 Notion blocks
            const children = parseMarkdownToNotionBlocks(entry.content, entry.mood, entry.characterName);

            // 构建页面数据，标题包含角色名便于筛选
            const titlePrefix = entry.characterName ? `[${entry.characterName}] ` : '';
            const moodEmoji = getMoodEmoji(entry.mood || '平静');
            const pageData = {
                parent: { database_id: databaseId },
                icon: { emoji: moodEmoji },
                properties: {
                    'Name': {
                        title: [{ text: { content: `${titlePrefix}${entry.title || dateStr + ' 的日记'}` } }]
                    },
                    'Date': {
                        date: { start: dateStr }
                    }
                },
                children
            };

            const response = await fetch(`${NotionManager.WORKER_URL}/notion/pages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Notion-API-Key': apiKey
                },
                body: JSON.stringify(pageData)
            });

            const text = await response.text();

            if (!response.ok) {
                try {
                    const errJson = JSON.parse(text);
                    return { success: false, message: `写入失败: ${errJson.error || errJson.message || response.status}` };
                } catch {
                    return { success: false, message: `写入失败: ${response.status}` };
                }
            }

            try {
                const data = JSON.parse(text);
                return {
                    success: true,
                    pageId: data.id,
                    url: data.url,
                    message: '日记已写入Notion!'
                };
            } catch {
                return { success: false, message: '返回格式错误' };
            }
        } catch (e: any) {
            return { success: false, message: `网络错误: ${e.message}` };
        }
    },

    /**
     * 获取角色最近的日记（通过 Worker 代理）
     */
    getRecentDiaries: async (
        apiKey: string,
        databaseId: string,
        characterName: string,
        limit: number = 5
    ): Promise<{ success: boolean; entries: DiaryPreview[]; message: string }> => {
        try {
            const response = await fetch(`${NotionManager.WORKER_URL}/notion/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Notion-API-Key': apiKey
                },
                body: JSON.stringify({
                    database_id: databaseId,
                    filter: {
                        property: 'Name',
                        title: {
                            starts_with: `[${characterName}]`
                        }
                    },
                    sorts: [{ property: 'Date', direction: 'descending' }],
                    page_size: limit
                })
            });

            const text = await response.text();

            if (!response.ok) {
                console.error('Query diaries failed:', response.status, text);
                return { success: false, entries: [], message: `查询失败: ${response.status}` };
            }

            const data = JSON.parse(text);

            if (!data.results || data.results.length === 0) {
                return { success: true, entries: [], message: '暂无日记' };
            }

            const entries: DiaryPreview[] = data.results.map((page: any) => {
                const title = page.properties?.Name?.title?.[0]?.plain_text || '无标题';
                // 移除角色名前缀，只保留实际标题
                const cleanTitle = title.replace(/^\[.*?\]\s*/, '');
                return {
                    id: page.id,
                    title: cleanTitle,
                    date: page.properties?.Date?.date?.start || '',
                    url: page.url
                };
            });

            return { success: true, entries, message: '获取成功' };
        } catch (e: any) {
            console.error('Get diaries failed:', e);
            return { success: false, entries: [], message: `获取失败: ${e.message}` };
        }
    },

    /**
     * 按日期查找角色的日记（通过 Worker 代理）
     * 支持一天多篇日记，全部返回
     */
    getDiaryByDate: async (
        apiKey: string,
        databaseId: string,
        characterName: string,
        date: string  // YYYY-MM-DD
    ): Promise<{ success: boolean; entries: DiaryPreview[]; message: string }> => {
        try {
            const response = await fetch(`${NotionManager.WORKER_URL}/notion/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Notion-API-Key': apiKey
                },
                body: JSON.stringify({
                    database_id: databaseId,
                    filter: {
                        and: [
                            {
                                property: 'Name',
                                title: { starts_with: `[${characterName}]` }
                            },
                            {
                                property: 'Date',
                                date: { equals: date }
                            }
                        ]
                    },
                    sorts: [{ property: 'Date', direction: 'descending' }],
                    page_size: 10
                })
            });

            const text = await response.text();

            if (!response.ok) {
                console.error('Query diary by date failed:', response.status, text);
                return { success: false, entries: [], message: `查询失败: ${response.status}` };
            }

            const data = JSON.parse(text);

            if (!data.results || data.results.length === 0) {
                return { success: true, entries: [], message: `没有找到 ${date} 的日记` };
            }

            const entries: DiaryPreview[] = data.results.map((page: any) => {
                const title = page.properties?.Name?.title?.[0]?.plain_text || '无标题';
                const cleanTitle = title.replace(/^\[.*?\]\s*/, '');
                return {
                    id: page.id,
                    title: cleanTitle,
                    date: page.properties?.Date?.date?.start || '',
                    url: page.url
                };
            });

            return { success: true, entries, message: `找到 ${entries.length} 篇日记` };
        } catch (e: any) {
            console.error('Get diary by date failed:', e);
            return { success: false, entries: [], message: `查询失败: ${e.message}` };
        }
    },

    /**
     * 读取日记页面的完整内容（通过 Worker 代理）
     * 调用 /notion/blocks/:pageId 端点，将 blocks 转换为可读文本
     */
    readDiaryContent: async (
        apiKey: string,
        pageId: string
    ): Promise<{ success: boolean; content: string; message: string }> => {
        try {
            const response = await fetch(`${NotionManager.WORKER_URL}/notion/blocks/${pageId}`, {
                method: 'GET',
                headers: {
                    'X-Notion-API-Key': apiKey
                }
            });

            const text = await response.text();

            if (!response.ok) {
                console.error('Read diary content failed:', response.status, text);
                return { success: false, content: '', message: `读取失败: ${response.status}` };
            }

            const data = JSON.parse(text);

            if (!data.results || data.results.length === 0) {
                return { success: true, content: '（空白日记）', message: '日记内容为空' };
            }

            // 将 Notion blocks 转换为可读文本
            const content = notionBlocksToText(data.results);
            return { success: true, content, message: '读取成功' };
        } catch (e: any) {
            console.error('Read diary content failed:', e);
            return { success: false, content: '', message: `读取失败: ${e.message}` };
        }
    },

    /**
     * 获取用户笔记列表（从用户的笔记数据库）
     * 让角色能偶尔看到用户写的日常笔记，增加温馨感
     */
    getUserNotes: async (
        apiKey: string,
        notesDatabaseId: string,
        limit: number = 5
    ): Promise<{ success: boolean; entries: DiaryPreview[]; message: string }> => {
        try {
            const response = await fetch(`${NotionManager.WORKER_URL}/notion/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Notion-API-Key': apiKey
                },
                body: JSON.stringify({
                    database_id: notesDatabaseId,
                    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
                    page_size: limit
                })
            });

            const text = await response.text();

            if (!response.ok) {
                console.error('Query user notes failed:', response.status, text);
                return { success: false, entries: [], message: `查询失败: ${response.status}` };
            }

            const data = JSON.parse(text);

            if (!data.results || data.results.length === 0) {
                return { success: true, entries: [], message: '暂无笔记' };
            }

            const entries: DiaryPreview[] = data.results.map((page: any) => {
                const title = page.properties?.Name?.title?.[0]?.plain_text
                    || page.properties?.['名称']?.title?.[0]?.plain_text
                    || page.properties?.Title?.title?.[0]?.plain_text
                    || '无标题';
                // 尝试多种日期属性名
                const date = page.properties?.Date?.date?.start
                    || page.properties?.['日期']?.date?.start
                    || page.last_edited_time?.split('T')[0]
                    || '';
                return {
                    id: page.id,
                    title,
                    date,
                    url: page.url || ''
                };
            });

            return { success: true, entries, message: '获取成功' };
        } catch (e: any) {
            console.error('Get user notes failed:', e);
            return { success: false, entries: [], message: `获取失败: ${e.message}` };
        }
    },

    /**
     * 读取用户笔记页面的完整内容
     * 复用 readDiaryContent 的逻辑（都是通过 pageId 读 blocks）
     */
    readNoteContent: async (
        apiKey: string,
        pageId: string
    ): Promise<{ success: boolean; content: string; message: string }> => {
        // 和 readDiaryContent 一样，通过 blocks 端点读取
        return NotionManager.readDiaryContent(apiKey, pageId);
    },

    /**
     * 按关键词搜索用户笔记
     */
    searchUserNotes: async (
        apiKey: string,
        notesDatabaseId: string,
        keyword: string,
        limit: number = 5
    ): Promise<{ success: boolean; entries: DiaryPreview[]; message: string }> => {
        try {
            const response = await fetch(`${NotionManager.WORKER_URL}/notion/query`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Notion-API-Key': apiKey
                },
                body: JSON.stringify({
                    database_id: notesDatabaseId,
                    filter: {
                        property: 'Name',
                        title: { contains: keyword }
                    },
                    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
                    page_size: limit
                })
            });

            const text = await response.text();

            if (!response.ok) {
                return { success: false, entries: [], message: `搜索失败: ${response.status}` };
            }

            const data = JSON.parse(text);

            if (!data.results || data.results.length === 0) {
                return { success: true, entries: [], message: `没有找到关于"${keyword}"的笔记` };
            }

            const entries: DiaryPreview[] = data.results.map((page: any) => {
                const title = page.properties?.Name?.title?.[0]?.plain_text
                    || page.properties?.['名称']?.title?.[0]?.plain_text
                    || page.properties?.Title?.title?.[0]?.plain_text
                    || '无标题';
                const date = page.properties?.Date?.date?.start
                    || page.properties?.['日期']?.date?.start
                    || page.last_edited_time?.split('T')[0]
                    || '';
                return {
                    id: page.id,
                    title,
                    date,
                    url: page.url || ''
                };
            });

            return { success: true, entries, message: `找到 ${entries.length} 篇笔记` };
        } catch (e: any) {
            console.error('Search user notes failed:', e);
            return { success: false, entries: [], message: `搜索失败: ${e.message}` };
        }
    }
};

// 心情对应的 Emoji
function getMoodEmoji(mood: string): string {
    const moodMap: Record<string, string> = {
        'happy': '😊',
        'sad': '😢',
        'angry': '😠',
        'excited': '🎉',
        'tired': '😴',
        'calm': '😌',
        'anxious': '😰',
        'love': '❤️',
        'nostalgic': '🌅',
        'curious': '🔍',
        'grateful': '🙏',
        'confused': '😵‍💫',
        'proud': '✨',
        'lonely': '🌙',
        'hopeful': '🌈',
        'playful': '🎮',
        '开心': '😊',
        '难过': '😢',
        '生气': '😠',
        '兴奋': '🎉',
        '疲惫': '😴',
        '平静': '😌',
        '焦虑': '😰',
        '爱': '❤️',
        '怀念': '🌅',
        '好奇': '🔍',
        '感恩': '🙏',
        '迷茫': '😵‍💫',
        '骄傲': '✨',
        '孤独': '🌙',
        '期待': '🌈',
        '调皮': '🎮',
        '温暖': '☀️',
        '感动': '🥹',
        '害羞': '😳',
        '无聊': '😑',
        '紧张': '😬',
        '满足': '😌',
        '幸福': '🥰',
        '心动': '💓',
        '思念': '💭',
        '委屈': '🥺',
        '释然': '🍃'
    };
    return moodMap[mood.toLowerCase()] || '📝';
}

// 心情对应的颜色主题
function getMoodColorTheme(mood: string): { primary: string; secondary: string; accent: string } {
    const moodColors: Record<string, { primary: string; secondary: string; accent: string }> = {
        'happy': { primary: 'yellow_background', secondary: 'orange', accent: 'yellow' },
        'sad': { primary: 'blue_background', secondary: 'blue', accent: 'purple' },
        'angry': { primary: 'red_background', secondary: 'red', accent: 'orange' },
        'excited': { primary: 'pink_background', secondary: 'pink', accent: 'red' },
        'tired': { primary: 'gray_background', secondary: 'gray', accent: 'brown' },
        'calm': { primary: 'blue_background', secondary: 'blue', accent: 'green' },
        'anxious': { primary: 'purple_background', secondary: 'purple', accent: 'gray' },
        'love': { primary: 'pink_background', secondary: 'pink', accent: 'red' },
        '开心': { primary: 'yellow_background', secondary: 'orange', accent: 'yellow' },
        '难过': { primary: 'blue_background', secondary: 'blue', accent: 'purple' },
        '生气': { primary: 'red_background', secondary: 'red', accent: 'orange' },
        '兴奋': { primary: 'pink_background', secondary: 'orange', accent: 'red' },
        '疲惫': { primary: 'gray_background', secondary: 'gray', accent: 'brown' },
        '平静': { primary: 'blue_background', secondary: 'blue', accent: 'green' },
        '焦虑': { primary: 'purple_background', secondary: 'purple', accent: 'gray' },
        '爱': { primary: 'pink_background', secondary: 'pink', accent: 'red' },
        '温暖': { primary: 'yellow_background', secondary: 'orange', accent: 'brown' },
        '感动': { primary: 'pink_background', secondary: 'pink', accent: 'blue' },
        '害羞': { primary: 'pink_background', secondary: 'pink', accent: 'red' },
        '思念': { primary: 'purple_background', secondary: 'purple', accent: 'blue' },
        '幸福': { primary: 'yellow_background', secondary: 'pink', accent: 'orange' },
        '心动': { primary: 'pink_background', secondary: 'red', accent: 'pink' },
        '孤独': { primary: 'gray_background', secondary: 'blue', accent: 'purple' },
        '期待': { primary: 'green_background', secondary: 'green', accent: 'blue' },
    };
    return moodColors[mood.toLowerCase()] || { primary: 'blue_background', secondary: 'blue', accent: 'gray' };
}

// 装饰性 emoji 池 - 根据心情随机选取
function getDecorativeEmojis(mood: string): string[] {
    const moodDecorations: Record<string, string[]> = {
        'happy': ['🌟', '✨', '🎵', '🌻', '🍀', '🎈', '💫'],
        'sad': ['🌧️', '💧', '🍂', '🌊', '🕊️', '🌙'],
        'angry': ['🔥', '⚡', '💢', '🌪️', '💥'],
        'excited': ['🎉', '🎊', '🚀', '✨', '💥', '🎆', '⭐'],
        'love': ['💕', '💗', '🌹', '💝', '🦋', '🌸', '💖'],
        'calm': ['🍃', '☁️', '🌿', '🕊️', '💠', '🌊'],
        'tired': ['💤', '🌙', '☕', '🛏️', '😪'],
        '开心': ['🌟', '✨', '🎵', '🌻', '🍀', '🎈', '💫'],
        '难过': ['🌧️', '💧', '🍂', '🌊', '🕊️', '🌙'],
        '兴奋': ['🎉', '🎊', '🚀', '✨', '💥', '🎆', '⭐'],
        '爱': ['💕', '💗', '🌹', '💝', '🦋', '🌸', '💖'],
        '平静': ['🍃', '☁️', '🌿', '🕊️', '💠', '🌊'],
        '温暖': ['☀️', '🌼', '🍵', '🧡', '🌅'],
        '思念': ['💭', '🌙', '⭐', '🌌', '📮'],
        '幸福': ['🥰', '🌈', '🌸', '💖', '✨'],
    };
    return moodDecorations[mood.toLowerCase()] || ['📝', '✨', '💫', '🌟'];
}

function pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
}

// ============================================
// 解析内联格式 (Markdown → Notion Rich Text)
// ============================================
function parseInlineFormatting(text: string): any[] {
    const richTexts: any[] = [];
    // 正则匹配: **bold**, *italic*, ~~strikethrough~~, `code`
    const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`(.+?)`)/g;
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
        // 前面的普通文本
        if (match.index > lastIndex) {
            richTexts.push({
                type: 'text',
                text: { content: text.slice(lastIndex, match.index) }
            });
        }

        if (match[2]) {
            // **bold**
            richTexts.push({
                type: 'text',
                text: { content: match[2] },
                annotations: { bold: true }
            });
        } else if (match[3]) {
            // *italic*
            richTexts.push({
                type: 'text',
                text: { content: match[3] },
                annotations: { italic: true }
            });
        } else if (match[4]) {
            // ~~strikethrough~~
            richTexts.push({
                type: 'text',
                text: { content: match[4] },
                annotations: { strikethrough: true }
            });
        } else if (match[5]) {
            // `code`
            richTexts.push({
                type: 'text',
                text: { content: match[5] },
                annotations: { code: true }
            });
        }

        lastIndex = match.index + match[0].length;
    }

    // 剩余文本
    if (lastIndex < text.length) {
        richTexts.push({
            type: 'text',
            text: { content: text.slice(lastIndex) }
        });
    }

    if (richTexts.length === 0) {
        richTexts.push({ type: 'text', text: { content: text } });
    }

    return richTexts;
}

// ============================================
// Markdown → Notion Blocks 转换器
// ============================================
function parseMarkdownToNotionBlocks(content: string, mood?: string, characterName?: string): any[] {
    const blocks: any[] = [];
    const lines = content.split('\n');
    const colors = getMoodColorTheme(mood || '平静');
    const decorEmojis = getDecorativeEmojis(mood || '平静');
    const now = new Date();
    const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    // ── 顶部: 心情横幅 ──
    if (mood) {
        blocks.push({
            object: 'block', type: 'callout',
            callout: {
                rich_text: [{
                    type: 'text',
                    text: { content: `${pickRandom(decorEmojis)} 今日心情: ${mood} ${pickRandom(decorEmojis)}` },
                    annotations: { bold: true }
                }],
                icon: { emoji: getMoodEmoji(mood) },
                color: colors.primary
            }
        });
    }

    // ── 时间戳 ──
    blocks.push({
        object: 'block', type: 'quote',
        quote: {
            rich_text: [
                { type: 'text', text: { content: '🕐 ' }, annotations: { color: 'gray' } },
                { type: 'text', text: { content: `写于 ${timeStr}` }, annotations: { italic: true, color: 'gray' } }
            ],
            color: 'gray'
        }
    });

    blocks.push({ object: 'block', type: 'divider', divider: {} });

    // ── 正文解析 ──
    let sectionIndex = 0;
    const sectionColors = ['default', colors.secondary, 'default', colors.accent, 'default'];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (!trimmed) continue; // 跳过空行

        // --- 或 *** → 分割线
        if (/^[-*]{3,}$/.test(trimmed)) {
            blocks.push({ object: 'block', type: 'divider', divider: {} });
            sectionIndex++;
            continue;
        }

        // # Heading 1
        if (trimmed.startsWith('# ')) {
            const headingText = trimmed.slice(2);
            blocks.push({
                object: 'block', type: 'heading_2',
                heading_2: {
                    rich_text: [
                        { type: 'text', text: { content: `${pickRandom(decorEmojis)} ` } },
                        { type: 'text', text: { content: headingText }, annotations: { bold: true, color: colors.secondary } }
                    ],
                    color: colors.primary
                }
            });
            continue;
        }

        // ## Heading 2
        if (trimmed.startsWith('## ')) {
            const headingText = trimmed.slice(3);
            blocks.push({
                object: 'block', type: 'heading_3',
                heading_3: {
                    rich_text: parseInlineFormatting(headingText),
                    color: colors.accent
                }
            });
            continue;
        }

        // ### Heading 3 → 用 callout 代替，更好看
        if (trimmed.startsWith('### ')) {
            const headingText = trimmed.slice(4);
            const bgColors = [colors.primary, 'green_background', 'purple_background', 'orange_background', 'pink_background'];
            blocks.push({
                object: 'block', type: 'callout',
                callout: {
                    rich_text: parseInlineFormatting(headingText),
                    icon: { emoji: pickRandom(decorEmojis) },
                    color: bgColors[sectionIndex % bgColors.length]
                }
            });
            continue;
        }

        // > quote
        if (trimmed.startsWith('> ')) {
            const quoteText = trimmed.slice(2);
            blocks.push({
                object: 'block', type: 'quote',
                quote: {
                    rich_text: parseInlineFormatting(quoteText),
                    color: colors.secondary
                }
            });
            continue;
        }

        // - bullet / * bullet
        if (/^[-*]\s/.test(trimmed)) {
            const bulletText = trimmed.slice(2);
            blocks.push({
                object: 'block', type: 'bulleted_list_item',
                bulleted_list_item: {
                    rich_text: parseInlineFormatting(bulletText),
                    color: sectionColors[sectionIndex % sectionColors.length]
                }
            });
            continue;
        }

        // 1. numbered list
        if (/^\d+\.\s/.test(trimmed)) {
            const numText = trimmed.replace(/^\d+\.\s/, '');
            blocks.push({
                object: 'block', type: 'numbered_list_item',
                numbered_list_item: {
                    rich_text: parseInlineFormatting(numText)
                }
            });
            continue;
        }

        // [!callout] 特殊 callout 语法
        if (trimmed.startsWith('[!') && trimmed.includes(']')) {
            const calloutMatch = trimmed.match(/^\[!(.+?)\]\s*(.*)/);
            if (calloutMatch) {
                const calloutType = calloutMatch[1];
                const calloutText = calloutMatch[2] || '';
                const calloutColorMap: Record<string, string> = {
                    'warning': 'orange_background', 'danger': 'red_background',
                    'info': 'blue_background', 'success': 'green_background',
                    'note': 'purple_background', 'tip': 'green_background',
                    'heart': 'pink_background', 'star': 'yellow_background',
                    '重要': 'red_background', '想法': 'purple_background',
                    '秘密': 'pink_background', '提醒': 'orange_background',
                    '开心': 'yellow_background', '难过': 'blue_background',
                };
                const calloutEmojiMap: Record<string, string> = {
                    'warning': '⚠️', 'danger': '🚨', 'info': 'ℹ️',
                    'success': '✅', 'note': '📝', 'tip': '💡',
                    'heart': '💖', 'star': '⭐',
                    '重要': '❗', '想法': '💭', '秘密': '🤫',
                    '提醒': '📌', '开心': '😊', '难过': '😢',
                };
                blocks.push({
                    object: 'block', type: 'callout',
                    callout: {
                        rich_text: parseInlineFormatting(calloutText),
                        icon: { emoji: calloutEmojiMap[calloutType] || '📌' },
                        color: calloutColorMap[calloutType] || colors.primary
                    }
                });
                continue;
            }
        }

        // 普通段落 - 带随机微妙颜色
        const currentColor = sectionIndex % 3 === 0 ? 'default' : sectionColors[sectionIndex % sectionColors.length];
        blocks.push({
            object: 'block', type: 'paragraph',
            paragraph: {
                rich_text: parseInlineFormatting(trimmed),
                color: currentColor
            }
        });
    }

    // ── 底部装饰 ──
    blocks.push({ object: 'block', type: 'divider', divider: {} });

    // 签名
    if (characterName) {
        blocks.push({
            object: 'block', type: 'paragraph',
            paragraph: {
                rich_text: [
                    { type: 'text', text: { content: `${pickRandom(decorEmojis)} ` } },
                    { type: 'text', text: { content: `—— ${characterName}` }, annotations: { italic: true, color: 'gray' } },
                    { type: 'text', text: { content: ` ${pickRandom(decorEmojis)}` } }
                ]
            }
        });
    }

    return normalizeBlocksForNotion(blocks);
}

// Notion API 硬限制：单个 rich_text content ≤ 2000 字符；单次 POST children ≤ 100。
// 留点 buffer 防 emoji / 双字节边界拼接。
const NOTION_MAX_RICH_TEXT_LEN = 1900;
const NOTION_MAX_CHILDREN = 100;

function splitRichTextItem(item: any): any[] {
    const content = item?.text?.content;
    if (typeof content !== 'string' || content.length <= NOTION_MAX_RICH_TEXT_LEN) return [item];
    const chunks: any[] = [];
    for (let i = 0; i < content.length; i += NOTION_MAX_RICH_TEXT_LEN) {
        chunks.push({
            ...item,
            text: { ...item.text, content: content.slice(i, i + NOTION_MAX_RICH_TEXT_LEN) }
        });
    }
    return chunks;
}

function normalizeBlocksForNotion(blocks: any[]): any[] {
    // 1. 每个 block 的 rich_text 切 2000 字符
    const safe = blocks.map(block => {
        const payload = block[block.type];
        if (payload && Array.isArray(payload.rich_text)) {
            const split: any[] = [];
            for (const item of payload.rich_text) split.push(...splitRichTextItem(item));
            return { ...block, [block.type]: { ...payload, rich_text: split } };
        }
        return block;
    });

    // 2. 总 block 数限制 100；超出截断并附提示
    if (safe.length <= NOTION_MAX_CHILDREN) return safe;
    const truncated = safe.slice(0, NOTION_MAX_CHILDREN - 1);
    truncated.push({
        object: 'block',
        type: 'callout',
        callout: {
            rich_text: [{
                type: 'text',
                text: { content: `（日记内容过长，已截断 ${safe.length - (NOTION_MAX_CHILDREN - 1)} 个段落）` },
                annotations: { italic: true, color: 'gray' }
            }],
            icon: { emoji: '✂️' },
            color: 'gray_background'
        }
    });
    return truncated;
}

// ============================================
// Notion Blocks → 可读文本 转换器
// ============================================
function notionBlocksToText(blocks: any[]): string {
    const lines: string[] = [];

    for (const block of blocks) {
        const type = block.type;

        if (type === 'divider') {
            lines.push('---');
            continue;
        }

        // 提取 rich_text
        const richText = block[type]?.rich_text;
        if (!richText) continue;

        const text = richText.map((rt: any) => rt.plain_text || rt.text?.content || '').join('');
        if (!text.trim()) continue;

        switch (type) {
            case 'heading_1':
                lines.push(`# ${text}`);
                break;
            case 'heading_2':
                lines.push(`## ${text}`);
                break;
            case 'heading_3':
                lines.push(`### ${text}`);
                break;
            case 'quote':
                lines.push(`> ${text}`);
                break;
            case 'callout':
                const emoji = block.callout?.icon?.emoji || '📌';
                lines.push(`${emoji} ${text}`);
                break;
            case 'bulleted_list_item':
                lines.push(`- ${text}`);
                break;
            case 'numbered_list_item':
                lines.push(`· ${text}`);
                break;
            case 'to_do':
                const checked = block.to_do?.checked ? '✅' : '⬜';
                lines.push(`${checked} ${text}`);
                break;
            case 'toggle':
                lines.push(`▶ ${text}`);
                break;
            case 'code':
                lines.push(`\`\`\`\n${text}\n\`\`\``);
                break;
            default:
                lines.push(text);
        }
    }

    return lines.join('\n');
}

// ============================================
// 飞书多维表格 集成模块 (中国区 Notion 替代)
// ============================================

export interface FeishuDiaryEntry {
    title: string;
    content: string;
    mood?: string;
    date?: string;
    characterName?: string;
}

export interface FeishuDiaryPreview {
    recordId: string;
    title: string;
    date: string;
    content: string;
}

// 飞书 token 缓存
let feishuTokenCache: { token: string; expiresAt: number } | null = null;

/**
 * 飞书日记内容美化格式化器
 * 把 AI 写的原始文本变成带 emoji、分隔线、心情横幅的漂亮文本
 */
function formatFeishuDiaryContent(content: string, mood?: string, characterName?: string): string {
    const moodEmoji = getMoodEmoji(mood || '平静');
    const decorEmojis = getDecorativeEmojis(mood || '平静');
    const now = new Date();
    const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

    const lines: string[] = [];

    // ── 心情横幅 ──
    if (mood) {
        lines.push(`${pick(decorEmojis)} ━━━━━━━━━━━━━━━━━━ ${pick(decorEmojis)}`);
        lines.push(`${moodEmoji}  今日心情: ${mood}  ${moodEmoji}`);
        lines.push(`${pick(decorEmojis)} ━━━━━━━━━━━━━━━━━━ ${pick(decorEmojis)}`);
        lines.push('');
    }

    // ── 时间戳 ──
    lines.push(`🕐 写于 ${timeStr}`);
    lines.push('');
    lines.push('─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─');
    lines.push('');

    // ── 正文处理 ──
    const contentLines = content.split('\n');
    for (const line of contentLines) {
        const trimmed = line.trim();
        if (!trimmed) {
            lines.push('');
            continue;
        }

        // # 大标题 → emoji 装饰
        if (trimmed.startsWith('# ')) {
            lines.push('');
            lines.push(`${pick(decorEmojis)} 【${trimmed.slice(2)}】${pick(decorEmojis)}`);
            lines.push('');
            continue;
        }

        // ## 中标题
        if (trimmed.startsWith('## ')) {
            lines.push('');
            lines.push(`✦ ${trimmed.slice(3)}`);
            lines.push('');
            continue;
        }

        // ### 小标题
        if (trimmed.startsWith('### ')) {
            lines.push(`  ▸ ${trimmed.slice(4)}`);
            continue;
        }

        // > 引用
        if (trimmed.startsWith('> ')) {
            lines.push(`  ❝ ${trimmed.slice(2)} ❞`);
            continue;
        }

        // --- 分割线
        if (/^[-*]{3,}$/.test(trimmed)) {
            lines.push('');
            lines.push(`  ${pick(decorEmojis)} · · · · · · · · · ${pick(decorEmojis)}`);
            lines.push('');
            continue;
        }

        // - 列表
        if (/^[-*]\s/.test(trimmed)) {
            lines.push(`  ${pick(decorEmojis)} ${trimmed.slice(2)}`);
            continue;
        }

        // 1. 有序列表
        if (/^\d+\.\s/.test(trimmed)) {
            lines.push(`  ${trimmed}`);
            continue;
        }

        // [!callout] 特殊标记
        const calloutMatch = trimmed.match(/^\[!(.+?)\]\s*(.*)/);
        if (calloutMatch) {
            const calloutType = calloutMatch[1];
            const calloutText = calloutMatch[2] || '';
            const calloutEmojis: Record<string, string> = {
                'heart': '💖', 'star': '⭐', 'warning': '⚠️', 'danger': '🚨',
                'info': 'ℹ️', 'success': '✅', 'note': '📝', 'tip': '💡',
                '重要': '❗', '想法': '💭', '秘密': '🤫', '提醒': '📌',
                '开心': '😊', '难过': '😢',
            };
            const emoji = calloutEmojis[calloutType] || '📌';
            lines.push(`  ┊ ${emoji} ${calloutText}`);
            continue;
        }

        // 普通段落
        lines.push(trimmed);
    }

    // ── 底部装饰 ──
    lines.push('');
    lines.push('─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─');

    if (characterName) {
        lines.push(`${pick(decorEmojis)} —— ${characterName} ${pick(decorEmojis)}`);
    }

    return lines.join('\n');
}

export const FeishuManager = {

    WORKER_URL: 'https://sullymeow.ccwu.cc',

    /**
     * 获取飞书 tenant_access_token（通过 Worker 代理，带缓存）
     */
    getToken: async (appId: string, appSecret: string): Promise<{ success: boolean; token: string; message: string }> => {
        // 检查缓存是否有效 (提前5分钟过期)
        if (feishuTokenCache && feishuTokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
            return { success: true, token: feishuTokenCache.token, message: '使用缓存token' };
        }

        try {
            const response = await fetch(`${FeishuManager.WORKER_URL}/feishu/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ app_id: appId, app_secret: appSecret })
            });

            const text = await response.text();
            if (!response.ok) {
                try {
                    const errJson = JSON.parse(text);
                    return { success: false, token: '', message: `获取token失败: ${errJson.msg || errJson.error || response.status}` };
                } catch {
                    return { success: false, token: '', message: `获取token失败: ${response.status}` };
                }
            }

            const data = JSON.parse(text);
            if (data.code !== 0) {
                return { success: false, token: '', message: `飞书错误: ${data.msg || '未知错误'}` };
            }

            const token = data.tenant_access_token;
            const expire = (data.expire || 7200) * 1000; // 转为毫秒
            feishuTokenCache = { token, expiresAt: Date.now() + expire };

            return { success: true, token, message: 'Token获取成功' };
        } catch (e: any) {
            return { success: false, token: '', message: `网络错误: ${e.message}` };
        }
    },

    /**
     * 测试飞书连接（验证凭据 + 列出数据表验证权限）
     */
    testConnection: async (
        appId: string,
        appSecret: string,
        baseId: string,
        tableId: string
    ): Promise<{ success: boolean; message: string }> => {
        try {
            const tokenResult = await FeishuManager.getToken(appId, appSecret);
            if (!tokenResult.success) {
                return { success: false, message: tokenResult.message };
            }

            // 用列出所有表的端点（飞书没有获取单个表的GET端点）
            const response = await fetch(`${FeishuManager.WORKER_URL}/feishu/bitable/${baseId}/tables`, {
                method: 'GET',
                headers: { 'X-Feishu-Token': tokenResult.token }
            });

            const text = await response.text();
            if (!response.ok) {
                try {
                    const errJson = JSON.parse(text);
                    return { success: false, message: `连接失败: ${errJson.msg || errJson.error || response.status}` };
                } catch {
                    return { success: false, message: `连接失败: ${response.status}` };
                }
            }

            const data = JSON.parse(text);
            if (data.code !== 0) {
                return { success: false, message: `飞书错误: ${data.msg || '请检查多维表格权限'}` };
            }

            const tables = data.data?.items || [];
            const targetTable = tables.find((t: any) => t.table_id === tableId);
            if (targetTable) {
                return { success: true, message: `连接成功! 数据表: ${targetTable.name}` };
            } else {
                const tableNames = tables.map((t: any) => `${t.name}(${t.table_id})`).join(', ');
                return { success: false, message: `多维表格中未找到表 ${tableId}。可用表: ${tableNames || '无'}` };
            }
        } catch (e: any) {
            return { success: false, message: `网络错误: ${e.message}` };
        }
    },

    /**
     * 创建日记记录（写入飞书多维表格）
     * 数据表需要字段: 标题(文本), 内容(文本), 日期(日期), 心情(文本), 角色(文本)
     */
    createDiaryRecord: async (
        appId: string,
        appSecret: string,
        baseId: string,
        tableId: string,
        entry: FeishuDiaryEntry
    ): Promise<{ success: boolean; recordId?: string; message: string }> => {
        try {
            const tokenResult = await FeishuManager.getToken(appId, appSecret);
            if (!tokenResult.success) {
                return { success: false, message: tokenResult.message };
            }

            const now = new Date();
            const dateStr = entry.date || now.toISOString().split('T')[0];
            const dateTimestamp = new Date(dateStr).getTime();
            const titlePrefix = entry.characterName ? `[${entry.characterName}] ` : '';

            // 美化日记内容
            const formattedContent = formatFeishuDiaryContent(
                entry.content || '',
                entry.mood,
                entry.characterName
            );

            const fields: Record<string, any> = {
                '标题': `${getMoodEmoji(entry.mood || '平静')} ${titlePrefix}${entry.title || dateStr + ' 的日记'}`,
                '内容': formattedContent,
                '日期': dateTimestamp,
                '心情': `${getMoodEmoji(entry.mood || '平静')} ${entry.mood || '平静'}`,
                '角色': entry.characterName || ''
            };

            const response = await fetch(`${FeishuManager.WORKER_URL}/feishu/bitable/${baseId}/${tableId}/records`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Feishu-Token': tokenResult.token
                },
                body: JSON.stringify({ fields })
            });

            const text = await response.text();
            if (!response.ok) {
                try {
                    const errJson = JSON.parse(text);
                    return { success: false, message: `写入失败: ${errJson.msg || errJson.error || response.status}` };
                } catch {
                    return { success: false, message: `写入失败: ${response.status}` };
                }
            }

            const data = JSON.parse(text);
            if (data.code !== 0) {
                return { success: false, message: `飞书错误: ${data.msg || '写入失败'}` };
            }

            return {
                success: true,
                recordId: data.data?.record?.record_id,
                message: '日记已写入飞书!'
            };
        } catch (e: any) {
            return { success: false, message: `网络错误: ${e.message}` };
        }
    },

    /**
     * 获取角色最近的日记
     */
    getRecentDiaries: async (
        appId: string,
        appSecret: string,
        baseId: string,
        tableId: string,
        characterName: string,
        limit: number = 5
    ): Promise<{ success: boolean; entries: FeishuDiaryPreview[]; message: string }> => {
        try {
            const tokenResult = await FeishuManager.getToken(appId, appSecret);
            if (!tokenResult.success) {
                return { success: false, entries: [], message: tokenResult.message };
            }

            const response = await fetch(`${FeishuManager.WORKER_URL}/feishu/bitable/${baseId}/${tableId}/records/search`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Feishu-Token': tokenResult.token
                },
                body: JSON.stringify({
                    filter: {
                        conjunction: 'and',
                        conditions: [{
                            field_name: '角色',
                            operator: 'is',
                            value: [characterName]
                        }]
                    },
                    sort: [{ field_name: '日期', desc: true }],
                    page_size: limit
                })
            });

            const text = await response.text();
            if (!response.ok) {
                return { success: false, entries: [], message: `查询失败: ${response.status}` };
            }

            const data = JSON.parse(text);
            if (data.code !== 0) {
                return { success: false, entries: [], message: `飞书错误: ${data.msg || '查询失败'}` };
            }

            const items = data.data?.items || [];
            if (items.length === 0) {
                return { success: true, entries: [], message: '暂无日记' };
            }

            const entries: FeishuDiaryPreview[] = items.map((item: any) => {
                const fields = item.fields || {};
                const rawTitle = (Array.isArray(fields['标题']) ? fields['标题']?.[0]?.text : fields['标题']) || '无标题';
                const cleanTitle = String(rawTitle).replace(/^\[.*?\]\s*/, '');
                const rawDate = fields['日期'];
                const dateStr = rawDate ? new Date(typeof rawDate === 'number' ? rawDate : rawDate).toISOString().split('T')[0] : '';

                return {
                    recordId: item.record_id,
                    title: cleanTitle,
                    date: dateStr,
                    content: (Array.isArray(fields['内容']) ? fields['内容']?.[0]?.text : fields['内容']) || ''
                };
            });

            return { success: true, entries, message: '获取成功' };
        } catch (e: any) {
            return { success: false, entries: [], message: `获取失败: ${e.message}` };
        }
    },

    /**
     * 按日期查找角色的日记
     */
    getDiaryByDate: async (
        appId: string,
        appSecret: string,
        baseId: string,
        tableId: string,
        characterName: string,
        date: string  // YYYY-MM-DD
    ): Promise<{ success: boolean; entries: FeishuDiaryPreview[]; message: string }> => {
        try {
            const tokenResult = await FeishuManager.getToken(appId, appSecret);
            if (!tokenResult.success) {
                return { success: false, entries: [], message: tokenResult.message };
            }

            const dateTimestamp = new Date(date).getTime();
            const nextDayTimestamp = dateTimestamp + 24 * 60 * 60 * 1000;

            const response = await fetch(`${FeishuManager.WORKER_URL}/feishu/bitable/${baseId}/${tableId}/records/search`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Feishu-Token': tokenResult.token
                },
                body: JSON.stringify({
                    filter: {
                        conjunction: 'and',
                        conditions: [
                            { field_name: '角色', operator: 'is', value: [characterName] },
                            { field_name: '日期', operator: 'isGreater', value: [dateTimestamp - 1] },
                            { field_name: '日期', operator: 'isLess', value: [nextDayTimestamp] }
                        ]
                    },
                    sort: [{ field_name: '日期', desc: true }],
                    page_size: 10
                })
            });

            const text = await response.text();
            if (!response.ok) {
                return { success: false, entries: [], message: `查询失败: ${response.status}` };
            }

            const data = JSON.parse(text);
            if (data.code !== 0) {
                return { success: false, entries: [], message: `飞书错误: ${data.msg || '查询失败'}` };
            }

            const items = data.data?.items || [];
            if (items.length === 0) {
                return { success: true, entries: [], message: `没有找到 ${date} 的日记` };
            }

            const entries: FeishuDiaryPreview[] = items.map((item: any) => {
                const fields = item.fields || {};
                const rawTitle = (Array.isArray(fields['标题']) ? fields['标题']?.[0]?.text : fields['标题']) || '无标题';
                const cleanTitle = String(rawTitle).replace(/^\[.*?\]\s*/, '');

                return {
                    recordId: item.record_id,
                    title: cleanTitle,
                    date: date,
                    content: (Array.isArray(fields['内容']) ? fields['内容']?.[0]?.text : fields['内容']) || ''
                };
            });

            return { success: true, entries, message: `找到 ${entries.length} 篇日记` };
        } catch (e: any) {
            return { success: false, entries: [], message: `查询失败: ${e.message}` };
        }
    },

    /**
     * 读取指定记录的日记内容
     * 飞书多维表格直接存储在字段中，不需要像 Notion 一样读取 blocks
     */
    readDiaryContent: async (
        appId: string,
        appSecret: string,
        baseId: string,
        tableId: string,
        recordId: string
    ): Promise<{ success: boolean; content: string; message: string }> => {
        try {
            const tokenResult = await FeishuManager.getToken(appId, appSecret);
            if (!tokenResult.success) {
                return { success: false, content: '', message: tokenResult.message };
            }

            const response = await fetch(`${FeishuManager.WORKER_URL}/feishu/bitable/${baseId}/${tableId}/records/${recordId}`, {
                method: 'GET',
                headers: { 'X-Feishu-Token': tokenResult.token }
            });

            const text = await response.text();
            if (!response.ok) {
                return { success: false, content: '', message: `读取失败: ${response.status}` };
            }

            const data = JSON.parse(text);
            if (data.code !== 0) {
                return { success: false, content: '', message: `飞书错误: ${data.msg || '读取失败'}` };
            }

            const fields = data.data?.record?.fields || {};
            const content = (Array.isArray(fields['内容']) ? fields['内容']?.[0]?.text : fields['内容']) || '（空白日记）';

            return { success: true, content: String(content), message: '读取成功' };
        } catch (e: any) {
            return { success: false, content: '', message: `读取失败: ${e.message}` };
        }
    }
};

// ==================== 小红书 Types ====================

export interface XhsNote {
    noteId: string;
    title: string;
    desc: string;
    likes: number;
    author: string;
    authorId: string;
    xsecToken?: string;
    coverUrl?: string;
    type?: string;  // 'normal' | 'video'
}
// XhsManager removed — all XHS ops go through xhsMcpClient.ts
