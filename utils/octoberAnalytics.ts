import { trackEvent } from './analytics';

/** Only explicit UI actions; never accept names, post IDs, dialogue choices or reward IDs. */
export function trackHalloweenFeature(value: unknown): void {
    let feature: string;
    switch (value) {
        case 'change': feature = '更换装扮'; break;
        case 'remove': feature = '去除装扮'; break;
        case 'candy': feature = '讨到糖果'; break;
        case 'dialogue': feature = '节日对话'; break;
        case 'replay': feature = '回看对话'; break;
        case 'gift': feature = '收到节日赠礼'; break;
        case 'collection': feature = '万圣节收藏'; break;
        default: return;
    }
    trackEvent('体验彼方万圣节', { 功能: feature });
}

export function trackBibiEntry(value: unknown): void {
    if (value === 'app') trackEvent('进入哔哔', { 入口: '独立App' });
    else if (value === 'phone') trackEvent('进入哔哔', { 入口: '家园小手机' });
}

export function trackBibiFeature(value: unknown): void {
    let feature: string;
    switch (value) {
        case 'post': feature = '发布编辑器'; break;
        case 'detail': feature = '动态详情'; break;
        case 'inbox': feature = '消息提醒'; break;
        case 'settings': feature = '设置'; break;
        case 'api': feature = '独立API'; break;
        case 'relations': feature = '关注与身份关系'; break;
        case 'sources': feature = '动态来源'; break;
        case 'weibo': feature = '微博连接'; break;
        case 'share': feature = '分享面板'; break;
        case 'following': feature = '关注列表'; break;
        default: return;
    }
    trackEvent('打开哔哔功能', { 功能: feature });
}
