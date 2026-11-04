import {friendPostImages,friendPostMediaCount} from '../utils/friendFeedImages';
import React, {useState} from 'react';
import {ArrowLeft, ArrowSquareOut, ChatCircle, DotsThree, GearSix, House, PencilSimple, Plus, Trash, UserCircle, UsersThree} from '@phosphor-icons/react';
import type {CharacterProfile, UserProfile} from '../types';
import type {FriendCircle, FriendPost} from '../utils/friendFeed';
import FriendFeedAvatar from './FriendFeedAvatar';
import FriendFeedImages from './FriendFeedImages';
import {FriendFeedCoverLayer} from './FriendFeedCover';
import {FriendFeedSourceQuote} from './FriendFeedTikHub';

export type SocialTheme = 'weibo' | 'twitter';
export function SocialHeader({theme, profileId, profileName, count, onBack, onProfile, onSettings, notifications}: {
    notifications?:React.ReactNode;
    theme:SocialTheme;profileId:string;profileName:string;count:number;onBack:()=>void;onProfile:(id:string)=>void;onSettings:()=>void;
}) {
    return <header className={`ff-social-header ff-${theme}-header`}>
        <button onClick={onBack} aria-label={profileId?'返回哔哔':'返回桌面'}><ArrowLeft size={23}/></button>
        {theme==='weibo'&&!profileId ? <div className="ff-weibo-top-tabs"><button className="is-active" onClick={()=>onProfile('')}>关注</button>
            <button onClick={()=>onProfile('user')}>我的</button><small>哔哔</small></div>
            : <div className="ff-social-title"><h1>{profileId?profileName:'主页'}</h1><small>{profileId?`${count} 条动态`:'哔哔'}</small></div>}
        {notifications}<button onClick={onSettings} aria-label="哔哔设置"><GearSix size={22}/></button>
    </header>;
}

export function SocialBottomNav({theme, profileId, canPost, onProfile, onCircle, onSources, onCompose}: {
    theme:SocialTheme;profileId:string;canPost:boolean;onProfile:(id:string)=>void;onCircle:()=>void;onSources:()=>void;onCompose:()=>void;
}) {
    return <>
        {theme==='twitter' && canPost && <button className="ff-twitter-fab" aria-label="发布新动态" onClick={onCompose}><PencilSimple size={25}/><Plus size={12}/></button>}
        <nav className={`ff-social-bottom ff-${theme}-bottom`} aria-label="哔哔底部导航">
            <button aria-label="朋友动态" title="再次点击刷新首页" aria-current={!profileId?'page':undefined} onClick={()=>onProfile('')}><House size={24} weight={!profileId?'fill':'regular'}/><span>首页</span></button>
            <button aria-label="账号与偏好" onClick={onCircle}><UsersThree size={24}/><span>偏好</span></button>
            {theme==='weibo'&&<button className="ff-weibo-write" aria-label="发布新动态" disabled={!canPost} onClick={onCompose}><Plus size={28}/></button>}
            {theme==='twitter'&&<button onClick={onSources} aria-label="管理动态来源"><ArrowSquareOut size={23}/><span>来源</span></button>}
            <button aria-label="我的主页" aria-current={profileId==='user'?'page':undefined} onClick={()=>onProfile('user')}><UserCircle size={25} weight={profileId==='user'?'fill':'regular'}/><span>我的</span></button>
            {theme==='weibo'&&<button onClick={onSources} aria-label="管理动态来源"><ArrowSquareOut size={23}/><span>来源</span></button>}
        </nav>
    </>;
}

export function SocialProfile({theme,name,avatar,posts,circle,onSettings,canManage,onFollowing,followingCount,coverImage,onEditCover}: {
    theme:SocialTheme;name:string;avatar?:string;posts:FriendPost[];circle:FriendCircle;onSettings:()=>void;canManage:boolean;onFollowing?:()=>void;followingCount?:number;coverImage?:string;onEditCover?:()=>void;
}) {
    const pictures=posts.filter(p=>friendPostMediaCount(p)).length, replies=posts.reduce((n,p)=>n+p.comments.length,0);
    return <section className={`ff-social-profile ff-${theme}-profile`} aria-label={`${name}的个人主页`}>
        <div className="ff-profile-cover"><FriendFeedCoverLayer value={coverImage} onEdit={canManage?onEditCover:undefined}/></div>
        <div className="ff-profile-identity"><FriendFeedAvatar name={name} avatar={avatar}/>
            {canManage&&<button className="ff-profile-edit" onClick={onSettings}>主页设置</button>}
            <h2>{name}</h2><p>{circle.name}</p></div>
        <div className="ff-profile-stats"><span><b>{posts.length}</b> 动态</span>{onFollowing?<button aria-label="我的关注" onClick={onFollowing}><b>{followingCount}</b> 角色关注</button>:<span><b>{pictures}</b> 图文</span>}<span><b>{replies}</b> 收到的评论</span></div>
    </section>;
}

export function SocialToolbar({theme,filter,onFilter}: {
    theme:SocialTheme;filter:'all'|'photos';onFilter:(filter:'all'|'photos')=>void;
}) {
    return <div className={`ff-social-toolbar ff-${theme}-toolbar`}>
        <nav className="ff-social-filter" aria-label="动态内容筛选"><button aria-pressed={filter==='all'} onClick={()=>onFilter('all')}>全部动态</button>
            <button aria-pressed={filter==='photos'} title="只看带图片的动态" onClick={()=>onFilter('photos')}>图片</button></nav>
    </div>;
}

