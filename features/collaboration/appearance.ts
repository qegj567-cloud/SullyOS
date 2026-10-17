import type { CollaborationAvatarMode, CollaborationSettings, CollaborationUiTheme } from './types';
import { validateScopedCss } from '../../utils/scopedCss';
import { maskCssComments } from '../../utils/cssRuleSelectors';

export const COLLABORATION_UI_THEMES: Array<{
  id: CollaborationUiTheme;
  label: string;
  caption: string;
  presence: string;
  emptyTitle: string;
  emptyDescription: string;
  swatches: [string, string, string];
  dark?: boolean;
}> = [
  { id: 'sully', label: '角色气泡', caption: 'SullyOS 原生布局', presence: '默认双方头像', emptyTitle: '从一件具体的事开始', emptyDescription: '上传资料或参考图，也可以直接告诉角色想完成什么。', swatches: ['#f4f6fa', '#ffffff', '#6366f1'] },
  { id: 'gpt', label: '黑白助手', caption: '克制的 AI 对话布局', presence: '默认不显示头像', emptyTitle: '有什么可以帮忙完成？', emptyDescription: '输入任务、上传文件或图片，或者选择一个制作能力开始。', swatches: ['#ffffff', '#f4f4f4', '#000000'] },
  { id: 'claude', label: '暖纸长文', caption: '适合阅读与写作', presence: '默认不显示头像', emptyTitle: '今天想一起做些什么？', emptyDescription: '把资料和目标交给角色，适合整理、写作与长文制作。', swatches: ['#f7f6f2', '#eee9df', '#d97757'] },
  { id: 'gemini', label: '渐光协作', caption: '轻盈的助手工作台', presence: '默认只显示角色', emptyTitle: '你好，今天一起完成什么？', emptyDescription: '角色会带着最近聊天里的连续感，在这里专心处理任务。', swatches: ['#ffffff', '#eef3ff', '#4d75e8'] },
  { id: 'kimi', label: '轻量资料', caption: '资料与文档优先', presence: '默认不显示头像', emptyTitle: '嗨，想从什么任务开始？', emptyDescription: '上传长文档、参考图或直接描述目标，角色会整理好再交付。', swatches: ['#f6f8fc', '#ffffff', '#2864ff'] },
  { id: 'deepseek', label: '理性工作台', caption: '清楚的推理分区', presence: '默认不显示头像', emptyTitle: '有什么可以帮到你？', emptyDescription: '描述问题或上传资料、图片，角色会按步骤分析并完成。', swatches: ['#f5f7fb', '#ffffff', '#4d6bfe'] },
  { id: 'charcoal', label: '炭黑', caption: '石墨底色与柔和青绿', presence: '默认双方头像', emptyTitle: '安静下来，做点什么', emptyDescription: '把想法或资料交给角色，一起慢慢完成。', swatches: ['#171c1b', '#232b28', '#9fc8b1'], dark: true },
  { id: 'warm-night', label: '暖灰夜读', caption: '暖灰底色与低亮琥珀', presence: '默认不显示头像', emptyTitle: '留一盏灯，继续写', emptyDescription: '适合与角色一起读资料、理思路和写长文。', swatches: ['#221f1d', '#302b27', '#dcb38f'], dark: true },
  { id: 'midnight', label: '午夜蓝', caption: '深蓝底色与雾紫点缀', presence: '默认只显示角色', emptyTitle: '夜深了，灵感还在', emptyDescription: '从一个问题开始，和角色一起把想法变成作品。', swatches: ['#171c2b', '#242d42', '#b5b9e9'], dark: true },
];
export type CollaborationUiThemeSpec = (typeof COLLABORATION_UI_THEMES)[number];

export const THEME_AVATAR_MODE: Record<CollaborationUiTheme, Exclude<CollaborationAvatarMode, 'theme'>> = {
  sully: 'both',
  gpt: 'none',
  claude: 'none',
  gemini: 'character',
  kimi: 'none',
  deepseek: 'none',
  charcoal: 'both',
  'warm-night': 'none',
  midnight: 'character',
};

export const COLLABORATION_CSS_EXAMPLE = `.collab-ui-root {
  --collab-accent: #9fc8b1;
}
.collab-ui-root .collab-message-bubble-user {
  border-radius: 14px !important;
}`;

export function validateCollaborationCss(css: string) {
  // Root overrides and descendants are allowed; siblings of the window are not.
  const result = validateScopedCss(css, /^\.collab-ui-root(?:$|\s+(?![+~])(?=\S)|\s*>)/, '.collab-ui-root 或它的子元素');
  const source = maskCssComments(css).replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  if (/@(?!media\b|supports\b|container\b)[\w-]+/i.test(source)) {
    result.errors.push('这里只支持 @media、@supports、@container 条件规则，请移除其他 @ 规则。');
    result.isValid = false;
  }
  return result;
}

export function resolveCollaborationAppearance(settings: Partial<CollaborationSettings>) {
  const spec = COLLABORATION_UI_THEMES.find(item => item.id === settings.uiTheme) || COLLABORATION_UI_THEMES[0];
  const css = typeof settings.customCss === 'string' ? settings.customCss : '';
  return { uiTheme: spec.id, dark: !!spec.dark, customCss: validateCollaborationCss(css).isValid ? css : '' };
}

/** The share boundary is deliberately smaller than CollaborationSettings. */
export interface CollaborationAppearance {
  uiTheme: CollaborationUiTheme;
  customCss: string;
  avatarMode: CollaborationAvatarMode;
  avatarStyle: NonNullable<CollaborationSettings['avatarStyle']>;
}
export function validateCollaborationAppearance(value: unknown): CollaborationAppearance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('协同工作美化格式无效');
  const v = value as Record<string, unknown>;
  const uiTheme = v.uiTheme ?? 'sully', avatarMode = v.avatarMode ?? 'theme', avatarStyle = v.avatarStyle ?? 'circle';
  if (!COLLABORATION_UI_THEMES.some(item => item.id === uiTheme)
    || !['theme','both','character','user','none'].includes(String(avatarMode))
    || !['circle','rounded','portrait'].includes(String(avatarStyle))) throw Error('协同工作美化选项无效');
  const customCss = v.customCss ?? '';
  if (typeof customCss !== 'string' || customCss.length > 8 * 1024 * 1024) throw Error('协同工作 CSS 无效');
  const check = validateCollaborationCss(customCss);
  if (!check.isValid) throw Error(check.errors.slice(0, 3).join('；'));
  return {uiTheme, customCss, avatarMode, avatarStyle} as CollaborationAppearance;
}
