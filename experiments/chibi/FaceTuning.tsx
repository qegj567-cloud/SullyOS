import React from 'react';
import {cleanAdjustment,defaultAdjustment,type FacePart} from '../../apps/room3d/chibi/faceAdjustments';
import {cleanFace} from '../../apps/room3d/chibi/faceAppearance';
import type {HairSettings} from '../../apps/room3d/chibi/types';
export function FaceTuning({part,label,hair,onChange,onBegin,onEnd}:{part:FacePart;label:string;hair:HairSettings;onChange:(v:HairSettings)=>void;onBegin:()=>void;onEnd:()=>void}){
 const f=cleanFace(hair.face),a=cleanAdjustment(f.adjustments?.[part]);
 const update=(key:keyof typeof a,value:number)=>onChange({...hair,face:{...f,enabled:true,adjustments:{...f.adjustments,[part]:{...a,[key]:value}}}});
 const events={onPointerDown:onBegin,onPointerUp:onEnd,onPointerCancel:onEnd,onBlur:onEnd,onKeyDown:(e:React.KeyboardEvent)=>{if(!e.repeat&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))onBegin();},onKeyUp:onEnd};
 return <div className="face-tuning" aria-label={`${label}微调`}>{(['size','width','y',...(part==='eyes'?['spacing']:[])] as Array<keyof typeof a>).map(key=>{
  const scale=key==='size'||key==='width',title={size:'大小',width:'宽窄',y:'上下',spacing:'眼距'}[key],value=scale?Math.round(a[key]*100):a[key];
  return <label className="creator-slider" key={key}><span>{title}</span><input type="range" aria-label={`${label}${title}`} min={scale?60:key==='spacing'?-16:-25} max={scale?160:key==='spacing'?16:25} step={scale?1:.5} value={value} {...events} onChange={e=>update(key,+e.target.value/(scale?100:1))}/><output>{value}{scale?'%':''}</output></label>;
 })}<button className="tuning-reset" onClick={()=>onChange({...hair,face:{...f,adjustments:{...f.adjustments,[part]:{...defaultAdjustment}}}})}>重置{label}微调</button></div>;
}
