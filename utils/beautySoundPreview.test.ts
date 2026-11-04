import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,it,expect} from 'vitest';
import BeautyPresetPreview from '../components/share/BeautyPresetPreview';
const data=(src:string)=>({format:'sullyos-chat-decoration',version:1,name:'Sound',parts:{sound:{src,volume:.6}}});
describe('notification sound previews',()=>{
 it('uses a lightweight waveform without building a chat preview in cards',()=>{
  const html=renderToStaticMarkup(React.createElement(BeautyPresetPreview,{data:data('ding'),compact:true}));
  expect(html).toContain('data-thumbnail-part="sound"');expect(html).toContain('点开试听');
  expect(html).not.toContain('data-beauty-preview-source');expect(html).not.toContain('<button');
 });
 it('offers explicit audition only for audible sound in details',()=>{
  expect(renderToStaticMarkup(React.createElement(BeautyPresetPreview,{data:data('ding')}))).toContain('试听提示音');
  expect(renderToStaticMarkup(React.createElement(BeautyPresetPreview,{data:data('none')}))).not.toContain('试听提示音');
 });
});
