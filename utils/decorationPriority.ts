import type { CharacterProfile, OSTheme } from '../types';
import { embeddedWhiteboxParts, withdrawWhiteboxParts, type WhiteboxPart } from './whiteboxParts';
import { stripWhiteboxSoundDirective } from './whiteboxSound';

type Appearance = Partial<CharacterProfile & OSTheme>;
const fields: Partial<Record<keyof Appearance, WhiteboxPart>> = {
    bubbleStyle:'bubbles', chatDefaultBubbleStyle:'bubbles', chatBackground:'background', chatBackgroundStyle:'background',
    thinkingChainStyle:'psyche', thinkingChainCustomCss:'psyche', thinkingChainCustomColors:'psyche', chatPsyche:'psyche',
    chatProfileAppearance:'profile', dateAppearance:'date', storyAppearance:'story', scheduleCardAppearance:'schedule', journalAppearance:'journal',
};
const layoutField = /^chat(?:Avatar|Header|Bubble(?:Font|Line|Indent|Style)|MessageSpacing|ShowTimestamp|Timestamp|SnapToEdge|ModuleAlign|EmojiSize|InputStyle|ChromeStyle|StatusStyle|SendButtonStyle|HideHeaderBuffs)/;

/** Derive a write from an explicit UI selection. Prepared outfit writes supply the selected parts as a unit. */
export function decorationSelection(
    previous: Appearance, patch: Appearance, scope: 'global'|'character',
    selected?: readonly WhiteboxPart[], incomingCss?: string,
): Appearance {
    const key = scope === 'global' ? 'chatChromeCustomCss' : 'chromeCustomCss';
    if (!selected && ('id' in patch || 'chatIndependentParts' in patch || (key in patch && Object.keys(patch).length > 1))) return patch;
    const before = previous[key] || '';
    const changedCss = incomingCss ?? (key in patch && stripWhiteboxSoundDirective(before).trim() !== stripWhiteboxSoundDirective(patch[key]).trim() ? patch[key] || '' : undefined);
    const chosen = new Map<WhiteboxPart, boolean>();
    if (selected) {
        selected.forEach(part=>chosen.set(part,true));
    } else {
        for (const field of Object.keys(patch) as (keyof Appearance)[]) {
            const part=fields[field];
            if (part) chosen.set(part, chosen.get(part) || patch[field] !== undefined);
            else if (layoutField.test(field)) chosen.set('layout',true);
        }
        if (patch.chatFineTune) chosen.set('layout',patch.chatFineTune.enabled !== false);
        if (patch.chatAppearance && !patch.chatFineTune && 'chatBackgroundStyle' in patch.chatAppearance) chosen.set('background',true);
    }
    if (!chosen.size && changedCss === undefined) return patch;
    const result={...patch};
    const embedded = changedCss ? embeddedWhiteboxParts(changedCss) : new Set<WhiteboxPart>();
    // A CSS-only whitebox needs the factory rendering underneath, otherwise old tails, overlays and images survive.
    if (embedded.has('bubbles') && !chosen.has('bubbles')) {
        if (scope==='global') result.chatDefaultBubbleStyle='default'; else result.bubbleStyle='default';
    }
    if (embedded.has('psyche') && !chosen.has('psyche')) {
        if (scope==='global') result.chatPsyche={styleId:'echo'};
        else Object.assign(result,{thinkingChainStyle:'echo',thinkingChainCustomCss:'',thinkingChainCustomColors:undefined});
    }
    if (embedded.has('background') && !chosen.has('background')) {
        result.chatBackground='';
        if (scope==='global') result.chatBackgroundStyle='plain';
        else result.chatAppearance={...previous.chatAppearance,...result.chatAppearance,chatBackgroundStyle:'plain'};
    }
    if (embedded.has('profile') && !chosen.has('profile')) result.chatProfileAppearance={customCss:''};
    // When the fields and CSS come from one outfit they work together. Only retire *earlier* CSS.
    const remove = [...chosen.keys()].filter(part=>!embedded.has(part));
    const current = result[key] ?? before;
    const clean = withdrawWhiteboxParts(current,remove);
    if (clean !== current) result[key]=clean;
    if (scope==='character') {
        const independent=new Set(Array.isArray(previous.chatIndependentParts)?previous.chatIndependentParts:[]);
        const following=new Set(Array.isArray(previous.chatFollowWhiteboxParts)?previous.chatFollowWhiteboxParts:[]);
        for(const [part,enabled] of chosen){
            if(!enabled && previous.chatDecorationCssIsolated)following.add(part);
            else following.delete(part);
        }
        for(const part of embedded)following.delete(part);
        if(following.size || previous.chatFollowWhiteboxParts)result.chatFollowWhiteboxParts=[...following];
        for (const [part,enabled] of chosen) { if (enabled) independent.add(part); else independent.delete(part); }
        for (const part of embedded) independent.add(part);
        // Also marks prepared writes so derived layout/audio fields aren't mistaken for another selection.
        if (selected || independent.size || previous.chatIndependentParts) result.chatIndependentParts=[...independent];
    }
    return result;
}
