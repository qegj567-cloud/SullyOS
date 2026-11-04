import type { DecorationPreset } from './chatDecoration';
export const BEAUTY_CATEGORIES = [['all', '全部'], ['appearance', '桌面主题'], ['chat', '全部聊天'], ['whitebox', '白框'], ['bubbles', '气泡'], ['avatar', '头像框'], ['background', '聊天背景'], ['psyche', '心象'], ['sound', '提示音'], ['collaboration', '协同工作'], ['date', '见面界面'], ['story', '剧情界面'], ['schedule', '日程表'], ['journal', '交换日记']] as const;
export type BeautyCategory = typeof BEAUTY_CATEGORIES[number][0];
/** Classify structured content only. Never try to split or infer the scope of arbitrary CSS. */
export function decorationCategories(preset: DecorationPreset): BeautyCategory[] {
  const p = preset.parts; if(p.collaboration)return ['collaboration']; if(p.date)return ['date']; if(p.story)return ['story']; if(p.schedule||p.journal)return [...(p.schedule?['schedule' as const]:[]),...(p.journal?['journal' as const]:[])]; const categories: BeautyCategory[] = ['chat'];
  const extraCss=(p.css||'').replace(/\/\* sully-composer:(avatar|background) \*\/[\s\S]*?\/\* end-sully-composer:\1 \*\//g,'').trim();
  if (p.layout || extraCss || Object.keys(p).filter(key=>key!=='css').length > 1) categories.push('whitebox');
  if (p.psyche) categories.push('psyche');
  if (p.bubbles) categories.push('bubbles');
  if (p.bubbles?.user.avatarDecoration || p.bubbles?.ai.avatarDecoration || p.css?.includes('/* sully-composer:avatar */')) categories.push('avatar');
  if (p.background || p.css?.includes('/* sully-composer:background */')) categories.push('background');
  if (p.sound !== undefined) categories.push('sound');
  return categories;
}
export function decorationContents(preset: DecorationPreset): string {
  const p = preset.parts; const labels: string[] = [];
  if(p.collaboration)labels.push('协同工作（全局）'); if(p.date)labels.push('见面界面'); if(p.story)labels.push('剧情界面（全局）');
  if (p.journal) labels.push('交换日记（全局）');
  if (p.schedule) labels.push('日程表（全局）');
  if (p.psyche) labels.push('心象');
  if (p.layout) labels.push('界面布局');
  if (p.bubbles) labels.push('气泡');
  if (p.bubbles?.user.avatarDecoration || p.bubbles?.ai.avatarDecoration || p.css?.includes('/* sully-composer:avatar */')) labels.push('头像框');
  if (p.background || p.css?.includes('/* sully-composer:background */')) labels.push('聊天背景');
  if (p.sound !== undefined) labels.push('提示音');
  if (p.css?.replace(/\/\* sully-composer:(avatar|background) \*\/[\s\S]*?\/\* end-sully-composer:\1 \*\//g,'').trim()) labels.push('白框 / 自定义样式（以预览为准）');
  return labels.join(' · ') || '作者提供的聊天样式';
}

export const APP_BEAUTY_CATEGORIES=['appearance','schedule','journal'] as const;
export function belongsInBeautyLibrary(categories:readonly string[],context:'chat'|'appearance'){
 const app=categories.some(c=>(APP_BEAUTY_CATEGORIES as readonly string[]).includes(c));return context==='appearance'?app:!app;
}
export function isAppDecoration(preset:DecorationPreset){return !!(preset.parts.schedule||preset.parts.journal);}
