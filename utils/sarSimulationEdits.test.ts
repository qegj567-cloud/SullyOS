import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { safeFetchJson } from './safeApi';
import { buildSARArchiveMarkdown, deleteSARIdentityCard, loadSARSimulationMessages, parseSARSimulationReply, readSARSimulationState, runSARSimulationTurn, startSARSimulationRun, SAR_SIMULATION_STORAGE_KEY } from './vrWorld/sarSimulation';
import { findSARPendingReply, replaceSARSimulationReply, replaceSARSimulationUserMessage, resolveSARReplyRetry } from './vrWorld/sarSimulationEdits';
vi.mock('./safeApi', () => ({ safeFetchJson: vi.fn() }));
vi.mock('./vrWorld/vrApi', () => ({ getVRApi: async () => null, logVRApiCall: vi.fn() }));
let serial=0;
async function seed(completed=false) {
    const id='edit-run-'+(++serial);
    const card={id:'card-'+id,charId:'c',charName:'角色',variantId:'variant-01',storyId:'story-01',createdAt:1,updatedAt:1,profile:{title:'故事',identity:'旅人',lifePatch:'经历',relationship:'朋友',steelSeal:'守约',patchCost:'疲惫',behaviorShift:'慢一些',openingScene:'开场',openingLine:'你好',logline:'故事',playerPrompt:'行动'}} as any;
    const run={id,cardId:card.id,status:completed?'archived':'active',interactionsUsed:completed?50:2,maxInteractions:50,createdAt:1,updatedAt:2,...(completed?{archiveReason:'completed',archivedAt:3}:{})} as any;
    localStorage.setItem(SAR_SIMULATION_STORAGE_KEY,JSON.stringify({version:2,cards:[card],runs:[run]}));
    for (let turn=1;turn<=2;turn++) {
        const metadata={source:'sar_simulation',sarRunId:id,sarCardId:card.id,sarTurn:turn};
        await DB.saveMessage({charId:'sar-simulation:'+id,role:'user',type:'text',content:'输入'+turn,metadata});
        await DB.saveMessage({charId:'sar-simulation:'+id,role:'assistant',type:'text',content:'旧回复'+turn,metadata:{...metadata,sarWorldNarration:'旧旁白',sarDirectorState:{sceneFacts:['旧事实'],openThreads:[],offscreenFacts:[],declinedHooks:[],revealedFacts:[]}}});
    }
    return {card,run,char:{id:'c',name:'角色',systemPrompt:'温和',vrState:{api:{baseUrl:'https://example.com',model:'test',apiKey:'test'}}} as any,userProfile:{name:'用户'} as any,apiConfig:{baseUrl:'https://example.com',model:'test',apiKey:'test'} as any,userText:'不应使用的新输入'};
}
beforeEach(()=>{ vi.mocked(safeFetchJson).mockReset(); });

