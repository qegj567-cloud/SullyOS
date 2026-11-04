import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {mountHomeEditor} from '../../apps/room3d/editor.js';
import {CreatorRollBridge} from '../../apps/room3d/chibi/CreatorRollBridge';
import {createVisitor,decodeParts} from '../../apps/room3d/chibi/visitor';
import {selectedHairAssets,type Parts} from '../../apps/room3d/chibi/types';
import '../../apps/room3d/editor.css';
import HomePhotoMode from '../../apps/room3d/HomePhotoMode';
import {createHome} from '../../apps/room3d/model.js';
import {testCharacter} from './room3d-test-character';
import type {HomeEditor} from '../../apps/room3d/editor';
const catalog=await fetch('/room3d/catalog.json').then(r=>r.json()),home=createHome(catalog);
const hair={bodyShape:new URLSearchParams(location.search).has('classic')?'classic' as const:'blank' as const,layers:{},extras:[],assets:selectedHairAssets(testCharacter.state)};
function PhotoQA(){const [editor,setEditor]=useState<HomeEditor>(),[open,setOpen]=useState(false),[parts,setParts]=useState<Parts>(),[request,setRequest]=useState(0),[ready,setReady]=useState(false);const stage=useRef<HTMLDivElement>(null);
 useEffect(()=>{let instance:HomeEditor;let closed=false;mountHomeEditor(stage.current!,{initialState:home,assetBase:new URL('/room3d/',location.href).href}).then(e=>{instance=e;if(closed){e.dispose();return;}e.setPrimaryResidentId('photo-qa-only','小栗');setEditor(e);const w=window as any;w.__homeEditor=e;w.advanceTime=()=>{};w.render_game_to_text=()=>JSON.stringify({photo:!!document.querySelector('.home-photo-mode'),...e.inspect?.() as object});});return()=>{closed=true;instance?.dispose();};},[]);
 useEffect(()=>{if(!editor||!parts)return;let closed=false;Promise.all([createVisitor(parts,hair),createVisitor(parts,hair)]).then(([a,b])=>{if(closed){a.dispose();b.dispose();return;}editor.setVisitor?.(a);editor.setSocialResident('user',b,'你');setReady(true);});return()=>{closed=true;};},[editor,parts]);
 useEffect(()=>{if(ready&&new URLSearchParams(location.search).has('photo'))setOpen(true);},[ready]);
 return <main><div ref={stage}/><CreatorRollBridge request={request} onReady={()=>setRequest(1)} onError={message=>{console.error(message);}}  savedState={testCharacter.state} onResult={r=>{decodeParts(r,hair).then(setParts);}}/>
 {!open&&<button className="photo-qa-open" disabled={!editor||!ready} onClick={()=>setOpen(true)}>开始拍照验收</button>}
 {open&&editor&&<HomePhotoMode editor={editor} onClose={()=>setOpen(false)}/>}
 </main>;}
createRoot(document.getElementById('root')!).render(<PhotoQA/>);
