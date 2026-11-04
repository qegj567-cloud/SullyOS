export const DEFAULT_FRIEND_FEED_PROMPT = '有想分享的日常就发动态，确实想回应时再写短评。可以接梗、吐槽、关心、表达不同意见，不必赞美或对每条互动。这是开放广场，不同世界的人都能刷到。认识的人按已有关系互动，不认识的就是陌生网友，不凭刷到帖子虚构交情。保留各自的性格与关系分寸。';
export const DEFAULT_FRIEND_NPC_PROMPT = `你写的是各自刷手机的网友，不是来服务帖主的捧场团。每个人只注意到自己感兴趣的一小点，不必理解全文，也不必给建议、提供情绪价值或把话说圆。
网友不是承载角色的分身，不把角色的口头禅、长比喻、职业术语传染给所有人。昵称像普通账号，不要人人都起一个精准贴合本帖话题的职业名或拟人梗名。
一次有三位以上路人时，长短必须有明显落差：至少一条只有表情、标点或 1–8 个字，最多一人长篇解释。用户问问题也不是全体网友的作业；被点名的人可以认真答，其他人不必回答、更不要换个说法重复答案或轮流附和“确实”。有些人只看热闹、只关心旁边一个细节，或者完全没跟上。
口吻、长度、懂行程度、立场要参差：有人只丢一个表情、问号或几个字；有人接梗、歪楼、认错重点；有人没看懂只围观或问一句；有人半信半疑、纠正细节或不买账；真与话题有关的人才从经验或专业角度展开几句。专业意见要有具体内容，不凭空捏造权威身份、经历或数据，不懂就不懂。
短评可以只有 1–8 字或纯表情，普通评论随意一两句，偶尔有 100–500 字的较长讨论。长短由想说的事决定；不是每个人都写同样长度。不要每批固定凑齐这些类型，不给网友标注“围观型/专业型”，不要照抄示例。无需每人都赞美，也无需人人刻薄，允许无聊、困惑、敷衍和话没说完。
少写“太有共鸣了”“被治愈了”“狠狠期待”“你真的好棒”式万能捧场；不要把原文换个说法再夸一遍，不要整齐排队“赞美＋分析＋建议”，不用总结陈词或固定结尾反问。emoji 可以独占一条，别每人都配一个。
网友也会接其他评论的话，而不只围着帖主：按已有评论 ID 指定回复对象，延续具体分歧、问题或梗；普通顶层评论不填回复 ID。只知道公开帖子和评论，不知道私聊与内心，不强行装熟。`;
export interface FriendAccount {id: string; name: string; purpose: string; tags: string[]}
export interface FriendIdentity {nickname?:string; tags: string[]; accounts: FriendAccount[]}
export type FriendRefreshKind = 'self' | 'related' | 'stranger';
export type WeiboHomeMode = 'default' | 'latest';
export interface FriendFeedSettings {
    userNickname?:string;
    weiboHomeMode: WeiboHomeMode;
    weiboProfile?:{uid:string;name:string;avatar?:string};
    coverImages?: Record<string,string>;
    interactionPrompt: string;
    npcPrompt: string;
    theme: 'island' | 'moments' | 'insta' | 'journal' | 'weibo' | 'twitter';
    layout: 'paper' | 'timeline' | 'compact';
    fontSize: 14 | 16 | 18;
    showCover: boolean;
    replyMode: 'piggyback' | 'immediate';
    npcEnabled: boolean;
    realContentEnabled: boolean;
    hideRealPosts: boolean;
    shareImagesEnabled: boolean;
    characterWeights: Record<string, number>;
    contentWeights: Record<FriendRefreshKind, number>;
    identities: Record<string, FriendIdentity>;
}
export const defaultFriendFeedSettings = (): FriendFeedSettings => ({
    userNickname: '',
    weiboHomeMode: 'default',
    coverImages: {},
    interactionPrompt: DEFAULT_FRIEND_FEED_PROMPT, npcPrompt: DEFAULT_FRIEND_NPC_PROMPT, theme: 'moments', layout: 'paper', fontSize: 14, showCover: true,
    replyMode: 'immediate', npcEnabled: true, realContentEnabled: false, hideRealPosts: false, shareImagesEnabled: false,
    characterWeights: {}, contentWeights: {self: 60, related: 30, stranger: 10}, identities: {},
});
const weight = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : fallback;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const tags = (v: unknown): string[] => Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === 'string').map(s => s.trim().slice(0, 30)).filter(Boolean))].slice(0, 8) : [];
export function resolveFriendIdentities(value: unknown): Record<string, FriendIdentity> {
    if (!record(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([,v]) => record(v)).map(([id, raw]) => {
        const v = raw as Record<string, unknown>, seen = new Set<string>();
        const accounts: FriendAccount[] = [];
        if (Array.isArray(v.accounts)) for (const a of v.accounts) {
            if (!record(a) || typeof a.id !== 'string' || !a.id || a.id === 'main' || seen.has(a.id) || typeof a.name !== 'string' || !a.name.trim()) continue;
            seen.add(a.id); accounts.push({id: a.id.slice(0, 100), name: a.name.trim().slice(0, 40), purpose: typeof a.purpose === 'string' ? a.purpose.slice(0, 300) : '', tags: tags(a.tags)});
            if (accounts.length === 3) break;
        }
        return [id, {nickname:typeof v.nickname==='string'?v.nickname.trim().slice(0,40):undefined,tags: tags(v.tags), accounts}];
    }));
}
export function friendAccounts(settings: FriendFeedSettings, char: {id: string; name: string}): FriendAccount[] {
    const identity = settings.identities[char.id];
    return [{id: 'main', name: identity?.nickname||char.name, purpose: '主号', tags: identity?.tags || []}, ...(identity?.accounts || [])];
}
export function friendAccountPrompt(settings: FriendFeedSettings, char: {id: string; name: string}) {
    return '这是公共广场，不同世界的人也能刷到。只按已有关系认人，未认识的作者按陌生网友理解，不因此共享世界观或私聊。\n你的账号（只属于你，不代表额外角色）：' + JSON.stringify(friendAccounts(settings, char))
        + '\n发帖、转发或评论时，accountId 必须填写上面本人账号列表中的 id（主号固定为 "main"），不要填网名、人名、角色 ID 或照抄其他作者的 accountId；省略表示 main。小号仍是你的行为。不得冒用别人的账号，不自动向网友公开小号与主号的关联；正文不可泄露未公开私聊。';
}
/** Older backups and unknown appearance values keep their content and use stable defaults. */
export function resolveFriendFeedSettings(value?: Partial<FriendFeedSettings> | null): FriendFeedSettings {
    const defaults = defaultFriendFeedSettings();
    return {
        userNickname:typeof value?.userNickname==='string'?value.userNickname.trim().slice(0,40):'',
        weiboHomeMode:value?.weiboHomeMode==='latest'?'latest':'default',
        weiboProfile:value?.weiboProfile && /^\d{4,25}$/.test(value.weiboProfile.uid) && typeof value.weiboProfile.name==='string' && value.weiboProfile.name.trim()
            ? {uid:value.weiboProfile.uid,name:value.weiboProfile.name.trim().slice(0,150),
                avatar:typeof value.weiboProfile.avatar==='string' && /^https:\/\/[a-z\d.-]+\.sinaimg\.cn\/[^\s]{1,1900}$/i.test(value.weiboProfile.avatar)?value.weiboProfile.avatar:undefined}:undefined,
        coverImages:record(value?.coverImages)?Object.fromEntries(Object.entries(value.coverImages).filter((entry):entry is [string,string]=>typeof entry[1]==='string'&&/^blobref:[a-zA-Z0-9_-]+$/.test(entry[1]))):{},
        interactionPrompt: typeof value?.interactionPrompt === 'string' ? value.interactionPrompt.slice(0, 3000) : defaults.interactionPrompt,
        npcPrompt: typeof value?.npcPrompt === 'string' ? value.npcPrompt.slice(0, 3000) : defaults.npcPrompt,
        theme: ['island', 'moments', 'insta', 'journal', 'weibo', 'twitter'].includes(value?.theme || '') ? value!.theme! : defaults.theme,
        layout: ['paper', 'timeline', 'compact'].includes(value?.layout || '') ? value!.layout! : defaults.layout,
        fontSize: [14, 16, 18].includes(value?.fontSize || 0) ? value!.fontSize! : defaults.fontSize,
        showCover: typeof value?.showCover === 'boolean' ? value.showCover : defaults.showCover,
        // Legacy backups may contain piggyback; user comments now always reply immediately.
        replyMode: 'immediate',
        realContentEnabled: value?.realContentEnabled === true,
        hideRealPosts: value?.hideRealPosts === true,
        shareImagesEnabled: value?.shareImagesEnabled === true,
        characterWeights: record(value?.characterWeights) ? Object.fromEntries(Object.entries(value.characterWeights).map(([id, v]) => [id, weight(v, 10)])) : {},
        contentWeights: {self: weight(value?.contentWeights?.self, 60), related: weight(value?.contentWeights?.related, 30), stranger: weight(value?.contentWeights?.stranger, 10)},
        identities: resolveFriendIdentities(value?.identities),
        npcEnabled: typeof value?.npcEnabled === 'boolean' ? value.npcEnabled : true,
    };
}
