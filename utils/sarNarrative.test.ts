import { describe, expect, it } from 'vitest';
import { latestSARDirectorState, normalizeSARDirectorState } from './vrWorld/sarNarrative';
import { buildSARArchiveMarkdown, parseSARSimulationReply } from './vrWorld/sarSimulation';

const facts = { sceneFacts:['雨仍在下'],openThreads:['送信人尚未到'],offscreenFacts:['内部事实标记'],declinedHooks:['用户拒绝现在调查'],revealedFacts:['角色留了一杯茶'] };
describe('SAR quiet scenes and private continuity',()=>{
    it('reads a complete tagged scene with raw quotes and newlines, keeping private facts separate',()=>{
        expect(parseSARSimulationReply(`<SAR_SCENE><worldNarration>门外静了下来。</worldNarration><character>他问："还记得我？"\n又低下头。</character><directorState>${JSON.stringify(facts)}</directorState></SAR_SCENE>`))
            .toEqual({worldNarration:'门外静了下来。',character:'他问："还记得我？"\n又低下头。',directorState:facts});
        expect(parseSARSimulationReply('<SAR_SCENE><character>他起身。</character><directorState>{broken}</directorState></SAR_SCENE>'))
            .toEqual({worldNarration:'',character:'他起身。'});
        for(const raw of [
            '<SAR_SCENE><character>他起身。</character>',
            '<SAR_SCENE><character>他起身。</SAR_SCENE>',
            '<SAR_SCENE><worldNarration>只有旁白</worldNarration></SAR_SCENE>',
            '<character>缺少外层</character><directorState>内部事实标记</directorState>',
            '<SAR_SCENE><character>正文<directorState>秘密</directorState></character></SAR_SCENE>',
        ]) expect(parseSARSimulationReply(raw)).toBeNull();
    });
    it('accepts an intentionally empty narration without leaking structured output',()=>{
        expect(parseSARSimulationReply(JSON.stringify({worldNarration:'',character:'他握住你的手。',directorState:facts}))).toEqual({worldNarration:'',character:'他握住你的手。',directorState:facts});
    });
    it('rejects structured failures instead of displaying the director record as dialogue',()=>{
        expect(parseSARSimulationReply(JSON.stringify({worldNarration:'雨还在下',directorState:facts}))).toBeNull();
        expect(parseSARSimulationReply('{"character":"半截内容","directorState":')).toBeNull();
        expect(parseSARSimulationReply('```json\n{"directorState":')).toBeNull();
        expect(parseSARSimulationReply('他关上窗，坐回你身边。')).toEqual({worldNarration:'',character:'他关上窗，坐回你身边。'});
    });
    it('bounds facts and rejects incomplete snapshots, retaining the last usable assistant state',()=>{
        const value=normalizeSARDirectorState({...facts,sceneFacts:['同一件事','同一件事',null,'',...Array.from({length:10},(_,i)=>String(i).repeat(250))]});
        expect(value?.sceneFacts).toHaveLength(6);
        expect(value?.sceneFacts.every(v=>v.length<=180)).toBe(true);
        expect(normalizeSARDirectorState({sceneFacts:['部分返回']})).toBeUndefined();
        const history=[{role:'assistant',metadata:{sarDirectorState:facts}},{role:'user',metadata:{sarDirectorState:{...facts,declinedHooks:[]}}},{role:'assistant',metadata:{sarDirectorState:{sceneFacts:['部分返回']}}},{role:'assistant',metadata:{sarWorldNarration:''}}] as any;
        expect(latestSARDirectorState(history)).toEqual(facts);
        expect(latestSARDirectorState([])).toBeUndefined();
    });
    it('exports visible narration and character text, keeping private continuity out of the manuscript',()=>{
        const card={id:'card',charId:'char',charName:'阿岚',variantId:'variant-01',storyId:'story-01',profile:{title:'雨停之前',identity:'修伞人',lifePatch:'留在城里',relationship:'熟悉',steelSeal:'等待',patchCost:'离不开故乡',behaviorShift:'温和',openingScene:'雨夜',openingLine:'回来啦。',playerPrompt:'坐坐'}} as any;
        const run={id:'run',interactionsUsed:1,maxInteractions:50,status:'archived',archiveReason:'emergency',createdAt:1,updatedAt:1} as any;
        const text=buildSARArchiveMarkdown(card,run,[{role:'assistant',content:'他握住你的手。',metadata:{sarTurn:1,sarDirectorState:facts,sarWorldNarration:''}}] as any,'我');
        expect(text).toContain('他握住你的手。');
        expect(text).not.toContain('内部事实标记');
        expect(text).not.toContain('用户拒绝现在调查');
    });
});
