import * as T from 'three';
import data from './blankBody.json';
import {bodyProportions,type BodyProportions} from './types';
import {bodyHeightY,bodyHeightSlope} from './bodyHeight';

// One connected reference body with rounded five-finger hands; offline refinement
// is documented in art/chibi/refine-body.mjs.
export const BLANK_SCALE=1.875/.354;
export const BLANK_HEAD_BOTTOM=.15;
// Match the supplied hoodie doll's head/body ratio with our torso unchanged.
// Reference: neck at .22 of centered unit height, head bounds .3327 × .28 × .2836.
// Target rest head: neck .15, bounds .4081 × .35 × .3382 (including ears).
const bodyRatio=.65/.72;
export const BLANK_HEAD_SCALE={x:.3327/.4081*bodyRatio,y:.28/.35*bodyRatio,z:.2836/.3382*bodyRatio};
export const fitBlankHeadY=(y:number,options?:BodyProportions)=>{const p=bodyProportions(options);return bodyHeightY(.65*BLANK_SCALE,p.bodyHeight)+(y-.65*BLANK_SCALE)*BLANK_HEAD_SCALE.y*p.headSize;};
// Keep Tiny T-Pose's torso and legs; only the head is fitted to the hoodie reference.
const LEG_ANKLE=-.44,LEG_HIP=-.14,LEG_EXTENSION=0;
const upperLift=(LEG_HIP-LEG_ANKLE)*LEG_EXTENSION;
// Register the artwork to the face area, not the full head/neck bounding box.
const ART_JAW=.205,ART_CROWN=.515;
export const BLANK_HAIR_Y_SCALE=(ART_CROWN-ART_JAW)*BLANK_SCALE/1.50;
export const BLANK_HAIR_PIVOT=(ART_JAW+.5+upperLift)*BLANK_SCALE+(.64-.70)*BLANK_HAIR_Y_SCALE;
export const BLANK_HAIR_Z_SCALE=.34*BLANK_SCALE/(1.51953125*.82);

export function createBlankBody(appearance:'skin'|'hair'|'outfit',options?:BodyProportions){
 const proportions=bodyProportions(options),headSize=proportions.headSize,height=proportions.bodyHeight;
 const g=new T.BufferGeometry(),positions:number[]=[],normals:number[]=[],uv:number[]=[],buckets=Array.from({length:6},()=>[] as number[]),normal=new T.Vector3();
 for(let i=0;i<data.positions.length;i+=3){
  const [x,y,z]=data.positions.slice(i,i+3);
  const legLift=T.MathUtils.clamp(y-LEG_ANKLE,0,LEG_HIP-LEG_ANKLE)*LEG_EXTENSION;
  const head=T.MathUtils.smoothstep(y,.125,.16);
  const bodyY=bodyHeightY((y+.5+legLift)*BLANK_SCALE,height),headY=fitBlankHeadY((y+.5)*BLANK_SCALE,options);
  positions.push(x*BLANK_SCALE*T.MathUtils.lerp(1,BLANK_HEAD_SCALE.x*headSize,head),
   T.MathUtils.lerp(bodyY,headY,head),
   z*BLANK_SCALE*T.MathUtils.lerp(1,BLANK_HEAD_SCALE.z*headSize,head));
  // Retain reference normals after simplification. Use the inverse transpose of
  // the proportion deformation, including the smooth transition at the neck.
  const sx=T.MathUtils.lerp(1,BLANK_HEAD_SCALE.x*headSize,head),sz=T.MathUtils.lerp(1,BLANK_HEAD_SCALE.z*headSize,head),sy=BLANK_HEAD_SCALE.y*headSize;
  const t=T.MathUtils.clamp((y-.125)/.035,0,1),dh=6*t*(1-t)/.035;
  const slope=bodyHeightSlope((y+.5)*BLANK_SCALE,height);
  const dy=slope+(sy-slope)*head+(headY-bodyY)/BLANK_SCALE*dh,dx=x*(BLANK_HEAD_SCALE.x*headSize-1)*dh,dz=z*(BLANK_HEAD_SCALE.z*headSize-1)*dh;
  const [nx,ny,nz]=data.normals.slice(i,i+3);
  normal.set(nx/sx,(ny-dx*nx/sx-dz*nz/sz)/dy,nz/sz).normalize();normals.push(normal.x,normal.y,normal.z);
  const faceY=.70+(y-ART_JAW)/(.5-ART_JAW)*1.30;
  uv.push((237+x*BLANK_SCALE/1.875*325)/472,1-(424-faceY/2*336)/472);
 }
 for(let i=0;i<data.indices.length;i+=3){
  const tri=data.indices.slice(i,i+3);
  const x=tri.reduce((v,k)=>v+data.positions[k*3],0)/3,y=tri.reduce((v,k)=>v+data.positions[k*3+1],0)/3,z=tri.reduce((v,k)=>v+data.positions[k*3+2],0)/3;
  const ear=Math.abs(x)>.168&&y<.30;
  // A continuous dyed crown covers the scalp beneath the lowered fringe.
  const scalp=appearance!=='skin'&&y>BLANK_HEAD_BOTTOM&&!ear&&(z<0||y>.405||(Math.abs(x*BLANK_SCALE)>.55&&z<.095));
  // Below the jaw use the existing plain skin material, never projected face art.
  const material=y<=BLANK_HEAD_BOTTOM||ear?1:scalp?(z>0?4:5):(z>0?0:1);
  buckets[material].push(...tri);
 }
 const indices:number[]=[];
 buckets.forEach((bucket,material)=>{const start=indices.length;indices.push(...bucket);if(bucket.length)g.addGroup(start,bucket.length,material);});
 g.userData.bodyHeight=height;
 g.setAttribute('position',new T.Float32BufferAttribute(positions,3));g.setAttribute('normal',new T.Float32BufferAttribute(normals,3));g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setIndex(indices);g.computeBoundingBox();g.computeBoundingSphere();
 return g;
}
