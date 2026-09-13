import { validateFamiliarity } from './sarFamiliarity/storageTypes';
import { sarNpcContentEnabled } from './sarNpcPreference';
import { SAR_STARTING_BALANCE, SAR_WANDERER_BALANCE, SAR_DAILY_BUYBACK, SAR_ECONOMY_VERSION, sarEconomyDay, remainingSARBuyback, creditSARWallet, type SARBuybackBudget } from './sarEconomy';
import type { CharacterProfile, RealtimeConfig, UserProfile } from '../../types';
import type { DinosaurGarden, DinoOrigin } from './dinosaurTypes';
import { readDinosaurGarden } from './dinosaurStorage';
import { AIVEN_FISH_SALE_REPLIES, validAivenFishSale, type AivenFishSale } from './fishingSale';

// A leaf module: importing the backup adapter must not pull in DB/prompt execution.
export const FISHING_MARKET_STORAGE_KEY = 'vr_fishing_market_v1';
export const MARKET_DAY_MS = 86_400_000;
export type FishingWeatherKind = 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog' | 'snow';
export type FishingRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'relic';
export interface FishingWeather { kind: FishingWeatherKind; label: string; detail: string; source: 'real' | 'simulated' }
export interface FishSpecies {
    id: string; name: string; icon: string; category: 'fish' | 'time-relic'; rarity: FishingRarity;
    basePrice: number; difficulty: number; weathers: FishingWeatherKind[]; blurb: string;
}
export interface MarketActor { id: string; name: string; kind: 'user' | 'character' | 'wanderer' }
export interface FishingCatch {
    origin?: DinoOrigin;
    id: string; speciesId: string; ownerId: string; ownerName: string; caughtAt: number;
    weather: FishingWeatherKind; weatherLabel: string; weatherSource: FishingWeather['source'];
    sizeCm: number; quality: 1 | 2 | 3; displayed?: boolean; studied?: boolean; incubatingUntil?: number;
}
export interface MarketComment {
    id: string; authorId: string; authorName: string; alias?: string; content: string; createdAt: number;
}
export interface MarketPostBase {
    id: string; itemLabel: string; createdAt: number; expiresAt: number; closedAt?: number;
    status: 'open' | 'sold' | 'fulfilled' | 'removed' | 'expired'; comments: MarketComment[]; alias?: string;
}
export type MarketCatchSnapshot = Pick<FishingCatch, 'id' | 'speciesId' | 'sizeCm' | 'quality'> & { nickname?: string };
export interface MarketListing extends MarketPostBase {
    sellerId: string; sellerName: string; catchId?: string; price: number; note?: string; buyerId?: string; buyerName?: string;
    catchSnapshot?: MarketCatchSnapshot;
}
export interface MarketRequest extends MarketPostBase {
    authorId: string; authorName: string; speciesId?: string; kind: 'item' | 'favor' | 'tip';
    offer: number; body: string; fulfillerId?: string; fulfillerName?: string; submission?: string;
    fulfilledCatch?: MarketCatchSnapshot;
}
export interface MarketLedgerItem {
    id: string; at: number; text: string; participants: string[]; deliveredTo: string[];
    quotes?: { name: string; content: string }[];
    sarPurchase?: { kind: 'draw' | 'module'; itemId: string; paid: number; firstCopy?: boolean };
    aivenSale?: AivenFishSale;
}
export interface FishingCollectionEntry {
    actorId: string; actorName: string; speciesId: string;
    firstObtainedAt: number; acquisitionIds: string[];
    /** Old saves can only reconstruct evidenced acquisitions, never invented totals. */
    historicalIncomplete?: boolean;
    announcement?: { id: string; published: boolean };
}
export interface FishingReaction {
    disposition: 'keep' | 'release' | 'sell'; reaction: string; shareToUser: { text: string } | null;
    saleWords?: string;
}
export interface FishingTrip {
    catch: FishingCatch; status: 'pending' | 'settled';
    result?: FishingReaction; settledAt?: number; cardSent?: boolean; shareSent?: boolean;
    sale?: AivenFishSale;
}
export interface FishingMarketState {
    sarFamiliarity?: import('./sarFamiliarity/storageTypes').FamiliarityState;
    sarCollection?: import('./sarCollectionJournal').SARCollectionJournal;
    economyVersion?: number;
    buybackBudgets?: Record<string, SARBuybackBudget>;
    sarCharacterModules?: Record<string, Record<string, number>>;
    sarCommerce?: { gacha: import('./sarGacha').SARGachaState; moduleShop: import('./sarModuleShop').SARModuleShopState };
    dinosaurGarden?: DinosaurGarden;
    collectionEntries?: FishingCollectionEntry[];
    fishingTrips?: FishingTrip[];
    version: 1; seed: number; accounts: Record<string, number>; inventory: FishingCatch[]; discovered: string[];
    listings: MarketListing[]; requests: MarketRequest[]; ledger: MarketLedgerItem[];
    priceDate: string; prices: Record<string, number>; previousPrices: Record<string, number>;
    lastPulseAt?: number; research: Record<string, number>;
}
export const WEATHER_LABELS: Record<FishingWeatherKind, string> = {
    clear: '晴朗', cloudy: '多云', rain: '有雨', storm: '雷暴', fog: '起雾', snow: '降雪',
};
export const FISH_CATALOG: FishSpecies[] = [
    { id: 'glass-minnow', name: '玻璃米鱼', icon: '◇', category: 'fish', rarity: 'common', basePrice: 8, difficulty: .18, weathers: ['clear', 'cloudy'], blurb: '逆光时几乎只剩下一道骨影。' },
    { id: 'cloud-carp', name: '云纹鲤', icon: '≈', category: 'fish', rarity: 'common', basePrice: 10, difficulty: .22, weathers: ['cloudy', 'fog'], blurb: '鳞片像被揉散的云。' },
    { id: 'rain-drum', name: '雨鼓鱼', icon: '◌', category: 'fish', rarity: 'common', basePrice: 12, difficulty: .28, weathers: ['rain', 'storm'], blurb: '雨点打在水面时，会从腹腔回一声。' },
    { id: 'sunneedle', name: '日针鱼', icon: '⌁', category: 'fish', rarity: 'uncommon', basePrice: 18, difficulty: .38, weathers: ['clear'], blurb: '细长而烫手，喜欢追逐水里的光斑。' },
    { id: 'moss-eel', name: '苔衣鳗', icon: '∿', category: 'fish', rarity: 'uncommon', basePrice: 22, difficulty: .42, weathers: ['rain', 'fog'], blurb: '从旧石缝里钻出来，身上带着一小片岸。' },
    { id: 'thunder-ray', name: '低压鳐', icon: '⌇', category: 'fish', rarity: 'rare', basePrice: 38, difficulty: .58, weathers: ['storm'], blurb: '雷声越近，它越贴近水面。' },
    { id: 'snow-lantern', name: '雪灯鱼', icon: '✧', category: 'fish', rarity: 'rare', basePrice: 36, difficulty: .55, weathers: ['snow'], blurb: '腹部微亮，像没来得及熄灭的小灯。' },
    { id: 'moon-envelope', name: '月皮信使', icon: '◒', category: 'fish', rarity: 'epic', basePrice: 54, difficulty: .72, weathers: ['clear', 'fog'], blurb: '鳍下夹着一片没有收件人的银色薄膜。' },
    { id: 'static-whale', name: '静电幼鲸', icon: '◜', category: 'fish', rarity: 'epic', basePrice: 62, difficulty: .78, weathers: ['storm', 'cloudy'], blurb: '其实只有手掌大，叫声却会让终端雪花一瞬。' },
    { id: 'tyrannosaurus', name: '霸王龙', icon: '暴', category: 'time-relic', rarity: 'relic', basePrice: 80, difficulty: .9, weathers: ['storm', 'clear'], blurb: '艾文捏的小霸王龙，圆肚子和短手都很认真。' },
    { id: 'triceratops', name: '三角龙', icon: '角', category: 'time-relic', rarity: 'relic', basePrice: 70, difficulty: .84, weathers: ['cloudy', 'rain'], blurb: '从水里冒出三只角，比鱼线更困惑。' },
    { id: 'stegosaurus', name: '剑龙', icon: '剑', category: 'time-relic', rarity: 'relic', basePrice: 68, difficulty: .82, weathers: ['clear', 'fog'], blurb: '背板卡住了水面的一小段晚霞。' },
    { id: 'brachiosaurus', name: '腕龙', icon: '腕', category: 'time-relic', rarity: 'relic', basePrice: 86, difficulty: .92, weathers: ['fog', 'cloudy'], blurb: '一根长脖子的小模型，脖子上还留着指腹的痕迹。' },
    { id: 'velociraptor', name: '迅猛龙', icon: '迅', category: 'time-relic', rarity: 'relic', basePrice: 74, difficulty: .94, weathers: ['storm', 'rain'], blurb: '不是被钓上来的，更像顺着线追了上来。' },
    { id: 'spinosaurus', name: '棘龙', icon: '棘', category: 'time-relic', rarity: 'relic', basePrice: 82, difficulty: .93, weathers: ['rain', 'storm'], blurb: '理论上，它才是来钓鱼的那个。' },
    { id: 'ankylosaurus', name: '甲龙', icon: '甲', category: 'time-relic', rarity: 'relic', basePrice: 72, difficulty: .86, weathers: ['clear', 'cloudy'], blurb: '圆滚滚的橡皮泥小甲龙，尾锤像一颗栗子。' },
    { id: 'parasaurolophus', name: '副栉龙', icon: '栉', category: 'time-relic', rarity: 'relic', basePrice: 68, difficulty: .8, weathers: ['fog', 'rain'], blurb: '有点荒谬。它还对鱼漂吹了一声。' },
    { id: 'pteranodon', name: '无齿翼龙', icon: '翼', category: 'time-relic', rarity: 'relic', basePrice: 78, difficulty: .9, weathers: ['clear', 'storm'], blurb: '从水下被钓到半空，过程学术上很柔软。' },
    { id: 'plesiosaur', name: '蛇颈龙', icon: '颈', category: 'time-relic', rarity: 'relic', basePrice: 90, difficulty: .96, weathers: ['rain', 'fog'], blurb: '含量正在稳步下降——艾文坚持这么说。' },
    { id: 'dinosaur-egg', name: '恐龙蛋', icon: '蛋', category: 'time-relic', rarity: 'relic', basePrice: 56, difficulty: .74, weathers: ['clear', 'cloudy', 'rain'], blurb: '橡皮泥惊喜蛋，交给研究台后可以揭晓里面的小模型。' },
    { id: 'dinosaur-fossil', name: '恐龙骨架', icon: '骨', category: 'time-relic', rarity: 'relic', basePrice: 62, difficulty: .76, weathers: ['fog', 'snow'], blurb: '罕见的橡皮泥骨架模型，骨头也是一根根捏的。' },
];


