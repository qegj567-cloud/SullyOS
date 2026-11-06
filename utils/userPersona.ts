import type { CharacterProfile, UserProfile } from '../types';
export interface CharacterUserPersona { name?: string; appearance?: string; supplement?: string }
const resolved = Symbol('character-user');
export function resolveCharacterUser(user: UserProfile, char: Pick<CharacterProfile, 'userPersona'>): UserProfile {
    const p = char.userPersona;
    if (!p || (user as any)[resolved] === p) return user;
    const result = { ...user, name: p.name?.trim() || user.name,
        bio: [user.bio, p.appearance?.trim() && `在 TA 面前的外貌：${p.appearance.trim()}`, p.supplement?.trim() && `补充设定：${p.supplement.trim()}`,
            '以上属于同一个用户的资料补充，沿用原有经历与关系；不要把未告知的设定当作你已知的事实。'].filter(Boolean).join('\n') };
    Object.defineProperty(result, resolved, { value: p });
    return result;
}
