// @vitest-environment jsdom
import {it,expect} from 'vitest';
import {PROFILE_PRESETS} from '../presets/chat/profilePresets';
import {makeWorkshopPreset} from './decorationWorkshop';
import {renderChatDecorationSample} from '../components/chat/ChatDecorationSample';
import {decorationPreviewScenes} from './decorationPreviewScenes';
import {bindDecorationPreview} from './decorationPreviewInteraction';
it('previews the same card skin in all three sections and allows switching from a preview tab',()=>{
 for(const item of PROFILE_PRESETS){
  const p=makeWorkshopPreset('profile');p.parts.profile={customCss:item.customCss};
  const ids=decorationPreviewScenes(p).map(s=>s.id);
  expect(ids).toEqual(['profile-current','profile-settings','profile-schedule']);
  for(const id of ids){
   const {css,markup}=renderChatDecorationSample(p,id);
   expect(css).toContain('grid-template-columns: var(--rail)');
   expect(css).toContain(item.customCss);
   const host=document.createElement('div');host.innerHTML=markup;
   expect(host.querySelector('[aria-selected="true"]')?.getAttribute('data-preview-scene')).toBe(id);
   let selected='';
   const cleanup=bindDecorationPreview(host,{},false,()=>{},value=>{selected=value;});
   host.querySelector<HTMLButtonElement>('[data-tab="日程"]')!.click();
   expect(selected).toBe('profile-schedule');
   cleanup();
  }
 }
});
