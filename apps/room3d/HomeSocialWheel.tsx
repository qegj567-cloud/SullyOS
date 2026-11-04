import {BED_LEISURE} from './chibi/bedLeisure';
import {socialPostureAllowed} from './socialPosture';
import {Button} from './islandComponents';
import React,{useEffect,useRef,useState} from 'react';
import {HandWaving,ChatCircle,Heart,Flower,Smiley,Sparkle,CloudLightning,ArrowLeft,ArrowRight,X,Users,Stop,Handshake,HandsClapping,SmileySad,SmileyNervous,PersonSimpleRun,Moon,HandHeart} from '@phosphor-icons/react';
import type {HomeEditor} from './editor.js';
import {selectedMotions} from './chibi/selectedMotions';
import {socialWheelLayout} from './socialWheelLayout';
import {isRomanticMotion} from './homeRomance';
import './socialWheel.css';
const categories=[['greet','招呼',HandWaving],['talk','聊天',ChatCircle],['care','关心',Flower],['close','亲密',Heart],['play','玩闹',Smiley],['mischief','恶作剧',SmileyNervous],['self','小动作',Sparkle],['conflict','闹别扭',CloudLightning]] as const;
function motionIcon(label:string,fallback:typeof Sparkle){
 if(/鼓掌|击掌/.test(label))return HandsClapping;
 if(/招手|挥手/.test(label))return HandWaving;
 if(/握手/.test(label))return Handshake;
 if(/搭肩|扶肩|安慰/.test(label))return HandHeart;
 if(/低落|失落/.test(label))return SmileySad;
 if(/吓|惊/.test(label))return SmileyNervous;
 if(/走|跑|拳击/.test(label))return PersonSimpleRun;
 if(/睡|休息/.test(label))return Moon;
 return fallback;
}
export function HomeSocialWheel({editor,actor,name,selfOnly=false,body,busy,status,available,onPlay,onClose,onSettings,onStop}:{editor:HomeEditor;body?:'blank'|'classic';selfOnly?:boolean;actor:string;name:string;busy:boolean;status:string;available:(motion:typeof selectedMotions[number])=>boolean;onPlay:(id:string)=>void;onClose:()=>void;onSettings:()=>void;onStop:()=>void}){
 const [category,setCategory]=useState<string|null>(null),[page,setPage]=useState(0),[anchor,setAnchor]=useState({x:195,y:380,width:390,height:844});
 const root=useRef<HTMLDivElement>(null);
 const [postures,setPostures]=useState(()=>[editor.getResidentPosture?.('user')||'standing',editor.getResidentPosture?.(actor)||'standing']);
 useEffect(()=>{const timer=setInterval(()=>{const next=[editor.getResidentPosture?.('user')||'standing',editor.getResidentPosture?.(actor)||'standing'];setPostures(old=>old[0]===next[0]&&old[1]===next[1]?old:next);},150);return()=>clearInterval(timer);},[editor,actor]);
 useEffect(()=>{const update=()=>{const box=root.current?.getBoundingClientRect();const point=editor.getResidentAnchor?.(actor);if(!point&&editor.getResidentAnchor){onClose();return;}if(point)setAnchor(old=>JSON.stringify(old)===JSON.stringify(point)?old:point);else if(box)setAnchor({x:box.width/2,y:box.height/2,width:box.width,height:box.height});};update();const timer=setInterval(update,100);return()=>clearInterval(timer);},[editor,actor,onClose]);
 useEffect(()=>{setCategory(null);setPage(0);},[postures[0],postures[1]]);
 useEffect(()=>{root.current?.querySelector<HTMLButtonElement>('button')?.focus();},[category,page]);
 const categoryInfo=categories.find(c=>c[0]===category),Icon=categoryInfo?.[2]??Sparkle;
 const motions=selectedMotions.filter(m=>(!isRomanticMotion(m.id)||editor.canPlaySocial?.(m.id,'user',actor)===true)&&(!['home-princess-carry','home-princess-carried'].includes(m.id)||body==='blank')&&(!selfOnly||m.participants===1)&&socialPostureAllowed(m.id,postures[0],postures[1],m.participants));
 const visibleCategories=categories.filter(([id])=>(selfOnly||id!=='self')&&motions.some(m=>m.category===id));
 const items=category?motions.filter(m=>m.category===category).map(m=>({id:m.id,label:m.label.replace(/\s*[AB]→[AB]/g,'').replace(/\s*·\s*双人/g,''),Icon:motionIcon(m.label,Icon),disabled:!available(m),run:()=>onPlay(m.id)})):visibleCategories.map(([id,label,Icon])=>({id,label,Icon,disabled:false,run:()=>{setCategory(id);setPage(0);}}));
 if(selfOnly&&!category&&postures[0]==='standing'&&editor.summonOwner)items.unshift({id:'summon',label:'把大家叫过来',Icon:HandWaving,disabled:false,run:()=>{(editor.summonAll??editor.summonOwner)?.();onClose();}});
 if(selfOnly&&!category&&['seated','lying'].includes(postures[0])&&editor.standResident)items.unshift({id:'stand',label:'起身',Icon:PersonSimpleRun,disabled:false,run:()=>{editor.standResident?.('user');onClose();}});
 if(selfOnly&&!category&&postures[0]==='lying'&&body==='blank'&&editor.setResidentBedMode)items.push(...[...BED_LEISURE,['sleep','睡一会儿']].map(([id,label])=>({id,label,Icon:id==='bed-talk'?ChatCircle:Moon,disabled:false,run:()=>{editor.setResidentBedMode?.('user',id);onClose();}})));
 const perPage=anchor.height<560?3:4,pages=Math.max(1,Math.ceil(items.length/perPage)),currentPage=Math.min(page,pages-1),shown=items.slice(currentPage*perPage,currentPage*perPage+perPage),layout=socialWheelLayout(anchor.x,anchor.y,anchor.width,anchor.height,shown.length);
 const backLabel=currentPage>0?'上一组互动':category?'返回互动分类':'返回家园';
 const goBack=()=>{if(currentPage>0)setPage(currentPage-1);else if(category){setCategory(null);setPage(0);}else onClose();};
 return <div className="home-social-wheel" ref={root} role="dialog" aria-label={`${name}的互动`} aria-modal="true" onPointerDown={e=>{if(e.target===e.currentTarget)onClose();}} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();goBack();}if(e.key==='Tab'){const buttons=[...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];if(e.shiftKey&&document.activeElement===buttons[0]){e.preventDefault();buttons.at(-1)?.focus();}else if(!e.shiftKey&&document.activeElement===buttons.at(-1)){e.preventDefault();buttons[0]?.focus();}}}}>
  <svg className="social-wheel-orbit" aria-hidden="true" width={anchor.width} height={anchor.height}>
   {shown.length>1&&(layout.edge?<path d={`M ${layout.points[0].x} ${layout.points[0].y} A ${Math.hypot(layout.points[0].x-layout.center.x,layout.points[0].y-layout.center.y)} ${Math.hypot(layout.points[0].x-layout.center.x,layout.points[0].y-layout.center.y)} 0 0 1 ${layout.points.at(-1)!.x} ${layout.points.at(-1)!.y}`}/>:<circle cx={layout.center.x} cy={layout.center.y} r={Math.hypot(layout.points[0].x-layout.center.x,layout.points[0].y-layout.center.y)}/>)}
  </svg>
  {shown.map((item,i)=><button className="social-petal" data-affection={item.Icon===Heart} key={item.id} style={{left:layout.points[i].x,top:layout.points[i].y,'--petal-index':i} as React.CSSProperties} aria-label={item.label} aria-disabled={busy||item.disabled} title={item.disabled?'请在成员中邀请你的小人，并等待形象准备好':item.label} onClick={()=>{if(busy)return;if(item.disabled){onSettings();return;}item.run();}}><i className="social-petal-icon"><item.Icon size={28} weight="duotone"/></i><span>{item.label}</span></button>)}
  <div className="social-wheel-near-pages social-wheel-navigation" style={{left:Math.max(76,Math.min(anchor.width-76,layout.center.x)),top:Math.min(anchor.height-100,(layout.points.length?Math.max(...layout.points.map(p=>p.y)):layout.center.y)+58)}}>
   <Button type="text" aria-label={backLabel} onClick={goBack}><ArrowLeft size={18}/><span>返回</span></Button>
   {pages>1&&<><span className="social-wheel-page-count" aria-live="polite">{currentPage+1}/{pages}</span><Button type="text" aria-label="下一组互动" onClick={()=>setPage((currentPage+1)%pages)}><ArrowRight size={18}/></Button></>}
  </div>
  <div className="social-wheel-footer"><p role="status" data-notice={!!status}>{status||(category?'选一个动作':selfOnly?'我要做什么？':`我要对 ${name}…`)}</p><div>{editor.controlResident&&<Button type="text" aria-label={selfOnly?'操控自己':'操控角色'} onClick={()=>{if(editor.controlResident?.(actor))onClose();}}><PersonSimpleRun/><span>{selfOnly?'操控自己':`操控 ${name}`}</span></Button>}<Button type="text" aria-label="成员与形象" onClick={onSettings}><Users/><span>成员</span></Button><Button type="text" disabled={busy} onClick={onStop}><Stop/><span>停止</span></Button><Button type="text" aria-label="关闭互动菜单" onClick={onClose}><X/><span>关闭</span></Button></div></div>
 </div>;
}

