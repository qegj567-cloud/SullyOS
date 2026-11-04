import type {FriendPost} from './friendFeed';
import {FRIEND_FEED_EXCERPT_LIMIT} from './friendFeedMaterial';

export interface WeiboOriginalComment {
    id: string; authorId: string; authorName: string; text: string; createdAt: number;
    parentId?: string;
}
export interface WeiboCommentPage {
    rows: WeiboOriginalComment[]; cursor: string | null; fetchedAt: number;
}
export interface FriendSourceReply {id: string; authorName: string; text: string}
export const FRIEND_SOURCE_COMMENT_LIMIT = 10;
export function isWeiboOriginalComment(value: unknown): value is WeiboOriginalComment {
    const c = value as WeiboOriginalComment;
    return !!c && typeof c.id === 'string' && /^\d{5,25}$/.test(c.id)
        && typeof c.authorId === 'string' && /^\d{4,25}$/.test(c.authorId)
        && typeof c.authorName === 'string' && c.authorName.length > 0 && c.authorName.length <= 150
        && typeof c.text === 'string' && c.text.length > 0 && c.text.length <= 4000
        && Number.isFinite(c.createdAt) && c.createdAt > 0 && c.createdAt < 8.64e15
        && (c.parentId === undefined || typeof c.parentId === 'string' && /^\d{5,25}$/.test(c.parentId));
}
export function isWeiboCommentPage(value: unknown): value is WeiboCommentPage {
    const page = value as WeiboCommentPage;
    return !!page && Array.isArray(page.rows) && page.rows.length <= 200 && page.rows.every(isWeiboOriginalComment)
        && (page.cursor === null || typeof page.cursor === 'string' && /^\d{1,25}$/.test(page.cursor))
        && Number.isFinite(page.fetchedAt) && page.fetchedAt > 0;
}
export function isFriendSourceReply(value: unknown): value is FriendSourceReply {
    const c = value as FriendSourceReply;
    return !!c && typeof c.id === 'string' && /^\d{5,25}$/.test(c.id)
        && typeof c.authorName === 'string' && c.authorName.length <= 150
        && typeof c.text === 'string' && c.text.length <= FRIEND_FEED_EXCERPT_LIMIT;
}
/** Imported comments are public material, never autobiographical events. */
export function recentSourceComments(post: FriendPost) {
    if (post.source?.platform !== 'weibo') return [];
    return [...(post.weiboComments?.rows || [])].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        .slice(0, FRIEND_SOURCE_COMMENT_LIMIT).map(c => ({id: c.id, authorName: c.authorName, text: c.text.slice(0, FRIEND_FEED_EXCERPT_LIMIT), ...(c.parentId ? {parentId: c.parentId} : {})}));
}
