import { describe, it, expect } from 'vitest';
import { ContextBuilder } from './context';
import type { CharacterProfile, MountedWorldbook, UserProfile } from '../types';

const sharedBook: MountedWorldbook = {
    id: 'shared',
    title: '青梅竹马',
    content: '{{char}}和{{user}}从小一起长大。',
    category: '测试',
};
const member = (id: string, name: string, books: MountedWorldbook[]): CharacterProfile => ({
    id, name, avatar: '', description: '', systemPrompt: '', memories: [], mountedWorldbooks: books,
} as CharacterProfile);
const user = { name: '小明', bio: '' } as UserProfile;

describe('群聊共有世界书', () => {
    it('{{char}} 换成挂了这条的成员名，不原样发出去', () => {
        const scene = ContextBuilder.buildGroupSharedScene([
            member('a', '阿澈', [sharedBook]),
            member('b', '小白', [sharedBook]),
            member('c', '路人甲', []),
        ], user, [], 'group.groupChat');
        expect(scene.sharedWorldbookIds.has('shared')).toBe(true);
        expect(scene.text).toContain('阿澈、小白和小明从小一起长大。');
        expect(scene.text).not.toContain('{{char}}');
        expect(scene.text).not.toContain('路人甲');
    });
});
