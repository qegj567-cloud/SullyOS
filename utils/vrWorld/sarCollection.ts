import { FISH_CATALOG, STORY_CATCH_CATALOG, migrateFishingCollection, WEATHER_LABELS, type FishingMarketState } from './fishingMarket';
import { SAR_ALL_MODULES } from './sarGacha';
import { SAR_MODULE_CATALOG } from './sarModuleShop';
import { rememberSARCollections } from './sarCollectionJournal';

export type SARCollectionCategory = 'fish' | 'dinosaur' | 'chip' | 'module';
export type SARCollectionEntry = {
    id: string; category: SARCollectionCategory; title: string; description: string; tag: string;
    collected: boolean; owned: number; source: string; speciesId?: string;
};
export const SAR_COLLECTION_CATEGORIES = [
    { id: 'fish', title: '鱼类', description: '水面之下的相遇' },
    { id: 'dinosaur', title: '恐龙', description: '橡皮泥模型与惊喜蛋' },
    { id: 'chip', title: '芯片', description: '变体与故事的可能性' },
    { id: 'module', title: '模块', description: '收集不同的表达方式' },
] as const;

/** Distinct historical collection and current quantity deliberately remain separate. */
export const sarCollectionEntries = (input: FishingMarketState, actorId: string, npcEnabled = true): SARCollectionEntry[] => {
    const state = rememberSARCollections(migrateFishingCollection(input));
    const journal = state.sarCollection?.actors[actorId];
    const fishRecords = new Set((state.collectionEntries || []).filter(entry => entry.actorId === actorId).map(entry => entry.speciesId));
    const ownedFish = new Map<string, number>();
    for (const item of state.inventory.filter(item => item.ownerId === actorId)) ownedFish.set(item.speciesId, (ownedFish.get(item.speciesId) || 0) + 1);
    const rarityNames = { common: '常见', uncommon: '少见', rare: '稀有', epic: '珍稀', relic: '橡皮泥收藏' };
    const entries: SARCollectionEntry[] = [...FISH_CATALOG, ...STORY_CATCH_CATALOG].filter(s=>s.id!=='dinosaur-egg'||state.sarFamiliarity?.unlocks.includes('eggs')||fishRecords.has(s.id)||ownedFish.has(s.id)).map(species => ({
        id: species.id, category: species.category === 'fish' ? 'fish' : 'dinosaur', title: species.name, description: species.id === 'aiven-chimera' && !fishRecords.has(species.id) && !ownedFish.has(species.id)
            ? '形状有点奇怪。还不知道它究竟是什么。' : species.blurb,
        speciesId: species.id, tag: rarityNames[species.rarity], collected: fishRecords.has(species.id) || ownedFish.has(species.id), owned: ownedFish.get(species.id) || 0,
        source: species.id==='aiven-chimera'?(fishRecords.has(species.id)||ownedFish.has(species.id)?'艾文的三星回忆 · 只此一只。':'和艾文相处下去，也许会收到一份特别的礼物。'):species.id==='dinosaur-egg'?'艾文的三星话题赠送。':`彼方水域 · ${species.weathers.map(kind => WEATHER_LABELS[kind]).join('、')}时更常出现。也可通过实物交易或赠送获得。`,
    }));
    for (const chip of SAR_ALL_MODULES) {
        const owned = actorId === 'user' ? state.sarCommerce?.gacha.collection[chip.id] || 0 : 0;
        entries.push({ id: chip.id, category: 'chip', title: chip.title, description: chip.summary,
            tag: chip.pool === 'story' ? '故事芯片' : '变体芯片', collected: !!journal?.chips.includes(chip.id) || owned > 0, owned,
            source: actorId === 'user' ? `扭蛋机 · ${chip.pool === 'story' ? '异界坐标' : '人格异格'}卡池。` : '角色短篇演绎使用临时芯片，不计入永久收集。',
        });
    }
    const moduleTags = { voice: '语气', bond: '关系', genre: '风格', stage: '场景' };
    for (const module of SAR_MODULE_CATALOG) {
        const owned = actorId === 'user' ? state.sarCommerce?.moduleShop.inventory[module.id] || 0 : state.sarCharacterModules?.[actorId]?.[module.id] || 0;
        entries.push({ id: module.id, category: 'module', title: module.title, description: module.description,
            tag: moduleTags[module.category], collected: !!journal?.modules.includes(module.id) || owned > 0, owned,
            source: actorId === 'user' ? '模块商店 · 留意每日货架。买下后收录，装载用掉也会保留记录。' : '角色自己购买的模块会收录。被别人装载的效果不等于拥有这枚模块。',
        });
    }
    return npcEnabled ? entries : entries.filter(entry => !['aiven-chimera', 'dinosaur-egg'].includes(entry.id)).map(entry => ({
        ...entry, description: entry.description.replace('艾文捏的小霸王龙', '橡皮泥小霸王龙').replace('——艾文坚持这么说。', '。'),
    }));
};
export const sarCollectionProgress = (entries: SARCollectionEntry[]) => SAR_COLLECTION_CATEGORIES.map(category => {
    const items = entries.filter(entry => entry.category === category.id);
    return { ...category, collected: items.filter(entry => entry.collected).length, total: items.length };
});
