/** Shared with worker/stream preview: no persistence or repaired JSON. */
export const FRIEND_FEED_MAIN_PROMPT_PREFIX = '【顺便回好友圈】';

export function extractFriendFeedReplyTags(raw: string, namespace:'FRIEND_FEED_REPLY'|'HOME_VISIT_REPLY'='FRIEND_FEED_REPLY'): {text: string; actions: unknown[]} {
    const marker = new RegExp('\\[\\['+namespace+'\\s*:','gi');
    const actions: unknown[] = [];
    let text = '', cursor = 0, match: RegExpExecArray | null;
    while ((match = marker.exec(raw))) {
        text += raw.slice(cursor, match.index);
        let start = marker.lastIndex;
        while (start < raw.length && /\s/.test(raw[start])) start++;
        let depth = 0, quoted = false, escaped = false, end = -1;
        if (raw[start] === '{') for (let i = start; i < raw.length; i++) {
            const c = raw[i];
            if (quoted) {
                if (escaped) escaped = false;
                else if (c === '\\') escaped = true;
                else if (c === '"') quoted = false;
            } else if (c === '"') quoted = true;
            else if (c === '{') depth++;
            else if (c === '}' && --depth === 0) {end = i + 1; break;}
        }
        const close = end >= 0 ? /^\s*\]\]/.exec(raw.slice(end)) : null;
        if (close) {
            try {actions.push(JSON.parse(raw.slice(start, end)));} catch { /* malformed actions stay hidden */ }
            cursor = end + close[0].length;
        } else {
            const fallback = raw[start] === '{' && end < 0 ? -1 : raw.indexOf(']]', end >= 0 ? end : start);
            cursor = fallback < 0 ? raw.length : fallback + 2;
        }
        marker.lastIndex = cursor;
    }
    return {text: text + raw.slice(cursor), actions};
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Only equivalent field spellings; identities, task IDs and reply targets stay authoritative. */
export function normalizeFriendFeedAction(value: unknown): unknown {
    if (!record(value)) return value;
    const normalize = (input: Record<string, unknown>, npc: boolean) => {
        const row = {...input};
        for (const [canonical, alias] of [['requestId','request_id'], ['accountId','account_id'], ['postId','post_id']]) {
            if (row[alias] !== undefined) {
                if (row[canonical] !== undefined && row[canonical] !== row[alias]) return null;
                row[canonical] = row[alias]; delete row[alias];
            }
        }
        if (typeof row.kind === 'string') row.kind = row.kind.trim().toLowerCase();
        const field = !npc && (row.kind === 'comment' || row.kind === undefined) ? 'comment' : 'text';
        if (row[field] === undefined) {
            const aliases = [row.content, row[field === 'text' ? 'comment' : 'text']].filter(v => v !== undefined);
            if (aliases.length && aliases.every(v => v === aliases[0])) row[field] = aliases[0];
        }
        if (row.text === undefined && ['post','repost'].includes(String(row.kind)) && Array.isArray(row.imageCards) && row.imageCards.length) row.text = '';
        // JSON schemas often emit null for unused optional fields.
        for (const key of ['accountId','imageCards','replyToCommentId','replyToSourceCommentId','replyToNpcIndex','followAuthorId','learnIdentities']) {
            if (row[key] === null) delete row[key];
        }
        return row;
    };
    const row = normalize(value, false);
    if (row && Array.isArray(row.npcActions)) row.npcActions = row.npcActions.map(n => record(n) ? normalize(n, true) : n);
    return row;
}
