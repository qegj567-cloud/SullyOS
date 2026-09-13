import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {CharacterProfile} from '../types';
import {rollMarketVisitor} from './vrWorld/marketRefresh';
import {createFishingMarketState,createRequest,ensureActorAccounts,createListing,saveFishingMarketState,readFishingMarketState} from './vrWorld/fishingMarket';
import {prepareMarketNPCs,parseMarketNPCs,applyMarketNPCs,rollMarketNPCs} from './vrWorld/marketNPCs';
vi.mock('./safeApi',()=>({safeFetchJson:vi.fn()}));
vi.mock('./vrWorld/vrApi',()=>({getVRApi:vi.fn(async()=>null),logVRApiCall:vi.fn(async()=>{})}));
import {safeFetchJson} from './safeApi';
import {getVRApi} from './vrWorld/vrApi';
import {runMarketNPCSession} from './vrWorld/marketNPCSession';
const user={id:'user',name:'我',kind:'user' as const};
const roster=[{id:'off',vrState:{enabled:false}},{id:'manual',vrState:{enabled:true,activityMode:'manual'}},{id:'roaming',vrState:{enabled:true,activityMode:'scheduled'}}] as CharacterProfile[];
const initial=()=>ensureActorAccounts(createFishingMarketState(42),[user]);
const dialogue=(ids:string[])=>[{actorId:ids[0],action:'post',ref:'n1',title:'鱼贩请回答',words:'隔壁昨天说鱼会自己砍价，现在还作数吗？'},...ids.slice(1).map(actorId=>({actorId,action:'comment',targetId:'n1',words:'你先让鱼开口，我负责记账。'})),{actorId:ids[0],action:'comment',targetId:'n1',words:'它刚吐的那个泡算不算口头报价？'}];
const plan=(snapshot:ReturnType<typeof prepareMarketNPCs>,actions=dialogue(snapshot.visitors.map(v=>v.id)))=>parseMarketNPCs(JSON.stringify({actions}),snapshot);
const replyFor=(options:RequestInit)=>{const scene=JSON.parse(JSON.parse(options.body as string).messages[1].content);return {choices:[{message:{content:JSON.stringify({actions:dialogue(scene.visitors.map((v:any)=>v.id))})}}]};};
const api:any={baseUrl:'https://chat.invalid/v1',apiKey:'test',model:'test'};
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();vi.mocked(getVRApi).mockResolvedValue(null);});
describe('布告板多人路人',()=>{
 it('random visitors respect manual participation and NPC opt-out',()=>{
  expect(rollMarketVisitor(roster,()=>.99)?.id).toBe('roaming');expect(rollMarketVisitor(roster.slice(0,2),()=>.99)).toBeNull();expect(rollMarketVisitor(roster,()=>.1)).toBeNull();
  expect(rollMarketVisitor(roster,()=>.1,false)?.id).toBe('roaming');expect(rollMarketNPCs(()=>.1)).toHaveLength(2);expect(rollMarketNPCs(()=>.9)).toHaveLength(3);
 });
 it('one generated scene creates a post and cross-NPC replies without templates or new wallets',()=>{
  const input={...initial(),accounts:{user:20,'wanderer:0':0}}, frozen=structuredClone(input),snapshot=prepareMarketNPCs(input,()=>.1);
  const result=applyMarketNPCs(input,snapshot,plan(snapshot));expect(result.state.requests[0].body).toContain('隔壁昨天');expect(result.state.requests[0].comments.map(c=>c.authorId)).toEqual(['wanderer:1','wanderer:0']);
  expect(result.state.accounts.user).toBe(20);expect(result.state.accounts['wanderer:0']).toBe(0);expect(input).toEqual(frozen);expect(result.state.inventory).toHaveLength(0);
 });
 it('preserves pending user posts and uses generated actual replies to existing targets',()=>{
  const input=createRequest(initial(),user,undefined,'求问',0,'真的能砍价吗？',Date.now(),'favor'),snapshot=prepareMarketNPCs(input,()=>.1);
  const actions=dialogue(snapshot.visitors.map(v=>v.id));actions[0]={actorId:'wanderer:0',action:'comment',targetId:input.requests[0].id,words:'看鱼愿不愿意。'} as any;actions.forEach(a=>{if('targetId' in a)a.targetId=input.requests[0].id;});
  const state=applyMarketNPCs(input,snapshot,plan(snapshot,actions)).state;expect(state.requests[0].body).toBe('真的能砍价吗？');expect(state.requests[0].comments).toHaveLength(3);expect(snapshot.prompt).toContain('真的能砍价吗');
 });
 it('rejects impersonation, bad refs, excessive actions and multiple transactions before any write',()=>{
  const snapshot=prepareMarketNPCs(initial(),()=>.1),actions=dialogue(snapshot.visitors.map(v=>v.id));
  for(const wrong of [[{...actions[0],actorId:'user'},...actions.slice(1)],[actions[0],{...actions[1],targetId:'invented'},actions[2]],Array(9).fill(actions[1]),[actions[0],actions[1],{...actions[0],ref:'n2'}]])expect(()=>plan(snapshot,wrong)).toThrow();
  expect(()=>parseMarketNPCs('随口一说',snapshot)).toThrow();
 });
 it('rechecks funds and keeps unrelated fresh edits when a purchase can no longer happen',()=>{
  const input=createListing(initial(),user,null,100,'出售空气',Date.now(),'一袋空气'),snapshot=prepareMarketNPCs(input,()=>.1);
  const actions=plan(snapshot,[{actorId:'wanderer:0',action:'buy',targetId:input.listings[0].id,words:'我看看够不够钱。'} as any,{actorId:'wanderer:1',action:'comment',targetId:input.listings[0].id,words:'我围观。'} as any,{actorId:'wanderer:0',action:'comment',targetId:input.listings[0].id,words:'算了再看看。'} as any]);
  const fresh={...input,accounts:{...input.accounts,'wanderer:0':0},research:{unchanged:9}};const result=applyMarketNPCs(fresh,snapshot,actions);
  expect(result.skipped).toHaveLength(1);expect(result.state.accounts.user).toBe(input.accounts.user);expect(result.state.listings[0].status).toBe('open');expect(result.state.listings[0].comments).toHaveLength(2);expect(result.state.research.unchanged).toBe(9);
 });
 it('listing a program-provided catch creates only that catch; an invalid sale leaves no minted fish',()=>{
  const input=initial(),snapshot=prepareMarketNPCs(input,()=>.1),actions=dialogue(snapshot.visitors.map(v=>v.id));
  actions[0]={...actions[0],action:'list',catchId:snapshot.stock[0].id,price:12} as any;
  const result=applyMarketNPCs(input,snapshot,plan(snapshot,actions));expect(result.state.inventory).toHaveLength(1);expect(result.state.listings[0].catchId).toBe(snapshot.stock[0].id);
  actions[0]={...actions[0],catchId:'invented'} as any;expect(()=>applyMarketNPCs(input,snapshot,plan(snapshot,actions))).toThrow();expect(input.inventory).toHaveLength(0);
 });
});
describe('路人一次模型调用',()=>{
 it('uses the Kanata API once for all visitors and logs the call',async()=>{
  vi.mocked(getVRApi).mockResolvedValue({...api,baseUrl:'https://kanata.invalid/v1',model:'kanata'});
  vi.mocked(safeFetchJson).mockImplementation(async(_url,options)=>replyFor(options));saveFishingMarketState(initial());const result=await runMarketNPCSession(api);
  expect(safeFetchJson).toHaveBeenCalledTimes(1);expect(vi.mocked(safeFetchJson).mock.calls[0][0]).toBe('https://kanata.invalid/v1/chat/completions');expect(result.visitors.length).toBeGreaterThanOrEqual(2);expect(result.applied).toBeGreaterThanOrEqual(3);
 });
 it('missing API, API failure and malformed outputs never fall back to fixed posts',async()=>{
  saveFishingMarketState(initial());const before=localStorage.getItem('vr_fishing_market_v1');await expect(runMarketNPCSession()).rejects.toThrow('配置');expect(safeFetchJson).not.toHaveBeenCalled();
  vi.mocked(safeFetchJson).mockRejectedValueOnce(Error('offline'));await expect(runMarketNPCSession(api)).rejects.toThrow('offline');expect(localStorage.getItem('vr_fishing_market_v1')).toBe(before);
  vi.mocked(safeFetchJson).mockResolvedValueOnce({choices:[{message:{content:'我想说句话'}}]});await expect(runMarketNPCSession(api)).rejects.toThrow('格式');expect(localStorage.getItem('vr_fishing_market_v1')).toBe(before);
 });
 it('leaving or switching off NPCs during generation prevents writeback',async()=>{
  saveFishingMarketState(initial());const before=localStorage.getItem('vr_fishing_market_v1'),controller=new AbortController();
  vi.mocked(safeFetchJson).mockImplementation(async(_url,options)=>{controller.abort();return replyFor(options);});await expect(runMarketNPCSession(api,controller.signal)).rejects.toThrow('离开');expect(localStorage.getItem('vr_fishing_market_v1')).toBe(before);
  vi.mocked(safeFetchJson).mockImplementation(async(_url,options)=>{localStorage.setItem('vr_sar_club_state_v1','{"npcPreference":"hide"}');return replyFor(options);});await expect(runMarketNPCSession(api)).rejects.toThrow('关闭');expect(localStorage.getItem('vr_fishing_market_v1')).toBe(before);
 });
 it('blocks duplicate clicks while permitting unrelated updates during generation',async()=>{
  saveFishingMarketState(initial());let finish!:()=>void;vi.mocked(safeFetchJson).mockImplementation(async(_url,options)=>{await new Promise<void>(resolve=>{finish=resolve;});return replyFor(options);});
  const first=runMarketNPCSession(api);await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));await expect(runMarketNPCSession(api)).rejects.toThrow('正在');
  saveFishingMarketState({...readFishingMarketState(),research:{userEdited:7}});finish();await first;expect(readFishingMarketState().research.userEdited).toBe(7);expect(safeFetchJson).toHaveBeenCalledTimes(1);
 });
});
