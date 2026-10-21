import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message } from '../types';
import {
    computeContextRangeSnapshot,
    loadCharacterContextMessageIds,
    loadCharacterContextRange,
    migrateCharacterContextRange,
} from './chatContextRange';
import { DB } from './db';
import { setReliableMemoryPalaceHighWaterMark } from './memoryPalace/highWaterMark';

const makeMessages = (from: number, to: number): Message[] =>
    Array.from({ length: to - from + 1 }, (_, index) => {
        const id = from + index;
        return {
            id,
            charId: 'char-context',
            role: id % 2 ? 'user' : 'assistant',
            type: 'text',
            content: `message-${id}`,
            timestamp: id,
        } as Message;
    });

const makeChar = (partial: Partial<CharacterProfile>): CharacterProfile => ({
    id: 'char-context',
    name: 'Context',
    avatar: '',
    description: '',
    systemPrompt: '',
    memories: [],
    contextRangePolicyVersion: 1,
    ...partial,
});

describe('AI 原文范围边界', () => {
    it('自适应最大范围从水位线之后开始', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({ autoArchiveEnabled: true, contextRangeMode: 'adaptive', contextLimit: 5000 }),
            800,
        );

        expect(snapshot.maxRangeStartMessageId).toBe(801);
        expect(snapshot.effectiveStartMessageId).toBe(801);
        expect(snapshot.messages[0].id).toBe(801);
        expect(snapshot.messages.at(-1)?.id).toBe(1000);
    });

    it('一键入宫后即使没开全自动，也会从水位线之后读取且当前可为 0 条', () => {
        const messages = makeMessages(1, 1000);
        const snapshot = computeContextRangeSnapshot(
            messages,
            makeChar({
                memoryPalaceEnabled: true,
                autoArchiveEnabled: false,
                contextRangeMode: 'adaptive',
                contextFollowsMemoryPalaceHwm: true,
            }),
            1000,
        );

        expect(snapshot.mode).toBe('adaptive');
        expect(snapshot.maxRangeStartMessageId).toBeUndefined();
        expect(snapshot.messages).toHaveLength(0);
    });

    it('选择保留最近 10 条时，水位线后的原文与橙色范围精确为 10 条', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({
                memoryPalaceEnabled: true,
                autoArchiveEnabled: false,
                contextRangeMode: 'adaptive',
                contextFollowsMemoryPalaceHwm: true,
            }),
            990,
        );

        expect(snapshot.maxRangeStartMessageId).toBe(991);
        expect(snapshot.messages).toHaveLength(10);
        expect(snapshot.messages[9].id).toBe(1000);
    });

    it('范围内用户断点只能把起点向更新消息推进', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'adaptive',
                contextUserStartMessageId: 900,
            }),
            800,
        );

        expect(snapshot.maxRangeStartMessageId).toBe(801);
        expect(snapshot.userStartMessageId).toBe(900);
        expect(snapshot.effectiveStartMessageId).toBe(900);
        expect(snapshot.messages[0].id).toBe(900);
    });

    it('用户断点恰好位于最大范围起点时有效且没有越界', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'manual',
                contextLimit: 500,
                contextUserStartMessageId: 501,
            }),
            800,
        );

        expect(snapshot.userBreakpointExpired).toBe(false);
        expect(snapshot.effectiveStartMessageId).toBe(501);
        expect(snapshot.messages).toHaveLength(500);
    });

    it('水位线之前的用户断点不能突破自适应最大范围', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'adaptive',
                contextUserStartMessageId: 700,
            }),
            800,
        );

        expect(snapshot.userBreakpointExpired).toBe(true);
        expect(snapshot.userStartMessageId).toBeUndefined();
        expect(snapshot.effectiveStartMessageId).toBe(801);
        expect(snapshot.messages[0].id).toBe(801);
    });

    it('手动拉杆忽略水位线并把最近 N 条作为最大范围', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'manual',
                contextLimit: 500,
            }),
            800,
        );

        expect(snapshot.maxRangeStartMessageId).toBe(501);
        expect(snapshot.effectiveStartMessageId).toBe(501);
        expect(snapshot.messages).toHaveLength(500);
    });

    it('拉杆范围外的旧断点失效，绝不会扩大范围', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1000),
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'manual',
                contextLimit: 500,
                contextUserStartMessageId: 300,
            }),
            800,
        );

        expect(snapshot.userBreakpointExpired).toBe(true);
        expect(snapshot.effectiveStartMessageId).toBe(501);
        expect(snapshot.messages[0].id).toBe(501);
    });

    it('新消息把拉杆起点推过固定断点后，固定断点失效并跟随拉杆', () => {
        const snapshot = computeContextRangeSnapshot(
            makeMessages(1, 1200),
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'manual',
                contextLimit: 500,
                contextUserStartMessageId: 700,
            }),
            800,
        );

        expect(snapshot.maxRangeStartMessageId).toBe(701);
        expect(snapshot.userBreakpointExpired).toBe(true);
        expect(snapshot.effectiveStartMessageId).toBe(701);
    });

    it('作为断点的消息被删除后断点失效，不能停在不存在的 ID 上', () => {
        const messages = makeMessages(1, 1000).filter(message => message.id !== 800);
        const snapshot = computeContextRangeSnapshot(
            messages,
            makeChar({
                autoArchiveEnabled: true,
                contextRangeMode: 'manual',
                contextLimit: 500,
                contextUserStartMessageId: 800,
            }),
            700,
        );

        expect(snapshot.userBreakpointExpired).toBe(true);
        expect(snapshot.userStartMessageId).toBeUndefined();
        expect(snapshot.messages[0].id).toBe(500);
    });
});

