import { describe, it, expect } from 'vitest';
import { buildChatFineTuneCss, mergeChatFineTune, CHAT_FINE_TUNE_KEYS } from './chatFineTuneCss';

// 聊天细节微调 CSS 生成器：全默认零输出；各旋钮生成的选择器与社区已验证版本一致。

describe('buildChatFineTuneCss', () => {
    it('全默认 → 空串（不注入任何 style）', () => {
        expect(buildChatFineTuneCss({})).toBe('');
        expect(buildChatFineTuneCss({ chatAvatarVisibility: 'both', chatAvatarPlacement: 'beside', chatAvatarAlign: 'bottom', chatAvatarOffsetY: 0, chatBubbleFontSize: 0, chatBubbleLineHeight: 0, chatBubbleIndent: 0 })).toBe('');
    });

    it('隐藏角色侧头像只影响 justify-start；贴边只收隐藏侧空位', () => {
        const css = buildChatFineTuneCss({ chatAvatarVisibility: 'hide_ai', chatSnapToEdge: true });
        expect(css).toContain('.group.justify-start > [class~="absolute"][class~="z-0"] { display: none');
        expect(css).not.toContain('.group.justify-end > [class~="absolute"][class~="z-0"] { display: none');
        expect(css).toContain('.ml-12:not(.sully-html-wrap) { margin-left: 0 !important; }');
        expect(css).not.toContain('margin-right: 0');
    });

    it('每轮气泡上方：显示组首头像、隐藏默认头像、首条留高并收回气泡旁空位', () => {
        const css = buildChatFineTuneCss({ chatAvatarPlacement: 'above_group' });
        expect(css).toContain('.sully-chat-turn-avatar-slot { display: block !important;');
        expect(css).toContain('.sully-chat-message-avatar { display: none !important;');
        expect(css).toContain('padding-top: calc(var(--sully-chat-message-avatar-size, 36px) + var(--sully-chat-avatar-time-space, 0px) + 8px) !important;');
        expect(css).toContain('.sully-chat-message-content:not(.sully-html-wrap) { margin-left: 0 !important; margin-right: 0 !important; }');
    });

    it('心象卡片钉回默认位置：贴边补 48px、缩进补 48-indent、没动不出规则', () => {
        const snapCss = buildChatFineTuneCss({ chatAvatarVisibility: 'hide_ai', chatSnapToEdge: true });
        expect(snapCss).toContain('.sully-psyche { margin-left: 48px !important; }');
        const indentCss = buildChatFineTuneCss({ chatBubbleIndent: 60 });
        expect(indentCss).toContain('.sully-psyche { margin-left: -12px !important; }');
        // 贴边只作用于用户侧时，AI 包装层只受缩进影响 → 按缩进补
        const mixedCss = buildChatFineTuneCss({ chatAvatarVisibility: 'hide_user', chatSnapToEdge: true, chatBubbleIndent: 28 });
        expect(mixedCss).toContain('.sully-psyche { margin-left: 20px !important; }');
        // 包装层没动（只改字号/对齐）→ 不出心象规则
        expect(buildChatFineTuneCss({ chatBubbleFontSize: 14, chatAvatarAlign: 'top' })).not.toContain('sully-psyche');
    });

    it('贴边/缩进的选择器都 :not() 绕开 HTML 卡片包装（卡片不随美化挪窝）', () => {
        const css = buildChatFineTuneCss({ chatAvatarVisibility: 'hide_both', chatSnapToEdge: true, chatBubbleIndent: 60 });
        const wrapRules = css.split('\n').filter(line => line.includes('.ml-12') || line.includes('.mr-12'));
        expect(wrapRules.length).toBeGreaterThan(0);
        for (const rule of wrapRules) expect(rule).toContain(':not(.sully-html-wrap)');
    });

    it('顶部对齐 + 垂直微调', () => {
        const css = buildChatFineTuneCss({ chatAvatarAlign: 'top', chatAvatarOffsetY: -8 });
        expect(css).toContain('bottom: auto !important; top: -0.5rem !important;');
        expect(css).toContain('translateY(-8px)');
    });

    it('垂直居中把偏移并进 calc（transform 不互相覆盖）', () => {
        const css = buildChatFineTuneCss({ chatAvatarAlign: 'center', chatAvatarOffsetY: 4 });
        expect(css).toContain('translateY(calc(-50% + 4px))');
    });

    it('字号/行距走社区版四层选择器，内联元素 inherit', () => {
        const css = buildChatFineTuneCss({ chatBubbleFontSize: 14, chatBubbleLineHeight: 1.5 });
        expect(css).toContain('.sully-bubble-ai > div[class~="select-text"]');
        expect(css).toContain('font-size: 14px !important;');
        expect(css).toContain('line-height: 1.5 !important;');
        expect(css).toContain('font-size: inherit !important;');
        expect(css).toContain('[class*="text-[13px]"]');
    });

    it('合并结果直接可喂给 buildChatFineTuneCss（角色覆盖后按覆盖值出 CSS）', () => {
        const css = buildChatFineTuneCss(mergeChatFineTune(
            { chatBubbleFontSize: 14 },
            { enabled: true, chatBubbleFontSize: 16 },
        ));
        expect(css).toContain('font-size: 16px !important;');
        expect(css).not.toContain('font-size: 14px');
    });

    it('气泡缩进对两侧生效；贴边侧让位', () => {
        const css = buildChatFineTuneCss({ chatBubbleIndent: 60 });
        expect(css).toContain('margin-left: 60px !important;');
        expect(css).toContain('margin-right: 60px !important;');
        const snapCss = buildChatFineTuneCss({ chatBubbleIndent: 60, chatAvatarVisibility: 'hide_ai', chatSnapToEdge: true });
        expect(snapCss).toContain('margin-left: 0 !important;');
        expect(snapCss).not.toContain('margin-left: 60px');
        expect(snapCss).toContain('margin-right: 60px !important;');
    });
});

