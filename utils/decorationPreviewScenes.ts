import type {DecorationPreset} from './chatDecoration';
import {cssRuleSelectors,maskCssComments} from './cssRuleSelectors';
import {CHAT_PREVIEW_SCENES,type ChatPreviewScene} from './chatPreviewFixtures';

export type DecorationThumbnailPart = 'bubbles'|'background'|'psyche'|'avatar'|'schedule'|'journal'|'date'|'story'|'collaboration';
/** Only unambiguous single-part works get an isolated catalog thumbnail. */
export function decorationThumbnailPart(value:unknown):DecorationThumbnailPart|undefined {
 const parts=(value as Partial<DecorationPreset>|null)?.parts;
 if(!parts||parts.layout)return;
 if(parts.css){
  const blocks=[...parts.css.matchAll(/\/\* sully-composer:(avatar|background) \*\/[\s\S]*?\/\* end-sully-composer:\1 \*\//g)];
  const rest=parts.css.replace(/\/\* sully-composer:(avatar|background) \*\/[\s\S]*?\/\* end-sully-composer:\1 \*\//g,'').trim();
  if(rest||blocks.length!==1)return;
  const kind=blocks[0][1] as 'avatar'|'background';
  if(Object.keys(parts).every(key=>key==='css'||key===kind))return kind;
  return;
 }
 const present=(['bubbles','background','psyche','sound','schedule','journal','date','story','collaboration'] as const).filter(key=>parts[key]!=null);
 return present.length===1&&present[0]!=='sound'?present[0]:undefined;
}

/** Limit the menu to the preset's parts and explicit CSS targets, not the fixture catalog. */
export function decorationPreviewScenes(value: unknown, scope: 'preset'|'all' = 'preset'): ChatPreviewScene[] {
  if((value as Partial<DecorationPreset>|null)?.parts?.collaboration)return [{id:'collaboration',label:'协同工作',messages:[]}];
  if((value as Partial<DecorationPreset>|null)?.parts?.date)return [{id:'date-reading',label:'见面界面',messages:[]}];
  if((value as Partial<DecorationPreset>|null)?.parts?.story)return [{id:'story-reading',label:'剧情界面',messages:[]}];
  // The composer checks the whole conversation, including content that keeps default styling.
  if((value as Partial<DecorationPreset>|null)?.parts?.journal)return [{id:'journal-app',label:'交换日记',messages:[]}];
  const scheduleScene={id:'schedule-card',label:'日程表',messages:[]};
  const hasSchedule=!!(value as Partial<DecorationPreset>|null)?.parts?.schedule;
  if (scope === 'all') return hasSchedule?[...CHAT_PREVIEW_SCENES,scheduleScene]:CHAT_PREVIEW_SCENES;
  const p = (value as Partial<DecorationPreset> | null)?.parts || {};
  const css = [p.css, p.bubbles?.customCss, p.psyche?.customCss].filter(Boolean).join('\n');
  // Ignore comments and declaration values (including URLs and textual examples).
  // Scan once: a regex searching for the next opening brace retries at every
  // byte of a large data URL in a declaration and can freeze mobile browsers.
  const masked = maskCssComments(css);
  const selectors = cssRuleSelectors(css).rules.map(rule => masked.slice(rule.start, rule.end)).join('\n');
  const ids = new Set<string>();
  const add = (...scenes: string[]) => scenes.forEach(id => ids.add(id));
  if (p.layout || p.background || /\.sully-chat-(?:root|header|inputbar|composer|message)(?![\w-])/.test(selectors)) {
    add('conversation','voice','voice-loading','voice-playing','transfer','transfer-accepted','transfer-returned','psyche','psyche-open');
  }
  if (p.bubbles || /\.sully-bubble[\w-]*/.test(selectors)) add('conversation');
  if (p.bubbles || /\.sully-voice-bar[\w-]*/.test(selectors)) add('voice','voice-loading','voice-playing');
  if (p.psyche || /\.sully-psyche[\w-]*/.test(selectors)) add('psyche','psyche-open');
  if (/\.sully-chat-transfer-/.test(selectors)) add('transfer','transfer-accepted','transfer-returned');
  if (/\.sully-collaboration-file/.test(selectors)) add('collaboration_file');
  if (/\.sully-schedule-change/.test(selectors)) add('schedule');
  for (const selector of selectors.split(/[,\n]/)) {
   for (const match of selector.matchAll(/\[data-card-kind\s*=\s*["']?([\w-]+)["']?\s*\]/g)) {
    const kind = match[1];
    const variants = Array.from(selector.matchAll(/\[data-card-variant\s*=\s*["']?([\w-]+)["']?\s*\]/g), item => item[1]);
    for (const scene of CHAT_PREVIEW_SCENES) {
      if (scene.id === 'all') continue;
      if (scene.messages.some(message => message.type === kind && (!variants.length || kind !== 'score_card' || variants.includes(message.metadata?.scoreCard?.type)))) ids.add(scene.id);
    }
   }
  }
  if (!ids.size&&!hasSchedule) add('conversation');
  return [...CHAT_PREVIEW_SCENES.filter(scene => ids.has(scene.id)),...(hasSchedule?[scheduleScene]:[])];
}
