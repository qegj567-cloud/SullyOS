import {trackHomeEntry,trackHomeFeature} from '../../utils/homeAnalytics';
import type {HomeConversationContext} from '../../utils/homeConversation';
import HomePhone from './HomePhone';
import HomelyHud from './HomelyHud';
import HomelyMusic from './HomelyMusic';
import '../../components/os/homelyHome.css';
import {homeDisposalReason} from '../../utils/homeAssetCancellation';
import {useBlobRefUrl} from '../../utils/blobRef';
import {HomeSocialPanel,type HomeResidentOption} from './HomeSocialPanel';
import React, {useEffect,useRef,useState,useMemo} from 'react';
import HomeSecretsReveal from './HomeSecretsReveal';
import {mountHomeEditor} from './editor.js';
import type {Home3DState} from './types';
import './editor.css';
import './homeHud.css';
import 'animal-island-ui/style';
import './islandTheme.css';
import type {HomeEditor} from './editor.js';
import type {Parts,HairSettings} from './chibi/types';
import {selectedHairAssets} from './chibi/types';
import type {CharacterProfile,UserProfile,APIConfig} from '../../types';
import {CreatorRollBridge} from './chibi/CreatorRollBridge';
import {createVisitor,decodeParts} from './chibi/visitor';
import {loadCreatorPartsForRender} from '../../utils/creatorPartsBlob';
import {resolveCharTimeZone} from '../../utils/timezone';
import {useHomeSchedule} from './useHomeSchedule';
import {HomePresenceBubbles,type HomeInitiativeRequest} from './HomePresenceBubbles';
import HomeLifePanel from './HomeLifePanel';
import HomeQualityTip from './HomeQualityTip';
import {useHomeCompanion} from './useHomeCompanion';
import {useHomeSocialLife} from './useHomeSocialLife';
import {HomeSpeechBubble} from './HomeSpeechBubble';

