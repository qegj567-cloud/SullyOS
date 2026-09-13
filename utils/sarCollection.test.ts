import { describe, expect, it } from 'vitest';
import * as M from './vrWorld/fishingMarket';
import { sarCollectionEntries, sarCollectionProgress } from './vrWorld/sarCollection';
import { rememberSARCollections } from './vrWorld/sarCollectionJournal';
import { createSARModuleShopState, SAR_MODULE_CATALOG } from './vrWorld/sarModuleShop';
import { consumeOwnedSARModule, drawSARModuleWithPayment, readSARCommerce } from './vrWorld/sarCommerce';
import { acquireCharacterModule, consumeCharacterModule } from './vrWorld/sarCharacterCommerce';
import { collectSARLocalBackup, restoreSARLocalBackup } from './vrWorld/sarBackup';
import { SAR_ALL_MODULES } from './vrWorld/sarGacha';
import { freshFamiliarity } from './vrWorld/sarFamiliarity/storageTypes';
const id = SAR_MODULE_CATALOG[0].id, other = SAR_MODULE_CATALOG[1].id;
const actor = { id: 'aran', name: '阿岚', kind: 'character' as const };
const init = () => ({ ...M.createFishingMarketState(42), sarCommerce: { moduleShop: createSARModuleShopState(), gacha: { version: 1 as const, collection: {}, history: [], freeDrawDate: {} } } });
const storageFor = (s: M.FishingMarketState) => { const values = new Map([[M.FISHING_MARKET_STORAGE_KEY, JSON.stringify(s)]]); return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k,v); }, removeItem: (k: string) => { values.delete(k); } }; };
const entry = (s: M.FishingMarketState, who: string, itemId = id) => sarCollectionEntries(s, who).find(e => e.id === itemId)!;
describe('SAR personal collection atlas', () => {
    it('uses the actual catalogs and counts distinct kinds, not duplicate units', () => {
        const s = init(); s.sarCommerce.gacha.collection = { 'story-01': 6, 'variant-01': 4, unknown: 90 }; s.sarCommerce.moduleShop.inventory = { [id]: 12, unknown: 8 };
        const p = sarCollectionProgress(sarCollectionEntries(s, 'user'));
        const availableDinos=[...M.FISH_CATALOG,...M.STORY_CATCH_CATALOG].filter(f=>f.category==='time-relic'&&f.id!=='dinosaur-egg').map(f=>f.id);
        expect(sarCollectionEntries(s,'user').filter(e=>e.category==='dinosaur').map(e=>e.id)).toEqual(availableDinos);
        expect(p.map(x => x.total)).toEqual([M.FISH_CATALOG.filter(f => f.category === 'fish').length, availableDinos.length, SAR_ALL_MODULES.length, SAR_MODULE_CATALOG.length]);
        expect(p.map(x => x.collected)).toEqual([0,0,2,1]);
        expect(sarCollectionProgress(sarCollectionEntries(s, actor.id)).every(x => x.collected === 0)).toBe(true);
    });
    it('previews the chimera without revealing the reward, then reveals it only after collection', () => {
        let s: M.FishingMarketState = init();
        const locked = entry(s, 'user', 'aiven-chimera');
        expect(locked).toMatchObject({ title: '？？？', collected: false, owned: 0 });
        expect(locked.source).not.toContain('三星');
        expect(locked.description).not.toContain('霸王龙');
        expect(s.inventory).toHaveLength(0);
        expect(sarCollectionEntries(s, 'user', false).some(item => item.id === 'aiven-chimera')).toBe(false);
        s = M.addCatchToState(s, { id: 'chimera-gift', speciesId: 'aiven-chimera', ownerId: 'user', ownerName: '我', caughtAt: 1, weather: 'clear', weatherLabel: '晴', weatherSource: 'simulated', sizeCm: 12, quality: 1 });
        expect(entry(s, 'user', 'aiven-chimera')).toMatchObject({ collected: true, owned: 1 });
        expect(entry(s, 'user', 'aiven-chimera').source).toContain('三星');
        expect(entry(s, 'user', 'aiven-chimera').description).toContain('霸王龙');
    });
    it('opens the egg atlas at the authored unlock and preserves legacy egg/chimera ownership history',()=>{
        let s:M.FishingMarketState=init();
        expect(entry(s,'user','dinosaur-egg')).toBeUndefined();
        s.sarFamiliarity=freshFamiliarity();s.sarFamiliarity.unlocks.push('eggs');
        expect(entry(s,'user','dinosaur-egg')).toMatchObject({collected:false,owned:0});
        delete s.sarFamiliarity;
        for(const speciesId of ['dinosaur-egg','aiven-chimera'])s=M.addCatchToState(s,{id:speciesId,ownerId:'user',ownerName:'我',speciesId,caughtAt:1,weather:'clear',weatherLabel:'晴',weatherSource:'simulated',sizeCm:12,quality:1});
        expect(entry(s,'user','dinosaur-egg')).toMatchObject({collected:true,owned:1});
        s={...s,inventory:[]};
        expect(entry(s,'user','dinosaur-egg')).toMatchObject({collected:true,owned:0});
        expect(entry(s,'user','aiven-chimera')).toMatchObject({collected:true,owned:0});
        expect(entry(s,'friend','dinosaur-egg')).toBeUndefined();
    });
    it('preserves fish discovery after sale or release and records each true owner', () => {
        const fish = M.rollFishingCatch(actor, { kind: 'clear', label: '晴', detail: '', source: 'simulated' }, () => 0);
        let s = M.ensureActorAccounts(M.addCatchToState(init(), fish), [actor, { id: 'user', name: '我', kind: 'user' }]);
        s = M.createListing(s, actor, fish, 10); s = M.buyListing(s, s.listings[0].id, { id: 'user', name: '我', kind: 'user' });
        expect(entry(s, actor.id, fish.speciesId)).toMatchObject({ collected: true, owned: 0 });
        expect(entry(s, 'user', fish.speciesId)).toMatchObject({ collected: true, owned: 1 });
        s = M.handleCollection(s, { id: 'user', name: '我', kind: 'user' }, fish.id, 'release');
        expect(entry(s, 'user', fish.speciesId)).toMatchObject({ collected: true, owned: 0 });
        expect(entry(s, 'stranger', fish.speciesId).collected).toBe(false);
    });
    it('remembers the last legacy user module before consumption, even without receipts', async () => {
        const s = init(); s.sarCommerce.moduleShop.inventory = { [id]: 1 }; const storage = storageFor(s);
        await consumeOwnedSARModule(id, storage);
        expect(entry(readSARCommerce(storage).market, 'user')).toMatchObject({ collected: true, owned: 0 });
        expect(entry(readSARCommerce(storage).market, actor.id).collected).toBe(false);
        const backup = collectSARLocalBackup(storage), restored = storageFor(init()); restoreSARLocalBackup(backup, { replaceMissing: true }, restored);
        expect(entry(readSARCommerce(restored).market, 'user')).toMatchObject({ collected: true, owned: 0 });
    });
    it('remembers character purchases and the last imported character module separately', async () => {
        const s = { ...init(), sarCharacterModules: { [actor.id]: { [id]: 1 } } }, storage = storageFor(s);
        await consumeCharacterModule(actor.id, id, storage);
        await acquireCharacterModule(actor, other, 'buy', storage); await consumeCharacterModule(actor.id, other, storage);
        for (const itemId of [id, other]) expect(entry(M.readFishingMarketState(storage), actor.id, itemId)).toMatchObject({ collected: true, owned: 0 });
        expect(entry(M.readFishingMarketState(storage), 'user', other).collected).toBe(false);
    });
    it('does not unlock anything when a purchase write fails', async () => {
        const storage = storageFor(init()), raw = storage.getItem(M.FISHING_MARKET_STORAGE_KEY);
        await expect(drawSARModuleWithPayment('story', { storage: { getItem: storage.getItem, setItem: () => { throw new Error('full'); } }, requestId: 'fail', maxCost: 0 })).rejects.toThrow('full');
        expect(storage.getItem(M.FISHING_MARKET_STORAGE_KEY)).toBe(raw);
        expect(sarCollectionEntries(M.readFishingMarketState(storage), 'user').some(e => e.collected)).toBe(false);
    });
    it('recovers bounded-history receipts only for the paying actor, not other participants', () => {
        const s = init(); s.ledger.push({ id: 'receipt', at: 1, text: '', participants: [actor.id, 'user'], deliveredTo: [], sarPurchase: { kind: 'module', itemId: id, paid: 20 } });
        expect(entry(s, actor.id).collected).toBe(true); expect(entry(s, 'user').collected).toBe(false);
        const journal = rememberSARCollections(s); journal.ledger = [];
        expect(entry(journal, actor.id).collected).toBe(true);
    });
    it('backs up malformed collection data verbatim without overwriting it', () => {
        const s = { ...init(), sarCollection: { version: 1, actors: { broken: { chips: 'bad', modules: [] } } } } as any;
        const storage = storageFor(s), raw = storage.getItem(M.FISHING_MARKET_STORAGE_KEY);
        expect(() => M.readFishingMarketState(storage)).toThrow('收集图鉴');
        expect(collectSARLocalBackup(storage).fishingMarketRaw).toBe(raw); expect(storage.getItem(M.FISHING_MARKET_STORAGE_KEY)).toBe(raw);
    });
});
