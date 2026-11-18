import {BUBBLE_SELECTOR_GROUPS,WHITEBOX_SELECTOR_GROUPS,PSYCHE_SELECTOR_GROUPS,WHITEBOX_DESIGN_RULES,WHITEBOX_OPTIONAL_CARD_REFERENCE,WHITEBOX_LAYOUT_REFERENCE,WHITEBOX_SCOPE_REGEX,WHITEBOX_SCOPE_HINT} from '../../utils/chatWhitebox';
import type {
  BubbleStyle,
  ChatTheme,
  CharacterProfile,
  OSTheme,
  Worldbook,
} from '../../types';
import { JOURNAL_CSS_SCOPE_HINT, JOURNAL_CSS_SCOPE_REGEX, JOURNAL_CUSTOM_CSS_SELECTOR_GROUPS } from '../../utils/journalAppearance';
import { SCHEDULE_CSS_SCOPE_HINT, SCHEDULE_CSS_SCOPE_REGEX, SCHEDULE_CUSTOM_CSS_SELECTOR_GROUPS } from '../../utils/scheduleAppearance';
import { validateScopedCss } from '../../utils/scopedCss';
import { parseStandardWorldbook, WORLDBOOK_POSITION_LABELS } from '../../utils/worldbook';
import type {
  CollaborationAttachment,
  CollaborationInstallableArtifact,
  CollaborationMakerKind,
} from './types';
import { collaborationId } from './types';

export type CollaborationMakerTarget = 'character' | 'optional-character' | 'global' | 'new-character';

export interface CollaborationMakerDefinition {
  kind: CollaborationMakerKind;
  label: string;
  shortLabel: string;
  description: string;
  target: CollaborationMakerTarget;
  accent: string;
  prompt: string;
}

const protocol = (kind: CollaborationMakerKind, schema: string, notes: string) => `### 当前制作任务（最高优先级）
用户选择了「${kind}」制作。先在自然回复中说明你的设计判断；定稿时必须再输出一个可安装作品块：

\`\`\`sully-artifact
kind: ${kind}
title: 作品名
---
${schema}
\`\`\`

横线后必须是严格 JSON，不能写注释、不能省略双引号。不要把内部块格式解释给用户。
${notes}`;

const bubbleSchema = `{
  "name": "主题名",
  "user": { "textColor": "#ffffff", "backgroundColor": "#6366f1", "borderRadius": 20, "opacity": 1 },
  "ai": { "textColor": "#1e293b", "backgroundColor": "#ffffff", "borderRadius": 20, "opacity": 1 },
  "customCss": ".sully-bubble-user{...}"
}`;

const formatSelectorGroups = (groups: ReadonlyArray<{ label: string; selectors: readonly string[] }>): string => groups
  .map(group => `${group.label}：${group.selectors.join('、')}`)
  .join('\n');

const cssDesignBrief = (surface: string, selectorGroups: ReadonlyArray<{ label: string; selectors: readonly string[] }>, extra: string): string => `
你要交付的是一套完整、可直接安装的「${surface}」视觉系统，不是只换背景色。先从用户描述中提炼 3—5 个设计关键词，在自然回复里简短说明材质、层级、排版和动效判断；随后在作品 JSON 中给出完整 CSS。

设计质量要求：
1. 建立一致的颜色、圆角、阴影、间距和字体层级；优先在根选择器声明专属 CSS 变量，后续复用。
2. 同时覆盖默认态、分组首尾态、用户/角色两侧以及实际存在的功能状态；不要只做一张静态示意图。
3. 面向约 360—430px 的手机窄屏，长标题、长消息、刘海安全区与触控面积都要可用；必要时补 @media，但媒体查询中的规则仍必须从公开选择器起笔。
4. 允许后代、子元素、属性、伪类与 ::before/::after；装饰伪元素必须 pointer-events:none。禁止 body、html、:root、裸标签和通配符开头，禁止外链脚本。
5. 覆盖项目默认/内联样式时用 !important，但不要无差别滥用。持续动画只允许 transform/opacity，尊重 @media (prefers-reduced-motion: reduce)。
6. 不得隐藏返回、发送、上传、输入、下载等关键操作，不得用负位移或透明度让它们实际不可达。文字与背景要有足够对比度。
7. 只使用下面列出的真实稳定选择器，不得猜测类名；无需每个选择器都强行写规则，但设计涉及的区域必须覆盖完整。

全部可用选择器：
${formatSelectorGroups(selectorGroups)}

${extra}`;

