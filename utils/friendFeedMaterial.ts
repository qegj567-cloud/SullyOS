import type {FriendPost} from './friendFeed';

/** Treat punctuation/spacing variants as the same line; retain emoji-only reactions. */
export function friendCommentKey(authorId: string, text: string) {
    const folded = text.normalize('NFKC').toLowerCase().replace(/[\s\u200b\ufe0f]+/gu, '');
    const words = folded.replace(/\p{P}/gu, '') || folded;
    // Short reactions may legitimately come from different people on the same post.
    return JSON.stringify([Array.from(words).length < 12 ? authorId : '', words]);
}

/** Only the comparison fingerprint of a removed line stays on its own post. */
export function removedCommentFingerprint(key: string) {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    return key.length.toString(36) + '-' + (hash >>> 0).toString(36);
}

/** Input excerpts only; publication limits and explicit share snapshots are separate. */
export const FRIEND_FEED_EXCERPT_LIMIT = 1200;
export const friendFeedExcerpt = (text: string) => text.length > FRIEND_FEED_EXCERPT_LIMIT
    ? `${text.slice(0, FRIEND_FEED_EXCERPT_LIMIT)}…` : text;

/** Keep every local contribution, including replies quoting an original comment. */
export const friendLocalComments = (post: FriendPost) => post.comments.map(c => ({
    id: c.id, authorId:c.authorId, accountId:c.accountId, accountBio:c.accountBio, author: c.authorName, text: friendFeedExcerpt(c.text),
    ...(c.localReply ? {localReply:c.localReply} : {}),
    ...(c.sourceReply ? {sourceReply: c.sourceReply} : {}),
}));
