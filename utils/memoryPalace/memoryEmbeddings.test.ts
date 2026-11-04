import { beforeEach, expect, it, vi } from 'vitest';
import { getMemoryEmbeddings } from './memoryEmbeddings';
import { getEmbeddings } from './embedding';
vi.mock('./embedding', () => ({ getEmbeddings: vi.fn() }));
const config = { baseUrl: 'https://embedding.example/v1', apiKey: 'key', model: 'embed', dimensions: 2 };
beforeEach(() => { vi.mocked(getEmbeddings).mockReset(); });

it('完整覆盖长摘要的末段，合并为单位向量，并保持节点顺序', async () => {
    const content = '前'.repeat(3000) + '后'.repeat(1500);
    vi.mocked(getEmbeddings).mockResolvedValue([
        new Float32Array([1, 0]), new Float32Array([0, 10]), new Float32Array([0.5, 0.5]),
    ]);
    const result = await getMemoryEmbeddings([
        { content, isBoxSummary: true }, { content: '普通记忆' },
    ], config);
    expect(vi.mocked(getEmbeddings).mock.calls[0][0]).toEqual(['前'.repeat(3000), '后'.repeat(1500), '普通记忆']);
    expect(result[0][0]).toBeCloseTo(2 / Math.sqrt(5));
    expect(result[0][1]).toBeCloseTo(1 / Math.sqrt(5));
    expect(Array.from(result[1])).toEqual([0.5, 0.5]);
});

it('段落缺失或维度不一致时拒绝，不产出半份索引', async () => {
    const nodes = [{ content: '长'.repeat(4500), isBoxSummary: true }];
    vi.mocked(getEmbeddings).mockResolvedValue([new Float32Array([1, 0])]);
    await expect(getMemoryEmbeddings(nodes, config)).rejects.toThrow('不完整');
    vi.mocked(getEmbeddings).mockResolvedValue([new Float32Array([1, 0]), new Float32Array([1])]);
    await expect(getMemoryEmbeddings(nodes, config)).rejects.toThrow('维度不一致');
});

it('分段不拆开 emoji，短摘要保持原请求和原向量', async () => {
    const content = '前'.repeat(2999) + '😀' + '后'.repeat(20);
    vi.mocked(getEmbeddings).mockImplementation(async texts => texts.map(() => new Float32Array([1, 0])));
    await getMemoryEmbeddings([{ content, isBoxSummary: true }], config);
    const inputs = vi.mocked(getEmbeddings).mock.calls[0][0];
    expect(inputs.join('')).toBe(content);
    expect(inputs[1].startsWith('😀')).toBe(true);
    await getMemoryEmbeddings([{ content: '短摘要', isBoxSummary: true }], config);
    expect(getEmbeddings).toHaveBeenLastCalledWith(['短摘要'], config);
});