const ALL_COLLABORATION_MAKERS: CollaborationMakerDefinition[] = [
  {
    kind: 'bubble-theme', label: '气泡制作', shortLabel: '气泡', target: 'character', accent: '#7c3aed',
    description: '角色与用户两侧气泡、语音条和装饰。',
    prompt: protocol('bubble-theme', bubbleSchema, cssDesignBrief('聊天气泡与语音条', BUBBLE_SELECTOR_GROUPS, 'user/ai 基础字段必须与 customCss 同一套设计语言；气泡尾巴、同一轮消息的首尾衔接、长文本和语音波形都要有明确处理。')),
  },
  {
    kind: 'whitebox-css', label: '白框制作', shortLabel: '白框', target: 'character', accent: '#ec4899',
    description: '聊天外壳与普通聊天、语音条、转账、心象；其他卡片按需设计。',
    prompt: protocol('whitebox-css', '{ "css": ".sully-chat-root{...}" }', cssDesignBrief('聊天白框、消息布局与整屏外壳', WHITEBOX_SELECTOR_GROUPS, WHITEBOX_LAYOUT_REFERENCE + WHITEBOX_OPTIONAL_CARD_REFERENCE + '\n【实际输出要求：完整接口清单不等于必须逐项输出】\n' + WHITEBOX_DESIGN_RULES + '转账与头像框选择器已经在真实聊天页面开放，可直接使用，不需要用户另行添加白名单。转账主卡/回执用 data-status 区分 pending/accepted/returned（回执无 pending）。头像框画在 .sully-chat-avatar-wrap::after，使用透明背景图、pointer-events:none，容器 overflow:visible；圆角或 clip-path 只作用于 .sully-chat-message-avatar-img。已有贴图 .sully-chat-avatar-frame 可隐藏避免叠加。顶栏头像是 img，不可用伪元素。顶栏已预留安全区；需要贴顶时使用 var(--safe-top)。若做“每轮头像在上方”，显示 .sully-chat-turn-avatar-slot、隐藏 .sully-chat-message-avatar，并同步调整组首留白和消息列边距。')),
  },
  {
    kind: 'appearance-preset', label: '当前界面美化', shortLabel: '整套界面', target: 'global', accent: '#2563eb',
    description: '生成一套可保存、可恢复的 SullyOS 外观预设。',
    prompt: protocol('appearance-preset', `{
  "theme": {
    "hue": 260, "saturation": 75, "lightness": 62, "darkMode": false,
    "contentColor": "#f7f5ff", "skin": "default", "desktopVariant": "paper", "statusBarMode": "standard",
    "chatAvatarShape": "circle", "chatAvatarSize": "medium", "chatEmojiSize": "small",
    "chatAvatarMode": "grouped", "chatAvatarPlacement": "beside", "chatAvatarVisibility": "both",
    "chatAvatarAlign": "bottom", "chatAvatarOffsetY": 0, "chatBubbleFontSize": 15,
    "chatBubbleLineHeight": 1.5, "chatBubbleIndent": 48, "chatSnapToEdge": false,
    "chatModuleAlign": "center", "chatChromeStyle": "soft", "chatHeaderStyle": "gradient",
    "chatInputStyle": "rounded", "chatBackgroundStyle": "mesh", "chatBubbleStyle": "modern",
    "chatMessageSpacing": "default", "chatShowTimestamp": "always", "chatTimestampPosition": "below", "chatHeaderAlign": "left",
    "chatHeaderDensity": "default", "chatStatusStyle": "subtle", "chatSendButtonStyle": "circle",
    "chatHideHeaderBuffs": false
  }
}`, `这是原生字段预设，不接受自造 CSS 或不存在的键。要把色相、明暗、桌面皮肤、聊天顶栏/输入栏/气泡、头像、间距和时间戳做成同一套视觉方向，不要逐字段随机选择。
可用枚举：skin=default|animalcrossing|mobilegame|tamagotchi|companion；desktopVariant=paper|nostalgia；statusBarMode=standard|compact|hidden；chatAvatarShape=circle|rounded|square；chatAvatarSize=small|medium|large；chatEmojiSize=small|medium|large；chatAvatarMode=grouped|every_message；chatAvatarPlacement=beside|above_group；chatAvatarVisibility=both|hide_ai|hide_user|hide_both；chatAvatarAlign=bottom|top|center；chatModuleAlign=anchor|center；chatChromeStyle=soft|flat|floating|pixel；chatHeaderStyle=default|minimal|gradient|wechat|telegram|discord|pixel；chatInputStyle=default|rounded|flat|wechat|ios|telegram|discord|pixel；chatBackgroundStyle=plain|grid|paper|mesh；chatBubbleStyle=modern|flat|outline|shadow|wechat|ios；chatMessageSpacing=compact|default|spacious；chatShowTimestamp=always|hover|never；chatTimestampPosition=below|top_center；chatHeaderAlign=left|center；chatHeaderDensity=compact|default|airy；chatStatusStyle=subtle|pill|dot；chatSendButtonStyle=circle|pill|minimal。
只写界面视觉字段，不写 API、角色内容、记忆、壁纸数据或任何凭据。`),
  },
  {
    kind: 'journal-css', label: '日记本美化', shortLabel: '日记本', target: 'global', accent: '#db2777',
    description: '交换日记的纸张、时间线、日期与编辑页。',
    prompt: protocol('journal-css', '{ "css": ".sully-journal-root{...}" }', cssDesignBrief('交换日记 App', JOURNAL_CUSTOM_CSS_SELECTOR_GROUPS, '必须覆盖日记本选择页、日记列表、书写双页和底部工具，而不是只美化纸张。装饰层不能遮住正文、返回键、美化入口、新建按钮或输入区。')),
  },
  {
    kind: 'schedule-css', label: '日程卡美化', shortLabel: '日程卡', target: 'global', accent: '#d97706',
    description: '桌面、房间与聊天共用的日程卡片。',
    prompt: protocol('schedule-css', '{ "css": ".sully-schedule-root{...}" }', cssDesignBrief('日程卡与修改回执', SCHEDULE_CUSTOM_CSS_SELECTOR_GROUPS, '可在 .sully-schedule-root 声明并复用 --schedule-bg、--schedule-text、--schedule-accent、--schedule-accent-soft、--schedule-base、--schedule-line。要同时处理当前事项、普通事项、长描述、紧凑小组件和聊天内修改回执。')),
  },
  {
    kind: 'psyche-css', label: '心象卡制作', shortLabel: '心象卡', target: 'character', accent: '#0891b2',
    description: '角色思考过程的折叠卡片外观。',
    prompt: protocol('psyche-css', '{ "css": ".sully-psyche-card{...}" }', cssDesignBrief('心象折叠卡', PSYCHE_SELECTOR_GROUPS, '心象卡要区分标题、折叠速览和展开正文；必须兼顾短念头与长段落，并确保展开内容仍清晰可读。')),
  },
  {
    kind: 'character-card', label: '角色卡制作', shortLabel: '角色卡', target: 'new-character', accent: '#4f46e5',
    description: '创建一位新的角色，保留项目原生字段。',
    prompt: protocol('character-card', `{
  "name": "角色名",
  "description": "给用户看的简短介绍",
  "systemPrompt": "完整角色核心设定",
  "worldview": "角色所在世界与共同事实"
}`, '必须把角色的动机、边界、语言习惯和关系立场写具体。不要输出 API、密钥、运行时记忆或界面美化字段。'),
  },
  {
    kind: 'worldbook', label: '世界书制作', shortLabel: '世界书', target: 'optional-character', accent: '#059669',
    description: '制作一个分类下的多条目世界书，并可整组挂载。',
    prompt: protocol('worldbook', `{
  "category": "世界书分类名",
  "entries": {
    "0": {
      "uid": 0, "comment": "条目标题", "content": "完整设定正文",
      "key": ["主要触发词"], "keysecondary": [],
      "constant": false, "selective": false, "selectiveLogic": 0,
      "order": 100, "position": 1, "disable": false,
      "probability": 100, "useProbability": false,
      "depth": 4, "role": null, "scanDepth": 4,
      "caseSensitive": false, "matchWholeWords": false
    }
  }
}`, '一个作品块代表一本世界书：category 下可放多个 entries，结构对齐 SillyTavern 世界书。position：0角色设定前、1角色设定后、2作者注释顶部、3作者注释底部、4聊天记录指定深度、5示例消息前、6示例消息后；只有 position=4 时 role 才使用 0/System、1/User、2/Assistant。常驻条目 constant=true 且 key=[]；关键词条目 constant=false 并填写 key。'),
  },
];

