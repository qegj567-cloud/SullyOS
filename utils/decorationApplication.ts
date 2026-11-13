import type { CharacterProfile, ChatTheme, OSTheme } from '../types';
import { hasAvatarFrameCss, readAvatarFrameSlots, setAvatarFrameSlot } from './avatarFrameTarget';
import { decorationPatches, readBubbleDecoration, validateBubble, validateDecoration, type DecorationPart, type DecorationPreset } from './chatDecoration';
import { migrateChatThemeBlobRefs } from './blobRef';
import { remixOrigin, type DecorationOrigin } from './decorationLibrary';
import { resolveActiveSound, stripWhiteboxSoundDirective } from './whiteboxSound';

const avatarFields = ['avatarDecoration', 'avatarDecorationX', 'avatarDecorationY', 'avatarDecorationScale', 'avatarDecorationRotate'] as const;
const stable = (value: any): any => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const originKey = (origin: DecorationOrigin) => JSON.stringify(stable(origin));
const bubbleKey = (bubble: ChatTheme) => JSON.stringify(validateBubble(bubble));

/** Prepare first; install each distinct bubble once, then assign the shared ID to every target. */
export async function prepareDecorationApplication(
    preset: DecorationPreset,
    parts: DecorationPart[],
    targets: CharacterProfile[],
    theme: OSTheme,
    availableBubbles: ChatTheme[],
    origin: DecorationOrigin,
    readBubbleOrigin: (id: string) => Promise<DecorationOrigin>,
) {
    const validated = validateDecoration(preset);
    const bubbles: ChatTheme[] = [];
    const bubbleOrigins = new Map<string, DecorationOrigin>();
    const prepared: { character: CharacterProfile; changes: Awaited<ReturnType<typeof decorationPatches>> }[] = [];
    const selected = new Map<string, ChatTheme>();
    const strippedBubbles = new Map<string, ChatTheme>();
    const portable = new Map<string, Promise<ChatTheme>>();
    const retainedFrames = new Map<string, Promise<ChatTheme>>();
    const origins = new Map<string, Promise<DecorationOrigin>>();
    const getOrigin = (id: string) => {
        if (!origins.has(id)) origins.set(id, readBubbleOrigin(id));
        return origins.get(id)!;
    };
    const portableBubble = (bubble: ChatTheme) => {
        if (!portable.has(bubble.id)) portable.set(bubble.id, readBubbleDecoration(bubble).then(p => p.parts.bubbles!));
        return portable.get(bubble.id)!;
    };
    const sourceOrigin = originKey(origin);
    const bubbleOnly = !validated.parts.css && !validated.parts.layout;
    const incomingCssFrames = parts.includes('css') && hasAvatarFrameCss(validated) ? readAvatarFrameSlots(validated.parts.css || '') : null;
    const cssFrameSides = incomingCssFrames ? (['user', 'ai'] as const).filter(side => Boolean(incomingCssFrames.shared || incomingCssFrames[side])) : [];
    for (const character of targets) {
        // CSS, sounds and background preservation are still computed separately for each character.
        const changes = await decorationPatches(validated, parts.filter(part => part !== 'bubbles'), 'character', character, theme);
        const previous = availableBubbles.find(b => b.id === (character.bubbleStyle || theme.chatDefaultBubbleStyle));
        if (parts.includes('bubbles') && validated.parts.bubbles) {
            let desired = structuredClone(validated.parts.bubbles);
            const incomingBubbleFrameSides = (['user', 'ai'] as const).filter(side => Boolean(desired[side].avatarDecoration));
            if (bubbleOnly && previous && (['user', 'ai'] as const).some(side => !desired[side].avatarDecoration && previous[side].avatarDecoration)) {
                for (const side of ['user', 'ai'] as const) {
                    if (!desired[side].avatarDecoration && previous[side].avatarDecoration) {
                        for (const field of avatarFields) (desired[side] as any)[field] = previous[side][field];
                    }
                }
                // Resolve only the retained frames, not unrelated images in the old bubble.
                if (!retainedFrames.has(previous.id)) retainedFrames.set(previous.id, readBubbleDecoration(desired).then(p => p.parts.bubbles!));
                desired = await retainedFrames.get(previous.id)!;
            }
            // Prevent a legacy bubble-embedded frame and an existing CSS frame from stacking on the same side.
            if (bubbleOnly && incomingBubbleFrameSides.length > 0) {
                const effectiveCss = [character.chatDecorationCssIsolated ? '' : theme.chatChromeCustomCss, character.chromeCustomCss].filter(Boolean).join('\n');
                const existingCssSlots = readAvatarFrameSlots(effectiveCss);
                if (incomingBubbleFrameSides.some(side => Boolean(existingCssSlots.shared || existingCssSlots[side]))) {
                    let nextCss = stripWhiteboxSoundDirective(effectiveCss);
                    for (const side of incomingBubbleFrameSides) nextCss = setAvatarFrameSlot(nextCss, side, '');
                    changes.character.chromeCustomCss = nextCss;
                    changes.character.chatDecorationCssIsolated = true;
                    changes.character.chatSound = resolveActiveSound(character.chromeCustomCss, character.chatSound, theme.chatChromeCustomCss, theme.chatSound) || { src: 'none' };
                    changes.character.chatSoundBound = false;
                }
            }
            const signature = bubbleKey(desired);
            let installed = selected.get(signature);
            if (!installed) {
                // Match complete visual content and provenance, never names or imported IDs alone.
                for (const candidate of availableBubbles) {
                    if (candidate.name !== desired.name) continue;
                    try {
                        if (bubbleKey(await portableBubble(candidate)) !== signature) continue;
                        if (originKey(await getOrigin(candidate.id)) !== sourceOrigin) continue;
                        installed = candidate;
                        break;
                    } catch { /* A broken old preset must not block installing a valid work. */ }
                }
                if (!installed) {
                    installed = await migrateChatThemeBlobRefs({ ...desired, id: 'decoration-' + crypto.randomUUID(), type: 'custom' });
                    bubbles.push(installed);
                    bubbleOrigins.set(installed.id, origin);
                }
                selected.set(signature, installed);
            }
            changes.character.bubbleStyle = installed.id;
        } else if (!parts.includes('bubbles') && previous && cssFrameSides.some(side => Boolean(previous[side].avatarDecoration))) {
            // Strip any legacy bubble-embedded frame on the side(s) now receiving a CSS avatar frame.
            const stripKey = `${previous.id}:${cssFrameSides.join(',')}`;
            let stripped = strippedBubbles.get(stripKey);
            if (!stripped) {
                const copy = structuredClone(previous);
                for (const side of cssFrameSides) for (const field of avatarFields) delete (copy[side] as any)[field];
                stripped = await migrateChatThemeBlobRefs({ ...copy, id: 'decoration-' + crypto.randomUUID(), type: 'custom' });
                strippedBubbles.set(stripKey, stripped);
                bubbles.push(stripped);
                bubbleOrigins.set(stripped.id, remixOrigin(await getOrigin(previous.id)));
            }
            changes.character.bubbleStyle = stripped.id;
        }
        prepared.push({ character, changes });
    }
    return { prepared, bubbles, bubbleOrigins };
}
