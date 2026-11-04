import React from 'react';
import {AppearanceColorControl} from './AppearanceColorControl';
import {FigureSlider} from './FigureSlider';
import {HUE_PALETTE,hexForTint,type CreatorHairTint} from '../../apps/room3d/chibi/creatorHairTint';
import type {HairSettings} from '../../apps/room3d/chibi/types';

export function HairDyeControls({hair,onChange,onBegin,onEnd}:{hair:HairSettings;onChange:(hair:HairSettings)=>void;onBegin:()=>void;onEnd:()=>void}){
 const tint:CreatorHairTint=hair.hairTint??{hueIdx:0,sat:50,light:0,color:hair.hairColor,gradientColor:hair.hairTipColor};
 const set=(next:CreatorHairTint)=>onChange({...hair,hairTint:next,hairColor:hexForTint(next),hairTipColor:next.gradientColor});
 const reset=()=>onChange({...hair,hairTint:undefined,hairColor:undefined,hairTipColor:undefined});
 return <>
  <div className="hair-dye-mode" aria-label="发色模式"><button aria-pressed={!tint.gradientColor} onClick={()=>{if(tint.gradientColor)set({...tint,gradientColor:undefined});}}>纯色</button><button aria-pressed={!!tint.gradientColor} onClick={()=>set({...tint,color:hexForTint(tint),gradientColor:tint.gradientColor??'#ecc5d5'})}>渐变</button></div>
  <fieldset className="appearance-colors"><legend>Chibi 候选发色</legend><div>{HUE_PALETTE.map((swatch,hueIdx)=><button key={swatch.name} className="appearance-swatch" style={{backgroundColor:swatch.hex}} title={swatch.name} aria-label={`发色 ${swatch.name}`} aria-pressed={!!hair.hairTint&&!tint.color&&tint.hueIdx===hueIdx} onClick={()=>{const next:CreatorHairTint={...tint,hueIdx,color:undefined};if(next.gradientColor)next.color=hexForTint(next);set(next);}}/>)}</div></fieldset>
  {!tint.color&&hair.hairColor&&<>
   <FigureSlider label="饱和度" value={tint.sat} min={0} max={100} onChange={sat=>set({...tint,sat})} onBegin={onBegin} onEnd={onEnd}/>
   <FigureSlider label="明度" value={tint.light} min={-50} max={50} onChange={light=>set({...tint,light})} onBegin={onBegin} onEnd={onEnd}/>
  </>}
  <AppearanceColorControl label={tint.gradientColor?'发根':'发色'} value={hair.hairColor} colors={[]} onChange={color=>color?set({...tint,color}):reset()} onBegin={onBegin} onEnd={onEnd}/>
  {tint.gradientColor&&<AppearanceColorControl label="发梢" value={tint.gradientColor} colors={[]} onChange={gradientColor=>set({...tint,gradientColor})} onBegin={onBegin} onEnd={onEnd}/>}
 </>;
}
