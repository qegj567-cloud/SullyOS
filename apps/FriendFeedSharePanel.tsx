import React,{useRef,useState} from 'react';
import type {CharacterGroup,CharacterProfile} from '../types';
import type {FriendPost} from '../utils/friendFeed';
import {shareFriendPost} from '../utils/friendFeedShare';
import {createLocalId} from '../utils/localId.js';
import FriendFeedCharacterPicker from './FriendFeedGroupedList';

export default function FriendFeedSharePanel({post,characters,groups=[],imagesEnabled,onBack,onBusy}:{post?:FriendPost;characters:CharacterProfile[];groups?:CharacterGroup[];imagesEnabled:boolean;onBack:()=>void;onBusy:(busy:boolean)=>void}) {
    const [target,setTarget]=useState(''),[busy,setBusy]=useState(false),[sent,setSent]=useState(''),[error,setError]=useState(''),[warning,setWarning]=useState('');
    const delivery=useRef(createLocalId()),running=useRef(false);
    if(!post)return <p className="friend-feed-empty">这条动态已经不存在。</p>;
    async function send(){
        if(!post||!target||running.current)return;running.current=true;setBusy(true);onBusy(true);setError('');
        try{const result=await shareFriendPost(post.id,target,delivery.current);setWarning(result.warning||'');setSent(characters.find(c=>c.id===target)?.name||'角色');}
        catch(e){setError(e instanceof Error?e.message:'分享失败，请重试');}
        finally{running.current=false;setBusy(false);onBusy(false);}
    }
    return <div className="friend-feed-form ff-share-panel"><h2>分享给角色</h2>
        <p className="ff-share-preview-author">{post.authorName}</p><p className="ff-share-preview-text">{post.text}</p>
        {sent?<><p role="status">已分享到 {sent} 的私聊。</p>{warning&&<p className="ff-discussion-hint">{warning}</p>}<button className="friend-feed-primary" onClick={onBack}>完成</button></>:<>
            <p className="ff-discussion-hint">发送帖子原文、最近 10 条可读取的微博原评论和全部本地评论。{imagesEnabled?'同时附带可读取的配图；下次对话使用支持图片的模型或已配置的识图 API。':'配图只在卡片展示；可在哔哔设置中开启图片输入。'}这是一次分享，不会开启自动浏览。</p>
            <FriendFeedCharacterPicker characters={characters} groups={groups} value={target} onChange={setTarget} label="分享对象" disabled={busy}/>
            {!characters.length&&<p>还没有可接收的角色。</p>}{error&&<p role="alert">{error}</p>}
            <div className="friend-feed-form-actions"><button onClick={onBack} disabled={busy}>取消</button><button className="friend-feed-primary" disabled={!target||busy} onClick={()=>void send()}>{busy?'正在整理帖子…':'发送到私聊'}</button></div>
        </>}
    </div>;
}
