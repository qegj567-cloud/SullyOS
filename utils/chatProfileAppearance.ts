import {validateScopedCss} from './scopedCss';

export interface ChatProfileAppearance { customCss: string }
export const PROFILE_SCOPE = /^\.chat-profile-[\w-]+\b/;
export const PROFILE_SELECTORS = [
    '.chat-profile-dialog', '.chat-profile-sheet', '.chat-profile-sky', '.chat-profile-tabs button[aria-selected="true"]',
    '.chat-profile-tabs button[data-tab="设定"]', '.chat-profile-scroll', '.chat-profile-current', '.chat-profile-portrait', '.chat-profile-identity h2', '.chat-profile-remark',
    '.chat-profile-thought', '.chat-profile-emotions', '.chat-profile-page-heading', '.chat-profile-editor',
    '.chat-profile-memory', '.chat-profile-schedule', '.chat-profile-schedule li[aria-current="time"]', '.chat-profile-close',
];
export function validateProfileAppearance(value: unknown): ChatProfileAppearance {
    const css = (value as Partial<ChatProfileAppearance> | null)?.customCss;
    if (typeof css !== 'string' || css.length > 8 * 1024 * 1024 || /<\/?(?:style|script|html|iframe)\b/i.test(css)) throw Error('角色名片 CSS 无效');
    const check = validateScopedCss(css, PROFILE_SCOPE, '.chat-profile-*');
    if (!check.isValid) throw Error(check.errors.slice(0,3).join('；'));
    return {customCss:css};
}