describe('SAR 档案删除与格式容错', () => {
    it('does not truncate a complete escaped JSON reply before parsing; only one request advances one turn', async () => {
        const input = await seed();
        const character = '回'.repeat(3000);
        const raw = JSON.stringify({character}).replace(/回/g, '\\u56de');
        expect(raw.length).toBeGreaterThan(16000);
        vi.mocked(safeFetchJson).mockResolvedValue({choices:[{message:{content:raw}}]});
        const result = await runSARSimulationTurn({...input, userText:'继续'});
        expect(result.reply).toBe(character);
        expect(result.run.interactionsUsed).toBe(3);
        expect(safeFetchJson).toHaveBeenCalledOnce();
        expect(JSON.parse(vi.mocked(safeFetchJson).mock.calls[0][1].body as string).max_tokens).toBe(8000);
    });

    it('accepts tagged content blocks and rejects an unfinished scene without saving or consuming a turn', async () => {
        const input = await seed();
        const before = await loadSARSimulationMessages(input.run.id);
        vi.mocked(safeFetchJson).mockResolvedValueOnce({choices:[{message:{content:'<SAR_SCENE><character>半截</character>'},finish_reason:'length'}]});
        await expect(runSARSimulationTurn(input)).rejects.toThrow('长度上限截断');
        expect(await loadSARSimulationMessages(input.run.id)).toEqual(before);
        expect(readSARSimulationState().runs[0].interactionsUsed).toBe(2);
        vi.mocked(safeFetchJson).mockResolvedValueOnce({choices:[{message:{content:[{type:'text',text:'<SAR_SCENE><character>他抬头："记得。"</character>'},{type:'text',text:'</SAR_SCENE>'}]}}]});
        const result = await runSARSimulationTurn(input);
        expect(result.reply).toBe('他抬头："记得。"');
        expect(result.run.interactionsUsed).toBe(3);
        expect(result.messages).toHaveLength(before.length+2);
    });
    it('删除身份卡及全部实例正文，不动另一张卡和原角色私聊', async () => {
        const input = await seed();
        const state = readSARSimulationState();
        const other = { ...input.card, id: 'other-card' };
        const second = { ...input.run, id: input.run.id + '-second', status: 'archived' };
        localStorage.setItem(SAR_SIMULATION_STORAGE_KEY, JSON.stringify({ ...state, cards: [...state.cards, other], runs: [...state.runs, second] }));
        await DB.saveMessage({ charId: 'sar-simulation:' + second.id, role: 'user', type: 'text', content: '旧旅程', metadata: { source: 'sar_simulation', sarRunId: second.id } });
        const privateId = await DB.saveMessage({ charId: 'c', role: 'user', type: 'text', content: '私聊保留' });
        await deleteSARIdentityCard(input.card.id);
        expect(readSARSimulationState().cards.map(c => c.id)).toEqual(['other-card']);
        expect(readSARSimulationState().runs).toHaveLength(0);
        expect(await loadSARSimulationMessages(input.run.id)).toHaveLength(0);
        expect(await loadSARSimulationMessages(second.id)).toHaveLength(0);
        expect((await DB.getMessagesByCharId('c')).some(m => m.id === privateId)).toBe(true);
    });

    it('清理失败保留可重试档案，并阻止继续生成；重试后完成删除', async () => {
        const input = await seed();
        const clear = vi.spyOn(DB, 'clearMessages').mockRejectedValueOnce(new Error('数据库忙'));
        try {
            await expect(deleteSARIdentityCard(input.card.id)).rejects.toThrow('数据库忙');
            expect(readSARSimulationState().cards[0].deletionPending).toBe(true);
            expect(() => startSARSimulationRun(input.card.id)).toThrow('正在删除');
            await expect(runSARSimulationTurn({ ...input, userText: '继续' })).rejects.toThrow('正在删除');
            expect(safeFetchJson).not.toHaveBeenCalled();
            expect(await loadSARSimulationMessages(input.run.id)).toHaveLength(4);
        } finally { clear.mockRestore(); }
        await deleteSARIdentityCard(input.card.id);
        expect(readSARSimulationState().cards).toHaveLength(0);
        expect(await loadSARSimulationMessages(input.run.id)).toHaveLength(0);
    });

    it('修复字符串里的原始换行与尾逗号，不改正文标点，不混入导演记录', () => {
        expect(parseSARSimulationReply('```json\n{"worldNarration":"雨停了。", "character":"第一行\n第二行 , }", "directorState":{"sceneFacts":["秘密",],},}\n```'))
            .toMatchObject({ worldNarration: '雨停了。', character: '第一行\n第二行 , }' });
        expect(parseSARSimulationReply('{"character":"未写完", "directorState":{"sceneFacts":["秘密"]}')).toBeNull();
        expect(parseSARSimulationReply('{"worldNarration":"只有旁白",}')).toBeNull();
    });
});

