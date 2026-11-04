import React,{useEffect,useState} from 'react';
import {ColorWheel} from './ColorWheel';
export function AppearanceColorControl({label,value,colors,onChange,onBegin,onEnd}:{label:string;value?:string;colors:string[];onChange:(color:string|undefined)=>void;onBegin:()=>void;onEnd:()=>void}) {
 const current=value??colors[0]??'#73513b';
 const [draft,setDraft]=useState(current);
 const [open,setOpen]=useState(false);
 useEffect(()=>setDraft(current),[current]);
 const commit=()=>{const color=/^#?[\da-f]{6}$/i.test(draft)?('#'+draft.replace(/^#/, '')).toLowerCase():undefined;if(color&&color!==current)onChange(color);setDraft(color??current);onEnd();};
 return <fieldset className="appearance-colors"><legend>{label}</legend><div>
  <button aria-label={`恢复原${label}`} aria-pressed={!value} onClick={()=>onChange(undefined)}>原色</button>
  {colors.map(color=><button key={color} className="appearance-swatch" style={{backgroundColor:color}} aria-label={`${label} ${color}`} aria-pressed={value===color} onClick={()=>onChange(color)}/>)}
  <button className="appearance-custom" aria-label={`自定义${label}`} aria-expanded={open} onClick={()=>setOpen(v=>!v)}><i style={{backgroundColor:current}}/><span>色环</span></button>
  <label className="appearance-hex"><span>HEX</span><input aria-label={`${label}颜色值`} value={draft} maxLength={7} spellCheck={false} onFocus={onBegin} onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();if(e.key==='Escape'){setDraft(current);onEnd();}}}/></label>
 </div>{open&&<ColorWheel label={label} value={current} onChange={onChange} onBegin={onBegin} onEnd={onEnd}/>}</fieldset>;
}
