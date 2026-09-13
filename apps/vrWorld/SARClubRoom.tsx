import React,{useEffect,useMemo,useRef,useState} from 'react';
import {ClipboardText,Cpu,Fish,Gift,PawPrint,Stack} from '@phosphor-icons/react';
import roomArt from '../../assets/sar-club-room.png';
import TokenImg from '../../components/os/TokenImg';
import type {CharacterProfile} from '../../types';
import {getChibi} from '../../utils/vrWorld/chibi';
import {arrangeSARRoomActors,SAR_ROOM_HOTSPOTS,SAR_ROOM_SIZE,type SARFacility,type SARRoomActor} from '../../utils/vrWorld/sarRoomLayout';
import {SARNpcChibi} from './SARNpcArt';
import {normalizeKanataTitle} from '../../utils/vrWorld/kanataTitle';
import './sar-club-room.css';
import {sarRoomView,type SARRoomView} from '../../utils/vrWorld/sarClub';
import {isSARActivityOccupant} from '../../utils/vrWorld/participation';
import {acknowledgeSARUpdateNotice,hasReadSARUpdateNotice,type SARUpdateNotice} from '../../utils/vrWorld/sarUpdateNotices';
import {SARUpdateDialogue} from './SARUpdateDialogue';
const FacilityIcons={board:ClipboardText,modules:Cpu,cabinet:Stack,gacha:Gift,water:Fish,garden:PawPrint};

