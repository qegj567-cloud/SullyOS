import React,{useEffect,useRef,useState} from 'react';
// @ts-expect-error Shared runtime JS helpers have no declaration files.
import {seatTransform} from '../../apps/room3d/seating.js';
// @ts-expect-error Shared runtime JS helpers have no declaration files.
import {body2BedTransform,bedFootSurface} from '../../apps/room3d/bedMotion.js';
import {createRoot} from 'react-dom/client';
import {CreatorRollBridge} from '../../apps/room3d/chibi/CreatorRollBridge';
import {createVisitor,decodeParts,NEW_BODY_HOME_PERCENT,type ChibiVisitor} from '../../apps/room3d/chibi/visitor';
import {defaultFace} from '../../apps/room3d/chibi/faceAppearance';
import {selectedHairAssets,type Parts,type HairSettings} from '../../apps/room3d/chibi/types';
import {mountHomeEditor} from '../../apps/room3d/editor.js';
import {createHome} from '../../apps/room3d/model.js';
import {furnishShowroom,SHOWROOMS} from '../../apps/room3d/showrooms.js';
import {gamingPreset} from '../../apps/room3d/gaming.js';
import {diningPreset} from '../../apps/room3d/dining.js';
import {setBoundary} from '../../apps/room3d/topology.js';
import {bathroomHome} from './bathroom-layout.js';
import {testCharacter} from './room3d-test-character';
import {APPROVED_ROOM_WALK_ID} from '../../apps/room3d/chibi/approvedRoomWalk';
import '../../apps/room3d/editor.css';
import './room3d-body-comparison.css';
const rooms=[['living','客厅'],['bedroom','卧室'],['study','书房'],['kitchen','厨房'],['bathroom','浴室'],['motion','动作练习区'],['race','赛车'],['rhythm','圆环音游'],['dining','餐桌'],['plush','玩偶'],['beds','旧床验收'],['seats','座椅验收']];
const ids=['classic','blank'] as const,labels=['原版 Chibi','二号素体'];
const bedPair=new URLSearchParams(location.search).has('pair');
const defaultSizes:Record<string,number>={classic:bedPair?NEW_BODY_HOME_PERCENT:100,blank:NEW_BODY_HOME_PERCENT};
function Comparison(){
 const [request,setRequest]=useState(0),[parts,setParts]=useState<Parts>(),[kind,setKind]=useState(()=>{const id=new URLSearchParams(location.search).get('room');return rooms.some(([k])=>k===id)?id!:'living';});
 const [assetId,setAssetId]=useState(()=>new URLSearchParams(location.search).get('asset')||''),[catalogAssets,setCatalogAssets]=useState<{id:string;name:string;beds?:unknown;seats?:unknown}[]>([]);
 const [active,setActive]=useState(()=>new URLSearchParams(location.search).get('body')==='blank'?'blank':'classic'),[status,setStatus]=useState('正在准备固定角色…'),[busy,setBusy]=useState(true);
 const [sizes,setSizes]=useState(defaultSizes),sizesRef=useRef(sizes);sizesRef.current=sizes;
 const host=useRef<HTMLDivElement>(null),editor=useRef<any>(null),activeRef=useRef(active);activeRef.current=active;
 const actors=useRef<ChibiVisitor[]>([]);
 const bedLayout=useRef<any>(null);
 useEffect(()=>{
  if(!parts)return;
  let cancelled=false,owned=false,e:any=null;const visitors:ChibiVisitor[]=[];const abort=new AbortController();
  setBusy(true);setStatus('正在准备两种体型和房间…');
  const release=()=>{e?.dispose();if(!owned)visitors.forEach(v=>v.dispose());};
  void(async()=>{
   try{
    const catalog=await fetch('/room3d/catalog.json',{signal:abort.signal}).then(r=>r.json());
    setCatalogAssets(catalog);
    const home=kind==='bathroom'?bathroomHome(catalog):createHome(catalog),room=home.rooms[0];
    if(kind!=='bathroom'){room.items=[];if(['race','rhythm'].includes(kind))room.items=gamingPreset(kind,catalog);else if(kind==='dining')room.items=diningPreset(catalog);else if(['beds','seats'].includes(kind))room.items=[{id:'bed-review',assetId:assetId||(kind==='beds'?'bedroom_single_bed':'show_living_pouf'),x:0,y:.15,z:0,rotation:0,color:null,stored:false}];else if(kind==='plush')room.items=catalog.filter((a,i)=>a.holdable).map((a,i)=>({id:'plush-'+i,assetId:a.id,x:-2.4+i*1.6,y:.15,z:-1.6,rotation:0,color:null,stored:false}));else if(kind!=='motion')furnishShowroom(room,kind,catalog);setBoundary(home,room.id,'front',{kind:'wall_high',door:{kind:(SHOWROOMS[kind]??SHOWROOMS.living).door,at:0,width:2.2}},catalog);}
    if(kind==='motion'){room.name='动作练习区';room.wall='#f4f4ec';room.trim='#586653';room.floor='#d7d6cb';}
    const hair:HairSettings={layers:{},extras:[],assets:selectedHairAssets(testCharacter.state),headSize:1.04,bodyHeight:1,face:{...defaultFace,irisColor:'#5e8068'}};
    bedLayout.current={catalog,room};
    // Sequential creation makes ownership and cancellation explicit.
    for(const bodyShape of ids){const v=await createVisitor(parts,{...hair,bodyShape:bedPair?'blank':bodyShape});v.setScaleMultiplier(sizesRef.current[bodyShape]/defaultSizes[bodyShape]);visitors.push(v);if(cancelled){release();return;}}
    e=await mountHomeEditor(host.current!,{assetBase:new URL('/room3d/',location.href).href,initialState:home,signal:abort.signal,...bedPair?{onMenu:()=>{}}:{}});
    if(cancelled){release();return;}
    if(bedPair){e.setPrimaryResidentId('blank','小栗');e.setVisitor(visitors[1]);e.setSocialResident('user',visitors[0],'你');e.controlResident('blank');}
    else e.setComparisonVisitors(visitors.map((visitor,i)=>({id:ids[i],label:labels[i],visitor})),activeRef.current);
    owned=true;editor.current=e;actors.current=visitors;
    const w=window as any;w.__homeEditor=e;w.__comparisonVisitors=visitors;
    w.render_game_to_text=()=>JSON.stringify({character:testCharacter.name,room:kind,walkCandidate:APPROVED_ROOM_WALK_ID,walkSpeed:visitors[1].walkSpeed,...e.inspect()});w.advanceTime=(ms:number)=>e.advanceTime(ms);
    setBusy(false);setStatus('切换体型，点同一件家具对照动作。');
   }catch(error){release();if(!cancelled){setStatus(`加载失败：${error}`);setBusy(false);console.error(error);}}
  })();
  return()=>{cancelled=true;abort.abort();release();editor.current=null;delete (window as any).__homeEditor;};
 },[parts,kind,assetId]);
 const chooseActor=(id:string)=>{if(bedPair?editor.current?.controlResident(id==='blank'?'blank':'user'):editor.current?.setActiveComparisonVisitor(id))setActive(id);};
 const resizeActor=(percent:number)=>{if(editor.current?.setComparisonVisitorScale(active,percent/defaultSizes[active]))setSizes(previous=>({...previous,[active]:percent}));};
 const changeRoom=(id:string)=>{setKind(id);setAssetId('');const url=new URL(location.href);url.searchParams.set('room',id);url.searchParams.delete('asset');history.replaceState(null,'',url);};
 const previewWalk=(enabled=true)=>{chooseActor('blank');editor.current?.previewComparisonWalk(enabled);};
 const previewBedPair=()=>{
  const e=editor.current,{catalog,room}=bedLayout.current,item=room.items.find((i:any)=>i.assetId==='show_bed');if(!e||!item)return;
  e.setSuspended(true);
  actors.current.forEach((v,i)=>{
   const seat=body2BedTransform(seatTransform(room,catalog,{roomId:room.id,itemId:item.id,seatId:String(i),bed:true},true),v.bedHeadToHip,v.bedHipHeight);
   v.root.parent!.position.fromArray(seat.position);v.root.parent!.rotation.set(0,seat.rotation,0);v.root.position.set(0,0,0);v.root.quaternion.identity();
   v.animate(3,'sleep','lying',{kind:'bed-rest',hands:[],bedTime:3,bedFootSurface:bedFootSurface(seat,v.seatScale)});
   v.updateExpression(3,{eyes:'closed',blink:false});
  });
  e.beginPhotoMode();e.setPhotoCamera({yaw:65,pitch:25,zoom:1.35,height:.05});void e.capturePhoto();setStatus('双人躺位静态验收：复用正式床位与睡姿；此视图不测试上床路径。');
 };
 return <><header className="comparison-bar"><div><h1>小栗 · 样板房动作对照</h1><p>固定栗棕发、绿眼睛 · 两种体型同场 · 先从客厅逐间看</p></div><nav aria-label="样板房">{rooms.map(([id,label],i)=><button key={id} disabled={busy} aria-pressed={kind===id} onClick={()=>changeRoom(id)}>{i+1} {label}</button>)}</nav>{["beds","seats"].includes(kind)&&<label>家具 <select aria-label="验收家具" disabled={busy} value={assetId||(kind==="beds"?"bedroom_single_bed":"show_living_pouf")} onChange={event=>{setAssetId(event.target.value);const url=new URL(location.href);url.searchParams.set("asset",event.target.value);history.replaceState(null,"",url);}}>{catalogAssets.filter(a=>kind==="beds"?a.beds:a.seats).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}<div className="comparison-actors"><span>当前测试</span>{ids.map((id,i)=><button key={id} disabled={busy} aria-pressed={active===id} onClick={()=>chooseActor(id)}>{bedPair?(id==='blank'?'操控小栗':'操控你'):labels[i]}</button>)}<div className="comparison-size"><label htmlFor="actor-size">角色大小 <output>{sizes[active]}%</output></label><input id="actor-size" type="range" min={active==='blank'?90:60} max={active==='blank'?260:180} step={1} value={sizes[active]} disabled={busy||bedPair} onChange={event=>resizeActor(Number(event.target.value))}/><button disabled={busy||sizes[active]===defaultSizes[active]} onClick={()=>resizeActor(defaultSizes[active])}>恢复原大小</button></div><span className="comparison-status" role="status">{status}</span></div><section className="comparison-walk" aria-label="日常走路"><strong>日常走路 · Meshy 10</strong><div className="comparison-walk-buttons"><button disabled={busy} onClick={()=>previewWalk()}>原地试看</button><button disabled={busy} onClick={()=>{chooseActor("blank");editor.current?.walkComparisonRoute();}}>走一小段</button><button disabled={busy} onClick={()=>previewWalk(false)}>停止试看</button><button disabled={busy} onClick={()=>{for(let i=0;i<120;i++)editor.current?.advanceTime?.(100);}}>快进当前动作 12 秒</button>{bedPair&&<button disabled={busy} onClick={previewBedPair}>查看双人躺位</button>}</div><p>点房间空地可实际走动。来源：<a href="https://www.meshy.ai/animation-library" target="_blank" rel="noreferrer">Meshy · Walking</a> · 用户导出第 10 段</p></section></header><div className="comparison-room" ref={host}/><CreatorRollBridge savedState={testCharacter.state} request={request} onReady={()=>setRequest(1)} onResult={result=>{void decodeParts(result).then(setParts).catch(error=>setStatus(String(error)));}} onError={setStatus}/></>;
}
createRoot(document.getElementById('root')!).render(<Comparison/>);
