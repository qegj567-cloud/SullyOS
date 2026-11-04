import {it,expect,vi,afterEach} from 'vitest';
import {runHomeSocialRound} from './homeSocialRound';
import {DB} from './db';
import {generateHomeReply} from './homeConversation';
import type {HomeRecord} from '../apps/room3d/types';
vi.mock('./homeConversation',()=>({generateHomeReply:vi.fn()}));
vi.mock('./homeSecrets',()=>({waitForHomeSecretOrigin:vi.fn(async()=>undefined)}));
afterEach(()=>vi.restoreAllMocks());
function setup(){
 let people=[{id:'A',name:'甲'},{id:'B',name:'乙'},{id:'C',name:'丙'}],records:HomeRecord[]=[{id:'input',at:1,actor:'user',source:'user',kind:'message',text:'大家好',roomId:'r',roomName:'客厅',sharedScene:{homeOwnerId:'A',participantIds:['A','B','C']}}];
 const scene={roomId:'r',roomName:'客厅',present:true,busy:false,actions:[],manualRevision:0};
 vi.spyOn(DB,'getCharacter').mockImplementation(async(id:string)=>({id,name:id,home3D:{records:[]},systemPrompt:id+'私密设定'} as any));
 const editor={getState:()=>({records}),getPresentResidents:()=>people,getHomeScene:()=>scene,getResidentScene:()=>({...scene,participants:people}),showHomeBubble:vi.fn(),performResidentActions:vi.fn(async(id,ids,replyTo)=>{records.push({id:'action-'+id,at:Date.now(),kind:'action',actor:'character',actorId:id,source:'model',text:'走过来了',replyTo,roomId:'r',roomName:'客厅'});return 'completed';})};
 const controller=new AbortController();const args={editor:editor as any,owner:{id:'A'} as any,user:{} as any,api:{} as any,inputId:'input',signal:controller.signal,onStage:vi.fn(),commit:(next:HomeRecord[])=>{records=next;}};
 return {args,records:()=>records,leave:()=>{people=people.filter(p=>p.id!=='B');},controller,editor};
}
it('calls one own context at a time and includes earlier speech and actual actions',async()=>{
 const s=setup(),calls:string[]=[];vi.mocked(generateHomeReply).mockImplementation(async args=>{calls.push(args.char.id);expect(args.char.systemPrompt).toBe(args.char.id+'私密设定');if(args.char.id==='B')expect(args.liveSceneEvents?.some(r=>r.id==='action-A')).toBe(true);return {text:args.char.id+'说话',actionIds:args.char.id==='A'?['walk']:[]};});
 await runHomeSocialRound(s.args);expect(calls).toEqual(['A','B','C']);const replies=s.records().filter(r=>r.kind==='message'&&r.source==='model');expect(replies.map(r=>r.actorId)).toEqual(['A','B','C']);expect(replies.every(r=>r.sharedScene?.participantIds.join()==='A,B,C')).toBe(true);
});
it('retry resumes after committed speakers without duplicate speech',async()=>{
 const s=setup();let failed=false;vi.mocked(generateHomeReply).mockImplementation(async args=>{if(args.char.id==='B'&&!failed){failed=true;throw Error('API 失败');}return {text:args.char.id};});
 await expect(runHomeSocialRound(s.args)).rejects.toThrow('API 失败');await runHomeSocialRound(s.args);expect(s.records().filter(r=>r.source==='model').map(r=>r.actorId)).toEqual(['A','B','C']);
});
it('discards a reply if someone leaves during its generation',async()=>{
 const s=setup();vi.mocked(generateHomeReply).mockImplementation(async()=>{s.leave();return {text:'过期回复'};});await expect(runHomeSocialRound(s.args)).rejects.toThrow('成员');expect(s.records()).toHaveLength(1);
});
it('records silence without inventing speech or launching another turn',async()=>{
 const s=setup();vi.mocked(generateHomeReply).mockResolvedValue({silent:true,text:'',actionIds:[]});await runHomeSocialRound(s.args);expect(s.records().slice(1).every(r=>r.kind==='presence')).toBe(true);expect(s.editor.showHomeBubble).not.toHaveBeenCalled();
});
