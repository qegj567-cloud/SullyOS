import {it,expect} from 'vitest';
import {DB} from './db';
import {exportDecorationMedia,restoreDecorationMedia} from './decorationMediaBackup';
import type {CharacterProfile} from '../types';
it('restores media-only decoration and defaults without replacing character text',async()=>{
 const source={id:'beauty-media-test',name:'source-private',systemPrompt:'secret',showThinkingChain:false,
  bubbleStyle:'old-bubble',chatIndependentParts:['bubbles'], chatAppearance:{chatAvatarShape:'square'},chatFineTune:{enabled:true},
  chromeCustomCss:'.sully-chat-root{color:red}',chatDecorationCssIsolated:true,chatBackground:'',
  chatSound:{src:'none'},thinkingChainStyle:'echo',thinkingChainCustomCss:'.sully-psyche-card{color:red}'} as unknown as CharacterProfile;
 const decoration=exportDecorationMedia(source);
 expect(JSON.stringify(decoration)).not.toMatch(/secret|source-private|showThinkingChain/);
 await DB.saveCharacter({...source,name:'keep me',systemPrompt:'keep prompt',showThinkingChain:true,chatBackground:'old-bg',thinkingChainCustomColors:{bg:'old'}} as CharacterProfile);
 await DB.importFullData({mediaAssets:[{charId:source.id,decoration:{...decoration,values:{...decoration.values,name:'injected'} as any}}]} as any);
 const restored=(await DB.getAllCharacters()).find(c=>c.id===source.id)!;
 expect(restored.name).toBe('keep me');expect(restored.systemPrompt).toBe('keep prompt');expect(restored.showThinkingChain).toBe(true);
 expect(restored.chatAppearance).toEqual(source.chatAppearance);expect(restored.chromeCustomCss).toBe(source.chromeCustomCss);
 expect(restored.chatIndependentParts).toEqual(['bubbles']);
 expect(restored.chatSound).toEqual({src:'none'});expect(restored.bubbleStyle).toBe('old-bubble');
 expect(restored.chatBackground).toBe('');expect(restored.thinkingChainCustomColors).toBeUndefined();
 expect(restoreDecorationMedia(undefined)).toEqual({});
});
