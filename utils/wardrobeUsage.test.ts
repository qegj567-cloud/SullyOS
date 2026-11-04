import {withAvatarFrameTarget} from './avatarFrameTarget';
import {describe,it,expect,vi} from 'vitest';
import {createWardrobeUsageReader} from './wardrobeUsage';
import {PRESET_THEMES} from '../components/chat/ChatConstants';
import type {OSTheme,CharacterProfile} from '../types';
const pack=(parts:object)=>({format:'sullyos-chat-decoration',parts});
const reader=(theme:object={},char:object={},normalize?:any)=>createWardrobeUsageReader(theme as OSTheme,char as CharacterProfile,PRESET_THEMES.default,{},normalize);
describe('wardrobe current usage',()=>{
 it('follows the selected character and CSS sound precedence',async()=>{
  expect(await reader({chatSound:{src:'ding'}},{chatSound:{src:'pop'}})(pack({sound:{src:'pop'}}))).toBe('当前使用中');
  expect(await reader({chatSound:{src:'ding'}},{chatSound:{src:'pop'}})(pack({sound:{src:'ding'}}))).toBe('');
  expect(await reader({chatSound:{src:'ding'}})(pack({sound:{src:'ding'}}))).toBe('当前使用中');
 });
 it('recognizes silence and checks volume changes',async()=>{
  expect(await reader()(pack({sound:{src:'none',volume:.6}}))).toBe('当前使用中');
  expect(await reader({}, {chatSound:{src:'ding',volume:.2}})(pack({sound:{src:'ding',volume:.6}}))).toBe('');
 });
 it('matches copied bubbles by contents instead of generated ids',async()=>{
  expect(await reader()(pack({bubbles:{...PRESET_THEMES.default,id:'copied',name:'renamed',type:'custom'}}))).toBe('当前使用中');
 });
 it('marks a mixed outfit as partial after a setting changes',async()=>{
  expect(await reader({}, {chromeCustomCss:'.sully-chat-root{color:red}',chatSound:{src:'ding'}})(pack({css:'.sully-chat-root{color:red}',sound:{src:'pop'}}))).toBe('部分使用中');
 });
 it('finds avatar/background blocks within a complete whitebox',async()=>{
  const avatar='/* sully-composer:avatar */\n.sully-chat-avatar-frame{color:red}\n/* end-sully-composer:avatar */';
  expect(await reader({}, {chromeCustomCss:'.sully-chat-root{color:blue}'+avatar})(pack({css:avatar}))).toBe('当前使用中');
 });
 it('recognizes the same frame after selecting only one side',async()=>{
  const original={format:'sullyos-chat-decoration' as const,version:1 as const,name:'Frame',parts:{css:'/* sully-composer:avatar */\n.sully-chat-avatar-wrap::after {content:""; background:red} .sully-chat-message-avatar-img {border-radius:50%}\n/* end-sully-composer:avatar */'}};
  const selected=withAvatarFrameTarget(original,'user');
  expect(await reader({}, {chromeCustomCss:selected.parts.css})(original)).toBe('当前使用中');
 });
 it('keeps date per character and story/schedule/journal global',async()=>{
  const read=reader({storyAppearance:{preset:'paper',name:'Book'},scheduleCardAppearance:{preset:'cream'},journalAppearance:{preset:'original'}},{dateAppearance:{preset:'night',name:'Night'}});
  for(const part of [{date:{preset:'night'}},{story:{preset:'paper'}},{schedule:{preset:'cream'}},{journal:{preset:'original',customCss:''}}])expect(await read(pack(part))).toBe('当前使用中');
  expect(await read(pack({date:{preset:'paper'}}))).toBe('');
 });
 it('ignores unused custom psyche colors for builtins',async()=>{
  expect(await reader({}, {thinkingChainStyle:'echo',thinkingChainCustomColors:{bg:'red'}})(pack({psyche:{styleId:'echo',customCss:''}}))).toBe('当前使用中');
 });
 it('normalizes local assets once and does not mutate presets',async()=>{
  const normalize=vi.fn(async(value:string)=>value==='blobref:image'?'data:image/png;base64,A':value);
  const read=reader({}, {chatBackground:'blobref:image'},normalize);
  const item=pack({background:{image:'data:image/png;base64,A',style:'plain'}});
  expect(await read(item)).toBe('当前使用中');expect(await read(item)).toBe('当前使用中');
  expect(normalize.mock.calls.filter(c=>c[0]==='blobref:image')).toHaveLength(1);
  expect(item.parts).toEqual({background:{image:'data:image/png;base64,A',style:'plain'}});
 });
 it('matches desktop theme fields and icons independently',async()=>{
  expect(await reader({skin:'default'})({theme:{skin:'default'},customIcons:{}})).toBe('当前使用中');
  expect(await reader({skin:'default'})({theme:{skin:'other'},customIcons:{}})).toBe('部分使用中');
 });
});
