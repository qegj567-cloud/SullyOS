import {beforeEach,it,expect,vi} from 'vitest';
import {processHomeMemoryAfterSave} from './homeMemoryPostHook';
const m=vi.hoisted(()=>({get:vi.fn(),process:vi.fn(),count:vi.fn(),digest:vi.fn()}));
vi.mock('./db',()=>({DB:{getCharacter:m.get}}));
vi.mock('./memoryPalace/autoArchive',()=>({processNewMessagesWithAutoArchive:m.process}));
vi.mock('./memoryPalace/digestion',()=>({incrementDigestRound:m.count,runCognitiveDigestion:m.digest}));
let seq=0;
const char=()=>({id:'post-'+(++seq),name:'C',memoryPalaceEnabled:true,home3D:{records:[]}} as any);
const event=(id:string,actor='user',kind='message')=>({id,actor,kind,source:actor==='user'?'user':'model',text:'动作或对话',roomId:'r',roomName:'客厅',at:1,...(actor==='character'?{replyTo:'u'}:{})} as any);
const config:any={embedding:{baseUrl:'emb',apiKey:'key'},lightLLM:{baseUrl:'light',model:'model'}};
beforeEach(()=>{vi.clearAllMocks();m.process.mockResolvedValue({stored:0});m.count.mockReturnValue(false);m.get.mockImplementation(async(id:string)=>({id,name:'C',memoryPalaceEnabled:true}));});
it('checks the common waterline after a new persisted turn; model reply counts once and triggers shared digestion',async()=>{const before=char(),input={...before,home3D:{records:[event('u')]}};await processHomeMemoryAfterSave(before,input,config,{} as any,'U');expect(m.process).toHaveBeenCalledWith([],before.id,'C',config.embedding,config.lightLLM,'U',false);expect(m.count).not.toHaveBeenCalled();const after={...input,home3D:{records:[event('u'),event('c','character')]}};m.count.mockReturnValue(true);await processHomeMemoryAfterSave(input,after,config,{} as any,'U');await processHomeMemoryAfterSave(input,after,config,{} as any,'U');expect(m.process).toHaveBeenCalledTimes(2);expect(m.count).toHaveBeenCalledTimes(1);expect(m.digest).toHaveBeenCalledTimes(1);});
it('edits do not trigger processing; a new action segment only checks the threshold, never counts as dialogue',async()=>{const before=char();before.home3D.records=[event('u'),event('c','character')];const edited={...before,home3D:{records:[event('u'),{...event('c','character'),text:'编辑'}]}};await processHomeMemoryAfterSave(before,edited,config,{} as any,'U');expect(m.process).not.toHaveBeenCalled();const after={...edited,home3D:{records:[...edited.home3D.records,event('a','character','action')]}};await processHomeMemoryAfterSave(edited,after,config,{} as any,'U');expect(m.process).toHaveBeenCalledOnce();expect(m.count).not.toHaveBeenCalled();const continued={...after,home3D:{records:[...after.home3D.records,event('a2','character','action')]}};await processHomeMemoryAfterSave(after,continued,config,{} as any,'U');expect(m.process).toHaveBeenCalledOnce();});
it('uses latest enabled state and skips missing embedding configuration',async()=>{const a=char();m.get.mockResolvedValue({...a,memoryPalaceEnabled:false});await processHomeMemoryAfterSave(a,{...a,home3D:{records:[event('u')]}},config,{} as any,'U');const b=char();m.get.mockResolvedValue(b);await processHomeMemoryAfterSave(b,{...b,home3D:{records:[event('u')]}},{},{} as any,'U');expect(m.process).not.toHaveBeenCalled();});
it('rechecks enabled state after processing before cognition',async()=>{const a=char();m.get.mockResolvedValueOnce(a).mockResolvedValueOnce({...a,memoryPalaceEnabled:false});await processHomeMemoryAfterSave(a,{...a,home3D:{records:[event('u'),event('c','character')]}},config,{} as any,'U');expect(m.process).toHaveBeenCalledTimes(1);expect(m.count).not.toHaveBeenCalled();});
it('checks every shared participant’s own memory pipeline and only counts their own model speech as a reply',async()=>{
 const a=char(),b=char(),c=char();
 const participants=[a.id,b.id,c.id];
 const records=[a,b,c].map((actor,index)=>({...event('shared-'+actor.id,'character',index===0?'message':'action'),
  actorId:actor.id,actorName:actor.name,sharedScene:{homeOwnerId:b.id,participantIds:participants},
 }));
 await processHomeMemoryAfterSave(b,{...b,home3D:{records}},config,{} as any,'U');
 expect(m.process.mock.calls.map(call=>call[1]).sort()).toEqual([...participants].sort());
 expect(m.count.mock.calls).toEqual([[a.id]]);
 await processHomeMemoryAfterSave(b,{...b,home3D:{records}},config,{} as any,'U');
 expect(m.process).toHaveBeenCalledTimes(3);
});