describe('SAR 修改自己的消息', () => {
    it('保存换行和修正文案，保持轮数、消息 ID 和后续剧情；导出和重试都读取新文本', async () => {
        const input = await seed();
        const before = await loadSARSimulationMessages(input.run.id);
        const runState = localStorage.getItem(SAR_SIMULATION_STORAGE_KEY);
        await replaceSARSimulationUserMessage(input.run.id, before[0], '修正错字\n第二行');
        const after = await loadSARSimulationMessages(input.run.id);
        expect(after.map(m => m.id)).toEqual(before.map(m => m.id));
        expect(after[0].content).toBe('修正错字\n第二行');
        expect(after[1].content).toBe(before[1].content);
        expect(after[3].content).toBe(before[3].content);
        expect(after[1].metadata.sarDirectorState).toBeUndefined();
        expect(after[3].metadata.sarDirectorState).toBeUndefined();
        expect(resolveSARReplyRetry(after, before[1].id).user.content).toBe('修正错字\n第二行');
        expect(buildSARArchiveMarkdown(input.card, input.run, after, '用户')).toContain('修正错字\n第二行');
        expect(localStorage.getItem(SAR_SIMULATION_STORAGE_KEY)).toBe(runState);
        expect(safeFetchJson).not.toHaveBeenCalled();
        await expect(replaceSARSimulationUserMessage(input.run.id, before[0], '过期覆盖')).rejects.toThrow('已变化');
    });
    it('拒绝空内容、角色回复和其它故事的消息，保持原记录', async () => {
        const input = await seed(); const before = await loadSARSimulationMessages(input.run.id);
        await expect(replaceSARSimulationUserMessage(input.run.id, before[0], '  ')).rejects.toThrow('1 至 4000');
        await expect(replaceSARSimulationUserMessage(input.run.id, before[1], '改角色')).rejects.toThrow('已变化');
        await expect(replaceSARSimulationUserMessage('other-run', before[0], '跨故事')).rejects.toThrow('已变化');
        expect(await loadSARSimulationMessages(input.run.id)).toEqual(before);
    });
});
describe('SAR reply editing and retry',()=>{
    it('edits atomically, preserving ids and following prose while invalidating derived state',async()=>{
        const input=await seed(); const old=await loadSARSimulationMessages(input.run.id);
        await replaceSARSimulationReply(input.run.id,old[1],{content:'修改回复',worldNarration:'修改旁白'});
        const next=await loadSARSimulationMessages(input.run.id);
        expect(next.map(m=>m.id)).toEqual(old.map(m=>m.id));
        expect(next[1].content).toBe('修改回复');expect(next[1].metadata.sarWorldNarration).toBe('修改旁白');
        expect(next[3].content).toBe('旧回复2');expect(next[3].metadata.sarDirectorState).toBeUndefined();
        await expect(replaceSARSimulationReply(input.run.id,old[1],{content:'过期写入'})).rejects.toThrow('已变化');
    });
    it('delete survives reload, export omits deleted reply, retry uses original input and prefix only',async()=>{
        const input=await seed(); const old=await loadSARSimulationMessages(input.run.id);
        await replaceSARSimulationReply(input.run.id,old[1],{content:'',deleted:true});
        const deleted=await loadSARSimulationMessages(input.run.id);
        expect(findSARPendingReply(deleted)?.id).toBe(old[1].id);
        expect(buildSARArchiveMarkdown(input.card,input.run,deleted,'用户')).not.toContain('旧回复1');
        vi.mocked(safeFetchJson).mockResolvedValue({choices:[{message:{content:JSON.stringify({character:'新回复',worldNarration:'新旁白'})}}]});
        const result=await runSARSimulationTurn({...input,retryReplyId:old[1].id});
        expect(result.run.interactionsUsed).toBe(2);expect(result.messages).toHaveLength(4);
        expect(result.messages[1]).toMatchObject({id:old[1].id,content:'新回复'});
        const body=JSON.parse(vi.mocked(safeFetchJson).mock.calls[0][1]!.body as string);
        expect(body.messages.at(-1).content).toContain('输入1');
        expect(JSON.stringify(body.messages)).not.toContain('输入2');
        expect(JSON.stringify(body.messages)).not.toContain('旧回复1');
        expect(JSON.stringify(body.messages)).not.toContain('不应使用的新输入');
    });
    it('keeps the old reply after API failure and rejects template-only output',async()=>{
        const input=await seed();const old=await loadSARSimulationMessages(input.run.id);
        vi.mocked(safeFetchJson).mockRejectedValue(new Error('API失败'));
        let caught: unknown;
        try { await runSARSimulationTurn({...input,retryReplyId:old[3].id}); } catch (error) { caught = error; }
        expect((caught as Error)?.message).toBe('API失败');
        expect(await loadSARSimulationMessages(input.run.id)).toEqual(old);
        expect(parseSARSimulationReply(JSON.stringify({worldNarration:'必要旁白，或空字符串',character:'本轮角色真正呈现给 User 的动作与台词'}))).toBeNull();
    });
    it('can retry an archived run without consuming another turn or reopening it',async()=>{
        const input=await seed(true);const old=await loadSARSimulationMessages(input.run.id);
        vi.mocked(safeFetchJson).mockResolvedValue({choices:[{message:{content:'封存修改'}}]});
        const result=await runSARSimulationTurn({...input,retryReplyId:old[3].id});
        expect(result.run).toMatchObject({status:'archived',interactionsUsed:50});
        expect(result.messages).toHaveLength(4);
    });
    it('rejects a foreign reply id and prevents a new turn while a deletion is pending',async()=>{
        const input=await seed();const old=await loadSARSimulationMessages(input.run.id);
        expect(()=>resolveSARReplyRetry(old,999999)).toThrow('不存在');
        await replaceSARSimulationReply(input.run.id,old[1],{content:'',deleted:true});
        await expect(runSARSimulationTurn(input)).rejects.toThrow('先重新生成');
        expect(safeFetchJson).not.toHaveBeenCalled();
    });
});

it('refuses to delete an orphan legacy reply into an unrecoverable pending slot', async () => {
    const input = await seed(); const old = await loadSARSimulationMessages(input.run.id);
    await DB.deleteMessages([old[0].id]);
    await expect(replaceSARSimulationReply(input.run.id, old[1], { content: '', deleted: true })).rejects.toThrow('对应的用户输入');
    expect((await loadSARSimulationMessages(input.run.id))[0].content).toBe('旧回复1');
});
