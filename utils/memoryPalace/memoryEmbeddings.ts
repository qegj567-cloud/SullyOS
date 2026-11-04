import type { EmbeddingConfig, MemoryNode } from './types';
import { getEmbeddings } from './embedding';

// Keep below the embedding transport's 4000-character per-input guard.
const SUMMARY_CHUNK_CHARS = 3000;

/** Long box summaries keep their full text; every segment contributes to the
 * existing one-vector-per-node index. Ordinary nodes retain their old path. */
export async function getMemoryEmbeddings(
    nodes: Pick<MemoryNode, 'content' | 'isBoxSummary'>[],
    config: EmbeddingConfig,
): Promise<Float32Array[]> {
    const inputs: string[] = [];
    const spans = nodes.map(node => {
        const start = inputs.length;
        if (!node.isBoxSummary || node.content.length <= SUMMARY_CHUNK_CHARS) {
            inputs.push(node.content);
        } else {
            let offset = 0;
            while (offset < node.content.length) {
                let end = Math.min(offset + SUMMARY_CHUNK_CHARS, node.content.length);
                // Never split a UTF-16 surrogate pair.
                if (end < node.content.length && /[\uD800-\uDBFF]/.test(node.content[end - 1])) end--;
                inputs.push(node.content.slice(offset, end));
                offset = end;
            }
        }
        return { start, end: inputs.length };
    });
    const vectors = await getEmbeddings(inputs, config);
    if (vectors.length !== inputs.length || vectors.some(v => !v?.length || !Array.from(v).every(Number.isFinite))) {
        throw new Error('Embedding 返回的向量不完整或无效，本次没有写入记忆');
    }
    return spans.map(({ start, end }) => {
        if (end - start === 1) return vectors[start];
        const dimensions = vectors[start].length;
        const pooled = new Float64Array(dimensions);
        for (let i = start; i < end; i++) {
            const vector = vectors[i];
            if (vector.length !== dimensions) throw new Error('摘要分段向量维度不一致，本次没有写入记忆');
            const norm = Math.hypot(...vector);
            if (!norm) throw new Error('摘要分段向量无效，本次没有写入记忆');
            const weight = inputs[i].length / norm;
            for (let d = 0; d < dimensions; d++) pooled[d] += vector[d] * weight;
        }
        const norm = Math.hypot(...pooled);
        if (!norm) throw new Error('摘要合并向量无效，本次没有写入记忆');
        return Float32Array.from(pooled, value => value / norm);
    });
}
