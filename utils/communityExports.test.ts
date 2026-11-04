import { expect, it } from 'vitest';
import { DB } from './db';
import type { BankTransaction, Message } from '../types';
import { formatChatTextExport } from './chatTextExport';
import { formatLedgerCsv, ledgerTotals, parseLedgerAmount } from './bankLedger';
import { buildDateHistoryGroups } from './dateHistory';

it('exports archived private dialogue with original text and timestamps, excluding hidden sources and media data', async () => {
    const charId = 'export-regression';
    const at = new Date(2026, 9, 27, 11, 15, 23).getTime();
    const save = (patch: Partial<Message>) => DB.saveMessage({charId, role: 'assistant', type: 'text', content: '原文 [保留括号]\n第二行', timestamp: at, ...patch});
    await save({role: 'user', timestamp: at - 1000, content: 'User 原话'});
    await save({});
    await save({role: 'system', content: '系统私密提示'});
    for (const source of ['date', 'call', 'home', 'story_theater_memory']) await save({content: `不要导出 ${source}`, metadata: {source}});
    await save({type: 'secret_note', content: '内心秘密'});
    await save({content: '主动触发提示', metadata: {proactiveHint: true}});
    await save({type: 'image', content: 'data:image/png;base64,PRIVATE'});
    await save({groupId: 'group-private', content: '群聊原文'});
    localStorage.setItem(`mp_lastMsgId_${charId}`, '999999');
    const exported = formatChatTextExport(await DB.getMessagesByCharId(charId, true));
    expect(exported).toContain('[2026-10-27 11:15:23] AI: 原文 [保留括号]\n第二行');
    expect(exported).toContain('User: User 原话');
    expect(exported.indexOf('User:')).toBeLessThan(exported.indexOf('AI:'));
    expect(exported).toContain('[图片]');
    for (const hidden of ['不要导出', 'PRIVATE', '内心秘密', '系统私密提示', '主动触发提示', '群聊原文']) expect(exported).not.toContain(hidden);
    localStorage.removeItem(`mp_lastMsgId_${charId}`);
});

it('history reads all date records before either sort, across the old 500 message boundary', async () => {
    const charId = 'date-history-regression';
    for (let i = 0; i < 530; i++) await DB.saveMessage({charId, role: 'assistant', type: 'text', content: `见面${i}`, timestamp: new Date(2025, 0, i + 1).getTime(), metadata: {source: 'date', dateEncounterId: `e-${i}`}});
    await DB.saveMessage({charId, role: 'user', type: 'text', content: '普通聊天', timestamp: Date.now()});
    localStorage.setItem(`mp_lastMsgId_${charId}`, '999999');
    const messages = await DB.getRecentMessagesByCharIdAndSource(charId, 'date', Number.MAX_SAFE_INTEGER);
    expect(messages).toHaveLength(530);
    expect(buildDateHistoryGroups(messages, 'date', 'oldest')[0].dateKey).toBe('2025-01-01');
    expect(buildDateHistoryGroups(messages, 'encounter', 'oldest')[0].messages[0].content).toBe('见面0');
    expect(buildDateHistoryGroups(messages, 'date', 'newest').at(-1)!.dateKey).toBe('2025-01-01');
    localStorage.removeItem(`mp_lastMsgId_${charId}`);
});

it('ledger keeps legacy expenses separate from income and exports all months without mutating input', () => {
    const txs: BankTransaction[] = [
        {id:'old', amount:10.12, category:'general', note:'晚餐,饮料\n"两人"', timestamp:1, dateStr:'2024-01-01'},
        {id:'income', type:'income', amount:1000, category:'general', note:'=恶意公式', timestamp:2, dateStr:'2026-10-01'},
    ];
    expect(ledgerTotals(txs)).toEqual({expense:10.12,income:1000,balance:989.88});
    const csv = formatLedgerCsv(txs);
    expect(csv).toContain('2024-01-01'); expect(csv).toContain('2026-10-01');
    expect(csv).toContain('收入,1000'); expect(csv).toContain('支出,10.12');
    expect(csv).toContain('"晚餐,饮料\n""两人"""');
    expect(csv).toContain('"\'=恶意公式"');
    expect(txs.map(t => t.id)).toEqual(['old','income']);
    for (const invalid of ['-1','0','Infinity','1e4','12abc','1.234','']) expect(parseLedgerAmount(invalid)).toBeNull();
    expect(parseLedgerAmount('12.30')).toBe(12.3);
});
