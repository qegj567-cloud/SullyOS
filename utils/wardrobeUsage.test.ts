import {mergeAvatarFrameCss,withAvatarFrameTarget} from './avatarFrameTarget';
import {describe,it,expect,vi} from 'vitest';
import {createWardrobeUsageReader} from './wardrobeUsage';
import {PRESET_THEMES} from '../components/chat/ChatConstants';
import type {OSTheme,CharacterProfile} from '../types';
const pack=(parts:object)=>({format:'sullyos-chat-decoration',parts});
const reader=(theme:object={},char:object={},normalize?:any)=>createWardrobeUsageReader(theme as OSTheme,char as CharacterProfile,PRESET_THEMES.default,{},normalize);
describe('wardrobe current usage',()=>{
 it('follows the selected character and CSS sound precedence',async()=>{
  expect(await reader({chatSound:{src:'ding'}},{chatSound:{src:'pop'}})(pack({sound:{src:'pop'}}))).toBe('使用中');
  expect(await reader({chatSound:{src:'ding'}},{chatSound:{src:'pop'}})(pack({sound:{src:'ding'}}))).toBe('');
  expect(await reader({chatSound:{src:'ding'}})(pack({sound:{src:'ding'}}))).toBe('使用中');
 });
 it('recognizes silence and checks volume changes',async()=>{
  expect(await reader()(pack({sound:{src:'none',volume:.6}}))).toBe('使用中');
  expect(await reader({}, {chatSound:{src:'ding',volume:.2}})(pack({sound:{src:'ding',volume:.6}}))).toBe('');
 });
 it('matches copied bubbles by contents instead of generated ids',async()=>{
  expect(await reader()(pack({bubbles:{...PRESET_THEMES.default,id:'copied',name:'renamed',type:'custom'}}))).toBe('使用中');
 });
 it('marks a mixed outfit as partial after a setting changes',async()=>{
  expect(await reader({}, {chromeCustomCss:'.sully-chat-root{color:red}',chatSound:{src:'ding'}})(pack({css:'.sully-chat-root{color:red}',sound:{src:'pop'}}))).toBe('部分使用中');
 });
 it('finds avatar/background blocks within a complete whitebox',async()=>{
  const avatar='/* sully-composer:avatar */\n.sully-chat-avatar-frame{color:red}\n/* end-sully-composer:avatar */';
  expect(await reader({}, {chromeCustomCss:'.sully-chat-root{color:blue}'+avatar})(pack({css:avatar}))).toBe('使用中');
 });
 it('recognizes the same frame after selecting only one side, and marks both frames in use when user and role wear different frames',async()=>{
  const frameA={format:'sullyos-chat-decoration' as const,version:1 as const,name:'Frame A',parts:{css:'/* sully-composer:avatar */\n.sully-chat-avatar-wrap::after {content:""; background:red} .sully-chat-message-avatar-img {border-radius:50%}\n/* end-sully-composer:avatar */'}};
  const frameB={format:'sullyos-chat-decoration' as const,version:1 as const,name:'Frame B',parts:{css:'/* sully-composer:avatar */\n.sully-chat-avatar-wrap::after {content:""; background:blue}\n/* end-sully-composer:avatar */'}};
  const frameC={format:'sullyos-chat-decoration' as const,version:1 as const,name:'Frame C',parts:{css:'/* sully-composer:avatar */\n.sully-chat-avatar-wrap::after {content:""; background:green}\n/* end-sully-composer:avatar */'}};
  const aiA=withAvatarFrameTarget(frameA,'ai');
  const userB=withAvatarFrameTarget(frameB,'user');
  expect(await reader({}, {chromeCustomCss:userB.parts.css})(frameB)).toBe('使用中');
  const dualCss=mergeAvatarFrameCss(aiA.parts.css!,userB.parts.css!);
  const readDual=reader({}, {chromeCustomCss:dualCss});
  expect(await readDual(frameA)).toBe('使用中');
  expect(await readDual(frameB)).toBe('使用中');
  expect(await readDual(frameC)).toBe('');
  const dualPreset=pack({css:dualCss});
  expect(await readDual(dualPreset)).toBe('使用中');
  const replacedUser=mergeAvatarFrameCss(dualCss,withAvatarFrameTarget(frameC,'user').parts.css!);
  expect(await reader({}, {chromeCustomCss:replacedUser})(dualPreset)).toBe('部分使用中');

  // Single-block split dual-frame preset (e.g. re-imported CSS) also matches two separately applied frames
  const singleBlockDual=pack({css:`/* sully-composer:avatar */\n${aiA.parts.css!.replace(/\/\*[\s\S]*?\*\//g,'').trim()}\n${userB.parts.css!.replace(/\/\*[\s\S]*?\*\//g,'').trim()}\n/* end-sully-composer:avatar */`});
  expect(await readDual(singleBlockDual)).toBe('使用中');

  // Whitebox with an embedded single avatar block applied to one side still reports 使用中
  const whiteboxWithFrame={format:'sullyos-chat-decoration' as const,version:1 as const,name:'Whitebox+Frame',parts:{css:'.sully-chat-header{color:purple}\n'+frameA.parts.css!}};
  const appliedWhiteboxAi=withAvatarFrameTarget(whiteboxWithFrame,'ai');
  expect(await reader({}, {chromeCustomCss:appliedWhiteboxAi.parts.css})(whiteboxWithFrame)).toBe('使用中');

  // A full outfit with only an AI frame drops to 部分使用中 once the user equips a second frame on user
  const outfitAiOnly=pack({layout:{chatAvatarShape:'circle'},css:aiA.parts.css!});
  expect(await reader({chatAvatarShape:'circle'},{chromeCustomCss:aiA.parts.css!})(outfitAiOnly)).toBe('使用中');
  expect(await reader({chatAvatarShape:'circle'},{chromeCustomCss:dualCss})(outfitAiOnly)).toBe('部分使用中');
 });
 it('marks a legacy bubble with embedded avatarDecoration as partial when its frame is worn over another bubble',async()=>{
  const frameBubble={...PRESET_THEMES.dream,user:{...PRESET_THEMES.dream.user,avatarDecoration:'data:image/png;base64,FRAME'}};
  const activeBubble={...PRESET_THEMES.default,user:{...PRESET_THEMES.default.user,avatarDecoration:'data:image/png;base64,FRAME'}};
  const read=createWardrobeUsageReader({} as OSTheme,{} as CharacterProfile,activeBubble,{});
  expect(await read(pack({bubbles:frameBubble}))).toBe('部分使用中');
 });
 it('keeps date per character and story/schedule/journal global',async()=>{
  const read=reader({storyAppearance:{preset:'paper',name:'Book'},scheduleCardAppearance:{preset:'cream'},journalAppearance:{preset:'original'}},{dateAppearance:{preset:'night',name:'Night'}});
  for(const part of [{date:{preset:'night'}},{story:{preset:'paper'}},{schedule:{preset:'cream'}},{journal:{preset:'original',customCss:''}}])expect(await read(pack(part))).toBe('使用中');
  expect(await read(pack({date:{preset:'paper'}}))).toBe('');
 });
 it('ignores unused custom psyche colors for builtins',async()=>{
  expect(await reader({}, {thinkingChainStyle:'echo',thinkingChainCustomColors:{bg:'red'}})(pack({psyche:{styleId:'echo',customCss:''}}))).toBe('使用中');
 });
 it('normalizes local assets once and does not mutate presets',async()=>{
  const normalize=vi.fn(async(value:string)=>value==='blobref:image'?'data:image/png;base64,A':value);
  const read=reader({}, {chatBackground:'blobref:image'},normalize);
  const item=pack({background:{image:'data:image/png;base64,A',style:'plain'}});
  expect(await read(item)).toBe('使用中');expect(await read(item)).toBe('使用中');
  expect(normalize.mock.calls.filter(c=>c[0]==='blobref:image')).toHaveLength(1);
  expect(item.parts).toEqual({background:{image:'data:image/png;base64,A',style:'plain'}});
 });
 it('matches desktop theme fields and icons independently',async()=>{
  expect(await reader({skin:'default'})({theme:{skin:'default'},customIcons:{}})).toBe('使用中');
  expect(await reader({skin:'default'})({theme:{skin:'other'},customIcons:{}})).toBe('部分使用中');
 });
});
