import { SAR_STARTING_BALANCE } from './sarEconomy';
import { beforeEach, expect, it, vi } from 'vitest';
import { runVRSession } from './runSession';
import { DB } from '../db';
import { safeFetchJson } from '../safeApi';
import { buildChatRequestPayload } from '../chatRequestPayload';
import { createFishingMarketState, ensureActorAccounts, createRequest, readFishingMarketState, saveFishingMarketState } from './fishingMarket';
import { collectSARLocalBackup, restoreSARLocalBackup } from './sarBackup';
import { flushFishingDeliveries } from './fishingDelivery';
import {ensureDinosaurGarden,setGardenVisits,editDino,gardenResidents,findGardenSpace} from './dinosaurGarden';
const mocks=vi.hoisted(()=>({messages:[] as any[],board:{id:'board',messages:[] as any[],updatedAt:0}}));
vi.mock('../db',()=>({DB:{
    ensureHomeContextMessages:vi.fn(async()=>{}),
    getVRNovels:vi.fn(async()=>[]),getVRMusicRoom:vi.fn(async()=>null),getEmojis:vi.fn(async()=>[]),getEmojiCategories:vi.fn(async()=>[]),
    getRecentMessagesByCharId:vi.fn(async(id:string)=>mocks.messages.filter(m=>m.charId===id)),getVRCardsByCharId:vi.fn(async(id:string)=>mocks.messages.filter(m=>m.charId===id)),getVRMarketEventIds:vi.fn(async(id:string)=>mocks.messages.filter(m=>m.charId===id).map(m=>m.metadata?.marketEventId).filter(Boolean)),
    saveMessageOnce:vi.fn(async(key:string,m:any)=>{const found=mocks.messages.find(x=>x.charId===m.charId&&x.metadata?.deliveryId===key);if(!found)mocks.messages.push({...m,metadata:{...m.metadata,deliveryId:key}});return 1;}),
    appendVRGuestbookMessages:vi.fn(async(messages:any[])=>{for(const m of messages)if(!mocks.board.messages.some(x=>x.id===m.id))mocks.board.messages.push(m);}),
    saveMessage:vi.fn(async(m:any)=>{mocks.messages.push(m);return 1;}),getVRGuestbook:vi.fn(async()=>mocks.board),saveVRGuestbook:vi.fn(async(b:any)=>{mocks.board=b;}),
}}));
vi.mock('../chatRequestPayload',()=>({buildChatRequestPayload:vi.fn(async()=>({systemPrompt:'ORIGINAL PERSONA',cleanedApiMessages:[]}))}));
vi.mock('../safeApi',async importOriginal=>({...await importOriginal<typeof import('../safeApi')>(),safeFetchJson:vi.fn()}));
vi.mock('../memoryPalace/autoArchive',()=>({processNewMessagesWithAutoArchive:vi.fn(async()=>{})}));
vi.mock('../../context/MusicContext',()=>({loadMusicCfgStandalone:vi.fn(()=>({}))}));
vi.mock('./vrApi',()=>({getVRApi:vi.fn(async()=>null),logVRApiCall:vi.fn()}));
const a={id:'a',name:'艾文',vrState:{enabled:true,intervalMinutes:120},memoryPalaceEnabled:false} as any;
const b={id:'b',name:'旁边那位',vrState:{enabled:true,intervalMinutes:120}} as any;
const deps={char:a,characters:[a,b],userProfile:{name:'用户'} as any,apiConfig:{baseUrl:'https://model.invalid/v1',apiKey:'fake',model:'test'} as any,groups:[],updateCharacter:vi.fn(),forcedRoom:'sar' as const,manual:true};
const answer=(text:string)=>vi.mocked(safeFetchJson).mockResolvedValue({choices:[{message:{content:text}}]});
beforeEach(()=>{vi.restoreAllMocks();localStorage.clear();mocks.messages=[];mocks.board={id:'board',messages:[],updatedAt:0};vi.clearAllMocks();saveFishingMarketState({...ensureActorAccounts(createFishingMarketState(42),[{id:'a',name:'艾文',kind:'character'},{id:'b',name:'旁边那位',kind:'character'},{id:'user',name:'用户',kind:'user'}]),lastPulseAt:Date.now()});});
it('a board encounter uses one character call and saves the committed scene and reaction in activity cards',async()=>{
    let state=ensureActorAccounts(readFishingMarketState(),[{id:'wanderer:0',name:'临时售票员',kind:'wanderer'}]);
    state=createRequest(state,{id:'wanderer:0',name:'临时售票员',kind:'wanderer'},undefined,'替风扇鼓掌',7,'需要一位热心观众',Date.now(),'favor');
    const post=state.requests[0];post.npcPersona={name:'临时售票员',identity:'风扇的经纪人'};post.encounter={story:'{{participant}}刚站稳，风扇就谢幕了。经纪人说它今天转得太投入。'};
    saveFishingMarketState(state);
    answer(`<ACTION>fulfill</ACTION><TARGET>${post.id}</TARGET><NOTE>去看看这场演出。</NOTE><REACTION>它的返场是不是得插电？</REACTION>`);
    expect(await runVRSession({...deps,forcedSARActivity:'market'})).toMatchObject({ok:true});
    expect(safeFetchJson).toHaveBeenCalledTimes(1);
    const cards=mocks.messages.filter(m=>m.type==='vr_card');
    expect(cards.some(m=>m.metadata?.marketActivity&&m.content.includes('风扇就谢幕了')&&m.content.includes('返场是不是得插电'))).toBe(true);
    expect(readFishingMarketState().requests[0].encounterResult?.participantId).toBe('a');
});
it('a rejected encounter does not publish the prewritten scene or the character reaction as experienced',async()=>{
    let state=ensureActorAccounts(readFishingMarketState(),[{id:'wanderer:0',name:'临时售票员',kind:'wanderer'}]);
    state=createRequest(state,{id:'wanderer:0',name:'临时售票员',kind:'wanderer'},undefined,'替风扇鼓掌',7,'需要观众',Date.now(),'favor');
    const post=state.requests[0];post.npcPersona={name:'临时售票员',identity:'风扇经纪人'};post.encounter={story:'风扇居然谢幕了。'};state.accounts['wanderer:0']=0;
    saveFishingMarketState(state);
    answer(`<ACTION>fulfill</ACTION><TARGET>${post.id}</TARGET><NOTE>去看看。</NOTE><REACTION>没想到还有返场。</REACTION>`);
    await runVRSession({...deps,forcedSARActivity:'market'});
    expect(mocks.messages.some(m=>m.content.includes('风扇居然谢幕了')||m.content.includes('没想到还有返场'))).toBe(false);
    expect(readFishingMarketState().requests[0].encounterResult).toBeUndefined();
});
it('manual-only participants cannot be started by a stale timer, but explicit invitations work',async()=>{
    const char={...a,vrState:{...a.vrState,activityMode:'manual'}};
    expect(await runVRSession({...deps,char,manual:false,forcedSARActivity:'market'})).toMatchObject({ok:false,reason:'manual-only'});
    expect(safeFetchJson).not.toHaveBeenCalled();expect(DB.getVRNovels).not.toHaveBeenCalled();
    answer('<NOTE>来看看有什么。</NOTE><ACTION>browse</ACTION><SHARE>none</SHARE>');
    expect((await runVRSession({...deps,char,forcedSARActivity:'market'})).ok).toBe(true);
    expect(safeFetchJson).toHaveBeenCalledTimes(1);
    const update=deps.updateCharacter.mock.calls.at(-1)![1];
    expect(update(char).vrState.activityMode).toBe('manual');
});