export default function Home3DView({value,onChange,onBack,character,user,api,conversationContext,onDefinition,onFigures,parts:previewParts,hair:inputHair,suspended=false,residents=[],onEditor,presentation='home'}:{presentation?:'home'|'homely';value?:Home3DState;onChange:(value:Home3DState)=>void;onBack:()=>void;character?:CharacterProfile;user?:UserProfile;api?:APIConfig;conversationContext?:HomeConversationContext;onDefinition?:()=>void;onFigures?:()=>void;parts?:Parts;hair?:HairSettings;suspended?:boolean;residents?:HomeResidentOption[];onEditor?:(editor:HomeEditor)=>void}){
 const homely=presentation==='homely';
 const entryTracked=useRef(false);
 const hair=inputHair??character?.chibiStudio?.home3D?.hair;
 const host=useRef<HTMLDivElement>(null),save=useRef(onChange),back=useRef(onBack),initial=useRef(value);
 const [editor,setEditor]=useState<HomeEditor>(),[parts,setParts]=useState<Parts>(),[residentError,setResidentError]=useState('');
 const userAvatar=useBlobRefUrl(user?.avatar),characterAvatar=useBlobRefUrl(character?.avatar);
 useEffect(()=>{editor?.setResidentPortraits([{id:character?.id??'resident',label:character?.name??'小人',avatar:characterAvatar},...residents.map(r=>({id:r.id,label:r.label,avatar:r.id==='user'?userAvatar:r.avatar}))]);},[editor,character?.id,character?.name,characterAvatar,userAvatar,residents]);
 useEffect(()=>{if(editor&&!suspended&&!entryTracked.current){entryTracked.current=true;trackHomeEntry(presentation);}},[editor,suspended,presentation]);
 const [bodyOverride,setBodyOverride]=useState<'blank'|'classic'>(),[mainReady,setMainReady]=useState(false);
 const {away,currentSchedule}=useHomeSchedule(editor,character,mainReady,suspended);
 useHomeCompanion(editor,character,user,api,mainReady,suspended);
 useHomeSocialLife(editor,character?.id,mainReady&&!suspended&&!homely,setResidentError);
 const [photoActive,setPhotoActive]=useState(false),[phoneOpen,setPhoneOpen]=useState(false),[phoneBusy,setPhoneBusy]=useState(false),[homeBusy,setHomeBusy]=useState(false);
 const [interactionTarget,setInteractionTarget]=useState<string>();
 const openLifePanel=(name:string|null,targetId?:string)=>{if(name&&name!==lifePanel)trackHomeFeature(name);setInteractionTarget(name==='interact'?targetId:undefined);setLifePanel(name);};
 const openFigures=onFigures?()=>{trackHomeFeature('figures');onFigures();}:undefined;
 const [initiative,setInitiative]=useState<HomeInitiativeRequest>();
 const [lifePanel,setLifePanel]=useState<string|null>(homely?'chat':null);
 useEffect(()=>{if(homely)editor?.setPrimaryResidentId(character?.id??'resident',character?.name);},[editor,homely,character?.id,character?.name]);
 useEffect(()=>{editor?.setHomelyChatOpen?.(lifePanel==='chat');},[editor,lifePanel]);
 const [residentAssets,setResidentAssets]=useState<Record<string,string>>({});
 const residentHair=useMemo(()=>({...hair,bodyShape:bodyOverride??hair?.bodyShape,layers:hair?.layers??{},extras:hair?.extras??[],assets:hair?.assets??residentAssets}),[hair,residentAssets,bodyOverride]);
 const previousAppearance=useRef<{parts:Parts;style:string}>();
 const roomTimeZone=resolveCharTimeZone(character),initialTimeZone=useRef(roomTimeZone);
 useEffect(()=>{editor?.setTimeZone(roomTimeZone);},[editor,roomTimeZone]);
 const [extraItems,setExtraItems]=useState<unknown[]>(),[creatorReady,setCreatorReady]=useState(false);
 const savedState=character?.chibiStudio?.home3D?.state??character?.chibiStudio?.room?.state??character?.chibiStudio?.vr?.state;
 useEffect(()=>{let cancelled=false;if(!savedState)return;loadCreatorPartsForRender().then(items=>{if(!cancelled)setExtraItems(items.map(p=>({...p,categoryKey:p.categoryKey})));}).catch(()=>{if(!cancelled)setResidentError('自定义素材读取失败，请退出小屋重试。');});return()=>{cancelled=true};},[savedState]);
 useEffect(()=>{let cancelled=false;if(!editor||suspended||!(previewParts||parts))return;
  setMainReady(false);const currentParts=(previewParts||parts)!,{headSize,bodyHeight,...style}=residentHair,signature=JSON.stringify(style);
  createVisitor(currentParts,residentHair).then(visitor=>{if(cancelled)visitor.dispose();else {const previous=previousAppearance.current;editor.setVisitor?.(visitor,{preservePose:previous?.parts===currentParts&&previous.style===signature});previousAppearance.current={parts:currentParts,style:signature};setResidentError('');setMainReady(true);}}).catch(e=>{if(!cancelled)setResidentError(String(e));});
  return()=>{cancelled=true};
 },[editor,previewParts,parts,residentHair,suspended]);
 useEffect(()=>{editor?.setSuspended?.(suspended);if(suspended)editor?.setVisitor?.(null);},[editor,suspended]);
 useEffect(()=>()=>{editor?.setVisitor?.(null);},[editor]);
 useEffect(()=>{if(homely||!editor||!mainReady||suspended)return;const timer=setTimeout(()=>editor.greetOwner?.(),600);return()=>clearTimeout(timer);},[editor,mainReady,suspended]);
 const [error,setError]=useState('');save.current=onChange;back.current=onBack;
 useEffect(()=>{
  let cancelled=false;const controller=new AbortController();
  const assetBase=new URL(`${import.meta.env.BASE_URL}room3d/`,location.href).href;
  // StrictMode's setup/cleanup probe finishes before this microtask: no abandoned WebGL or requests.
  Promise.resolve().then(()=>{if(cancelled)return;return mountHomeEditor(host.current!,{assetBase,firstPerson:homely,initialState:initial.current,timeZone:initialTimeZone.current,onChange:(s:Home3DState)=>save.current(s),onBack:()=>back.current(),onMenu:openLifePanel,signal:controller.signal});})
   .then(e=>{if(!e||cancelled)return;setEditor(e);onEditor?.(e);}).catch(e=>{if(!cancelled)setError(e.message)});
  return()=>{cancelled=true;controller.abort(homeDisposalReason())};
 },[]);
 return <div className={`home-island ${homely?'homely-scene':''} relative h-full w-full`} data-chat-open={homely&&lifePanel==='chat'} data-photo-active={photoActive} style={{paddingBottom:'var(--safe-bottom, 0px)',background:'#fafafa'}}>
   <div ref={host} className="h-full w-full" />
   {editor&&!homely&&<HomeQualityTip editor={editor} active={!suspended&&!lifePanel&&!phoneOpen&&!photoActive}/>}
   {editor&&!suspended&&<>{(!homely||lifePanel!=='chat')&&<HomeSpeechBubble editor={editor}/>}<HomePresenceBubbles editor={editor} character={character} enabled={mainReady&&!lifePanel&&!phoneOpen} canInvite={!!api&&!!user} onInitiative={setInitiative}/></>}
   {away&&!editor?.getHomeScene().present&&<p className="home-away-note" role="status">{character?.name}现在不在家哦……</p>}
   {editor&&!suspended&&!homely&&<><HomeSocialPanel targetId={interactionTarget} initialSettings={lifePanel==='visits'} externalOpen={lifePanel==='interact'||lifePanel==='visits'} onClose={()=>setLifePanel(null)} editor={editor} primary={{id:character?.id??'resident',label:character?.name??'小人'}} options={residents.filter(r=>r.id!==character?.id)} body={residentHair.bodyShape??'classic'} onBody={value=>{setMainReady(false);setBodyOverride(value);}} mainReady={mainReady} hair={residentHair}/></>}
   {editor&&<HomeLifePanel presentation={homely?'homely':'home'} onBusyChange={setHomeBusy} active={!suspended&&!photoActive} initiative={initiative} editor={editor} character={character} user={user} api={api} conversationContext={conversationContext} panel={suspended||homely&&phoneOpen?null:lifePanel} onPanel={openLifePanel} onDefinition={onDefinition} onFigures={openFigures}/>}
   {editor&&character&&!suspended&&<HomePhone onPhotoChange={setPhotoActive} editor={editor} characterId={character.id} onBusyChange={setPhoneBusy} onOpenChange={setPhoneOpen}/>}
   {character&&<HomeSecretsReveal key={character.id} charId={character.id} active={!suspended} ready={mainReady&&!phoneOpen}/>}
   {editor&&homely&&!suspended&&!phoneOpen&&<HomelyHud editor={editor} name={character?.name||'TA'} schedule={currentSchedule} ready={mainReady} panel={lifePanel} onPanel={openLifePanel} onFigures={openFigures} music={<HomelyMusic editor={editor} active={!photoActive&&!homeBusy&&!phoneBusy}/>}/>}
   {editor&&!suspended&&(!homely||lifePanel!=='chat')&&(homeBusy||phoneBusy)&&<div className="home-life-hint" role="status">{character?.name||'角色'}正在回应…</div>}
   {savedState&&<CreatorRollBridge request={creatorReady&&extraItems?1:0} savedState={savedState} extraItems={extraItems} onReady={()=>setCreatorReady(true)} onResult={result=>{setResidentAssets(selectedHairAssets(result.state));decodeParts(result,residentHair).then(setParts).catch(e=>setResidentError(String(e)));}} onError={setResidentError}/>}
   {(residentError||character&&!savedState)&&<p role="status" style={{position:'absolute',top:100,left:18,right:18,fontSize:12,pointerEvents:'none',color:'#665274'}}>{residentError||'先在手办柜捏好小小窝或彼方形象，小人就能住进来。'}</p>}
   {error&&<div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#e8dde7] p-8 text-center text-sm text-purple-900"><p>{error}</p><button className="rounded-full bg-white px-5 py-3" onClick={onBack}>返回</button></div>}
 </div>;
}
