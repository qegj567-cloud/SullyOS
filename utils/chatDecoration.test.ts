import {readFileSync} from 'node:fs';
import {File} from 'node:buffer';
import {embedShareInPng} from './pngShare';
import {describe,it,expect,vi} from 'vitest';
vi.mock('./blobRef',()=>({resolveRefToDataUrl:vi.fn(async(v:string)=>v==='blobref:missing'?'':'data:image/png;base64,AA=='),blobToDataUrl:vi.fn(),migrateDataUrlToRef:vi.fn(async(v:string)=>v.startsWith('data:')?'blobref:new':v),migrateChatThemeBlobRefs:vi.fn(async(v:any)=>v)}));
import {decorationPatches,exportDecoration,parseDecorationText,validateDecoration,resolveDecorationTheme,decorationCssPatch,LAYOUT_DEFAULTS,readDecorationFile} from './chatDecoration';
import {PRESET_THEMES} from '../components/chat/ChatConstants';
import {upsertWhiteboxSound} from './whiteboxSound';
const char:any={id:'a',name:'Private name',systemPrompt:'SECRET',chromeCustomCss:'.x{color:red}',chatSound:{src:'chime'},chatFineTune:{enabled:true,chatBubbleFontSize:18}};
const base:any={chatHeaderStyle:'telegram',chatChromeCustomCss:'.base{color:blue}',chatSound:{src:'ding'},apiKey:'SECRET',wallpaper:'SECRET'};
const wrap=(parts:any)=>({format:'sullyos-chat-decoration',version:1,name:'Test',parts});
describe('portable chat decoration',()=>{
 it('keeps legacy global layout and CSS unchanged without imported overrides',()=>{const old={...base,chatAvatarMode:'every_message',chatEmojiSize:'large'};expect(resolveDecorationTheme(old,{...char,chatAppearance:undefined})).toEqual(old);});
 it('round trips migrated avatar frequency and sticker size within layout only',async()=>{const old={...base,chatAvatarMode:'every_message',chatEmojiSize:'large'};const preset=await exportDecoration('Legacy layout',old,undefined,PRESET_THEMES.default);const patch=await decorationPatches(preset,['layout'],'character',char,base);expect(patch.character.chatAppearance).toMatchObject({chatAvatarMode:'every_message',chatEmojiSize:'large'});expect(patch.character.chromeCustomCss).toBeUndefined();expect(base.chatEmojiSize).toBeUndefined();});
 it('exports five effective parts, inherited layout/css and local assets without private data',async()=>{
  const p=await exportDecoration('Test',base,{...char,chatBackground:'blobref:picture'},PRESET_THEMES.dream);
  expect(Object.keys(p.parts)).toHaveLength(5);expect(p.parts.layout).toMatchObject({chatHeaderStyle:'telegram',chatBubbleFontSize:18});expect(p.parts.css).toContain('.base');expect(p.parts.background?.image).toMatch(/^data:image/);expect(JSON.stringify(p)).not.toMatch(/SECRET|Private name|blobref:/);
 });
 it('fails instead of sharing a dead local asset',async()=>{await expect(exportDecoration('x',base,{...char,chatBackground:'blobref:missing'},PRESET_THEMES.default)).rejects.toThrow('丢失');});
 it('never interprets leading CSS comments as image URLs',async()=>{const p=await exportDecoration('x',{...base,chatChromeCustomCss:'/* comment */ .x{color:red}'},undefined,PRESET_THEMES.default);expect(p.parts.css).toContain('/* comment */');});
 it('rejects unknown versions, foreign JSON, invalid enum and script markup',()=>{
  expect(()=>validateDecoration({...wrap({css:'.x{}'}),version:2})).toThrow();expect(()=>parseDecorationText('{"apiKey":"secret"}')).toThrow();expect(()=>validateDecoration(wrap({layout:{chatHeaderStyle:'fake'}}))).toThrow();expect(()=>parseDecorationText('<script>alert(1)</script>')).toThrow();
 });
 it('recognizes CSS with fences and legacy sound binding',()=>{
  expect(parseDecorationText('```css\n.x{color:red}\n```').parts).toEqual({css:'.x{color:red}'});
  const p=parseDecorationText(upsertWhiteboxSound('.x{color:red}',{src:'pop'}));expect(p.parts.sound?.src).toBe('pop');
 });
 it('preserves embedded sound when manually replacing or resetting CSS',()=>{
  const bound={...char,chromeCustomCss:upsertWhiteboxSound('.x{color:red}',{src:'pop'}),chatSoundBound:true,chatDecorationCssIsolated:true};
  expect(decorationCssPatch('', 'character',bound,base,true)).toMatchObject({chromeCustomCss:'',chatSound:{src:'pop'},chatSoundBound:false,chatDecorationCssIsolated:false});
  expect(decorationCssPatch('.new{}','global',char,{...base,chatChromeCustomCss:upsertWhiteboxSound('.old{}',{src:'ding'})})).toMatchObject({chatSound:{src:'ding'}});
 });
 it('keeps attribute-selector CSS out of the JSON parser',()=>{expect(parseDecorationText('[data-test] {color:red}').parts.css).toContain('[data-test]');});
 it('identifies preset PNG cards, rejects foreign cards and corrupt PNGs',async()=>{
  const png=new Uint8Array(readFileSync(new URL('../public/icons/icon-192.png',import.meta.url)));
  const metadata:any={format:'sullyos-share',version:1,kind:'chat-decoration',title:'x',author:'',restrictions:'',style:'paper',fileName:'x.json',mimeType:'application/json'};
  const payload=new TextEncoder().encode(JSON.stringify(wrap({css:'.x{color:red}'})));
  const file=(bytes:Uint8Array)=>new File([new Uint8Array(bytes).buffer], 'share.png',{type:'image/png'}) as any;
  const result=await readDecorationFile(file(embedShareInPng(png,metadata,payload)));expect(result.kind).toBe('preset');
  await expect(readDecorationFile(file(embedShareInPng(png,{...metadata,kind:'character'},payload)))).rejects.toThrow('角色卡');
  const broken=png.slice();broken[50]^=1;await expect(readDecorationFile(file(broken))).rejects.toThrow();
 });
 it('recognizes standalone bubble JSON without carrying id or extra fields',()=>{
  const p=parseDecorationText(JSON.stringify({...PRESET_THEMES.dream,apiKey:'SECRET'}));expect(p.parts.bubbles?.name).toBe('Dream');expect(JSON.stringify(p)).not.toContain('SECRET');
 });
 it('only applies selected parts and preserves independent sound on CSS import',async()=>{
  const result=await decorationPatches(validateDecoration(wrap({css:'.new{color:gray}',sound:{src:'pop'},layout:{chatHeaderStyle:'minimal'}})),['css'],'character',char,base);
  expect(result.character.chromeCustomCss).toBe('.new{color:gray}');expect(result.character.chatSound).toEqual(char.chatSound);expect(result.character.chatFineTune).toBeUndefined();expect(result.theme).toEqual({});
 });
 it('sound-only import removes old bound sound without removing styling',async()=>{
  const result=await decorationPatches(validateDecoration(wrap({sound:null})),['sound'],'character',{...char,chromeCustomCss:upsertWhiteboxSound('.keep{color:red}',{src:'ding'})},base);
  expect(result.character.chromeCustomCss).toContain('.keep');expect(result.character.chromeCustomCss).not.toContain('@sully-sound');expect(result.character.chatSound?.src).toBe('none');
 });
 it('global import applies global bubble/background instead of mutating current character',async()=>{
  const preset=await exportDecoration('x',base,char,PRESET_THEMES.dream);const result=await decorationPatches(preset,['layout','bubbles','background','sound','css'],'global',char,base);
  expect(result.character).toEqual({});expect(result.theme.chatDefaultBubbleStyle).toBe(result.bubble?.id);expect(result.theme.chatBackground).toBe('');expect(result.theme.chatHeaderStyle).toBe('telegram');
 });
 it('character imported layout survives toggling and does not mutate global defaults',async()=>{
  const result=await decorationPatches(validateDecoration(wrap({layout:{chatHeaderStyle:'minimal'},background:{style:'paper',image:null}})),['layout','background'],'character',char,base);
  const applied={...char,...result.character};expect(resolveDecorationTheme(base,applied).chatHeaderStyle).toBe('minimal');expect(resolveDecorationTheme(base,{...applied,chatFineTune:{enabled:false}}).chatHeaderStyle).toBe('telegram');expect(applied.chatBackground).toBe('');expect(base.chatHeaderStyle).toBe('telegram');
 });
 it('layout-only application preserves the unselected character background style',async()=>{const result=await decorationPatches(validateDecoration(wrap({layout:{chatHeaderStyle:'minimal'}})),['layout'],'character',{...char,chatAppearance:{chatBackgroundStyle:'mesh'}},base);expect(result.character.chatAppearance?.chatBackgroundStyle).toBe('mesh');});
 it('isolated imported CSS does not re-add recipient global CSS on export',async()=>{const p=await exportDecoration('x',base,{...char,chatDecorationCssIsolated:true},PRESET_THEMES.default);expect(p.parts.css).toBe(char.chromeCustomCss);});
});
