import React,{useEffect,useState} from 'react';
import type {HairSettings} from '../../apps/room3d/chibi/types';
import {resolveWardrobeColors,cleanWardrobeColors,garmentColorRegions,normalizeGarmentColor} from '../../apps/room3d/chibi/wardrobeColors';
import './garment-colors.css';
import {halloweenPalette} from '../../apps/room3d/chibi/halloweenPalettes';
import {ColorWheel} from './ColorWheel';

const swatches=[['奶白','#f3ede2'],['炭黑','#303039'],['雾灰','#929398'],['莓红','#b85d72'],['藕粉','#dbacb8'],['姜黄','#d6b171'],['鼠尾草','#8fa68c'],['湖蓝','#6f9ea5'],['海军蓝','#3f5378'],['雾紫','#a193b9']] as const;
export function GarmentColors({parts,id,hair,onChange,onBegin,onEnd}:{parts?:import('../../apps/room3d/chibi/types').Parts;id:string;hair:HairSettings;onChange:(v:HairSettings)=>void;onBegin?:()=>void;onEnd?:()=>void}){
 const regions=garmentColorRegions[id]??[];
 const [selected,setSelected]=useState(regions[0]?.id);
 const region=regions.find(r=>r.id===selected)??regions[0];
 const colors=cleanWardrobeColors(hair.wardrobeColors),saved=colors[id]??{};
 const effective=resolveWardrobeColors(hair.wardrobe??{},hair.wardrobeColors)[id]??saved;
 const value=region?(effective[region.id]??region.color):'#ffffff';
 const [draft,setDraft]=useState(value);
 const [colorError,setColorError]=useState('');
 const [wheelOpen,setWheelOpen]=useState(false);
 useEffect(()=>setDraft(value),[value,region?.id]);
 if(!region)return null;
 const update=(color?:string)=>{
  const next={...saved};if(color)next[region.id]=color;else delete next[region.id];
  if(Object.keys(next).length)colors[id]=next;else delete colors[id];
  onChange({...hair,wardrobeColors:colors});
 };
 const commit=()=>{const color=normalizeGarmentColor(draft);if(color)update(color);setDraft(color??value);onEnd?.();};
 const matchHair=()=>{
  try{
   const explicit=normalizeGarmentColor(hair.hairColor??'');
   if(explicit){onChange({...hair,wardrobeColors:{...colors,[id]:{...saved,fur:explicit}}});setColorError('');return;}
   const image=['fronthair','earhair','back1','back2'].map(k=>parts?.[k]).find(i=>i?.naturalWidth);
   if(!image)throw Error('头发还没准备好，请稍后再试');
   const canvas=document.createElement('canvas');canvas.width=canvas.height=96;
   const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0,96,96);
   const pixels=ctx.getImageData(0,0,96,96).data,bins=new Map<string,{n:number;r:number;g:number;b:number}>();
   for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]<220)continue;const [r,g,b]=[pixels[i],pixels[i+1],pixels[i+2]],key=[r>>4,g>>4,b>>4].join(',');const bin=bins.get(key)??{n:0,r:0,g:0,b:0};bin.n++;bin.r+=r;bin.g+=g;bin.b+=b;bins.set(key,bin);}
   const dominant=[...bins.values()].sort((a,b)=>b.n-a.n)[0];if(!dominant)throw Error('当前头发没有可取的颜色');
   const color='#'+[dominant.r,dominant.g,dominant.b].map(v=>Math.round(v/dominant.n).toString(16).padStart(2,'0')).join('');
   onChange({...hair,wardrobeColors:{...colors,[id]:{...saved,fur:color}}});setColorError('');
  }catch(e){setColorError(e instanceof Error?e.message:'暂时无法读取发色');}
 };
 return <section className="garment-dye" aria-label="衣服换色">
  <div className="garment-dye-heading"><strong>配色</strong><button disabled={!Object.keys(saved).length} onClick={()=>{delete colors[id];onChange({...hair,wardrobeColors:colors});}}>恢复本件原色</button></div>
  {id.startsWith('halloween-')&&<div className="garment-dye-regions" aria-label="万圣节单品配色">{[['midnight','午夜黑灰'],['crimson','绯红晚宴'],['moonlight','月光蓝银']].map(([key,label])=><button key={key} onClick={()=>onChange({...hair,wardrobeColors:{...colors,[id]:halloweenPalette(id.split('-')[1],key)!}})}>{label}</button>)}</div>}
  {hair.wardrobe?.tail===id&&hair.wardrobe?.ears&&<p>{saved.fur?'毛色已单独设置，恢复毛色原色即可跟随兽耳。':'毛色默认跟随当前兽耳，耳色改变时同步更新。'}</p>}
  {regions.some(r=>r.id==='fur')&&<button onClick={matchHair}>毛色跟随当前发色</button>}
  {colorError&&<p role="status">{colorError}</p>}
  <div className="garment-dye-regions" aria-label="换色部位">{regions.map(r=><button key={r.id} aria-pressed={r.id===region.id} onClick={()=>setSelected(r.id)}><i style={{background:saved[r.id]??r.color}}/>{r.label}</button>)}</div>
  <div className="garment-dye-editor">
   <button className="garment-dye-custom" aria-label={`${region.label}自定义颜色`} aria-expanded={wheelOpen} onClick={()=>setWheelOpen(v=>!v)}><i style={{background:value}}/><span>色环</span></button>
   <label className="garment-dye-hex"><span>HEX</span><input aria-label="颜色值" spellCheck={false} maxLength={7} value={draft} aria-invalid={!normalizeGarmentColor(draft)} onFocus={onBegin} onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape'){setDraft(value);onEnd?.();}}}/></label>
   <button disabled={!saved[region.id]} onClick={()=>update()}>部位原色</button>
  </div>
  {wheelOpen&&<ColorWheel key={region.id} label={region.label} value={value} onChange={update} onBegin={()=>onBegin?.()} onEnd={()=>onEnd?.()}/>}
  <div className="garment-dye-swatches" aria-label="常用颜色">{swatches.map(([label,color])=><button key={color} title={label} aria-label={label} aria-pressed={value===color} style={{'--swatch':color} as React.CSSProperties} onClick={()=>update(color)}><i/></button>)}</div>
  <p>选择部位后调色。每件单独保存，换回来仍会保留。</p>
 </section>;
}

