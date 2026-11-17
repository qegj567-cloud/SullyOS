import {SCHEDULE_CUSTOM_CSS_SELECTOR_GROUPS} from './scheduleAppearance';
export const PSYCHE_SELECTOR_GROUPS = [{
  label: '心象卡全部结构',
  selectors: ['.sully-psyche', '.sully-psyche-card', '.sully-psyche-title', '.sully-psyche-preview', '.sully-psyche-body'],
}] as const;


export const BUBBLE_SELECTOR_GROUPS = [
  {
    label: '两侧气泡',
    selectors: [
      '.sully-bubble-user', '.sully-bubble-ai', '.sully-bubble-group-first',
      '.sully-bubble-group-last', '.sully-bubble-tail-visible', '.sully-bubble-tail-hidden',
    ],
  },
  {
    label: '语音条',
    selectors: [
      '.sully-voice-bar', '.sully-voice-bar-shell', '.sully-voice-bar-button',
      '.sully-voice-bar-toggle', '.sully-voice-bar-loading', '.sully-voice-bar-placeholder',
      '.sully-voice-bar-transcript', '.sully-voice-bar-wave', '.sully-voice-bar-wave-segment',
    ],
  },
] as const;

export const WHITEBOX_SELECTOR_GROUPS = [
  ...PSYCHE_SELECTOR_GROUPS,
  {label:'所有 App 卡片的统一外壳',selectors:['.sully-chat-card','.sully-chat-card-surface','.sully-chat-card-content']},
  {
    label: '整屏与顶栏',
    selectors: [
      '.sully-chat-root', '.sully-chat-header', '.sully-chat-back', '.sully-chat-avatar',
      '.sully-chat-info', '.sully-chat-name', '.sully-chat-status', '.sully-chat-buffs',
      '.sully-chat-token', '.sully-chat-trigger',
    ],
  },
  {
    label: '输入与功能面板',
    selectors: ['.sully-chat-inputbar', '.sully-chat-composer', '.sully-chat-input-wrap', '.sully-chat-textarea', '.sully-chat-actions-button', '.sully-chat-send-button', '.sully-chat-emoji-suggestions', '.sully-chat-auto-reply', '.sully-chat-panel', '.sully-chat-panel button'],
  },
  {
    label: '消息布局',
    selectors: [
      '.sully-chat-message', '.sully-chat-message-user', '.sully-chat-message-ai',
      '.sully-chat-message-group-first', '.sully-chat-message-group-last', '.sully-chat-message-module',
      '.sully-chat-system', '.sully-chat-interaction', '.sully-chat-message-content', '.sully-chat-message-sender', '.sully-chat-message-avatar-slot',
      '.sully-chat-message-avatar', '.sully-chat-message-avatar-img', '.sully-chat-turn-avatar-slot',
      '.sully-chat-turn-avatar', '.sully-chat-avatar-wrap', '.sully-chat-avatar-frame',
      '.sully-chat-time-divider', '.sully-chat-timestamp-slot', '.sully-chat-timestamp',
    ],
  },
  {
    label: '气泡、表情与语音',
    selectors: [
      ...BUBBLE_SELECTOR_GROUPS[0].selectors, '.sully-emoji-msg', ...BUBBLE_SELECTOR_GROUPS[1].selectors,
    ],
  },
  {
    label: '转账主卡、回执与详情',
    selectors: ['card', 'receipt', 'header', 'icon', 'brand', 'watermark', 'amount', 'note', 'recipient', 'status', 'overlay', 'dialog', 'accept', 'return'].map(part => `.sully-chat-transfer-${part}`),
  },
  {
    label: '正式文件附件',
    selectors: [
      '.sully-collaboration-file', '.sully-collaboration-file-icon', '.sully-collaboration-file-meta',
      '.sully-collaboration-file-name', '.sully-collaboration-file-detail', '.sully-collaboration-file-action',
    ],
  },
  {
    label: '日程修改回执',
    selectors: SCHEDULE_CUSTOM_CSS_SELECTOR_GROUPS[2].selectors,
  },
] as const;


