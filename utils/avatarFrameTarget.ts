import {cssRuleSelectors, maskCssComments, splitCssSelectors} from './cssRuleSelectors';
import type {DecorationPreset} from './chatDecoration';
export type AvatarFrameTarget = 'both' | 'user' | 'ai';
export const AVATAR_FRAME_TARGETS = [['both','双方使用'],['user','用户使用（我）'],['ai','角色使用（TA）']] as const;
const block=()=>/\/\* sully-composer:avatar \*\/\n?([\s\S]*?)\/\* end-sully-composer:avatar \*\//g;
const wrapBlock=(content:string)=>`/* sully-composer:avatar */\n${content.trim()}\n/* end-sully-composer:avatar */`;
const sideScopeRe=()=>/:(?:where|is)\(\s*\.sully-chat-message-(?:user|ai)\s+\*\s*\)/g;
const sidePrefixRe=()=>/(?:\.sully-chat-message)?\.sully-chat-message-(?:user|ai)(?![\w-])\s+/g;
const avatarHookRe=()=>/\.sully-chat-(?:avatar-wrap|avatar-frame|message-avatar-img)(?![\w-])/g;

export interface AvatarFrameSlots {
 /** Frame shared by both sides (or an inseparable rule styling user and ai together). */
 shared?: string;
 /** User-side frame CSS, scoped to `.sully-chat-message-user`. */
 user?: string;
 /** Character-side frame CSS, scoped to `.sully-chat-message-ai`. */
 ai?: string;
 /** True only when a single rule or @media block mixes user and ai selectors inseparably. */
 coupled?: boolean;
}

function classifyAvatarCss(css:string):AvatarFrameTarget|'split'{
 const masked=maskCssComments(css);
 const {rules}=cssRuleSelectors(css);
 let hasUser=false,hasAi=false,hasBoth=false;
 for(const rule of rules){
  for(const raw of splitCssSelectors(masked.slice(rule.start,rule.end))){
   const selector=raw.trim();
   if(!selector)continue;
   const u=/\.sully-chat-message-user(?![\w-])/.test(selector);
   const a=/\.sully-chat-message-ai(?![\w-])/.test(selector);
   if(u&&!a)hasUser=true;
   else if(a&&!u)hasAi=true;
   else hasBoth=true;
  }
 }
 if(hasUser&&!hasAi&&!hasBoth)return 'user';
 if(hasAi&&!hasUser&&!hasBoth)return 'ai';
 if(hasUser&&hasAi&&!hasBoth)return 'split';
 return 'both';
}

