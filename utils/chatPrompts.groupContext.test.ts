import { describe, it, expect, vi } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';
import { setCharNameRegistry, getCharNameById } from './charNameRegistry';

// 群聊背景注入的发言人标注：之前所有角色发言（包括收到注入的角色自己）都被匿名成
// "Member"，私聊被问起群里的事时角色分不清谁说了什么、认不出自己的发言。
// 修复后：user 显示用户名，注入对象自己的发言标「你（名字）」，其他成员经
// charNameRegistry 解析出真实名字，查不到的兜底「群友」。

const charA = { id: 'char-a', name: '阿一' } as any;
const userProfile = { name: '条条' } as any;
const groups = [{ id: 'g-test', name: '深夜茶话会', members: ['char-a', 'char-b'] }] as any;

describe('群聊背景注入 · 发言人真实标注', () => {
    it('charNameRegistry 基本行为', () => {
        setCharNameRegistry([{ id: 'x', name: '小明' }]);
        expect(getCharNameById('x')).toBe('小明');
        expect(getCharNameById('missing')).toBeNull();
        expect(getCharNameById(null)).toBeNull();
    });

    it('注入块标注：用户名 / 你（自己） / 真实成员名 / 未知兜底群友', async () => {
        setCharNameRegistry([
            { id: 'char-a', name: '阿一' },
            { id: 'char-b', name: '阿二' },
        ]);
        await DB.saveMessage({ charId: 'user', groupId: 'g-test', role: 'user', type: 'text', content: '今晚吃火锅吗' } as any);
        await DB.saveMessage({ charId: 'char-a', groupId: 'g-test', role: 'assistant', type: 'text', content: '我要毛肚' } as any);
        await DB.saveMessage({ charId: 'char-b', groupId: 'g-test', role: 'assistant', type: 'text', content: '加宽粉' } as any);
        await DB.saveMessage({ charId: 'char-ghost', groupId: 'g-test', role: 'assistant', type: 'text', content: '幽灵发言' } as any);

        const parts = await ChatPrompts.buildSystemPromptParts(
            charA, userProfile, groups, [], [], [],
        );
        const injected = parts.volatileState;

        expect(injected).toContain('你亲历的近期群聊');
        expect(injected).toContain('条条: 今晚吃火锅吗');
        expect(injected).toContain('你（阿一）: 我要毛肚');
        expect(injected).toContain('阿二: 加宽粉');
        expect(injected).toContain('群友: 幽灵发言');
        expect(injected).not.toContain('Member');
    });
});

// 每次私聊回复都要拼群聊背景，每个群只用得上最后几十条。
// 钉住：进提示词的消息与全量读法逐条相同（含顺序），且不把整群读出来。
describe('群聊背景注入 · 每个群只读用得上的尾部', () => {
    it('与「读全量 → 过归档线 → 取尾部 → 按时间排」逐条相同，且不调用全量读取', async () => {
        const seedGroup = async (groupId: string, total: number, timestampOf: (i: number) => number) => {
            const ids: number[] = [];
            for (let i = 0; i < total; i++) {
                ids.push(await DB.saveMessage({
                    charId: i % 2 ? 'char-a' : 'user', groupId, role: i % 2 ? 'assistant' : 'user',
                    type: 'text', content: `${groupId}#${i}`, timestamp: timestampOf(i),
                } as any));
            }
            return ids;
        };
        // 归档线压在尾部窗口里：最后 5 条中只有 3 条过线。
        const archivedIds = await seedGroup('g-archived', 30, i => 10_000 + i * 10);
        // 时间戳与写入顺序相反：尾部按 id 取，取完才按时间排。
        await seedGroup('g-reversed', 12, i => 20_000 - i * 10);
        // 不设条数时默认 80 条。
        await seedGroup('g-default', 85, i => 30_000 + i * 7);
        const tailGroups = [
            { id: 'g-archived', name: '归档群', members: ['char-a'], privateContextCap: 5, archivedThroughMessageId: archivedIds[26] },
            { id: 'g-reversed', name: '倒序群', members: ['char-a'], privateContextCap: 8 },
            { id: 'g-default', name: '默认群', members: ['char-a'] },
            { id: 'g-test', name: '别人的群', members: ['char-b'] },
        ] as any;

        const expected: { content: string; timestamp: number }[] = [];
        for (const g of tailGroups.filter((g: any) => g.members.includes('char-a'))) {
            const all = await DB.getGroupMessages(g.id);
            expected.push(...all.filter(m => m.id > (g.archivedThroughMessageId || 0)).slice(-(g.privateContextCap ?? 80)));
        }
        expected.sort((a, b) => a.timestamp - b.timestamp);
        expect(expected).toHaveLength(3 + 8 + 80);

        const fullRead = vi.spyOn(DB, 'getGroupMessages');
        const parts = await ChatPrompts.buildSystemPromptParts(charA, userProfile, tailGroups, [], [], []);
        expect(fullRead).not.toHaveBeenCalled();
        fullRead.mockRestore();

        const injected = parts.volatileState.split('\n')
            .filter(line => line.includes('] [群：'))
            .map(line => line.slice(line.lastIndexOf(': ') + 2));
        expect(injected).toEqual(expected.map(m => m.content));
    });
});
