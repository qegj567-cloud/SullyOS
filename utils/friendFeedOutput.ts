import {normalizeFriendFeedAction} from './friendFeedReplyFormat';
import {extractAssistantText, parseEmotionEvalOutput} from './emotionApply';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Dedicated calls may return the action itself instead of its documented wrapper.
 * Never complete a truncated action, and never invent or replace a requestId. */
export function parseDedicatedFriendFeedAction(raw: string): unknown {
    const wrapped = parseEmotionEvalOutput(raw);
    if (wrapped?.friendFeedAction !== undefined) return wrapped.friendFeedAction === null ? null : normalizeFriendFeedAction(wrapped.friendFeedAction) ?? undefined;
    const start = raw.indexOf('{');
    if (start < 0) return undefined;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < raw.length; i++) {
        const c = raw[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
            const parsed = parseEmotionEvalOutput('{"friendFeedAction":' + raw.slice(start, i + 1) + '}')?.friendFeedAction;
            if (record(parsed) && !('friendFeedAction' in parsed) && ('requestId' in parsed || 'request_id' in parsed)) return normalizeFriendFeedAction(parsed) ?? undefined;
            return undefined;
        }
    }
    return undefined;
}

export function readDedicatedFriendFeedResponse(data:any) {
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') throw Error('API 截断了本轮回复，请检查模型输出上限或减少本轮内容');
    const raw = extractAssistantText(choice?.message);
    const answer = raw.replace(/<(think|thinking|thought)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<(?:think|thinking|thought)\b[^>]*>[\s\S]*$/i, '');
    return parseDedicatedFriendFeedAction(answer);
}
