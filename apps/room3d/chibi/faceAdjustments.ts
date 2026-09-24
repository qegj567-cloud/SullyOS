import type {FaceSide} from './faceLandmarks';
export type FacePart='eyes'|'upper'|'iris'|'lower'|'brow'|'highlight'|'pupil'|'mouth';
export interface FaceAdjustment {size:number;width:number;y:number;spacing:number}
export type FaceAdjustments=Partial<Record<FacePart,Partial<FaceAdjustment>>>;
export const defaultAdjustment:FaceAdjustment={size:1,width:1,y:0,spacing:0};
export function cleanAdjustment(v?:Partial<FaceAdjustment>):FaceAdjustment{
 const clamp=(x:unknown,min:number,max:number,base:number)=>typeof x==='number'&&Number.isFinite(x)?Math.max(min,Math.min(max,x)):base;
 return {size:clamp(v?.size,.6,1.6,1),width:clamp(v?.width,.6,1.6,1),y:clamp(v?.y,-25,25,0),spacing:clamp(v?.spacing,-16,16,0)};
}
export function transformFaceSide(side:FaceSide,value:Partial<FaceAdjustment>,index:number):FaceSide{
 const a=cleanAdjustment(value),sx=a.size*a.width,sy=a.size,cy=(side.top+side.bottom)/2;
 const x=(v:number)=>side.x+(v-side.x)*sx+(index?1:-1)*a.spacing;
 const y=(v:number)=>cy+(v-cy)*sy+a.y;
 const left=Math.round(x(side.left)),right=Math.round(x(side.right));
 const point=(p:[number,number]):[number,number]=>[x(p[0]),y(p[1])];
 return {...side,left,right,x:x(side.x),top:y(side.top),bottom:y(side.bottom),anchor:y(side.anchor),outer:point(side.outer),inner:point(side.inner),edge:Array.from({length:right-left+1},(_,i)=>{
  const original=(left+i-side.x-(index?1:-1)*a.spacing)/sx+side.x;
  const j=Math.max(0,Math.min(side.edge.length-1,Math.round(original)-side.left));return y(side.edge[j]);
 })};
}
export type MouthUse='closed'|'open'|'smile';
export type MouthChoices=Record<MouthUse,string>;
export function cleanMouthChoices(value:Partial<MouthChoices>|undefined,legacy:string,available:string[]):MouthChoices{
 const result:MouthChoices={closed:'closed-04',open:'open-01',smile:'smile-02'};
 for(const use of ['closed','open','smile'] as const){
  const id=value?.[use]??(legacy.startsWith(`${use}-`)?legacy:result[use]);
  if(id.startsWith(`${use}-`)&&available.includes(id))result[use]=id;
 }
 return result;
}
