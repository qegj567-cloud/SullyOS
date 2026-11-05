/** Shared by prompts, persistence and the composer. Counts UTF-16 code units, as textarea does. */
export const FRIEND_POST_TEXT_LIMIT = 4000;
export const FRIEND_COMMENT_TEXT_LIMIT = 2000;
export const FRIEND_FEED_OUTPUT_TOKENS = 16000;
export const FRIEND_REPLY_OUTPUT_TOKENS = 8000;

/** Keep the model-visible budget consistent with the outgoing request. */
export function withFriendFeedOutputBudget(prompt: string, maxTokens: number) {
    return `本轮整份 JSON 的请求上限为 ${maxTokens} tokens，本人和所有路人共用，字段、ID 和配图描述也占用额度。单条动态最多 ${FRIEND_POST_TEXT_LIMIT} 字，单条评论最多 ${FRIEND_COMMENT_TEXT_LIMIT} 字。普通动态写几句即可，短评可以只有一句或一个表情。内容多时先精简正文和配图描述，必要时少写可选路人条目，留足空间把 JSON 完整收尾。\n${prompt}`;
}
