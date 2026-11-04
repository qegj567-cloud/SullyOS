import { validateScopedCss } from './scopedCss';

export const MEETING_CSS_SCOPE = /^\.meeting-reading\b/;
export const MEETING_CSS_HINT = '.meeting-reading 及其子元素';
export const MEETING_CSS_PROMPT = `为 SullyOS 见面／剧情阅读界面制作 CSS。每个选择器必须以 .meeting-reading 开头，只返回 CSS，不要 HTML 或脚本。
可用：.meeting-reading（根）、.meeting-reading .meeting-reading-page（阅读页）、.meeting-reading .meeting-prose（正文）、.meeting-reading .meeting-prose p（段落）、.meeting-reading .meeting-user-turn（用户段落）。
根节点变量：--meeting-paper 背景、--meeting-ink 文字、--meeting-font-size 字号、--meeting-line-height 行距、--meeting-letter-spacing 字距。用这些变量覆盖内置阅读样式；更细的正文覆盖可使用 !important。不要隐藏正文、操作按钮或破坏滚动。预览只使用示例内容。`;
export const MEETING_APPEARANCES = [
    { id: 'none', name: '无', description: '保留原有界面', background: '#faf8f5', ink: '#292524' },
    { id: 'novel', name: '纯小说', description: '素白正文 · 连续阅读', background: '#fcfcfa', ink: '#292929' },
    { id: 'paper', name: '旧书纸页', description: '暖纸衬底 · 宽松行距', background: '#f3ead8', ink: '#51432f' },
    { id: 'night', name: '静夜阅读', description: '深色页面 · 柔和文字', background: '#191d24', ink: '#d6d9df' },
] as const;
export type MeetingAppearance = { preset: typeof MEETING_APPEARANCES[number]['id']; name?: string; customCss?: string };
export function validateMeetingAppearance(value: unknown): MeetingAppearance {
    const preset = (value as MeetingAppearance | null)?.preset;
    if (!MEETING_APPEARANCES.some(item => item.id === preset)) throw Error('见面／剧情美化样式无效');
    const name = (value as MeetingAppearance).name;
    const css = (value as MeetingAppearance).customCss;
    if (css !== undefined && typeof css !== 'string') throw Error('阅读样式 CSS 无效');
    if (css && css.length > 100_000) throw Error('阅读样式 CSS 过长');
    const check = validateScopedCss(css || '', MEETING_CSS_SCOPE, MEETING_CSS_HINT);
    if (!check.isValid) throw Error(check.errors.join('\n'));
    return { preset: preset!, ...(typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, 60) } : {}), ...(css ? { customCss: css } : {}) };
}
export function meetingCustomCss(value?: MeetingAppearance): string {
    if (!value || value.preset === 'none') return '';
    try { return validateMeetingAppearance(value).customCss || ''; } catch { return ''; }
}
export function meetingAppearance(value?: MeetingAppearance) {
    const base = MEETING_APPEARANCES.find(item => item.id === value?.preset) || MEETING_APPEARANCES[0];
    return { ...base, name: base.id !== 'none' && value?.name ? value.name : base.name };
}

/** Shared reading typography for real surfaces and isolated sample previews. */
export const MEETING_READING_CSS = `
.meeting-reading { --meeting-paper:#fcfcfa; --meeting-ink:#292929; }
.meeting-reading:where([data-reading-preset="paper"]) { --meeting-paper:#f3ead8; --meeting-ink:#51432f; }
.meeting-reading:where([data-reading-preset="night"]) { --meeting-paper:#191d24; --meeting-ink:#d6d9df; }
.meeting-reading .meeting-reading-page { background:var(--meeting-paper)!important; color:var(--meeting-ink)!important; mask-image:none!important; backdrop-filter:none!important; }
.meeting-reading .meeting-prose { color:var(--meeting-ink)!important; font-family:var(--app-font,serif); font-size:var(--meeting-font-size,17px)!important; line-height:var(--meeting-line-height,2)!important; letter-spacing:var(--meeting-letter-spacing,.035em); text-align:justify!important; font-style:normal!important; border:0!important; padding-inline:0!important; text-shadow:none!important; }
.meeting-reading .meeting-prose p { margin-block:.7em; }
.meeting-reading .meeting-reading-page .meeting-reading-avatar { display:none; }
.meeting-reading .meeting-reading-page .meeting-user-label { display:none; }
.meeting-reading .meeting-user-turn { border:0!important; padding-left:0!important; }
.meeting-reading .meeting-reading-page .meeting-prose { white-space:pre-wrap; }
.meeting-reading.story-theme { --story-bg:var(--meeting-paper); --story-surface:var(--meeting-paper); --story-ink:var(--meeting-ink); }
.meeting-reading.story-theme::before { display:none; }
`;
