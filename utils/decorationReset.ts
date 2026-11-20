import type { CharacterProfile, ChatTheme, OSTheme } from '../types';
import type { BeautyCategory } from './beautyCategories';
import { decorationSelection } from './decorationPriority';
import { type WhiteboxPart } from './whiteboxParts';
import { LAYOUT_DEFAULTS, resolveDecorationTheme } from './chatDecoration';
import { replaceWorkshopCss } from './decorationWorkshop';
import { resolveActiveSound, stripWhiteboxSoundDirective } from './whiteboxSound';

/** Explicit defaults override inherited global settings; saved presets remain intact. */
export function resetChatDecoration(category: BeautyCategory, char: CharacterProfile, theme: OSTheme, activeBubble: ChatTheme) {
    const character: Partial<CharacterProfile> = {};
    let bubble: ChatTheme | undefined;
    const effectiveCss = stripWhiteboxSoundDirective([resolveDecorationTheme(theme,char).chatChromeCustomCss, char.chromeCustomCss].filter(Boolean).join('\n'));
    if (category === 'avatar' || category === 'background') {
        character.chatSound = resolveActiveSound(char.chromeCustomCss, char.chatSound, theme.chatChromeCustomCss, theme.chatSound) || { src: 'none' };
        character.chatSoundBound = false;
    }
    if (category === 'avatar') {
        bubble = structuredClone(activeBubble);
        bubble.id = 'decoration-reset-' + crypto.randomUUID();
        bubble.name += '（无头像框）';
        bubble.type = 'custom';
        for (const side of ['user', 'ai'] as const) {
            delete bubble[side].avatarDecoration;
            delete bubble[side].avatarDecorationX;
            delete bubble[side].avatarDecorationY;
            delete bubble[side].avatarDecorationScale;
            delete bubble[side].avatarDecorationRotate;
        }
        character.bubbleStyle = bubble.id;
        character.chromeCustomCss = replaceWorkshopCss(effectiveCss, 'avatar', '');
        character.chatDecorationCssIsolated = true;
    } else if (category === 'bubbles') {
        character.bubbleStyle = 'default';
    } else if (category === 'background') {
        character.chatBackground = '';
        character.chatAppearance = { ...char.chatAppearance, chatBackgroundStyle: 'plain' };
        character.chromeCustomCss = replaceWorkshopCss(effectiveCss, 'background', '');
        character.chatDecorationCssIsolated = true;
    } else if (category === 'sound') {
        character.chromeCustomCss = stripWhiteboxSoundDirective(char.chromeCustomCss || '');
        character.chatSound = { src: 'none' };
        character.chatSoundBound = false;
    } else if (category === 'profile') {
        character.chatProfileAppearance = {customCss:''};
    } else if (category === 'psyche') {
        character.thinkingChainStyle = 'echo';
        character.thinkingChainCustomCss = '';
        character.thinkingChainCustomColors = undefined;
    } else if (category === 'whitebox') {
        character.chromeCustomCss = '';
        character.chatDecorationCssIsolated = true;
        character.chatAppearance = { ...LAYOUT_DEFAULTS, chatBackgroundStyle: char.chatAppearance?.chatBackgroundStyle };
        character.chatFineTune = { enabled: true };
        character.chatSound = resolveActiveSound(char.chromeCustomCss, char.chatSound, theme.chatChromeCustomCss, theme.chatSound) || { src: 'none' };
        character.chatSoundBound = false;
    }
    const parts: WhiteboxPart[] = category === 'avatar' ? ['avatar:user','avatar:ai'] : ['background','bubbles','profile','psyche'].includes(category) ? [category as WhiteboxPart] : [];
    return { character: decorationSelection(char,character,'character',parts,''), bubble };
}
