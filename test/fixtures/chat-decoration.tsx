import React, {useState} from 'react';
import Appearance from '../../apps/Appearance';
import {OSProvider} from '../../context/OSContext';
import {createRoot} from 'react-dom/client';
import ChatDecorationPanel from '../../components/chat/ChatDecorationPanel';
import {PRESET_THEMES} from '../../components/chat/ChatConstants';
import {resolveDecorationTheme} from '../../utils/chatDecoration';
import {useBlobRefUrl} from '../../utils/blobRef';
import {buildChatFineTuneCss,mergeChatFineTune} from '../../utils/chatFineTuneCss';
import type {CharacterProfile,OSTheme} from '../../types';
const initial={id:'decoration-preview',name:'Sully',avatar:'',systemPrompt:'',bubbleStyle:'default',chromeCustomCss:'.sully-chat-name { letter-spacing: .05em; }',chatFineTune:{enabled:true,chatBubbleFontSize:15}} as CharacterProfile;
function Preview(){
 const [char,setChar]=useState(initial);const [theme,setTheme]=useState({chatBackgroundStyle:'plain'} as OSTheme);const [open,setOpen]=useState(true);const [workshop,setWorkshop]=useState(false);const [importedThemes,setImportedThemes]=useState<any[]>([]);const [draft,setDraft]=useState('');const [sent,setSent]=useState<string[]>([]);
 (window as any).decorationQA={char,theme};
 const effective=resolveDecorationTheme(theme,char);const fine=mergeChatFineTune(effective,char.chatFineTune);const bubble=[...Object.values(PRESET_THEMES),...importedThemes].find(b=>b.id===(char.bubbleStyle||theme.chatDefaultBubbleStyle||'default'));const background=useBlobRefUrl(char.chatBackground??theme.chatBackground);
 return <>
  <style>{buildChatFineTuneCss(fine)}{effective.chatChromeCustomCss}{char.chromeCustomCss}</style>
  <div className="sully-chat-root" style={{height:'100dvh',background:background?`url("${background}") center / cover`:'#f7f5fa',color:'#584b64',fontFamily:'system-ui',padding:'40px 24px 105px',overflowY:'auto'}}>
   <div className="sully-chat-header" style={{display:'flex',alignItems:'center',gap:12,borderBottom:'1px solid #e8e1ef',paddingBottom:20}}><div className="sully-chat-avatar" style={{width:42,height:42,borderRadius:'50%',background:'#e2d5ee',display:'grid',placeItems:'center'}}>S</div><div><div className="sully-chat-name">Sully</div><small style={{fontSize:10,color:'#aa98ba'}}>Online</small></div></div>
   <div style={{marginTop:24,maxWidth:260,padding:'14px 18px',background:'white',borderRadius:'18px 18px 18px 4px',fontSize:14}}>换个你喜欢的样子吧。</div>
   <div style={{margin:'18px 0 0 auto',maxWidth:210,padding:'14px 18px',background:bubble?.user.backgroundColor,color:'white',borderRadius:18,fontSize:14}}>那就从这里开始。</div>
   {sent.map((message,index)=><div key={index} style={{margin:'18px 0 0 auto',maxWidth:210,padding:'14px 18px',background:bubble?.user.backgroundColor,color:'white',borderRadius:18,fontSize:14}}>{message}</div>)}
   <form className="sully-chat-inputbar" style={{position:'fixed',bottom:0,left:0,right:0,background:'#faf9fc',borderTop:'1px solid #e8e1ef',paddingBottom:'env(safe-area-inset-bottom,0px)'}} onSubmit={event=>{event.preventDefault();if(draft.trim()){setSent(messages=>[...messages,draft.trim()]);setDraft('');}}}>
    <div className="sully-chat-composer" style={{display:'flex',alignItems:'center',gap:10,padding:'14px 16px'}}>
     <button type="button" className="sully-chat-actions-button" aria-label="打开装扮" onClick={()=>setOpen(true)} style={{border:0,background:'none',fontSize:28,color:'#9684a6',padding:4}}>＋</button>
     <div className="sully-chat-input-wrap" style={{display:'flex',flex:1,minWidth:0,borderRadius:24,background:'#eee9f3',padding:'8px 14px'}}><input aria-label="预览消息" placeholder="说点什么…" value={draft} onChange={e=>setDraft(e.target.value)} style={{minWidth:0,width:'100%',border:0,outline:0,background:'transparent',fontSize:14,color:'#584b64',lineHeight:'28px'}}/><span aria-hidden="true" style={{alignSelf:'center',color:'#a594b5'}}>☺</span></div>
     <button type="submit" className="sully-chat-send-button" aria-label="发送预览消息" style={{border:0,borderRadius:22,background:'#8b739e',color:'white',padding:'12px 14px',fontSize:12}}>发送</button>
    </div>
   </form>
   {!open&&<button onClick={()=>setOpen(true)} style={{marginTop:24}}>打开装扮</button>}
   {workshop&&<p role="status">气泡工坊入口已触发（预览不离开页面）</p>}
  </div>
  {open&&<ChatDecorationPanel initialTab={new URLSearchParams(location.search).has('presets')?'presets':'layout'} character={char} theme={theme} themes={[...Object.values(PRESET_THEMES),...importedThemes]} onSaveBubble={bubble=>setImportedThemes(all=>[...all,bubble])} updateCharacter={patch=>setChar(c=>({...c,...patch}))} updateTheme={patch=>setTheme(t=>({...t,...patch}))} backgroundUrl={char.chatBackground} onBgUpload={file=>setChar(c=>({...c,chatBackground:URL.createObjectURL(file)}))} onOpenWorkshop={()=>setWorkshop(true)} onClose={()=>setOpen(false)}/>}
 </>;
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('appearance')?<OSProvider><Appearance/></OSProvider>:<Preview/>);
