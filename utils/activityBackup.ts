import type { FriendFeedState } from './friendFeed';
import type { FriendFeedImage } from './friendFeedSource';
import { isLocalFriendImage } from './friendFeedImages';
import { stripBackupImages } from './backupExport';

/** These records live in assets for historical reasons, but contain user history/settings. */
export const isActivityTextAsset = (id: string): boolean =>
    ['friend_feed_v1', 'friend_feed_api', 'home_visits_v1'].includes(id)
    || id.startsWith('friend_feed_eval_v1_') || id.startsWith('home_secrets_v1_');

export type ActivityTextAsset = { id: string; data: string };
export function exportActivityTextAsset(item: { id: string; data: unknown }): ActivityTextAsset | undefined {
    // The feed has its own typed section, including its text-only image stripping.
    if (!isActivityTextAsset(item.id) || item.id === 'friend_feed_v1') return undefined;
    if (typeof item.data !== 'string') throw new Error('活动文字存档格式不正确，请保留原存档');
    return { id: item.id, data: JSON.stringify(stripBackupImages(JSON.parse(item.data))) };
}

export type FriendFeedMediaBackup = { version: 1; posts: { id: string; images: FriendFeedImage[] }[]; coverImages?: Record<string,string> };
export function collectFriendFeedMedia(feed: FriendFeedState): FriendFeedMediaBackup {
    const coverImages=Object.fromEntries(Object.entries(feed.settings?.coverImages||{}).filter(([,image])=>isLocalFriendImage(image)));
    return { version: 1, posts: feed.posts.filter(p => p.images?.length).map(p => ({
        id: p.id, images: p.images!.filter(i => isLocalFriendImage(i.url) && i.thumbnail === i.url).map(i => ({ ...i })),
    })), ...(Object.keys(coverImages).length?{coverImages}:{}) };
}

/** Restore pictures by post ID without replacing newer text, replies, accounts or settings. */
export function applyFriendFeedMedia(feed: FriendFeedState, media: FriendFeedMediaBackup): FriendFeedState {
    if (media?.version !== 1 || !Array.isArray(media.posts) || media.posts.some(p =>
        !p || typeof p.id !== 'string' || !Array.isArray(p.images) || p.images.length > 9
        || p.images.some(i => !i || !isLocalFriendImage(i.url) || i.thumbnail !== i.url))) {
        throw new Error('哔哔图片备份格式不正确');
    }
    if(media.coverImages!==undefined&&(!media.coverImages||typeof media.coverImages!=='object'||Array.isArray(media.coverImages)||Object.values(media.coverImages).some(image=>!isLocalFriendImage(image))))throw new Error('哔哔封面备份格式不正确');
    const pictures = new Map(media.posts.map(p => [p.id, p.images]));
    return { ...feed, ...(media.coverImages?{settings:{...feed.settings,coverImages:{...feed.settings?.coverImages,...media.coverImages}}}:{}), posts: feed.posts.map(p => pictures.has(p.id) ? { ...p, images: pictures.get(p.id)!.map(i => ({ ...i })) } : p) };
}