it('automatic exclusions skip every model call and cannot be bypassed by a forced SAR mode',async()=>{
    const char={...a,id:'blocked-automatic',vrState:{...a.vrState,excludedAutoRooms:['guestbook','gym','postoffice','theater','library','music','sar']}};
    expect(await runVRSession({...deps,char,manual:false,forcedRoom:undefined})).toMatchObject({ok:false,reason:'no-content'});
    expect(await runVRSession({...deps,char,manual:false,forcedSARActivity:'market'})).toMatchObject({ok:false,reason:'no-content'});
    expect(safeFetchJson).not.toHaveBeenCalled();
    expect(buildChatRequestPayload).not.toHaveBeenCalled();
});

it('manual module-shop invitation stays in the shop even when automatic SAR is disabled',async()=>{
    vi.spyOn(Math,'random').mockReturnValue(0);
    answer('<ACTIVITY>看了看模块。</ACTIVITY><NOTE>有点意思。</NOTE><BUY>NO</BUY><USE_ON_USER>NO</USE_ON_USER>');
    const char={...a,vrState:{...a.vrState,excludedAutoRooms:['sar'],excludedAutoSARActivities:['module-shop']}};
    expect(await runVRSession({...deps,char,forcedSARActivity:'module-shop'})).toMatchObject({ok:true});
    expect(safeFetchJson).toHaveBeenCalledTimes(1);
    const body=JSON.parse((vi.mocked(safeFetchJson).mock.calls[0][1] as any).body);
    expect(body.messages[0].content).toContain('此刻只在模块商店');
    expect(mocks.messages.at(-1).metadata.sarModuleShop).toBeDefined();
    expect(readFishingMarketState().fishingTrips||[]).toHaveLength(0);
});

