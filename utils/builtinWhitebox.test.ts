import {describe,it,expect} from 'vitest';
import {BUILTIN_WHITEBOX_PRESETS} from './builtinWhitebox';
import {decorationPatches} from './chatDecoration';
import {portableCssImages} from './cssImageAssets';

// Export may use base64 instead of percent-encoded SVG; compare decoded assets and CSS.
const normalizeImages=(css:string)=>css.replace(/data:image\/svg\+xml(;base64)?,([^"\n]*)/g,(_,base64,body)=>
 'svg:'+JSON.stringify(base64?Buffer.from(body,'base64').toString('utf8'):decodeURIComponent(body)));

describe('bundled whitebox outfits',()=>{
 it.each(BUILTIN_WHITEBOX_PRESETS)('$name is portable and applies a complete outfit without changing sounds',async item=>{
  const preset=item.read();
  expect(preset.parts.layout?.chatAvatarSize).toBe('medium');
  expect(preset.parts.css).toContain('data:image/svg+xml');
  expect(preset.parts.css).not.toMatch(/url\(["']?https?:/);
  const patch=await decorationPatches(preset,['layout','bubbles','background','psyche','css'],'character',{id:'sample',chatSound:{src:'ding'}} as any,{} as any);
  expect(patch.character.chromeCustomCss).toContain('blobref:');expect(normalizeImages(await portableCssImages(patch.character.chromeCustomCss!))).toBe(normalizeImages(preset.parts.css!));
  expect(patch.character.chatAppearance?.chatAvatarSize).toBe('medium');
  expect(patch.character.chatSound).toEqual({src:'ding'});
 });
 it('keeps builtins unchanged when a returned copy is edited',()=>{
  const item=BUILTIN_WHITEBOX_PRESETS[0];const p=item.read();p.parts.css='changed';
  expect(item.read().parts.css).not.toBe('changed');
 });
 it('applies 银晕 with a timestamp below every visible avatar',async()=>{
  const preset=BUILTIN_WHITEBOX_PRESETS.find(item=>item.id==='builtin-silver-halo')!.read();
  const patch=await decorationPatches(preset,['layout'],'character',{id:'sample'} as any,{} as any);
  expect(patch.character.chatAppearance).toMatchObject({chatAvatarMode:'every_message',chatTimestampPosition:'below_avatar',chatShowTimestamp:'always'});
 });
});
