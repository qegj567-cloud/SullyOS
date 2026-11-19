import {expect,it} from 'vitest';
import {makeWorkshopPreset,projectWorkshopPreset,replaceWorkshopCss,checkWorkshopCss} from './decorationWorkshop';
import {decorationPatches} from './chatDecoration';
import {portableCssImages} from './cssImageAssets';
import {decorationCategories} from './beautyCategories';
import {PROFILE_PRESETS} from '../presets/chat/profilePresets';

it('applies a profile without moving avatars and resets old positions before applying a standalone whitebox',async()=>{
 const char={id:'sample',chatFineTune:{enabled:true,chatAvatarPlacement:'above_group',chatAvatarAlign:'top',chatAvatarOffsetY:12,chatBubbleIndent:9},
  chatAppearance:{chatAvatarPlacement:'above_group',chatHeaderAlign:'center'}} as any;
 for(const skin of PROFILE_PRESETS){
  const preset=makeWorkshopPreset('profile');preset.parts.profile={customCss:skin.customCss};
  expect(decorationCategories(preset)).toEqual(['chat','profile']);
  const {character}=await decorationPatches(preset,['profile'],'character',char,{} as any);
  expect(Object.keys(character)).toEqual(['chatProfileAppearance']);
  expect(character.chatProfileAppearance!.customCss).toContain('blobref:');
  expect(await portableCssImages(character.chatProfileAppearance!.customCss)).toBe(skin.customCss);
 }
 const legacy=makeWorkshopPreset('whitebox');legacy.parts.css='.sully-chat-header{color:tan}';
 const patch=(await decorationPatches(legacy,['css'],'character',char,{} as any)).character;
 expect(patch.chatAppearance).toMatchObject({chatAvatarPlacement:'beside',chatAvatarAlign:'bottom',chatAvatarOffsetY:0,chatHeaderAlign:'center'});
 expect(patch.chatFineTune).toEqual({enabled:true,chatBubbleIndent:9});
 expect((await decorationPatches(legacy,['css'],'character',{...char,...patch},{} as any)).character).toEqual(patch);
});

it('category makers export only their own content and never clear unrelated CSS',async()=>{
 const preset=makeWorkshopPreset('background');preset.parts.css='.sully-chat-header{color:red}';
 const isolated=projectWorkshopPreset(preset,'background');
 expect(isolated.parts.css).toBeUndefined();expect(decorationCategories(isolated)).toEqual(['chat','background']);
 const patch=await decorationPatches(isolated,['background'],'character',{id:'a',chromeCustomCss:'keep'} as any,{} as any);
 expect(patch.character.chromeCustomCss).toBeUndefined();
});
it('applying an avatar frame preserves the existing whitebox and background CSS',async()=>{
 const old=replaceWorkshopCss('.sully-chat-header{color:red}','background','.sully-chat-root{background:pink}');
 const preset=makeWorkshopPreset('avatar');preset.parts.css=replaceWorkshopCss('','avatar','.sully-chat-avatar-wrap::after{border:1px solid red}');
 expect(decorationCategories(preset)).toEqual(['chat','avatar']);
 const patch=await decorationPatches(preset,['css'],'character',{id:'a',chromeCustomCss:old} as any,{} as any);
 expect(patch.character.chromeCustomCss).toContain('.sully-chat-header');expect(patch.character.chromeCustomCss).toContain('background:pink');expect(patch.character.chromeCustomCss).toContain('avatar-wrap::after');
 expect(patch.character.chatDecorationCssIsolated).toBeUndefined();
 expect(()=>checkWorkshopCss('psyche','.sully-chat-header{color:red}')).toThrow();
 expect(()=>checkWorkshopCss('psyche','.sully-psyche-card{color:red}')).not.toThrow();
});

it('keeps legacy whitebox CSS unchanged while specialized makers remain scoped',()=>{
 const css=String.raw`/* 旧版白框 */
.flex.justify-center.my-6.px-10.w-full { color: purple; }
.fixed.inset-0.bg-slate-900\/45 { background: #3338; }
:root { --old-accent: purple; }
@media (max-width: 600px) { .flex.items-center { padding: 5px; } }
.sully-chat-message:is(.user, .assistant)::after { content: "}"; }
@keyframes old-pulse { from { opacity: 0; } to { opacity: 1; } }`;
 expect(checkWorkshopCss('whitebox',css)).toBe(css);
 expect(()=>checkWorkshopCss('bubbles',css)).toThrow();
 expect(()=>checkWorkshopCss('psyche','.sully-psyche-card:is(.a, .b)::after {content:"}"}')).not.toThrow();
 expect(()=>checkWorkshopCss('whitebox','.flex {color:red')).toThrow('未闭合');
});

it('summarizes repeated validation problems instead of flooding the editor',()=>{
 const css=Array.from({length:30},(_,i)=>`.outside-${i}{color:red}`).join('\n');
 try{checkWorkshopCss('avatar',css);throw Error('expected rejection');}catch(e){
  expect((e as Error).message).toContain('30 处');
  expect((e as Error).message.split('超出限定范围')).toHaveLength(4);
  expect((e as Error).message).toContain('其余提示已收起');
 }
});
