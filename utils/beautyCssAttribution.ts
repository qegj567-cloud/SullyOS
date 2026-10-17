import {parseDecorationText,validateDecoration,type DecorationPreset} from './chatDecoration';
import {makeWorkshopPreset,replaceWorkshopCss,type DecorationWorkshop} from './decorationWorkshop';
import type {DecorationOrigin} from './decorationLibrary';
export interface CssAttribution {name:string;credit:string;category:DecorationWorkshop;allowRemix?:boolean;allowRedistribute?:boolean}
const categories=['whitebox','bubbles','avatar','background','psyche','sound','schedule','journal','collaboration'];
const marker=/\/\* SULLY-BEAUTY-V1 ([^\r\n]*?) \*\//;
export function readCssAttribution(css:string):CssAttribution|null{
 const match=css.match(marker);if(!match){if(css.includes('SULLY-BEAUTY-V1'))throw Error('CSS 署名标记不完整，请使用原始分享内容');return null;}
 try{const m=JSON.parse(decodeURIComponent(match[1]));if(typeof m.credit!=='string'||!m.credit.trim()||m.credit.length>60||typeof m.name!=='string'||m.name.length>80||!categories.includes(m.category))throw Error();
 return {name:m.name,credit:m.credit,category:m.category,allowRemix:typeof m.allowRemix==='boolean'?m.allowRemix:undefined,allowRedistribute:typeof m.allowRedistribute==='boolean'?m.allowRedistribute:undefined};}catch{throw Error('CSS 署名标记无效，请使用原始分享内容');}
}
export function stampBeautyCss(css:string,meta:CssAttribution){
 const clean={name:meta.name.slice(0,80),credit:meta.credit.trim().slice(0,60),category:meta.category,allowRemix:meta.allowRemix,allowRedistribute:meta.allowRedistribute};
 if(!clean.credit)throw Error('请先填写分享署名');
 const visible=clean.credit.replace(/[\r\n]/g,' ').replace(/\*\//g,'＊／');
 return `/* SULLY-BEAUTY-V1 ${encodeURIComponent(JSON.stringify(clean))} */\n/* SullyOS · 作者：${visible} */\n${css.replace(marker,'').replace(/\/\* SullyOS · 作者：[^\n]*?\*\/\s*/,'').trim()}`;
}
/** CSS may start with an attribute selector; only successfully parsed JSON is a package. */
export function isCssImportCandidate(text:string){
 const source=text.replace(/^\uFEFF/,'').trim();if(source.startsWith('SULLYSND1:'))return false;
 try{JSON.parse(source);return false;}catch{return true;}
}
export function cssImportPreset(css:string,name:string,fallbackCategory:DecorationWorkshop='whitebox'):{preset:DecorationPreset;origin:DecorationOrigin|null}{
 const meta=readCssAttribution(css);const text=css.replace(marker,'').replace(/\/\* SullyOS · 作者：[^\n]*?\*\/\s*/,'').trim();
 if(!isCssImportCandidate(text))throw Error('这里仅接收 CSS，请通过文件导入装扮包');
 const checked=parseDecorationText(text,name);
 if(checked.parts.css===undefined)throw Error('这里仅接收 CSS，请通过文件导入装扮包');
 let preset=checked;
 if(meta||fallbackCategory!=='whitebox'){const category=meta?.category||fallbackCategory;preset=makeWorkshopPreset(category);preset.name=meta?.name||name;
  if(category==='collaboration')preset.parts.collaboration!.customCss=text;
  else if(category==='journal')preset.parts.journal!.customCss=text;
  else if(category==='schedule')preset.parts.schedule!.customCss=text;
  else if(category==='bubbles')preset.parts.bubbles!.customCss=text;
  else if(category==='psyche')preset.parts.psyche!.customCss=text;
  else if(category==='avatar'||category==='background')preset.parts={css:replaceWorkshopCss('',category,text)};
  else preset={...checked,name:meta?.name||name};
 }
 return {preset:validateDecoration(preset),origin:meta?{kind:'imported',credit:meta.credit,allowRemix:meta.allowRemix,allowRedistribute:meta.allowRedistribute}:null};
}

/** The former whitebox editor shared multiple presets as SULLYCSS1 or a JSON array. */
export function readLegacyWhiteboxShare(text:string):{name:string;code:string}[]|null{
 const source=text.trim();if(!source.startsWith('SULLYCSS1:')&&!source.startsWith('['))return null;
 let value:unknown;try{value=JSON.parse(source.startsWith('SULLYCSS1:')?new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(source.slice(10)),char=>char.charCodeAt(0))):source);}catch{if(source.startsWith('SULLYCSS1:'))throw Error('旧版白框分享码不完整');return null;}
 if(!Array.isArray(value))throw Error('旧版白框分享内容无效');
 if(!value.length||value.length>200||value.some(item=>!item||typeof item.name!=='string'||typeof item.code!=='string'))throw Error('旧版白框预设列表无效');
 if(new TextEncoder().encode(JSON.stringify(value)).length>40*1024*1024)throw Error('预设超过 40 MB');
 return value.map(item=>({name:item.name.slice(0,60),code:item.code}));
}
