import type {FriendFeedImage} from './friendFeedSource';
import {isWeiboImageUrl} from './friendFeedSource';

export const FRIEND_POST_IMAGE_LIMIT = 9;
export interface FriendImageCard {caption:string;description:string}
export const validFriendImageCards=(value:unknown):value is FriendImageCard[]=>Array.isArray(value)&&value.length<=3&&value.every(c=>
    c&&typeof c==='object'&&!Array.isArray(c)&&Object.keys(c).every(k=>k==='caption'||k==='description')
    &&typeof c.caption==='string'&&c.caption.trim().length<=40&&typeof c.description==='string'&&!!c.description.trim()&&c.description.trim().length<=600);
export const friendImageCardsText=(cards?:FriendImageCard[])=>cards?.length?'文字配图（作者描述的画面，无真实图片像素）：\n'+cards.map((c,i)=>`${i+1}. ${c.caption?c.caption+'：':''}${c.description}`).join('\n'):'';
export const friendPostText=(post:{text:string;imageCards?:FriendImageCard[]})=>[post.text,friendImageCardsText(post.imageCards)].filter(Boolean).join('\n');
export const isLocalFriendImage = (value: unknown): value is string => typeof value === 'string' && /^blobref:[a-zA-Z0-9_-]+$/.test(value);
export const isFriendImage = (image: FriendFeedImage) => !!image &&
    ((isLocalFriendImage(image.url) && image.thumbnail === image.url) || (isWeiboImageUrl(image.url) && isWeiboImageUrl(image.thumbnail)));
export function friendPostImages(post: {images?: FriendFeedImage[]; source?: {images?: FriendFeedImage[]}}): FriendFeedImage[] {
    return [...(post.images || []), ...(post.source?.images || [])].filter(isFriendImage).slice(0,18);
}
export const friendPostMediaCount=(post:Parameters<typeof friendPostImages>[0]&{imageCards?:FriendImageCard[]})=>friendPostImages(post).length+(post.imageCards?.length||0);
export function friendPostImageHint(post: Parameters<typeof friendPostImages>[0]&{imageCards?:FriendImageCard[]}) {
    const count=friendPostImages(post).length;
    return [count ? `有 ${count} 张真实配图；本次普通浏览仅提供文字，不能猜测未提供的图片内容。` : '',friendImageCardsText(post.imageCards)].filter(Boolean).join('\n')||undefined;
}
