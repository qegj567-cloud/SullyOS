import { FISH_CATALOG, STORY_CATCH_CATALOG, migrateFishingCollection, WEATHER_LABELS, type FishingMarketState } from './fishingMarket';
import { SAR_ALL_MODULES } from './sarGacha';
import { SAR_MODULE_CATALOG } from './sarModuleShop';
import { rememberSARCollections } from './sarCollectionJournal';
import { HALLOWEEN_CANDIES, HALLOWEEN_COSTUMES } from './kanataHalloween';

export type SARCollectionCategory = 'fish' | 'dinosaur' | 'chip' | 'module' | 'halloween';
export type SARCollectionEntry = {
    id: string; category: SARCollectionCategory; title: string; description: string; tag: string;
    collected: boolean; owned: number; source: string; speciesId?: string; halloweenHat?: boolean;
};
export const SAR_COLLECTION_CATEGORIES = [
    { id: 'fish', title: '鱼类', description: '水面之下的相遇' },
    { id: 'dinosaur', title: '恐龙', description: '橡皮泥模型与惊喜蛋' },
    { id: 'chip', title: '芯片', description: '变体与故事的可能性' },
    { id: 'module', title: '模块', description: '收集不同的表达方式' },
    { id: 'halloween', title: '万圣节', description: '装扮、糖果与万圣夜的回忆' },
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
        speciesId: species.id, halloweenHat: state.inventory.some(c => c.ownerId === actorId && c.speciesId === species.id && c.halloweenHat), tag: rarityNames[species.rarity], collected: fishRecords.has(species.id) || ownedFish.has(species.id), owned: ownedFish.get(species.id) || 0,
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
    const holidayDino = entries.find(e => e.id === 'halloween-dinosaur');
    if (holidayDino) holidayDino.source = '2026 万圣节 · 完整读完艾文的特殊对话，收到一只万圣小恐龙。';
    if (actorId === 'user') {
        const event = state.kanataHalloween;
        for (const c of HALLOWEEN_CANDIES) entries.push({ id: c.id, category: 'halloween', title: c.name, description: c.description, tag: '糖果', collected: !!event?.candies[c.id], owned: event?.candies[c.id] || 0, source: '万圣节期间点击彼方小人，选择「不给糖就捣蛋！！」。' });
        for (const c of HALLOWEEN_COSTUMES) entries.push({ id: c.id, category: 'halloween', title: c.name, description: '今年万圣夜穿过的小装扮。脱下后，这份回忆也会留下。', tag: '装扮', collected: !!event?.collectedCostumes.includes(c.id), owned: event?.collectedCostumes.includes(c.id) ? 1 : 0, source: '角色进入彼方随机穿上；点击角色也可以随机更换一件不同的装扮。' });
        if (npcEnabled) for (const npc of ['caian', 'aiven'] as const) entries.push({ id: `halloween-memory-${npc}`, category: 'halloween', title: npc === 'caian' ? '凯恩 · 万圣夜快乐' : '艾文 · 幽灵不会说话', description: npc === 'caian' ? '可爱的衣服、南瓜灯，还有一份重要成员的意见。' : '真正的管理员没有档期，但礼物已经准备好了。', tag: '特殊对话', collected: !!event?.completed.includes(npc), owned: event?.completed.includes(npc) ? 1 : 0, source: '完整读完万圣节特殊对话后收录，可以重看，不重复发放礼物。' });
    }
    return npcEnabled ? entries : entries.filter(entry => !['aiven-chimera', 'dinosaur-egg', 'halloween-dinosaur'].includes(entry.id)).map(entry => ({
        ...entry, description: entry.description.replace('艾文捏的小霸王龙', '橡皮泥小霸王龙').replace('——艾文坚持这么说。', '。'),
    }));
};
export const sarCollectionProgress = (entries: SARCollectionEntry[]) => SAR_COLLECTION_CATEGORIES.map(category => {
    const items = entries.filter(entry => entry.category === category.id);
    return { ...category, collected: items.filter(entry => entry.collected).length, total: items.length };
});
