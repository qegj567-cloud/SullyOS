import {cssRuleSelectors, maskCssComments, splitCssSelectors} from './cssRuleSelectors';
import type {DecorationPreset} from './chatDecoration';
export type AvatarFrameTarget = 'both' | 'user' | 'ai';
export const AVATAR_FRAME_TARGETS = [['both','双方使用'],['user','用户使用（我）'],['ai','角色使用（TA）']] as const;
const block=()=>/\/\* sully-composer:avatar \*\/\n?([\s\S]*?)\/\* end-sully-composer:avatar \*\//g;
const targetFilter=/:where\(\.sully-chat-message-(?:user|ai) \*\)/g;
export const readAvatarFrameTarget=(css:string):AvatarFrameTarget=>css.includes(':where(.sully-chat-message-user *)')?'user':css.includes(':where(.sully-chat-message-ai *)')?'ai':'both';
export const hasAvatarFrameCss=(preset:DecorationPreset)=>block().test(preset.parts.css||'');
/** Restrict only actual selector hooks, never strings, URLs, declarations or keyframes. */
export function targetAvatarFrameCss(css:string,target:AvatarFrameTarget):string{
 let result=css;const masked=maskCssComments(css);
 for(const rule of cssRuleSelectors(css).rules.reverse()){
  const selectors=splitCssSelectors(masked.slice(rule.start,rule.end)).map(selector=>selector.trim().replace(targetFilter,'').replace(/\.sully-chat-(?:avatar-wrap|avatar-frame|message-avatar-img)\b/g,hook=>hook+(target==='both'?'':`:where(.sully-chat-message-${target} *)`)));
  const comments=css.slice(rule.start,rule.end).match(/\/\*[\s\S]*?\*\//g)||[];
  result=result.slice(0,rule.start)+comments.join('\n')+'\n'+selectors.join(', ')+result.slice(rule.end);
 }
 return result;
}
export function withAvatarFrameTarget(preset:DecorationPreset,target:AvatarFrameTarget):DecorationPreset{
 return {...preset,parts:{...preset.parts,css:(preset.parts.css||'').replace(block(),(_,content)=>`/* sully-composer:avatar */\n${targetAvatarFrameCss(content,target).trim()}\n/* end-sully-composer:avatar */`)}};
}
/** Explicitly selected frames paint after bubble CSS; keep the author's bytes and scope.
 * Both real chat and the isolated preview use this final layer. */
export function avatarFrameLayer(css:string):string{
 return [...css.matchAll(block())].map(match=>match[1]).join('\n');
}