// The all-in-one appearance preset overpromises what one generated artifact can
// safely control. Keep its definition only so older saved works still preview,
// validate and install; do not expose it as a new-work maker.
export const COLLABORATION_MAKERS = ALL_COLLABORATION_MAKERS.filter(
  definition => definition.kind !== 'appearance-preset',
);

export const COLLABORATION_MAKER_MAP = Object.fromEntries(
  ALL_COLLABORATION_MAKERS.map(definition => [definition.kind, definition]),
) as Record<CollaborationMakerKind, CollaborationMakerDefinition>;

export const getCollaborationMakerPrompt = (kind?: CollaborationMakerKind): string => (
  kind ? COLLABORATION_MAKER_MAP[kind].prompt : ''
);

const INSTALLABLE_BLOCK = /```sully-artifact\s*\n([\s\S]*?)```/gi;

export const parseInstallableArtifactBlocks = (response: string): {
  visibleText: string;
  artifacts: CollaborationInstallableArtifact[];
} => {
  const artifacts: CollaborationInstallableArtifact[] = [];
  const visibleText = response.replace(INSTALLABLE_BLOCK, (raw, blockText: string) => {
    const divider = blockText.indexOf('\n---');
    if (divider < 0) return raw;
    const header = blockText.slice(0, divider).trim();
    const payloadText = blockText.slice(divider + 4).trim();
    const values = Object.fromEntries(header.split('\n').map(line => {
      const colon = line.indexOf(':');
      return colon < 0 ? ['', ''] : [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
    }).filter(([key]) => key));
    const kind = values.kind as CollaborationMakerKind;
    if (!COLLABORATION_MAKER_MAP[kind]) return raw;
    try {
      const payload = JSON.parse(payloadText);
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') return raw;
      artifacts.push({ kind, title: values.title || COLLABORATION_MAKER_MAP[kind].label, payload });
      return '';
    } catch {
      return raw;
    }
  }).trim();
  return { visibleText, artifacts };
};

export const materializeInstallableArtifact = (artifact: CollaborationInstallableArtifact): {
  attachment: CollaborationAttachment;
  blob: Blob;
} => {
  const blob = new Blob([JSON.stringify(artifact)], { type: 'application/vnd.sullyos.installable+json' });
  return {
    blob,
    attachment: {
      id: collaborationId('attachment'),
      assetId: collaborationId('asset'),
      kind: 'installable',
      installableKind: artifact.kind,
      name: artifact.title,
      mimeType: blob.type,
      size: blob.size,
      createdAt: Date.now(),
    },
  };
};

const bubbleSelector = /^(?:\.sully-bubble(?:\b|-)|\.sully-voice-bar(?:\b|-))/;
const psycheSelector = /^\.sully-psyche\b/;

const cssOf = (artifact: CollaborationInstallableArtifact): string => (
  typeof artifact.payload.css === 'string' ? artifact.payload.css : ''
);

const worldbookEntriesOf = (payload: Record<string, unknown>): unknown[] => {
  const rawEntries = payload.entries;
  if (Array.isArray(rawEntries)) return rawEntries;
  if (rawEntries && typeof rawEntries === 'object') return Object.values(rawEntries as Record<string, unknown>);
  // Compatibility for artifacts generated before worldbooks became grouped packages.
  if (typeof payload.content === 'string') return [payload];
  return [];
};

export const validateInstallableArtifact = (artifact: CollaborationInstallableArtifact): string[] => {
  const errors: string[] = [];
  const requireCss = (regex: RegExp, hint: string) => {
    const css = cssOf(artifact);
    if (!css.trim()) errors.push('作品里没有可用的 CSS。');
    else errors.push(...validateScopedCss(css, regex, hint).errors);
  };
  if (artifact.kind === 'bubble-theme') {
    const css = typeof artifact.payload.customCss === 'string' ? artifact.payload.customCss : '';
    if (!artifact.payload.user || !artifact.payload.ai) errors.push('气泡主题缺少 user 或 ai 两侧样式。');
    if (css) errors.push(...validateScopedCss(css, bubbleSelector, '.sully-bubble-user / .sully-bubble-ai / .sully-voice-bar').errors);
  } else if (artifact.kind === 'whitebox-css') requireCss(WHITEBOX_SCOPE_REGEX, WHITEBOX_SCOPE_HINT);
  else if (artifact.kind === 'journal-css') requireCss(JOURNAL_CSS_SCOPE_REGEX, JOURNAL_CSS_SCOPE_HINT);
  else if (artifact.kind === 'schedule-css') requireCss(SCHEDULE_CSS_SCOPE_REGEX, SCHEDULE_CSS_SCOPE_HINT);
  else if (artifact.kind === 'psyche-css') requireCss(psycheSelector, '.sully-psyche*');
  else if (artifact.kind === 'appearance-preset' && (!artifact.payload.theme || typeof artifact.payload.theme !== 'object')) errors.push('外观预设缺少 theme 配置。');
  else if (artifact.kind === 'character-card') {
    if (typeof artifact.payload.name !== 'string' || !artifact.payload.name.trim()) errors.push('角色卡缺少名字。');
    if (typeof artifact.payload.systemPrompt !== 'string' || !artifact.payload.systemPrompt.trim()) errors.push('角色卡缺少核心设定。');
  } else if (artifact.kind === 'worldbook') {
    if (typeof artifact.payload.category !== 'string' || !artifact.payload.category.trim()) errors.push('世界书缺少分类名。');
    const entries = worldbookEntriesOf(artifact.payload);
    if (entries.length === 0) errors.push('世界书里没有条目。');
    entries.forEach((entry, index) => {
      const value = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      const entryTitle = typeof value.comment === 'string' ? value.comment : value.title;
      if (typeof entryTitle !== 'string' || !entryTitle.trim()) errors.push(`世界书第 ${index + 1} 条缺少标题 comment。`);
      if (typeof value.content !== 'string' || !value.content.trim()) errors.push(`世界书第 ${index + 1} 条缺少正文。`);
      if (value.position !== undefined && (typeof value.position !== 'number' || value.position < 0 || value.position > 6)) errors.push(`世界书第 ${index + 1} 条的注入位置无效。`);
    });
  }
  return errors;
};

const DEFAULT_BUBBLE: BubbleStyle = {
  textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 20, opacity: 1,
};

const normalizeBubbleSide = (value: unknown): BubbleStyle => {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    ...DEFAULT_BUBBLE,
    ...Object.fromEntries(Object.entries(source).filter(([, entry]) => ['string', 'number'].includes(typeof entry))),
    textColor: typeof source.textColor === 'string' ? source.textColor : DEFAULT_BUBBLE.textColor,
    backgroundColor: typeof source.backgroundColor === 'string' ? source.backgroundColor : DEFAULT_BUBBLE.backgroundColor,
    borderRadius: typeof source.borderRadius === 'number' ? source.borderRadius : DEFAULT_BUBBLE.borderRadius,
    opacity: typeof source.opacity === 'number' ? source.opacity : 1,
  } as BubbleStyle;
};

