import {describe,it,expect} from 'vitest';
import {stampBeautyCss,readCssAttribution,cssImportPreset,isCssImportCandidate,readLegacyWhiteboxShare} from './beautyCssAttribution';
import {canEditDecoration} from './decorationLibrary';
describe('CSS public attribution',()=>{
 it.each(['date','story'] as const)('preserves %s reading base, CSS and author terms in a CSS share',category=>{
  const css='.meeting-reading { --meeting-paper:#112233; }';
  const text=stampBeautyCss(css,{name:'夜读',credit:'作者',category,readingPreset:'night',allowRemix:false,allowRedistribute:false});
  const imported=cssImportPreset(text,'文件名');
  expect(imported.preset.parts).toEqual({[category]:{preset:'night',customCss:css}});
  expect(imported.origin).toMatchObject({credit:'作者',allowRemix:false,allowRedistribute:false});
  expect(cssImportPreset(css,'无署名',category).preset.parts[category]).toEqual({preset:'novel',customCss:css});
  expect(cssImportPreset(css,'无署名',category).origin).toBeNull();
  const old=stampBeautyCss(css,{name:'旧分享',credit:'作者',category});
  expect(cssImportPreset(old,'旧分享').preset.parts[category]?.preset).toBe('novel');
  expect(()=>stampBeautyCss(css,{name:'错误',credit:'作者',category,readingPreset:'bad' as any})).toThrow();
 });
 it.each(['whitebox','bubbles','psyche','avatar','background'] as const)('round trips %s without claiming authorship',category=>{
  const css=category==='psyche'?'.sully-psyche-card { color: red; }':category==='bubbles'?'.sully-bubble-ai { color: red; }':category==='avatar'?'.sully-chat-avatar-wrap { color: red; }':'.sully-chat-root { color: red; }';
  const text=stampBeautyCss(css,{name:'作品',credit:'作者',category,allowRemix:false,allowRedistribute:false});
  const result=cssImportPreset(text,'文件名');expect(result.preset.name).toBe('作品');expect(result.origin).toMatchObject({kind:'imported',credit:'作者',allowRemix:false});expect(canEditDecoration(result.origin!)).toBe(false);
  if(category==='psyche')expect(result.preset.parts.psyche?.customCss).toBe(css);
  if(category==='bubbles')expect(result.preset.parts.bubbles?.customCss).toBe(css);
 });
 it('places an unsigned bubble stylesheet in the chosen category without inventing its author',()=>{const result=cssImportPreset('.sully-bubble-ai {color:red}','旧气泡','bubbles');expect(result.preset.parts.bubbles?.customCss).toContain('color:red');expect(result.preset.parts.css).toBeUndefined();expect(result.origin).toBeNull();});
 it('keeps unknown legacy CSS unclassified until user confirms its source',()=>{expect(cssImportPreset('.sully-chat-root { color: red; }','旧版').origin).toBeNull();});
 it('exports only whitelisted public fields and escapes comment terminators',()=>{
  const text=stampBeautyCss('.sully-chat-root { color: red; }',{name:'测试',credit:'作者 */ x',category:'whitebox',password:'private-secret',authorCode:'private-author',token:'private-token'} as any);
  expect(text).not.toContain('private-');expect(readCssAttribution(text)?.credit).toBe('作者 */ x');expect(text).toContain('作者 ＊／ x');
  expect(stampBeautyCss(text,{name:'测试',credit:'新的署名',category:'whitebox'}).match(/SULLY-BEAUTY-V1/g)).toHaveLength(1);
 });
 it('does not silently downgrade a damaged attribution header to unsigned CSS',()=>{expect(()=>cssImportPreset('/* SULLY-BEAUTY-V1 damaged */ .sully-chat-root {color:red}','test')).toThrow('署名');});
});

it('routes attribute-selector CSS through source confirmation, but keeps JSON and sound packages separate',()=>{
 const css='[data-owner="ai"] .sully-bubble-ai { color: red; }';
 expect(isCssImportCandidate(css)).toBe(true);expect(cssImportPreset(css,'旧版').preset.parts.css).toBe(css);
 expect(isCssImportCandidate('SULLYSND1:payload')).toBe(false);expect(isCssImportCandidate('{"format":"sullyos-chat-decoration"}')).toBe(false);
 expect(()=>cssImportPreset('{"format":"sullyos-chat-decoration","version":1,"parts":{"css":".x{color:red}"}}','test')).toThrow('仅接收 CSS');
});

it('decodes old batch codes and JSON without confusing attribute selectors',()=>{
 const items=[{name:'旧白框',code:'.sully-chat-root { color:red; }'}];const encoded='SULLYCSS1:'+Buffer.from(JSON.stringify(items),'utf8').toString('base64');
 expect(readLegacyWhiteboxShare(encoded)).toEqual(items);expect(readLegacyWhiteboxShare(JSON.stringify(items))).toEqual(items);
 expect(readLegacyWhiteboxShare('[data-x] {color:red}')).toBeNull();expect(()=>readLegacyWhiteboxShare('SULLYCSS1:broken')).toThrow();
});
