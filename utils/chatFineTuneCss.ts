/**
 * 聊天细节微调 CSS 生成器（外观 → 聊天细节）。
 *
 * 收编自社区作者「毛豆腐和面机」（DC）的「神秘拼好码」美化 CSS（致谢见 README 鸣谢）：
 * 隐藏头像、头像位置/对齐/微调、消息贴边、气泡缩进、正文字号/行距。
 * 选择器沿用她的版本已在真实 DOM 上验证过的形态
 * （锚 .group.justify-* 与 .sully-bubble-* 结构），生成规则带 !important
 * 以压过 Tailwind 工具类。
 *
 * 注入位置：Chat.tsx 在用户自定义白框 CSS（chatChromeCustomCss / 角色
 * chromeCustomCss）**之前**插入本样式——同为 !important 时后者胜，老用户
 * 手写的美化代码永远能覆盖这里的可视化设置，互不打架。
 *
 * 全部字段缺省时返回空串（一个 <style> 都不注入，现状零变化）。
 */

import type { ChatFineTuneFields, ChatFineTuneOverride } from '../types';

/** 微调字段清单（合并 / 重置 / 快照都以这份为准，加字段只改这里一处）。 */
export const CHAT_FINE_TUNE_KEYS = [
    'chatAvatarVisibility', 'chatAvatarPlacement', 'chatAvatarAlign', 'chatAvatarOffsetY',
    'chatBubbleFontSize', 'chatBubbleLineHeight', 'chatBubbleIndent', 'chatSnapToEdge',
    // chatModuleAlign 不生成 CSS（HTML/心象卡片位置经 MessageItem 布局属性生效），
    // 但同属微调字段：合并/重置/角色覆盖/备份都跟这份清单走。
    'chatModuleAlign',
] as const satisfies ReadonlyArray<keyof ChatFineTuneFields>;

/**
 * 「全局打底，角色可覆盖」的合并规则：
 * - override 缺省或 enabled 不为 true → 原样返回全局值（角色完全跟随全局）；
 * - enabled=true → 已定义（!== undefined）的字段逐个覆盖全局，未定义的字段跟随全局。
 *   注意显式 0 / 'both' / false 也算「已定义」——角色可以借此把某项压回默认，
 *   即使全局设了别的值（UI 的「回默认」按钮依赖这一点）。
 * 返回值只含微调字段的浅拷贝，喂给 buildChatFineTuneCss 即可。
 */
export function mergeChatFineTune(global: ChatFineTuneFields, override?: ChatFineTuneOverride | null): ChatFineTuneFields {
    const merged: ChatFineTuneFields = {};
    for (const key of CHAT_FINE_TUNE_KEYS) {
        const value = override?.enabled === true && override[key] !== undefined ? override[key] : global[key];
        if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    }
    return merged;
}

const AI_AVATAR = '.sully-chat-root .group.justify-start > [class~="absolute"][class~="z-0"]';
const USER_AVATAR = '.sully-chat-root .group.justify-end > [class~="absolute"][class~="z-0"]';
const AI_BESIDE_AVATAR = '.sully-chat-root .sully-chat-message-ai > .sully-chat-message-avatar-slot';
const USER_BESIDE_AVATAR = '.sully-chat-root .sully-chat-message-user > .sully-chat-message-avatar-slot';
const TURN_AVATAR = '.sully-chat-root .sully-chat-turn-avatar-slot';
const DEFAULT_AVATAR = '.sully-chat-root .sully-chat-message-avatar';
const GROUP_FIRST = '.sully-chat-root .sully-chat-message-group-first:not(.sully-chat-message-module)';
const MESSAGE_CONTENT = '.sully-chat-root .sully-chat-message-content:not(.sully-html-wrap)';
const AI_BODY = '.sully-chat-root .sully-bubble-ai > div[class~="select-text"]';
const USER_BODY = '.sully-chat-root .sully-bubble-user > div[class~="select-text"]';
// 贴边/缩进只该动普通气泡：HTML 卡片（280px 定宽模块，包装层带 .sully-html-wrap）
// 的默认位置就是"视觉居中"的约定，:not() 绕开让它不随美化挪窝。
const AI_WRAP = '.sully-chat-root .group.justify-start [class~="max-w-[72%]"].ml-12:not(.sully-html-wrap)';
const USER_WRAP = '.sully-chat-root .group.justify-end [class~="max-w-[72%]"].mr-12:not(.sully-html-wrap)';
// 心象卡片（思考链，仅 AI 侧）与气泡共用包装层，:not() 绕不开——包装层被贴边/缩进挪动时
// 给它一个反向 margin 抵消，钉回默认位置（ml-12 = 48px），与 HTML 卡片同一"模块不挪窝"约定。
const AI_PSYCHE = '.sully-chat-root .group.justify-start .sully-psyche';
const DEFAULT_WRAP_MARGIN = 48;

const hideRule = (sel: string) =>
    `${sel} { display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important; }`;

