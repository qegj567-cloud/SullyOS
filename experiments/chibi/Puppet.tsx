import React,{useEffect,useMemo,useRef,useState} from 'react';
import * as T from 'three';
import {buildBody,loadBody} from './FbxBody';
import {createWardrobePose} from './wardrobePose';
import {prepareHoodie} from '../../apps/room3d/chibi/hoodieClothes';
import {prepareApprovedWardrobe} from '../../apps/room3d/chibi/approvedClothing';
import {BLANK_SCALE} from '../../apps/room3d/chibi/blankBody';
import {NEW_BODY_HOME_PERCENT} from '../../apps/room3d/chibi/visitor';
import type {HairSettings,Parts,Motion} from '../../apps/room3d/chibi/types';
import type {LayeringReport} from '../../apps/room3d/chibi/garmentLayering';
export type {Parts,Motion};
export function Puppet({parts,yaw,motion,wire,playing,appearance='outfit',hair,focus='body',wardrobeStyle,wardrobeReplay=0,onLayeringReport}:{onLayeringReport?:(report:LayeringReport|undefined)=>void;focus?:'body'|'head';wardrobeStyle?:HairSettings['wardrobeStyle'];wardrobeReplay?:number;hair?:HairSettings;parts:Parts;yaw:number;motion:Motion;wire:boolean;playing:boolean;appearance?:'skin'|'hair'|'outfit'}){
 const host=useRef<HTMLDivElement>(null),rig=useRef<ReturnType<typeof buildBody>>(),wake=useRef(()=>{});
 type Outfit={attach():void;dispose():void;updatePose?():void;updateColors?:(value:HairSettings['wardrobeColors'])=>void;layeringReport?:LayeringReport};
 const outfitRef=useRef<Outfit>();
 const colorsRef=useRef(hair?.wardrobeColors);colorsRef.current=hair?.wardrobeColors;
 const reportRef=useRef(onLayeringReport);reportRef.current=onLayeringReport;
 // Body/hair resources and the animation clock survive every wardrobe edit.
 const shapeKey=JSON.stringify(hair?{...hair,wardrobe:undefined,wardrobeFits:undefined,wardrobeColors:undefined,wardrobeLayering:undefined,wardrobeStyle:undefined,face:undefined}:null);
 const shapeHair=useMemo(()=>hair?{...hair,wardrobe:undefined,wardrobeFits:undefined,wardrobeColors:undefined,wardrobeLayering:undefined,wardrobeStyle:undefined,face:undefined}:undefined,[shapeKey]);
 const outfitKey=JSON.stringify([hair?.wardrobe,hair?.wardrobeFits,hair?.wardrobeLayering]);
 const outfitSettings=useMemo(()=>({wardrobe:hair?.wardrobe,fits:hair?.wardrobeFits,layering:hair?.wardrobeLayering}),[outfitKey]);
 const controls=useRef({yaw,motion,wire,playing,focus});controls.current={yaw,motion,wire,playing,focus};
 const posing=useRef<{root:T.Group;sample:(t:number)=>void}>();
 const [source,setSource]=useState<T.Group>(),[body,setBody]=useState<ReturnType<typeof buildBody>>(),[error,setError]=useState(''),[dressing,setDressing]=useState(false);
 useEffect(()=>{let cancelled=false,loaded:T.Group|undefined;const release=()=>loaded?.traverse(o=>{if(o instanceof T.Mesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});loadBody().then(m=>{loaded=m;if(cancelled)release();else setSource(m);}).catch(e=>{if(!cancelled)setError(String(e));});return()=>{cancelled=true;release();};},[]);
 const scene=useRef<T.Scene>();
 useEffect(()=>{
  const element=host.current!;let renderer:T.WebGLRenderer;
  try{renderer=new T.WebGLRenderer({antialias:true,alpha:true});}catch(e){setError(String(e));return;}
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));element.appendChild(renderer.domElement);
  const world=new T.Scene();scene.current=world;
  world.add(new T.AmbientLight('#ffffff',.65),new T.HemisphereLight('#ffffff','#ede6df',1.9));
  const key=new T.DirectionalLight('#fff8ef',.65);key.position.set(-3,5,5);world.add(key);
  const fill=new T.DirectionalLight('#f1f4ff',.35);fill.position.set(3,2,-4);world.add(fill);
  const floor=new T.Mesh(new T.CircleGeometry(1.8,48),new T.MeshStandardMaterial({color:'#ddd5c7',roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=.015;world.add(floor);
  const camera=new T.OrthographicCamera(-1.6,1.6,1.6,-1.6,.1,30);camera.position.set(0,1.1,6);camera.lookAt(0,1.1,0);
  let framing=1.1,viewHalf=1.48,aspect=1;
  let frame=0,disposed=false,time=0,previous=0,lastDraw=0,dirty=true,lastRig:typeof rig.current,lastMotion:Motion|undefined,frames=0;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const schedule=()=>{dirty=true;if(!disposed&&!document.hidden&&!frame)frame=requestAnimationFrame(draw);};wake.current=schedule;
  function draw(stamp:number){frame=0;if(disposed||document.hidden)return;const c=controls.current,r=rig.current,animate=c.playing&&!reduced.matches;
   const dt=previous?Math.min((stamp-previous)/1000,.05):0;previous=stamp;if(animate)time+=dt;
   if(dirty||stamp-lastDraw>=1000/30){
    if(r){if(c.motion!==lastMotion){time=0;}if(posing.current?.root===r.root&&c.motion==='idle'){posing.current.sample(time);}else if(r!==lastRig||c.motion!==lastMotion||animate){r.animate(time,c.motion);}r.updateFace(time);r.root.rotation.y=c.yaw*Math.PI/180;outfitRef.current?.updatePose?.();r.root.traverse(o=>{if(o instanceof T.Mesh)for(const m of Array.isArray(o.material)?o.material:[o.material])m.wireframe=c.wire;});lastRig=r;lastMotion=c.motion;}
    const targetY=c.focus==='head'?(r?.rig? (r.root.updateMatrixWorld(true),r.rig.bones.head.getWorldPosition(new T.Vector3()).y+.25):1.9):1.18;
    const targetHalf=c.focus==='head'?Math.max(.61,.46/aspect):Math.max(1.48,1.22/aspect);
    const ease=reduced.matches?1:1-Math.exp(-Math.max(dt,1/60)*12);framing=T.MathUtils.lerp(framing,targetY,ease);viewHalf=T.MathUtils.lerp(viewHalf,targetHalf,ease);
    camera.position.set(0,framing,6);camera.lookAt(0,framing,0);camera.left=-viewHalf*aspect;camera.right=viewHalf*aspect;camera.top=viewHalf;camera.bottom=-viewHalf;camera.updateProjectionMatrix();
    element.dataset.focus=c.focus;renderer.render(world,camera);frames++;element.dataset.frames=String(frames);element.dataset.drawCalls=String(renderer.info.render.calls);element.dataset.triangles=String(renderer.info.render.triangles);dirty=false;lastDraw=stamp;
   }
   if(animate||Math.abs(framing-(c.focus==='head'?(r?.rig?r.rig.bones.head.getWorldPosition(new T.Vector3()).y+.25:1.9):1.18))>.002||Math.abs(viewHalf-(c.focus==='head'?Math.max(.61,.46/aspect):Math.max(1.48,1.22/aspect)))>.002)frame=requestAnimationFrame(draw);
  }
  const resize=()=>{const w=element.clientWidth,h=element.clientHeight;if(!w||!h)return;renderer.setSize(w,h);aspect=w/h;const half=viewHalf;camera.left=-half*aspect;camera.right=half*aspect;camera.top=half;camera.bottom=-half;camera.updateProjectionMatrix();schedule();};
  const observer=new ResizeObserver(resize);observer.observe(element);resize();
  const visibility=()=>{previous=0;if(document.hidden){cancelAnimationFrame(frame);frame=0;}else schedule();};document.addEventListener('visibilitychange',visibility);
  return()=>{disposed=true;cancelAnimationFrame(frame);observer.disconnect();document.removeEventListener('visibilitychange',visibility);wake.current=()=>{};scene.current=undefined;floor.geometry.dispose();floor.material.dispose();renderer.dispose();renderer.domElement.remove();};
 },[]);
 useEffect(()=>{
  if(!source||!scene.current)return;
  let next:ReturnType<typeof buildBody>;
  try{next=buildBody(source,parts,appearance,shapeHair);}catch(e){setError(String(e));return;}
  if(next.rig)next.root.scale.setScalar(1.4/BLANK_SCALE*(NEW_BODY_HOME_PERCENT/100));
  rig.current=next;setBody(next);scene.current.add(next.root);setError('');
  // Expose identity alongside the existing frame counters for preview QA.
  if(host.current)host.current.dataset.bodyId=next.root.uuid;
  wake.current();
  return()=>{outfitRef.current?.dispose();outfitRef.current=undefined;next.root.removeFromParent();next.resources.forEach(r=>r.dispose());if(rig.current===next)rig.current=undefined;};
 },[source,parts,appearance,shapeHair]);
 useEffect(()=>{
  if(!body?.rig||!wardrobeStyle)return;
  const clip=createWardrobePose(body.rig,wardrobeStyle),mixer=new T.AnimationMixer(body.root),loop=mixer.clipAction(clip);loop.play();loop.paused=true;
  let started:number|undefined;
  const pose={root:body.root,sample(t:number){started??=t;loop.time=(t-started)%clip.duration;mixer.update(0);}};posing.current=pose;wake.current();
  return()=>{mixer.stopAllAction();mixer.uncacheRoot(body.root);if(posing.current===pose)posing.current=undefined;};
 },[body,wardrobeStyle,wardrobeReplay]);
 useEffect(()=>{
  if(!body||rig.current!==body)return;
  let cancelled=false;
  if(!body.rig||appearance!=='outfit'){setDressing(false);reportRef.current?.(undefined);return;}
  setDressing(true);setError('');
  (async()=>{
   const outfit:Outfit=outfitSettings.wardrobe===undefined?prepareHoodie(body.rig!):await prepareApprovedWardrobe(body.rig!,outfitSettings.wardrobe,outfitSettings.fits,undefined,outfitSettings.layering);
   if(cancelled||rig.current!==body){outfit.dispose();return;}
   outfit.updateColors?.(colorsRef.current);
   // No frame can see a half-loaded outfit. Pending/failed loads leave the
   // current clothes, skin mask, skeleton and footwear support in place.
   outfitRef.current?.dispose();outfit.attach();outfitRef.current=outfit;
   reportRef.current?.(outfit.layeringReport);setDressing(false);wake.current();
  })().catch(e=>{if(!cancelled){setError(String(e));setDressing(false);}});
  return()=>{cancelled=true;};
 },[body,appearance,outfitSettings]);
 useEffect(()=>{if(!body)return;let cancelled=false;body.setFaceSettings(hair?.face).then(()=>{if(!cancelled)wake.current();}).catch(e=>{if(!cancelled)setError(`表情素材加载失败：${String(e)}`);});return()=>{cancelled=true;};},[body,hair?.face]);
 useEffect(()=>{outfitRef.current?.updateColors?.(hair?.wardrobeColors);wake.current();},[hair?.wardrobeColors]);
 useEffect(()=>{wake.current();},[yaw,motion,wire,playing,focus]);
 return <div ref={host} className="puppet" aria-busy={dressing}>{error&&<p role="alert">{error}</p>}{!source&&!error&&<p>正在加载小人…</p>}{source&&dressing&&!outfitRef.current&&!error&&<p role="status">正在换装…</p>}</div>;
}
