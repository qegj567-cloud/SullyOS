import * as T from 'three';
import {approvedGarments,type ApprovedWardrobe,type WardrobeSlot} from './approvedWardrobe';
import {bodyBaseY,bodyHeightY} from './bodyHeight';

export const fitLimits={scale:[25,200,100],width:[75,140,100],depth:[75,150,100],length:[70,135,100],hemOpening:[0,100,0],neckline:[0,100,0],sleeveLength:[75,120,100],sleeveWidth:[75,150,100],sleeveUpperWidth:[75,150,100],sleeveLowerWidth:[75,150,100],sleeveOpening:[0,100,0],clearance:[-8,8,0],sleeveClearance:[-8,8,0],offsetX:[-50,50,0],offsetY:[-50,50,0],offsetZ:[-50,50,0],rotateX:[-180,180,0],rotateY:[-180,180,0],rotateZ:[-180,180,0]} as const;
export type FitKey=keyof typeof fitLimits;
export const maskRegions={torso:'躯干',upperArms:'上臂',forearms:'前臂',hips:'腰胯',thighs:'大腿',calves:'小腿',feet:'脚部'} as const;
export type MaskRegion=keyof typeof maskRegions;
export type GarmentFit=Record<FitKey,number>&{autoHide:boolean;hide:MaskRegion[];hemOpeningByBottom?:Record<string,number>};
export type WardrobeFits=Record<string,Partial<GarmentFit>>;
const hemPartners=new Set(['none',...approvedGarments.filter(g=>g.slot==='bottom'||g.slot==='onepiece').map(g=>g.id)]);
const hasHem=(id:string)=>approvedGarments.some(g=>g.id===id&&(g.slot==='top'||g.slot==='outer'));
const partnerKey=(id?:string)=>id&&hemPartners.has(id)?id:'none';
export function fitForGarment(id:string,value?:Partial<GarmentFit>,bottom?:string){
 const fit=cleanGarmentFit(value);if(hasHem(id)&&fit.hemOpeningByBottom)fit.hemOpening=fit.hemOpeningByBottom[partnerKey(bottom)]??0;return fit;
}
/** Resolve old global values against the outfit they were saved with before switching bottoms. */
export function scopeLegacyHemFits(fits:WardrobeFits={},items:ApprovedWardrobe):WardrobeFits{
 const next={...fits};for(const id of [items.top,items.outer])if(id&&hasHem(id)&&fits[id]){
  const fit=cleanGarmentFit(fits[id]);if(!fit.hemOpeningByBottom&&fit.hemOpening!==0)next[id]={...fit,hemOpening:0,hemOpeningByBottom:{[partnerKey(items.bottom??items.onepiece)]:fit.hemOpening}};
 }return next;
}
/** Shared dimensions stay per garment; manual hem ease belongs to the current pairing. */
export function updateGarmentFit(id:string,value:Partial<GarmentFit>|undefined,patch:Partial<GarmentFit>,bottom?:string):GarmentFit{
 const base=cleanGarmentFit(value),next=cleanGarmentFit({...base,...patch});
 if(hasHem(id)){
  next.hemOpening=base.hemOpening;next.hemOpeningByBottom=base.hemOpeningByBottom;
  if(patch.hemOpening!==undefined){next.hemOpening=0;next.hemOpeningByBottom={...base.hemOpeningByBottom,[partnerKey(bottom)]:cleanGarmentFit(patch).hemOpening};}
 }return next;
}
export function cleanGarmentFit(value?:Partial<GarmentFit>):GarmentFit{
 const fit={} as GarmentFit;
 for(const key of Object.keys(fitLimits) as FitKey[]){const [min,max,fallback]=fitLimits[key],v=value?.[key];fit[key]=typeof v==='number'&&Number.isFinite(v)?Math.max(min,Math.min(max,v)):fallback;}
 // Older drafts had one clearance for both the body and sleeves.
 if(value?.sleeveClearance===undefined)fit.sleeveClearance=fit.clearance;
 // Preserve the old uniform sleeve fit when opening an existing outfit.
 if(value?.sleeveUpperWidth===undefined)fit.sleeveUpperWidth=fit.sleeveWidth;
 if(value?.sleeveLowerWidth===undefined)fit.sleeveLowerWidth=fit.sleeveWidth;
 fit.autoHide=value?.autoHide!==false;fit.hide=Array.isArray(value?.hide)?value.hide.filter(v=>v in maskRegions):[];
 if(value?.hemOpeningByBottom&&typeof value.hemOpeningByBottom==='object'&&!Array.isArray(value.hemOpeningByBottom))fit.hemOpeningByBottom=Object.fromEntries(Object.entries(value.hemOpeningByBottom).filter(([id,v])=>hemPartners.has(id)&&typeof v==='number'&&Number.isFinite(v)).map(([id,v])=>[id,Math.max(0,Math.min(100,v))]));
 return fit;
}
const smooth=(v:number)=>{v=Math.max(0,Math.min(1,v));return v*v*(3-2*v);};
/** All coordinates use the target rig's unposed rest space. No pose is baked in. */
export function garmentTransform(slot:WardrobeSlot,fit:GarmentFit,height:number,actualBounds:T.Box3,actualCenters?:{left:T.Vector3;right:T.Vector3}){
 // Existing tailoring operates in uniform reference space, then the same
 // height mapping as the body is reapplied. This keeps anchors and openings aligned.
 const reference=(v:T.Vector3)=>new T.Vector3(v.x,bodyBaseY(v.y,height)*height,v.z);
 const bounds=new T.Box3(reference(actualBounds.min),reference(actualBounds.max));
 const pairedCenters=actualCenters?{left:reference(actualCenters.left),right:reference(actualCenters.right)}:undefined;
 const upper=slot==='top'||slot==='outer'||slot==='onepiece',lower=slot==='bottom',feet=slot==='shoes'||slot==='socks',headwear=slot==='headwear';
 const center=bounds.getCenter(new T.Vector3());
 const sleeveExtent=Math.max(Math.abs(bounds.min.x),Math.abs(bounds.max.x));
 // Sleeve-only accessories start at the forearm instead of the shoulder.
 const sleeveStart=pairedCenters?Math.max(.30,Math.min(Math.abs(pairedCenters.left.x),Math.abs(pairedCenters.right.x))-(sleeveExtent-Math.max(Math.abs(pairedCenters.left.x),Math.abs(pairedCenters.right.x)))):.30;
 const sleeveSpan=Math.max(.1,sleeveExtent-sleeveStart);
 const anchor=upper?3.22*height:lower?bounds.max.y:feet?bounds.min.y:center.y;
 const hemStart=Math.min(2.85*height,bounds.min.y+.65*height),hemSpan=Math.max(.05*height,hemStart-bounds.min.y);
 const rotation=new T.Quaternion().setFromEuler(new T.Euler(T.MathUtils.degToRad(fit.rotateX),T.MathUtils.degToRad(fit.rotateY),T.MathUtils.degToRad(fit.rotateZ),'XYZ'));
 return (p:T.Vector3)=>{
  p.y=bodyBaseY(p.y,height)*height;
  const x=p.x,y=p.y,z=p.z,arm=upper?smooth((Math.abs(x)-.28)/.20)*smooth((y/height-2.65)/.30):0;
  const signed=Math.sign(x),bodyX=x*fit.width/100,sleeveX=signed*(.30+(Math.abs(x)-.30)*fit.sleeveLength/100);
  const alongSleeve=(Math.abs(x)-sleeveStart)/sleeveSpan;
  const sleeveWidth=T.MathUtils.lerp(fit.sleeveUpperWidth,fit.sleeveLowerWidth,smooth((alongSleeve-.3)/.4))/100;
  const opening=1+fit.sleeveOpening/100*smooth((alongSleeve-.72)/.28);
  const sleeveScale=sleeveWidth*opening;
  const localCenterX=headwear?center.x:feet?signed*.19:0;
  p.x=upper?T.MathUtils.lerp(bodyX,sleeveX,arm):localCenterX+(x-localCenterX)*fit.width/100;
  p.y=T.MathUtils.lerp(anchor+(y-anchor)*fit.length/100,3.125*height+(y-3.125*height)*sleeveScale,arm);
  p.z=headwear?center.z+(z-center.z)*fit.depth/100:T.MathUtils.lerp(z*fit.depth/100,-.0106+(z+.0106)*sleeveScale,arm);
  // Radial ease does not puff seams along discontinuous vertex normals.
  const radial=new T.Vector3((x-localCenterX)*(1-arm),(y-3.125*height)*arm,z+.0106*arm);
  if(!headwear&&radial.lengthSq()>1e-8)p.addScaledVector(radial.normalize(),T.MathUtils.lerp(fit.clearance,fit.sleeveClearance,arm)*.01);
  if((slot==='top'||slot==='outer')&&!pairedCenters){const flare=1+.45*fit.hemOpening/100*smooth((hemStart-y)/hemSpan)*(1-arm);p.x*=flare;p.z*=flare;}
  if(headwear||slot==='accessory'||pairedCenters){const pivot=pairedCenters?(x<0?pairedCenters.left:pairedCenters.right):center;p.sub(pivot).multiplyScalar(fit.scale/100).add(pivot);}
  if(headwear)p.sub(center).applyQuaternion(rotation).add(center);
  p.x+=fit.offsetX*.01;p.y+=fit.offsetY*.01*height;p.z+=fit.offsetZ*.01;p.y=bodyHeightY(p.y/height,height);return p;
 };
}
export function deformGarment(g:T.BufferGeometry,transform:(p:T.Vector3)=>T.Vector3){
 const p=g.attributes.position,n=g.attributes.normal,q=new T.Vector3(),v=new T.Vector3(),a=new T.Vector3(),b=new T.Vector3(),columns:T.Vector3[]=[new T.Vector3(),new T.Vector3(),new T.Vector3()],matrix=new T.Matrix3(),e=.0001;
 for(let i=0;i<p.count;i++){
  q.fromBufferAttribute(p,i);
  if(n){for(let axis=0;axis<3;axis++){a.copy(q);b.copy(q);a.setComponent(axis,a.getComponent(axis)+e);b.setComponent(axis,b.getComponent(axis)-e);columns[axis].copy(transform(a)).sub(transform(b)).multiplyScalar(1/(2*e));}
   const [x,y,z]=columns;matrix.set(x.x,y.x,z.x,x.y,y.y,z.y,x.z,y.z,z.z).invert().transpose();v.fromBufferAttribute(n,i).applyMatrix3(matrix).normalize();n.setXYZ(i,v.x,v.y,v.z);
  }
  transform(q);p.setXYZ(i,q.x,q.y,q.z);
 }
 p.needsUpdate=true;if(n)n.needsUpdate=true;g.computeBoundingBox();g.computeBoundingSphere();
}
export function manualCoverage(p:T.Vector3,hide:MaskRegion[],height:number){
 const x=Math.abs(p.x),y=bodyBaseY(p.y,height);
 return hide.some(region=>({torso:x<.36&&y>2.48&&y<3.22,upperArms:x>.32&&x<.88&&y>2.83&&y<3.42,forearms:x>=.88&&x<1.44&&y>2.83&&y<3.42,hips:x<.43&&y>2.12&&y<2.48,thighs:y>1.34&&y<=2.12,calves:y>.32&&y<=1.34,feet:y<=.32}[region]));
}
