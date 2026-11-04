import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect,vi} from 'vitest';

vi.mock('../context/OSContext',()=>({useOS:()=>({characters:[{id:'c1'}],activeCharacterId:'c1',appearancePresets:[],openApp(){},closeApp(){}})}));
vi.mock('../components/appearance/BeautyShareChannel',()=>({default:()=>React.createElement('div',{className:'beauty-wardrobe'})}));

describe('legacy bubble maker entry',()=>{
 it('wraps the wardrobe in its own vertical scroller because the app shell clips overflow',async()=>{
  const {default:Entry}=await import('../components/chat/LegacyBubbleMakerEntry');
  const html=renderToStaticMarkup(React.createElement(Entry));
  expect(html).toMatch(/^<div class="[^"]*overflow-y-auto[^"]*"><div class="beauty-wardrobe">/);
 });
});
