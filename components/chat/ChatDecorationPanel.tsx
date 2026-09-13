import React, {useState} from 'react';
import {createPortal} from 'react-dom';
import type {CharacterProfile, ChatTheme, OSTheme} from '../../types';
import ChatLayoutSettings from './ChatLayoutSettings';
import ChromeCssEditor from './ChromeCssEditor';
import WhiteboxSoundEditor from './WhiteboxSoundEditor';
import {mergeChatFineTune,CHAT_FINE_TUNE_KEYS} from '../../utils/chatFineTuneCss';
import {parseWhiteboxSound,upsertWhiteboxSound,stripWhiteboxSoundDirective,WhiteboxSound} from '../../utils/whiteboxSound';
import './ChatDecorationPanel.css';
import ChatDecorationPresets from './ChatDecorationPresets';
import {exportDecoration,decorationPatches,resolveDecorationTheme,decorationCssPatch} from '../../utils/chatDecoration';
import {useBlobRefUrl,putImageBlob} from '../../utils/blobRef';

export type DecorationTab = 'layout'|'bubbles'|'background'|'sound'|'css'|'presets';
const tabs: {id:DecorationTab;name:string}[] = [{id:'layout',name:'布局'},{id:'bubbles',name:'气泡'},{id:'background',name:'背景'},{id:'sound',name:'声音'},{id:'css',name:'进阶'},{id:'presets',name:'预设'}];
interface Props {
 character: CharacterProfile; theme: OSTheme; themes: ChatTheme[];
 updateCharacter: (patch:Partial<CharacterProfile>)=>void|Promise<void>;
 onSaveBubble:(bubble:ChatTheme)=>void|Promise<void>;
 updateTheme:(patch:Partial<OSTheme>)=>void|Promise<void>;
 onBgUpload:(file:File)=>void; backgroundUrl?:string|null;
 onOpenWorkshop:()=>void; onClose:()=>void; initialTab?:DecorationTab;
}
export default function ChatDecorationPanel({character:char,theme,themes,updateCharacter,updateTheme,onBgUpload,backgroundUrl,onOpenWorkshop,onClose,onSaveBubble,initialTab='layout'}:Props){
 const [tab,setTab]=useState<DecorationTab>(initialTab);
 const [scope,setScope]=useState<'character'|'global'>('character');
 const [collapsed,setCollapsed]=useState(false);
 const [presetBusy,setPresetBusy]=useState(false);
 const [panelOpacity,setPanelOpacity]=useState(100);
 const global=scope==='global';
 const override=char.chatFineTune;
 const customized=override?.enabled===true;
 const characterTheme=resolveDecorationTheme(theme,char);
 const effective=global?theme:{...characterTheme,...mergeChatFineTune(characterTheme,override)};
 const displayedBackground=useBlobRefUrl(global?theme.chatBackground:(char.chatBackground??theme.chatBackground));
 const css=global?theme.chatChromeCustomCss:char.chromeCustomCss;
 const boundSound=parseWhiteboxSound(css);
 const bound=global?!!boundSound:!!char.chatSoundBound||!!boundSound;
 const sound:WhiteboxSound|null=bound?boundSound:((global?theme.chatSound:char.chatSound)||null);
 const setCss=(value:string,reset=false)=>{const patch=decorationCssPatch(value,scope,char,theme,reset);return global?updateTheme(patch):updateCharacter(patch);};
 const changeSound=(value:WhiteboxSound|null)=>{
   if(global) updateTheme(bound?{chatChromeCustomCss:upsertWhiteboxSound(css||'',value),chatSound:undefined}:{chatSound:value||undefined});
   else updateCharacter(bound?{chromeCustomCss:upsertWhiteboxSound(css||'',value),chatSound:undefined}:{chatSound:value||undefined});
 };
 const changeBound=(value:boolean)=>updateCharacter(value
   ?{chromeCustomCss:upsertWhiteboxSound(css||'',sound),chatSound:undefined,chatSoundBound:true}
   :{chromeCustomCss:stripWhiteboxSoundDirective(css||''),chatSound:sound||undefined,chatSoundBound:false});
 const activeBubble=themes.find(t=>t.id===((global?theme.chatDefaultBubbleStyle:char.bubbleStyle||theme.chatDefaultBubbleStyle)||'default'))||themes[0];
 const switchTab=(next:DecorationTab)=>setTab(next);
 return createPortal(<>
  {collapsed&&<button type="button" className="chat-decoration-return" onClick={()=>setCollapsed(false)}>返回装扮</button>}
  <aside className={`chat-decoration ${collapsed?'is-collapsed':''}`} aria-label="ChatApp 装扮" style={{backgroundColor:`rgba(250,249,252,${panelOpacity/100})`}}>
   <header className="chat-decoration-heading">
    <div><small>CHATAPP</small><h2>装扮</h2></div>
    <label className="chat-decoration-opacity"><span>透明度 <output>{panelOpacity}%</output></span><input type="range" aria-label="面板透明度" min="30" max="100" step="5" value={panelOpacity} style={{['--slider-fill' as string]:`${(panelOpacity-30)/70*100}%`}} onChange={event=>setPanelOpacity(Number(event.target.value))}/></label>
    <div className="chat-decoration-tools"><button type="button" disabled={presetBusy} onClick={()=>setCollapsed(!collapsed)}>{collapsed?'展开':'看效果'}</button><button type="button" disabled={presetBusy} onClick={onClose}>完成</button></div>
   </header>
   {!collapsed&&<>
    <div className="chat-decoration-scope"><span>正在设置</span><div className="chat-decoration-scope-buttons" role="group" aria-label="正在设置"><button type="button" aria-pressed={!global} disabled={presetBusy} onClick={()=>setScope('character')} title={`${char.name}专属`}>{char.name}专属</button><button type="button" aria-pressed={global} disabled={presetBusy} onClick={()=>setScope('global')}>全局默认</button></div></div>
    <p className="chat-decoration-summary">{global?'全局修改会影响未单独定制的聊天。':`布局${customized?'已单独定制':'跟随全局'} · 气泡 ${activeBubble?.name||'默认'}`}</p>
    <nav className="chat-decoration-tabs" aria-label="装扮分类">{tabs.map(item=><button key={item.id} type="button" aria-pressed={tab===item.id} disabled={presetBusy} onClick={()=>switchTab(item.id)}>{item.name}</button>)}</nav>
    <div className="chat-decoration-body" key={tab}>
     {tab==='presets'&&<ChatDecorationPresets onBusyChange={setPresetBusy} target={global?'全局默认':`${char.name}专属`} scope={scope} currentBubble={activeBubble} exportCurrent={name=>exportDecoration(name,theme,global?undefined:char,activeBubble)} onApply={async(preset,parts)=>{const changes=await decorationPatches(preset,parts,scope,char,theme);if(changes.bubble)await onSaveBubble(changes.bubble);if(global)await updateTheme(changes.theme);else await updateCharacter(changes.character);}}/>}
     {tab==='layout'&&<>
      <h3>界面与头像</h3>
      {!global&&<label className="chat-decoration-toggle"><span>为 {char.name} 单独调整布局<small>关闭后跟随全局，已调好的内容会保留。</small></span><input type="checkbox" checked={customized} onChange={()=>updateCharacter({chatFineTune:{...override,enabled:!customized}})}/></label>}
      {(global||customized)?<ChatLayoutSettings theme={effective} updateTheme={patch=>{if(global){void updateTheme(patch);return;}const fine=Object.fromEntries(Object.entries(patch).filter(([key])=>(CHAT_FINE_TUNE_KEYS as readonly string[]).includes(key)));void updateCharacter({chatAppearance:{...char.chatAppearance,...patch},chatFineTune:{...override,...fine,enabled:true}});}}/>:<p className="chat-decoration-note">想一起调整所有聊天，可以在上方切换到「全局默认」。</p>}
      <p className="chat-decoration-note">{char.chromeCustomCss||theme.chatChromeCustomCss?'当前有进阶 CSS，可能覆盖布局和气泡的部分效果。可在「进阶」查看。':'布局调整会实时显示在聊天中。'}</p>
     </>}
     {tab==='bubbles'&&<>
      <h3>气泡主题</h3>
      {!global&&<button className="chat-decoration-link" onClick={()=>updateCharacter({bubbleStyle:undefined})}>跟随全局气泡</button>}
      {<div className="chat-decoration-bubbles">{themes.map(item=><button key={item.id} type="button" aria-pressed={activeBubble?.id===item.id} onClick={()=>global?updateTheme({chatDefaultBubbleStyle:item.id}):updateCharacter({bubbleStyle:item.id})}><span className="chat-decoration-bubble-sample" style={{background:item.user.backgroundColor,color:item.user.textColor,borderRadius:Math.min(item.user.borderRadius,16)}}>你好呀</span><span>{item.name}</span></button>)}</div>}
      <button className="chat-decoration-link" onClick={onOpenWorkshop}>打开气泡工坊 · 制作与导入 →</button>
     </>}
     {tab==='background'&&<>
      <h3>聊天背景</h3>
      {global&&<label className="chat-decoration-field">默认背景底纹<select value={theme.chatBackgroundStyle||'plain'} onChange={e=>updateTheme({chatBackgroundStyle:e.target.value as OSTheme['chatBackgroundStyle']})}>{[['plain','纯色'],['grid','网格'],['paper','纸张'],['mesh','柔光']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>}
       {displayedBackground?<img className="chat-decoration-background" src={displayedBackground} alt="当前聊天背景"/>:<p className="chat-decoration-note">当前使用全局背景；可以为这个角色换一张图片。</p>}
       <label className="chat-decoration-upload">选择背景图片<input aria-label="选择背景图片" type="file" accept="image/*" onChange={e=>{const f=e.target.files?.[0];if(f){if(global)void putImageBlob(f).then(ref=>updateTheme({chatBackground:ref}));else onBgUpload(f);}e.target.value='';}}/></label>
       {(global?theme.chatBackground:char.chatBackground!==undefined)&&<button className="chat-decoration-link" onClick={()=>global?updateTheme({chatBackground:undefined}):updateCharacter({chatBackground:undefined})}>{global?'移除全局背景图片':'移除专属背景，跟随全局'}</button>}
     </>}
     {tab==='sound'&&<>
      <h3>消息提示音</h3>
      <WhiteboxSoundEditor key={scope} sound={sound} bound={bound} showBind={!global} onChangeSound={changeSound} onChangeBound={changeBound} hint={global?'未设置专属提示音的角色会使用这里的声音。':'角色的新回复到达时响一次。不设置则跟随全局提示音。'}/>
     </>}
     {tab==='css'&&<>
      <h3>进阶 CSS <span className="chat-decoration-former">原白框</span></h3>
      <p className="chat-decoration-note">{global?'全局 CSS 先应用，再叠加角色 CSS。':char.chatDecorationCssIsolated?'当前使用导入预设的独立 CSS，不叠加全局 CSS。':'角色 CSS 叠加在全局之上；原来的预设与分享文件仍可使用。'}</p>
      <details className="chat-decoration-sources"><summary>查看生效来源</summary><p>全局 CSS：{theme.chatChromeCustomCss?.trim()?'已设置':'未设置'}<br/>角色 CSS：{char.chromeCustomCss?.trim()?'已设置':'未设置'}<br/>气泡主题：{activeBubble?.name||'默认'}{activeBubble?.customCss?'（含 CSS）':''}</p></details>
      <ChromeCssEditor key={scope} value={css||''} onChange={value=>setCss(value)}/>
     </>}
    </div>
   </>}
  </aside>
  {tab==='css'&&<>
   <style>{`#sully-safe-reset{position:fixed!important;top:calc(var(--safe-top,0px) + 6px)!important;left:50%!important;transform:translateX(-50%)!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;display:flex!important;z-index:2147483647!important;}`}</style>
   <button id="sully-safe-reset" style={{padding:'7px 12px',borderRadius:20,background:'#272537',color:'#fff',border:'1px solid #fff6',fontSize:11}} onClick={()=>setCss('',true)}>还原{global?'全局':'此角色'} CSS</button>
  </>}
 </>,document.body);
}
