import { addCatchToState, type FishingMarketState } from './fishingMarket';
import { isKanataHalloween } from './halloweenCalendar';
import { getLocalDateKey } from '../localDate';

export const HALLOWEEN_COSTUMES = [
    { id: 'black-cat', name: '黑猫铃铛', file: 'black-cat.png', clip: 'ellipse(29% 28% at 50% 53%)' },
    { id: 'little-devil', name: '小恶魔', file: 'little-devil.png' },
    { id: 'ghost-friend', name: '幽灵朋友', file: 'ghost-friend.png' },
    { id: 'skull-bow', name: '骷髅蝴蝶结', file: 'skull-bow.png' },
    { id: 'ghost-cloak', name: '幽灵罩衫', file: 'ghost-cloak.png', clip: 'ellipse(20% 20% at 50% 52%)' },
] as const;
export const HALLOWEEN_CANDIES = [
    { id: 'pumpkin-caramel', name: '南瓜焦糖', color: '#ed9849', description: '橙色糖纸里藏着一颗暖乎乎的焦糖。' },
    { id: 'ghost-milk', name: '幽灵奶糖', color: '#eee8dc', description: '小幽灵把自己裹成了一颗软软的奶糖。' },
    { id: 'bat-grape', name: '蝙蝠葡萄糖', color: '#a78bca', description: '深紫色的葡萄糖，糖纸像张开的小翅膀。' },
    { id: 'cat-sesame', name: '黑猫芝麻糖', color: '#62616e', description: '一颗黑芝麻糖，包装上印着偷偷笑的猫。' },
    { id: 'witch-apple', name: '魔女苹果糖', color: '#b9cc82', description: '酸酸甜甜的青苹果味，没有施加奇怪的魔法。' },
    { id: 'moon-strawberry', name: '月亮草莓糖', color: '#e99baf', description: '在万圣夜收到的草莓糖，留着慢慢吃。' },
] as const;
export type HalloweenNpc = 'caian' | 'aiven';
export interface KanataHalloweenState {
    version: 1; disabled: boolean; costumes: Record<string, string | null>;
    collectedCostumes: string[]; candies: Record<string, number>; completed: HalloweenNpc[];
}
export const freshHalloween = (): KanataHalloweenState => ({ version: 1, disabled: false, costumes: {}, collectedCostumes: [], candies: {}, completed: [] });
export function validateHalloween(value: KanataHalloweenState) {
    const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    if (!value || value.version !== 1 || typeof value.disabled !== 'boolean' || !record(value.costumes) || !record(value.candies)
        || Object.values(value.costumes).some(id => id !== null && !HALLOWEEN_COSTUMES.some(c => c.id === id))
        || Object.entries(value.candies).some(([id, n]) => !HALLOWEEN_CANDIES.some(c => c.id === id) || !Number.isSafeInteger(n) || (n as number) < 0)
        || !Array.isArray(value.collectedCostumes) || value.collectedCostumes.some(id => !HALLOWEEN_COSTUMES.some(c => c.id === id))
        || !Array.isArray(value.completed) || value.completed.some(id => id !== 'caian' && id !== 'aiven')) throw new Error('万圣节收藏无法读取，请先备份；没有覆盖原存档');
}
export function halloweenActive(state: FishingMarketState, at = Date.now()) {
    return isKanataHalloween(getLocalDateKey(new Date(at))) && !state.kanataHalloween?.disabled;
}
const pick = <T,>(items: readonly T[], random: () => number) => items[Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)))];
export function assignHalloweenCostume(state: FishingMarketState, actorId: string, mode: 'initial' | 'change' | 'remove', at = Date.now(), random = Math.random): FishingMarketState {
    if (!halloweenActive(state, at)) return state;
    const event = state.kanataHalloween || freshHalloween();
    if (mode === 'initial' && Object.hasOwn(event.costumes, actorId)) return state;
    const previous = event.costumes[actorId];
    const costume = mode === 'remove' ? null : pick(HALLOWEEN_COSTUMES.filter(c => c.id !== previous), random).id;
    return { ...state, kanataHalloween: { ...event, costumes: { ...event.costumes, [actorId]: costume },
        collectedCostumes: costume ? [...new Set([...event.collectedCostumes, costume])] : event.collectedCostumes } };
}
export function giveHalloweenCandy(state: FishingMarketState, at = Date.now(), random = Math.random): { state: FishingMarketState; candyId: string } {
    if (!halloweenActive(state, at)) throw new Error('万圣节活动已经结束或撤下了。');
    const event = state.kanataHalloween || freshHalloween(), candyId = pick(HALLOWEEN_CANDIES, random).id;
    const count = (event.candies[candyId] || 0) + 1;
    if (!Number.isSafeInteger(count)) throw new Error('糖果袋已经装满了。');
    return { state: { ...state, kanataHalloween: { ...event, candies: { ...event.candies, [candyId]: count } } }, candyId };
}
export function finishHalloweenDialogue(state: FishingMarketState, npc: HalloweenNpc, userName: string, withdraw = false, at = Date.now(), random = Math.random): FishingMarketState {
    if (!halloweenActive(state, at)) return state;
    const event = state.kanataHalloween || freshHalloween();
    if (withdraw) return { ...state, kanataHalloween: { ...event, disabled: true, costumes: {}, completed: [...new Set([...event.completed, npc])] } };
    if (event.completed.includes(npc)) return state;
    let next = npc === 'caian' ? giveHalloweenCandy(state, at, random).state : state;
    if (npc === 'aiven') next = addCatchToState(next, {
        id: 'kanata-halloween-2026-pumpkin-dino', speciesId: 'halloween-dinosaur', ownerId: 'user', ownerName: userName,
        caughtAt: at, origin: { kind: 'gift', actorId: 'aiven', actorName: '艾文', at },
        weather: 'clear', weatherLabel: '万圣夜的礼物', weatherSource: 'simulated', sizeCm: 12, quality: 3,
    });
    return { ...next, kanataHalloween: { ...(next.kanataHalloween || event), completed: [...event.completed, npc] } };
}
