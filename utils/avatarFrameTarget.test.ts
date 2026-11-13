import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {targetAvatarFrameCss,readAvatarFrameTarget,withAvatarFrameTarget,avatarFrameLayer,hasSplitAvatarFrames,setAvatarFrameSlot,mergeAvatarFrameCss} from './avatarFrameTarget';
import {decorationPatches} from './chatDecoration';
import {decorationThumbnailPart} from './decorationPreviewScenes';
import {resetChatDecoration} from './decorationReset';
import {PRESET_THEMES} from '../components/chat/ChatConstants';
import {checkWorkshopCss,projectWorkshopPreset,replaceWorkshopCss,workshopCss} from './decorationWorkshop';
const frame='.sully-chat-avatar-wrap::after {content:"";background:url("https://example.com/frame.png")} .sully-chat-message-avatar-img {border-radius:50%}';
const frameB='.sully-chat-avatar-wrap::after {content:"";background:url("https://example.com/frame-b.png")}';
const make=(css=frame)=>({format:'sullyos-chat-decoration' as const,version:1 as const,name:'frame',parts:{css:replaceWorkshopCss('','avatar',css)}});
describe('avatar frame application targets',()=>{
 it.each(['user','ai'] as const)('limits %s selectors and passes the existing maker validator',target=>{
  const result=targetAvatarFrameCss(frame,target);
  expect(result).toContain(`.sully-chat-avatar-wrap:where(.sully-chat-message-${target} *)::after`);
  expect(readAvatarFrameTarget(result)).toBe(target);
  expect(()=>checkWorkshopCss('avatar',result)).not.toThrow();
 });
 it('can switch from user to role to both without accumulating filters',()=>{
  const user=targetAvatarFrameCss(frame,'user'),ai=targetAvatarFrameCss(user,'ai'),both=targetAvatarFrameCss(ai,'both');
  expect(ai).not.toContain('message-user');expect(both).not.toContain(':where(');
  expect(targetAvatarFrameCss(ai,'ai')).toBe(ai);
 });
 it('preserves declaration strings, URLs, media queries and keyframes',()=>{
  const source='@media(max-width:600px){.sully-chat-avatar-wrap::after{content:".sully-chat-avatar-wrap";background:url("https://example.com/.sully-chat-avatar-wrap.png")}} @keyframes pulse{from{opacity:0}to{opacity:1}}';
  const result=targetAvatarFrameCss(source,'user');
  expect(result).toContain('content:".sully-chat-avatar-wrap"');expect(result).toContain('/.sully-chat-avatar-wrap.png');expect(result).toContain('@keyframes pulse{from{opacity:0}to{opacity:1}}');
 });
 it('keeps whitebox, background and original preset unchanged when applying a target',async()=>{
  const original=make();const selected=withAvatarFrameTarget(original,'user');
  const before=replaceWorkshopCss('.sully-chat-header{color:red}','background','.sully-chat-root{background:pink}');
  const patch=await decorationPatches(selected,['css'],'character',{id:'c',chromeCustomCss:before,chatSound:{src:'ding'}} as any,{} as any);
  expect(patch.character.chromeCustomCss).toContain('.sully-chat-header{color:red}');expect(patch.character.chromeCustomCss).toContain('background:pink');expect(patch.character.chromeCustomCss).toContain('message-user');
  expect(patch.character.chatSound).toEqual({src:'ding'});expect(original.parts.css).not.toContain(':where(');
 });
 it('keeps role avatar frame when applying a different user avatar frame afterwards',async()=>{
  const aiFrame=withAvatarFrameTarget(make(frame),'ai');
  const userFrame=withAvatarFrameTarget(make(frameB),'user');
  const step1=await decorationPatches(aiFrame,['css'],'character',{id:'c',chromeCustomCss:'.sully-chat-header{color:red}'} as any,{} as any);
  const step2=await decorationPatches(userFrame,['css'],'character',{id:'c',chromeCustomCss:step1.character.chromeCustomCss} as any,{} as any);
  const finalCss=step2.character.chromeCustomCss||'';
  expect(finalCss).toContain('.sully-chat-header{color:red}');
  expect(finalCss).toContain('frame.png');
  expect(finalCss).toContain('.sully-chat-avatar-wrap:where(.sully-chat-message-ai *)::after');
  expect(finalCss).toContain('frame-b.png');
  expect(finalCss).toContain('.sully-chat-avatar-wrap:where(.sully-chat-message-user *)::after');
  expect(hasSplitAvatarFrames(finalCss)).toBe(true);
  expect(avatarFrameLayer(finalCss)).toContain('frame.png');
  expect(avatarFrameLayer(finalCss)).toContain('frame-b.png');
  const reset=resetChatDecoration('avatar',{id:'c',chromeCustomCss:finalCss} as any,{} as any,PRESET_THEMES.default);
  expect(reset.character.chromeCustomCss).not.toContain('sully-composer:avatar');
 });
 it('narrows an existing shared frame to the untouched side when replacing one side, and replaces both on shared apply',async()=>{
  const shared=withAvatarFrameTarget(make(frame),'both');
  const userOnly=withAvatarFrameTarget(make(frameB),'user');
  const step1=await decorationPatches(shared,['css'],'character',{id:'c',chromeCustomCss:''} as any,{} as any);
  const step2=await decorationPatches(userOnly,['css'],'character',{id:'c',chromeCustomCss:step1.character.chromeCustomCss} as any,{} as any);
  const splitCss=step2.character.chromeCustomCss||'';
  expect(splitCss).toContain('frame-b.png');
  expect(splitCss).toContain('.sully-chat-avatar-wrap:where(.sully-chat-message-user *)::after');
  expect(splitCss).toContain('frame.png');
  expect(splitCss).toContain('.sully-chat-avatar-wrap:where(.sully-chat-message-ai *)::after');
  const step3=await decorationPatches(shared,['css'],'character',{id:'c',chromeCustomCss:splitCss} as any,{} as any);
  expect(step3.character.chromeCustomCss).not.toContain('frame-b.png');
  expect(step3.character.chromeCustomCss).not.toContain(':where(');
 });
 it('updates or clears individual sides in outfit composer slots',()=>{
  const withAi=setAvatarFrameSlot('.sully-chat-root{color:blue}','ai',frame);
  const withBothDifferent=setAvatarFrameSlot(withAi,'user',frameB);
  expect(hasSplitAvatarFrames(withBothDifferent)).toBe(true);
  const clearedUser=setAvatarFrameSlot(withBothDifferent,'user','');
  expect(hasSplitAvatarFrames(clearedUser)).toBe(false);
  expect(readAvatarFrameTarget(clearedUser)).toBe('ai');
  expect(clearedUser).toContain('frame.png');
  expect(clearedUser).not.toContain('frame-b.png');
 });
 it('extracts only the explicit frame layer for final rendering',()=>{
  const combined=replaceWorkshopCss('.sully-chat-root{color:red}','avatar',frame);
  expect(avatarFrameLayer(combined).trim()).toBe(frame);expect(avatarFrameLayer('.sully-chat-root{}')).toBe('');
 });
 it('real chat and preview both place selected frames after bubble CSS',()=>{
  const chat=readFileSync(new URL('../apps/Chat.tsx',import.meta.url),'utf8');
  const preview=readFileSync(new URL('../components/chat/ChatDecorationSample.tsx',import.meta.url),'utf8');
  expect(chat.indexOf('css={selectedAvatarFrameCss}')).toBeGreaterThan(chat.indexOf('{activeTheme.customCss && <style>'));
  expect(preview.indexOf('${avatarFrameLayer(')).toBeGreaterThan(preview.indexOf('${p.bubbles?.customCss'));
 });
 it('splits combined dual-frame CSS back into per-side slots across workshop, copy-import and single-side selection',()=>{
  const dualCss=mergeAvatarFrameCss(withAvatarFrameTarget(make(frame),'ai').parts.css!,withAvatarFrameTarget(make(frameB),'user').parts.css!);
  const dualPreset={format:'sullyos-chat-decoration' as const,version:1 as const,name:'双框',parts:{css:dualCss}};
  expect(decorationThumbnailPart(dualPreset)).toBe('avatar');
  const projected=projectWorkshopPreset(dualPreset,'avatar');
  const copiedBlock=replaceWorkshopCss('','avatar',workshopCss(projected,'avatar'));
  const replacedUserOnly=mergeAvatarFrameCss(copiedBlock,withAvatarFrameTarget(make('.sully-chat-avatar-wrap::after{content:"";background:green}'),'user').parts.css!);
  expect(replacedUserOnly).toContain('frame.png');
  expect(replacedUserOnly).toContain('background:green');
  expect(replacedUserOnly).not.toContain('frame-b.png');
  const pickedAiFromDual=setAvatarFrameSlot('','ai',workshopCss(dualPreset,'avatar'));
  expect(pickedAiFromDual).toContain('frame.png');
  expect(pickedAiFromDual).not.toContain('frame-b.png');
 });
 it('rewrites handwritten ancestor or :is() side scopes cleanly without mangling custom hyphenated classes',()=>{
  const handwritten='.sully-chat-message-user .sully-chat-avatar-wrap::after{content:""} .sully-chat-avatar-frame:is(.sully-chat-message-user *){opacity:.9} .sully-chat-avatar-wrap-custom{color:red}';
  const toAi=targetAvatarFrameCss(handwritten,'ai');
  expect(toAi).not.toContain('message-user');
  expect(toAi).toContain('.sully-chat-avatar-wrap:where(.sully-chat-message-ai *)::after');
  expect(toAi).toContain('.sully-chat-avatar-frame:where(.sully-chat-message-ai *)');
  expect(toAi).toContain('.sully-chat-avatar-wrap-custom{color:red}');
  const toBoth=setAvatarFrameSlot('','both',handwritten);
  expect(toBoth).not.toContain('message-user');
  expect(toBoth).not.toContain(':where(');
 });
 it('overwrites removed sides and old whitebox CSS when applying a full outfit with layout',async()=>{
  const initialDual=mergeAvatarFrameCss(withAvatarFrameTarget(make(frame),'ai').parts.css!,withAvatarFrameTarget(make(frameB),'user').parts.css!);
  const outfitWithAiOnly={format:'sullyos-chat-decoration' as const,version:1 as const,name:'搭配',parts:{layout:{chatAvatarShape:'circle' as const},bubbles:PRESET_THEMES.default,css:withAvatarFrameTarget(make(frame),'ai').parts.css!}};
  const patch=await decorationPatches(outfitWithAiOnly,['layout','bubbles','css'],'character',{id:'c',chromeCustomCss:'.sully-chat-header{color:red}\n'+initialDual} as any,{} as any);
  expect(patch.character.chromeCustomCss).toContain('frame.png');
  expect(patch.character.chromeCustomCss).not.toContain('frame-b.png');
  expect(patch.character.chromeCustomCss).not.toContain('.sully-chat-header{color:red}');
  expect(patch.character.chatDecorationCssIsolated).toBe(true);
 });
});
