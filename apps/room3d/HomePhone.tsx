import {trackHomeFeature} from '../../utils/homeAnalytics';
import {AMSG_INSTANT_CHAT_PENDING_EVENT,AMSG_INSTANT_CHAT_PENDING_LS_KEY,getInstantChatPending} from '../../utils/amsgInstantChat';
import HomePhotoMode from './HomePhotoMode';
import {CHAT_GEN_EVENTS,registerEmbeddedChatView} from '../../utils/chatGenEvents';
import {shareOrDownloadBlob} from '../../utils/shareExport';
import {useOS} from '../../context/OSContext';
import type {HomePhoneChatProps} from '../Chat';
import React,{lazy,Suspense,useEffect,useRef,useState} from 'react';
import {Camera,ChatCircleDots,ArrowLeft,X,DownloadSimple} from '@phosphor-icons/react';
import BibiIcon from '../../components/os/BibiIcon';
import {useLocalBackHandler} from '../../hooks/useLocalBackHandler';
import {handleLocalBack} from '../../utils/localBackHandlers';
import type {HomeEditor} from './editor';
import './homePhone.css';
const Chat=lazy(()=>import('../Chat'));
const FriendFeed=lazy(()=>import('../FriendFeedApp'));
function PhoneMessages({homePhone}:{homePhone:HomePhoneChatProps}){const {characters}=useOS();return characters.some(c=>c.id===homePhone.characterId)?<Chat homePhone={homePhone}/>:<p className="home-phone-loading" role="status">正在读取聊天对象…</p>;}

function PhoneArt(){return <svg viewBox="0 0 64 80" aria-hidden="true"><g transform="rotate(-9 32 40)"><rect x="12" y="4" width="42" height="70" rx="13" fill="var(--home-phone-case,#b7dfc5)" stroke="var(--home-phone-ink,#718d72)" strokeWidth="2.2"/><rect x="17" y="15" width="32" height="44" rx="6" fill="#fffbea"/><path d="M28 10h10" stroke="var(--home-phone-ink,#718d72)" strokeWidth="2.5" strokeLinecap="round"/><circle cx="33" cy="66" r="3" fill="#fffbea"/><path d="M24 33q9-10 18 0v11H24z" fill="#ebc57b"/><path d="M21 33l12-10 12 10" fill="none" stroke="#a37d48" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/><circle cx="29" cy="36" r="1.2" fill="#80663e"/><circle cx="37" cy="36" r="1.2" fill="#80663e"/><path d="M30 40q3 3 6 0" fill="none" stroke="#80663e" strokeWidth="1.5" strokeLinecap="round"/></g><path d="M54 5v8m-4-4h8" stroke="#d8ae62" strokeWidth="2" strokeLinecap="round"/></svg>}

