import {friendPostImages,friendPostMediaCount} from '../utils/friendFeedImages';
import React, {useState} from 'react';
import {ArrowLeft, ChatCircle, DotsThree, GearSix, PlusCircle, Trash, UserCircle} from '@phosphor-icons/react';
import type {CharacterProfile, UserProfile} from '../types';
import type {FriendPost} from '../utils/friendFeed';
import FriendFeedAvatar from './FriendFeedAvatar';
import FriendFeedImages from './FriendFeedImages';
import {FriendFeedCoverLayer} from './FriendFeedCover';
import {FriendFeedSourceQuote} from './FriendFeedTikHub';
type Theme = 'island' | 'moments' | 'insta' | 'journal';

export function ClassicHeader({theme, onBack, onSettings, onProfile, onHome, notifications, backLabel}: {notifications?: React.ReactNode; theme: Theme; onBack: () => void; onSettings: () => void; onProfile: () => void; onHome: () => void; backLabel?: string}) {
    return <header className={`ff-classic-header ff-${theme}-header`}>
        <div className="ff-header-leading"><button aria-label={backLabel || '返回桌面或小手机'} onClick={onBack}><ArrowLeft size={22}/></button>{notifications}</div>
        <h1><button className="ff-feed-title" aria-label="朋友动态" title="返回首页；在首页再次点击刷新" onClick={onHome}>{theme === 'island' ? '岛上来信' : theme === 'moments' ? '朋友圈' : theme === 'insta' ? 'Instants' : 'SIDE B'}</button></h1>
        <div className="ff-header-trailing"><button aria-label="哔哔设置" onClick={onSettings}><GearSix size={21}/></button>
        <button aria-label="我的主页" onClick={onProfile}><UserCircle size={24}/></button></div>
    </header>;
}
export function ClassicComposer({user,onCompose}:{user:UserProfile;onCompose:()=>void}) {
    return <button type="button" className="ff-classic-compose" aria-label="发布新动态" onClick={onCompose}>
        <FriendFeedAvatar name={user.name||'我'} avatar={user.avatar}/><span>分享今天的新鲜事…</span><PlusCircle size={24}/>
    </button>;
}
function Landscape() {
    return <svg viewBox="0 0 600 240" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <path fill="#a4bdc5" d="M0 0h600v240H0z"/><circle cx="455" cy="60" r="27" fill="#f1e7ce"/>
        <path fill="#718f8e" d="M0 145 88 68l92 75 105-104 111 98 94-32 110 43v92H0Z"/>
        <path fill="#405f65" d="m0 161 109-49 130 76 133-53 98 41 130-54v118H0Z"/>
        <path fill="#24474d" d="m0 204 141-35 136 52 144-23 179 17v25H0Z"/>
    </svg>;
}
export function ClassicCover({theme, user, count, onProfile,coverImage,onEditCover}: {theme: Theme; user: UserProfile; count: number; onProfile: () => void;coverImage?:string;onEditCover?:()=>void}) {
    if (theme === 'moments') return <section className="ff-classic-cover ff-moments-cover"><Landscape/><FriendFeedCoverLayer value={coverImage} onEdit={onEditCover}/><button className="ff-cover-profile" onClick={onProfile}><strong>{user.name || '我'}</strong><FriendFeedAvatar name={user.name || '我'} avatar={user.avatar}/></button></section>;
    if (theme === 'insta') return <section className="ff-classic-cover ff-insta-cover"><span>YOUR DAILY EDIT</span><button onClick={onProfile}><FriendFeedAvatar name={user.name || '我'} avatar={user.avatar}/>我的日常 ↗</button></section>;
    if (theme === 'journal') return <section className="ff-classic-cover ff-journal-cover"><div><span>生活的另一面</span><span>{String(count).padStart(2, '0')} ENTRIES</span></div><h2>日常，<br/><em>正在发生。</em></h2><footer><span>PERSONAL / PUBLIC</span><button onClick={onProfile}>我的专栏 ↗</button></footer></section>;
    return <section className="ff-classic-cover ff-island-cover"><div><small>岛民留言板</small><h2>今天也有<br/>新鲜的小事。</h2><p>熟人来信，也有偶遇。</p></div><svg viewBox="0 0 140 120" aria-hidden="true"><ellipse cx="72" cy="106" rx="53" ry="8" fill="#52826922"/><g transform="rotate(-10 70 60)"><rect x="20" y="18" width="82" height="69" rx="7" fill="#fffbed"/><path d="M34 34h49m-49 12h34" stroke="#c6bda3" strokeWidth="4"/><rect x="32" y="53" width="91" height="52" rx="9" fill="#efc56d"/><path d="m36 58 40 28 43-28" fill="none" stroke="#bb9551" strokeWidth="2"/><circle cx="77" cy="79" r="11" fill="#fff9df"/><path d="m72 79 4 4 7-8" stroke="#45866c" strokeWidth="3" fill="none"/></g></svg></section>;
}
export function ClassicProfile({theme, name, avatar, posts, onSettings, onFollowing, followingCount,coverImage,onEditCover}: {theme: Theme; name: string; avatar?: string; posts: FriendPost[]; onSettings: () => void;onFollowing?:()=>void;followingCount?:number;coverImage?:string;onEditCover?:()=>void}) {
    return <section className={`ff-classic-profile ff-${theme}-profile`}>
        {(theme === 'moments'||coverImage||onEditCover) && <div className="ff-profile-landscape"><Landscape/><FriendFeedCoverLayer value={coverImage} onEdit={onEditCover}/></div>}
        <FriendFeedAvatar name={name} avatar={avatar}/><div><small>{theme === 'journal' ? 'CONTRIBUTOR' : '个人主页'}</small><h2>{name}</h2><p>{posts.length} 条动态 · {posts.filter(p=>friendPostMediaCount(p)).length} 篇图文</p>
            {onFollowing&&<button className="ff-profile-following" aria-label="我的关注" onClick={onFollowing}><b>{followingCount}</b> 角色关注</button>}</div>
        <button onClick={onSettings}>主页设置</button>
    </section>;
}
export function ClassicPost({theme, post, index, user, characters, onProfile, onComment, onDelete, children}: {
    theme: Theme; post: FriendPost; index: number; user: UserProfile; characters: CharacterProfile[];
    onProfile: (id: string,accountId?:string) => void; onComment: () => void; onDelete?: () => void; children?: React.ReactNode;
}) {
    const [fullText, setFullText] = useState(false);
    const name = post.accountId && post.accountId !== 'main' ? post.authorName : post.authorId === 'user' ? user.name || '我' : characters.find(c => c.id === post.authorId)?.name || post.authorName;
    const avatar = post.accountId&&post.accountId!=='main'?undefined:post.authorId === 'user' ? user.avatar : characters.find(c => c.id === post.authorId)?.avatar || (post.authorId.startsWith('weibo:')||post.authorKind==='external'?post.source?.authorAvatar:undefined);
    const time = new Date(post.createdAt).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
    const media = friendPostMediaCount(post) ? <FriendFeedImages images={friendPostImages(post)} imageCards={post.imageCards} carousel={theme === 'insta'}/> : null;
    const limit = theme === 'insta' ? 140 : theme === 'moments' ? 240 : 360;
    const text = Array.from(post.text), truncated = text.length > limit;
    const body = post.authorKind !== 'external' ? <><p className="ff-classic-text">{fullText || !truncated ? post.text : text.slice(0, limit).join('') + '…'}</p>
        {truncated && <button className="ff-classic-expand" onClick={() => setFullText(v => !v)}>{fullText ? '收起正文' : '展开全文'}</button>}</> : null;
    return <article className={`ff-classic-post ff-${theme}-entry${post.synced ? ' is-real' : ''}${media ? ' has-media' : ''}`} tabIndex={0} aria-label={`查看动态评论区：${post.text.slice(0,30)}`}
        onClick={e=>{if(!(e.target as Element).closest('button,a,input,summary,details,dialog')&&!window.getSelection()?.toString())onComment();}}
        onKeyDown={e=>{if(e.target===e.currentTarget&&e.key==='Enter')onComment();}}>
        {theme === 'journal' && <div className="ff-editorial-index"><span>{String(index + 1).padStart(2, '0')}</span><small>{media ? 'PHOTO DIARY' : 'FIELD NOTES'}</small></div>}
        <header className="ff-classic-byline"><button onClick={() => onProfile(post.authorId,post.accountId)} aria-label={`查看${name}的主页`}><FriendFeedAvatar name={name} avatar={avatar}/></button>
            <div><button onClick={() => onProfile(post.authorId,post.accountId)}><strong>{name}</strong></button><time dateTime={new Date(post.createdAt).toISOString()}>{time}</time></div>
            {onDelete&&<details className="ff-post-menu"><summary aria-label="动态操作"><DotsThree size={22}/></summary><button aria-label={`删除动态：${post.text.slice(0, 12)}`} onClick={onDelete}><Trash size={15}/>删除动态</button></details>}
        </header>
        <div className="ff-classic-content">
            {theme === 'insta' && media}
            {!!post.accountTags?.length && <small className="ff-account-tags">{post.accountTags.map(t => `#${t}`).join(' · ')}</small>}
            {body}
            {theme !== 'insta' && media}
            {post.source && !post.synced && <FriendFeedSourceQuote source={post.source}/>}
            {post.source && <a className="friend-feed-source-hint" href={post.source.url} target="_blank" rel="noopener noreferrer">{post.synced ? '来自真实微博' : post.authorKind === 'external' ? '导入的公开资料' : '角色转发'} ↗{post.source.truncated ? ' · 正文摘录' : ''}</a>}
        </div>
        <footer className="ff-classic-actions"><span>{theme === 'island' ? '留一句话吧' : theme === 'journal' ? 'CONVERSATION' : ''}</span><button className="friend-feed-comment-button" onClick={onComment}><ChatCircle size={theme === 'insta' ? 24 : 18}/>{post.comments.length ? `${post.comments.length} 条评论` : '评论'}</button></footer>
        {!!post.comments.length && <div className="ff-classic-replies">{post.comments.slice(0, theme === 'moments' ? 5 : 2).map(c => <p key={c.id}><strong>{c.authorName}</strong><span>：{c.text}</span></p>)}
            {post.comments.length > (theme === 'moments' ? 5 : 2) && <button onClick={onComment}>{`查看全部 ${post.comments.length} 条评论`}</button>}
        </div>}
        {children}
    </article>;
}