export const installableToChatTheme = (artifact: CollaborationInstallableArtifact): ChatTheme => ({
  id: collaborationId('theme'),
  name: String(artifact.payload.name || artifact.title).slice(0, 50),
  type: 'custom',
  user: normalizeBubbleSide(artifact.payload.user),
  ai: normalizeBubbleSide(artifact.payload.ai),
  customCss: typeof artifact.payload.customCss === 'string' ? artifact.payload.customCss : '',
});

const APPEARANCE_KEYS: Array<keyof OSTheme> = [
  'hue', 'saturation', 'lightness', 'darkMode', 'contentColor', 'skin', 'desktopVariant', 'statusBarMode',
  'chatAvatarShape', 'chatAvatarSize', 'chatEmojiSize', 'chatAvatarMode', 'chatAvatarPlacement',
  'chatBubbleStyle', 'chatMessageSpacing', 'chatShowTimestamp', 'chatTimestampPosition', 'chatHeaderStyle', 'chatInputStyle',
  'chatChromeStyle', 'chatBackgroundStyle', 'chatHeaderAlign', 'chatHeaderDensity', 'chatStatusStyle',
  'chatSendButtonStyle', 'chatHideHeaderBuffs',
  'chatAvatarVisibility', 'chatAvatarAlign', 'chatAvatarOffsetY', 'chatBubbleFontSize',
  'chatBubbleLineHeight', 'chatBubbleIndent', 'chatSnapToEdge', 'chatModuleAlign',
];

