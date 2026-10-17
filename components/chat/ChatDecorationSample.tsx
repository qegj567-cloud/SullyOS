import {renderCollaborationBeautySample} from '../../features/collaboration/CollaborationBeautySample';
import {avatarFrameLayer,readAvatarFrameTarget} from '../../utils/avatarFrameTarget';
import JournalThemeArtwork from '../journal/JournalThemeArtwork';
import {meetingAppearance, MEETING_READING_CSS} from '../../utils/meetingAppearance';
import {resolveJournalAppearanceCss,JOURNAL_APPEARANCE_SAFETY_CSS} from '../../utils/journalAppearance';
import {ScheduleCardView} from '../schedule/ScheduleCard';
import React from 'react';
import type {DecorationPreviewState} from '../../utils/decorationPreviewInteraction';
import {renderToStaticMarkup} from 'react-dom/server';
import MessageItem,{ThinkingChainBlock} from './MessageItem';
import type {DecorationThumbnailPart} from '../../utils/decorationPreviewScenes';
import ChatHeaderShell from './ChatHeaderShell';
import ChatInputArea from './ChatInputArea';
import {PRESET_THEMES} from './ChatConstants';
import ScheduleChangeNotice from './ScheduleChangeNotice';
import {validateDecoration} from '../../utils/chatDecoration';
import {buildChatFineTuneCss} from '../../utils/chatFineTuneCss';
import {CHAT_PREVIEW_SCENES} from '../../utils/chatPreviewFixtures';
import {BEAUTY_PREVIEW_AVATAR} from '../../utils/beautyPreviewAssets';
import type {CharacterBuff} from '../../types';
import baseCss from './chatPreview.generated.css?inline';
import cardCss from './ChatCardSurface.css?inline';
import qixiCss from './QixiEventCard.css?inline';
import sarCss from '../sar/sar-speech.css?inline';

const noop=()=>{};
// Fictional fixture states only; never read or update a real character's emotions.
const previewBuffs:CharacterBuff[]=[
 {id:'preview-calm',name:'preview_calm',label:'安心',emoji:'🍃',color:'#059669',intensity:2},
 {id:'preview-anticipation',name:'preview_anticipation',label:'期待见面',emoji:'✨',color:'#d97706',intensity:2},
];
const defaultBubble=PRESET_THEMES.default;

