import React from 'react';
import type {CharacterGroup, CharacterProfile} from '../types';
import FriendFeedAccounts from './FriendFeedAccounts';
import {FriendFeedTikHubSettings} from './FriendFeedTikHub';
import {defaultFriendFeedSettings, DEFAULT_FRIEND_FEED_PROMPT, DEFAULT_FRIEND_NPC_PROMPT, type FriendFeedSettings} from '../utils/friendFeedSettings';
import type {PreferenceSection} from './FriendFeedSettingsMenu';

export default function FriendFeedPreferences({value, onChange, disabled, embedded = false, characters = [], groups = [], section}: {
    value: FriendFeedSettings; onChange: (next: FriendFeedSettings) => void; disabled: boolean; embedded?: boolean; characters?: CharacterProfile[]; groups?: CharacterGroup[]; section: PreferenceSection;
}) {
    const change = (patch: Partial<FriendFeedSettings>) => onChange({...value, ...patch});
    return <div className="ff-preferences">
        {section === 'appearance' && <section className="ff-preferences-section" aria-label="外观与阅读">
        {embedded ? <p className="friend-feed-home-theme">小屋手机使用森间手记。其他主题可在桌面哔哔中切换。</p> : <fieldset className="friend-feed-theme-options" disabled={disabled}><legend>界面主题</legend>
            <div>{([
                ['island', '森间手记', '奶油纸与薄荷绿'],
                ['moments', '微信朋友圈', '熟悉的头像与留言'],
                ['insta', 'Ins 风格', '黑白界面，日常特写'],
                ['journal', '蓝墨杂志', '钴蓝刊头与黑字短讯'],
                ['weibo', '微博风格', '暖橙导航，熟悉的新鲜事'],
                ['twitter', '推特风格', '蓝白时间线，轻快短动态'],
            ] as const).map(([theme, label, hint]) => <label key={theme} data-sample={theme}>
                <input type="radio" name="feed-theme" value={theme} checked={value.theme === theme} onChange={() => change({theme})}/>
                <span className="friend-feed-theme-sample" aria-hidden="true"><i className="sample-cover"/><i className="sample-face"/><i className="sample-copy"/><i className="sample-note"/></span>
                <strong>{label}</strong><small>{hint}</small>
            </label>)}</div>
        </fieldset>}
        <fieldset className="friend-feed-layout-options" disabled={disabled}><legend>动态排版</legend>
            <div>{([
                ['paper', '舒展', '保留主题原有排版'],
                ['timeline', '时间线', '顺着时间往下看'],
                ['compact', '紧凑', '一屏多看几条'],
            ] as const).map(([layout, label, hint]) => <label key={layout}>
                <input type="radio" name="feed-layout" value={layout} checked={value.layout === layout} onChange={() => change({layout})}/>
                <span className={`friend-feed-layout-sample sample-${layout}`} aria-hidden="true"><i/><i/><i/></span>
                <strong>{label}</strong><small>{hint}</small>
            </label>)}</div>
        </fieldset>
        <fieldset className="friend-feed-font-options" disabled={disabled}><legend>正文字号</legend>
            <div>{([14, 16, 18] as const).map((fontSize, i) => <label key={fontSize}>
                <input type="radio" name="feed-font-size" checked={value.fontSize === fontSize} onChange={() => change({fontSize})}/>
                <span>{['标准', '舒展', '大字'][i]}</span>
            </label>)}</div>
        </fieldset>
        <label className="ff-toggle-row"><span>显示首页封面<small>收起后直接阅读动态</small></span><input type="checkbox" checked={value.showCover} disabled={disabled}
            onChange={e => change({showCover: e.target.checked})}/></label>
        <div className="friend-feed-layout-preview" aria-label="排版预览"><small>排版预览</small>
            <article className="friend-feed-post"><div className="friend-feed-post-heading"><span className="friend-feed-avatar">友</span><div><strong>一位朋友</strong><time>刚刚</time></div></div>
                <p className="friend-feed-post-body">今天的咖啡，终于没有煮糊。<br/>谁要来尝第一口？</p>
                <div className="friend-feed-comments"><p><strong>另一个朋友</strong>：杯子已经准备好了。</p></div>
            </article>
        </div>
        </section>}
        {section === 'interaction' && <section className="ff-preferences-section" data-setup-section="interaction" tabIndex={-1} aria-label="互动与提示词">
        <p className="friend-feed-settings-hint">用户评论保存后立即调用一次对话 API，由角色或路人接话；帖主私聊会收到评论记录。失败直接显示错误，不后台重试、不等主 API。每次评论会产生模型用量。</p>
        <label className="ff-toggle-row"><span>让路人也来串场<small>世界书 NPC 或陌生网友；首页刷新目标 2～5 条新动态，评论可有 3～6 位路人接话</small></span><input type="checkbox" checked={value.npcEnabled} disabled={disabled}
            onChange={e => change({npcEnabled: e.target.checked})}/></label>
        <label className="ff-setting-field">哔哔提示词<textarea value={value.interactionPrompt} disabled={disabled} rows={5} maxLength={3000}
            placeholder={DEFAULT_FRIEND_FEED_PROMPT} onChange={e => change({interactionPrompt: e.target.value})}/></label>
        <p className="friend-feed-settings-hint">控制发动态和评论的语气、互动偏好。所有角色共用这份风格提示词，也可规定首页的话题与内容偏好。留空使用默认风格。保存后从下一次生成起生效。</p>
        <details className="ff-npc-prompt"><summary>路人提示词</summary>
            <p className="friend-feed-settings-hint">专门控制网友的口吻、长短和参与方式。可以只发个表情，也可以认真聊几句。留空使用默认提示词。</p>
            <label className="ff-setting-field">路人怎么说话<textarea value={value.npcPrompt} disabled={disabled} rows={9} maxLength={3000} placeholder={DEFAULT_FRIEND_NPC_PROMPT} onChange={e=>change({npcPrompt:e.target.value})}/></label>
            <button type="button" disabled={disabled} onClick={()=>change({npcPrompt:DEFAULT_FRIEND_NPC_PROMPT})}>恢复默认路人口吻</button>
        </details>
        </section>}
        {section === 'content' && <section className="ff-preferences-section" aria-label="真实内容权限">
            <label className="ff-toggle-row"><span>允许角色阅读真实微博<small>选中的正文、最多 10 条真实评论（楼中楼也计一条）与全部本地评论会发给你配置的 AI。隐藏仅影响界面，不会关闭此权限；所有接话只留在本地。</small></span><input type="checkbox" disabled={disabled} checked={value.realContentEnabled} onChange={e => change({realContentEnabled: e.target.checked})}/></label>
            <label className="ff-toggle-row"><span>分享时让角色看配图<small>将配图交给对话模型或已配置的识图 API，需要支持图片。仅影响之后分享的帖子；关闭时卡片仍可展示图片。</small></span><input type="checkbox" disabled={disabled} checked={value.shareImagesEnabled} onChange={e=>change({shareImagesEnabled:e.target.checked})}/></label>
            <label className="ff-toggle-row"><span>隐藏真实微博帖子<small>仅隐藏同步 / 导入的原帖；保留角色转发与本地动态。</small></span><input type="checkbox" disabled={disabled} checked={value.hideRealPosts} onChange={e => change({hideRealPosts: e.target.checked})}/></label>
        </section>}
        {(section === 'profile' || section === 'weights' || section === 'accounts') && <FriendFeedAccounts section={section} value={value} onChange={onChange} characters={characters} groups={groups} disabled={disabled}/>}
        {section === 'advanced' && <><FriendFeedTikHubSettings/>
        <button type="button" className="friend-feed-reset" disabled={disabled} onClick={() => onChange({...defaultFriendFeedSettings(),userNickname:value.userNickname,weiboProfile:value.weiboProfile,identities:value.identities,coverImages:value.coverImages, ...(embedded ? {theme: value.theme} : {})})}>恢复默认设置</button>
        <p className="friend-feed-settings-hint">恢复外观与互动默认值，保留网名和小号。点击保存后生效。</p></>}
    </div>;
}
