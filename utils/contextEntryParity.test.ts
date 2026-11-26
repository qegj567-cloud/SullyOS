import {buildHomeConversationPayload} from './homeConversation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterProfile, UserProfile } from '../types';
import { DB } from './db';
import { loadCharacterContextMessages, loadCharacterContextRange } from './chatContextRange';
import { buildChatRequestPayload } from './chatRequestPayload';
import { DatePrompts } from './datePrompts';
import * as palace from './memoryPalace/pipeline';

const userProfile = { name: '用户' } as UserProfile;
// Compare actual dialogue bodies, not internal event copies in projection metadata.
const markerNumbers = (messages: unknown): number[] => [...JSON.stringify(Array.isArray(messages)?messages.map(message=>message.content):messages).matchAll(/原文标记(\d+)结束/g)].map(match => Number(match[1]));

describe('以 ChatApp 实际发送链路为基准核对上下文', () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => vi.restoreAllMocks());

    it.each([
        { name: '自适应忽略残留的手动 10 条，允许超过 200 条', mode: 'adaptive', hwm: 20, limit: 10, from: 21 },
        { name: '手动 200 条跨过水位线，不只剩未总结的 26 条', mode: 'manual', hwm: 215, limit: 200, from: 42 },
        { name: '手动 10 条确实只发最近 10 条', mode: 'manual', hwm: 20, limit: 10, from: 232 },
        { name: '自适应范围内的用户断点继续收窄', mode: 'adaptive', hwm: 20, limit: 10, breakpoint: 232, from: 232 },
        { name: '手动范围内的用户断点继续收窄', mode: 'manual', hwm: 215, limit: 200, breakpoint: 232, from: 232 },
        { name: '自适应范围外的旧断点失效', mode: 'adaptive', hwm: 20, limit: 10, breakpoint: 19, from: 21 },
        { name: '手动范围外的旧断点失效', mode: 'manual', hwm: 215, limit: 200, breakpoint: 20, from: 42 },
        { name: '关闭全自动后的一键入宫水位跟随', mode: 'adaptive', hwm: 240, limit: 200, oneShot: true, from: 241 },
        { name: '没有水位跟随来源的残留 adaptive 字段按手动处理', mode: 'adaptive', hwm: 20, limit: 10, orphan: true, from: 232 },
    ] as const)('$name', async scenario => {
        const charId = `parity-${scenario.name}`;
        const ids: number[] = [];
        for (let n = 1; n <= 241; n++) {
            ids.push(await DB.saveMessage({
                charId, role: n % 2 ? 'user' : 'assistant', type: 'text',
                content: `原文标记${n}结束`, timestamp: 1700000000000 + n,
                metadata: n === 241 ? {source:'home',homeTurnId:'parity-turn'} : { source: n <= 20 ? 'chat' : n <= 200 ? 'date' : 'call' },
            }));
            if (n === 220) await DB.saveMessage({ charId, groupId: 'other-group', role: 'user', type: 'text', content: '群聊独立记录' });
        }
        const char: CharacterProfile = {
            memoryPalaceEnabled:true, id: charId, name: '角色', avatar: '', description: '', systemPrompt: '', memories: [],
            contextRangePolicyVersion: 1, contextRangeMode: scenario.mode, contextLimit: scenario.limit,
            autoArchiveEnabled: !('oneShot' in scenario || 'orphan' in scenario),
            contextFollowsMemoryPalaceHwm: 'oneShot' in scenario,
            contextUserStartMessageId: scenario.breakpoint !== undefined ? ids[scenario.breakpoint - 1] : undefined,
        };
        await DB.saveCharacter(char);
        localStorage.setItem(`mp_lastMsgId_${charId}`, String(ids[scenario.hwm - 1]));

        // 复现 useChatAI 的数据库读取和实际 payload 构建；旧 UI 缓存仍包含范围外消息。
        const chatRange = await loadCharacterContextRange(char);
        const allRows = await DB.getMessagesByCharId(charId, true);
        const expected = Array.from({ length: 242 - scenario.from }, (_, index) => index + scenario.from);
        const recall = vi.spyOn(palace, 'injectMemoryPalace');
        const chat = await buildChatRequestPayload({
            scene: 'chat.private',
            char, userProfile, groups: [], emojis: [], categories: [],
            historyMsgs: chatRange.messages, recentMsgsHint: allRows,
            contextLimit: Math.max(1, chatRange.messages.length),
            realtimeConfig: { weatherEnabled: false, newsEnabled: false } as any,
        });
        expect(markerNumbers(chat.cleanedApiMessages)).toEqual(expected);
        expect(markerNumbers(recall.mock.calls[0][1])).toEqual(expected);

        const dateRows = await loadCharacterContextMessages(charId);
        expect(dateRows.map(message => message.id)).toEqual(chatRange.messages.map(message => message.id));
        for (const variant of ['send', 'reroll'] as const) {
            const date = await DatePrompts.buildSessionPayload({
                char, userProfile, allMsgs: dateRows, emojis: [],
                userText: dateRows.at(-1)!.content, variant,
            });
            expect(markerNumbers(date.messages)).toEqual(expected);
        }
        expect(markerNumbers((await DatePrompts.buildPeekPayload({ char, userProfile, allMsgs: dateRows, emojis: [] })).messages)).toEqual(expected);
        const home=await buildHomeConversationPayload({char,user:userProfile,api:{} as any,scene:{roomId:'r',roomName:'客厅',present:true,actions:[]} as any,records:[{id:'parity-turn',turnId:'parity-turn',actor:'user',kind:'message',source:'user',text:'原文标记241结束',at:1700000000241,roomId:'r',roomName:'客厅'}],signal:new AbortController().signal});
        expect(markerNumbers(home.slice(1))).toEqual(expected);
        expect(markerNumbers(recall.mock.calls.at(-1)![1])).toEqual(expected);
    });

    it('一键入宫后暂无新原文时，旧 UI 缓存不进入召回和世界书扫描', async () => {
        const char = {
            id: 'parity-empty', name: '角色', contextRangePolicyVersion: 1,
            contextRangeMode: 'adaptive', contextFollowsMemoryPalaceHwm: true,
            mountedWorldbooks: [{ id: 'hidden-keyword', title: '关键词条目', category: '测试', constant: false, key: ['原文标记1结束'], content: '被隐藏消息触发的世界书正文' }],
        } as CharacterProfile;
        const id = await DB.saveMessage({ charId: char.id, role: 'user', type: 'text', content: '原文标记1结束' });
        localStorage.setItem(`mp_lastMsgId_${char.id}`, String(id));
        const rows = await loadCharacterContextMessages(char);
        const recall = vi.spyOn(palace, 'injectMemoryPalace');
        const chat = await buildChatRequestPayload({
            scene: 'chat.private',
            char, userProfile, groups: [], emojis: [], categories: [], historyMsgs: rows,
            recentMsgsHint: await DB.getMessagesByCharId(char.id, true), contextLimit: 1,
            realtimeConfig: { weatherEnabled: false, newsEnabled: false } as any,
        });
        expect(chat.cleanedApiMessages).toEqual([]);
        expect(recall.mock.calls[0][1]).toEqual([]);
        expect(JSON.stringify(chat.fullMessages)).not.toContain('被隐藏消息触发的世界书正文');
        expect(markerNumbers((await DatePrompts.buildPeekPayload({ char, userProfile, allMsgs: rows, emojis: [] })).messages)).toEqual([]);
        const manual = await buildChatRequestPayload({
            scene: 'chat.private',
            char: { ...char, contextRangeMode: 'manual', contextLimit: 10 },
            userProfile, groups: [], emojis: [], categories: [],
            historyMsgs: await DB.getMessagesByCharId(char.id, true), contextLimit: 10,
            realtimeConfig: { weatherEnabled: false, newsEnabled: false } as any,
        });
        expect(JSON.stringify(manual.fullMessages)).toContain('被隐藏消息触发的世界书正文');
    });
});
