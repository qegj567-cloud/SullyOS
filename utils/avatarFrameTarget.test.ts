import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {targetAvatarFrameCss,readAvatarFrameTarget,withAvatarFrameTarget,avatarFrameLayer} from './avatarFrameTarget';
import {decorationPatches} from './chatDecoration';
import {checkWorkshopCss,replaceWorkshopCss} from './decorationWorkshop';
const frame='.sully-chat-avatar-wrap::after {content:"";background:url("https://example.com/frame.png")} .sully-chat-message-avatar-img {border-radius:50%}';
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
});
