import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DB} from './db';
import {loadCharacterContextRange} from './chatContextRange';
import {buildChatRequestPayload} from './chatRequestPayload';
import {buildHomeConversationPayload,buildHomeScenePrompt} from './homeConversation';
import {ContextBuilder} from './context';
import {RealtimeContextManager,NotionManager,FeishuManager} from './realtimeContext';
import * as palace from './memoryPalace/pipeline';
import * as plates from './memoryPalace/roomPlates';
import * as schedule from './dailySchedule';
import * as life from './lifeRecords';
import * as cabinet from '../features/collaboration/chatLibrary';
import type {CharacterProfile,UserProfile} from '../types';

beforeEach(()=>{localStorage.clear();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-04T10:00:00Z'));});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();localStorage.clear();});
const scene:any={roomId:'r',roomName:'客厅',present:true,busy:false,activity:'坐着',actions:[]};
const user={name:'小雨'} as UserProfile;

it('compares actual ChatApp and home payloads: all shared blocks and chronological history are identical',async()=>{
 const now=Date.now(),id='home-full-pipeline';
 const records:any[]=[{id:'old',turnId:'old',at:now-4000,actor:'user',kind:'message',source:'user',text:'补录的旧家园原文',roomId:'r',roomName:'客厅'},
 {id:'pending',turnId:'pending',at:now,actor:'user',kind:'message',source:'user',text:'海边关键词：还记得吗',roomId:'r',roomName:'客厅'}];
 const char={id,name:'C',contextRangePolicyVersion:1,contextRangeMode:'manual',contextLimit:50,memoryPalaceEnabled:true,
  chatCollaborationEnabled:true,scheduleFeatureEnabled:true,systemPrompt:'基础人设标记',worldview:'世界观标记',homeDefinition:{kind:'between-worlds',notes:'家园定义标记'},
  mountedWorldbooks:[{id:'constant',title:'常驻',content:'常驻世界书标记',constant:true,position:1},
   {id:'depth',title:'深度',content:'关键词深度世界书标记',constant:false,key:['海边关键词'],position:4,depth:1,role:0}],
  home3D:{records}} as unknown as CharacterProfile;
 await DB.saveMessage({charId:id,role:'user',type:'text',timestamp:now-5000,content:'最早私聊'});
 await DB.saveMessage({charId:id,role:'user',type:'text',timestamp:now-3000,content:'中间见面',metadata:{source:'date'}});
 await DB.saveMessage({charId:id,role:'assistant',type:'text',timestamp:now-1000,content:'原文保留\n%%BILINGUAL%%\n译文剔除'});
 // Saved after chat, but happened earlier: neither entry may mistake its new ID for its time.
 await DB.saveCharacter(char);
 const groups:any[]=[{id:'parity-group',name:'朋友群',members:[id]}];
 await DB.saveMessage({charId:id,groupId:'parity-group',role:'user',type:'text',timestamp:now-1000,content:'群聊背景标记'});
 vi.spyOn(RealtimeContextManager,'buildFullContext').mockResolvedValue('天气热搜标记');
 vi.spyOn(NotionManager,'getRecentDiaries').mockResolvedValue({success:true,entries:[{date:'今天',title:'Notion日记标记'}]} as any);
 vi.spyOn(NotionManager,'getUserNotes').mockResolvedValue({success:true,entries:[{date:'今天',title:'Notion笔记标记'}]} as any);
 vi.spyOn(FeishuManager,'getRecentDiaries').mockResolvedValue({success:true,entries:[{date:'今天',title:'飞书日记标记'}]} as any);
 vi.spyOn(schedule,'getDailyScheduleForChar').mockResolvedValue({slots:[{startTime:'00:00',activity:'日程标记'}]} as any);
 vi.spyOn(life,'buildLifeRecordInjection').mockResolvedValue('生活档案标记');
 vi.spyOn(cabinet,'loadCollaborationFileCabinetBlock').mockResolvedValue('协同文件柜标记');
 const recall=vi.spyOn(palace,'injectMemoryPalace').mockImplementation(async c=>{c.memoryPalaceInjection='记忆召回标记';c.roomPlatesInjection='房间门牌标记';return {stages:[]} as any;});
 const realtimeConfig:any={weatherEnabled:true,newsEnabled:true,notionEnabled:true,notionApiKey:'test',notionDatabaseId:'d',notionNotesDatabaseId:'n',feishuEnabled:true,feishuAppId:'a',feishuAppSecret:'b',feishuBaseId:'c',feishuTableId:'d'};
 const musicSnapshot:any={current:{id:1,name:'共听歌曲标记',artists:'歌手'},playing:true,lyric:[{time:0,text:'共听歌词标记'}],activeLyricIdx:0,listeningTogetherWith:[id],cfg:{}};
 const range=await loadCharacterContextRange(char);
 const chat=await buildChatRequestPayload({ scene: 'chat.private',char,userProfile:user,groups,emojis:[],categories:[],historyMsgs:range.messages,
  recentMsgsHint:range.messages.filter(m=>m.metadata?.source!=='home'),contextLimit:range.messages.length,contextHighWaterMark:range.hwm,
  recallEntryPoint:'chat_app',realtimeConfig,musicSnapshot});
 const home=await buildHomeConversationPayload({char,user,api:{} as any,scene,records,signal:new AbortController().signal,context:{groups,emojis:[],categories:[],realtimeConfig,musicSnapshot}});
 expect(recall.mock.calls[0][1]).toEqual(recall.mock.calls[1][1]);
 expect(recall.mock.calls[1][2]).toBeUndefined();
 expect(home.slice(1,-1)).toEqual(chat.cleanedApiMessages);
 const history=JSON.stringify(chat.cleanedApiMessages);
 expect(history.indexOf('最早私聊')).toBeLessThan(history.indexOf('补录的旧家园原文'));
 expect(history.indexOf('补录的旧家园原文')).toBeLessThan(history.indexOf('中间见面'));
 expect(history).not.toContain('译文剔除');expect(history.match(/关键词深度世界书标记/g)).toHaveLength(1);
 expect(home[0].content).toBe(chat.fullMessages[0].content.split('### 聊天 App 行为规范')[0]);
 expect(home.at(-1)!.content.replace(buildHomeScenePrompt(user,scene),'')).toBe(chat.fullMessages.at(-1)!.content.replace(`\n${ContextBuilder.buildMusicActionGuide(true)}\n`,''));
 for(const marker of ['基础人设标记','世界观标记','家园定义标记','常驻世界书标记','天气热搜标记','Notion日记标记','Notion笔记标记','飞书日记标记','群聊背景标记','日程标记','生活档案标记','协同文件柜标记','记忆召回标记','房间门牌标记','共听歌曲标记','共听歌词标记']){
  expect(JSON.stringify(home),marker).toContain(marker);expect(JSON.stringify(chat.fullMessages),marker).toContain(marker);
 }
 expect(JSON.stringify(home)).not.toContain('Chat App Rules');
 expect(home.at(-1)!.role).toBe('system');
});

it.each(['chat_app','home_3d'] as const)('%s uses interactive recall and reads room plates without embeddings',async entryPoint=>{
 localStorage.setItem('os_memory_palace_config',JSON.stringify({featureFlags:{interactionAdaptation:true,deepEngagement:true}}));
 vi.spyOn(plates,'buildRoomPlatesInjection').mockResolvedValue('无需向量配置的常驻门牌');
 const char:any={id:'recall-'+entryPoint,name:'C',memoryPalaceEnabled:true};
 const trace=await palace.injectMemoryPalace(char,[{id:1,charId:char.id,role:'user',type:'text',content:'我过啦！！！',timestamp:Date.now()}],undefined,'小雨',{entryPoint});
 expect(trace.interactionAdaptation?.status).toBe('observed');
 expect(trace.deepEngagement?.status).not.toBe('out_of_scope');
 expect(trace.stages.some(stage=>stage.name==='room_plates')).toBe(true);
 expect(char.roomPlatesInjection).toBe('无需向量配置的常驻门牌');
 expect(trace.outcome).toBe('skipped_embedding_unconfigured');
});

it('regenerating a backfilled home turn excludes later events even when their IDs are smaller',async()=>{
 const id='home-regenerate-time',at=Date.now();
 const records:any[]=[{id:'turn',turnId:'turn',at:at-1000,actor:'user',kind:'message',source:'user',text:'原问题',roomId:'r',roomName:'客厅'}];
 const char:any={id,name:'C',contextRangePolicyVersion:1,contextRangeMode:'manual',contextLimit:50,home3D:{records}};
 await DB.saveMessage({charId:id,role:'user',type:'text',timestamp:at-2000,content:'过去私聊'});
 await DB.saveMessage({charId:id,role:'user',type:'text',timestamp:at,content:'未来私聊不能泄露'});
 await DB.saveCharacter(char);
 const result=await buildHomeConversationPayload({char,user,api:{} as any,scene,records,regenerating:true,signal:new AbortController().signal});
 const text=JSON.stringify(result);
 expect(text).toContain('过去私聊');expect(text).toContain('原问题');expect(text).not.toContain('未来私聊不能泄露');
});

it('home includes the same live task list and receipts as ChatApp, and acknowledges only a successful reply',async()=>{
 const {ActiveMsgStore}=await import('./activeMsgStore');
 const bridge=await import('./amsg2ToolBridge');
 const {collectAmsg2TaskContext}=await import('./amsg2TaskContext');
 const {generateHomeReply}=await import('./homeConversation');
 vi.spyOn(bridge,'isAmsg2GlobalReady').mockResolvedValue(true);
 const notices:any[]=[{id:'cancelled-one',charId:'home-tasks',kind:'user_cancelled',occurrenceMs:Date.now()-1000,createdAt:Date.now(),mode:'prompted',promptHint:'旧约定',recurrenceType:'none'}];
 vi.spyOn(ActiveMsgStore,'getExpiredNotices').mockResolvedValue(notices);
 const mark=vi.spyOn(ActiveMsgStore,'markExpiredNoticesNotified').mockResolvedValue();
 const records:any[]=[{id:'input',at:Date.now(),actor:'user',kind:'message',source:'user',text:'聊聊之后的安排',roomId:'r',roomName:'客厅'}];
 const char:any={id:'home-tasks',name:'C',activeMsg2Config:{enabled:true,tasks:[{taskUuid:'pending-task',clientTaskId:'pending',mode:'prompted',status:'scheduled',source:'character',firstSendTime:new Date(Date.now()+3600000).toISOString(),recurrenceType:'none',expirePolicy:'expire',promptHint:'之后的约定',createdAt:Date.now()}]}};
 const args:any={char,user,scene,records,api:{baseUrl:'https://test.invalid',model:'test'},signal:new AbortController().signal};
 const expected=await collectAmsg2TaskContext(char,user.name);
 const messages=await buildHomeConversationPayload(args);
 expect(messages.at(-2)?.content).toBe(expected.text);
 expect(messages.at(-1)?.content).toContain('回到你自己');expect(mark).not.toHaveBeenCalled();
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{"choices":[{"message":{"content":"{\\\"text\\\":\\\"好呀\\\"}"}}]}'));
 await generateHomeReply(args);expect(mark).toHaveBeenCalledWith(char.id,expected.expiredIds);
 mark.mockClear();fetcher.mockResolvedValue(new Response('',{status:503}));
 await expect(generateHomeReply(args)).rejects.toThrow('503');expect(mark).not.toHaveBeenCalled();
});

it('home retains SAR module state while using its own JSON output protocol',async()=>{
 const {installSARModuleOnCharacter,installSARModuleOnUser}=await import('./vrWorld/sarModuleRuntime');
 const {SAR_MODULE_CATALOG}=await import('./vrWorld/sarModuleShop');
 const char:any={id:'home-sar',name:'C',vrState:{enabled:true,sarModule:installSARModuleOnCharacter(SAR_MODULE_CATALOG[0],1)}};
 const sarUser:any={...user,vrState:{enabled:true,sarModule:installSARModuleOnUser(SAR_MODULE_CATALOG[1],char,1)}};
 const records:any[]=[{id:'input',at:Date.now(),actor:'user',kind:'message',source:'user',text:'你在做什么',roomId:'r',roomName:'客厅'}];
 const home=await buildHomeConversationPayload({char,user:sarUser,scene,records,api:{} as any,signal:new AbortController().signal});
 const state=ContextBuilder.buildSARModuleContext(char,sarUser,'home');
 expect(state).toContain('SAR 临时模块');
 expect(ContextBuilder.buildSARModuleContext(char,sarUser,'chat')).toContain(state.trim());
 expect(JSON.stringify(home)).toContain('SAR 临时模块');expect(JSON.stringify(home)).not.toContain('<SAR_MODULE_OUTPUT>');
});

it.each([-1,0])('retains ChatApp music context when the active lyric index is %s',async activeLyricIdx=>{
 const id='home-music-parity-'+activeLyricIdx;
 const records:any[]=[{id:'input',at:Date.now(),actor:'user',kind:'message',source:'user',text:'一起听歌',roomId:'r',roomName:'客厅'}];
 const char:any={id,name:'C',home3D:{records}};
 await DB.saveCharacter(char);
 const musicSnapshot:any={current:{id:1,name:'前奏中的歌曲',artists:'歌手'},playing:true,lyric:[{time:10,text:'第一句歌词'}],activeLyricIdx,listeningTogetherWith:[id],cfg:{}};
 const range=await loadCharacterContextRange(char);
 // Reference the existing ChatApp behavior, including the intro before the first lyric.
 const chat=await buildChatRequestPayload({ scene: 'chat.private',char,userProfile:user,groups:[],emojis:[],categories:[],historyMsgs:range.messages,contextLimit:range.messages.length,recallEntryPoint:'chat_app',
  userListeningContext:{songName:musicSnapshot.current.name,artists:'歌手',lyricWindow:activeLyricIdx<0?[]:['第一句歌词'],activeIdx:activeLyricIdx},isListeningTogether:true,musicCfg:musicSnapshot.cfg});
 const home=await buildHomeConversationPayload({char,user,api:{} as any,scene,records,signal:new AbortController().signal,context:{musicSnapshot}});
 expect(home.at(-1)!.content.replace(buildHomeScenePrompt(user,scene),'')).toBe(chat.fullMessages.at(-1)!.content.replace(`\n${ContextBuilder.buildMusicActionGuide(true)}\n`,''));
 expect(JSON.stringify(home)).toContain('前奏中的歌曲');
});