/** Static rendering intentionally never mounts effects or binds actual message actions. */
export function renderChatDecorationSample(value:unknown,sceneId:string,thumbnailPart?:DecorationThumbnailPart,state:DecorationPreviewState={}) {
 const p=validateDecoration(value).parts,l=p.layout||{};
 if(p.collaboration)return renderCollaborationBeautySample(p.collaboration,!!thumbnailPart);
 if(p.date||p.story){
  const style=meetingAppearance(p.date||p.story);
  const markup=renderToStaticMarkup(<main className="meeting-reading" data-reading-preset={style.id}>
    <div className="meeting-reading-page" style={{height:thumbnailPart?360:600,padding:'28px 24px',overflow:'hidden'}}>
      <header style={{fontSize:11,opacity:.55,letterSpacing:3,marginBottom:32}}>{p.date?'见面':'剧情放映厅'} · {style.name}</header>
      <div className="meeting-prose"><p>窗边的灯亮了，书页上留下了一小片暖色。</p><p>“今天读到哪里了？”</p><p>他把书签夹好，往旁边挪了挪杯子。窗外的雨渐渐停了，只有屋檐还偶尔落下一滴水。</p><p>“刚好到这里。你呢？”</p></div>
      {p.story&&<small style={{opacity:.5}}>▸ 场景与补充</small>}
    </div>
  </main>);
  return {markup,css:baseCss+'\n'+MEETING_READING_CSS};
 }
 if(thumbnailPart==='journal'||sceneId==='journal-app'){
  const preset=p.journal?.preset||'original';
  const markup=renderToStaticMarkup(<main className={`sully-journal-root sully-journal-select h-full w-full bg-amber-50 flex flex-col font-light${preset==='original'?'':` sully-journal-designed sully-journal-theme-${preset}`}`}><JournalThemeArtwork preset={preset} scene="select"/><header className="sully-journal-header border-b border-amber-100 bg-amber-50/80 relative z-20"><div className="h-12 px-6 flex items-center justify-between"><span className="sully-journal-back">‹</span><b className="sully-journal-header-title text-amber-900">选择日记本</b><span>⋯</span></div></header><div className="sully-journal-notebook-grid p-6 grid grid-cols-2 gap-5 overflow-y-auto">{['示例角色','另一本日记'].map(name=><div key={name} className="sully-journal-notebook aspect-[3/4] bg-white rounded-r-2xl rounded-l-md border-l-4 border-l-amber-800 shadow-lg p-4 flex flex-col items-center justify-center gap-3 relative overflow-hidden"><div className="sully-journal-notebook-avatar w-16 h-16 rounded-full border border-amber-100 bg-amber-50"><img src={BEAUTY_PREVIEW_AVATAR} className="w-full h-full rounded-full object-cover" alt="示例头像"/></div><b className="sully-journal-notebook-name text-amber-900 text-sm">{name}</b><span className="sully-journal-notebook-label text-[9px] text-amber-600">JOURNAL</span></div>)}</div></main>);
  return {markup,css:`${baseCss}\n.beauty-preview-body{width:360px;height:${thumbnailPart?360:600}px;font:14px/1.5 system-ui;--app-font:system-ui;--chrome-top:0px}.sully-journal-root{position:relative;overflow:hidden}\n${resolveJournalAppearanceCss(p.journal)}\n${JOURNAL_APPEARANCE_SAFETY_CSS}`};
 }
 if(thumbnailPart==='schedule' ||sceneId==='schedule-card'){
  const schedule={id:'preview',charId:'preview',date:'2026-09-27',generatedAt:0,slots:[{startTime:'08:00',activity:'慢慢吃一顿早餐',description:'留一点时间给自己。',emoji:'☕'},{startTime:'10:00',activity:'去街角的书店',description:'挑一本喜欢的书，再写下今天的小计划。',emoji:'📖'},{startTime:'18:00',activity:'一起散步',description:'沿着熟悉的小路走走。',emoji:'🌿'}]};
  const markup=renderToStaticMarkup(<div style={{padding:16}}><ScheduleCardView schedule={schedule as any} character={{id:'preview',name:'示例角色',avatar:BEAUTY_PREVIEW_AVATAR} as any} theme={{hue:260,scheduleCardAppearance:p.schedule} as any} previewNow={new Date(2026,8,27,10,30)} compact={!!thumbnailPart}/></div>);
  return {markup,css:`${baseCss}\n.beauty-preview-body{width:360px;height:${thumbnailPart?360:600}px;overflow:auto;scrollbar-width:none;background:#f4f2f5;font:14px/1.5 system-ui;--app-font:system-ui;--safe-top:0px}\n${p.schedule?.customCss||''}`};
 }
 const scene=CHAT_PREVIEW_SCENES.find(item=>item.id===sceneId)||CHAT_PREVIEW_SCENES[0];
  const messages=scene.messages.flatMap(message=>{const status=state.transfers?.[message.id];if(!status||message.type!=='transfer'||message.metadata?.receipt)return [message];return [{...message,metadata:{...message.metadata,status}},{...message,id:-message.id,role:'user' as const,metadata:{amount:message.metadata?.amount,receipt:status}}];});
 const markup=renderToStaticMarkup(thumbnailPart?<main className={`sully-chat-root sample-chat sample-part sample-part-${thumbnailPart}`}>
  {thumbnailPart==='avatar'&&<div className={`sample-avatar sully-chat-message sully-chat-message-${readAvatarFrameTarget(p.css||'')==='user'?'user':'ai'}`}><span className="sully-chat-avatar-wrap" style={{position:'relative',display:'block',width:100,height:100,margin:'auto'}}><img className="sully-chat-message-avatar-img" src={BEAUTY_PREVIEW_AVATAR} alt="示例头像" style={{width:'100%',height:'100%',borderRadius:'50%'}}/>{p.bubbles?.ai.avatarDecoration&&<img className="sully-chat-avatar-frame" src={p.bubbles.ai.avatarDecoration} alt="" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'contain'}}/>}</span></div>}
  {thumbnailPart==='psyche'&&<div className="sample-psyche"><ThinkingChainBlock chain="听到开门的声音，忽然想把刚才看到的那朵云也分享给你。" styleId={p.psyche?.styleId} customColors={p.psyche?.customColors}/></div>}
  {thumbnailPart==='bubbles'&&<div className="sully-chat-messages sample-bubbles">{CHAT_PREVIEW_SCENES.find(item=>item.id==='conversation')!.messages.map((message,index)=><MessageItem key={message.id} msg={message} activeTheme={p.bubbles||defaultBubble} isFirstInGroup={index%2===0} isLastInGroup={index%2===1} charAvatar={BEAUTY_PREVIEW_AVATAR} userAvatar={BEAUTY_PREVIEW_AVATAR} charName="示例角色" onLongPress={noop} onReply={noop} selectionMode={false} isSelected={false} onToggleSelect={noop} showTimestamp="never" suppressEntranceAnimation/>)}</div>}
 </main>:<main className="sully-chat-root sample-chat">
  <ChatHeaderShell selectionMode={false} selectedCount={0} onCancelSelection={noop} activeCharacter={{id:'whitebox-preview',name:'示例角色',avatar:BEAUTY_PREVIEW_AVATAR,activeBuffs:previewBuffs}} isTyping={false} isSummarizing={false} lastTokenUsage={1200} statusText="在线" onClose={noop} onTriggerAI={noop} onShowCharsPanel={noop} hideBuffs={l.chatHideHeaderBuffs??false} headerStyle={l.chatHeaderStyle} avatarShape={l.chatAvatarShape} headerAlign={l.chatHeaderAlign} headerDensity={l.chatHeaderDensity} statusStyle={l.chatStatusStyle} chromeStyle={l.chatChromeStyle}/>
  <div className="sully-chat-messages sample-messages">
   {(scene.id==='schedule'||scene.id==='all') && <ScheduleChangeNotice onDone={noop} detail={{eventId:'preview',charId:'whitebox-preview',date:'2026-09-26',schedule:{} as any,changes:[{startTime:'18:00',before:'整理房间',after:'一起散步'},{startTime:'20:00',before:'看书',after:'一起看电影'}]}}/>}
   {messages.map((message,index)=><div key={message.id} data-preview-message={message.id} style={{display:"contents"}}><MessageItem msg={message} isFirstInGroup={index===0||messages[index-1].role!==message.role} isLastInGroup={index===messages.length-1||messages[index+1].role!==message.role} activeTheme={p.bubbles||defaultBubble} charAvatar={BEAUTY_PREVIEW_AVATAR} userAvatar={BEAUTY_PREVIEW_AVATAR} charName="示例角色" onLongPress={noop} onReply={noop} selectionMode={false} isSelected={false} onToggleSelect={noop} avatarShape={l.chatAvatarShape} avatarSize={l.chatAvatarSize} avatarMode={l.chatAvatarMode} bubbleVariant={l.chatBubbleStyle} messageSpacing={l.chatMessageSpacing} showTimestamp={l.chatShowTimestamp} moduleAlign={l.chatModuleAlign} suppressEntranceAnimation thinkingChainOptions={p.psyche} previewExpanded={state.psyche?.[message.id]??scene.expanded} previewTransferOpen={state.transferOpen===String(message.id)} onResolveTransfer={noop} voiceData={scene.voicePlaying?{url:'data:audio/wav;base64,',originalText:'晚安，明天见。',spokenText:'晚安，明天见。'}:undefined} voiceLoading={scene.voiceLoading} isVoicePlaying={scene.voicePlaying} translationEnabled translationExpanded/></div>) }
  </div>
  <ChatInputArea input="" setInput={noop} isTyping={false} selectionMode={false} showPanel={state.panel?"actions":"none"} previewActionsPage={state.actionsPage} setShowPanel={noop} onSend={noop} onDeleteSelected={noop} selectedCount={0} emojis={[]} onPanelAction={noop} onImageSelect={noop} isSummarizing={false} onReroll={noop} canReroll={false} inputStyle={l.chatInputStyle} sendButtonStyle={l.chatSendButtonStyle} chromeStyle={l.chatChromeStyle}/>
 </main>);
 const background=p.background?.image?`url(${JSON.stringify(p.background.image)}) center/cover`:'#f4f2f5';
 return {markup,css:`${baseCss}\n${cardCss}\n${qixiCss}\n${sarCss}
 .beauty-preview-body{width:360px;height:600px;font:14px/1.6 system-ui;--app-font:system-ui;--safe-top:0px;--safe-bottom:0px;--primary-hue:265;--primary-sat:30%;--primary-lightness:60%;}
 .sample-chat{height:600px;display:flex;flex-direction:column;background:${background};overflow:hidden;position:relative;color:#38323e}
 .sample-messages{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:16px 0 28px}
 .sample-chat .sully-schedule-change{transform:translateX(-50%)}
 ${scene.id==='all'?'.sample-chat .sully-schedule-change{position:relative;left:auto;top:auto;transform:none;margin:0 auto 16px}':''}
 ${buildChatFineTuneCss(l)}
 .sample-chat{--sully-emoji-size:${{small:96,medium:128,large:160}[l.chatEmojiSize||'small']}px}
 ${p.psyche?.customCss||''}
 ${p.css||''}
 ${p.bubbles?.customCss||''}
 ${avatarFrameLayer(p.css||'')}
 .sample-chat .sample-messages,.sample-chat .no-scrollbar{scrollbar-width:none!important;-ms-overflow-style:none}
 .sample-chat .sample-messages::-webkit-scrollbar,.sample-chat .no-scrollbar::-webkit-scrollbar{display:none!important;width:0;height:0}
 ${thumbnailPart?`.beauty-preview-body,.sample-chat.sample-part{height:${thumbnailPart==='psyche'?180:360}px}.sample-chat.sample-part{justify-content:center}.sample-psyche{width:calc(100% - 40px);margin:auto}.sample-bubbles{width:100%;padding:20px 0}.sample-part-psyche,.sample-part-bubbles{background:#f5f4f7}.sample-part .sully-chat-message-content{margin-left:0!important;margin-right:0!important;max-width:86%}.sample-part .sully-chat-message-avatar-slot{display:none}`:''}
 `};
}
