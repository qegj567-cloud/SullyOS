import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {CharacterProfile} from '../types';
import {rollMarketVisitor} from './vrWorld/marketRefresh';
import {createFishingMarketState,createRequest,ensureActorAccounts,createListing,saveFishingMarketState,readFishingMarketState} from './vrWorld/fishingMarket';
import {prepareMarketNPCs,parseMarketNPCs,applyMarketNPCs,rollMarketNPCs} from './vrWorld/marketNPCs';
vi.mock('./safeApi',async importOriginal=>({...await importOriginal<typeof import('./safeApi')>(),safeFetchJson:vi.fn()}));
vi.mock('./vrWorld/vrApi',()=>({getVRApi:vi.fn(async()=>null),logVRApiCall:vi.fn(async()=>{})}));
import {safeFetchJson} from './safeApi';
import {getVRApi,logVRApiCall} from './vrWorld/vrApi';
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
 it('accepts one explicit action per visitor on a two-person visit',()=>{
  const snapshot=prepareMarketNPCs(initial(),()=>.1), actions=dialogue(snapshot.visitors.map(v=>v.id)).slice(0,2);
  expect(plan(snapshot,actions)).toHaveLength(2);
 });
 it('rejects impersonation, bad refs, excessive actions and duplicate references before any write',()=>{
  const snapshot=prepareMarketNPCs(initial(),()=>.1),actions=dialogue(snapshot.visitors.map(v=>v.id));
  for(const wrong of [[{...actions[0],actorId:'user'},...actions.slice(1)],[actions[0],{...actions[1],targetId:'invented'},actions[2]],Array(9).fill(actions[1]),[actions[0],actions[1],{...actions[0],ref:'n1'}]])expect(()=>plan(snapshot,wrong)).toThrow();
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

 it('accepts wrapped JSON, trailing commas and raw newlines without changing quoted text',()=>{
   const snapshot=prepareMarketNPCs(initial(),()=>.1), actions=dialogue(snapshot.visitors.map(v=>v.id));
   actions[0].words='原文 ,} 保留';
   const json=JSON.stringify({actions});
   const text='以下是本轮内容：\n'+json.slice(0,-1)+',}\n完毕';
   expect(parseMarketNPCs(text,snapshot)[0].words).toBe('原文 ,} 保留');
   const raw=json.replace('原文 ,} 保留','第一行\n第二行');
   expect(parseMarketNPCs(raw,snapshot)[0].words).toBe('第一行\n第二行');
   expect(()=>parseMarketNPCs(json.slice(0,-2),snapshot)).toThrow('JSON');
 });
 it('preserves authoritative existing personas when the model rephrases them',()=>{
   const snapshot=prepareMarketNPCs(initial(),()=>.1);
   snapshot.visitors[0].persona={name:'原名',identity:'原身份'};
   const data={personas:[{actorId:snapshot.visitors[0].id,name:'改名',identity:'改写'}],actions:dialogue(snapshot.visitors.map(v=>v.id))};
   expect(parseMarketNPCs(JSON.stringify(data),snapshot)[0].persona).toEqual({name:'原名',identity:'原身份'});
 });
 it('records malformed responses as failures rather than successful visits',async()=>{
   saveFishingMarketState(initial());
   vi.mocked(safeFetchJson).mockResolvedValueOnce({choices:[{message:{content:'不是 JSON'}}]});
   await expect(runMarketNPCSession(api)).rejects.toThrow('JSON');
   expect(logVRApiCall).toHaveBeenLastCalledWith(expect.objectContaining({ok:false,error:expect.stringContaining('JSON')}));
 });
 it('accepts text content blocks but never applies length-truncated responses',async()=>{
   saveFishingMarketState(initial());
   vi.mocked(safeFetchJson).mockImplementationOnce(async(_url,options)=>{const data=replyFor(options!);return {choices:[{message:{content:[{type:'text',text:data.choices[0].message.content}]}}]};});
   await expect(runMarketNPCSession(api)).resolves.toMatchObject({applied:expect.any(Number)});
   const before=localStorage.getItem('vr_fishing_market_v1');
   vi.mocked(safeFetchJson).mockImplementationOnce(async(_url,options)=>{const data=replyFor(options!);return {choices:[{...data.choices[0],finish_reason:'length'}]};});
   await expect(runMarketNPCSession(api)).rejects.toThrow('截断');
   expect(localStorage.getItem('vr_fishing_market_v1')).toBe(before);
 });

 it.each([
  ['target', 'targetId'], ['price', 'price'],
 ])('identifies the exact seventh action failure: %s', (kind, expected) => {
   const snapshot=prepareMarketNPCs(initial(),()=>.1),ids=snapshot.visitors.map(v=>v.id);
   const actions:any[]=dialogue(ids);
   while(actions.length<6)actions.push({actorId:ids[1],action:'comment',targetId:'n1',words:'有效回复'});
   const bad=kind==='target'?{actorId:ids[1],action:'comment',targetId:'unknown',words:'正文'}:{actorId:ids[1],action:'list',ref:'n2',title:'标题',words:'正文',price:'10'};
   actions.push(bad);
   expect(()=>plan(snapshot,actions)).toThrow('动作 7');
   expect(()=>plan(snapshot,actions)).toThrow(expected);
   try{plan(snapshot,actions)}catch(error){expect(String(error)).not.toContain('密密密');}
 });

 it('keeps long public text, titles and replies instead of rejecting or truncating them',()=>{
   const snapshot=prepareMarketNPCs(initial(),()=>.1),actions=dialogue(snapshot.visitors.map(v=>v.id));
   const long='长正文'.repeat(700)+'结尾保留';
   if(!('title' in actions[0]))throw Error('expected post');
   actions[0].words=long;actions[0].title='长标题'.repeat(30);
   actions[1].words=long;
   const result=applyMarketNPCs(initial(),snapshot,plan(snapshot,actions));
   expect(result.state.requests[0].body).toBe(long);
   expect(result.state.requests[0].itemLabel).toBe(actions[0].title);
   expect(result.state.requests[0].comments[0].content).toBe(long);
 });

 it('exposes only the current failed response in memory and never persists its text',async()=>{
   saveFishingMarketState(initial());const original='原始返回，不是JSON\n第二行';
   vi.mocked(safeFetchJson).mockResolvedValueOnce({choices:[{message:{content:original},finish_reason:'stop'}],usage:{prompt_tokens:12}});
   let caught:any;try{await runMarketNPCSession(api)}catch(e){caught=e}
   const record=vi.mocked(logVRApiCall).mock.calls.at(-1)![0];
   expect(record.ok).toBe(false);expect(record).not.toHaveProperty('responseText');
   expect(JSON.parse(caught.responseText).content).toBe(original);
   expect(caught.responseText).not.toContain('Authorization');expect(caught.responseText).not.toContain(api.baseUrl);
   expect(localStorage.getItem('vr_fishing_market_v1')).not.toContain(original);
 });

 it('allows the reported combination of a free encounter followed by a fish listing from the same visitor',()=>{
   const input=initial(),snapshot=prepareMarketNPCs(input,()=>.1),[a,b]=snapshot.visitors.map(v=>v.id);
   const fish=snapshot.stock.find(c=>c.ownerId===a)!;
   const actions=parseMarketNPCs(JSON.stringify({personas:[{actorId:a,name:'路人甲',identity:'卖鱼的'},{actorId:b,name:'路人乙',identity:'围观的'}],actions:[
      {actorId:a,action:'encounter',ref:'n1',mode:'free',price:0,title:'免费鉴定',words:'来看看。',event:{story:'{{participant}}发现这是赠品鳞片。'}},
      {actorId:b,action:'comment',targetId:'n1',words:'我看看。'},
      {actorId:a,action:'list',ref:'n2',catchId:fish.id,price:30,title:'挂售鱼获',words:'这条三十。'},
   ]}),snapshot);
   const result=applyMarketNPCs(input,snapshot,actions);
   expect(result.applied).toBe(3);expect(result.skipped).toEqual([]);
   expect(result.state.listings).toHaveLength(2);
   expect(result.state.listings[0].encounter).toBeDefined();
   expect(result.state.listings[1].catchId).toBe(fish.id);
   expect(result.state.accounts.user).toBe(input.accounts.user);
   // A second attempt to list the same stock is rejected by the real market executor.
   const duplicate=applyMarketNPCs(input,snapshot,[...actions,{...actions[2],ref:'n3'}]);
   expect(duplicate.applied).toBe(3);expect(duplicate.skipped).toHaveLength(1);
   expect(duplicate.state.listings).toHaveLength(2);
 });
