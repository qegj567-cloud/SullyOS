/**
 * 整合回忆长度兜底（纯逻辑，无外部依赖，便于单测）。
 *
 * content 超过精简触发线时尝试一次二次压缩；只采用更短的完整结果。
 * 压不短或调用失败时保留完整原文，绝不 slice 后加省略号。
 *
 * recompress 由调用方注入（真实路径是 LLM 调用），单测时换成假实现即可不碰网络。
 */
export async function enforceSummaryLengthBudget(
    content: string,
    recompress: (text: string) => Promise<string | null>,
    recompressThreshold: number,
): Promise<string> {
    if (content.length <= recompressThreshold) return content;
    try {
        const recompressed = (await recompress(content))?.trim();
        if (recompressed && recompressed.length < content.length) return recompressed;
    } catch {
        // 精简是可选优化；首次生成的完整正文仍可正常保存。
    }
    return content;
}
