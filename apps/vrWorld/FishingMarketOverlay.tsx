import { sarNpcContentEnabled } from '../../utils/vrWorld/sarNpcPreference';
import { runMarketNPCSession } from '../../utils/vrWorld/marketNPCSession';
import { rollMarketVisitor } from '../../utils/vrWorld/marketRefresh';
import { SARFacilityGuide } from './SARFacilityGuide';
import { AivenFishSaleReceipt } from './AivenFishSaleReceipt';
import type { AivenFishSale } from '../../utils/vrWorld/fishingSale';
import { remainingSARBuyback, SAR_DAILY_BUYBACK } from '../../utils/vrWorld/sarEconomy';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, X, Fish, BookOpen, DotsThree, PencilSimple, CaretRight, ArrowsClockwise } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile, RealtimeConfig, UserProfile } from '../../types';
import {
    personalFishingCollection, pendingFishingTrip, FISH_CATALOG, WEATHER_LABELS, FISHING_MARKET_STORAGE_KEY, addCatchToState, availableCatches, buyListing, catchValue,
    commentOnPost, createFishingMarketState, createListing, createRequest, ensureActorAccounts, ensureMarketDay,
    fulfillRequest, handleCollection, hatchEgg, listMarketActors, marketActorName, marketCatchSnapshot, mutateFishingMarket, readFishingMarketState,
    removeMarketPost, resolveFishingWeather, rollFishingCatch, sellFishToAiven, speciesById,
    type FishingCatch, type FishingMarketState, type FishingWeather, type MarketCatchSnapshot, type MarketListing, type MarketRequest,
} from '../../utils/vrWorld/fishingMarket';
import { flushMarketReceipts } from '../../utils/vrWorld/fishingCharacter';
import { flushFishingDeliveries } from '../../utils/vrWorld/fishingDelivery';
import { FishingGame } from './FishingGame';
import { FishArt } from './FishArt';
import './fishing.css';
import './fishingBoard.css';

type Tab = 'water' | 'catalog' | 'board' | 'more' | 'prices' | 'archive' | 'visit';
type Compose = 'listing' | 'item' | 'favor' | 'tip';
type BoardPost = MarketListing | MarketRequest;
const rarityLabel: Record<string,string> = {common:'常见',uncommon:'少见',rare:'稀有',epic:'奇珍',relic:'橡皮泥藏品'};
const statusLabel: Record<string,string> = {open:'展板中',sold:'已售出',fulfilled:'已完成',removed:'主动撤下',expired:'已到期'};
const ownerId = (p:BoardPost) => 'sellerId' in p ? p.sellerId : p.authorId;
const ownerName = (p:BoardPost) => p.alias || ('sellerName' in p ? p.sellerName : p.authorName);
const isFreeNote = (p:BoardPost) => 'kind' in p && p.kind==='favor' && p.offer===0;
const postKind = (p:BoardPost) => 'price' in p ? '转让' : p.kind==='item' ? '求物' : p.kind==='favor' ? (isFreeNote(p)?'便笺':'求回应') : '收心意';
const postAmount = (p:BoardPost) => 'price' in p ? p.price : p.offer;
const amountLabel = (p:BoardPost) => 'price' in p ? '售价' : p.kind==='tip' ? '心意' : '酬谢';
const specimenLabel = (c:MarketCatchSnapshot) => `${c.nickname?c.nickname+' · ':''}${speciesById(c.speciesId)?.name||'藏品'} · ${c.sizeCm} cm · ${c.quality} 星`;
const countdown = (deadline:number,now:number) => {
    const s=Math.max(0,Math.ceil((deadline-now)/1000)); return Math.floor(s/3600)+'h '+String(Math.floor(s/60)%60).padStart(2,'0')+'m';
};

