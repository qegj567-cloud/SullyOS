import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {CharacterProfile,UserProfile} from '../../types';
import type {FriendFeedState} from '../../utils/friendFeed';
import {defaultFriendFeedSettings} from '../../utils/friendFeedSettings';
import {normalizeFriendGraph,friendAccountRef,setFriendAccountFollow} from '../../utils/friendFeedGraph';
import FriendFeedRelations from '../../apps/FriendFeedRelations';
import '../../apps/friendFeed.css';
import '../../apps/friendFeedSettings.css';
import '../../apps/friendFeedSocialThemes.css';

const characters=[{id:'preview-a',name:'阿青'},{id:'preview-b',name:'顾夏'}] as CharacterProfile[];
const initial:FriendFeedState={version:1,publicFeed:true,circles:[{id:'public',name:'广场',description:'',createdAt:0,memberIds:characters.map(c=>c.id)}],posts:[],settings:{...defaultFriendFeedSettings(),userNickname:'橘子汽水',identities:{
    'preview-a':{nickname:'青柠',tags:[],accounts:[]},
    'preview-b':{nickname:'下班再说',tags:[],accounts:[{id:'coffee',name:'每天一杯',purpose:'咖啡账号',tags:['咖啡']},{id:'rant',name:'半夜吃面',purpose:'匿名吐槽',tags:[]},{id:'photo',name:'慢半拍',purpose:'摄影',tags:['摄影']}]},
}}};
normalizeFriendGraph(initial,characters);
const a=friendAccountRef(initial,{authorId:'preview-a'})!,coffee=friendAccountRef(initial,{authorId:'preview-b',accountId:'coffee'})!,rant=friendAccountRef(initial,{authorId:'preview-b',accountId:'rant'})!;
setFriendAccountFollow(initial,a.id,coffee.id,true);setFriendAccountFollow(initial,coffee.id,a.id,true);setFriendAccountFollow(initial,a.id,rant.id,true);
initial.posts.push({id:'preview-rant-post',authorId:'preview-b',accountId:'rant',authorName:'半夜吃面',text:'面又煮多了',createdAt:0,circleId:'public',audienceIds:[],comments:[]});
function Preview(){
    const [feed,setFeed]=useState(initial);
    return <><style>{`*{box-sizing:border-box}html,body,#root{margin:0;min-height:100%;font-family:system-ui,sans-serif}body{background:#e8ebe3;color:#34483e}.preview-caption{max-width:420px;margin:24px auto 16px;padding:0 16px;font-size:12px;line-height:1.8}.preview-phone{max-width:420px;height:820px;max-height:88vh;margin:0 auto 24px;border-radius:24px;overflow:auto;scrollbar-width:none;box-shadow:0 12px 40px #223b2710}.preview-phone>.friend-feed{height:auto;min-height:100%}@media(max-width:480px){.preview-caption{margin:12px auto}.preview-phone{width:100%;border-radius:0;height:auto;max-height:none;margin:0;box-shadow:none}}`}</style>
        <p className="preview-caption">哔哔 · 关系设置预览<br/>仅示例数据，可以修改开关和切换角色视角；不保存、不调用 API。</p>
        <div className="preview-phone"><section className="friend-feed" data-theme="island"><FriendFeedRelations feed={feed} characters={characters} user={{name:'小雨'} as UserProfile} initialOwner="preview-a" onChange={async change=>{
            setFeed(previous=>{const next=structuredClone(previous);if(change.kind==='follow')setFriendAccountFollow(next,change.sourceId,change.targetId,change.value);else(next.accountGraph!.known[change.viewerId] ||= {})[change.targetId]=change.value;return next;});
        }}/></section></div></>;
}
const root=createRoot(document.getElementById('root')!);
root.render(<Preview/>);
if(import.meta.hot)import.meta.hot.dispose(()=>root.unmount());
