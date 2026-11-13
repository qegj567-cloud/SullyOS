import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareDecorationApplication } from './decorationApplication';
import { validateDecoration } from './chatDecoration';
import { withAvatarFrameTarget } from './avatarFrameTarget';
import { replaceWorkshopCss } from './decorationWorkshop';
import { PRESET_THEMES } from '../components/chat/ChatConstants';
import { migrateChatThemeBlobRefs } from './blobRef';
import type { CharacterProfile, ChatTheme, OSTheme } from '../types';
import type { DecorationOrigin } from './decorationLibrary';

vi.mock('./blobRef', () => ({
    migrateChatThemeBlobRefs: vi.fn(async (bubble: ChatTheme) => structuredClone(bubble)),
    migrateDataUrlToRef: vi.fn(async (value: string) => value),
    resolveRefToDataUrl: vi.fn(async (value: string) => value === 'blobref:missing' ? '' : 'data:image/png;base64,AA=='),
    blobToDataUrl: vi.fn(),
}));
const base = { chatSound: { src: 'ding' } } as OSTheme;
const self: DecorationOrigin = { kind: 'self' };
const readSelf = vi.fn(async () => self);
const chars = Array.from({ length: 12 }, (_, index) => ({ id: `c-${index}`, name: `C ${index}`, chromeCustomCss: `.own-${index}{}`, chatSound: { src: index % 2 ? 'pop' : 'chime' } } as CharacterProfile));
const preset = (bubble = PRESET_THEMES.dream, more = {}) => validateDecoration({ format: 'sullyos-chat-decoration', version: 1, name: '搭配', parts: { bubbles: bubble, ...more } });
beforeEach(() => vi.clearAllMocks());

