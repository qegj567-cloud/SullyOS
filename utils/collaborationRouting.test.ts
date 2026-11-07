import { afterEach, expect, it, vi } from 'vitest';
import { buildLiveCollaborationChatContext } from '../features/collaboration/context';
import { runCollaborationTurn } from '../features/collaboration/engine';
import { ActiveMsgClient } from './activeMsgClient';
import { clearInstantChatPending, getInstantChatPending, setInstantChatPending } from './amsgInstantChat';
import { DB } from './db';
import type { CharacterProfile, Message } from '../types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); clearInstantChatPending('cowork-route'); });

it('沉浸式协同只调用专用 API；已有云端私聊仍属于私聊，不带回手机聊天输出规则', async () => {
    const char = { id:'cowork-route',name:'角色',avatar:'',description:'',systemPrompt:'角色核心设定',memories:[],
        contextRangeMode:'manual',contextRangePolicyVersion:1,contextLimit:20,timeAwarenessEnabled:false,
        scheduleFeatureEnabled:false,memoryPalaceEnabled:false,showThinkingChain:true,
        activeMsg2Config:{enabled:true},dialogueApi:{baseUrl:'https://chat.example/v1',apiKey:'chat-key',model:'chat-model'} } as CharacterProfile;
    const history = [
        {id:1,charId:char.id,role:'assistant',type:'text',content:'之前面对面谈过贺卡',timestamp:1,metadata:{source:'date'}},
        {id:2,charId:char.id,role:'user',type:'text',content:'吹风机只有 50W',timestamp:2},
    ] as Message[];
    setInstantChatPending(char.id, 'existing-private-request');
    const cloud = vi.spyOn(ActiveMsgClient, 'sendInstantChat');
    const save = vi.spyOn(DB, 'saveMessage');
    const request = vi.fn(async () => Response.json({choices:[{message:{content:'这是贺卡文件。'}}]}));
    vi.stubGlobal('fetch', request);
    const context = await buildLiveCollaborationChatContext({ char,user:{name:'小明'} as any,groups:[],emojis:[],categories:[],recentChatMessages:history,chatContextLimit:2 });
    await runCollaborationTurn({ profile:{baseUrl:'https://cowork.example/v1',apiKey:'cowork-key',model:'cowork-model',stream:false,temperature:.85},
        ...context,characterId:char.id,userName:'小明',messages:[{id:'task',sessionId:'work',role:'user',content:'设计贺卡网页',createdAt:3}] });
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cowork.example/v1/chat/completions');
    expect(options.headers).toMatchObject({ Authorization:'Bearer cowork-key' });
    const body = JSON.parse(options.body as string);
    expect(body.model).toBe('cowork-model');
    const text = JSON.stringify(body.messages);
    expect(text).toContain('角色核心设定');
    expect(text).toContain('吹风机只有 50W');
    expect(text).toContain('设计贺卡网页');
    expect(text).toContain('协同工作规则');
    expect(text).not.toContain('TOP 1｜ChatApp 格式');
    expect(text).not.toContain('现在已经回到 ChatApp 的文字聊天界面');
    expect(text).not.toContain('[schedule_message]');
    expect(cloud).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(getInstantChatPending(char.id)?.uuid).toBe('existing-private-request');
});
