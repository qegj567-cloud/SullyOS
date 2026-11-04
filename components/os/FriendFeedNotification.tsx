import React,{useEffect,useRef,useState} from 'react';
import {X} from '@phosphor-icons/react';
import {useOS} from '../../context/OSContext';
import {AppID} from '../../types';
import {readFriendFeed,subscribeFriendFeed} from '../../utils/friendFeed';
import {claimFriendInboxAnnouncements,friendUserInbox,requestFriendInbox} from '../../utils/friendFeedInbox';
import BibiIcon from './BibiIcon';
import './friendFeedNotification.css';

/** App-wide banner; no OS notification permission or additional API request. */
export default function FriendFeedNotification(){
    const {openApp}=useOS();
    const [items,setItems]=useState<ReturnType<typeof friendUserInbox>>([]);
    const timer=useRef<ReturnType<typeof setTimeout>>();
    useEffect(()=>{
        let alive=true,running=false,again=false;
        const refresh=async()=>{
            if(document.visibilityState==='hidden')return;
            if(running){again=true;return;}running=true;
            try{do{
                again=false;
                const rows=friendUserInbox(await readFriendFeed());if(!alive)return;
                const unread=new Set(rows.filter(r=>!r.notice.read).map(r=>r.notice.id));
                setItems(previous=>previous.some(r=>!unread.has(r.notice.id))?previous.filter(r=>unread.has(r.notice.id)):previous);
                if(rows.some(r=>!r.notice.read&&!r.notice.announced)){
                    const fresh=await claimFriendInboxAnnouncements();if(!alive)return;
                    if(fresh.length){setItems(previous=>[...fresh,...previous.filter(r=>!fresh.some(n=>n.notice.id===r.notice.id))]);
                        clearTimeout(timer.current);timer.current=setTimeout(()=>setItems([]),8000);}
                }
            }while(again&&alive);
            }catch{ /* Durable inbox remains unread; retry on the next feed event/focus. */ }
            finally{running=false;}
        };
        void refresh();const stop=subscribeFriendFeed(()=>void refresh());
        const visible=()=>void refresh();document.addEventListener('visibilitychange',visible);
        return()=>{alive=false;stop();clearTimeout(timer.current);document.removeEventListener('visibilitychange',visible);};
    },[]);
    if(!items.length)return null;
    const first=items[0],samePost=items.every(r=>r.notice.postId===first.notice.postId);
    const message=items.length>1?`收到了 ${items.length} 条新互动`:`${first.comment.authorName}${first.notice.kind==='reply'?'回复了你的评论':'评论了你的动态'}`;
    return <aside className="bibi-global-notification" role="status" aria-label="哔哔新互动提醒">
        <BibiIcon size={30}/><button className="bibi-notification-open" onClick={()=>{requestFriendInbox(samePost?{postId:first.notice.postId,commentId:first.notice.commentId}:{});openApp(AppID.FriendFeed);setItems([]);}}><strong>哔哔 · 新回复</strong><span>{message}</span><small>查看 →</small></button>
        <button className="bibi-notification-close" aria-label="收起哔哔提醒" onClick={()=>setItems([])}><X size={17}/></button>
    </aside>;
}
