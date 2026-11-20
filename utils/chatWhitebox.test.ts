// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {CHAT_PREVIEW_SCENES,CHAT_TYPE_SAMPLES} from './chatPreviewFixtures';
import {renderChatDecorationSample} from '../components/chat/ChatDecorationSample';
import {WHITEBOX_AI_PROMPT,WHITEBOX_SCOPE_REGEX,WHITEBOX_SCOPE_HINT} from './chatWhitebox';
import {validateScopedCss} from './scopedCss';
import {validateDecoration,decorationPatches} from './chatDecoration';
import {resolvePsycheAppearance} from './psycheAppearance';
import type {CharacterProfile,OSTheme} from '../types';

const preset={format:'sullyos-chat-decoration',version:1,name:'完整白框',parts:{css:'.sully-psyche-card{color:rebeccapurple!important}',psyche:{styleId:'whisper',customCss:''}}};
describe('complete whitebox contract',()=>{
 it('isolates catalog parts while keeping individual previews in the full chat',()=>{
  const psyche=renderChatDecorationSample(preset,'psyche','psyche').markup;
  expect(psyche).toContain('sully-psyche-card');
  expect(psyche).not.toContain('sully-chat-header');
  expect(psyche).not.toContain('sully-chat-inputbar');
  expect(psyche).not.toContain('回来就好');
  const bubbles=renderChatDecorationSample(preset,'conversation','bubbles').markup;
  expect(bubbles).toContain('sully-bubble');
  expect(bubbles).not.toContain('sully-chat-header');
  const background=renderChatDecorationSample(preset,'conversation','background').markup;
  expect(background).not.toContain('sully-chat-message');
  expect(renderChatDecorationSample(preset,'psyche').markup).toContain('sully-chat-inputbar');
 });
 it('allows card and psyche hooks while rejecting page-wide styles',()=>{
  expect(validateScopedCss('.sully-chat-card[data-card-kind="music_card"] .sully-chat-card-surface{padding:8px}.sully-psyche-body{color:red}',WHITEBOX_SCOPE_REGEX,WHITEBOX_SCOPE_HINT).isValid).toBe(true);
  expect(validateScopedCss('body{display:none}',WHITEBOX_SCOPE_REGEX,WHITEBOX_SCOPE_HINT).isValid).toBe(false);
  expect(WHITEBOX_AI_PROMPT).toContain('.sully-psyche-body');
  expect(WHITEBOX_AI_PROMPT).toContain('data-card-kind');
  expect(WHITEBOX_AI_PROMPT).toContain('.sully-collaboration-file-action');
  expect(WHITEBOX_AI_PROMPT).toContain('.sully-schedule-change');
  expect(WHITEBOX_AI_PROMPT).toContain('diary_card');
  expect(WHITEBOX_AI_PROMPT).toContain('其他 App 卡片仅在用户明确点名时增加样式');
  expect(WHITEBOX_AI_PROMPT).toContain('完整接口说明');
 });
 it.each(CHAT_PREVIEW_SCENES.map(scene=>[scene.id,scene.label]))('renders real fixture %s (%s) without network or data writes',(id)=>{
  const fetchSpy=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Preview must not fetch'));
  try{const {markup}=renderChatDecorationSample(preset,id);expect(markup).toContain('sully-chat-messages');expect(markup).not.toContain('NaN');expect(fetchSpy).not.toHaveBeenCalled();}finally{fetchSpy.mockRestore();}
 });
 it('includes every message type and expanded psyche and transfer states',()=>{
  const fullConversation=CHAT_PREVIEW_SCENES.find(scene=>scene.id==='all')!;
  expect(new Set(fullConversation.messages.map(message=>message.type))).toEqual(new Set(Object.keys(CHAT_TYPE_SAMPLES)));
  expect(renderChatDecorationSample(preset,'psyche-open').markup).toContain('sully-psyche-body');
  expect(renderChatDecorationSample(preset,'music_card').markup).toContain('data-card-kind="music_card"');
  expect(renderChatDecorationSample(preset,'transfer-accepted').markup).toContain('data-status="accepted"');
 });
 it('puts the theme on each painted card and leaves collectible artwork and embeds independent',()=>{
  const chat=document.createElement('div');
  chat.innerHTML=renderChatDecorationSample(preset,'all').markup;
  for(const card of chat.querySelectorAll<HTMLElement>('[data-card-kind]')){
   const dedicated=['transfer','html_card'].includes(card.dataset.cardKind!)
    || ['like520_card','qixi_event_card'].includes(card.dataset.cardVariant!);
   expect(card.querySelectorAll('.sully-chat-card-face'),card.dataset.cardVariant || card.dataset.cardKind)
    .toHaveLength(dedicated ? 0 : 1);
  }
  expect(chat.querySelector('[data-card-kind="chat_forward"] .sully-chat-card-face')?.textContent).toContain('点击查看');
  expect(chat.querySelector('[data-card-kind="collaboration_file"] button.sully-chat-card-face')).toBeTruthy();
  expect(chat.querySelector('[data-card-kind="friend_feed_share_card"] details.sully-chat-card-face > summary')).toBeTruthy();
 });
 it('keeps appearance separate from reasoning preferences and preserves legacy presets',async()=>{
  const sanitized=validateDecoration({...preset,parts:{psyche:{styleId:'ink',customCss:'',enabled:false,customPrompt:'DO NOT EXPORT',password:'private'}}});
  expect(sanitized.parts.psyche).toEqual({styleId:'ink',customCss:''});
  const char={id:'test',name:'Test',avatar:'',description:'',systemPrompt:'keep',memories:[],thinkingChainCustomPrompt:'keep'} as CharacterProfile;
  const patch=await decorationPatches(sanitized,['psyche'],'character',char,{} as OSTheme);
  expect(patch.character.thinkingChainStyle).toBe('ink');
  expect(patch.character).not.toHaveProperty('thinkingChainCustomPrompt');
  expect(patch.character).not.toHaveProperty('thinkingChainEnabled');
  expect(validateDecoration({format:'sullyos-chat-decoration',version:1,name:'旧白框',parts:{css:'.sully-chat-root{}'}}).parts.psyche).toBeUndefined();
  expect(resolvePsycheAppearance({chatPsyche:{styleId:'ink'}},{thinkingChainStyle:'neon'}).styleId).toBe('neon');
  expect(resolvePsycheAppearance({chatPsyche:{styleId:'ink'}}).styleId).toBe('ink');
 });
});
