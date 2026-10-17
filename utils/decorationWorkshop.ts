import {validateCollaborationCss} from '../features/collaboration/appearance';
import {JOURNAL_AI_CSS_PROMPT,JOURNAL_CSS_SCOPE_REGEX,JOURNAL_CSS_SCOPE_HINT} from './journalAppearance';
import {SCHEDULE_BEAUTY_PROMPT,SCHEDULE_CSS_SCOPE_REGEX,SCHEDULE_CSS_SCOPE_HINT} from './scheduleAppearance';
import type {DecorationPreset} from './chatDecoration';
import {PRESET_THEMES} from '../components/chat/ChatConstants';
import {validateScopedCss} from './scopedCss';
import {WHITEBOX_AI_PROMPT,WHITEBOX_SCOPE_REGEX,WHITEBOX_SCOPE_HINT} from './chatWhitebox';

export const DECORATION_WORKSHOPS=[['whitebox','白框'],['bubbles','气泡'],['avatar','头像框'],['background','聊天背景'],['psyche','心象'],['sound','提示音'],['collaboration','协同工作'],['date','见面界面'],['story','剧情界面'],['schedule','日程表'],['journal','交换日记']] as const;
export type DecorationWorkshop=typeof DECORATION_WORKSHOPS[number][0];
export const workshopBlock=(category:'avatar'|'background')=>new RegExp(`/\\* sully-composer:${category} \\*/\\n?([\\s\\S]*?)/\\* end-sully-composer:${category} \\*/`,'g');
export function workshopCss(preset:DecorationPreset,category:DecorationWorkshop){
 if(category==='collaboration')return preset.parts.collaboration?.customCss||'';
 if(category==='journal')return preset.parts.journal?.customCss||'';
 if(category==='schedule')return preset.parts.schedule?.customCss||'';
 if(category==='bubbles')return preset.parts.bubbles?.customCss||'';
 if(category==='psyche')return preset.parts.psyche?.customCss||'';
 if(category==='avatar'||category==='background')return [...(preset.parts.css||'').matchAll(workshopBlock(category))].map(m=>m[1].trim()).join('\n');
 return preset.parts.css||'';
}
export function replaceWorkshopCss(base:string,category:'avatar'|'background',css:string){return [base.replace(workshopBlock(category),'').trim(),css.trim()?`/* sully-composer:${category} */\n${css}\n/* end-sully-composer:${category} */`:''].filter(Boolean).join('\n');}
export function makeWorkshopPreset(category:DecorationWorkshop):DecorationPreset{
 const parts:DecorationPreset['parts']=category==='collaboration'?{collaboration:{uiTheme:'sully',customCss:'',avatarMode:'theme',avatarStyle:'circle'}}:category==='date'?{date:{preset:'novel'}}:category==='story'?{story:{preset:'novel'}}:category==='journal'?{journal:{preset:'original',customCss:''}}:category==='schedule'?{schedule:{preset:'original',customCss:''}}:category==='bubbles'?{bubbles:{...structuredClone(PRESET_THEMES.default),type:'custom'}}:category==='psyche'?{psyche:{styleId:'echo',customCss:''}}:category==='background'?{background:{image:null,style:'plain'}}:category==='sound'?{sound:null}:{css:''};
 return {format:'sullyos-chat-decoration',version:1,name:`我的${DECORATION_WORKSHOPS.find(([id])=>id===category)![1]}`,parts};
}
export function projectWorkshopPreset(preset:DecorationPreset,category:DecorationWorkshop):DecorationPreset{
 if(category==='whitebox')return structuredClone(preset);
 const out=makeWorkshopPreset(category);out.name=preset.name;
 if(category==='avatar'||category==='background'){
  const css=replaceWorkshopCss('',category,workshopCss(preset,category));
  if(css)out.parts.css=css;else delete out.parts.css;
  if(category==='background'&&preset.parts.background)out.parts.background=preset.parts.background;
 }else if(preset.parts[category]!==undefined)out.parts={[category]:preset.parts[category]};
 return out;
}
const scopes={
 collaboration:[/^\.collab-ui-root\b/,'.collab-ui-root 及其子元素'],
 journal:[JOURNAL_CSS_SCOPE_REGEX,JOURNAL_CSS_SCOPE_HINT],
 schedule:[SCHEDULE_CSS_SCOPE_REGEX,SCHEDULE_CSS_SCOPE_HINT],
 whitebox:[WHITEBOX_SCOPE_REGEX,WHITEBOX_SCOPE_HINT],
 bubbles:[/^\.sully-(?:bubble(?:-[\w-]+)?|voice-bar(?:-[\w-]+)?)\b/,'.sully-bubble-* / .sully-voice-bar*'],
 avatar:[/^\.sully-chat-(?:avatar-wrap|avatar-frame|message-avatar-img)\b/,'.sully-chat-avatar-wrap / .sully-chat-avatar-frame / .sully-chat-message-avatar-img'],
 background:[/^\.sully-chat-(?:root|messages)\b/,'.sully-chat-root / .sully-chat-messages'],
 psyche:[/^\.sully-psyche[\w-]*\b/,'.sully-psyche*'],
} as const;
export function checkWorkshopCss(category:DecorationWorkshop,css:string){
 if(category==='collaboration'){const check=validateCollaborationCss(css);if(!check.isValid)throw Error(check.errors.slice(0,3).join('；'));return css;}
 if(category==='sound'||category==='date'||category==='story')return;
 // The old whitebox editor accepts arbitrary CSS. Stable hooks are authoring
 // guidance, not a new hard restriction on existing work. Other makers stay scoped.
 const [scope,hint]=scopes[category];const check=validateScopedCss(css,category==='whitebox'?/^[\s\S]*$/:scope,hint);
 if(!check.isValid){
  const errors=[...new Set(check.errors)];
  throw Error(`有 ${errors.length} 处 CSS 需要调整。\n`+errors.slice(0,3).join('\n')+(errors.length>3?'\n其余提示已收起，请先修正以上内容。':''));
 }
 return css;
}
export function workshopPrompt(category:DecorationWorkshop){
 if(category==='journal')return JOURNAL_AI_CSS_PROMPT;
 if(category==='schedule')return SCHEDULE_BEAUTY_PROMPT;
 if(category==='whitebox')return WHITEBOX_AI_PROMPT;
 if(category==='sound'||category==='date'||category==='story')return '';
 return `为 SullyOS 制作${DECORATION_WORKSHOPS.find(([id])=>id===category)![1]} CSS。仅修改当前类别，保留其他聊天内容的默认样式。可用选择器：${scopes[category][1]}。返回纯 CSS，不要 HTML、脚本或整套页面。不要隐藏正文、操作按钮或破坏滚动。`;
}