// 「全局打底，角色可覆盖」合并规则：enabled 才生效；生效时已定义字段逐个覆盖，未定义跟随全局。

describe('mergeChatFineTune', () => {
    const global = { chatAvatarVisibility: 'hide_ai', chatBubbleFontSize: 14, chatBubbleIndent: 60, chatSnapToEdge: true } as const;

    it('无覆盖 / enabled 缺省或 false → 完全跟随全局（设了字段也不生效）', () => {
        expect(mergeChatFineTune(global)).toEqual(global);
        expect(mergeChatFineTune(global, null)).toEqual(global);
        expect(mergeChatFineTune(global, { chatBubbleFontSize: 16 })).toEqual(global);
        expect(mergeChatFineTune(global, { enabled: false, chatBubbleFontSize: 16 })).toEqual(global);
    });

    it('enabled=true → 已定义字段逐个覆盖，未定义字段跟随全局', () => {
        const merged = mergeChatFineTune(global, { enabled: true, chatBubbleFontSize: 16, chatAvatarAlign: 'top' });
        expect(merged).toEqual({ ...global, chatBubbleFontSize: 16, chatAvatarAlign: 'top' });
    });

    it('显式默认值（0 / both / false）也算覆盖——角色可把某项压回默认', () => {
        const merged = mergeChatFineTune(global, { enabled: true, chatBubbleFontSize: 0, chatAvatarVisibility: 'both', chatSnapToEdge: false });
        expect(merged.chatBubbleFontSize).toBe(0);
        expect(merged.chatAvatarVisibility).toBe('both');
        expect(merged.chatSnapToEdge).toBe(false);
        expect(merged.chatBubbleIndent).toBe(60); // 未覆盖的字段仍跟全局
    });

    it('返回浅拷贝且只含微调字段，不夹带 enabled / 其他主题键', () => {
        const merged = mergeChatFineTune({ ...global, chatBubbleStyle: 'flat' } as any, { enabled: true });
        expect(merged).not.toBe(global);
        expect(merged).not.toHaveProperty('enabled');
        expect(merged).not.toHaveProperty('chatBubbleStyle');
        for (const key of Object.keys(merged)) expect(CHAT_FINE_TUNE_KEYS).toContain(key);
    });

    it('全局与覆盖都为空 → 空对象（buildChatFineTuneCss 得零输出）', () => {
        const merged = mergeChatFineTune({}, { enabled: true });
        expect(merged).toEqual({});
        expect(buildChatFineTuneCss(merged)).toBe('');
    });

    it('chatModuleAlign 参与合并但不生成 CSS（经 MessageItem 布局属性生效，缺省=居中）', () => {
        const merged = mergeChatFineTune({ chatModuleAlign: 'center' }, { enabled: true, chatModuleAlign: 'anchor' });
        expect(merged.chatModuleAlign).toBe('anchor');
        expect(buildChatFineTuneCss({ chatModuleAlign: 'center' })).toBe('');
        expect(buildChatFineTuneCss({ chatModuleAlign: 'anchor' })).toBe('');
    });
});