describe('旧角色上下文迁移', () => {
    it('全自动用户即使原来拉满 5000 条也回到自适应默认', () => {
        const result = migrateCharacterContextRange(makeChar({
            contextRangePolicyVersion: undefined,
            autoArchiveEnabled: true,
            contextLimit: 5000,
            hideBeforeMessageId: 600,
        }));

        expect(result.migrated).toBe(true);
        expect(result.resetAutoContext).toBe(true);
        expect(result.character.contextRangeMode).toBe('adaptive');
        expect(result.character.contextLimit).toBe(500);
        expect(result.character.contextUserStartMessageId).toBeUndefined();
    });

    it('未开全自动的旧用户保留拉杆，并把旧用户断点迁入新字段', () => {
        const result = migrateCharacterContextRange(makeChar({
            contextRangePolicyVersion: undefined,
            autoArchiveEnabled: false,
            contextLimit: 300,
            hideBeforeMessageId: 250,
        }));

        expect(result.character.contextRangeMode).toBe('manual');
        expect(result.character.contextLimit).toBe(300);
        expect(result.character.contextUserStartMessageId).toBe(250);
    });

    it('新字段会随角色设置 JSON 备份往返保留', () => {
        const original = makeChar({
            autoArchiveEnabled: true,
            contextRangeMode: 'manual',
            contextLimit: 1200,
            contextUserStartMessageId: 321,
            contextFollowsMemoryPalaceHwm: true,
        });
        const restored = JSON.parse(JSON.stringify(original)) as CharacterProfile;

        expect(restored.contextRangePolicyVersion).toBe(1);
        expect(restored.contextRangeMode).toBe('manual');
        expect(restored.contextLimit).toBe(1200);
        expect(restored.contextUserStartMessageId).toBe(321);
        expect(restored.contextFollowsMemoryPalaceHwm).toBe(true);
    });

    it('localStorage 被清空时，loadCharacterContextRange 兜底从 IndexedDB 水位线恢复，不读全量历史', async () => {
        await DB.clearMessages('char-hwm-fallback');
        const total = 50;
        let hwmId = 0;
        for (let i = 1; i <= total; i++) {
            const id = await DB.saveMessage({
                charId: 'char-hwm-fallback',
                role: i % 2 ? 'user' : 'assistant',
                type: 'text',
                content: `msg-${i}`,
                timestamp: 1000 + i,
            });
            if (i === 40) hwmId = id;
        }
        await setReliableMemoryPalaceHighWaterMark('char-hwm-fallback', hwmId);

        // 模拟大退重开后 localStorage 被系统清空，但 IndexedDB 仍在
        localStorage.removeItem('mp_lastMsgId_char-hwm-fallback');

        const char = makeChar({
            id: 'char-hwm-fallback',
            autoArchiveEnabled: true,
            contextRangeMode: 'adaptive',
        });

        const snapshot = await loadCharacterContextRange(char);
        expect(snapshot.hwm).toBe(hwmId);
        expect(snapshot.messages).toHaveLength(10);
        expect(snapshot.messages[0].content).toBe('msg-41');
        expect(localStorage.getItem('mp_lastMsgId_char-hwm-fallback')).toBe(String(hwmId));

        // 再次清除 localStorage，验证 loadCharacterContextMessageIds 同样兜底
        localStorage.removeItem('mp_lastMsgId_char-hwm-fallback');
        const allMsgs = await DB.getMessagesByCharId('char-hwm-fallback');
        const idSet = await loadCharacterContextMessageIds(char, allMsgs);
        expect(idSet.size).toBe(10);
    });
});