it('manual cabinet invitation cannot randomly turn into fishing',async()=>{
    vi.spyOn(Math,'random').mockReturnValue(0);
    answer(JSON.stringify({title:'芯片测试',story:'一场临时芯片故事。',notes:'收好随笔。'}));
    expect(await runVRSession({...deps,forcedSARActivity:'cabinet'})).toMatchObject({ok:true});
    expect(safeFetchJson).toHaveBeenCalledTimes(1);
    expect(mocks.messages.at(-1).content).toContain('芯片：');
    expect(readFishingMarketState().fishingTrips||[]).toHaveLength(0);
});
it('a disconnected character cannot be started even through a manual entry',async()=>{
    expect(await runVRSession({...deps,char:{...a,vrState:{...a.vrState,enabled:false}},forcedSARActivity:'market'})).toMatchObject({ok:false,reason:'not-enabled'});
    expect(safeFetchJson).not.toHaveBeenCalled();
});
it('one fishing call keeps the rolled catch, sends actual chat and announces personal unlock',async()=>{
    answer(JSON.stringify({disposition:'keep',reaction:'这条很漂亮。',shareToUser:{text:'快看，我钓到了！'}}));
    expect(await runVRSession({...deps,forcedSARActivity:'fishing'})).toMatchObject({ok:true});expect(safeFetchJson).toHaveBeenCalledTimes(1);
    const s=readFishingMarketState();expect(s.inventory.filter(c=>c.ownerId==='a')).toHaveLength(1);
    expect(mocks.board.messages).toHaveLength(1);expect(mocks.board.messages[0]).toMatchObject({authorId:'sar-discovery',kind:'collection-unlock'});
    const card=mocks.messages.find(m=>m.metadata?.fishing);expect(card.metadata.fishing.speciesId).toBe(s.inventory[0].speciesId);
    expect(mocks.messages.filter(m=>m.type==='text')).toMatchObject([{charId:'a',content:'快看，我钓到了！'}]);
    expect(mocks.messages.some(m=>m.charId==='b'&&m.content.includes('首次解锁'))).toBe(true);
    const payload=JSON.parse((vi.mocked(safeFetchJson).mock.calls[0][1] as any).body);expect(payload.messages[0].content).toContain('ORIGINAL PERSONA');expect(payload.messages.at(-1).content).toContain('程序判定的唯一鱼获');
    expect(payload.messages.at(-1).content).toContain('previouslyOwned');expect(s.listings).toHaveLength(0);expect(s.lastPulseAt).toBeDefined();
});
it('release and share are independent; duplicate species never repeats unlock announcements',async()=>{
    vi.spyOn(Math,'random').mockReturnValue(0);
    for(let i=0;i<2;i++){
        answer(JSON.stringify({disposition:'release',reaction:'小鱼回家吧。',shareToUser:{text:'放回去了。'}}));
        expect((await runVRSession({...deps,forcedSARActivity:'fishing'})).ok).toBe(true);
    }
    const s=readFishingMarketState();expect(s.inventory).toHaveLength(0);expect(s.collectionEntries![0].acquisitionIds).toHaveLength(2);
    expect(mocks.board.messages).toHaveLength(1);expect(mocks.messages.filter(m=>m.type==='text')).toHaveLength(2);expect(safeFetchJson).toHaveBeenCalledTimes(2);
});
it('sells to Aiven at the end of one fishing call and retries delivery without another payment',async()=>{
    vi.spyOn(Math,'random').mockReturnValue(0);
    answer(JSON.stringify({disposition:'sell',reaction:'今天有收获。',saleWords:'这条你收吗？',shareToUser:{text:'把鱼卖给艾文了。'}}));
    expect((await runVRSession({...deps,forcedSARActivity:'fishing'})).ok).toBe(true);
    const saved=readFishingMarketState(),trip=saved.fishingTrips![0];
    expect(saved.inventory).toHaveLength(0);expect(trip.sale).toBeDefined();
    expect(saved.accounts.a).toBe(SAR_STARTING_BALANCE+trip.sale!.amount);
    const card=mocks.messages.find(m=>m.metadata?.fishing);expect(card.metadata.fishing.decision).toBe('sell');
    expect(card.content).toContain('艾文的成交回应');expect(card.content).toContain('这条你收吗？');
    expect(mocks.messages.filter(m=>m.type==='text')).toMatchObject([{content:'把鱼卖给艾文了。'}]);
    await flushFishingDeliveries([a,b]);await flushFishingDeliveries([a,b]);
    expect(readFishingMarketState().accounts.a).toBe(saved.accounts.a);expect(safeFetchJson).toHaveBeenCalledTimes(1);
    expect(mocks.messages.filter(m=>m.metadata?.fishing)).toHaveLength(1);
    const backup=collectSARLocalBackup();localStorage.clear();restoreSARLocalBackup(backup,{replaceMissing:false});
    expect(readFishingMarketState().fishingTrips![0].sale).toEqual(trip.sale);
});
it('API failure retains exactly one catch and retries the same snapshot',async()=>{
    vi.mocked(safeFetchJson).mockRejectedValueOnce(Error('offline'));
    expect((await runVRSession({...deps,forcedSARActivity:'fishing'})).ok).toBe(false);
    const before=readFishingMarketState();expect(before.inventory).toHaveLength(1);expect(before.fishingTrips![0].status).toBe('pending');
    vi.mocked(safeFetchJson).mockResolvedValueOnce({choices:[{message:{content:[{type:'text',text:'决定如下：\n```json\n{"disposition":" KEEP ","reaction":"先留下。",}\n```'}]}}]});
    expect((await runVRSession({...deps,forcedSARActivity:'fishing'})).ok).toBe(true);
    const after=readFishingMarketState();expect(after.inventory[0]).toEqual(before.inventory[0]);expect(after.inventory).toHaveLength(1);expect(after.collectionEntries![0].acquisitionIds).toHaveLength(1);
    expect(mocks.board.messages).toHaveLength(1);expect(safeFetchJson).toHaveBeenCalledTimes(2);
});
it('invalid JSON retains pending catch, and a model cannot release clay or invoke market',async()=>{
    vi.spyOn(Math,'random').mockReturnValue(.99999);
    answer(JSON.stringify({disposition:'release',reaction:'放回去',shareToUser:null}));
    expect(await runVRSession({...deps,forcedSARActivity:'fishing'})).toMatchObject({ok:false,reason:'fishing-settlement',detail:'橡皮泥模型不能放生'});
    const id=readFishingMarketState().inventory[0].id;
    answer(JSON.stringify({disposition:'market',reaction:'卖了',shareToUser:null}));
    expect((await runVRSession({...deps,forcedSARActivity:'fishing'})).ok).toBe(false);
    expect(readFishingMarketState().inventory[0].id).toBe(id);expect(readFishingMarketState().listings).toHaveLength(0);expect(mocks.messages.filter(m=>m.type==='text')).toHaveLength(0);
});
it('failed sharing can be retried without another model call, catch, or repeated action',async()=>{
    vi.spyOn(Math,'random').mockReturnValue(0);
    const actual=vi.mocked(DB.saveMessageOnce).getMockImplementation()!;
    vi.mocked(DB.saveMessageOnce).mockImplementation(async(key,m)=>{if(key.startsWith('fishing_share_'))throw Error('disk full');return actual(key,m);});
    answer(JSON.stringify({disposition:'release',reaction:'放回去吧',shareToUser:{text:'放回去了'}}));
    expect((await runVRSession({...deps,forcedSARActivity:'fishing'})).ok).toBe(true);
    expect(readFishingMarketState().inventory).toHaveLength(0);expect(mocks.messages.filter(m=>m.type==='text')).toHaveLength(0);
    vi.mocked(DB.saveMessageOnce).mockImplementation(actual);
    await flushFishingDeliveries([a,b]);await flushFishingDeliveries([a,b]);
    expect(mocks.messages.filter(m=>m.type==='text')).toHaveLength(1);expect(readFishingMarketState().fishingTrips).toHaveLength(1);expect(safeFetchJson).toHaveBeenCalledTimes(1);
});
it('publication failure preserves a retriable unlock announcement',async()=>{
    vi.mocked(DB.appendVRGuestbookMessages).mockRejectedValueOnce(Error('disk full')).mockRejectedValueOnce(Error('disk full'));
    answer(JSON.stringify({disposition:'keep',reaction:'好看',shareToUser:null}));await runVRSession({...deps,forcedSARActivity:'fishing'});
    await flushFishingDeliveries([a,b]);await flushFishingDeliveries([a,b]);expect(mocks.board.messages).toHaveLength(1);expect(readFishingMarketState().collectionEntries![0].announcement?.published).toBe(true);
});
it('completed tip reaches both characters and the next call can react to what actually happened',async()=>{
    let s=readFishingMarketState();s=createRequest(s,{id:'b',name:'旁边那位',kind:'character'},undefined,'给我钱',30,'给我钱！！',Date.now(),'tip');saveFishingMarketState(s);
    answer(`<NOTE>还真敢要钱。</NOTE><ACTION>fulfill</ACTION><TARGET>${s.requests[0].id}</TARGET><WORDS>拿好</WORDS><SHARE>none</SHARE>`);
    expect((await runVRSession({...deps,forcedSARActivity:'market'})).ok).toBe(true);
    expect(readFishingMarketState().accounts).toMatchObject({a:SAR_STARTING_BALANCE-30,b:SAR_STARTING_BALANCE+30});
    expect(mocks.messages.some(m=>m.charId==='b'&&m.content.includes('真的给')&&m.content.includes('给我钱！！'))).toBe(true);
    answer('<NOTE>居然真有人给了！</NOTE><ACTION>browse</ACTION><SHARE>guestbook</SHARE><SHARE_WORDS>我要了30块，居然真收到了！</SHARE_WORDS>');
    expect((await runVRSession({...deps,char:b,forcedSARActivity:'market'})).ok).toBe(true);
    const body=JSON.parse((vi.mocked(safeFetchJson).mock.calls[1][1] as any).body);expect(body.messages.at(-1).content).toContain('打赏了 30');
    expect(vi.mocked(buildChatRequestPayload).mock.calls[1][0].historyMsgs.some(m=>m.content.includes('打赏了 30'))).toBe(true);
    expect(mocks.board.messages.at(-1)?.content).toContain('居然真收到了');expect(safeFetchJson).toHaveBeenCalledTimes(2);
});
it('invalid action does not pay or broadcast an invented success',async()=>{
    answer('<NOTE>我要买</NOTE><ACTION>buy</ACTION><TARGET>nonexistent</TARGET><SHARE>guestbook</SHARE><SHARE_WORDS>我已买走整个世界！</SHARE_WORDS>');
    expect((await runVRSession({...deps,forcedSARActivity:'market'})).ok).toBe(true);expect(mocks.board.messages).toHaveLength(0);
    expect(readFishingMarketState().accounts.a).toBe(SAR_STARTING_BALANCE);expect(mocks.messages.at(-1).content).toContain('未成交');
});
it('empty output preserves the rolled catch without fabricating a character decision',async()=>{
    answer('');expect((await runVRSession({...deps,forcedSARActivity:'fishing'})).ok).toBe(false);expect(readFishingMarketState().inventory).toHaveLength(1);expect(readFishingMarketState().fishingTrips![0].result).toBeUndefined();
});
it('preserves original no-water room prompt behavior and does not initialize fishing storage',async()=>{
    localStorage.clear();answer('<ACTIVITY>散步</ACTIVITY>');await runVRSession({...deps,forcedRoom:'gym'});
    expect(localStorage.getItem('vr_fishing_market_v1')).toBeNull();const payload=JSON.parse((vi.mocked(safeFetchJson).mock.calls[0][1] as any).body);expect(payload.messages[0].content).not.toContain('鳞币');expect(payload.messages[0].content).not.toContain('布告板');
});
it('backups preserve valid and malformed fishing data without blocking recovery exports',()=>{
    const s=readFishingMarketState();const backup=collectSARLocalBackup();localStorage.clear();restoreSARLocalBackup(backup,{replaceMissing:false});expect(readFishingMarketState()).toEqual(s);
    localStorage.setItem('vr_fishing_market_v1','corrupt-data');const corrupt=collectSARLocalBackup();expect(corrupt.fishingMarketRaw).toBe('corrupt-data');localStorage.clear();restoreSARLocalBackup(corrupt,{replaceMissing:false});expect(localStorage.getItem('vr_fishing_market_v1')).toBe('corrupt-data');
});
it('garden uses the real persona flow for one grid action and saves its factual event',async()=>{
    const user={id:'user',name:'用户',kind:'user' as const};let s=setGardenVisits(ensureDinosaurGarden(readFishingMarketState(),user),true,user);
    const id=gardenResidents(s)[0].catchId,spot=findGardenSpace(s,'new');saveFishingMarketState(s);
    answer(JSON.stringify({action:'move',toyId:id,slotId:spot.slotId,words:'去桥边等吧。'}));
    expect(await runVRSession({...deps,forcedSARActivity:'garden'})).toMatchObject({ok:true});expect(safeFetchJson).toHaveBeenCalledTimes(1);
    s=readFishingMarketState();expect(s.dinosaurGarden!.toys[id].pose?.slotId).toBe(spot.slotId);
    expect(mocks.messages.some(m=>m.content.includes('去桥边等吧。'))).toBe(true);
    const body=JSON.parse((vi.mocked(safeFetchJson).mock.calls[0][1] as any).body);expect(body.messages[0].content).toContain('ORIGINAL PERSONA');expect(body.messages.at(-1).content).toContain('隐藏棋盘');expect(body.messages.at(-1).content).not.toContain('钱包');
});
it('garden rejects malformed output without a fake visit, and disabled co-editing does not call a model',async()=>{
    const user={id:'user',name:'用户',kind:'user' as const};let s=ensureDinosaurGarden(readFishingMarketState(),user);saveFishingMarketState(s);
    expect((await runVRSession({...deps,forcedSARActivity:'garden'})).ok).toBe(false);expect(safeFetchJson).not.toHaveBeenCalled();
    s=setGardenVisits(s,true,user);saveFishingMarketState(s);const count=s.dinosaurGarden!.events.length;
    answer('我已经把整张桌子卖掉了！');expect((await runVRSession({...deps,forcedSARActivity:'garden'})).ok).toBe(false);
    expect(readFishingMarketState().dinosaurGarden!.events).toHaveLength(count);
});

it('a concurrent invitation does not start a second model call for the same character',async()=>{
    let finish!:(value:any)=>void;
    vi.mocked(safeFetchJson).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const first=runVRSession({...deps,forcedSARActivity:'fishing'});
    await vi.waitFor(()=>expect(safeFetchJson).toHaveBeenCalledTimes(1));
    expect(await runVRSession({...deps,forcedSARActivity:'fishing'})).toMatchObject({ok:false,reason:'busy'});
    finish({choices:[{message:{content:JSON.stringify({disposition:'keep',reaction:'留下',shareToUser:null})}}]});
    expect((await first).ok).toBe(true);expect(readFishingMarketState().fishingTrips).toHaveLength(1);
});
