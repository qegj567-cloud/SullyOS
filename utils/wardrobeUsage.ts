import {validateCollaborationAppearance,type CollaborationAppearance} from '../features/collaboration/appearance';
import {targetAvatarFrameCss} from './avatarFrameTarget';
import type {CharacterProfile, OSTheme, ChatTheme} from '../types';
import {LAYOUT_DEFAULTS, pickDecorationLayout, resolveDecorationTheme} from './chatDecoration';
import {mergeChatFineTune} from './chatFineTuneCss';
import {resolvePsycheAppearance} from './psycheAppearance';
import {resolveActiveSound, stripWhiteboxSoundDirective} from './whiteboxSound';
import {workshopBlock} from './decorationWorkshop';
import {resolveRefToDataUrl, blobToDataUrl} from './blobRef';
import {portableCssImages} from './cssImageAssets';

export type WardrobeUsage = '当前使用中' | '部分使用中' | '';
export type WardrobeUsageReader = (pack: unknown) => Promise<WardrobeUsage>;
const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const css = (v: string) => stripWhiteboxSoundDirective(v).replace(/\/\*[\s\S]*?\*\//g, '').trim();
const sound = (v: any) => !v?.src || v.src === 'none' ? {src:'none'} : {src:v.src,volume:v.volume ?? .6};
const bubble = (v: any) => v && {user:{borderRadius:20,opacity:1,...v.user},ai:{borderRadius:20,opacity:1,...v.ai},customCss:css(v.customCss || '')};
const app = (v: any, fallback: string) => ({...v,preset:v?.preset || fallback,name:undefined,customCss:css(v?.customCss || '')});
const psyche = (v: any) => ({styleId:v.styleId,customCss:css(v.customCss || ''),...(v.styleId==='custom'?{customColors:{bg:'#1f2937',accent:'#fbbf24',text:'#f1f5f9',...v.customColors}}:{})});

/** Resolve local asset representations only. Never download an author's remote images
 * just to add a badge. Cache reads for the selected character and visible cards. */
export function createWardrobeUsageReader(theme: OSTheme, char: CharacterProfile | undefined, activeBubble: ChatTheme, icons: Record<string,string>, normalizeAsset?: (value:string)=>Promise<string>, collaborationAppearance?:CollaborationAppearance): WardrobeUsageReader {
 const strings = new Map<string,Promise<string>>();
 const normalizeString = (value:string):Promise<string> => {
  if (!strings.has(value)) strings.set(value,(async()=>{
   if(normalizeAsset)return normalizeAsset(value);
   if(value.startsWith('blobref:'))return resolveRefToDataUrl(value);
   if(value.startsWith('blob:') || /^\/(?!\/)[^\s"\'<> {}]+$/.test(value)) {
    const response=await fetch(value);if(!response.ok)throw Error('Local asset unavailable');
    return blobToDataUrl(await response.blob());
   }
   if(value.includes('url(')&&value.includes('blobref:'))return portableCssImages(value);
   return value;
  })());
  return strings.get(value)!;
 };
 const normalize = async(value:any):Promise<any> => {
  if(typeof value==='string')return normalizeString(value);
  if(Array.isArray(value))return Promise.all(value.map(normalize));
  if(object(value)){const out:Record<string,unknown>={};for(const key of Object.keys(value).sort())if(value[key]!==undefined)out[key]=await normalize(value[key]);return out;}
  return value;
 };
 const equal=async(a:any,b:any)=>a===b || JSON.stringify(await normalize(a))===JSON.stringify(await normalize(b));
 const effective=resolveDecorationTheme(theme,char);
 const current:Record<string,any>={
  layout:{...LAYOUT_DEFAULTS,...pickDecorationLayout({...effective,...(char?mergeChatFineTune(effective,char.chatFineTune):{})})},
  bubbles:bubble(activeBubble),background:{image:(char?.chatBackground??theme.chatBackground)||null,style:effective.chatBackgroundStyle||'plain'},
  sound:sound(resolveActiveSound(char?.chromeCustomCss,char?.chatSound,effective.chatChromeCustomCss,theme.chatSound)),
  css:[effective.chatChromeCustomCss,char?.chromeCustomCss].filter(Boolean).join('\n'),
  psyche:psyche(resolvePsycheAppearance(theme,char)),date:app(char?.dateAppearance,'none'),story:app(theme.storyAppearance,'none'),
  ...(collaborationAppearance?{collaboration:validateCollaborationAppearance(collaborationAppearance)}:{}),
  schedule:app(theme.scheduleCardAppearance,'original'),journal:app(theme.journalAppearance,'original'),
 };
 const results=new WeakMap<object,Promise<WardrobeUsage>>();
 const read=async(pack:any):Promise<WardrobeUsage>=>{
  if(!object(pack))return '';
  const matches:boolean[]=[];
  if(pack.format==='sullyos-chat-decoration'&&object(pack.parts)){
   for(const [key,value] of Object.entries(pack.parts)){
    if(!(key in current))continue;
    let expected:any=value,actual=current[key];
    if(key==='collaboration'){expected=validateCollaborationAppearance(value);expected={...expected,customCss:css(expected.customCss)};actual={...actual,customCss:css(actual.customCss)};}
    if(key==='layout')expected={...LAYOUT_DEFAULTS,...value as object};
    if(key==='bubbles')expected=bubble(value);
    if(key==='sound')expected=sound(value);
    if(key==='psyche')expected=psyche(value);
    if(['date','story','schedule','journal'].includes(key))expected=app(value,key==='date'||key==='story'?'none':'original');
    if(key==='css'){
     const source=String(value||'');
     const blocks=[...source.matchAll(/\/\* sully-composer:(avatar|background) \*\/\n?([\s\S]*?)\/\* end-sully-composer:\1 \*\//g)];
     if(blocks.length&&!source.replace(workshopBlock('avatar'),'').replace(workshopBlock('background'),'').trim()){
      for(const block of blocks){const installed=[...String(actual).matchAll(workshopBlock(block[1] as 'avatar'|'background'))].map(m=>m[1]).join('\n');matches.push(await equal(targetAvatarFrameCss(css(block[2]),'both').trim(),targetAvatarFrameCss(css(installed),'both').trim()));}
      continue;
     }
     expected=css(source);actual=css(actual);
    }
    matches.push(await equal(expected,actual));
   }
  }else if(object(pack.theme)){
   // Only fields present in the saved theme take part; unrelated later settings do not.
   const expected={...pack.theme},actual:Record<string,unknown>={};
   delete expected.launcherWidgetImage;
   for(const key of Object.keys(expected))actual[key]=(theme as any)[key];
   matches.push(await equal(expected,actual));
   if(pack.customIcons)matches.push(await equal(pack.customIcons,icons));
  }
  return matches.length&&matches.every(Boolean)?'当前使用中':matches.some(Boolean)?'部分使用中':'';
 };
 return pack=>{
  if(!object(pack))return Promise.resolve('');
  if(!results.has(pack))results.set(pack,read(pack).catch(()=>''));
  return results.get(pack)!;
 };
}
