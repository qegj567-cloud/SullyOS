import { speciesById, type FishingMarketState } from './fishingMarket';
import { getSARModuleById as getChip } from './sarGacha';
import { getSARModuleById as getModule } from './sarModuleShop';
import { HALLOWEEN_CANDIES } from './kanataHalloween';

export type SARWarehouseItem = { id: string; title: string; kind: 'chip' | 'module' | 'catch' | 'souvenir' | 'coupon' | 'candy'; count: number; detail: string; status: string; speciesId?: string; halloweenHat?: boolean };
/** Current ownership is authoritative; acquisition origin never grants duplicate ownership. */
export const sarWarehouseItems = (state: FishingMarketState, actorId: string, now = Date.now()): SARWarehouseItem[] => {
    const items: SARWarehouseItem[] = [];
    if (actorId === 'user') for (const [id, count] of Object.entries(state.sarCommerce?.gacha.collection || {})) {
        const chip = getChip(id);
        if (chip && count > 0) items.push({ id, title: chip.title, kind: 'chip', count, detail: chip.summary, status: chip.pool === 'story' ? '故事芯片' : '变体芯片' });
    }
    for (const [id, count] of Object.entries(actorId === 'user' ? state.sarCommerce?.moduleShop.inventory || {} : state.sarCharacterModules?.[actorId] || {})) {
        const module = getModule(id);
        if (module && count > 0) items.push({ id, title: module.title, kind: 'module', count, detail: module.description, status: '待装载' });
    }
    for (const caught of state.inventory.filter(c => c.ownerId === actorId)) {
        const species = speciesById(caught.speciesId);
        if (!species) continue;
        const toy = state.dinosaurGarden?.toys[caught.id];
        const listed = state.listings.some(p => p.catchId === caught.id && p.status === 'open' && p.expiresAt > now);
        items.push({ id: caught.id, title: toy?.name || species.name, kind: 'catch', count: 1, speciesId: caught.speciesId, halloweenHat: caught.halloweenHat,
            detail: `${species.blurb} ${caught.sizeCm} cm · ${'✦'.repeat(caught.quality)}`,
            status: listed ? '挂板中' : caught.incubatingUntil ? caught.incubatingUntil > now ? '孵化中' : '等待揭晓' : caught.displayed ? '陈列中' : toy?.mapId ? '箱庭中' : species.category === 'fish' ? '鱼获' : '橡皮泥模型' });
    }
    if(actorId==='user') {
        for (const candy of HALLOWEEN_CANDIES) { const count = state.kanataHalloween?.candies[candy.id] || 0; if (count) items.push({ id:candy.id,title:candy.name,kind:'candy',count,detail:candy.description,status:'万圣节糖果' }); }
        for(const s of state.sarFamiliarity?.souvenirs||[]) items.push({id:s.id,title:s.title,kind:'souvenir',count:1,detail:s.description,status:'SAR 纪念物'});
        const coupons=state.sarFamiliarity?.coupons.filter(c=>!c.usedBy)||[];
        for(const percent of new Set(coupons.map(c=>c.percent))) items.push({id:`sar-coupon-${percent}`,title:`模块商店${(100-percent)/10}折券`,kind:'coupon',count:coupons.filter(c=>c.percent===percent).length,detail:'购买模块时自动使用最佳单项优惠，不与限时折扣叠加。',status:'待使用'});
    }
    return items;
};
