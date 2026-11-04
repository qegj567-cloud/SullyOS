import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {DB} from './db';
import {HOME_VISITS_KEY,requestHomeVisit,readHomeVisits,decideHomeVisit,reconcileHomeVisits,claimHomeVisit,releaseHomeVisit,presentHomeVisit,homeVisitPrompt,cancelHomeVisit,submitScheduleHomeVisits} from './homeVisits';
import {consumeHomeVisitReply} from './homeVisitReply';
import {classifyLLMOutput} from '../worker/amsg/src/classifier';
import {homeRelation,homeSocialPair,homeSocialRelationPrompt} from './homeSocialRelations';
import type {CharacterProfile} from '../types';
const chars=['visit-a','visit-b','visit-c'].map(id=>({id,name:id,avatar:'',description:'',memories:[],home3D:{version:1,rooms:[{id:'r',name:'客厅',x:0,z:0,level:0,items:[]}],activeRoomId:'r'}} as unknown as CharacterProfile));
const [a,b,c]=chars;const now=()=>Date.now();
const input=(extra:Record<string,unknown>={})=>({guestId:a.id,hostId:b.id,startsAt:now()+60000,endsAt:now()+3600000,purpose:'坐一会儿',...extra});
beforeEach(async()=>{await DB.saveAsset(HOME_VISITS_KEY,JSON.stringify({version:1,visits:[]}));for(const char of chars)await DB.saveCharacter(char);});
afterEach(()=>vi.restoreAllMocks());
it('resolves real contacts by ID, keeps one-way affinity and honors either-side blocks',()=>{
 const first={...a,phoneState:{contacts:[{kind:'npc',name:b.name,status:'friend',affinity:99},{kind:'real',linkedCharId:b.id,status:'friend',affinity:75}]}} as any;
 expect(homeRelation(a,b.id).known).toBe(false);expect(homeSocialPair(first,b).forward.affinity).toBe(75);expect(homeSocialPair(first,b).backward.known).toBe(false);
 const second={...b,phoneState:{contacts:[{kind:'real',linkedCharId:a.id,status:'blocked',affinity:90}]}} as any;
 expect(homeSocialPair(first,second).approach).toBe(0);expect(JSON.stringify(homeSocialRelationPrompt(first,[{id:b.id,name:b.name}]))).not.toContain('blocked');
});
it('is idempotent and serializes competing overlapping requests',async()=>{
 const data=input();const pair=await Promise.all([requestHomeVisit(data),requestHomeVisit(data)]);expect(pair[0].id).toBe(pair[1].id);
 await expect(requestHomeVisit({...data,hostId:c.id})).rejects.toThrow('冲突');expect(await readHomeVisits()).toHaveLength(1);
});
it('only the host can decide before the deadline; refusal survives reconciliation',async()=>{
 const v=await requestHomeVisit(input());expect(await decideHomeVisit(a.id,v.id,true)).toBe(false);expect(await decideHomeVisit(b.id,v.id,false)).toBe(true);
 expect((await reconcileHomeVisits(v.startsAt))[0].status).toBe('declined');
});
it('auto-approves at the deadline without inventing arrival and expires without an offline record',async()=>{
 const v=await requestHomeVisit(input());expect(await decideHomeVisit(b.id,v.id,true,v.startsAt)).toBe(false);
 const [accepted]=await reconcileHomeVisits(v.startsAt);expect(accepted).toMatchObject({status:'accepted',automatic:true});expect(presentHomeVisit([accepted],a.id,v.startsAt)).toBeUndefined();
 expect((await reconcileHomeVisits(v.endsAt))[0].status).toBe('done');
});
it('leases a live arrival to one scene, recovers from expiry, and releases on exit',async()=>{
 const v=await requestHomeVisit(input({startsAt:now()-1}));await reconcileHomeVisits();expect(await claimHomeVisit(v.id,'tab-a')).toBe(true);expect(await claimHomeVisit(v.id,'tab-b',true)).toBe(false);
 expect(presentHomeVisit(await readHomeVisits(),a.id)).toBeUndefined();expect(await claimHomeVisit(v.id,'tab-a',true)).toBe(true);expect(presentHomeVisit(await readHomeVisits(),a.id)?.id).toBe(v.id);
 expect(presentHomeVisit(await readHomeVisits(),a.id,now()+16000)).toBeUndefined();await releaseHomeVisit(v.id,'tab-b');expect(presentHomeVisit(await readHomeVisits(),a.id)).toBeTruthy();await releaseHomeVisit(v.id,'tab-a');expect(presentHomeVisit(await readHomeVisits(),a.id)).toBeUndefined();
});
it('cancels blocked pairs and invalidates stale approval commands',async()=>{
 const v=await requestHomeVisit(input());await DB.saveCharacter({...b,phoneState:{contacts:[{id:'x',kind:'real',linkedCharId:a.id,status:'blocked',affinity:0}]}} as any);expect((await reconcileHomeVisits())[0].status).toBe('cancelled');expect(await decideHomeVisit(b.id,v.id,true)).toBe(false);
});
it('reclaims an expired lease without declaring arrival before the avatar loads',async()=>{
 const v=await requestHomeVisit(input({startsAt:now()-1}));await reconcileHomeVisits();await claimHomeVisit(v.id,'old-tab',true);
 const rows=await readHomeVisits();rows[0].presenceUntil=now()-1;await DB.saveAsset(HOME_VISITS_KEY,JSON.stringify({version:1,visits:rows}));
 expect(await claimHomeVisit(v.id,'new-tab')).toBe(true);expect(presentHomeVisit(await readHomeVisits(),a.id)).toBeUndefined();
 await claimHomeVisit(v.id,'new-tab',true);expect(presentHomeVisit(await readHomeVisits(),a.id)).toBeTruthy();
 const [expired]=await reconcileHomeVisits(now()+16000);expect(expired.status).toBe('accepted');expect(expired.session).toBeUndefined();expect(expired.presenceUntil).toBeUndefined();
});
it('prompts only the addressed host and consumes only strict complete commands',async()=>{
 const v=await requestHomeVisit(input());expect(await homeVisitPrompt(a)).toBe('');expect(await homeVisitPrompt(b)).toContain(v.id);
 await consumeHomeVisitReply(b.id,'[[HOME_VISIT_REPLY:{"id":"'+v.id+'","accept":true');expect((await readHomeVisits())[0].status).toBe('pending');
 await consumeHomeVisitReply(a.id,'[[HOME_VISIT_REPLY:'+JSON.stringify({id:v.id,accept:true})+']]');expect((await readHomeVisits())[0].status).toBe('pending');
 await expect(consumeHomeVisitReply(b.id,'[[HOME_VISIT_REPLY:'+JSON.stringify({id:v.id,accept:'false'})+']]')).rejects.toThrow('明确');
 expect(await consumeHomeVisitReply(b.id,JSON.stringify({text:'来吧',homeVisitReplies:[{id:v.id,accept:true}]}))).toBe('{"text":"来吧"}');expect((await readHomeVisits())[0].status).toBe('accepted');
});
it('keeps reasoning commands inert and worker commands out of ordinary chat text',async()=>{
 const v=await requestHomeVisit(input()),tag='[[HOME_VISIT_REPLY:'+JSON.stringify({id:v.id,accept:true})+']]';await consumeHomeVisitReply(b.id,'<think>'+tag+'</think>等等');expect((await readHomeVisits())[0].status).toBe('pending');
 const result=classifyLLMOutput('来吧'+tag);expect(result.kind).toBe('finish');if(result.kind==='finish'){expect(result.cleanedText).toBe('来吧');expect(result.directives).toContainEqual({type:'home_visit_reply',action:{id:v.id,accept:true}});}
});
it('supports either participant cancelling and rejects invalid clocks',async()=>{
 const v=await requestHomeVisit(input());expect(await cancelHomeVisit(c.id,v.id)).toBe(false);expect(await cancelHomeVisit(a.id,v.id)).toBe(true);
 await expect(submitScheduleHomeVisits(a,'2026-10-26',[{hostId:b.id,startTime:'25:00',endTime:'26:00',purpose:'拜访'}])).rejects.toThrow('时间格式');
});
