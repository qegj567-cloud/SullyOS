import { expect, it } from 'vitest';
import { ContextBuilder } from './context';
import { buildFreeRoamSystemPrompt } from './xhsFreeRoam';
import type { CharacterProfile, UserProfile, XhsActivityRecord } from '../types';

it('自由活动保留可读的过往活动，同时在请求层按角色和深度加载世界书', async () => {
    const char = {
        id: 'c', name: 'C', systemPrompt: '角色设定',
        mountedWorldbooks: [{ id: 'wb', title: '设定', content: '活动世界书', constant: true, position: 4, depth: 0, role: 2 }],
    } as CharacterProfile;
    const input = buildFreeRoamSystemPrompt(char, { name: 'U' } as UserProfile, '聊天摘要', [{
        timestamp: 1, actionType: 'post', content: { title: '上次发的帖子' }, result: 'success',
    } as XhsActivityRecord]);
    expect(input.instructions).toContain('上次发的帖子');
    expect(input.instructions).not.toContain('[object Object]');
    expect(input.instructions).not.toContain('活动世界书');
    const messages = (await ContextBuilder.buildCharacterRequest({ ...input, scene: 'apps.freeRoam' }, [{ role: 'user', content: '今天想做什么？' }]));
    expect(messages[messages.length - 1]).toEqual({ role: 'assistant', content: '活动世界书' });
    expect(JSON.stringify(messages).split('活动世界书')).toHaveLength(2);
});
