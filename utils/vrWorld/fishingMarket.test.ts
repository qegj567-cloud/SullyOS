import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as M from './fishingMarket';
import { angleDifference, createFishingGame, stepFishingGame } from './fishingGame';
const weatherFetch=vi.hoisted(()=>vi.fn());
vi.mock('../realtimeContext',()=>({RealtimeContextManager:{fetchWeather:weatherFetch}}));

const user: M.MarketActor = {id:'user',name:'我',kind:'user'};
const a: M.MarketActor = {id:'a',name:'艾文',kind:'character'};
const b: M.MarketActor = {id:'b',name:'另一位',kind:'character'};
const now = new Date('2026-09-06T12:00:00+08:00').getTime();
const init = () => M.ensureMarketDay(M.ensureActorAccounts({...M.createFishingMarketState(42),accounts:{user:1000,a:1000,b:1000}},[user,a,b]),now);
const fish = (owner=a,id='fish-1',speciesId='glass-minnow'): M.FishingCatch => ({id,speciesId,ownerId:owner.id,ownerName:owner.name,caughtAt:now,weather:'rain',weatherLabel:'有雨',weatherSource:'simulated',sizeCm:23.4,quality:2});
beforeEach(()=>localStorage.clear());

describe('local fishing economy',()=>{
    it('uses current profile names for old collections without changing stored ownership',()=>{
        const caught=fish({id:'user',name:'user',kind:'user'});
        let actors=M.listMarketActors({name:'雨眠'} as any,[{id:'a',name:'艾文'}] as any);
        expect(M.marketActorName(actors,caught.ownerId,caught.ownerName)).toBe('雨眠');
        actors=M.listMarketActors({name:'小雨'} as any,[{id:'a',name:'新名字'}] as any);
        expect(M.marketActorName(actors,caught.ownerId,caught.ownerName)).toBe('小雨');
        expect(M.marketActorName(actors,'a','艾文')).toBe('新名字');
        expect(caught).toMatchObject({ownerId:'user',ownerName:'user'});
    });
    it('retains names of past visitors and handles missing legacy names without displaying IDs',()=>{
        expect(M.marketActorName([],'user','user')).toBe('我');
        expect(M.marketActorName([],'deleted-character','来访的朋友')).toBe('来访的朋友');
        expect(M.marketActorName([],undefined)).toBe('未记录姓名');
    });
    it('initializes independent wallets only once',()=>{
        const s=M.ensureActorAccounts(M.createFishingMarketState(42),[user,a]);s.accounts.a=0;
        expect(M.ensureActorAccounts(s,[a,b]).accounts).toEqual({user:120,a:0,b:120});
    });
    it('keeps daily weather/prices stable, worlds independent, yesterday real even after absence',()=>{
        const s=init(); expect(M.ensureMarketDay(s,now+1000).prices).toEqual(s.prices);
        expect(M.simulatedFishingWeather(42,now)).toEqual(M.simulatedFishingWeather(42,now+1000));
        expect(M.ensureMarketDay(M.createFishingMarketState(43),now).prices).not.toEqual(s.prices);
        const tomorrow=M.ensureMarketDay(s,now+M.MARKET_DAY_MS);
        expect(tomorrow.previousPrices).toEqual(s.prices);
        expect(M.ensureMarketDay(s,now+3*M.MARKET_DAY_MS).previousPrices).toEqual(M.ensureMarketDay(s,now+2*M.MARKET_DAY_MS).prices);
    });
    it.each([['雷阵雨','storm'],['小雪','snow'],['rain','rain'],['阴','cloudy'],['haze','fog'],['晴','clear']])('maps weather %s', (source,kind)=>expect(M.weatherFromDescription(source)).toBe(kind));
    it('disabled real perception uses explicit simulated provenance without network',async()=>{
        const fetch=vi.spyOn(globalThis,'fetch');expect((await M.resolveFishingWeather(undefined,42)).source).toBe('simulated');expect(fetch).not.toHaveBeenCalled();fetch.mockRestore();
    });
    it('weather actually changes catch distribution',()=>{
        const sample=(kind:M.FishingWeatherKind)=>{const r=M.marketRandom(12);let count=0;for(let i=0;i<5000;i++){if(M.rollFishingCatch(a,{kind,label:kind,detail:'',source:'simulated'},r,now).speciesId==='rain-drum')count++;}return count;};
        expect(sample('rain')).toBeGreaterThan(sample('clear')*2);
    });
    it('uses enabled real perception and visibly falls back if that source is unavailable',async()=>{
        const config={weatherEnabled:true,weatherCity:'上海'} as any;
        weatherFetch.mockResolvedValueOnce({city:'上海',description:'雷阵雨',temp:25});
        expect(await M.resolveFishingWeather(config,42)).toMatchObject({kind:'storm',source:'real',detail:'上海 · 雷阵雨 · 25°C'});
        expect(weatherFetch).toHaveBeenCalledWith(config);
        weatherFetch.mockRejectedValueOnce(Error('offline'));expect(await M.resolveFishingWeather(config,42)).toMatchObject({source:'simulated',detail:'真实天气暂不可用 · 使用彼方今日天气'});
    });
    it('transfers real inventory and conserves money, without repeat purchase',()=>{
        const caught=fish();let s=M.createListing(M.addCatchToState(init(),caught),a,caught,123,'我垄断全宇宙',now);
        const id=s.listings[0].id;s=M.buyListing(s,id,b,now);
        expect(s.accounts).toEqual({user:1000,a:1123,b:877});expect(s.inventory[0].ownerId).toBe('b');
        expect(s.ledger.at(-1)?.participants.sort()).toEqual(['a','b']);expect(s.ledger.at(-1)?.quotes?.[0].content).toBe('我垄断全宇宙');
        expect(()=>M.buyListing(s,id,user,now)).toThrow();expect(s.listings[0].status).toBe('sold');
    });
    it('zero price and imaginary goods are allowed, no imaginary inventory is minted',()=>{
        let s=M.createListing(init(),a,null,0,'你们到底想干嘛！！',now,'一个响指','匿名7');
        s=M.buyListing(s,s.listings[0].id,b,now);expect(s.accounts).toEqual(init().accounts);expect(s.inventory).toHaveLength(0);
        expect(s.ledger.at(-1)?.text).toContain('仅文字约定');expect(s.ledger.at(-1)?.text).toContain('匿名7');
    });
    it.each([-1,.5,NaN,Infinity,1000001])('rejects invalid price %s',n=>expect(()=>M.createListing(init(),a,null,n,'',now,'空气')).toThrow());
    it('rejects self purchase, missing goods and insufficient balance without changes',()=>{
        const s=M.createListing(M.addCatchToState(init(),fish()),a,fish(),1001,'',now);const snapshot=JSON.stringify(s);
        expect(()=>M.buyListing(s,s.listings[0].id,b,now)).toThrow('余额');expect(()=>M.buyListing(s,s.listings[0].id,a,now)).toThrow('自己');
        expect(()=>M.buyListing({...s,inventory:[]},s.listings[0].id,b,now)).toThrow('没有');expect(JSON.stringify(s)).toBe(snapshot);
    });
    it('comments never pay, tips pay responder to poster and retain full archive',()=>{
        let s=M.createRequest(init(),a,undefined,'给我钱',50,'我是宇宙之王',now,'tip','神秘人');const id=s.requests[0].id;
        s=M.commentOnPost(s,id,b,'？？？','交易员',now);expect(s.accounts.a).toBe(1000);
        s=M.fulfillRequest(s,id,b,'拿去吧',now);expect(s.accounts.a).toBe(1050);expect(s.accounts.b).toBe(950);
        expect(s.requests[0]).toMatchObject({status:'fulfilled',body:'我是宇宙之王',submission:'拿去吧',comments:[{content:'？？？'}]});
        expect(()=>M.fulfillRequest(s,id,user,'',now)).toThrow();
    });
    it('item requests need owned unlisted inventory; favors pay only after text submitted',()=>{
        let s=M.createRequest(M.addCatchToState(init(),fish(b)),a,'glass-minnow','想要鱼',20,'',now);const id=s.requests[0].id;
        expect(()=>M.fulfillRequest(s,id,user,'我说我有',now)).toThrow();
        s=M.fulfillRequest(s,id,b,'请收好',now);expect(s.inventory[0].ownerId).toBe('a');expect(s.accounts.a).toBe(980);
        s=M.createRequest(s,a,undefined,'一句鼓励',0,'',now,'favor');const favor=s.requests.at(-1)!.id;
        expect(()=>M.fulfillRequest(s,favor,b,'',now)).toThrow();expect(M.fulfillRequest(s,favor,b,'会好起来的',now).requests.at(-1)?.status).toBe('fulfilled');
    });
    it('expiry and deletion archive without erasing comments and unlock the fish',()=>{
        let s=M.createListing(M.addCatchToState(init(),fish()),a,fish(),10,'原文',now);const id=s.listings[0].id;
        s=M.commentOnPost(s,id,b,'原回复','',now);expect(M.availableCatches(s,'a',now)).toHaveLength(0);
        expect(()=>M.buyListing(s,id,b,now+M.MARKET_DAY_MS)).toThrow();expect(()=>M.commentOnPost(s,id,b,'晚到','',now+M.MARKET_DAY_MS)).toThrow();
        const expired=M.ensureMarketDay(s,now+M.MARKET_DAY_MS);expect(expired.listings[0]).toMatchObject({status:'expired',note:'原文',comments:[{content:'原回复'}]});expect(M.availableCatches(expired,'a',now+M.MARKET_DAY_MS)).toHaveLength(1);
        expect(()=>M.removeMarketPost(s,id,'b',now)).toThrow();expect(M.removeMarketPost(s,id,'a',now).listings[0].status).toBe('removed');
    });
    it('keeps the post owner anonymous when replying without a new alias',()=>{
        let s=M.createListing(init(),a,null,0,'原文',now,'一句晚安','月亮交易员');
        s=M.commentOnPost(s,s.listings[0].id,a,'还在哦','',now);
        expect(s.listings[0].comments[0].alias).toBe('月亮交易员');
        expect(s.ledger.at(-1)?.text).not.toContain(a.name);
        expect(s.ledger.at(-1)?.quotes?.[0].name).toBe('月亮交易员');
        s=M.createRequest(s,a,undefined,'一句鼓励',0,'',now,'favor','匿名发帖人');
        s=M.commentOnPost(s,s.requests[0].id,a,'谢谢','',now);
        expect(s.requests[0].comments[0].alias).toBe('匿名发帖人');
        s=M.commentOnPost(s,s.requests[0].id,b,'加油','',now);
        expect(s.requests[0].comments[1].alias).toBeUndefined();
    });
    it('delivers the chosen specimen and archives it without taking another of the same species',()=>{
        let s=M.addCatchToState(M.addCatchToState(init(),fish(b,'precious')),fish(b,'chosen'));
        s=M.createRequest(s,a,'glass-minnow','求鱼',20,'',now);
        expect(()=>M.fulfillRequest(s,s.requests[0].id,b,'',now)).toThrow('选择');
        s=M.fulfillRequest(s,s.requests[0].id,b,'这条给你',now,'chosen');
        expect(s.inventory.find(c=>c.id==='precious')?.ownerId).toBe(b.id);
        expect(s.inventory.find(c=>c.id==='chosen')?.ownerId).toBe(a.id);
        expect(s.requests[0].fulfilledCatch).toMatchObject({id:'chosen',speciesId:'glass-minnow',quality:2,sizeCm:23.4});
        expect(s.accounts).toMatchObject({a:980,b:1020});
    });
    it('never substitutes another specimen when the chosen one becomes unavailable',()=>{
        let s=M.addCatchToState(M.addCatchToState(init(),fish(b,'other')),fish(b,'chosen'));
        s=M.createRequest(s,a,'glass-minnow','求鱼',20,'',now);
        s=M.createListing(s,b,s.inventory.find(c=>c.id==='chosen')!,10,'',now);
        const snapshot=JSON.stringify(s);
        expect(()=>M.fulfillRequest(s,s.requests[0].id,b,'',now,'chosen')).toThrow();
        expect(JSON.stringify(s)).toBe(snapshot);
        expect(()=>M.fulfillRequest(s,s.requests[0].id,b,'',now,'missing')).toThrow();
    });
    it('keeps the listed specimen details in the archive even after it leaves inventory',()=>{
        let s=M.createListing(M.addCatchToState(init(),fish(a)),a,fish(a),20,'实物',now);
        s=M.buyListing(s,s.listings[0].id,b,now);
        s=M.handleCollection(s,b,'fish-1','release',now);
        M.saveFishingMarketState(s);
        const restored=M.readFishingMarketState();
        expect(restored.inventory).toHaveLength(0);
        expect(restored.listings[0]).toMatchObject({status:'sold',buyerName:b.name,catchSnapshot:{id:'fish-1',speciesId:'glass-minnow',quality:2,sizeCm:23.4}});
        expect(restored.listings[0].catchSnapshot).not.toHaveProperty('ownerName');
    });
    it('retains >250 assets, rejects corrupted storage, retries catch without duplication',()=>{
        let s=init();for(let i=0;i<260;i++)s=M.addCatchToState(s,fish(a,'f'+i));M.saveFishingMarketState(s);
        expect(M.readFishingMarketState().inventory).toHaveLength(260);
        s=M.handleCollection(s,a,'f0','release',now);expect(M.addCatchToState(s,fish(a,'f0')).inventory).toHaveLength(259);
        localStorage.setItem(M.FISHING_MARKET_STORAGE_KEY,'broken');expect(()=>M.readFishingMarketState()).toThrow();expect(localStorage.getItem(M.FISHING_MARKET_STORAGE_KEY)).toBe('broken');
        expect(()=>M.saveFishingMarketState(s,{setItem:()=>{throw Error('full');}})).toThrow('full');
    });
    it('serializes competing buyers, only one pays and no lost update',async()=>{
        const s=M.createListing(M.addCatchToState(init(),fish()),a,fish(),15);M.saveFishingMarketState(s);
        const results=await Promise.allSettled([M.mutateFishingMarket(s=>M.buyListing(s,s.listings[0].id,b)),M.mutateFishingMarket(s=>M.buyListing(s,s.listings[0].id,user))]);
        expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);expect(M.readFishingMarketState().accounts).toEqual({user:1000,a:1015,b:985});
    });
    it('egg locks for six hours then hatches exactly once; study keeps collectible',()=>{
        let s=M.addCatchToState(init(),fish(user,'egg','dinosaur-egg'));s=M.handleCollection(s,user,'egg','study',now);
        expect(s.research.user).toBe(1);expect(s.inventory).toHaveLength(1);expect(()=>M.handleCollection(s,user,'egg','study',now)).toThrow();
        s=M.handleCollection(s,user,'egg','incubate',now);expect(()=>M.handleCollection(s,user,'egg','sell',now)).toThrow();expect(()=>M.hatchEgg(s,user,'egg',now)).toThrow();
        s=M.hatchEgg(s,user,'egg',now+6*3600000);expect(s.inventory[0].speciesId).not.toBe('dinosaur-egg');expect(()=>M.hatchEgg(s,user,'egg',now+6*3600000)).toThrow();
    });
});
describe('tide resonance engine',()=>{
    it.each([.18,.58,.96])('can catch difficulty %s with actual controls',difficulty=>{
        const s={...createFishingGame(difficulty),phase:'waiting' as const} as ReturnType<typeof createFishingGame>;
        for(let i=0;i<4000&&s.phase!=='caught'&&s.phase!=='escaped';i++){
            s.held=angleDifference(s.fishAngle,s.playerAngle+s.playerVelocity*.10)>0;stepFishingGame(s,1/120);
        }
        expect(s.phase).toBe('caught');expect(s.progress).toBe(1);
    });
    it('unattended cast escapes, idle/success cannot award more progress',()=>{
        const s=createFishingGame(.7);stepFishingGame(s,10);expect(s.phase).toBe('idle');s.phase='waiting';
        for(let i=0;i<5000;i++)stepFishingGame(s,1/120);expect(s.phase).toBe('escaped');const elapsed=s.elapsed;stepFishingGame(s,10);expect(s.elapsed).toBe(elapsed);
    });
});
