import type {ChatTheme} from '../types';

export const avatarFields = ['avatarDecoration', 'avatarDecorationX', 'avatarDecorationY', 'avatarDecorationScale', 'avatarDecorationRotate'] as const;
export function keepBubbleFrames(next: ChatTheme, previous?: ChatTheme, replaced: readonly ('user'|'ai')[] = []): ChatTheme {
    if (!previous) return next;
    const result=structuredClone(next);
    for (const side of ['user','ai'] as const) {
        if(replaced.includes(side) || result[side].avatarDecoration || !previous[side].avatarDecoration) continue;
        const target=result[side];
        for(const field of avatarFields) {
            const value=previous[side][field];
            if(value!==undefined) Object.assign(target,{[field]:value});
        }
    }
    return result;
}
