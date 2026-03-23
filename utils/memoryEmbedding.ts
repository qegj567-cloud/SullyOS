/**
 * Memory Palace — Embedding Service
 * 调用 OpenAI 兼容的 Embedding API（支持国产/自定义 API）
 */

import { EmbeddingApiConfig } from '../types';
import { safeResponseJson } from './safeApi';

const DEFAULT_DIMENSIONS = 1024;

/**
 * 批量获取文本的 embedding 向量
 * 支持任何 OpenAI 兼容的 /embeddings 接口（OpenAI、硅基流动、Dashscope 等）
 */
export async function getEmbeddings(
    texts: string[],
    config: EmbeddingApiConfig
): Promise<number[][]> {
    if (texts.length === 0) return [];

    const dimensions = config.dimensions || DEFAULT_DIMENSIONS;
    const url = `${config.baseUrl.replace(/\/$/, '')}/embeddings`;

    const body: Record<string, any> = {
        model: config.model,
        input: texts,
    };

    // OpenAI text-embedding-3-* 支持 dimensions 参数（Matryoshka）
    // 大部分国产 API 也兼容这个参数
    if (dimensions) {
        body.dimensions = dimensions;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const data = await safeResponseJson(response);
        const errMsg = data?.error?.message || data?.error || `HTTP ${response.status}`;
        throw new Error(`Embedding API Error: ${errMsg}`);
    }

    const data = await safeResponseJson(response);

    // OpenAI 格式: { data: [{ embedding: number[], index: number }] }
    if (!data?.data || !Array.isArray(data.data)) {
        throw new Error('Embedding API 返回了非预期格式');
    }

    // 按 index 排序确保顺序正确
    const sorted = data.data.sort((a: any, b: any) => a.index - b.index);
    return sorted.map((item: any) => item.embedding as number[]);
}

/**
 * 获取单条文本的 embedding
 */
export async function getEmbedding(
    text: string,
    config: EmbeddingApiConfig
): Promise<number[]> {
    const results = await getEmbeddings([text], config);
    return results[0];
}

/**
 * 默认 embedding 配置（用户未自定义时的 fallback）
 * 使用与主 API 相同的 baseUrl + apiKey
 */
export function getDefaultEmbeddingConfig(
    baseUrl: string,
    apiKey: string
): EmbeddingApiConfig {
    return {
        baseUrl,
        apiKey,
        model: 'text-embedding-3-small',
        dimensions: DEFAULT_DIMENSIONS,
    };
}
