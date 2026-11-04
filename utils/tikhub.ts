import {isFriendFeedSource, type FriendFeedSource} from './friendFeedSource';

const KEY = 'sully:tikhub:key:v1';
// Deliberately outside assets/settings: feed exports and cloud prompts never include this key.
export const readTikHubKey = () => {try {return localStorage.getItem(KEY) || '';} catch {return '';}};
export function saveTikHubKey(key: string) {
    const value = key.trim();
    if (value && !/^[\x21-\x7e]{8,512}$/.test(value)) throw new Error('请填写有效的 TikHub API Key');
    if (value) localStorage.setItem(KEY, value); else localStorage.removeItem(KEY);
}
export interface TikHubLink {platform: 'x' | 'xiaohongshu'; id?: string; shareUrl?: string}
export function parseTikHubLink(input: string): TikHubLink {
    const links = input.match(/https?:\/\/[^\s<>"，。！）)]+/g) || [];
    if (links.length !== 1) throw new Error('请粘贴一条 X 或小红书帖子链接');
    let url: URL;
    try {url = new URL(links[0]);} catch {throw new Error('帖子链接格式不正确');}
    if (url.username || url.password || url.port) throw new Error('不支持这个帖子链接');
    const host = url.hostname.toLowerCase();
    if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(host)) {
        const id = url.pathname.match(/^\/(?:[^/]+\/status|i\/web\/status|i\/status)\/(\d{5,25})(?:\/(?:photo|video)\/\d+)?\/?$/)?.[1];
        if (id) return {platform: 'x', id};
    }
    if (['xiaohongshu.com', 'www.xiaohongshu.com'].includes(host)) {
        const id = url.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/i)?.[1];
        if (id) return {platform: 'xiaohongshu', id: id.toLowerCase()};
    }
    if (['xhslink.com', 'www.xhslink.com', 'xhslink.cn', 'www.xhslink.cn'].includes(host)
        && /^\/(?:a\/|o\/)?[a-z\d]+\/?$/i.test(url.pathname)) {
        return {platform: 'xiaohongshu', shareUrl: `https://${host}${url.pathname}`};
    }
    throw new Error('目前支持 X 推文、小红书笔记及小红书分享短链接');
}

type Row = Record<string, any>;
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
/** Traverse envelopes only to find a post with its own ID; never pick a random quoted post. */
export function normalizeTikHubPost(payload: unknown, link: TikHubLink): FriendFeedSource {
    const root = payload as Row;
    if (!object(root) || (root.code !== undefined && root.code !== 200)) throw new Error('TikHub 未返回有效帖子');
    const queue: unknown[] = [root.data]; let found: Row | undefined, count = 0;
    while (queue.length && count++ < 1000) {
        const item = queue.shift();
        if (Array.isArray(item)) {queue.push(...item.slice(0, 100)); continue;}
        if (!object(item)) continue;
        const id = String(link.platform === 'x' ? item.rest_id || item.id_str || item.tweet_id || '' : item.note_id || item.id || '');
        const text = link.platform === 'x' ? item.note_tweet?.note_tweet_results?.result?.text || item.legacy?.full_text || item.full_text || item.text
            : item.desc || item.content || item.title;
        if (id && (!link.id || id === link.id) && typeof text === 'string' && text.trim()) {found = item; break;}
        for (const [key, value] of Object.entries(item)) {
            if (!/quoted|retweeted|comment|replies|user|author/i.test(key) && (object(value) || Array.isArray(value))) queue.push(value);
        }
    }
    if (!found) throw new Error('没有读到帖子正文；帖子可能已删除、不可见，或上游返回格式已变化');
    const id = String(link.platform === 'x' ? found.rest_id || found.id_str || found.tweet_id : found.note_id || found.id);
    const user = found.core?.user_results?.result?.legacy || found.core?.user_results?.result?.core || found.user || found.author || {};
    const author = user.name || user.nickname || user.nick_name || user.screen_name || found.core?.user_results?.result?.core?.name || found.author_name;
    if (typeof author !== 'string' || !author.trim()) throw new Error('帖子缺少原作者信息，暂不导入');
    const fullText = link.platform === 'x' ? found.note_tweet?.note_tweet_results?.result?.text || found.legacy?.full_text || found.full_text || found.text
        : [found.title, found.desc || found.content].filter((v, i, a) => typeof v === 'string' && v.trim() && a.indexOf(v) === i).join('\n');
    const rawTime = found.legacy?.created_at || found.created_at || found.time || found.create_time;
    const at = typeof rawTime === 'number' ? rawTime * (rawTime < 1e12 ? 1000 : 1) : typeof rawTime === 'string' ? Date.parse(rawTime) : NaN;
    const source: FriendFeedSource = {platform: link.platform, externalId: id,
        url: link.platform === 'x' ? `https://x.com/i/status/${id}` : `https://www.xiaohongshu.com/explore/${id}`,
        author: author.trim().slice(0, 150), text: fullText.trim().slice(0, 12000), truncated: fullText.trim().length > 12000,
        fetchedAt: Date.now(), ...(Number.isFinite(at) && at > 0 && at < 8.64e15 ? {publishedAt: at} : {})};
    if (!isFriendFeedSource(source)) throw new Error('帖子来源信息不完整，暂不导入');
    return source;
}
// Retained for old callers: the paid provider is disabled before any network access.
export async function fetchTikHubPost(_input: string, _key: string, _signal?: AbortSignal): Promise<FriendFeedSource> {
    throw new Error('TikHub 付费接入已停用');
}