interface Props {
    onOpenGacha:()=>void;onOpenCabinet:()=>void;onOpenModuleShop:()=>void;
    onOpenFishingMarket:(entry:'water'|'board'|'garden')=>void;
    occupants?:CharacterProfile[];npcEnabled?:boolean;caianMet?:boolean;
    labelsHidden?:boolean;
    roomView?:SARRoomView;
    onTalkToCaian?:()=>void;onTalkToAiven?:()=>void;onSelectCharacter?:(char:CharacterProfile)=>void;
}
export default function SARClubRoom({onOpenGacha,onOpenCabinet,onOpenModuleShop,onOpenFishingMarket,occupants:providedOccupants=[],npcEnabled=false,caianMet=false,labelsHidden=false,roomView,onTalkToCaian,onTalkToAiven,onSelectCharacter}:Props){
    const occupants=useMemo(()=>providedOccupants.filter(char=>char.id==='user'||isSARActivityOccupant(char)),[providedOccupants]);
    const viewport=useRef<HTMLDivElement>(null),[size,setSize]=useState({width:0,height:0}),[roster,setRoster]=useState(false);
    const [updateNotice,setUpdateNotice]=useState<SARUpdateNotice|null>(null),pendingNotice=useRef<SARUpdateNotice|null>(null);
    useEffect(()=>{
        if(!viewport.current)return;
        const observer=new ResizeObserver(([entry])=>{
            const width=Math.min(entry.contentRect.width,entry.contentRect.height*SAR_ROOM_SIZE.width/SAR_ROOM_SIZE.height);
            setSize({width,height:width*SAR_ROOM_SIZE.height/SAR_ROOM_SIZE.width});
        });observer.observe(viewport.current);return()=>observer.disconnect();
    },[]);
    const {placed,overflow}=useMemo(()=>{
        const actors:SARRoomActor[]=occupants.map(char=>{
            const chibi=getChibi(char),scale=Math.min(1.5,Math.max(.6,chibi.scale));
            const headOffset=chibi.isFallback?0:Math.max(0,size.width*.125*(.90466*(scale-1)-.09534)-scale*chibi.offsetY*size.width/SAR_ROOM_SIZE.width);
            return {id:char.id,name:char.name,title:npcEnabled?normalizeKanataTitle(char.vrState?.title):'',headOffset,zone:char.vrState?.sarActivity==='fishing'?'fishing':'common'};
        });
        if(npcEnabled)actors.unshift({id:'sar-npc-caian',name:'凯恩',zone:'common',anchor:{x:740,y:945}},{id:'sar-npc-aiven',name:'艾文',zone:'fishing',anchor:{x:880,y:1745}});
        return arrangeSARRoomActors(actors,size.width/SAR_ROOM_SIZE.width);
    },[occupants,npcEnabled,size.width]);
    const enterFacility=(id:SARFacility)=>{
        if(id==='gacha')onOpenGacha();else if(id==='cabinet')onOpenCabinet();else if(id==='modules')onOpenModuleShop();else onOpenFishingMarket(id);
    };
    const open=(id:SARFacility)=>{
        if(pendingNotice.current)return;
        if(npcEnabled&&(id==='cabinet'||id==='board')&&!hasReadSARUpdateNotice(id)){
            pendingNotice.current=id;setUpdateNotice(id);return;
        }
        enterFacility(id);
    };
    const finishNotice=(read:boolean)=>{
        const notice=pendingNotice.current;if(!notice)return;
        pendingNotice.current=null;setUpdateNotice(null);
        if(read)acknowledgeSARUpdateNotice(notice);
        enterFacility(notice);
    };
    useEffect(()=>{if(!npcEnabled&&pendingNotice.current)finishNotice(false);},[npcEnabled]);
    const view=sarRoomView({roomView,labelsHidden});
    return <div className={`sar-club-room sar-room-view-${view}${view==='text-hidden'?' sar-room-ui-hidden':''}`} data-room-view={view}>
        {updateNotice&&npcEnabled&&<SARUpdateDialogue key={updateNotice} notice={updateNotice} onComplete={()=>finishNotice(true)}/>}
        <div className="sar-room-viewport" ref={viewport}>
            <div className="sar-room-canvas" style={{width:size.width,height:size.height}} data-art-width={SAR_ROOM_SIZE.width} data-art-height={SAR_ROOM_SIZE.height}>
                <img className="sar-room-background" src={roomArt} alt="SAR 活动室" draggable={false}/>
                {size.width>0&&placed.map(actor=>{
                    const npc=actor.id==='sar-npc-caian'?'caian':actor.id==='sar-npc-aiven'?'aiven':null;
                    const char=npc?undefined:occupants.find(c=>c.id===actor.id),chibi=char?getChibi(char):null;
                    const name=npc==='caian'?'凯恩':npc==='aiven'?'艾文':char?.name||'';
                    return <button key={actor.id} type="button" className={`sar-room-person ${npc?'is-npc':''}`}
                        aria-label={npc?`与${name}交谈`:`查看 ${name}`} data-actor-id={actor.id} data-zone={actor.zone} data-foot-x={actor.x} data-foot-y={actor.y}
                        style={{left:`${actor.x/SAR_ROOM_SIZE.width*100}%`,top:`${actor.y/SAR_ROOM_SIZE.height*100}%`,zIndex:20+Math.round(actor.y/SAR_ROOM_SIZE.height*30)}}
                        onClick={()=>{if(npc==='caian')onTalkToCaian?.();else if(npc==='aiven')onTalkToAiven?.();else if(char&&char.id!=='user')onSelectCharacter?.(char);else setRoster(r=>!r);}}>
                        <span className="sar-room-person__shadow"/>
                        <span className={`sar-room-person__body ${chibi?.isFallback?'is-fallback':''}`}>
                        {npc?<SARNpcChibi who={npc}/>:chibi?.img?<TokenImg value={chibi.img} alt={name} draggable={false}
                            className={`sar-room-person__visitor ${chibi.isFallback?'is-fallback':''}`} style={{transform:`scale(${Math.min(1.5,Math.max(.6,chibi.scale))}) scaleX(${chibi.flip?-1:1}) translateY(${chibi.offsetY*size.width/SAR_ROOM_SIZE.width}px)`}}/>
                            :<span className="sar-room-person__fallback">{name.slice(0,1)}</span>}
                        </span>
                        {actor.title&&<span className="sar-room-person__title" title={actor.title} style={{bottom:`calc(100% + ${3+(actor.headOffset||0)}px)`}}>{actor.title}</span>}
                        <span className="sar-room-person__name" title={name}>{name}</span>
                        {npc==='caian'&&!caianMet&&<span className="sar-room-person__quest" aria-hidden="true">!</span>}
                    </button>;
                })}
                <nav className="sar-room-hotspots" aria-label="活动室设施">
                    {SAR_ROOM_HOTSPOTS.map(point=>{const Icon=FacilityIcons[point.id];return <button type="button" key={point.id} className={`sar-room-hotspot align-${point.align}`} data-facility={point.id}
                        style={{left:`${point.x/SAR_ROOM_SIZE.width*100}%`,top:`${point.y/SAR_ROOM_SIZE.height*100}%`}}
                        aria-label={point.ariaLabel} onClick={()=>open(point.id)}><i aria-hidden="true"/><span><Icon size={12} weight="duotone"/>{point.label}</span></button>;})}
                </nav>
            </div>
        </div>
        {occupants.length>0&&<div className="sar-room-roster">
            <button type="button" aria-expanded={roster} onClick={()=>setRoster(r=>!r)}>在场 {occupants.length} 人{overflow.length>0?` · ${overflow.length} 人候位`:''}</button>
            {roster&&<div className="sar-room-roster__list">{occupants.map(char=><button key={char.id} type="button" onClick={()=>{if(char.id!=='user')onSelectCharacter?.(char);}}>
                <span>{char.name}</span><small>{char.vrState?.sarActivity==='fishing'?'钓鱼区':'活动室'}{overflow.includes(char.id)?' · 候位':''}</small>
            </button>)}</div>}
        </div>}
    </div>;
}
