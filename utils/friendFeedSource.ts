import {FRIEND_FEED_EXCERPT_LIMIT} from './friendFeedMaterial';
export interface FriendFeedImage {url: string; thumbnail: string}
export function isWeiboImageUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {const u = new URL(value); return u.protocol === 'https:' && /^(?:[a-z0-9-]+\.)*sinaimg\.cn$/.test(u.hostname)
        && !u.username && !u.password && !u.port;} catch {return false;}
}
/** Public attribution. Never store the provider response or credentials. */
export interface FriendFeedSource {
    platform: 'x' | 'xiaohongshu' | 'weibo';
    accountId?: string;
    externalId: string;
    url: string;
    author: string;
    /** Public display metadata; excluded from model material. */
    authorAvatar?: string;
    text: string;
    fetchedAt: number;
    publishedAt?: number;
    truncated: boolean;
    /** Display only: deliberately excluded from sourceContext and model requests. */
    images?: FriendFeedImage[];
}
export const sourceLabel = (source: FriendFeedSource) => source.platform === 'weibo' ? '微博' : source.platform === 'x' ? 'X / Twitter' : '小红书';
export function isFriendFeedSource(value: unknown): value is FriendFeedSource {
    if (!value || typeof value !== 'object') return false;
    const s = value as FriendFeedSource;
    const validTime = (t: unknown) => typeof t === 'number' && Number.isFinite(t) && t > 0 && t < 8.64e15;
    if (!['x', 'xiaohongshu', 'weibo'].includes(s.platform) || typeof s.externalId !== 'string'
        || !(s.platform !== 'xiaohongshu' ? /^\d{5,25}$/ : /^[a-f\d]{24}$/i).test(s.externalId)
        || typeof s.author !== 'string' || !s.author.trim() || s.author.length > 150
        || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 12000
        || !validTime(s.fetchedAt) || (s.publishedAt !== undefined && !validTime(s.publishedAt))
        || typeof s.truncated !== 'boolean') return false;
    if (s.images !== undefined && (s.platform !== 'weibo' || !Array.isArray(s.images) || s.images.length > 18
        || !s.images.every(i => i && isWeiboImageUrl(i.url) && isWeiboImageUrl(i.thumbnail)))) return false;
    if(s.authorAvatar!==undefined&&!isWeiboImageUrl(s.authorAvatar))return false;
    if (s.platform === 'weibo') return validTime(s.publishedAt) && /^\d{4,25}$/.test(s.accountId || '') &&
        new RegExp('^https://weibo\\.com/' + s.accountId + '/[a-zA-Z0-9]{5,25}$').test(s.url);
    return s.url === (s.platform === 'x' ? `https://x.com/i/status/${s.externalId}` : `https://www.xiaohongshu.com/explore/${s.externalId}`);
}
export const sourceContext = (source: FriendFeedSource) => ({platform: sourceLabel(source), author: source.author,
    text: source.text.slice(0, FRIEND_FEED_EXCERPT_LIMIT), truncated: source.truncated || source.text.length > FRIEND_FEED_EXCERPT_LIMIT, url: source.url});
