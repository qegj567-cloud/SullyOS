import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEmbeddings } from './embedding';
import type { EmbeddingConfig } from './types';

// 这组测试守护「分批 / 并行不破坏结果」这条契约：
//   1. 无论多少条文本，返回的向量条数 = 输入条数，且顺序严格对应下标
//   2. 任何单次请求塞的条数都 ≤ 10（DashScope/Qwen 的硬上限）
//   3. 多批走并行 + 并发上限，不改变上面两条
//
// 调用方（pipeline 的 queryVectors[i]、vectorStore 的 vectors[i]）全靠
// 「第 i 个向量对应第 i 条输入」这个保序契约，所以这是召回正确性的地基。

const config: EmbeddingConfig = {
    baseUrl: 'https://api.test/v1',
    apiKey: 'test-key',
    model: 'BAAI/bge-m3',
    dimensions: 1024,
};

// 记录每次 fetch 实际塞了几条 input / 每条多长，用于断言 batch 上限与截断
let batchSizes: number[] = [];
let batchInputs: string[][] = [];

beforeEach(() => {
    batchSizes = [];
    batchInputs = [];
    // mock fetch：把每条输入文本「原样编码」进它的向量第一位。
    // 文本约定是 String(i)（长文本场景是 `${i}xxx...`，parseFloat 取前缀数字），
    // 所以正确情况下 results[i][0] === i。
    // 用文本身份编码（而非请求内的局部下标）→ 一旦顺序错乱，断言立刻失败。
    global.fetch = vi.fn(async (_url: any, init: any) => {
        const body = JSON.parse(init.body as string);
        const input: string[] = body.input;
        batchSizes.push(input.length);
        batchInputs.push(input);
        return {
            ok: true,
            status: 200,
            json: async () => ({
                data: input.map((text, localIdx) => ({
                    index: localIdx,
                    embedding: [parseFloat(text)],
                })),
            }),
        } as any;
    }) as any;
});

describe('getEmbeddings 分批 / 并行保序', () => {
    it('空输入返回空数组，不发请求', async () => {
        const out = await getEmbeddings([], config);
        expect(out).toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('单条输入返回单条向量', async () => {
        const out = await getEmbeddings(['0'], config);
        expect(out).toHaveLength(1);
        expect(out[0][0]).toBe(0);
        expect(batchSizes).toEqual([1]);
    });

    it('恰好 10 条 → 一次请求，顺序正确', async () => {
        const texts = Array.from({ length: 10 }, (_, i) => String(i));
        const out = await getEmbeddings(texts, config);
        expect(out).toHaveLength(10);
        out.forEach((v, i) => expect(v[0]).toBe(i));
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(Math.max(...batchSizes)).toBeLessThanOrEqual(10);
    });

    it('12 条（检索典型场景）→ 拆成 ≤10 的多批，顺序仍严格对应', async () => {
        const texts = Array.from({ length: 12 }, (_, i) => String(i));
        const out = await getEmbeddings(texts, config);
        expect(out).toHaveLength(12);
        // 关键：第 i 个向量必须仍是第 i 条输入算出来的
        out.forEach((v, i) => expect(v[0]).toBe(i));
        expect(fetch).toHaveBeenCalledTimes(2);
        // 没有任何一批超过 10（否则 Qwen 会 400）
        batchSizes.forEach(n => expect(n).toBeLessThanOrEqual(10));
    });

    it('100 条（重建场景）→ 全部保序，且每批都 ≤10', async () => {
        const texts = Array.from({ length: 100 }, (_, i) => String(i));
        const out = await getEmbeddings(texts, config);
        expect(out).toHaveLength(100);
        out.forEach((v, i) => expect(v[0]).toBe(i));
        expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(100); // 不多不少
        batchSizes.forEach(n => expect(n).toBeLessThanOrEqual(10));
    });
});

describe('getEmbeddings 长文本防线（防 400 code 20015）', () => {
    it('单条超长输入被截到 4000 字符（防单条超 8192 token），且日志面板有提示', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const long = '0' + 'x'.repeat(10000);
            const out = await getEmbeddings([long], config);
            expect(out).toHaveLength(1);
            expect(out[0][0]).toBe(0);
            expect(batchInputs[0][0].length).toBe(4000);
            // 截断不能静默：日志面板（只抓 console.error）必须能看到截了哪条
            const logged = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
            expect(logged).toContain('已截断');
            expect(logged).toContain('第1条');
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('多条长文本按批内字符预算(6000)切批，仍严格保序', async () => {
        // 4 条各 2000 字：前 3 条 6000 字装满一批，第 4 条另起一批
        const texts = Array.from({ length: 4 }, (_, i) => `${i}${'x'.repeat(1999)}`);
        const out = await getEmbeddings(texts, config);
        expect(out).toHaveLength(4);
        out.forEach((v, i) => expect(v[0]).toBe(i));
        expect(batchSizes).toEqual([3, 1]);
        // 任何一批的字符总量都不超预算
        batchInputs.forEach(batch => {
            expect(batch.reduce((a, t) => a + t.length, 0)).toBeLessThanOrEqual(6000);
        });
    });

    it('短文本行为不变：12 条短 query 仍只拆成 2 批', async () => {
        const texts = Array.from({ length: 12 }, (_, i) => String(i));
        await getEmbeddings(texts, config);
        expect(batchSizes).toEqual([10, 2]);
    });
});

describe('getEmbeddings 批量 400 自动降级为逐条', () => {
    it('批量被 400 拒 → 逐条重发，结果完整且保序，4xx 不做无谓重试', async () => {
        global.fetch = vi.fn(async (_url: any, init: any) => {
            const body = JSON.parse(init.body as string);
            const input: string[] = body.input;
            batchSizes.push(input.length);
            if (input.length > 1) {
                return {
                    ok: false,
                    status: 400,
                    text: async () => '{"code":20015,"message":"The parameter is invalid. Please check again."}',
                } as any;
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    data: [{ index: 0, embedding: [parseFloat(input[0])] }],
                }),
            } as any;
        }) as any;

        const errorSpy = vi.spyOn(console, 'error');
        try {
            const out = await getEmbeddings(['0', '1', '2'], config);
            expect(out).toHaveLength(3);
            out.forEach((v, i) => expect(v[0]).toBe(i));
            // 1 次批量(400) + 3 次单条——批量 400 没有被重试第二遍
            expect(batchSizes).toEqual([3, 1, 1, 1]);
            expect(errorSpy).not.toHaveBeenCalled();
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('降级后单条仍 400 → 报错里带上第几条、多长、内容开头（可定位坏输入）', async () => {
        global.fetch = vi.fn(async () => ({
            ok: false,
            status: 400,
            text: async () => '{"code":20015,"message":"The parameter is invalid."}',
        })) as any;

        await expect(getEmbeddings(['正常文本', 'data:image/png;base64,AAAA'], config))
            .rejects.toThrow(/第 1\/2 条.*正常文本/s);
    });

    it('5xx 仍然重试一次后成功', async () => {
        let calls = 0;
        global.fetch = vi.fn(async (_url: any, init: any) => {
            calls++;
            if (calls === 1) {
                return { ok: false, status: 500, text: async () => 'oops' } as any;
            }
            const input: string[] = JSON.parse(init.body as string).input;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    data: input.map((text, localIdx) => ({ index: localIdx, embedding: [parseFloat(text)] })),
                }),
            } as any;
        }) as any;

        const out = await getEmbeddings(['7'], config);
        expect(out[0][0]).toBe(7);
        expect(calls).toBe(2);
    });
});
