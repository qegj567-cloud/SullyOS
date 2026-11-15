import { useCallback, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { parseWhiteboxSound, playWhiteboxSound, resolveActiveSound } from '../utils/whiteboxSound';
import { resetRecalledSoundSettings } from '../utils/recalledNotificationSound';

/** Repairs only the setting used for this playback, using the latest state after
 * the async fingerprint check. Switching chats cannot reset the new chat. */
export function useChatNotificationSound() {
    const os = useOS();
    const current = useRef(os);
    current.current = os;
    return useCallback((kind: 'character' | 'group', id: string) => {
        const context = current.current;
        const target = kind === 'character' ? context.characters.find(c => c.id === id) : context.groups.find(g => g.id === id);
        if (!target) return;
        const localSound = parseWhiteboxSound(target.chromeCustomCss) || (target.chatSound?.src ? target.chatSound : null);
        const sound = resolveActiveSound(target.chromeCustomCss, target.chatSound, context.theme.chatChromeCustomCss, context.theme.chatSound);
        playWhiteboxSound(sound, { onBlocked: async src => {
            const latest = current.current;
            if (!localSound) {
                const active = resolveActiveSound(undefined, undefined, latest.theme.chatChromeCustomCss, latest.theme.chatSound);
                if (active?.src !== src) return;
                const patch = resetRecalledSoundSettings(latest.theme, src, true);
                if (patch) await latest.updateTheme(patch);
            } else if (kind === 'character') {
                latest.updateCharacter(id, character => {
                    if (resolveActiveSound(character.chromeCustomCss, character.chatSound)?.src !== src) return {};
                    return resetRecalledSoundSettings(character, src) || {};
                });
            } else {
                const group = latest.groups.find(g => g.id === id);
                if (!group || resolveActiveSound(group.chromeCustomCss, group.chatSound)?.src !== src) return;
                const patch = resetRecalledSoundSettings(group, src);
                if (patch) await latest.updateGroup(id, patch);
            }
        } });
    }, []);
}