export const installableToThemePatch = (artifact: CollaborationInstallableArtifact): Partial<OSTheme> => {
  const source = artifact.payload.theme && typeof artifact.payload.theme === 'object'
    ? artifact.payload.theme as Record<string, unknown>
    : {};
  const patch: Partial<OSTheme> = {};
  APPEARANCE_KEYS.forEach(key => {
    if (source[key] !== undefined && ['string', 'number', 'boolean'].includes(typeof source[key])) {
      (patch as Record<string, unknown>)[key] = source[key];
    }
  });
  return patch;
};

export const installableToCharacterPatch = (artifact: CollaborationInstallableArtifact): Partial<CharacterProfile> => ({
  name: String(artifact.payload.name || artifact.title).trim().slice(0, 80),
  description: typeof artifact.payload.description === 'string' ? artifact.payload.description : '',
  systemPrompt: typeof artifact.payload.systemPrompt === 'string' ? artifact.payload.systemPrompt : '',
  worldview: typeof artifact.payload.worldview === 'string' ? artifact.payload.worldview : undefined,
});

export const installableToWorldbooks = (artifact: CollaborationInstallableArtifact): Worldbook[] => {
  const now = Date.now();
  const payload = artifact.payload;
  const entries = worldbookEntriesOf(payload);
  const normalizedEntries = entries.map((entry, index) => {
    const value = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    return {
      ...value,
      uid: Number.isFinite(Number(value.uid)) ? Number(value.uid) : index,
      comment: String(value.comment || value.title || `条目 ${index + 1}`).slice(0, 100),
    };
  });
  const category = typeof payload.category === 'string' && payload.category.trim()
    ? payload.category.trim().slice(0, 50)
    : artifact.title.trim().slice(0, 50) || '协同制作';
  return parseStandardWorldbook(JSON.stringify({ entries: normalizedEntries }), category, now);
};