function splitTopLevelAvatarCss(source:string):{user:string;ai:string}|null{
 const statements:string[]=[];
 let start=0,depth=0,quote='',comment=false;
 for(let i=0;i<source.length;i++){
  const c=source[i],next=source[i+1];
  if(comment){if(c==='*'&&next==='/'){comment=false;i++;}continue;}
  if(quote){if(c==='\\'){i++;continue;}if(c===quote)quote='';continue;}
  if(c==='/'&&next==='*'){comment=true;i++;continue;}
  if(c==='"'||c==="'"){quote=c;continue;}
  if(c==='\\'){i++;continue;}
  if(c==='{')depth++;
  else if(c==='}'){
   if(depth>0)depth--;
   if(depth===0){const s=source.slice(start,i+1).trim();if(s)statements.push(s);start=i+1;}
  }else if(c===';'&&depth===0){
   const s=source.slice(start,i+1).trim();if(s)statements.push(s);start=i+1;
  }
 }
 const tail=source.slice(start).trim();
 if(tail)statements.push(tail);
 const userRules:string[]=[],aiRules:string[]=[],sharedAtRules:{raw:string;keyframe?:string}[]=[];
 for(const stmt of statements){
  if(!cssRuleSelectors(stmt).rules.length){
   const kf=/^@(?:-webkit-)?keyframes\s+([\w-]+)/i.exec(stmt.replace(/\/\*[\s\S]*?\*\//g,'').trim())?.[1];
   sharedAtRules.push({raw:stmt,keyframe:kf});
   continue;
  }
  const kind=classifyAvatarCss(stmt);
  if(kind==='user')userRules.push(stmt);
  else if(kind==='ai')aiRules.push(stmt);
  else return null;
 }
 if(!userRules.length||!aiRules.length)return null;
 const withAtRules=(rules:string[])=>{
  const body=rules.join('\n');
  const extras=sharedAtRules.filter(item=>!item.keyframe||body.includes(item.keyframe)).map(item=>item.raw);
  return [...rules,...extras].join('\n');
 };
 return {user:withAtRules(userRules),ai:withAtRules(aiRules)};
}

function collapseIdenticalSides(slots:AvatarFrameSlots){
 if(slots.user&&slots.ai&&targetAvatarFrameCss(slots.user,'both').trim()===targetAvatarFrameCss(slots.ai,'both').trim()){
  slots.shared=targetAvatarFrameCss(slots.user,'both').trim();
  delete slots.user;
  delete slots.ai;
 }
}

function applyBlockToSlots(slots:AvatarFrameSlots,rawContent:string){
 const content=rawContent.trim();
 if(!content)return;
 const kind=classifyAvatarCss(content);
 if(kind==='user'||kind==='ai'){
  // Narrow a previously shared frame to the untouched side so replacing one side
  // keeps the other side's frame intact without leaving the shared rule stacking.
  if(slots.shared!==undefined&&!slots.coupled){
   const other=kind==='user'?'ai':'user';
   slots[other]=targetAvatarFrameCss(slots.shared,other).trim();
  }
  delete slots.shared;
  delete slots.coupled;
  slots[kind]=content;
  collapseIdenticalSides(slots);
 }else if(kind==='split'){
  const partitioned=splitTopLevelAvatarCss(content);
  delete slots.shared;
  delete slots.coupled;
  if(partitioned){
   slots.user=partitioned.user;
   slots.ai=partitioned.ai;
   collapseIdenticalSides(slots);
  }else{
   delete slots.user;
   delete slots.ai;
   slots.shared=content;
   slots.coupled=true;
  }
 }else{
  delete slots.user;
  delete slots.ai;
  slots.shared=content;
  slots.coupled=false;
 }
}

/** Reuse standard `sully-composer:avatar` blocks per side so exported presets remain
 * compatible with existing category detection, share selection and final-layer rendering. */
export function readAvatarFrameSlots(css:string):AvatarFrameSlots{
 const slots:AvatarFrameSlots={};
 for(const match of css.matchAll(block()))applyBlockToSlots(slots,match[1]);
 return slots;
}

function serializeAvatarFrameSlots(slots:AvatarFrameSlots):string{
 if(slots.shared)return wrapBlock(slots.shared);
 return [slots.user,slots.ai].filter((item):item is string=>!!item?.trim()).map(wrapBlock).join('\n');
}

export function readAvatarFrameTarget(css:string):AvatarFrameTarget{
 if(block().test(css)){
  const slots=readAvatarFrameSlots(css);
  if(slots.user&&!slots.ai)return 'user';
  if(slots.ai&&!slots.user)return 'ai';
  return 'both';
 }
 const kind=classifyAvatarCss(css);
 return kind==='user'||kind==='ai'?kind:'both';
}

export const hasAvatarFrameCss=(preset:DecorationPreset)=>block().test(preset.parts.css||'');

/** Outfits that already carry distinct user and character frames keep their per-side scopes
 * on apply instead of collapsing both frames onto a single target selector. */
export function hasSplitAvatarFrames(value:DecorationPreset|string):boolean{
 const css=typeof value==='string'?value:value.parts.css||'';
 const slots=readAvatarFrameSlots(css);
 return Boolean((slots.user&&slots.ai)||slots.coupled);
}

function rewriteAvatarSelector(raw:string,target:AvatarFrameTarget):string{
 let selector=raw.trim().replace(sideScopeRe(),'');
 if(avatarHookRe().test(selector)){
  selector=selector.replace(sidePrefixRe(),'').replace(avatarHookRe(),hook=>hook+(target==='both'?'':`:where(.sully-chat-message-${target} *)`));
 }
 return selector;
}

/** Restrict only actual selector hooks, never strings, URLs, declarations or keyframes. */
export function targetAvatarFrameCss(css:string,target:AvatarFrameTarget):string{
 let result=css;const masked=maskCssComments(css);
 for(const rule of cssRuleSelectors(css).rules.reverse()){
  const selectors=splitCssSelectors(masked.slice(rule.start,rule.end)).map(selector=>rewriteAvatarSelector(selector,target));
  const comments=css.slice(rule.start,rule.end).match(/\/\*[\s\S]*?\*\//g)||[];
  const head=[...comments,selectors.join(', ')].join('\n');
  result=result.slice(0,rule.start)+(rule.start>0?'\n':'')+head+result.slice(rule.end);
 }
 return result;
}

export function withAvatarFrameTarget(preset:DecorationPreset,target:AvatarFrameTarget):DecorationPreset{
 return {...preset,parts:{...preset.parts,css:(preset.parts.css||'').replace(block(),(_,content)=>wrapBlock(targetAvatarFrameCss(content,target)))}};
}

/** Merge incoming `sully-composer:avatar` blocks by side into existing CSS. */
export function mergeAvatarFrameCss(baseCss:string,incomingCss:string):string{
 const slots=readAvatarFrameSlots(baseCss);
 for(const match of incomingCss.matchAll(block()))applyBlockToSlots(slots,match[1]);
 return [baseCss.replace(block(),'').trim(),serializeAvatarFrameSlots(slots)].filter(Boolean).join('\n');
}

/** Set or clear one side's avatar frame CSS in the outfit composer while keeping the other side. */
export function setAvatarFrameSlot(baseCss:string,target:AvatarFrameTarget,frameCss:string):string{
 const slots=readAvatarFrameSlots(baseCss);
 const trimmed=frameCss.trim();
 if(!trimmed){
  if(target==='both'){delete slots.shared;delete slots.coupled;delete slots.user;delete slots.ai;}
  else{
   if(slots.shared!==undefined&&!slots.coupled){
    const other=target==='user'?'ai':'user';
    slots[other]=targetAvatarFrameCss(slots.shared,other).trim();
   }
   delete slots.shared;
   delete slots.coupled;
   delete slots[target];
  }
 }else if(target==='both'){
  const kind=classifyAvatarCss(trimmed);
  if(kind==='split')applyBlockToSlots(slots,trimmed);
  else{
   const hasSideScope=/\.sully-chat-message-(?:user|ai)(?![\w-])/.test(maskCssComments(trimmed));
   const normalized=hasSideScope?targetAvatarFrameCss(trimmed,'both').trim():trimmed;
   delete slots.user;
   delete slots.ai;
   slots.shared=normalized;
   slots.coupled=false;
  }
 }else{
  const incoming:AvatarFrameSlots={};
  applyBlockToSlots(incoming,trimmed);
  const chosen=incoming.user&&incoming.ai?incoming[target]!:targetAvatarFrameCss(trimmed,target);
  applyBlockToSlots(slots,chosen);
 }
 return [baseCss.replace(block(),'').trim(),serializeAvatarFrameSlots(slots)].filter(Boolean).join('\n');
}

/** Explicitly selected frames paint after bubble CSS; keep the author's bytes and scope.
 * Both real chat and the isolated preview use this final layer. */
export function avatarFrameLayer(css:string):string{
 return [...css.matchAll(block())].map(match=>match[1]).join('\n');
}