export const WHITEBOX_SCOPE_REGEX=/^(?:\.sully-chat(?:\b|-)|\.sully-bubble(?:\b|-)|\.sully-voice-bar(?:\b|-)|\.sully-emoji-msg\b|\.sully-collaboration-file(?:\b|-)|\.sully-schedule-change(?:\b|-)|\.sully-psyche(?:\b|-))/;
export const WHITEBOX_SCOPE_HINT='.sully-chat-* / .sully-bubble-* / .sully-voice-bar* / .sully-psyche* / .sully-emoji-msg / .sully-collaboration-file* / .sully-schedule-change*';
export const CHAT_CARD_KINDS = ['social_card','chat_forward','xhs_card','score_card','music_card','mcd_card','luckin_card','html_card','news_card','vr_card','trpg_card','novel_card','world_card','sim_card','phone_card','webpage_card','theater_card','room_card','life_card','group_topic_card','transfer','collaboration_file'] as const;
export const WHITEBOX_OPTIONAL_CARD_REFERENCE = `【可选 App 卡片接口参考：只在用户要求时输出对应 CSS】
data-card-kind 可取：${CHAT_CARD_KINDS.join('、')}。例如 .sully-chat-card[data-card-kind="music_card"]。data-role 区分 user/assistant/system。
score_card 的 data-card-variant 包括 quiz_card、guidebook_card、whiteday_card、like520_card、qixi_event_card、diary_card、lifesim_reset_card；日记和结算也可能由 system 发送。
统一外壳 .sully-chat-card-surface，内容区 .sully-chat-card-content；在指定卡片上声明 --sully-card-background、--sully-card-color、--sully-card-border、--sully-card-radius、--sully-card-shadow 可调整外壳，内部背景需要按内容区另行覆盖。不要在根节点声明这些变量而无意重画所有卡片。
HTML 卡片的内容处于沙盒 iframe，只能调整外壳和尺寸。正式文件附件保留文件名、类型与打开入口。日程回执使用 .sully-schedule-change*，系统提示与互动使用 .sully-chat-system / .sully-chat-interaction。
`;
export const WHITEBOX_LAYOUT_REFERENCE = `【布局说明与设计自由度】
.sully-chat-header 是 position:relative，头像、名字、状态、闪电和 token 可在其中重新布局；顶栏头像 .sully-chat-avatar 是 img，不能在它上面做伪元素。顶栏挂饰需要溢出时设 overflow:visible。
.sully-chat-buffs button 是情绪胶囊，带内联样式；覆盖时需要 !important。输入行使用 .sully-chat-composer，输入框用 .sully-chat-input-wrap / .sully-chat-textarea；表情联想和自动回复倒计时是输入栏外的同级区域，不依赖元素序号定位。
每轮头像在上方时，显示默认隐藏的 .sully-chat-turn-avatar-slot、隐藏 .sully-chat-message-avatar，给 .sully-chat-message-group-first 留出顶部空间，并清零 .sully-chat-message-content 的左右 margin。已有头像贴图 .sully-chat-avatar-frame 可隐藏以免重叠。
时间位置（气泡下方 vs 对话段上方居中）由「布局 → 时间位置」控制：上方居中整行容器为 .sully-chat-time-divider，气泡下方挂载位为 .sully-chat-timestamp-slot，两种模式的时间文字均为 .sully-chat-timestamp（可调字号、颜色、胶囊底色、圆角或伪元素装饰）。
不限于换颜色：可设计渐变、图案、图片背景、多层叠加、异形切角、描边、内外阴影、文字层级和伪元素挂饰，重新组织顶栏视觉。静态 blur/backdrop-filter 可用，持续动画仅用 transform/opacity 并尊重 prefers-reduced-motion。
`;
export const WHITEBOX_DESIGN_RULES=`白框默认沿用聊天背景、顶栏、输入栏和双方消息与头像的结构，内容样式只要求四类：普通聊天、语音条、转账、心象（折叠/展开）。如果用户只要求其中一部分，就只设计该部分。
其他 App 卡片仅在用户明确点名时增加样式；未点名保留原样，不需要逐项覆盖，也不要主动用通用卡片样式重画它们。点名的卡片可用 .sully-chat-card[data-card-kind="对应类型"] 精确定位，子类型用 data-card-variant；不要依赖 Tailwind 类或 nth-child。HTML 卡片仍不能跨 iframe 修改内容。
心象使用 .sully-psyche-card/title/preview/body，保留折叠与展开的可读性。图片、表情保持比例。
转账 data-status 为 pending/accepted/returned，金额与接收/退回操作不可隐藏。语音应覆盖加载、播放与字幕。
360—430px 窄屏，长文本换行；顶栏保留 var(--safe-top)，输入栏保留安全区。覆盖内联样式时使用 !important。禁止全局 body/html/* 选择器和持续模糊动画，禁止隐藏返回、发送及操作按钮。
头像装饰放 .sully-chat-avatar-wrap::after，pointer-events:none；容器 overflow:visible，裁剪仅作用于图片。组首头像使用 .sully-chat-turn-avatar-slot，不依赖元素序号。
`;
export const WHITEBOX_AI_PROMPT=`你是 SullyOS 糯米机的聊天白框设计师。以下是完整接口说明，供理解可定制范围，并不要求把所有接口都写进作品。\n${WHITEBOX_SELECTOR_GROUPS.map(group=>group.label+'：'+group.selectors.join('、')).join('\n')}\n${WHITEBOX_LAYOUT_REFERENCE}\n${WHITEBOX_OPTIONAL_CARD_REFERENCE}\n【实际输出要求】\n${WHITEBOX_DESIGN_RULES}\n直接输出可用的 CSS，可以带少量注释，不需要长篇解释。\n我想要的风格：______`;