describe('装扮应用共享气泡', () => {
    it('12 个角色只安装一份，重复应用和另一个角色继续复用同一 ID', async () => {
        const first = await prepareDecorationApplication(preset(), ['bubbles'], chars, base, [], self, readSelf);
        expect(first.bubbles).toHaveLength(1);
        const id = first.bubbles[0].id;
        expect(new Set(first.prepared.map(p => p.changes.character.bubbleStyle))).toEqual(new Set([id]));
        expect(migrateChatThemeBlobRefs).toHaveBeenCalledTimes(1);
        const applied = first.prepared.map(p => ({ ...p.character, ...p.changes.character }));
        const second = await prepareDecorationApplication(preset(), ['bubbles'], applied, base, first.bubbles, self, readSelf);
        expect(second.bubbles).toEqual([]);
        expect(second.prepared.every(p => p.changes.character.bubbleStyle === id)).toBe(true);
        const another = await prepareDecorationApplication(preset(), ['bubbles'], [chars[0]], base, first.bubbles, self, readSelf);
        expect(another.bubbles).toEqual([]);
        expect(another.prepared[0].changes.character.bubbleStyle).toBe(id);
        expect(migrateChatThemeBlobRefs).toHaveBeenCalledTimes(1);
    });

    it('已收藏气泡及内置气泡直接复用，不按角色复制', async () => {
        const local = { ...structuredClone(PRESET_THEMES.dream), id: 'local-original' };
        const result = await prepareDecorationApplication(preset(), ['bubbles'], chars, base, [local], self, readSelf);
        expect(result.bubbles).toEqual([]);
        expect(result.prepared.every(p => p.changes.character.bubbleStyle === local.id)).toBe(true);
        const builtin = await prepareDecorationApplication(preset(), ['bubbles'], chars, base, Object.values(PRESET_THEMES), { kind: 'builtin' }, async () => ({ kind: 'builtin' }));
        expect(builtin.bubbles).toEqual([]);
        expect(builtin.prepared[0].changes.character.bubbleStyle).toBe(PRESET_THEMES.dream.id);
    });

    it('整套搭配共用气泡，但各角色的未选声音、背景等设置分别保留', async () => {
        const result = await prepareDecorationApplication(preset(undefined, { css: '.sully-chat-page{color:red}' }), ['bubbles', 'css'], chars, base, [], self, readSelf);
        expect(result.bubbles).toHaveLength(1);
        result.prepared.forEach(({ character, changes }) => {
            expect(changes.character.chatSound).toEqual(character.chatSound);
            expect(changes.character.chatBackground).toBeUndefined();
            expect(changes.character.chromeCustomCss).toContain('color:red');
        });
    });

    it('相同头像框只准备一份组合，不同头像框分别保留，重用时不再增加', async () => {
        const old = (id: string, image: string) => ({ ...structuredClone(PRESET_THEMES.default), id, user: { ...PRESET_THEMES.default.user, avatarDecoration: image, avatarDecorationX: 7 } });
        const previous = [old('frame-a', 'data:image/png;base64,AA=='), old('frame-b', 'data:image/png;base64,BB==')];
        const targets = chars.map((char, index) => ({ ...char, bubbleStyle: index % 2 ? 'frame-a' : 'frame-b' }));
        const result = await prepareDecorationApplication(preset(), ['bubbles'], targets, base, previous, self, readSelf);
        expect(result.bubbles).toHaveLength(2);
        expect(new Set(result.prepared.map(p => p.changes.character.bubbleStyle)).size).toBe(2);
        expect(result.bubbles.map(b => b.user.avatarDecoration).sort()).toEqual(previous.map(b => b.user.avatarDecoration).sort());
        const next = result.prepared.map(p => ({ ...p.character, ...p.changes.character }));
        expect((await prepareDecorationApplication(preset(), ['bubbles'], next, base, [...previous, ...result.bubbles], self, readSelf)).bubbles).toEqual([]);
    });

    it('本机 blobref 与文件内联图片按实际内容复用，损坏的旧气泡不阻塞', async () => {
        const local = { ...structuredClone(PRESET_THEMES.dream), id: 'local-img', user: { ...PRESET_THEMES.dream.user, backgroundImage: 'blobref:valid' } };
        const incoming = { ...local, user: { ...local.user, backgroundImage: 'data:image/png;base64,AA==' } };
        const broken = { ...local, id: 'broken', user: { ...local.user, backgroundImage: 'blobref:missing' } };
        const result = await prepareDecorationApplication(preset(incoming), ['bubbles'], chars, base, [broken, local], self, readSelf);
        expect(result.bubbles).toEqual([]);
        expect(result.prepared[0].changes.character.bubbleStyle).toBe('local-img');
    });

    it('同名不同内容、来源或权限不合并，不覆盖原来的收藏', async () => {
        const existing = { ...structuredClone(PRESET_THEMES.dream), id: 'original' };
        const changed = { ...existing, customCss: '.sully-bubble{color:red}' };
        expect((await prepareDecorationApplication(preset(changed), ['bubbles'], chars, base, [existing], self, readSelf)).bubbles).toHaveLength(1);
        const result = await prepareDecorationApplication(preset(), ['bubbles'], chars, base, [existing], { kind: 'imported', credit: '作者', allowRemix: false }, readSelf);
        expect(result.bubbles).toHaveLength(1);
        expect(result.bubbles[0].id).not.toBe('original');
        expect(existing.customCss).not.toBe(changed.customCss);
    });

    it('仅保留旧头像框，不因旧气泡里无关的丢失背景图而阻塞应用', async () => {
        const previous = { ...structuredClone(PRESET_THEMES.default), id: 'old-broken-background', user: {
            ...PRESET_THEMES.default.user, backgroundImage: 'blobref:missing', avatarDecoration: 'blobref:frame',
        } };
        const result = await prepareDecorationApplication(preset(), ['bubbles'], [{ ...chars[0], bubbleStyle: previous.id }], base, [previous], self, readSelf);
        expect(result.bubbles).toHaveLength(1);
        expect(result.bubbles[0].user.avatarDecoration).toBe('data:image/png;base64,AA==');
        expect(result.bubbles[0].user.backgroundImage).not.toBe('blobref:missing');
    });

    it('未选择气泡以及没有目标角色时不会安装任何气泡', async () => {
        expect((await prepareDecorationApplication(preset(undefined, { css: '.x{}' }), ['css'], chars, base, [], self, readSelf)).bubbles).toEqual([]);
        expect((await prepareDecorationApplication(preset(), ['bubbles'], [], base, [], self, readSelf)).bubbles).toEqual([]);
        expect(migrateChatThemeBlobRefs).not.toHaveBeenCalled();
    });

    it('独立 CSS 头像框与旧版气泡内嵌头像框同侧应用时自动清掉同侧旧挂件，保留异侧挂件与原气泡署名', async () => {
        const bubbleWithBothFrames: ChatTheme = {
            ...structuredClone(PRESET_THEMES.default),
            id: 'legacy-dual-bubble',
            type: 'custom',
            user: { ...PRESET_THEMES.default.user, avatarDecoration: 'data:image/png;base64,AA==' },
            ai: { ...PRESET_THEMES.default.ai, avatarDecoration: 'data:image/png;base64,BB==' },
        };
        const bubbleOrigin: DecorationOrigin = { kind: 'imported', credit: '气泡作者', allowRemix: true, allowRedistribute: false };
        const cssAiOnly = withAvatarFrameTarget(validateDecoration({
            format: 'sullyos-chat-decoration',
            version: 1,
            name: 'CSS框',
            parts: { css: replaceWorkshopCss('', 'avatar', '.sully-chat-avatar-wrap::after{content:"";background:red}') },
        }), 'ai');
        const step1 = await prepareDecorationApplication(
            cssAiOnly,
            ['css'],
            [{ ...chars[0], chromeCustomCss: '', bubbleStyle: 'legacy-dual-bubble' }],
            base,
            [bubbleWithBothFrames],
            self,
            async () => bubbleOrigin,
        );
        expect(step1.bubbles).toHaveLength(1);
        expect(step1.bubbles[0].ai.avatarDecoration).toBeUndefined();
        expect(step1.bubbles[0].user.avatarDecoration).toBe('data:image/png;base64,AA==');
        expect(step1.bubbleOrigins.get(step1.bubbles[0].id)).toMatchObject({ kind: 'remix', credit: '气泡作者', allowRedistribute: false });

        // Reverse: applying a bubble with user.avatarDecoration clears user's CSS frame while keeping ai's CSS frame
        const userBubbleFrame: ChatTheme = {
            ...structuredClone(PRESET_THEMES.dream),
            user: { ...PRESET_THEMES.dream.user, avatarDecoration: 'data:image/png;base64,CC==' },
        };
        const bothCssChar = {
            ...chars[0],
            chromeCustomCss: [
                withAvatarFrameTarget(cssAiOnly, 'ai').parts.css,
                withAvatarFrameTarget(cssAiOnly, 'user').parts.css,
            ].join('\n'),
        };
        const step2 = await prepareDecorationApplication(preset(userBubbleFrame), ['bubbles'], [bothCssChar], base, [], self, readSelf);
        expect(step2.prepared[0].changes.character.chromeCustomCss).toContain('message-ai');
        expect(step2.prepared[0].changes.character.chromeCustomCss).not.toContain('message-user');
    });
});