interface Props {
    initialEntry?:'water'|'board'|'sell'; apiConfig?:APIConfig;
    characters:CharacterProfile[]; userProfile:UserProfile; realtimeConfig?:RealtimeConfig;
    addToast?:(message:string,type?:any)=>void; onClose:()=>void;
    onOpenGarden?:()=>void;
    onCharacterTrip:(char:CharacterProfile,mode:'fishing'|'market')=>Promise<{ok:boolean;reason?:string}>;
}
export const FishingMarketOverlay:React.FC<Props> = ({initialEntry='water',apiConfig,characters,userProfile,realtimeConfig,addToast,onClose,onOpenGarden,onCharacterTrip}) => {
    const actors=useMemo(()=>listMarketActors(userProfile,characters),[userProfile.name,characters]);
    const user=actors[0];
    const [state,setState]=useState<FishingMarketState>(()=>{try{return ensureMarketDay(readFishingMarketState());}catch{return createFishingMarketState();}});
    const [error,setError]=useState('');
    const [weather,setWeather]=useState<FishingWeather|null>(null);
    const [tab,setTab]=useState<Tab>(initialEntry==='sell'?'catalog':initialEntry);
    const selling=initialEntry==='sell'&&tab==='catalog';
    const atWater=tab==='water'||tab==='catalog';
    const mainRef=useRef<HTMLElement>(null);
    const scrollPositions=useRef<Partial<Record<Tab,number>>>({});
    const visitReturn=useRef<'board'|'more'>('more');
    const goTo=(next:Tab)=>{if(next==='visit')visitReturn.current=tab==='board'?'board':'more';scrollPositions.current[tab]=mainRef.current?.scrollTop||0;setTab(next);setError('');};
    useLayoutEffect(()=>{if(mainRef.current)mainRef.current.scrollTop=scrollPositions.current[tab]||0;},[tab]);
    const [viewer,setViewer]=useState('user');
    const [busy,setBusy]=useState(false);
    const refreshInFlight = useRef(false);
    const [refreshNotice, setRefreshNotice] = useState('');
    const [trip,setTrip]=useState<string|null>(null);
    const tripResultRef=useRef<HTMLDivElement>(null);
    const [tripChar,setTripChar]=useState('');
    const [selectedCatch,setSelectedCatch]=useState<FishingCatch|null>(null);
    const [saleReceipt,setSaleReceipt]=useState<AivenFishSale|null>(null);
    const saleInFlight=useRef(false);
    const [compose,setCompose]=useState<Compose|null>(null);
    const [selectedPost,setSelectedPost]=useState<BoardPost|null>(null);
    const [postText,setPostText]=useState('');
    const [fulfillmentCatchId,setFulfillmentCatchId]=useState('');
    const [now,setNow]=useState(Date.now());
    const [archivePage,setArchivePage]=useState(0);
    const [inventoryPage,setInventoryPage]=useState(0);
    const [draft,setDraft]=useState({catchId:'',speciesId:'dinosaur-egg',label:'',price:'0',body:'',alias:''});
    const actor=actors.find(a=>a.id===viewer)||user;
    const report=(e:unknown)=>{const message=e instanceof Error?e.message:String(e);setError(message);addToast?.(message,'error');};
    const refresh=useCallback(()=>{try{setState(ensureMarketDay(readFishingMarketState()));}catch(e){setError(e instanceof Error?e.message:String(e));}},[]);
    useEffect(()=>{
        let alive=true;
        void mutateFishingMarket(s=>ensureActorAccounts(s,actors)).then(async s=>{
            if(alive)setState(s);
            if(initialEntry==='water'||initialEntry==='sell'){
                const value=await resolveFishingWeather(realtimeConfig,s.seed);if(alive)setWeather(value);
            }
            await flushFishingDeliveries(characters);
            await flushMarketReceipts(characters);
        }).catch(e=>{if(alive)setError(e instanceof Error?e.message:String(e));});
        const onStorage=(e:StorageEvent)=>{if(e.key===FISHING_MARKET_STORAGE_KEY)refresh();};
        window.addEventListener('vr-fishing-market-updated',refresh);window.addEventListener('storage',onStorage);
        const timer=setInterval(()=>{setNow(Date.now());refresh();},30_000);
        return()=>{alive=false;clearInterval(timer);window.removeEventListener('vr-fishing-market-updated',refresh);window.removeEventListener('storage',onStorage);};
    },[actors,realtimeConfig,refresh,characters,initialEntry]);
    const commit=async(change:(s:FishingMarketState)=>FishingMarketState)=>{
        const next=await mutateFishingMarket(change);setState(next);
        try{await flushFishingDeliveries(characters);await flushMarketReceipts(characters);}catch{setError('交易已保存；角色回执暂未同步，下次进入水域或布告板会重试。');}
        return next;
    };
    const act=async(change:(s:FishingMarketState)=>FishingMarketState,after?:()=>void)=>{
        if(busy)return;setBusy(true);setError('');
        try{await commit(change);after?.();}catch(e){report(e);}finally{setBusy(false);}
    };
    const sellToAiven=async(catchId:string)=>{
        if(busy||saleInFlight.current)return;
        saleInFlight.current=true;setBusy(true);setError('');
        try{
            let receipt:AivenFishSale|undefined;
            await commit(s=>{const sold=sellFishToAiven(s,user,catchId);receipt=sold.sale;return sold.state;});
            setSelectedCatch(null);setSaleReceipt(receipt!);
        }catch(e){report(e);}finally{saleInFlight.current=false;setBusy(false);}
    };
    const npcAbort=useRef<AbortController|null>(null);
    useEffect(()=>()=>npcAbort.current?.abort(),[]);
    const refreshVisitors = async () => {
        if (refreshInFlight.current || busy || trip) return;
        refreshInFlight.current = true; setBusy(true); setError(''); setRefreshNotice('');
        try {
            const visitor = rollMarketVisitor(characters,Math.random,sarNpcContentEnabled());
            if (visitor) {
                setRefreshNotice(visitor.name + '正在看看布告板…');
                const result = await onCharacterTrip(visitor, 'market');
                if (!result.ok) throw new Error(result.reason === 'no-api' ? '尚未配置角色或彼方 API，暂时无法邀请这位角色。'
                    : result.reason === 'busy' ? '这位角色正在进行另一项活动，稍后再刷新看看。' : '这次来访没有完成，可以稍后再试。');
                refresh();
                setRefreshNotice(visitor.name + '来过了，看看有没有留下新便笺或回复。');
            } else {
                setRefreshNotice('路人正在看看最近的便笺…');
                const controller=new AbortController();npcAbort.current=controller;
                const result=await runMarketNPCSession(apiConfig,controller.signal);
                setState(result.state);
                await flushMarketReceipts(characters);
                setRefreshNotice(result.visitors.map(v=>v.name).join('、')+'来过了。'+(result.skipped.length?'有 '+result.skipped.length+' 项行动因便笺或余额变化未执行。':''));
            }
            setNow(Date.now());
        } catch (cause) { setRefreshNotice(''); report(cause); }
        finally { npcAbort.current=null;refreshInFlight.current = false; setBusy(false); }
    };
    const onCaught=async(c:FishingCatch)=>{await commit(s=>addCatchToState(s,c));};
    const beginPost=(mode:Compose,catchId='')=>{
        const c=state.inventory.find(c=>c.id===catchId);
        setDraft({catchId,speciesId:'dinosaur-egg',label:'',price:c?String(catchValue(state,c)):mode==='tip'?'10':'0',body:'',alias:''});setCompose(mode);setError('');
    };
    const publish=()=>void act(s=>{
        const price=Number(draft.price);if(!draft.price.trim())throw new Error('请填写金额');
        if(compose==='listing'){
            const caught=draft.catchId?s.inventory.find(c=>c.id===draft.catchId):null;
            if(draft.catchId&&!caught)throw new Error('选中的藏品已经不在手中');
            return createListing(s,user,caught||null,price,draft.body,Date.now(),draft.label,draft.alias);
        }
        const species=speciesById(draft.speciesId);
        return createRequest(s,user,compose==='item'?species?.id:undefined,compose==='item'?species!.name:draft.label,
            price,draft.body,Date.now(),compose==='tip'?'tip':compose==='item'?'item':'favor',draft.alias);
    },()=>{setCompose(null);scrollPositions.current.board=0;setTab('board');if(mainRef.current)mainRef.current.scrollTop=0;});
    const runTrip=async(mode:'fishing'|'market')=>{
        const char=characters.find(c=>c.id===tripChar);if(!char||trip||busy||refreshInFlight.current)return;
        refreshInFlight.current=true;
        setTrip(char.id);setError('');
        try{const result=await onCharacterTrip(char,mode);if(!result.ok)throw new Error(pendingFishingTrip(readFishingMarketState(),char.id)?'这一竿的鱼获已暂存。点“继续处理这一竿”重试，不会重新抽取。':result.reason==='no-api'?'尚未配置角色或彼方 API':result.reason==='busy'?'角色正在进行另一项活动':result.reason==='empty'?'角色的回复没有给出可执行结果，这轮没有替角色编造行动':'这次活动未完成，请查看彼方调用记录');refresh();}
        catch(e){report(e);}finally{refreshInFlight.current=false;setTrip(null);if(mode==='fishing')requestAnimationFrame(()=>tripResultRef.current?.scrollIntoView({block:'nearest',behavior:'smooth'}));}
    };
    useEffect(()=>{
        if(tab==='water'&&weather)return;
        const target=window as Window & {render_game_to_text?:()=>string;advanceTime?:(ms:number)=>void};
        const render=()=>JSON.stringify({mode:'fishing-market',tab,page:compose?'compose':selectedPost?'detail':tab,selectedPost:selectedPost?.id,viewer,balance:state.accounts[viewer],inventory:state.inventory.filter(c=>c.ownerId===viewer).map(c=>({id:c.id,speciesId:c.speciesId})),openListings:state.listings.filter(p=>p.status==='open').length,openRequests:state.requests.filter(p=>p.status==='open').length,compose});
        const advance=()=>{};target.render_game_to_text=render;target.advanceTime=advance;
        return()=>{if(target.render_game_to_text===render)delete target.render_game_to_text;if(target.advanceTime===advance)delete target.advanceTime;};
    },[tab,viewer,state,compose,weather,selectedPost]);
    const owned=state.inventory.filter(c=>c.ownerId===actor.id&&(!selling||speciesById(c.speciesId)?.category==='fish'));
    const discoveries=personalFishingCollection(state,actor.id);
    const pendingTrip=pendingFishingTrip(state,tripChar);
    const latestTrip=(state.fishingTrips||[]).filter(t=>t.catch.ownerId===tripChar).at(-1);
    const deliveryPending=(state.fishingTrips||[]).some(t=>t.catch.ownerId===tripChar&&t.status==='settled'&&(!t.cardSent||(t.result?.shareToUser&&!t.shareSent)));
    const retryDelivery=()=>void (async()=>{if(busy)return;setBusy(true);setError('');try{await flushFishingDeliveries(characters);await flushMarketReceipts(characters);refresh();}catch(e){report(e);}finally{setBusy(false);}})();
    const archive=[...state.listings,...state.requests].filter(p=>p.status!=='open'&&ownerId(p)===actor.id).sort((a,b)=>(b.closedAt||b.createdAt)-(a.closedAt||a.createdAt));
    const activePost=selectedPost?[...state.listings,...state.requests].find(p=>p.id===selectedPost.id):null;
    const draftCatch=state.inventory.find(c=>c.id===draft.catchId);
    const needsSpecimen=activePost&&'kind' in activePost&&activePost.kind==='item'&&activePost.authorId!==user.id&&activePost.status==='open';
    const fulfillmentCatches=needsSpecimen?availableCatches(state,user.id).filter(c=>c.speciesId===activePost.speciesId):[];
    const postSpecimen=(p:BoardPost)=>{
        if(!('price' in p))return p.fulfilledCatch;
        const c=state.inventory.find(c=>c.id===p.catchId);
        return p.catchSnapshot||(c?marketCatchSnapshot(state,c):undefined);
    };
    const posts=[...state.listings,...state.requests].filter(p=>p.status==='open').sort((a,b)=>b.createdAt-a.createdAt);
    const viewPicker=<select aria-label="查看谁的钱包和收藏" className="fish-input" value={viewer} onChange={e=>{setViewer(e.target.value);setInventoryPage(0);setArchivePage(0);}}>{actors.map(a=><option key={a.id} value={a.id}>{a.name} · {state.accounts[a.id]||0} 鳞币</option>)}</select>;
    const characterTripControls=(mode:'fishing'|'market')=><section className={mode==='fishing'?'fish-divider mt-5 pt-4':'board-visit'}>
        <div className="mb-2 text-[13px]">{mode==='fishing'?'角色自己的闲暇':'一起逛逛'}</div>
        <p className="fish-note mb-3">{mode==='fishing'?`由 ta 决定保留、放生或交给${sarNpcContentEnabled()?'艾文':'回收站'}，使用一次模型调用。`:'让 ta 自己决定看看、交易，或留一句话。每次邀请使用一次模型调用。'}</p>
        <select className="fish-input" aria-label={mode==='fishing'?'选择去水域的角色':'选择逛布告板的角色'} value={tripChar} onChange={e=>setTripChar(e.target.value)}><option value="">选择已接入彼方的角色</option>{characters.filter(c=>c.vrState?.enabled).map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select>
        <button disabled={!tripChar||!!trip||busy} className="fish-action mt-2 w-full" onClick={()=>void runTrip(mode)}>{trip?'活动进行中…':mode==='fishing'?(pendingTrip?'继续处理这一竿':'让 ta 去钓鱼'):'让 ta 逛布告板'}</button>
        {mode==='fishing'&&latestTrip&&<div ref={tripResultRef} className="mt-3 rounded-xl bg-white/5 p-3" aria-live="polite">
            <div className="text-[13px]">{speciesById(latestTrip.catch.speciesId)?.name} · {latestTrip.catch.sizeCm} cm · {'✦'.repeat(latestTrip.catch.quality)}</div>
            <p className="fish-note mt-1">{latestTrip.status==='pending'?'鱼获已暂存，等 ta 决定去向。':latestTrip.result?.disposition==='release'?'已放生，个人图鉴记录保留。':latestTrip.sale?`已交给${sarNpcContentEnabled()?'艾文':'回收站'}，获得 ${latestTrip.sale.amount} 鳞币，个人图鉴记录保留。`:'已放进 ta 自己的收藏柜。'}</p>
            {latestTrip.sale&&<AivenFishSaleReceipt sale={latestTrip.sale} sellerName={marketActorName(actors,latestTrip.catch.ownerId,latestTrip.catch.ownerName)} sellerWords={latestTrip.result?.saleWords}/>}
            {latestTrip.result&&<p className="mt-2 text-[12px] leading-6">{latestTrip.result.reaction}</p>}
            {latestTrip.result?.shareToUser&&<p className="fish-note mt-1">{latestTrip.shareSent?'ta 已在私聊里告诉你了。':'私聊分享待发送。'}</p>}
            <button className="fish-action mt-2" onClick={()=>{setViewer(tripChar);setTab('catalog');}}>查看 ta 的收藏与图鉴 →</button>
        </div>}
        {mode==='fishing'&&deliveryPending&&<button disabled={busy} className="fish-action mt-2 w-full" onClick={retryDelivery}>重试发送记录与分享</button>}
    </section>;
    const postRow=(p:BoardPost)=><button key={p.id} type="button" onClick={()=>{setSelectedPost(p);setPostText('');setFulfillmentCatchId('');setError('');}} className="board-note">
        <div className="board-note-meta"><span>{ownerName(p)} · {postKind(p)}</span><span>{p.status==='open'?(p.comments.length?`${p.comments.length} 条回复`:''):statusLabel[p.status]}</span></div>
        <div className="board-note-title">{p.itemLabel}</div>
        <p className="board-note-excerpt">{('note' in p?p.note:(p as MarketRequest).body)||'点开看看这张便笺。'}</p>
        <div className="board-note-foot"><span>{isFreeNote(p)?'留句话':`${amountLabel(p)} ${postAmount(p)} 鳞币`}</span><CaretRight size={15} aria-hidden/></div>
    </button>;
    const boardTitle=tab==='more'?'更多':tab==='prices'?'当日行情':tab==='archive'?'往期便笺':tab==='visit'?'邀请角色':'布告板';
    return <div className={`fishing-shell ${tab==='water'?'fishing-water-shell':''} ${!atWater||compose?'fishing-board-shell':''} fixed inset-0 z-[380] flex flex-col overflow-hidden`} role="dialog" aria-modal="true" aria-label={atWater?'彼方水域':'彼方布告板'}>
        <div className="fish-page-underlay flex min-h-0 flex-1 flex-col" hidden={!!compose||!!activePost}>
        {atWater?<header className="flex shrink-0 items-center gap-3 px-4 pb-3" style={{paddingTop:'calc(var(--chrome-top) + .5rem)'}}>
            <button className="fish-action !border-0 !p-2" onClick={onClose} aria-label={atWater?'离开水域':'离开布告板'}><ArrowLeft size={20}/></button>
            <div className="flex-1"><div className="text-[19px] tracking-[.16em]" style={{fontFamily:"'Noto Serif SC',serif"}}>{selling?(sarNpcContentEnabled()?'艾文的收鱼摊':'鱼获回收'):atWater?'彼方水域':'彼方布告板'}</div><div className="text-[8px] tracking-[.25em] text-[#8eaaa9]">{atWater?'WATERSIDE':'MARKET'} / SAR</div></div>
            <span className="text-[15px] tabular-nums text-[#d4c4a4]">{state.accounts.user||0}<small className="ml-1 text-[10px]">鳞币</small></span>
            <SARFacilityGuide facility="water"/>
        </header>:<header className="board-header">
            <button className="board-icon" onClick={()=>tab==='board'?onClose():goTo(tab==='more'?'board':tab==='visit'?visitReturn.current:'more')} aria-label={tab==='board'?'离开布告板':tab==='more'||(tab==='visit'&&visitReturn.current==='board')?'返回布告板':'返回更多'}><ArrowLeft size={21}/></button>
            <h1>{boardTitle}</h1>
            {tab==='board'&&<button className="board-icon" aria-label="布告板更多" onClick={()=>goTo('more')}><DotsThree size={25} weight="bold"/></button>}
            <SARFacilityGuide facility="board"/>
        </header>}
        {atWater&&<nav className="fish-divider grid shrink-0 grid-cols-2 border-b border-[#c8e0ea21] px-3">
            {([['water','钓鱼',Fish],['catalog',initialEntry==='sell'?'卖鱼':'图鉴',BookOpen]] as const).map(([id,label,Icon])=><button key={id} aria-current={tab===id?'page':undefined} className={`flex items-center justify-center gap-1.5 border-b-2 py-3 ${tab===id?'border-[#a7cebd] text-[#dfeee4]':'border-transparent text-[#8a9eab]'}`} onClick={()=>goTo(id)}><Icon size={15}/>{label}</button>)}
        </nav>}
        <main ref={mainRef} className={`min-h-0 flex-1 overflow-y-auto vr-reader-scroll ${tab==='water'?'fishing-water-main':atWater?'px-4 pt-4':'board-content'}`} style={tab==='water'?undefined:{paddingBottom:'calc(var(--safe-bottom) + 1.5rem)'}}>
            <div className={tab==='water'?'fishing-water-content':'mx-auto w-full max-w-[560px]'}>
                {error&&<p role="alert" className="mb-3 rounded-lg bg-amber-200/10 px-3 py-2 text-[12px] leading-6 text-amber-100">{error}</p>}
                {tab==='water'&&<>
                    {weather?<FishingGame weather={weather} onCast={()=>rollFishingCatch(user,weather)} onCaught={onCaught} onOpenCollection={()=>{goTo('catalog');setViewer('user');}}/>:<div className="grid flex-1 place-items-center fish-note">水面正在醒来……</div>}
                    <details className="fishing-companions"><summary>角色钓鱼<CaretRight size={14}/></summary>{characterTripControls('fishing')}</details>
                </>}
                {tab==='catalog'&&<>
                    {!selling&&onOpenGarden&&<button className="fish-action primary w-full mb-4" onClick={onOpenGarden}>带橡皮泥恐龙去箱庭 →</button>}
                    {!selling&&viewPicker}
                    <div className="mt-4 flex items-center justify-between"><h2 className="text-[14px]">{actor.name} 的收藏</h2><span className="fish-note">{owned.length} 件 · 研究 {state.research[actor.id]||0}</span></div>
                    {actor.id!=='user'&&<p className="fish-note mt-1">你可以回看 ta 的收藏；鱼获和交易由 ta 在自己的活动中决定。</p>}
                    {actor.id==='user'&&<p className="fish-note mt-1">点一条鱼，可以按今天的行情交给{sarNpcContentEnabled()?'艾文':'回收站'}。</p>}
                    <div className="mt-3 grid grid-cols-2 gap-2">{owned.slice().reverse().slice(inventoryPage*12,inventoryPage*12+12).map(c=><button className="rounded-xl bg-[#c8e0ea08] p-3 text-left" key={c.id} onClick={()=>{setSelectedCatch(c);setError('');}}><div className="flex justify-center"><FishArt speciesId={c.speciesId} size={118}/></div><div className="mt-1 text-[12px]">{speciesById(c.speciesId)?.name}</div><div className="fish-note">{'✦'.repeat(c.quality)} · {c.sizeCm} cm{c.displayed?' · 陈列中':''}{c.incubatingUntil?' · 孵化中':''}</div></button>)}</div>
                    {!owned.length&&<p className="fish-note py-7 text-center">{selling?'现在还没有鱼可以卖，先去钓一会儿吧。':'水箱还空着。收藏从第一竿开始。'}</p>}
                    {owned.length>12&&<div className="mt-3 flex justify-between"><button className="fish-action" disabled={inventoryPage===0} onClick={()=>setInventoryPage(p=>p-1)}>上一页</button><span className="fish-note">{inventoryPage+1} / {Math.ceil(owned.length/12)}</span><button className="fish-action" disabled={(inventoryPage+1)*12>=owned.length} onClick={()=>setInventoryPage(p=>p+1)}>下一页</button></div>}
                    <div className="fish-divider mt-5 flex items-center justify-between pt-4"><h2 className="text-[14px]">{actor.name} 的水域图鉴</h2><span className="fish-note">{discoveries.length} / {FISH_CATALOG.length}</span></div>
                    <p className="fish-note mt-1">亮起的天气是今天；匹配时更容易钓到。恐龙都是橡皮泥模型，可以放进箱庭。</p>
                    <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-5">{FISH_CATALOG.map(f=>{const entry=discoveries.find(e=>e.speciesId===f.id);const seen=!!entry;return <div key={f.id}><div className="flex h-24 items-center justify-center rounded-xl bg-[#c8e0ea04]"><FishArt speciesId={f.id} size={130} silhouette={!seen}/></div><div className="mt-2 text-[12px]">{seen?f.name:'未发现 · '+rarityLabel[f.rarity]}</div><div className="mt-1 flex flex-wrap gap-x-2 text-[10px]">{f.weathers.map(w=><span className={weather?.kind===w?'text-[#bcdfbc]':'text-[#8096a1]'} key={w}>{WEATHER_LABELS[w]}{weather?.kind===w?' · 活跃':''}</span>)}</div>{seen&&<><p className="fish-note mt-1">{f.blurb}</p><p className="fish-note mt-1">{entry!.historicalIncomplete?'已记录至少':'累计获得 '}{entry!.acquisitionIds.length} 件 · 现有 {owned.filter(c=>c.speciesId===f.id).length} 件</p><p className="fish-note">{entry!.firstObtainedAt ? (entry!.historicalIncomplete?'最早已知：':'首次获得：')+new Date(entry!.firstObtainedAt).toLocaleDateString('zh-CN') : '早期获得，日期未记录'}</p></>}</div>;})}</div>
                </>}
                {tab==='board'&&<>
                    <div className="board-refresh-row"><p className="board-dateline">{new Date(now).toLocaleDateString('zh-CN',{month:'long',day:'numeric'})} · 最近的便笺</p><div className="board-refresh-actions"><button type="button" disabled={busy || !!trip} onClick={()=>goTo('visit')}>指定角色</button><button type="button" disabled={busy || !!trip} onClick={() => void refreshVisitors()} aria-label="刷新布告板"><ArrowsClockwise size={16}/>{refreshInFlight.current ? '来访中…' : '刷新'}</button></div></div>
                    {refreshNotice && <p className="board-refresh-notice" role="status">{refreshNotice}</p>}
                    <div className="board-notes">{posts.map(postRow)}</div>
                    {!posts.length&&<div className="board-empty"><PencilSimple size={28} weight="light" aria-hidden/><p>还没有便笺</p><span>写点什么，留给路过的朋友。</span></div>}
                </>}
                {tab==='more'&&<>
                    <div className="board-wallet"><span>我的鳞币</span><strong>{state.accounts.user||0}</strong></div>
                    <div className="board-links">{([['prices','当日行情','看看今天的鱼获收购价'],['archive','往期便笺','回看原文、回复与成交记录'],['visit','邀请角色','请一位朋友来逛逛']] as const).map(([id,title,description])=><button key={id} onClick={()=>goTo(id)}><span><strong>{title}</strong><small>{description}</small></span><CaretRight size={17}/></button>)}</div>
                    <details className="board-about"><summary>关于布告板</summary><p>这里属于你和你的角色。各自的新钱包从 120 鳞币开始，互不混用。</p><p>便笺保留 24 小时；成交、撤下或到期后收进作者的往期便笺。回复不扣钱。</p></details>
                </>}
                {tab==='prices'&&<>
                    <div className="board-dateline">{new Date(now).toLocaleDateString('zh-CN',{month:'long',day:'numeric'})} · 参考收购价 / 鳞币</div>
                    <div className="board-prices">{FISH_CATALOG.filter(f=>f.category==='fish').map(f=>{const price=state.prices[f.id]||f.basePrice;const before=state.previousPrices[f.id]||price;const delta=Math.round((price/before-1)*100);return <div className="board-price-row" key={f.id}><FishArt speciesId={f.id} size={66}/><div className="board-price-name">{f.name}<small>{rarityLabel[f.rarity]}</small></div><div className="board-price-value">{price}<small>{delta>0?'↑':delta<0?'↓':'—'} {Math.abs(delta)}% 较昨日</small></div></div>;})}</div>
                    <p className="fish-note mt-4">在收藏里可以直接按行情卖出。二星、三星按品质加价；便笺售价由发布者自己决定。</p>
                </>}
                {tab==='visit'&&<>
                    {characterTripControls('market')}
                    <section className="board-passersby"><h2>路过的朋友</h2><p className="fish-note">主页点「刷新」，随机来两三位路人或一位自由活动中的角色。路人的发帖、接话和隔空喊话由一次模型调用共同生成，会接着最近的便笺聊；使用彼方 API，未单独配置时跟随聊天默认。想让谁来，就点「指定角色」。</p><button type="button" className="fish-action mt-3" onClick={()=>goTo('board')}>去刷新布告板</button></section>
                </>}
                {tab==='archive'&&<>
                    {viewPicker}
                    <h2 className="mt-4 text-[14px]">{actor.name} 的往期便笺</h2>
                    <p className="fish-note mt-1">已下板的原文、回复和结果都留在这里。</p>
                    <div className="board-notes mt-4">{archive.slice(archivePage*12,archivePage*12+12).map(postRow)}</div>
                    {!archive.length&&<p className="fish-note py-7 text-center">暂时没有封存便笺。</p>}
                    {archive.length>12&&<div className="mt-3 flex justify-between"><button className="fish-action" disabled={archivePage===0} onClick={()=>setArchivePage(p=>p-1)}>上一页</button><button className="fish-action" disabled={(archivePage+1)*12>=archive.length} onClick={()=>setArchivePage(p=>p+1)}>下一页</button></div>}
                    <details className="board-about"><summary>收支记录</summary><div className="board-ledger">{state.ledger.filter(e=>e.participants.includes(actor.id)).slice(-30).reverse().map(e=><div className="py-3" key={e.id}><p className="text-[12px] leading-6">{e.text}</p><div className="fish-note">{new Date(e.at).toLocaleString()}</div></div>)}</div></details>
                </>}
            </div>
        </main>
        {tab==='board'&&<footer className="board-footer"><button className="fish-action primary" onClick={()=>beginPost('favor')}><PencilSimple size={17}/>写便笺</button></footer>}
        </div>
        {saleReceipt&&<Sheet title={sarNpcContentEnabled()?'艾文的收鱼摊':'鱼获回收'} onClose={()=>setSaleReceipt(null)}><AivenFishSaleReceipt sale={saleReceipt} sellerName={user.name}/></Sheet>}
        {selectedCatch&&(()=>{const c=state.inventory.find(item=>item.id===selectedCatch.id);if(!c)return null;const f=speciesById(c.speciesId)!;const mine=c.ownerId==='user';const free=availableCatches(state,'user').some(item=>item.id===c.id);
            const collectionAct=(action:'sell'|'release'|'display'|'study'|'incubate')=>void act(s=>handleCollection(s,user,c.id,action),()=>setSelectedCatch(null));
            return <Sheet title={f.name} onClose={()=>setSelectedCatch(null)}>
                <div className="flex justify-center py-2"><FishArt speciesId={c.speciesId} size={240} animated/></div>
                <div className="text-center text-[13px]">{rarityLabel[f.rarity]} · {c.sizeCm} cm · {'✦'.repeat(c.quality)}</div><p className="fish-note mt-2 text-center">{f.blurb}</p>
                <p className="fish-note mt-3">{marketActorName(actors,c.ownerId,c.ownerName)} 的收藏 · {c.weatherLabel} · {c.weatherSource==='real'?'真实天气':'模拟天气'}</p>
                {error&&<p role="alert" className="mt-2 text-[12px] text-amber-100">{error}</p>}
                {mine&&<p className="fish-note mt-3">今日回收额度 {remainingSARBuyback(state.buybackBudgets, 'user', now)} / {SAR_DAILY_BUYBACK} 鳞币 · 次日恢复</p>}
                {mine&&<div className="mt-4 flex flex-wrap gap-2">
                    <button disabled={busy||!free||catchValue(state,c)>remainingSARBuyback(state.buybackBudgets,'user',now)} className="fish-action primary" onClick={()=>f.category==='fish'?void sellToAiven(c.id):collectionAct('sell')}>{f.category==='fish'&&sarNpcContentEnabled()?'卖给艾文':'按行情卖出'} · {catchValue(state,c)} 鳞币</button>
                    <button disabled={busy||!free} className="fish-action" onClick={()=>{setSelectedCatch(null);beginPost('listing',c.id);}}>自己定价挂板</button>
                    <button disabled={busy||!free} className="fish-action" onClick={()=>collectionAct('display')}>{c.displayed?'收起陈列':'放进陈列'}</button>
                    {f.category==='time-relic'&&<button disabled={busy||!free||c.studied} className="fish-action" onClick={()=>collectionAct('study')}>{c.studied?'已记录观察':'制作观察记录'}</button>}
                    {c.speciesId==='dinosaur-egg'&&(c.incubatingUntil?<button disabled={busy||c.incubatingUntil>now} className="fish-action" onClick={()=>void act(s=>hatchEgg(s,user,c.id),()=>setSelectedCatch(null))}>{c.incubatingUntil>now?'孵化剩余 '+countdown(c.incubatingUntil,now):'揭晓孵化结果'}</button>:<button disabled={busy||!free} className="fish-action" onClick={()=>collectionAct('incubate')}>孵化 · 6 小时</button>)}
                    {f.category==='fish'&&<button disabled={busy||!free} className="fish-action" onClick={()=>collectionAct('release')}>放生</button>}
                </div>}
                {c.displayed&&<p className="fish-note mt-3">已放在自己的水域陈列架。</p>}
            </Sheet>;
        })()}
        {compose&&<BoardPage title="写便笺" onClose={()=>setCompose(null)}>
            <div className="board-compose">
                <label className="block fish-note">我想<select aria-label="便笺用途" className="fish-input mt-1" value={compose} onChange={e=>{const next=e.target.value as Compose;setCompose(next);setError('');setDraft(d=>({...d,price:next==='listing'&&draftCatch?String(catchValue(state,draftCatch)):next==='tip'?'10':'0'}));}}><option value="favor">收到一句回应</option><option value="item">找到一件藏品</option><option value="listing">转让一件东西</option><option value="tip">收一份心意</option></select></label>
                {compose==='listing'?<label className="block fish-note">商品<select className="fish-input mt-1" value={draft.catchId} onChange={e=>{const c=state.inventory.find(c=>c.id===e.target.value);setDraft(d=>({...d,catchId:e.target.value,price:c?String(catchValue(state,c)):'0'}));}}><option value="">自定义文字商品（没有实物）</option>{availableCatches(state,'user').map((c,i)=><option key={c.id} value={c.id}>{specimenLabel(marketCatchSnapshot(state,c))} · 第 {i+1} 件</option>)}</select></label>:compose==='item'?<label className="block fish-note">需要的物种<select className="fish-input mt-1" value={draft.speciesId} onChange={e=>setDraft(d=>({...d,speciesId:e.target.value}))}>{FISH_CATALOG.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label>:null}
                {(compose==='listing'&&!draft.catchId||compose==='favor'||compose==='tip')&&<label className="block fish-note">便笺标题<input className="fish-input mt-1" maxLength={40} value={draft.label} placeholder={compose==='tip'?'例如：想买一根新鱼竿':'例如：求一句鼓励'} onChange={e=>setDraft(d=>({...d,label:e.target.value}))}/></label>}
                <label className="block fish-note">想说的话<textarea aria-label="便笺正文" className="fish-input mt-1" rows={4} maxLength={240} value={draft.body} placeholder="把想说的留在这里。" onChange={e=>setDraft(d=>({...d,body:e.target.value}))}/></label>
                <label className="block fish-note">{compose==='tip'?'希望收到的鳞币':compose==='listing'?'售价（鳞币）':'给对方的酬谢（鳞币）'}<input aria-label="金额" className="fish-input mt-1" type="number" min={0} max={1000000} step={1} value={draft.price} onChange={e=>setDraft(d=>({...d,price:e.target.value}))}/></label>
                {compose==='listing'&&draftCatch&&<p className="fish-note">今日参考价 {catchValue(state,draftCatch)} 鳞币 · 你可以自己定价。</p>}
                <details className="board-signature"><summary>署名 · {draft.alias||user.name}</summary><input aria-label="匿名笔名" className="fish-input mt-2" maxLength={24} value={draft.alias} placeholder="笔名（留空使用自己的名字）" onChange={e=>setDraft(d=>({...d,alias:e.target.value}))}/></details>
                <p className="fish-note">{compose==='tip'?'对方响应时付款，你收到这份心意。':compose==='favor'?'对方提交文字后即收到酬谢；不支持需要后续验收的任务。':compose==='item'?'对方交付藏品时，你支付酬谢。':draft.catchId?'成交时交出这件藏品，你收到售价。':'文字约定不含实物，成交时你收到售价。'} 金额可以为 0，便笺保留 24 小时。</p>
                {error&&<p role="alert" className="text-[12px] text-amber-100">{error}</p>}
                <button className="fish-action primary w-full" disabled={busy} onClick={publish}>贴上布告板</button>
            </div>
        </BoardPage>}
        {activePost&&<BoardPage title="便笺" label={activePost.itemLabel} onClose={()=>setSelectedPost(null)}>
            <div className="fish-note">{ownerName(activePost)} · {activePost.status==='open'?countdown(activePost.expiresAt,now)+' 后封存':statusLabel[activePost.status]}</div>
            <h2 className="board-detail-title">{activePost.itemLabel}</h2>
            {'price' in activePost&&!activePost.catchId&&<p className="fish-note mt-2">文字商品 · 自愿交易，不会获得实体藏品。</p>}
            {postSpecimen(activePost)&&<p className="fish-note mt-2 break-words">{activePost.status==='fulfilled'?'已交付':'实物'}：{specimenLabel(postSpecimen(activePost)!)}</p>}
            {'buyerName' in activePost&&activePost.buyerName&&<p className="fish-note mt-2">成交买家：{activePost.buyerName}</p>}
            {'fulfillerName' in activePost&&activePost.fulfillerName&&<p className="fish-note mt-2">{activePost.kind==='tip'?'打赏人':'交付人'}：{activePost.fulfillerName}</p>}
            <p className="mt-3 whitespace-pre-wrap break-words text-[13px] leading-7">{'price' in activePost?activePost.note:activePost.body}</p>
            <div className="board-detail-price">{isFreeNote(activePost)?<span>一张便笺，随意聊聊。</span>:<><span>{amountLabel(activePost)}</span><strong>{postAmount(activePost)} <small>鳞币</small></strong></>}</div>
            {'submission' in activePost&&activePost.submission&&<p className="fish-note mt-2">交付内容：{activePost.submission}</p>}
            {activePost.comments.length>0&&<div className="fish-divider mt-4 space-y-3 pt-3">{activePost.comments.map(c=><div key={c.id} className="text-[12px] leading-6"><span className="board-comment-author">{c.alias||c.authorName}</span>：<span className="whitespace-pre-wrap break-words">{c.content}</span></div>)}</div>}
            {activePost.status==='open'&&<><label className="block fish-note mt-5">{'kind' in activePost&&activePost.kind==='favor'?'写下你的回应':'留句话'}<textarea aria-label="回复或交付内容" className="fish-input mt-1" rows={3} value={postText} maxLength={240} placeholder="说点什么……" onChange={e=>setPostText(e.target.value)}/></label>
                {needsSpecimen&&<div className="mt-3">
                    <label className="block fish-note">选择交付的藏品<select aria-label="选择交付的藏品" className="fish-input mt-1" value={fulfillmentCatchId} onChange={e=>setFulfillmentCatchId(e.target.value)}>
                        <option value="">请选择具体哪一件</option>
                        {fulfillmentCatches.map((c,i)=><option key={c.id} value={c.id}>{specimenLabel(marketCatchSnapshot(state,c))} · 第 {i+1} 件</option>)}
                    </select></label>
                    <p className="fish-note mt-1">{fulfillmentCatches.length?'交付后，这件藏品归对方，你收到出价的鳞币。':'没有可交付的同种藏品；已挂板、孵化中或等待角色处理的藏品不能交付。'}</p>
                </div>}
                <div className="board-detail-actions">
                {ownerId(activePost)!=='user'&&<button disabled={busy||!!needsSpecimen&&!fulfillmentCatches.some(c=>c.id===fulfillmentCatchId)} className="fish-action primary" onClick={()=>void act(s=>'price' in activePost?buyListing(s,activePost.id,user):fulfillRequest(s,activePost.id,user,postText,Date.now(),fulfillmentCatchId))}>{'price' in activePost?`支付 ${activePost.price} 鳞币，买下`:activePost.kind==='tip'?`赠予 ${activePost.offer} 鳞币`:activePost.kind==='favor'?(isFreeNote(activePost)?'提交回应并完成':`提交并领取 ${activePost.offer} 鳞币`):`交付并领取 ${activePost.offer} 鳞币`}</button>}
                <div className="flex justify-between gap-3"><button disabled={busy||!postText.trim()} className="board-text-button" onClick={()=>void act(s=>commentOnPost(s,activePost.id,user,postText),()=>setPostText(''))}>{isFreeNote(activePost)?'回复':'仅回复'}</button>{ownerId(activePost)==='user'&&<button disabled={busy} className="board-text-button" onClick={()=>void act(s=>removeMarketPost(s,activePost.id,'user'))}>撤下并存档</button>}</div></div></>}
            {error&&<p role="alert" className="mt-3 text-[12px] text-amber-100">{error}</p>}
            {activePost.alias&&ownerId(activePost)==='user'&&<p className="fish-note mt-3">你的匿名发帖；在这张便笺下回复会沿用「{activePost.alias}」。</p>}
        </BoardPage>}
    </div>;
};
const BoardPage:React.FC<{title:string;label?:string;onClose:()=>void;children:React.ReactNode}> = ({title,label,onClose,children})=>{
    const heading=useRef<HTMLHeadingElement>(null);
    const closeRef=useRef(onClose);closeRef.current=onClose;
    useEffect(()=>{
        const previous=document.activeElement as HTMLElement|null;
        heading.current?.focus();
        const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeRef.current();}};
        document.addEventListener('keydown',escape,true);
        return()=>{document.removeEventListener('keydown',escape,true);requestAnimationFrame(()=>previous?.isConnected&&previous.focus({preventScroll:true}));};
    },[]);
    return <section className="board-page flex min-h-0 flex-1 flex-col" role="dialog" aria-modal="true" aria-label={label||title}>
        <header className="board-header"><button className="board-icon" aria-label="返回上一页" onClick={onClose}><ArrowLeft size={21}/></button><h1 ref={heading} tabIndex={-1}>{title}</h1></header>
        <div className="board-content min-h-0 flex-1 overflow-y-auto vr-reader-scroll"><div className="mx-auto w-full max-w-[560px]">{children}</div></div>
    </section>;
};
const Sheet:React.FC<{title:string;onClose:()=>void;children:React.ReactNode}> = ({title,onClose,children})=><div className="absolute inset-0 z-30 flex items-end justify-center bg-[#02080cb3] px-2 pt-16" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
    <section className="fish-reveal max-h-full w-full max-w-[540px] overflow-y-auto rounded-t-2xl bg-[#1b303d] px-5 pt-4" style={{paddingBottom:'calc(var(--safe-bottom) + 1.5rem)'}} onClick={e=>e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between"><h2 className="text-[16px]">{title}</h2><button className="fish-action !border-0 !p-2" aria-label="关闭详情" onClick={onClose}><X size={18}/></button></div>{children}
    </section>
</div>;
export default FishingMarketOverlay;
