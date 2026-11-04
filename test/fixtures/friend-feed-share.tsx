/** Synthetic snapshots only. No DB writes, model calls, or real identities. */
import React from 'react';
import {createRoot} from 'react-dom/client';
import ChatMessage from '../../components/chat/MessageItem';
import {PRESET_THEMES} from '../../components/chat/ChatConstants';
import {CHAT_TYPE_SAMPLES} from '../../utils/chatPreviewFixtures';
import '../../components/chat/chatPreview.generated.css';
import type {Message} from '../../types';
const photo=await (await fetch('/anniversary/cake-stripes.jpg')).blob();
const image=await new Promise<string>(resolve=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.readAsDataURL(photo);});
const sample=CHAT_TYPE_SAMPLES.friend_feed_share_card;
const rows:Message[]=[{...CHAT_TYPE_SAMPLES.text,id:901,role:'user',content:'这个看起来好好吃，下次一起做？'},
    {...sample,id:902,metadata:{friendFeedShare:{...sample.metadata!.friendFeedShare,authorId:'npc:baker',authorName:'巷口烘焙日记',text:'奶油不用抹得太整齐。\n草莓要挑甜的，下午要留给喜欢的人。',imagesEnabled:true,imageRefs:[image],imageCount:1}}},
    {...sample,id:903}];
const avatar=(name:string,color:string)=>'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="24" fill="${color}"/><text x="24" y="32" text-anchor="middle" fill="#6d756c" font-size="24">${name}</text></svg>`);
createRoot(document.getElementById('root')!).render(<main><h1>把刷到的日常，分享给 TA</h1><p>轻量分享卡 · 无内边框 · 点击卡片可展开原文与评论</p><div className="previews">{[false,true].map(custom=><section className={'phone'+(custom?' custom':'')} key={String(custom)}><header>小白<small>{custom?'叠加全局白框美化':'卡片原生样式'}</small></header><div className="conversation">{rows.map(msg=><ChatMessage key={msg.id} msg={msg} isFirstInGroup isLastInGroup activeTheme={PRESET_THEMES.default} charAvatar={avatar('白','#dde2d6')} charName="小白" userAvatar={avatar('雨','#e4dfd1')} onLongPress={()=>{}} onReply={()=>{}} selectionMode={false} isSelected={false} onToggleSelect={()=>{}}/>)}</div><p className="caption">卡片只展示摘要；角色上下文保留原文与分享时的评论。</p></section>)}</div></main>);
