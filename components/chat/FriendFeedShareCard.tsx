import React, {useState} from 'react';
import {ChatCircle,ArrowUpRight} from '@phosphor-icons/react';
import type {FriendFeedShareSnapshot} from '../../utils/friendFeedShareContext';
import {isWeiboImageUrl} from '../../utils/friendFeedSource';
import {getProxyWorkerUrl} from '../../utils/proxyWorker';
import FriendFeedImages from '../../apps/FriendFeedImages';
import TokenImg from '../os/TokenImg';
import {isBlobRef} from '../../utils/blobRef';
import {friendPostImages,friendPostMediaCount} from '../../utils/friendFeedImages';
import './friendFeedShareCard.css';

/** No nested card chrome: the outer ChatCardSurface belongs to the user's theme. */
export default function FriendFeedShareCard({share}:{share:FriendFeedShareSnapshot}) {
    const [failed,setFailed]=useState(0);
    const cover=share.source?.images?.[0]?.thumbnail;
    const safeCover=cover&&isWeiboImageUrl(cover)?cover:undefined;
    const local=share.images?.[0]?.thumbnail || share.imageRefs?.[0];
    const localCover=typeof local==='string'&&(isBlobRef(local)||local.startsWith('data:image/'))?local:undefined;
    const coverValue=failed===0&&localCover?localCover:failed===0?safeCover:failed===1&&safeCover?getProxyWorkerUrl().replace(/\/+$/,'')+'/weibo-image?url='+encodeURIComponent(safeCover):undefined;
    const source=share.source?.platform==='weibo'?'微博':'哔哔';
    return <details className="friend-feed-share-card">
        <summary><div className="ff-share-card-copy"><small>{source} · {share.authorName}</small><p>{share.text||share.imageCards?.[0]?.caption||'配图'}</p>
            <span><ChatCircle size={13}/>{share.comments.length} 条讨论{share.originalComments.length>0&&` · ${share.originalComments.length} 条原评论`}<ArrowUpRight size={14}/></span></div>
            {coverValue&&<TokenImg alt="分享帖子的封面" referrerPolicy="no-referrer" loading="lazy" value={coverValue} onError={()=>setFailed(n=>n+1)}/>}
        </summary>
        <div className="ff-share-card-expanded"><p>{share.text}</p>
            {share.source&&share.source.text!==share.text&&<p>{share.source.author}：{share.source.text}</p>}
            {share.source?.truncated&&<small>原平台目前只提供正文摘录。</small>}
            {!!friendPostMediaCount(share)&&<FriendFeedImages images={friendPostImages(share)} imageCards={share.imageCards}/>}
            {!!share.comments.length&&<section><h4>本地讨论 · 分享时的全部评论</h4>{share.comments.map(c=><p key={c.id}><strong>{c.authorName}</strong> {c.text}{c.localReply&&<small>回复 {c.localReply.authorName}：{c.localReply.text}</small>}{c.sourceReply&&<small>回复 {c.sourceReply.authorName}：{c.sourceReply.text}</small>}</p>)}</section>}
            {!!share.originalComments.length&&<section><h4>微博原评论 · 最近 {share.originalComments.length} 条</h4>{share.originalComments.map(c=><p key={c.id}><strong>{c.authorName}</strong> {c.text}</p>)}</section>}
            {share.warning&&<small>{share.warning}</small>}
            <small>分享时的内容 · 本地讨论不会发回微博</small>
        </div>
    </details>;
}