export default function HomePhone({editor,characterId,onOpenChange,onBusyChange,onPhotoChange}:{onPhotoChange?:(active:boolean)=>void;onBusyChange?:(busy:boolean)=>void;editor:HomeEditor;characterId:string;onOpenChange:(open:boolean)=>void}){
 const [page,setPage]=useState<'closed'|'home'|'chat'|'photo'|'camera'|'feed'>('closed'),[photo,setPhoto]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [unread,setUnread]=useState(false),[visible,setVisible]=useState(!document.hidden);
 useEffect(()=>()=>onPhotoChange?.(false),[onPhotoChange]);
 useEffect(()=>{if(page==='chat')return registerEmbeddedChatView(characterId);},[page,characterId]);
 const pageRef=useRef(page);pageRef.current=page;
 const photoBlob=useRef<Blob>(),photoRef=useRef(''),alive=useRef(true),captureVersion=useRef(0),trigger=useRef<HTMLButtonElement>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;captureVersion.current++;if(photoRef.current)URL.revokeObjectURL(photoRef.current);};},[]);
 const change=(next:typeof page)=>{if(next!==page){if(next==='home'&&page==='closed')trackHomeFeature('phone');else if(next==='chat')trackHomeFeature('phone-chat');else if(next==='camera')trackHomeFeature('camera');}captureVersion.current++;setPage(next);if(next==='chat'&&!document.hidden)setUnread(false);onOpenChange(next!=='closed');onPhotoChange?.(next==='camera');if(next==='closed')trigger.current?.focus();};
 useLocalBackHandler(()=>{change(page==='home'?'closed':'home');return true;},65,page!=='closed'&&page!=='camera');
 useEffect(()=>{if(page==='closed'||page==='camera')return;const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();if(page==='feed')handleLocalBack();else change('closed');}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[page]);
 useEffect(()=>{
  let stopTimer:ReturnType<typeof setTimeout>|undefined;let localBusy=false;
  const pending=()=>!!getInstantChatPending(characterId);
  const syncBusy=()=>{const busy=localBusy||pending();onBusyChange?.(busy);return busy;};
  const stop=()=>{clearTimeout(stopTimer);editor.setPhoneReply(false);};
  const hold=(ms:number)=>{clearTimeout(stopTimer);editor.setPhoneReply(true);stopTimer=setTimeout(()=>{if((pending()||localBusy)&&!document.hidden)hold(120000);else stop();},ms);};
  const matches=(event:Event)=>(event as CustomEvent).detail?.charId===characterId;
  const start=(e:Event)=>{if(matches(e)){localBusy=true;syncBusy();if(!document.hidden)hold(120000);}};
  const end=(e:Event)=>{if(matches(e)){localBusy=false;if(syncBusy())return;clearTimeout(stopTimer);stopTimer=setTimeout(stop,2500);}};
  const arrived=(e:Event)=>{if(!matches(e))return;syncBusy();setUnread(document.hidden||pageRef.current!=='chat');if(!document.hidden)hold(6000);};
  const hidden=()=>{setVisible(!document.hidden);if(document.hidden)stop();else if(pageRef.current==='chat')setUnread(false);};
  const pendingChanged=(e:Event)=>{if(!matches(e))return;if(syncBusy()){if(!document.hidden)hold(120000);}else{clearTimeout(stopTimer);stopTimer=setTimeout(stop,2500);}};
  const storage=(e:StorageEvent)=>{if(e.key===AMSG_INSTANT_CHAT_PENDING_LS_KEY){syncBusy();if(!pending()){clearTimeout(stopTimer);stopTimer=setTimeout(stop,2500);}}};
  window.addEventListener('storage',storage);
  syncBusy();if(pending()&&!document.hidden)hold(120000);
  window.addEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT,pendingChanged);
  window.addEventListener(CHAT_GEN_EVENTS.replyStart,start);window.addEventListener(CHAT_GEN_EVENTS.replyEnd,end);window.addEventListener(CHAT_GEN_EVENTS.replyArrived,arrived);window.addEventListener('active-msg-received',arrived);document.addEventListener('visibilitychange',hidden);
  return()=>{window.removeEventListener('storage',storage);window.removeEventListener(AMSG_INSTANT_CHAT_PENDING_EVENT,pendingChanged);stop();onBusyChange?.(false);window.removeEventListener(CHAT_GEN_EVENTS.replyStart,start);window.removeEventListener(CHAT_GEN_EVENTS.replyEnd,end);window.removeEventListener(CHAT_GEN_EVENTS.replyArrived,arrived);window.removeEventListener('active-msg-received',arrived);document.removeEventListener('visibilitychange',hidden);};
 },[editor,characterId,onBusyChange]);
 useEffect(()=>{if(!unread||!visible)return;const buzz=()=>{try{navigator.vibrate?.([35,45,35]);}catch{}};buzz();const timer=setInterval(buzz,2400);return()=>{clearInterval(timer);try{navigator.vibrate?.(0);}catch{}};},[unread,visible]);
 const shoot=async()=>{const version=++captureVersion.current;setBusy(true);setError('');try{const blob=await editor.capturePhoto();if(!alive.current||version!==captureVersion.current)return;if(photoRef.current)URL.revokeObjectURL(photoRef.current);photoBlob.current=blob;photoRef.current=URL.createObjectURL(blob);setPhoto(photoRef.current);setPage('photo');onOpenChange(true);}catch{if(alive.current)setError('没拍好，再试一次吧');}finally{if(alive.current)setBusy(false);}};
 if(page==='camera')return <HomePhotoMode editor={editor} onClose={()=>change('home')}/>;
 return <>
  {page==='closed'&&<button ref={trigger} className={`home-phone-launch${unread&&visible?' is-buzzing':''}`} aria-label="打开小手机" onClick={()=>change('home')}><PhoneArt/>{unread&&<i className="home-phone-unread" aria-label="有新消息"/>}<span>小手机</span></button>}
  {page!=='closed'&&<section className={`home-phone${unread&&visible?' is-buzzing':''}`} role="dialog" aria-label="家园小手机">
   <div className="home-phone-top"><button aria-label="返回手机首页" onClick={()=>change('home')} disabled={page==='home'}><ArrowLeft size={17}/></button><span className="home-phone-speaker"/><button aria-label="收起小手机" onClick={()=>change('closed')}><X size={18}/></button></div>
   <div className="home-phone-screen">
    {page==='home'&&<div className="home-phone-home"><div className="home-phone-greeting"><PhoneArt/><small>HOME, SWEET HOME</small><h2>今天，也想靠近你</h2><p>就在身边，也有想发给你的话。</p></div><div className="home-phone-apps"><button onClick={()=>change('chat')}><span><ChatCircleDots size={35} weight="duotone"/></span>信息</button><button disabled={busy} onClick={()=>change('camera')}><span><Camera size={35} weight="duotone"/></span>{busy?'拍摄中…':'拍照'}</button><button onClick={()=>change('feed')}><span><BibiIcon variant="island" size={40}/></span>哔哔</button></div>{error&&<p role="alert">{error}</p>}<span className="home-phone-flower" aria-hidden="true">✿</span></div>}
    {page==='feed'&&<Suspense fallback={<p className="home-phone-loading" role="status">正在打开哔哔…</p>}><FriendFeed embedded initialCharacterId={characterId} onBack={()=>change('home')}/></Suspense>}
    {page==='chat'&&<Suspense fallback={<p className="home-phone-loading" role="status">正在打开信息…</p>}><PhoneMessages homePhone={{characterId,onBack:()=>change('home'),getContext:()=>{const scene=editor.getHomeScene();return scene.present?`【家园手机聊天】此刻你们都在家园里，当前房间是${JSON.stringify(scene.roomName)}。你们正在用手机发信息；沿用正常私聊的交流方式。`:`【家园手机聊天】对方正在家园的${JSON.stringify(scene.roomName)}用手机给你发信息；你当前不在这个房间，不要假定彼此面对面。`;}}}/></Suspense>}
    {page==='photo'&&<div className="home-phone-photo"><h2>把这一刻收好</h2><img src={photo} alt="刚拍下的家园"/><div><button disabled={busy} onClick={shoot}><Camera size={19}/>重拍</button><button onClick={()=>{if(photoBlob.current)void shareOrDownloadBlob({blob:photoBlob.current,fileName:"家园合影.png",shareTitle:"家园合影",preferDownloadOnWeb:true}).catch(()=>setError("照片保存失败，请重试"));}}><DownloadSimple size={19}/>保存照片</button></div>{error&&<p role="alert">{error}</p>}</div>}
   </div><span className="home-phone-homebar"/>
  </section>}
 </>;
}
