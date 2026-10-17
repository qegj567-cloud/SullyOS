import {parseWhiteboxSound} from './whiteboxSound';
export type BeautyShareSelection = Record<string, boolean>;
export const DEFAULT_SHARE_SELECTION: BeautyShareSelection = {};
export interface BeautyShareContent {key:string;label:string;required?:boolean}
const soundDirective = /\/\*\s*@sully-sound\b[^{}]*\{[^{}]*\}\s*\*\//gi;
const stripSound = (css: string) => css.replace(soundDirective, '');
const block = (kind:string) => new RegExp(`/\\* sully-composer:${kind} \\*/[\\s\\S]*?/\\* end-sully-composer:${kind} \\*/`, 'g');
const labels:Record<string,string>={collaboration:'协同工作（主题、头像样式与 CSS）',css:'白框 / 自定义样式',layout:'聊天布局',bubbles:'气泡预设',avatar:'头像框',background:'聊天背景',psyche:'心象',sound:'聊天提示音',date:'见面界面',story:'剧情界面',schedule:'日程表',journal:'交换日记'};
const appearanceParts:Record<string,string>={css:'chatChromeCustomCss',background:'chatBackground',psyche:'chatPsyche',sound:'chatSound',story:'storyAppearance',schedule:'scheduleCardAppearance',journal:'journalAppearance'};
const specialChat=new Set([...Object.values(appearanceParts),'chatBackgroundStyle']);
const isLayout=(key:string)=>(key.startsWith('chat')&&!specialChat.has(key))||key==='acnhChatSync';
function partsOf(pack:any):any {
  if(pack?.format==='sullyos-chat-decoration')return pack.parts||{};
  if(pack?.type!=='sully_appearance_preset')return {};
  const parts:any={};
  for(const [key,field] of Object.entries(appearanceParts))if(pack.theme?.[field]!==undefined)parts[key]=pack.theme[field];
  if(pack.chatLayout||Object.keys(pack.theme||{}).some(isLayout))parts.layout=true;
  if(pack.chatThemes?.length)parts.bubbles=pack.chatThemes;
  return parts;
}
export function beautyShareContents(value: unknown):BeautyShareContent[] {
  const pack=value as any, parts=partsOf(pack), result:BeautyShareContent[]=[];
  if(pack?.type==='sully_appearance_preset'){
    result.push({key:'theme',label:'桌面外观（主体）',required:true});
    if(Object.keys(pack.customIcons||{}).length)result.push({key:'icons',label:'桌面图标'});
  }
  const css=parts.css||'';
  for(const key of Object.keys(labels)){
    let exists=parts[key]!==undefined;
    if(key==='css')exists=!!stripSound(css).replace(block('avatar'),'').replace(block('background'),'').trim();
    if(key==='avatar')exists=block('avatar').test(css);
    if(key==='background')exists=exists||block('background').test(css);
    if(key==='sound')exists=exists||!!parseWhiteboxSound(css);
    if(!exists)continue;
    let label=labels[key];
    if(key==='bubbles'){
      const list=Array.isArray(parts.bubbles)?parts.bubbles:[parts.bubbles];
      label+=`（${list.length} 套）：`+list.map((b:any)=>b.name||'未命名气泡').join('、');
      if(list.some((b:any)=>b.user?.avatarDecoration||b.ai?.avatarDecoration))label+='（含气泡内嵌头像框）';
    }
    result.push({key,label});
  }
  return result;
}
function selectCss(css:string,selection:BeautyShareSelection):string {
  if(selection.css===false) return ['avatar','background'].filter(k=>selection[k]!==false).flatMap(k=>css.match(block(k))||[]).join('\n');
  for(const key of ['avatar','background'])if(selection[key]===false)css=css.replace(block(key),'');
  return selection.sound===false?stripSound(css):css;
}
/** Only structured parts / explicitly marked CSS blocks can be split reliably.
 * Arbitrary handwritten CSS remains one selectable unit, never guessed apart. */
export function selectBeautyShareContents(value:unknown,selection:BeautyShareSelection=DEFAULT_SHARE_SELECTION):any {
  const pack=structuredClone(value) as any;
  const parts=partsOf(pack), embeddedSound=parseWhiteboxSound(parts.css);
  if(pack?.type==='sully_appearance_preset'){
    if(selection.icons===false)delete pack.customIcons;
    if(selection.layout===false){delete pack.chatLayout;for(const key of Object.keys(pack.theme))if(isLayout(key))delete pack.theme[key];}
    for(const [key,field] of Object.entries(appearanceParts))if(key!=='css'&&selection[key]===false)delete pack.theme[field];
    if(selection.background===false)delete pack.theme.chatBackgroundStyle;
    if(selection.bubbles===false){delete pack.chatThemes;delete pack.theme.chatDefaultBubbleStyle;}
    if(typeof parts.css==='string'){
      const css=selectCss(parts.css,selection);if(css.trim())pack.theme.chatChromeCustomCss=css;else delete pack.theme.chatChromeCustomCss;
    }
    if(selection.css===false&&selection.sound!==false&&embeddedSound)pack.theme.chatSound=embeddedSound;
  }else if(pack?.format==='sullyos-chat-decoration'){
    for(const key of Object.keys(pack.parts))if(key!=='css'&&selection[key]===false)delete pack.parts[key];
    if(typeof parts.css==='string'){
      const css=selectCss(parts.css,selection);if(css.trim())pack.parts.css=css;else delete pack.parts.css;
    }
    if(selection.css===false&&selection.sound!==false&&embeddedSound&&pack.parts.sound===undefined)pack.parts.sound=embeddedSound;
  }
  return pack;
}
