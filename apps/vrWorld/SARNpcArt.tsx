import React,{useEffect,useState} from 'react';
import CdnImg from '../../components/os/CdnImg';
import caianChibi from '../../assets/sar/caian-chibi.png';
import aivenChibi from '../../assets/sar/aiven-chibi.png';
import {sarPortraitPath,SAR_NPC_NAMES,type SARExpression,type SARCastExpressions} from '../../utils/vrWorld/sarArt';
import type {SARDialogueSpeaker} from '../../utils/vrWorld/sarClub';
import './sar-npc-art.css';
import {HalloweenChibi} from './KanataHalloween';

const CHIBI_ART={
    caian:caianChibi,
    aiven:aivenChibi,
};
const loadedPortraits=new Map<string,string>();
// 这四张同名素材更新过透明背景，用素材提交号避开浏览器里的旧白底图。
const refreshedPortraits=new Set(['Enduring Pain','avoidant','normal2','warm'].map(name=>`SAR/Caian/${name}.png`));
/** Same original canvas and base scale as visitor chibis; never trim NPCs independently. */
export function SARNpcChibi({who,className=''}:{who:SARDialogueSpeaker;className?:string}){
    const art=CHIBI_ART[who];
    return <span className={`sar-npc-chibi ${className}`} style={{aspectRatio:'1'}}>
        <HalloweenChibi actorId={`sar-npc-${who}`} img={art} name={`${SAR_NPC_NAMES[who]} Q 版形象`}
            style={{width:'100%',left:0,top:0}}/>
    </span>;
}

function PortraitImage({who,expression}:{who:SARDialogueSpeaker;expression:SARExpression}){
    const desired=sarPortraitPath(who,expression),normal=sarPortraitPath(who);
    const [lastReady,setLastReady]=useState<{path:string;src:string}|null>(null),[failed,setFailed]=useState<string[]>([]),[localFailed,setLocalFailed]=useState<string[]>([]);
    const path=failed.includes(desired)?normal:desired,broken=failed.includes(path);
    const cached=loadedPortraits.get(path),shown=cached?{path,src:cached}:lastReady;
    const waiting=!broken&&!cached;
    return <div className="sar-npc-portrait" data-speaker={who} data-expression={expression} aria-busy={waiting}>
        {shown&&<img src={shown.src} className="sar-npc-portrait__image" alt={`${SAR_NPC_NAMES[who]}立绘`} draggable={false}/>}
        {waiting&&!localFailed.includes(path)&&<img src={import.meta.env.BASE_URL+'sar-portraits/'+path.replace(/^SAR\//,'').replace(/\.png$/,'.webp')+(refreshedPortraits.has(path)?'?v=01edb974':'')} className="sar-npc-portrait__image sar-npc-portrait__pending" alt="" aria-hidden="true" decoding="async" onLoad={event=>{const src=event.currentTarget.currentSrc;loadedPortraits.set(path,src);setLastReady({path,src});}} onError={()=>setLocalFailed(prev=>[...prev,path])}/>}
        {waiting&&localFailed.includes(path)&&<CdnImg key={`loading:${path}`} path={path} className="sar-npc-portrait__image sar-npc-portrait__pending" alt="" aria-hidden="true" decoding="async"
            onLoad={event=>{const src=event.currentTarget.currentSrc;loadedPortraits.set(path,src);setLastReady({path,src});}} onError={()=>setFailed(prev=>[...prev,path])}/>}
        {!shown&&<div className="sar-npc-portrait__placeholder" role="status">{broken?'立绘暂时未加载':SAR_NPC_NAMES[who]}
            {broken&&<button type="button" onClick={()=>{setFailed([]);setLocalFailed([]);}}>重新加载</button>}</div>}
    </div>;
}
export function SARPortrait({who,expression='normal'}:{who:SARDialogueSpeaker;expression?:SARExpression}){
    return <PortraitImage key={who} who={who} expression={expression}/>;
}

export function SARDialogueCast({speaker,lead=speaker,expression='normal',castExpressions,keepGuest=false}:{speaker:SARDialogueSpeaker;lead?:SARDialogueSpeaker;expression?:SARExpression;castExpressions?:Partial<SARCastExpressions>;keepGuest?:boolean}){
    const [expressions,setExpressions]=useState<Record<SARDialogueSpeaker,SARExpression>>({caian:'normal',aiven:'normal'});
    useEffect(()=>setExpressions(previous=>({...previous,...castExpressions,[speaker]:expression})),[speaker,expression,castExpressions]);
    const visible={...expressions,...castExpressions,[speaker]:expression};
    const actors:SARDialogueSpeaker[]=speaker===lead&&!keepGuest?[lead]:['caian','aiven'];
    return <div className={`sar-dialogue-cast ${actors.length===1?'is-solo':'is-exchange'}`} data-speaking={speaker} data-lead={lead}>
        {actors.map(who=><div key={who} className={`sar-dialogue-cast__actor cast-${who} ${speaker===who?'is-speaking':''}`}>
            <SARPortrait who={who} expression={visible[who]}/>
        </div>)}
    </div>;
}
