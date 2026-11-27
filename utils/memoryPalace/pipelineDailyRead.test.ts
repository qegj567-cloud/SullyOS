import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB } from '../db';
import type { Message } from '../../types';
import { isMessageSemanticallyRelevant } from '../messageFormat';
import { processNewMessages } from './pipeline';
import { setReliableMemoryPalaceHighWaterMark } from './highWaterMark';

// 每次角色回复后都会跑一遍日常整理，绝大多数时候结论是「还没攒够」。
// 这里钉住两件事：日常路径不把整段聊天读出来；结论与按全量算出来的逐项相同。

const HOT = 20;
const THRESHOLD = 10;
const waterline = { preset: 'custom', hotZoneSize: HOT, bufferThreshold: THRESHOLD } as const;
const emb: any = { baseUrl: 'test', apiKey: 'test', model: 'test' };
const llm: any = { baseUrl: 'test', apiKey: 'test', model: 'test' };

type Outcome = { skip: string } | { count: number; firstId: number; lastId: number };

/** 每 4 条夹一张图片（不参与整理）、每 5 条夹一条同角色的群发言（不属于私聊）。 */
async function seed(charId: string, total: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 0; i < total; i++) {
        const base = { charId, role: i % 2 ? 'assistant' : 'user', timestamp: 1000 + i } as any;
        if (i % 5 === 4) ids.push(await DB.saveMessage({ ...base, groupId: 'g-daily', type: 'text', content: `群里第${i}句` }));
        else if (i % 4 === 3) ids.push(await DB.saveMessage({ ...base, type: 'image', content: 'data:image/png;base64,AAAA' }));
        else ids.push(await DB.saveMessage({ ...base, type: 'text', content: `私聊第${i}句` }));
    }
    return ids;
}

/** 按全量读法算出的结论，口径与整理管线的日常分支一致。 */
function expectedFromFullRead(all: Message[], hwm: number): Outcome {
    const text = all.filter(m => !m.groupId).filter(m => isMessageSemanticallyRelevant(m)).sort((a, b) => a.id - b.id);
    if (text.length <= HOT) return { skip: 'hot_zone' };
    const hotZoneStartId = text[text.length - HOT].id;
    const buffer = text.filter(m => m.id > hwm && m.id < hotZoneStartId);
    if (buffer.length < THRESHOLD) return { skip: 'threshold' };
    const toProcess = buffer.slice(0, Math.ceil(buffer.length * 0.85));
    return { count: toProcess.length, firstId: toProcess[0].id, lastId: toProcess[toProcess.length - 1].id };
}

async function runDaily(charId: string, force = false): Promise<Outcome> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 停在真正开始整理的那一步，不发任何网络请求。
    const progress = vi.fn((_stage: string) => { throw new Error('test: stop before network'); });
    const result = await processNewMessages([], charId, 'C', emb, llm, 'U', force, progress, { waterline });
    if (result?.skipReason) return { skip: result.skipReason };
    const count = Number(/正在整理 (\d+) 条对话/.exec(String(progress.mock.calls[0]?.[0]))?.[1]);
    const range = /消息ID范围: (\d+) ~ (\d+)/.exec(log.mock.calls.map(call => String(call[0])).find(line => line.includes('消息ID范围')) || '');
    return { count, firstId: Number(range?.[1]), lastId: Number(range?.[2]) };
}

afterEach(() => vi.restoreAllMocks());

describe('记忆整理 · 日常路径只读水位线之后的一段', () => {
    // [总条数, 水位线落在第几条（0 = 从未整理）, 预期结论类型]
    const cases: [string, number, number, string][] = [
        ['总数不到热区', 18, 0, 'hot_zone'],
        ['水位线之后不足热区、再往前也凑不满', 30, 10, 'hot_zone'],
        ['水位线之后不足热区、往前能凑满', 80, 60, 'threshold'],
        ['过了热区但缓冲区没攒够', 50, 10, 'threshold'],
        ['攒够了，开始整理', 80, 10, 'process'],
        ['从未整理过且已攒够', 60, 0, 'process'],
    ];

    it.each(cases)('%s：结论与全量读法相同，且不读全量', async (_name, total, hwmIndex, kind) => {
        const charId = `daily-read-${total}-${hwmIndex}`;
        const ids = await seed(charId, total);
        const hwm = hwmIndex ? ids[hwmIndex - 1] : 0;
        if (hwm) await setReliableMemoryPalaceHighWaterMark(charId, hwm);

        const expected = expectedFromFullRead(await DB.getMessagesByCharId(charId, true), hwm);
        expect('skip' in expected ? expected.skip : 'process').toBe(kind);

        const fullRead = vi.spyOn(DB, 'getMessagesByCharId');
        expect(await runDaily(charId)).toEqual(expected);
        expect(fullRead).not.toHaveBeenCalled();
    });

    it('force 仍按全量读取', async () => {
        const charId = 'daily-read-force';
        await seed(charId, 40);
        const fullRead = vi.spyOn(DB, 'getMessagesByCharId');
        await runDaily(charId, true);
        expect(fullRead).toHaveBeenCalledWith(charId, true, false);
    });
});
