import React,{useEffect,useState} from 'react';
import type {HairSettings} from '../../apps/room3d/chibi/types';
import {cleanWardrobeColors,garmentColorRegions,normalizeGarmentColor} from '../../apps/room3d/chibi/wardrobeColors';
import './garment-colors.css';

const swatches=[['奶白','#f3ede2'],['炭黑','#303039'],['雾灰','#929398'],['莓红','#b85d72'],['藕粉','#dbacb8'],['姜黄','#d6b171'],['鼠尾草','#8fa68c'],['湖蓝','#6f9ea5'],['海军蓝','#3f5378'],['雾紫','#a193b9']] as const;
export function GarmentColors({id,hair,onChange,onBegin,onEnd}:{id:string;hair:HairSettings;onChange:(v:HairSettings)=>void;onBegin?:()=>void;onEnd?:()=>void}){
 const regions=garmentColorRegions[id]??[];
 const [selected,setSelected]=useState(regions[0]?.id);
 const region=regions.find(r=>r.id===selected)??regions[0];
 const colors=cleanWardrobeColors(hair.wardrobeColors),saved=colors[id]??{};
 const value=region?(saved[region.id]??region.color):'#ffffff';
 const [draft,setDraft]=useState(value);
 useEffect(()=>setDraft(value),[value,region?.id]);
 if(!region)return null;
 const update=(color?:string)=>{
  const next={...saved};if(color)next[region.id]=color;else delete next[region.id];
  if(Object.keys(next).length)colors[id]=next;else delete colors[id];
  onChange({...hair,wardrobeColors:colors});
 };
 const commit=()=>{const color=normalizeGarmentColor(draft);if(color)update(color);setDraft(color??value);onEnd?.();};
 return <section className="garment-dye" aria-label="衣服换色">
  <div className="garment-dye-heading"><strong>配色</strong><button disabled={!Object.keys(saved).length} onClick={()=>{delete colors[id];onChange({...hair,wardrobeColors:colors});}}>恢复本件原色</button></div>
  <div className="garment-dye-regions" aria-label="换色部位">{regions.map(r=><button key={r.id} aria-pressed={r.id===region.id} onClick={()=>setSelected(r.id)}><i style={{background:saved[r.id]??r.color}}/>{r.label}</button>)}</div>
  <div className="garment-dye-editor">
   <label className="garment-dye-custom"><input aria-label={`${region.label}自定义颜色`} type="color" value={value} onFocus={onBegin} onBlur={onEnd} onChange={e=>update(e.target.value)}/><span>自定义</span></label>
   <label className="garment-dye-hex"><span>HEX</span><input aria-label="颜色值" spellCheck={false} maxLength={7} value={draft} aria-invalid={!normalizeGarmentColor(draft)} onFocus={onBegin} onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape'){setDraft(value);onEnd?.();}}}/></label>
   <button disabled={!saved[region.id]} onClick={()=>update()}>部位原色</button>
  </div>
  <div className="garment-dye-swatches" aria-label="常用颜色">{swatches.map(([label,color])=><button key={color} title={label} aria-label={label} aria-pressed={value===color} style={{'--swatch':color} as React.CSSProperties} onClick={()=>update(color)}><i/></button>)}</div>
  <p>选择部位后调色。每件单独保存，换回来仍会保留。</p>
 </section>;
}
