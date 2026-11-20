import {expect,it} from 'vitest';
import {decorationSelection} from './decorationPriority';
import {decorationPatches,resolveDecorationTheme,exportDecoration,validateDecoration} from './chatDecoration';
import {withdrawWhiteboxParts,mergeWhiteboxSelection} from './whiteboxParts';
import {prepareDecorationApplication} from './decorationApplication';
import {PRESET_THEMES} from '../components/chat/ChatConstants';
import type {CharacterProfile,OSTheme} from '../types';

const skin = '.sully-chat-root{background:purple!important;color:black;--ink:#456}.sully-chat-header{color:var(--ink)}@media(max-width:700px){.sully-bubble-ai,.sully-chat-back{border:4px solid red!important}}.sully-voice-bar::after{content:"old tail"}.sully-psyche-card{color:yellow}';
const pack = (parts:Record<string,unknown>)=>validateDecoration({format:'sullyos-chat-decoration',version:1,name:'A',parts});
const role={id:'a',bubbleStyle:'old'} as CharacterProfile;
const theme={chatChromeCustomCss:skin} as OSTheme;
const bubble=PRESET_THEMES.dream;
it('switches outfit → standalone → outfit in trial, application and exported snapshots',async()=>{
 const full=pack({css:skin,bubbles:bubble});
 const first=await decorationPatches(full,['css','bubbles'],'character',role,theme,'trial');
 const wearing={...role,...first.character};
 for(const mode of ['trial','apply'] as const){
  const next=await prepareDecorationApplication(pack({bubbles:bubble}),['bubbles'],[wearing],theme,[],{kind:'self'},async()=>({kind:'self'}),mode);
  const independent={...wearing,...next.prepared[0].changes.character};
  const exported=await exportDecoration('当前',theme,independent,next.bubbles[0]);
  expect(exported.parts.css).not.toMatch(/sully-bubble-ai|old tail/);
  expect(exported.parts.css).toContain('.sully-chat-back');
  expect(exported.parts.css).toContain('.sully-psyche-card');
  const again=await decorationPatches(pack({css:skin}),['css'],'character',independent,theme,mode);
  expect(again.character.bubbleStyle).toBe('default');
  expect(again.character.chromeCustomCss).toContain('old tail');
 }
 expect(full.parts.css).toBe(skin);
});
it('keeps inherited chrome live, respects a role override and releases it when following global',()=>{
 const chosen=decorationSelection(role,{bubbleStyle:'B'},'character');
 const own={...role,...chosen};
 const inherited=resolveDecorationTheme(theme,own).chatChromeCustomCss!;
 expect(inherited).not.toContain('old tail');
 expect(inherited).toContain('.sully-chat-back');
 expect(resolveDecorationTheme(theme,role).chatChromeCustomCss).toBe(skin);
 const follow=decorationSelection(own,{bubbleStyle:undefined},'character');
 expect(resolveDecorationTheme(theme,{...own,...follow}).chatChromeCustomCss).toBe(skin);
 const global=decorationSelection(theme,{chatDefaultBubbleStyle:'B'},'global');
 expect(global.chatChromeCustomCss).not.toContain('old tail');
 expect(theme.chatChromeCustomCss).toBe(skin);
 const isolated={...own,chromeCustomCss:skin,chatDecorationCssIsolated:true};
 const released={...isolated,...decorationSelection(isolated,{bubbleStyle:undefined},'character')};
 const live=resolveDecorationTheme({...theme,chatChromeCustomCss:skin.replace('old tail','global tail')},released);
 expect(live.chatChromeCustomCss).toContain('global tail');
 expect(live.chatChromeCustomCss).not.toContain('.sully-chat-header');
 expect(released.chromeCustomCss).not.toContain('old tail');
});
it('splits canvas paint, selector branches, avatar sides and omitted components without dropping unrelated CSS',()=>{
 const css=skin+'.sully-chat-avatar-wrap::after{background:red}:is(.sully-bubble-user,.sully-chat-name){color:pink}';
 const clean=withdrawWhiteboxParts(css,['background','bubbles','avatar:user','psyche']);
 expect(clean).not.toMatch(/background:purple|old tail|sully-bubble-user|sully-psyche-card/);
 expect(clean).toContain('color:black'); expect(clean).toContain('sully-chat-name');
 expect(clean).toContain('sully-chat-message-ai');
 const partial=mergeWhiteboxSelection(css,'.sully-chat-name{color:lime}',[]);
 expect(partial).toContain('old tail');expect(partial).not.toContain('.sully-chat-header');
});
