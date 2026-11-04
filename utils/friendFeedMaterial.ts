import type {FriendPost} from './friendFeed';

/** Input excerpts only; publication limits and explicit share snapshots are separate. */
export const FRIEND_FEED_EXCERPT_LIMIT = 1200;
export const friendFeedExcerpt = (text: string) => text.length > FRIEND_FEED_EXCERPT_LIMIT
    ? `${text.slice(0, FRIEND_FEED_EXCERPT_LIMIT)}…` : text;

/** Keep every local contribution, including replies quoting an original comment. */
export const friendLocalComments = (post: FriendPost) => post.comments.map(c => ({
    id: c.id, authorId:c.authorId, author: c.authorName, text: friendFeedExcerpt(c.text),
    ...(c.localReply ? {localReply:c.localReply} : {}),
    ...(c.sourceReply ? {sourceReply: c.sourceReply} : {}),
}));