export function buildChatFineTuneCss(theme: ChatFineTuneFields): string {
    const rules: string[] = [];
    const vis = theme.chatAvatarVisibility || 'both';
    const hideAi = vis === 'hide_ai' || vis === 'hide_both';
    const hideUser = vis === 'hide_user' || vis === 'hide_both';

    // 隐藏规则最后追加：这样“每轮上方”的 display:block 不会意外把用户主动隐藏的一侧重新显示。
    const hideRules: string[] = [];
    if (hideAi) hideRules.push(hideRule(AI_AVATAR));
    if (hideUser) hideRules.push(hideRule(USER_AVATAR));

    // ── 贴边（只对隐藏了头像的一侧收回空位）──
    if (theme.chatSnapToEdge) {
        if (hideAi) rules.push(`${AI_WRAP} { margin-left: 0 !important; }`);
        if (hideUser) rules.push(`${USER_WRAP} { margin-right: 0 !important; }`);
    }

    // ── 头像对齐 + 垂直微调 ──
    const align = theme.chatAvatarAlign || 'bottom';
    const offY = theme.chatAvatarOffsetY || 0;
    if (align !== 'bottom' || offY !== 0) {
        const both = `${AI_BESIDE_AVATAR}, ${USER_BESIDE_AVATAR}`;
        if (align === 'top') {
            rules.push(`${both} { bottom: auto !important; top: -0.5rem !important;${offY ? ` transform: translateY(${offY}px) !important;` : ''} }`);
        } else if (align === 'center') {
            rules.push(`${both} { bottom: auto !important; top: 50% !important; transform: translateY(calc(-50% + ${offY}px)) !important; }`);
        } else {
            rules.push(`${both} { transform: translateY(${offY}px) !important; }`);
        }
    }

    // ── 气泡与头像侧的间距（贴边侧不重复设置，贴边优先）──
    const indent = theme.chatBubbleIndent || 0;
    if (indent > 0) {
        if (!(theme.chatSnapToEdge && hideAi)) rules.push(`${AI_WRAP} { margin-left: ${indent}px !important; }`);
        if (!(theme.chatSnapToEdge && hideUser)) rules.push(`${USER_WRAP} { margin-right: ${indent}px !important; }`);
    }

    // ── 心象卡片钉回默认位置 ──
    // AI 侧包装层被挪动多少，就给心象反向补多少：贴边时包装层 48→0（补 48px），
    // 缩进时 48→indent（补 48-indent，可为负）。包装层没动就不出规则。
    if (theme.chatSnapToEdge && hideAi) {
        rules.push(`${AI_PSYCHE} { margin-left: ${DEFAULT_WRAP_MARGIN}px !important; }`);
    } else if (indent > 0) {
        rules.push(`${AI_PSYCHE} { margin-left: ${DEFAULT_WRAP_MARGIN - indent}px !important; }`);
    }

    // ── 正文字号 / 行距（沿用社区版的四层选择器：容器/内层行/内联继承/引用行）──
    const fs = theme.chatBubbleFontSize || 0;
    const lh = theme.chatBubbleLineHeight || 0;
    if (fs > 0 || lh > 0) {
        const decl = `${fs > 0 ? ` font-size: ${fs}px !important;` : ''}${lh > 0 ? ` line-height: ${lh} !important;` : ''}`;
        const inheritDecl = `${fs > 0 ? ' font-size: inherit !important;' : ''}${lh > 0 ? ' line-height: inherit !important;' : ''}`;
        rules.push(`${AI_BODY}, ${USER_BODY} {${decl} }`);
        rules.push(`${AI_BODY} div, ${USER_BODY} div {${decl} }`);
        rules.push(`${AI_BODY} strong, ${AI_BODY} em, ${AI_BODY} span, ${USER_BODY} strong, ${USER_BODY} em, ${USER_BODY} span {${inheritDecl} }`);
        rules.push(`${AI_BODY} [class*="text-[13px]"], ${USER_BODY} [class*="text-[13px]"] {${decl} }`);
    }

    // ── 每轮头像置于整组气泡上方 ──
    if ((theme.chatAvatarPlacement || 'beside') === 'above_group') {
        rules.push(`${TURN_AVATAR} { display: block !important; top: 0 !important; bottom: auto !important; transform: none !important; }`);
        rules.push(`${DEFAULT_AVATAR} { display: none !important; }`);
        rules.push(`${GROUP_FIRST} { padding-top: calc(var(--sully-chat-message-avatar-size, 36px) + var(--sully-chat-avatar-time-space, 0px) + 8px) !important; }`);
        rules.push(`${MESSAGE_CONTENT} { margin-left: 0 !important; margin-right: 0 !important; }`);
    }

    rules.push(...hideRules);
    return rules.length ? `/* 聊天细节微调（外观 App 生成，用户自定义 CSS 可覆盖） */\n${rules.join('\n')}` : '';
}