export function SocialComposer({theme,user,onCompose}: {theme:SocialTheme;user:UserProfile;onCompose:()=>void}) {
    return <div className={`ff-social-composer ff-${theme}-composer`}>
        <FriendFeedAvatar name={user.name||'我'} avatar={user.avatar}/>
        <button className="ff-compose-placeholder" onClick={onCompose}>{theme==='weibo'?'分享你的新鲜事…':'有什么新鲜事？'}</button>
        {theme==='twitter'&&<div className="ff-compose-bottom"><small>发布到公共广场</small><button onClick={onCompose}>发布</button></div>}
        {theme==='weibo'&&<button className="ff-compose-pencil" onClick={onCompose} aria-label="写动态"><PencilSimple size={20}/></button>}
    </div>;
}

export function SocialPost({theme,post,user,characters,onProfile,onComment,onDelete,children}: {
    theme:SocialTheme;post:FriendPost;user:UserProfile;characters:CharacterProfile[];onProfile:(id:string,accountId?:string)=>void;onComment:()=>void;onDelete?:()=>void;children?:React.ReactNode;
}) {
    const [fullText,setFullText]=useState(false);
    const textCharacters=Array.from(post.text), textLimit=theme==='weibo'?220:320;
    const name=post.accountId&&post.accountId!=='main'?post.authorName:post.authorId==='user'?user.name||'我':characters.find(c=>c.id===post.authorId)?.name||post.authorName;
    const avatar=post.accountId&&post.accountId!=='main'?undefined:post.authorId==='user'?user.avatar:characters.find(c=>c.id===post.authorId)?.avatar||(post.authorId.startsWith('weibo:')||post.authorKind==='external'?post.source?.authorAvatar:undefined);
    const visible=post.comments.slice(0,2);
    const time=new Date(post.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    return <article className={`ff-social-post ff-${theme}-post${post.synced?' is-real':''}`} tabIndex={0} aria-label={`查看动态评论区：${post.text.slice(0,30)}`}
        onClick={e=>{if(!(e.target as Element).closest('button,a,input,summary,details,dialog')&&!window.getSelection()?.toString())onComment();}}
        onKeyDown={e=>{if(e.target===e.currentTarget&&e.key==='Enter')onComment();}}>
        <header className="ff-post-byline"><button className="ff-byline-avatar" onClick={()=>onProfile(post.authorId,post.accountId)} aria-label={`查看${name}的主页`}><FriendFeedAvatar name={name} avatar={avatar}/></button>
            <div className="ff-byline-identity"><button onClick={()=>onProfile(post.authorId,post.accountId)}>{name}</button>
                <time dateTime={new Date(post.createdAt).toISOString()}>{time}</time>
                {theme==='weibo'&&post.synced&&<span>来自真实微博</span>}</div>
            {onDelete&&<details className="ff-post-menu"><summary aria-label="动态操作"><DotsThree size={23}/></summary><button onClick={onDelete}><Trash size={15}/>删除动态</button></details>}
        </header>
        <div className="ff-post-content">
            {!!post.accountTags?.length&&<small className="ff-account-tags">{post.accountTags.map(t=>`#${t}`).join(' · ')}</small>}
            {post.authorKind!=='external'&&<><p className="ff-post-text">{fullText||textCharacters.length<=textLimit?post.text:textCharacters.slice(0,textLimit).join('')+'…'}</p>
                {textCharacters.length>textLimit&&<button className="ff-read-more" onClick={()=>setFullText(v=>!v)}>{fullText?'收起':theme==='weibo'?'展开全文':'显示更多'}</button>}</>}
            {post.source&&!post.synced&&<FriendFeedSourceQuote source={post.source}/>}
            {friendPostMediaCount(post) ? <FriendFeedImages images={friendPostImages(post)} imageCards={post.imageCards} previewLimit={theme==='twitter'?4:9}/> : null}
            {post.source?.truncated&&<small className="ff-post-excerpt">正文摘录 · 完整内容见原文</small>}
            {theme==='twitter'&&post.synced&&<span className="ff-real-label">来自真实微博</span>}
        </div>
        <footer className="ff-post-actions">
            <button onClick={onComment}><ChatCircle size={19}/><span>{theme==='weibo'?'评论':''}{post.comments.length ? ` ${post.comments.length}` : theme==='twitter'?'回复':''}</span></button>
            {post.source&&<a href={post.source.url} target="_blank" rel="noopener noreferrer"><ArrowSquareOut size={18}/><span>查看原文</span></a>}
        </footer>
        {!!visible.length&&<div className="ff-post-replies">{visible.map(c=><div className="ff-post-reply" key={c.id}>
            {theme==='twitter'&&<FriendFeedAvatar name={c.authorName} avatar={c.authorId==='user'?user.avatar:characters.find(char=>char.id===c.authorId)?.avatar}/>}
            <p><strong>{c.authorName}</strong><span>{theme==='weibo'?'：':''}{c.text}</span></p></div>)}
            {post.comments.length>2&&<button className="ff-expand-replies" onClick={onComment}>{`查看全部 ${post.comments.length} 条回复`}</button>}
        </div>}
        {children}
    </article>;
}