/** @deprecated Prefer installableToWorldbooks; retained for older single-entry callers. */
export const installableToWorldbook = (artifact: CollaborationInstallableArtifact): Worldbook => (
  installableToWorldbooks(artifact)[0]
);

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
const safeStyleText = (value: string): string => value.replace(/<\/style/gi, '<\\/style');

export const buildInstallablePreviewDocument = (artifact: CollaborationInstallableArtifact): string => {
  const css = artifact.kind === 'bubble-theme' ? String(artifact.payload.customCss || '') : cssOf(artifact);
  const title = escapeHtml(artifact.title);
  const common = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>html,body{margin:0;min-height:100%;font-family:system-ui,'Microsoft YaHei',sans-serif;color:#25314a}*{box-sizing:border-box}body{background:#eef1f7}.phone{width:min(100%,430px);min-height:100vh;margin:auto;background:#f7f8fc;overflow:hidden}.label{font-size:10px;letter-spacing:.16em;text-transform:uppercase;opacity:.5}</style><style>${safeStyleText(css)}</style></head><body>`;
  if (artifact.kind === 'bubble-theme' || artifact.kind === 'whitebox-css') {
    const theme = artifact.kind === 'bubble-theme' ? installableToChatTheme(artifact) : null;
    const userStyle = theme ? `background:${theme.user.backgroundColor};color:${theme.user.textColor};border-radius:${theme.user.borderRadius}px;opacity:${theme.user.opacity}` : '';
    const aiStyle = theme ? `background:${theme.ai.backgroundColor};color:${theme.ai.textColor};border-radius:${theme.ai.borderRadius}px;opacity:${theme.ai.opacity}` : '';
    return `${common}<main class="phone sully-chat-root"><header class="sully-chat-header" style="height:88px;padding:30px 16px 12px;display:flex;align-items:center;gap:10px;background:white"><button class="sully-chat-back">‹</button><div class="sully-chat-avatar" style="width:38px;height:38px;border-radius:50%;background:#c4b5fd"></div><div><b class="sully-chat-name">Noir</b><div class="sully-chat-status" style="font-size:11px;opacity:.55">沉浸式协同</div></div><span class="sully-chat-token" style="margin-left:auto;font-size:10px">WORK</span></header><section style="padding:36px 18px"><div class="sully-chat-message sully-chat-message-ai"><div class="sully-chat-message-content"><div class="sully-bubble-ai" style="${aiStyle};display:inline-block;padding:12px 15px;max-width:82%">我把细节都收好了。先看这一版。</div></div></div><div class="sully-chat-message sully-chat-message-user" style="margin-top:18px;text-align:right"><div class="sully-chat-message-content"><div class="sully-bubble-user" style="${userStyle};display:inline-block;padding:12px 15px;max-width:82%">好，我喜欢这个方向。</div></div></div></section><footer class="sully-chat-inputbar" style="position:fixed;bottom:0;width:min(100%,430px);padding:14px;background:white"><div style="height:42px;border-radius:22px;background:#f1f3f8"></div></footer></main></body></html>`;
  }
  if (artifact.kind === 'journal-css') return `${common}<main class="phone sully-journal-root" style="padding:46px 20px"><div class="label">EXCHANGE JOURNAL</div><article class="sully-journal-paper" style="margin-top:18px;padding:28px 24px;min-height:560px;background:#fffdf8;box-shadow:0 18px 50px #5b49601f"><div class="sully-journal-date">2026 · 08 · 29</div><h1 class="sully-journal-title">留给今天的一页</h1><p class="sully-journal-body">她把没有说完的话写在这里。窗外很安静，纸页上留下了一点柔软的光。</p><div class="sully-journal-timeline">22:31 · Noir</div></article></main></body></html>`;
  if (artifact.kind === 'schedule-css') return `${common}<main class="phone" style="padding:70px 18px"><section class="sully-schedule-root sully-schedule-card" style="--schedule-bg:#21192b;--schedule-text:#f8f3ff;--schedule-accent:#c9a7ff;background:var(--schedule-bg);color:var(--schedule-text);border-radius:24px;padding:20px"><header class="sully-schedule-header"><div class="label">TODAY</div><h2>Noir 的日程</h2></header><div class="sully-schedule-list"><div class="sully-schedule-item sully-schedule-item-current" style="padding:14px;border-left:3px solid var(--schedule-accent)"><b class="sully-schedule-time">22:30</b><div class="sully-schedule-activity">整理协同作品</div><small class="sully-schedule-description">检查预览并把作品归档。</small></div><div class="sully-schedule-item" style="padding:14px"><b class="sully-schedule-time">23:20</b><div class="sully-schedule-activity">夜间阅读</div></div></div></section></main></body></html>`;
  if (artifact.kind === 'psyche-css') return `${common}<main class="phone" style="padding:90px 20px"><div class="sully-psyche"><section class="sully-psyche-card" style="padding:18px;border-radius:18px;background:#211b38;color:#f5e9c9;border:1px solid #e7c27666"><div class="sully-psyche-title">心象 · ECHO</div><p class="sully-psyche-preview">她说喜欢……那就再把边缘收得更干净一点。</p><div class="sully-psyche-body">先确认保存位置，再交给她使用。</div></section></div></main></body></html>`;
  if (artifact.kind === 'appearance-preset') {
    const patch = installableToThemePatch(artifact);
    const hue = typeof patch.hue === 'number' ? patch.hue : 260;
    const content = typeof patch.contentColor === 'string' ? patch.contentColor : '#f7f5ff';
    return `${common}<main class="phone" style="padding:54px 22px;background:hsl(${hue} 45% 94%)"><div class="label">${title}</div><section style="margin-top:20px;padding:22px;border-radius:28px;background:${escapeHtml(content)}"><h1 style="font-size:28px;margin:0">SullyOS</h1><p style="opacity:.58">外观预设 · 即时预览</p><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:40px">${['聊天','日记','小屋','音乐','日程','设置'].map(label => `<div style="aspect-ratio:1;border-radius:22px;background:white;display:grid;place-items:center;box-shadow:0 10px 28px #4a3d6612">${label}</div>`).join('')}</div></section></main></body></html>`;
  }
  if (artifact.kind === 'worldbook') {
    let books: Worldbook[] = [];
    try { books = installableToWorldbooks(artifact); } catch { /* validation explains malformed entries */ }
    const category = escapeHtml(String(artifact.payload.category || artifact.title));
    const rows = books.map(book => {
      const mode = book.constant ? '常驻' : `触发：${escapeHtml((book.key || []).join('、') || '未设置')}`;
      const position = WORLDBOOK_POSITION_LABELS[book.position ?? 1];
      return `<article style="padding:18px 0;border-top:1px solid #dfe4ec"><div style="display:flex;align-items:center;gap:8px"><b style="font-size:15px">${escapeHtml(book.title)}</b><span style="font-size:10px;padding:3px 7px;border-radius:999px;background:#e8f5ee;color:#17734a">${mode}</span></div><div style="margin-top:7px;font-size:11px;color:#758096">${escapeHtml(position)} · 顺序 ${book.order ?? 100}</div><p style="margin:10px 0 0;white-space:pre-wrap;font-size:13px;line-height:1.65;color:#44506a">${escapeHtml(book.content)}</p></article>`;
    }).join('');
    return `${common}<main class="phone" style="padding:46px 22px"><div class="label">SILLYTAVERN WORLDBOOK</div><h1 style="margin:9px 0 4px;font-size:25px">${category}</h1><p style="margin:0 0 24px;color:#8791a5;font-size:12px">${books.length} 个条目 · 将作为同一分类保存</p><section style="background:white;padding:0 18px;border-radius:22px">${rows || '<p style="padding:24px;color:#9aa3b3">没有可预览的有效条目</p>'}</section></main></body></html>`;
  }
  return `${common}<main class="phone" style="padding:54px 24px"><div class="label">${escapeHtml(COLLABORATION_MAKER_MAP[artifact.kind].label)}</div><h1>${title}</h1><pre style="white-space:pre-wrap;font:14px/1.7 system-ui;background:white;padding:20px;border-radius:20px">${escapeHtml(JSON.stringify(artifact.payload, null, 2))}</pre></main></body></html>`;
};
