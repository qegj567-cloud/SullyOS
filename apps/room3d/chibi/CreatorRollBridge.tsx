import React, { useEffect, useMemo, useRef, useState } from 'react';
import {readRollCache,writeRollCache,rollCacheKey} from './rollCache';
import {captureCreatorLayer} from './captureCreatorLayer';
import type {EyeTint} from './faceTint';
export interface RollResult { layers:Record<string,string>; image:string; state?:unknown; eyeColors?:{L:string;R:string}; eyeTints?:{L:EyeTint;R:EyeTint} }
type BridgeProps={ request:number; savedState?:unknown; extraItems?:unknown[]; editing?:boolean; captureOnly?:boolean; onReady:()=>void; onResult:(r:RollResult)=>void; onError:(message:string)=>void };
function RawCreatorRollBridge({ request, savedState, extraItems, editing=false, captureOnly=false, onReady, onResult, onError }: BridgeProps) {
    const frame=useRef<HTMLIFrameElement>(null),callbacks=useRef({onReady,onResult,onError});callbacks.current={onReady,onResult,onError};
    const [html,setHtml]=useState('');
    const active=useRef(0);
    useEffect(()=>{
        let cancelled=false;
        const origin=location.origin;
        const bridge=`<script>
        const captureCreatorLayer=${captureCreatorLayer.toString()};
        // This document is an isolated copy of the existing creator. Its functions,
        // palette and rendering remain the source of truth; no user draft is saved.
        let rollBusy=false;
        let historyEnabled=false,restoring=false,dragging=false,dragRecorded=false;
        const past=[],future=[];
        const snapshot=()=>JSON.stringify({selected:state.selected,tintColor:state.tintColor,itemColor:state.itemColor,flipped:state.flipped,eyeSide:state.eyeSide,hairLinked:state.hairLinked,activeItemFocus:state.activeItemFocus,preserveLineart:state.preserveLineart});
        let present=snapshot();
        const undoButton=document.createElement('button'),redoButton=document.createElement('button');
        undoButton.textContent='↶ 撤销';redoButton.textContent='↷ 重做';
        for(const button of [undoButton,redoButton]){button.className='pill-btn';document.getElementById('btnRandom').parentElement.appendChild(button);}
        const syncHistory=()=>{undoButton.disabled=!past.length;redoButton.disabled=!future.length;};syncHistory();
        const renderBeforeHistory=renderCharacter;
        renderCharacter=function(){
          const next=snapshot();
          if(historyEnabled&&!restoring&&next!==present){if(!dragging||!dragRecorded){past.push(present);if(past.length>40)past.shift();dragRecorded=true;}future.length=0;present=next;syncHistory();}
          return renderBeforeHistory.apply(this,arguments);
        };
        const restoreHistory=(from,to)=>{if(!from.length)return;to.push(present);present=from.pop();restoring=true;try{applyFullState(JSON.parse(present));renderTabs();renderPanel();renderCharacter();}finally{restoring=false;syncHistory();}};
        undoButton.onclick=()=>restoreHistory(past,future);redoButton.onclick=()=>restoreHistory(future,past);
        document.addEventListener('pointerdown',e=>{dragging=e.target instanceof HTMLInputElement&&e.target.type==='range';dragRecorded=false;},true);
        for(const name of ['pointerup','pointercancel'])document.addEventListener(name,()=>{dragging=false;},true);
        window.addEventListener('message',async e=>{
          if(e.source!==parent||e.origin!==${JSON.stringify(origin)}||e.data?.type!=='experiment-roll'||rollBusy)return;
          rollBusy=true;const id=e.data.id;
          try{
            if(e.data.extraItems)mergeExtraItems(e.data.extraItems);
            if(!e.data.captureOnly){
              historyEnabled=false;
              if(e.data.savedState){if(!applyFullState(e.data.savedState))throw Error('无法还原形象');renderCharacter();}
              else randomizeAll();
              present=snapshot();past.length=0;future.length=0;historyEnabled=true;syncHistory();
            }
            await Promise.all(Object.values(imgCache).filter(x=>x instanceof Promise));
            await Promise.resolve();
            await Promise.all([...document.querySelectorAll('.character img')].map(img=>img.decode()));
            const layers={},whole=document.createElement('canvas');whole.width=whole.height=472;
            const wholeCtx=whole.getContext('2d');
            for(const layer of document.querySelectorAll('.character > .layer')){
              const canvas=captureCreatorLayer(layer);
              const key=layer.id.replace('layer-','');layers[key]=canvas.toDataURL();
              wholeCtx.globalAlpha=Number(getComputedStyle(layer).opacity);wholeCtx.drawImage(canvas,0,0);
            }
            // Keep untouched source pixels for 3D dye changes. Recoloring the
            // composited, already tinted layer crushes its painted shadows.
            for(const key of ['fronthair','earhair','back1','back2']){
              const part=PARTS.find(p=>p.key===key),item=part?.items.find(p=>p.id===state.selected[key]);
              if(!item)continue;
              const img=await loadImage(item.src),raw=document.createElement('canvas');
              raw.width=img.naturalWidth;raw.height=img.naturalHeight;const ctx=raw.getContext('2d');
              if(state.flipped[key]){ctx.translate(raw.width,0);ctx.scale(-1,1);}
              ctx.drawImage(img,0,0);layers[key+(item.noTint?'-raw-fixed':'-raw')]=raw.toDataURL();
              if(item.shadow){
                const shadow=await loadImage(item.shadow);ctx.clearRect(0,0,raw.width,raw.height);
                ctx.drawImage(shadow,0,0,raw.width,raw.height);layers[key+'-shadow']=raw.toDataURL();
              }
            }
            const eyePart=PARTS.find(p=>p.key==='eyes').items.find(p=>p.id===state.selected.eyes);
            let eyeColors,eyeTints;
            if(eyePart){
              const img=await loadImage(eyePart.src),raw=document.createElement('canvas');raw.width=img.naturalWidth;raw.height=img.naturalHeight;const ctx=raw.getContext('2d');
              if(state.flipped.eyes){ctx.translate(raw.width,0);ctx.scale(-1,1);}
              ctx.drawImage(img,0,0);layers['eyes-raw']=raw.toDataURL();
              if(!eyePart.noTint){const eyes=state.tintColor.eyes;eyeTints={L:eyes[state.flipped.eyes?'R':'L'],R:eyes[state.flipped.eyes?'L':'R']};eyeColors={L:hexForTint(eyeTints.L),R:hexForTint(eyeTints.R)};}
            }
            parent.postMessage({type:'experiment-roll-result',id,payload:{layers,eyeColors,eyeTints,image:whole.toDataURL(),state:JSON.parse(JSON.stringify(state))}},${JSON.stringify(origin)});
          }catch(error){parent.postMessage({type:'experiment-roll-error',id,message:String(error)},${JSON.stringify(origin)});}
          finally{rollBusy=false;}
        });
        fetch('parts/manifest.json').then(r=>{if(!r.ok)throw new Error('素材清单加载失败');return r.json();}).then(items=>{mergeExtraItems(items);parent.postMessage({type:'experiment-roll-ready'},${JSON.stringify(origin)});}).catch(e=>parent.postMessage({type:'experiment-roll-error',message:String(e)},${JSON.stringify(origin)}));
        </script>`;
        const base=new URL(`${import.meta.env.BASE_URL}like520/`,location.href).href;
        fetch(new URL('character_creator.html',base)).then(r=>{if(!r.ok)throw new Error('捏人器加载失败');return r.text();}).then(text=>{
            if(cancelled)return;
            // No changes to the production creator file; isolate its draft writes.
            setHtml(text.replace(/saveDraft\(\);/g,'/* preview: no draft writes */').replace(/<script\b[^>]*\bsrc=[^>]*>[\s\S]*?<\/script>/gi,'').replace('<head>','<head><base href="'+base+'"><style>#btnSave{display:none!important}</style>').replace('</body>',bridge+'</body>'));
        }).catch(e=>{if(!cancelled)callbacks.current.onError(String(e));});
        const receive=(e:MessageEvent)=>{
            if(e.source!==frame.current?.contentWindow||e.origin!==origin)return;
            if(e.data?.type==='experiment-roll-ready')callbacks.current.onReady();
            if(e.data?.type==='experiment-roll-result'&&e.data.id===active.current)callbacks.current.onResult(e.data.payload);
            if(e.data?.type==='experiment-roll-error'&&(e.data.id===undefined||e.data.id===active.current))callbacks.current.onError(e.data.message);
        };
        window.addEventListener('message',receive);
        return()=>{cancelled=true;window.removeEventListener('message',receive);};
    },[]);
    useEffect(()=>{
        if(!request)return;
        active.current=request;
        frame.current?.contentWindow?.postMessage({type:'experiment-roll',id:request,savedState,extraItems,captureOnly},location.origin);
    },[request,savedState,extraItems,captureOnly]);
    return html?<iframe ref={frame} title="小人捏人器" aria-hidden={!editing} tabIndex={editing?0:-1} srcDoc={html} style={editing?{position:'fixed',inset:'60px 0 0',width:'100%',height:'calc(100dvh - 60px)',border:0,zIndex:30,background:'#fff8f0'}:{position:'fixed',left:-10000,top:0,width:472,height:472,border:0,pointerEvents:'none'}}/>:null;
}

export function CreatorRollBridge(props:React.ComponentProps<typeof RawCreatorRollBridge>){
 const key=props.editing||props.captureOnly?null:rollCacheKey(props.savedState,props.extraItems);
 const cached=useMemo(()=>readRollCache(key),[key]);
 const callbacks=useRef(props);callbacks.current=props;
 useEffect(()=>{if(cached)callbacks.current.onReady();},[cached]);
 useEffect(()=>{if(cached&&props.request)callbacks.current.onResult(cached);},[cached,props.request]);
 if(cached)return null;
 return <RawCreatorRollBridge {...props} onResult={result=>{if(key)writeRollCache(key,result);props.onResult(result);}}/>;
}
