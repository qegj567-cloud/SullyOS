export type Parts = Record<string, HTMLImageElement>;
export type HairMode='wrap'|'project';
// `puff` keeps its stored key for compatibility; it now controls curved-sheet depth.
export interface HairLayer { length:number; width:number; offsetY:number; distance:number; mode?:HairMode; offsetX?:number; offsetZ?:number; puff?:number; }
export interface ExtraHair extends HairLayer { id:string; source:string; src?:string; }
export interface BodyProportions { headSize?:number; bodyHeight?:number; }
export interface HairSettings extends BodyProportions { layers:Record<string,HairLayer>; extras:ExtraHair[]; assetModes?:Record<string,HairMode>; assets?:Record<string,string>; bodyShape?:'classic'|'blank'; wardrobeStyle?:'cute'|'boy'|'normal'; wardrobe?:import('./approvedWardrobe').ApprovedWardrobe; wardrobeFits?:import('./garmentFit').WardrobeFits; }
export function bodyProportions(value?:BodyProportions){
 const clamp=(v:number|undefined,min:number,max:number,fallback:number)=>typeof v==='number'&&Number.isFinite(v)?Math.min(max,Math.max(min,v)):fallback;
 return {headSize:clamp(value?.headSize,.75,1.4,1.04),bodyHeight:clamp(value?.bodyHeight,.8,1.25,1)};
}
// Reviewed against the shipped PNGs: buns, ponytails, tufts and cat ears.
export const builtinHairModes:Record<string,HairMode>=Object.fromEntries(['back2_05','back2_06','back2_07','back2_010','back2_011','back2_012','back2_013','back2_014'].map(id=>[id,'project']));
export function hairMode(settings:HairSettings|undefined,key:string):HairMode{
 const id=settings?.assets?.[key];
 return (id&&settings?.assetModes?.[id])||(id&&builtinHairModes[id])||settings?.layers[key]?.mode||'wrap';
}
export function selectedHairAssets(state:unknown):Record<string,string>{
 const selected=(state as {selected?:Record<string,unknown>}|undefined)?.selected;
 return Object.fromEntries(['fronthair','earhair','back1','back2'].flatMap(key=>typeof selected?.[key]==='string'?[[key,selected[key] as string]]:[]));
}
export const defaultHairLayer:HairLayer={length:1,width:1,offsetY:0,distance:0,offsetX:0,offsetZ:0,puff:.16};
export type Motion = 'idle' | 'sit' | 'wave' | 'wave-cute' | 'wave-calm' | 'sleep' | 'angry' | 'walk' | 'dance' | 'water' | 'computer' | 'stream' | 'race' | 'rhythm' | 'eat' | 'hug' | 'coffee' | 'wash' | 'cook';
export type Posture = 'standing' | 'seated' | 'lying';

export interface ActivityPose {hands:number[][];kind:string;carrying?:boolean;rhythm?:{offset:number[];hands:number[][];keys:string[]}[]}
