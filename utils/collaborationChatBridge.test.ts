import { describe, expect, it } from 'vitest';
import { DB } from './db';
import { loadCollaborationChatHistory, selectCollaborationTransfer } from '../features/collaboration/chatBridge';
import type { CharacterProfile } from '../types';
import type { CollaborationMessage } from '../features/collaboration/types';

describe('协同实时私聊与选择转发',()=>{
  it('10/20/跟随范围每轮重新读库，遵守用户断点，不读其他角色和群聊',async()=>{
    const char={id:'bridge-char',name:'测试',contextLimit:100,contextRangeMode:'manual',contextRangePolicyVersion:1} as CharacterProfile;
    await DB.saveCharacter(char);
    const ids:number[]=[];
    for(let i=0;i<25;i++)ids.push(await DB.saveMessage({charId:char.id,role:'user',type:'text',content:'要求'+i}));
    await DB.saveMessage({charId:'other',role:'user',type:'text',content:'别人'});
    await DB.saveMessage({charId:char.id,groupId:'group',role:'user',type:'text',content:'群聊'});
    expect((await loadCollaborationChatHistory(char,10)).messages).toHaveLength(10);
    expect((await loadCollaborationChatHistory(char,20)).messages).toHaveLength(20);
    await DB.saveMessage({charId:char.id,role:'user',type:'text',content:'最新修改要求'});
    expect((await loadCollaborationChatHistory(char,10)).messages.at(-1)?.content).toBe('最新修改要求');
    await DB.saveCharacter({...char,contextUserStartMessageId:ids[23]});
    for(const choice of ['configured',20] as const){
      const result=await loadCollaborationChatHistory(char,choice);
      expect(result.messages.map(m=>m.content)).toEqual(['要求23','要求24','最新修改要求']);
    }
    expect((await loadCollaborationChatHistory(char,0)).messages).toEqual([]);
    await DB.saveCharacter({...char,autoArchiveEnabled:true,contextRangeMode:'adaptive'});
    localStorage.setItem('mp_lastMsgId_'+char.id,'9999999');
    expect((await loadCollaborationChatHistory(char,'configured')).messages).toEqual([]);
    localStorage.removeItem('mp_lastMsgId_'+char.id);
  });
  it('只转发选中且属于本窗口的正文和附件，保留顺序，不包含思考过程',()=>{
    const messages:CollaborationMessage[]=[
      {id:'one',sessionId:'a',role:'user',content:'第一条',createdAt:1},
      {id:'two',sessionId:'a',role:'assistant',content:'第二条',createdAt:2,thinkingChain:'不要转发思考'},
      {id:'other',sessionId:'b',role:'assistant',content:'其他窗口',createdAt:3},
    ] as CollaborationMessage[];
    expect(selectCollaborationTransfer(messages,'a',new Set())).toEqual([]);
    const selected=selectCollaborationTransfer(messages,'a',new Set(['two','other']));
    expect(selected).toEqual([{role:'assistant',type:'text',content:'第二条',timestamp:2}]);
    expect(selectCollaborationTransfer(messages,'a',new Set(['two','one'])).map(m=>m.content)).toEqual(['第一条','第二条']);
  });
});