export const STORY_CATCH_CATALOG: FishSpecies[] = [{ id: 'aiven-chimera', name: '？？？', icon: '？', category: 'time-relic', rarity: 'relic', basePrice: 80, difficulty: 1, weathers: [], blurb: '艾文从异常的物品堆里找出的专属混合恐龙：霸王龙的身体、三角龙的角、剑龙的背板和腕龙的长脖子。' }];
export const speciesById = (id: string) => [...FISH_CATALOG, ...STORY_CATCH_CATALOG].find(species => species.id === id);
export const marketId = (p: string) => p + '_' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
const money = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0 || n > 1_000_000) throw new Error('金额须为 0～1,000,000 的整数');
    return n;
};
const txt = (s: string, max = 240) => String(s || '').trim().slice(0, max);
export const marketHash = (text: string): number => {
    let h = 1779033703 ^ text.length;
    for (let i = 0; i < text.length; i++) { h = Math.imul(h ^ text.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
    return (h >>> 0) || 1;
};
export const marketRandom = (seed: number) => {
    let t = seed >>> 0;
    return () => {
        t += 0x6D2B79F5;
        let v = Math.imul(t ^ t >>> 15, t | 1);
        v ^= v + Math.imul(v ^ v >>> 7, v | 61);
        return ((v ^ v >>> 14) >>> 0) / 4294967296;
    };
};
const localDate = (at = Date.now()) => {
    const d = new Date(at);
    return [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-');
};
export const createFishingMarketState = (seed = Math.floor(Math.random() * 0x7fffffff)): FishingMarketState => ({
    version: 1, seed, accounts: {}, inventory: [], discovered: [], listings: [], requests: [], ledger: [],
    priceDate: '', prices: {}, previousPrices: {}, research: {}, collectionEntries: [], fishingTrips: [],
});
export const readFishingMarketState = (storage: Pick<Storage, 'getItem'> = localStorage): FishingMarketState => {
    const source = storage.getItem(FISHING_MARKET_STORAGE_KEY);
    if (!source) return createFishingMarketState();
    let raw: FishingMarketState;
    try { raw = JSON.parse(source); } catch { throw new Error('水域存档无法读取，请先导出备份；没有覆盖原存档'); }
    if (!raw || raw.version !== 1 || !Array.isArray(raw.inventory) || !Array.isArray(raw.listings) || !Array.isArray(raw.requests)
        || !Array.isArray(raw.ledger) || !raw.accounts || !Number.isFinite(raw.seed)) throw new Error('水域存档格式不兼容；没有覆盖原存档');
    if (typeof raw.accounts !== 'object' || Array.isArray(raw.accounts) || Object.values(raw.accounts).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('钱包数据异常，请先导出备份');
    if (raw.sarCollection !== undefined && (!raw.sarCollection || raw.sarCollection.version !== 1 || !raw.sarCollection.actors || typeof raw.sarCollection.actors !== 'object' || Array.isArray(raw.sarCollection.actors)
        || Object.values(raw.sarCollection.actors).some(entry => !entry || !Array.isArray(entry.chips) || !Array.isArray(entry.modules) || [...entry.chips, ...entry.modules].some(id => typeof id !== 'string' || !id)))) throw new Error('收集图鉴存档异常，请先备份');
    if (raw.buybackBudgets !== undefined && (!raw.buybackBudgets || typeof raw.buybackBudgets !== 'object' || Array.isArray(raw.buybackBudgets)
        || Object.values(raw.buybackBudgets).some(b => !b || typeof b.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.day) || !Number.isSafeInteger(b.earned) || b.earned < 0))) throw new Error('回收额度存档异常，请先备份');
    if (raw.sarCharacterModules !== undefined && (!raw.sarCharacterModules || typeof raw.sarCharacterModules !== 'object' || Array.isArray(raw.sarCharacterModules)
        || Object.values(raw.sarCharacterModules).some(bag => !bag || typeof bag !== 'object' || Array.isArray(bag) || Object.values(bag).some(n => !Number.isSafeInteger(n) || n < 0)))) throw new Error('角色仓库存档异常，请先备份');
    if (raw.collectionEntries !== undefined && (!Array.isArray(raw.collectionEntries) || raw.collectionEntries.some(e => !e || typeof e.actorId !== 'string' || !speciesById(e.speciesId) || !Number.isFinite(e.firstObtainedAt) || !Array.isArray(e.acquisitionIds) || e.acquisitionIds.some(id => typeof id !== 'string') || (e.announcement && (typeof e.announcement.id !== 'string' || typeof e.announcement.published !== 'boolean'))))) throw new Error('个人图鉴存档无法读取；没有覆盖原存档');
    if (raw.fishingTrips !== undefined && (!Array.isArray(raw.fishingTrips) || raw.fishingTrips.some(t => !t?.catch?.id || typeof t.catch.ownerId !== 'string' || !speciesById(t.catch.speciesId) || !Number.isFinite(t.catch.caughtAt) || !['pending', 'settled'].includes(t.status) || (t.status === 'settled' && (!t.result || !['keep', 'release', 'sell'].includes(t.result.disposition) || typeof t.result.reaction !== 'string' || (t.result.shareToUser !== null && typeof t.result.shareToUser?.text !== 'string')))))) throw new Error('钓鱼记录无法读取；没有覆盖原存档');
    if (raw.fishingTrips?.some(t => (t.sale !== undefined && !validAivenFishSale(t.sale)) || (t.result?.disposition === 'sell' && !t.sale))
        || raw.ledger.some(e => e.aivenSale !== undefined && !validAivenFishSale(e.aivenSale))) throw new Error('售鱼回执无法读取；没有覆盖原存档');
    if (raw.sarFamiliarity !== undefined) validateFamiliarity(raw.sarFamiliarity);
    return migrateFishingCollection({ ...raw, ...(raw.dinosaurGarden ? {dinosaurGarden:readDinosaurGarden(raw.dinosaurGarden)} : {}), research: raw.research || {}, discovered: raw.discovered || [],
        listings: raw.listings.map(p => ({ ...p, comments: p.comments || [] })),
        requests: raw.requests.map(p => ({ ...p, comments: p.comments || [], kind: p.kind || (p.speciesId ? 'item' : 'favor') })),
        ledger: raw.ledger.map(e => ({ ...e, participants: e.participants || [], deliveredTo: e.deliveredTo || [] })) });
};
export const saveFishingMarketState = (state: FishingMarketState, storage: Pick<Storage, 'setItem'> = localStorage) => {
    // Never truncate earned assets or archives. Storage exhaustion must fail visibly.
    storage.setItem(FISHING_MARKET_STORAGE_KEY, JSON.stringify(state));
    try { window.dispatchEvent(new CustomEvent('vr-fishing-market-updated')); } catch { /* node */ }
    return state;
};
export const logMarketEvent = (state: FishingMarketState, text: string, participants: string[], quotes?: MarketLedgerItem['quotes'], at = Date.now()): FishingMarketState => ({
    ...state, ledger: [...state.ledger, { id: marketId('event'), at, text, participants: [...new Set(participants)], deliveredTo: [], quotes }],
});
export const expireMarketPosts = (state: FishingMarketState, now = Date.now()): FishingMarketState => ({
    ...state,
    listings: state.listings.map(p => p.status === 'open' && p.expiresAt <= now ? { ...p, status: 'expired', closedAt: p.expiresAt } : p),
    requests: state.requests.map(p => p.status === 'open' && p.expiresAt <= now ? { ...p, status: 'expired', closedAt: p.expiresAt } : p),
});
const pricesForDay = (seed: number, at: number) => {
    const rand = marketRandom(marketHash(seed + ':' + localDate(at) + ':market'));
    return Object.fromEntries(FISH_CATALOG.map(f => [f.id, Math.max(1, Math.round(f.basePrice * (.9 + rand() * .2)))]));
};
export const ensureMarketDay = (state: FishingMarketState, at = Date.now()): FishingMarketState => {
    const next = expireMarketPosts(state, at);
    if (state.economyVersion === SAR_ECONOMY_VERSION && state.priceDate === localDate(at)) return next;
    const yesterday = new Date(at); yesterday.setDate(yesterday.getDate() - 1);
    return { ...next, economyVersion: SAR_ECONOMY_VERSION, priceDate: localDate(at), prices: pricesForDay(state.seed, at), previousPrices: pricesForDay(state.seed, yesterday.getTime()) };
};
export const listMarketActors = (user: UserProfile, characters: CharacterProfile[]): MarketActor[] => [
    { id: 'user', name: user.name || '我', kind: 'user' },
    ...characters.map(c => ({ id: c.id, name: c.name, kind: 'character' as const })),
];
/** Ownership stays keyed by ID; collection labels follow the current profile after a rename. */
export const marketActorName = (actors: MarketActor[], actorId: string | undefined, savedName?: string): string =>
    actors.find(actor => actor.id === actorId)?.name || (actorId === 'user' ? '我' : savedName || '未记录姓名');
export const ensureActorAccounts = (state: FishingMarketState, actors: MarketActor[]): FishingMarketState => {
    const accounts = { ...state.accounts };
    for (const a of actors) {
        if (Object.prototype.hasOwnProperty.call(accounts, a.id)) {
            if (!Number.isSafeInteger(accounts[a.id]) || accounts[a.id] < 0) throw new Error('钱包数据异常，请先导出备份');
        } else Object.defineProperty(accounts, a.id, { value: a.kind === 'wanderer' ? SAR_WANDERER_BALANCE : SAR_STARTING_BALANCE, enumerable: true, configurable: true, writable: true });
    }
    return { ...state, accounts };
};
let writeChain: Promise<unknown> = Promise.resolve();
/** Fresh read-modify-write. Web Locks serialize other tabs too; model calls never hold this lock. */
export const mutateFishingMarket = (change: (state: FishingMarketState) => FishingMarketState, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): Promise<FishingMarketState> => {
    const run = async (): Promise<FishingMarketState> => {
        const perform = () => saveFishingMarketState(change(ensureMarketDay(readFishingMarketState(storage))), storage);
        // Return a promise from the lock callback even when validation throws synchronously.
        return typeof navigator !== 'undefined' && navigator.locks ? await navigator.locks.request('vr-fishing-market', async () => perform()) : perform();
    };
    const result = writeChain.then(run, run); writeChain = result.catch(() => {}); return result;
};
export const weatherFromDescription = (description: string): FishingWeatherKind => {
    const d = description.toLowerCase();
    if (/雷|storm|thunder/.test(d)) return 'storm';
    if (/雪|snow|sleet/.test(d)) return 'snow';
    if (/雨|rain|drizzle|shower/.test(d)) return 'rain';
    if (/雾|霾|fog|mist|haze/.test(d)) return 'fog';
    if (/云|阴|cloud|overcast/.test(d)) return 'cloudy';
    return 'clear';
};
export const simulatedFishingWeather = (seed: number, at = Date.now()): FishingWeather => {
    const r = marketRandom(marketHash(seed + ':' + localDate(at) + ':weather'))();
    const kind: FishingWeatherKind = r < .28 ? 'clear' : r < .52 ? 'cloudy' : r < .72 ? 'rain' : r < .8 ? 'storm' : r < .92 ? 'fog' : 'snow';
    return { kind, label: WEATHER_LABELS[kind], detail: '彼方今日天气', source: 'simulated' };
};
export const resolveFishingWeather = async (config: RealtimeConfig | undefined, seed: number): Promise<FishingWeather> => {
    if (config?.weatherEnabled) {
        try {
            const { RealtimeContextManager } = await import('../realtimeContext');
            const result = await RealtimeContextManager.fetchWeather(config);
            if (result?.description) {
                const kind = weatherFromDescription(result.description);
                return { kind, label: WEATHER_LABELS[kind], detail: (result.city || config.weatherCity || '当前位置') + ' · ' + result.description + ' · ' + Math.round(result.temp) + '°C', source: 'real' };
            }
        } catch { /* daily local fallback */ }
    }
    return { ...simulatedFishingWeather(seed), detail: config?.weatherEnabled ? '真实天气暂不可用 · 使用彼方今日天气' : '未开启天气感知 · 使用彼方今日天气' };
};
const rarityWeight: Record<FishingRarity, number> = { common: 52, uncommon: 26, rare: 12, epic: 5, relic: .62 };
export const rollFishingCatch = (owner: Pick<MarketActor, 'id' | 'name'>, weather: FishingWeather, random = Math.random, now = Date.now()): FishingCatch => {
    const entries = FISH_CATALOG.filter(f => f.id !== 'dinosaur-egg').map(f => ({ f, w: rarityWeight[f.rarity] * (f.weathers.includes(weather.kind) ? 3.3 : f.category === 'time-relic' ? .28 : .42) }));
    let cursor = Math.max(0, Math.min(.999999, random())) * entries.reduce((sum, e) => sum + e.w, 0);
    const f = entries.find(e => (cursor -= e.w) <= 0)?.f || entries[0].f; const q = random();
    return { id: marketId('catch'), speciesId: f.id, ownerId: owner.id, ownerName: owner.name, caughtAt: now, origin:{kind:'fished',actorId:owner.id,actorName:owner.name,at:now},
        weather: weather.kind, weatherLabel: weather.label, weatherSource: weather.source,
        sizeCm: Math.round((f.category === 'time-relic' ? 8 + random() * 14 : 18 + random() * 96) * 10) / 10, quality: q > .93 ? 3 : q > .65 ? 2 : 1 };
};
export const addCatchToState = (state: FishingMarketState, caught: FishingCatch): FishingMarketState => {
    if (state.inventory.some(c => c.id === caught.id) || state.ledger.some(e => e.id === 'caught_' + caught.id)) return state;
    const next = logMarketEvent({ ...state, inventory: [...state.inventory, caught], discovered: [...new Set([...state.discovered, caught.speciesId])] },
        caught.origin?.kind==='gift' ? caught.ownerName+'收到了'+(caught.origin.actorName||'朋友')+'送出的'+speciesById(caught.speciesId)?.name+'橡皮泥模型。' : caught.ownerName + '在彼方水域钓到' + speciesById(caught.speciesId)?.name + '（' + caught.sizeCm + ' cm，' + caught.quality + ' 星）；天气：' + caught.weatherLabel + '，' + (caught.weatherSource === 'real' ? '同步真实天气' : '游戏模拟天气') + '。', [caught.ownerId], undefined, caught.caughtAt);
    next.ledger[next.ledger.length - 1].id = 'caught_' + caught.id;
    return recordFishingAcquisition(next, { id: caught.ownerId, name: caught.ownerName }, caught.speciesId, 'caught_' + caught.id, caught.caughtAt);
};
export const catchValue = (state: FishingMarketState, c: FishingCatch) =>
    Math.max(1, Math.round((state.prices[c.speciesId] || speciesById(c.speciesId)?.basePrice || 1) * [0, 1, 1.15, 1.3][c.quality]));
export const availableCatches = (state: FishingMarketState, actorId: string, now = Date.now()) =>
    state.inventory.filter(c => c.ownerId === actorId && !c.incubatingUntil && !state.fishingTrips?.some(t => t.catch.id === c.id && t.status === 'pending') && !state.listings.some(l => l.catchId === c.id && l.status === 'open' && l.expiresAt > now));
/** Public specimen details omit its owner's identity and keep archives stable after later transfers. */
export const marketCatchSnapshot = (state: FishingMarketState, c: FishingCatch): MarketCatchSnapshot => ({
    id: c.id, speciesId: c.speciesId, sizeCm: c.sizeCm, quality: c.quality,
    ...(state.dinosaurGarden?.toys[c.id]?.name ? { nickname: state.dinosaurGarden.toys[c.id].name } : {}),
});
const requireCatch = (state: FishingMarketState, actor: MarketActor, id: string, now = Date.now()) => {
    const c = availableCatches(state, actor.id, now).find(c => c.id === id);
    if (!c) throw new Error('这件藏品不在手里、正在孵化，或已挂板'); return c;
};
const capacity = (state: FishingMarketState, actorId: string) => {
    if (state.listings.filter(p => p.status === 'open' && p.sellerId === actorId).length + state.requests.filter(p => p.status === 'open' && p.authorId === actorId).length >= 12)
        throw new Error('每人最多同时挂 12 张便笺，请先撤下或等待成交');
};
export const createListing = (state: FishingMarketState, seller: MarketActor, caught: FishingCatch | null, price: number, note = '', now = Date.now(), customLabel = '', alias = ''): FishingMarketState => {
    capacity(state, seller.id); money(price); if (caught) caught = requireCatch(state, seller, caught.id, now);
    const label = caught ? speciesById(caught.speciesId)!.name : txt(customLabel, 40); if (!label) throw new Error('写下要卖的东西');
    const p: MarketListing = { id: marketId('listing'), sellerId: seller.id, sellerName: seller.name, catchId: caught?.id, itemLabel: label,
        price, note: txt(note), alias: txt(alias, 24) || undefined, createdAt: now, expiresAt: now + MARKET_DAY_MS, status: 'open', comments: [],
        ...(caught ? { catchSnapshot: marketCatchSnapshot(state, caught) } : {}) };
    return logMarketEvent({ ...state, listings: [...state.listings, p] }, seller.name + '以 ' + price + ' 鳞币挂牌出售「' + label + '」' + (caught ? '' : '（玩笑商品，没有实体道具）') + '，24 小时有效。',
        [seller.id], note ? [{ name: p.alias || seller.name, content: p.note! }] : undefined, now);
};
const transfer = (state: FishingMarketState, from: string, to: string, amount: number) => {
    money(amount); if (from === to) throw new Error('不能和自己成交');
    if (!Number.isSafeInteger(state.accounts[from]) || !Number.isSafeInteger(state.accounts[to])) throw new Error('交易方钱包尚未接入');
    if (state.accounts[from] < amount) throw new Error('付款方余额不足');
    return { ...state.accounts, [from]: state.accounts[from] - amount, [to]: creditSARWallet(state.accounts[to], amount) };
};
export const buyListing = (state: FishingMarketState, id: string, buyer: MarketActor, now = Date.now()): FishingMarketState => {
    const p = state.listings.find(p => p.id === id && p.status === 'open' && p.expiresAt > now);
    if (!p) throw new Error('这张挂单已失效或已成交');
    if (p.catchId && !state.inventory.some(c => c.id === p.catchId && c.ownerId === p.sellerId)) throw new Error('卖家已没有这件东西');
    const accounts = transfer(state, buyer.id, p.sellerId, p.price);
    const acquired = p.catchId ? state.inventory.find(c => c.id === p.catchId) : undefined;
    state = acquired ? recordFishingAcquisition(state, buyer, acquired.speciesId, 'purchase_' + p.id, now) : state;
    return logMarketEvent({ ...state, accounts, inventory: state.inventory.map(c => c.id === p.catchId ? { ...c, ownerId: buyer.id, ownerName: buyer.name, displayed: false } : c),
        listings: state.listings.map(l => l.id === id ? { ...l, status: 'sold', buyerId: buyer.id, buyerName: buyer.name, closedAt: now } : l),
    }, buyer.name + '向' + (p.alias || p.sellerName) + '支付 ' + p.price + ' 鳞币，买下「' + p.itemLabel + '」' + (p.catchId ? '；道具已转移。' : '（玩笑商品，仅文字约定）。'),
    [buyer.id, p.sellerId], p.note ? [{ name: p.alias || p.sellerName, content: p.note }] : undefined, now);
};
export const createRequest = (state: FishingMarketState, actor: MarketActor, speciesId: string | undefined, itemLabel: string, offer: number, body: string, now = Date.now(), kind: MarketRequest['kind'] = speciesId ? 'item' : 'favor', alias = ''): FishingMarketState => {
    capacity(state, actor.id); money(offer);
    if (kind === 'item' && !speciesById(speciesId || '')) throw new Error('请选择有效物种');
    if (kind !== 'tip' && (state.accounts[actor.id] || 0) < offer) throw new Error('出价超过当前余额');
    if (kind === 'tip' && offer === 0) throw new Error('求打赏请填写大于 0 的金额');
    if (!txt(itemLabel)) throw new Error('写下你想要什么');
    const p: MarketRequest = { id: marketId('request'), authorId: actor.id, authorName: actor.name, kind,
        speciesId: kind === 'item' ? speciesId : undefined, itemLabel: txt(itemLabel, 40), offer, body: txt(body),
        alias: txt(alias, 24) || undefined, createdAt: now, expiresAt: now + MARKET_DAY_MS, status: 'open', comments: [] };
    return logMarketEvent({ ...state, requests: [...state.requests, p] }, actor.name + '发布「' + p.itemLabel + '」：' + (kind === 'tip' ? '求打赏' : '出价') + ' ' + offer + ' 鳞币。仅为请求，尚未成交。',
        [actor.id], p.body ? [{ name: p.alias || actor.name, content: p.body }] : undefined, now);
};
export const commentOnPost = (state: FishingMarketState, id: string, actor: MarketActor, content: string, alias = '', now = Date.now()): FishingMarketState => {
    const p = [...state.listings, ...state.requests].find(p => p.id === id && p.status === 'open' && p.expiresAt > now);
    if (!p) throw new Error('这张便笺已经封存'); if (!txt(content)) throw new Error('先写一句话');
    if (p.comments.length >= 40) throw new Error('便笺上的 40 条回复写满了');
    const isOwner = ('sellerId' in p ? p.sellerId : p.authorId) === actor.id;
    const c: MarketComment = { id: marketId('comment'), authorId: actor.id, authorName: actor.name,
        alias: txt(alias, 24) || (isOwner ? p.alias : undefined), content: txt(content), createdAt: now };
    const update = <T extends MarketPostBase>(p: T): T => p.id === id ? { ...p, comments: [...p.comments, c] } : p;
    return logMarketEvent({ ...state, listings: state.listings.map(update), requests: state.requests.map(update) },
        (c.alias || actor.name) + '在「' + p.itemLabel + '」下回复了。仅为发言，没有发生交易。',
        [actor.id, 'sellerId' in p ? p.sellerId : p.authorId], [{ name: c.alias || actor.name, content: c.content }], now);
};
export const fulfillRequest = (state: FishingMarketState, id: string, actor: MarketActor, submission = '', now = Date.now(), catchId = ''): FishingMarketState => {
    const p = state.requests.find(p => p.id === id && p.status === 'open' && p.expiresAt > now);
    if (!p) throw new Error('需求已失效或已完成'); if (p.authorId === actor.id) throw new Error('不能响应自己的需求');
    const eligible = p.kind === 'item' ? availableCatches(state, actor.id, now).filter(c => c.speciesId === p.speciesId) : [];
    if (p.kind === 'item' && !catchId && eligible.length > 1) throw new Error('请先选择要交付的那件藏品');
    const c = catchId ? eligible.find(c => c.id === catchId) : eligible[0];
    if (p.kind === 'item' && catchId && !c) throw new Error('选中的藏品已不可交付，请重新选择；没有用其他藏品替代');
    if (p.kind === 'item' && !c) throw new Error('手里没有对方要的东西');
    if (p.kind === 'favor' && !txt(submission)) throw new Error('写下你交付的内容');
    const accounts = p.kind === 'tip' ? transfer(state, actor.id, p.authorId, p.offer) : transfer(state, p.authorId, actor.id, p.offer);
    if (c) state = recordFishingAcquisition(state, { id: p.authorId, name: p.authorName }, c.speciesId, 'fulfillment_' + p.id, now);
    return logMarketEvent({ ...state, accounts, inventory: state.inventory.map(item => item.id === c?.id ? { ...item, ownerId: p.authorId, ownerName: p.authorName, displayed: false } : item),
        requests: state.requests.map(item => item.id === id ? { ...item, status: 'fulfilled', fulfillerId: actor.id, fulfillerName: actor.name, submission: txt(submission), closedAt: now,
            ...(c ? { fulfilledCatch: marketCatchSnapshot(state, c) } : {}) } : item),
    }, p.kind === 'tip' ? actor.name + '真的给' + (p.alias || p.authorName) + '打赏了 ' + p.offer + ' 鳞币。'
        : actor.name + '完成' + (p.alias || p.authorName) + '的「' + p.itemLabel + '」需求，收到 ' + p.offer + ' 鳞币。' + (c ? '藏品已交付。' : '仅交付文字约定，不创建实体道具。'),
    [actor.id, p.authorId], [...(p.body ? [{ name: p.alias || p.authorName, content: p.body }] : []), ...(txt(submission) ? [{ name: actor.name, content: txt(submission) }] : [])], now);
};
export const removeMarketPost = (state: FishingMarketState, id: string, actorId: string, now = Date.now()): FishingMarketState => {
    const p = [...state.listings, ...state.requests].find(p => p.id === id && p.status === 'open');
    if (!p || ('sellerId' in p ? p.sellerId : p.authorId) !== actorId) throw new Error('只能撤下自己的便笺');
    const close = <T extends MarketPostBase>(p: T): T => p.id === id ? { ...p, status: 'removed', closedAt: now } : p;
    return logMarketEvent({ ...state, listings: state.listings.map(close), requests: state.requests.map(close) }, '「' + p.itemLabel + '」已撤下，原文保存在发帖方本地档案。', [actorId], undefined, now);
};
export const handleCollection = (state: FishingMarketState, actor: MarketActor, id: string, action: 'sell' | 'release' | 'display' | 'study' | 'incubate', now = Date.now()): FishingMarketState => {
    const c = requireCatch(state, actor, id, now); const f = speciesById(c.speciesId)!;
    if (action === 'release' && f.category !== 'fish') throw new Error('橡皮泥模型不能放生，可以收藏、赠送或交易');
    if (action === 'sell' || action === 'release') {
        const value = action === 'sell' ? catchValue(state, c) : 0;
        const remaining = remainingSARBuyback(state.buybackBudgets, actor.id, now);
        if (value > remaining) throw new Error(`今日回收额度还剩 ${remaining} 鳞币，这件藏品需要 ${value}；可以留到明天或挂板转让`);
        const balance = creditSARWallet(state.accounts[actor.id] ?? 0, value);
        const buybackBudgets = value ? { ...state.buybackBudgets, [actor.id]: { day: state.buybackBudgets?.[actor.id]?.day && state.buybackBudgets[actor.id].day > sarEconomyDay(now) ? state.buybackBudgets[actor.id].day : sarEconomyDay(now), earned: SAR_DAILY_BUYBACK - remaining + value } } : state.buybackBudgets;
        return logMarketEvent({ ...state, buybackBudgets, inventory: state.inventory.filter(item => item.id !== id),
            accounts: { ...state.accounts, [actor.id]: balance } },
        actor.name + (action === 'sell' ? '按今日鱼价卖出' : '放生') + f.name + (action === 'sell' ? '，获得 ' + value + ' 鳞币' : '') + '。图鉴发现记录保留。', [actor.id], undefined, now);
    }
    if (action === 'study') {
        if (f.category !== 'time-relic' || c.studied) throw new Error('这件藏品无需重复研究');
        return logMarketEvent({ ...state, inventory: state.inventory.map(item => item.id === id ? { ...item, studied: true } : item),
            research: { ...state.research, [actor.id]: (state.research[actor.id] || 0) + 1 } },
        actor.name + '为' + f.name + '制作橡皮泥模型观察记录，研究进度 +1；藏品仍保留，可陈列或交易。', [actor.id], undefined, now);
    }
    if (action === 'incubate' && c.speciesId !== 'dinosaur-egg') throw new Error('只有恐龙蛋可以孵化');
    return logMarketEvent({ ...state, inventory: state.inventory.map(item => item.id === id ? action === 'display' ? { ...item, displayed: !item.displayed } : { ...item, incubatingUntil: now + 6 * 3_600_000 } : item) },
        actor.name + (action === 'display' ? c.displayed ? '收起了' : '陈列了' : '开始孵化') + f.name + (action === 'incubate' ? '，六小时后可揭晓' : '') + '。', [actor.id], undefined, now);
};
export const hatchEgg = (state: FishingMarketState, actor: MarketActor, id: string, now = Date.now()): FishingMarketState => {
    const egg = state.inventory.find(c => c.id === id && c.ownerId === actor.id);
    if (!egg?.incubatingUntil || egg.speciesId !== 'dinosaur-egg' || egg.incubatingUntil > now) throw new Error('蛋还没有孵化完成');
    const species = FISH_CATALOG.filter(f => f.category === 'time-relic' && !['dinosaur-egg', 'dinosaur-fossil'].includes(f.id));
    const f = species[marketHash(id) % species.length];
    state = recordFishingAcquisition(state, actor, f.id, 'hatch_' + id, now);
    return logMarketEvent({ ...state, inventory: state.inventory.map(c => c.id === id ? { ...c, speciesId: f.id, incubatingUntil: undefined, studied: false, displayed: false } : c),
        discovered: [...new Set([...state.discovered, f.id])] }, actor.name + '的恐龙蛋孵出了' + f.name + '，可陈列、观察或交易。', [actor.id], undefined, now);
};
export function sellFishToAiven(state: FishingMarketState, actor: MarketActor, catchId: string, at = Date.now(), words = ''): { state: FishingMarketState; sale: AivenFishSale } {
    const current = ensureMarketDay(state, at);
    const caught = requireCatch(current, actor, catchId, at);
    if (speciesById(caught.speciesId)?.category !== 'fish') throw new Error('艾文这里只收鱼，橡皮泥恐龙可以收藏或挂板转让');
    const sale = { amount: catchValue(current, caught), at, replyIndex: marketHash(`${catchId}:${at}`) % AIVEN_FISH_SALE_REPLIES.length };
    const next = handleCollection(current, actor, catchId, 'sell', at);
    const reply = AIVEN_FISH_SALE_REPLIES[sale.replyIndex];
    const receipt = next.ledger[next.ledger.length - 1];
    receipt.id = 'aiven_fish_sale_' + catchId;
    receipt.text = `${actor.name}把${speciesById(caught.speciesId)!.name}${sarNpcContentEnabled() ? '卖给艾文' : '交给回收站'}，按当日行情与品质结算，获得 ${sale.amount} 鳞币。图鉴记录保留。`;
    receipt.quotes = sarNpcContentEnabled() ? [...(words.trim() ? [{ name: actor.name, content: words.trim().slice(0, 600) }] : []), { name: '艾文', content: reply.text }] : [];
    receipt.aivenSale = sale;
    return { state: next, sale };
}
/** Acquisition history is independent of current ownership and the shared species checklist. */
export function recordFishingAcquisition(state: FishingMarketState, actor: Pick<MarketActor, 'id' | 'name'>, speciesId: string, acquisitionId: string, at: number, legacy = false): FishingMarketState {
    const entries = state.collectionEntries || [];
    const old = entries.find(e => e.actorId === actor.id && e.speciesId === speciesId);
    if (old?.acquisitionIds.includes(acquisitionId)) return state;
    const entry: FishingCollectionEntry = old ? { ...old, actorName: actor.name, firstObtainedAt: Math.min(old.firstObtainedAt, at), acquisitionIds: [...old.acquisitionIds, acquisitionId] } : {
        actorId: actor.id, actorName: actor.name, speciesId, firstObtainedAt: at, acquisitionIds: [acquisitionId],
        ...(legacy ? { historicalIncomplete: true } : actor.id !== 'user' && !actor.id.startsWith('wanderer:') ? { announcement: { id: marketId('discovery'), published: false } } : {}),
    };
    return { ...state, discovered: [...new Set([...state.discovered, speciesId])], collectionEntries: old ? entries.map(e => e === old ? entry : e) : [...entries, entry] };
}
export function migrateFishingCollection(state: FishingMarketState): FishingMarketState {
    if (state.collectionEntries !== undefined) return state;
    let next: FishingMarketState = { ...state, collectionEntries: [], fishingTrips: state.fishingTrips || [] };
    const evidenced = new Set<string>();
    for (const event of state.ledger) {
        if (!event.id.startsWith('caught_') || !event.participants[0]) continue;
        const species = FISH_CATALOG.find(f => event.text.includes('在彼方水域钓到' + f.name + '（') || event.text.includes('送出的' + f.name + '橡皮泥模型。'));
        if (!species) continue;
        const ownerId = event.participants[0];
        const ownerName = event.text.split(/在彼方水域钓到|收到了/)[0];
        next = recordFishingAcquisition(next, { id: ownerId, name: ownerName }, species.id, event.id, event.at, true);
        evidenced.add(ownerId + ':' + event.id.slice(7) + ':' + species.id);
    }
    for (const item of state.inventory) {
        if (evidenced.has(item.ownerId + ':' + item.id + ':' + item.speciesId)) continue;
        // A transferred old item has no trustworthy acquisition date: its catch date is not the buyer's date.
        const originalOwner = item.origin?.kind === 'fished' && item.origin.actorId === item.ownerId;
        if (!speciesById(item.speciesId)) continue;
        next = recordFishingAcquisition(next, { id: item.ownerId, name: item.ownerName }, item.speciesId, 'legacy_' + item.id, originalOwner ? item.caughtAt : 0, true);
    }
    return next;
}
export const personalFishingCollection = (state: FishingMarketState, actorId: string) =>
    (state.collectionEntries || []).filter(e => e.actorId === actorId);
export const pendingFishingTrip = (state: FishingMarketState, actorId: string) =>
    state.fishingTrips?.find(t => t.catch.ownerId === actorId && t.status === 'pending');
export function beginFishingTrip(state: FishingMarketState, actor: MarketActor, weather: FishingWeather, random = Math.random): FishingMarketState {
    if (pendingFishingTrip(state, actor.id)) return state;
    const caught = rollFishingCatch(actor, weather, random);
    const next = addCatchToState(state, caught);
    return { ...next, fishingTrips: [...(next.fishingTrips || []), { catch: caught, status: 'pending' }] };
}
export function settleFishingTrip(state: FishingMarketState, actor: MarketActor, catchId: string, result: FishingReaction, at = Date.now()): FishingMarketState {
    const trip = state.fishingTrips?.find(t => t.catch.id === catchId && t.catch.ownerId === actor.id);
    if (!trip) throw new Error('这不是该角色正在处理的鱼获');
    if (trip.status === 'settled') return state;
    if (result.disposition === 'release' && speciesById(trip.catch.speciesId)?.category !== 'fish') throw new Error('橡皮泥模型不能放生');
    if (!['keep', 'release', 'sell'].includes(result.disposition)) throw new Error('没有识别这次鱼获的去向');
    if (!state.inventory.some(c => c.id === catchId && c.ownerId === actor.id)) throw new Error('本次鱼获已不在收藏中');
    const next = { ...state, fishingTrips: state.fishingTrips!.map(t => t === trip ? { ...t, status: 'settled' as const, result, settledAt: at } : t) };
    let settled = result.disposition === 'release' ? handleCollection(next, actor, catchId, 'release', at) : next;
    if (result.disposition === 'sell') {
        const sold = sellFishToAiven(next, actor, catchId, at, result.saleWords);
        settled = { ...sold.state, fishingTrips: sold.state.fishingTrips!.map(t => t.catch.id === catchId ? { ...t, sale: sold.sale } : t) };
    }
    if (result.disposition === 'release') settled.ledger[settled.ledger.length - 1].id = 'fishing_release_' + catchId;
    const recorded = logMarketEvent(settled, actor.name + '完成这一竿：' + speciesById(trip.catch.speciesId)!.name + (result.disposition === 'release' ? '已放生' : result.disposition === 'sell' ? '已卖给艾文' : '已保留在自己的收藏柜') + '。' + (result.shareToUser ? '分享原话等待发送。' : '没有选择私聊分享。'), [actor.id], [{ name: actor.name, content: result.reaction }], at);
    recorded.ledger[recorded.ledger.length - 1].id = 'fishing_result_' + catchId;
    return recorded;
}
