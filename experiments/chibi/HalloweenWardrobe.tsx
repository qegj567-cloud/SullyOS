import React from 'react';
import {approvedPresets} from '../../apps/room3d/chibi/approvedWardrobe';
import {applyOutfit} from '../../apps/room3d/chibi/outfitLibrary';
import type {HairSettings,Parts} from '../../apps/room3d/chibi/types';
import {OutfitPreview} from './OutfitPreview';

const palettes=[['original','经典万圣节','#ee7916'],['midnight','黑白午夜','#303039'],['crimson','绯红夜宴','#711a30'],['moonlight','月光蓝','#638da7']] as const;
export function HalloweenWardrobe({parts,hair,installed,onSelect}:{parts?:Parts;hair:HairSettings;installed:boolean;onSelect:(hair:HairSettings)=>void}){
 const styles=Object.entries(approvedPresets).filter(([id,p])=>p.collection==='halloween'&&id.endsWith('-original'));
 const selected=styles.find(([,p])=>Object.entries(p.items).every(([slot,id])=>hair.wardrobe?.[slot as keyof typeof hair.wardrobe]===id));
 return <>
  <div className="wardrobe-items garment-grid outfit-grid" aria-label="万圣节套装款式">{styles.map(([id,p])=>{
   const name=p.label.split(' · ')[0];
   return <button key={id} className="garment-tile" data-pack-locked={!installed} aria-label={name} aria-pressed={selected?.[0]===id} onClick={()=>onSelect(applyOutfit(hair,{id,name,clothes:p.clothes!}))}>
    <OutfitPreview name={name} parts={parts} hair={applyOutfit(hair,{id,name,clothes:p.clothes!})}/><small>{name}</small>{selected?.[0]===id&&<b aria-label="已穿">✓</b>}
   </button>;
  })}</div>
  {selected?<div className="halloween-palette" aria-label="套装配色"><p>{selected[1].label.split(' · ')[0]} · 配色</p><div>{palettes.map(([key,label,color])=>{
   const p=approvedPresets[selected[0].replace(/original$/,key)],ids=Object.values(p.items);
   const active=ids.every(id=>JSON.stringify(hair.wardrobeColors?.[id]??{})===JSON.stringify(p.clothes!.wardrobeColors[id]??{}));
   return <button key={key} aria-pressed={active} onClick={()=>{
    const colors={...hair.wardrobeColors};for(const id of ids){delete colors[id];if(p.clothes!.wardrobeColors[id])colors[id]={...p.clothes!.wardrobeColors[id]};}
    onSelect({...hair,wardrobeColors:colors});
   }}><span aria-hidden="true" style={{background:color}}/>{label}</button>;
  })}</div></div>:<p className="halloween-palette-hint">先选择一套衣服，再挑喜欢的配色。</p>}
 </>;
}
