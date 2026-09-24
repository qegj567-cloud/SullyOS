import manifest from './faceAssets.json';
import originals from './faceOriginals.json';
import {cleanAdjustment,transformFaceSide,cleanMouthChoices,type FaceAdjustments,type FaceAdjustment,type MouthChoices} from './faceAdjustments';
import {eyePairOffset,scleraContour,browExpressionRotation,detailBounds,fitHighlight,type FaceSide} from './faceLandmarks';

export type EyeState='open'|'half'|'closed'|'happy';
export interface FaceSettings {
 enabled:boolean; upper:string; eye:string; lower:string; brow:string; highlight:string;
 eyeState:EyeState; emotion:'neutral'|'angry'|'sad'; mouth:string;
 eyeOffsetY:number; browOffsetY:number; irisColor:string; blink:boolean;
 pupilSrc?:string; highlightSrc?:string;
 adjustments?:FaceAdjustments; mouths?:MouthChoices;
}
export const defaultFace:FaceSettings={enabled:true,upper:'01',eye:'01',lower:'01',brow:'original',highlight:'original',eyeState:'open',emotion:'neutral',mouth:'closed-04',eyeOffsetY:0,browOffsetY:0,irisColor:'#79658c',blink:false};
type Asset={src:string;sourceLayer:string;sides?:FaceSide[]};
export const faceAssets={...manifest.assets,...originals.assets} as unknown as Record<string,Asset>;
export const eyeStyles=['01','02','03','05','06','07'];
export const upperStyles=['01','02','03','04','05','06','07'];
export const mouthStyles=Object.keys(faceAssets).filter(k=>k.startsWith('mouth-')).map(k=>k.slice(6));
export function cleanFace(value?:Partial<FaceSettings>):FaceSettings {
 const v={...defaultFace,...value};
 const choose=(value:string,choices:string[],fallback:string)=>choices.includes(value)?value:fallback;
 v.upper=choose(v.upper,upperStyles,'01');v.eye=choose(v.eye,eyeStyles,'01');
 v.lower=choose(v.lower,['none',...eyeStyles],'01');v.brow=choose(v.brow,['original','none','01','02','03','04'],'original');
 v.highlight=choose(v.highlight,['original','none','01','02','03','04','05','06','07'],'original');
 v.mouth=choose(v.mouth,mouthStyles,'closed-04');
 v.mouths=cleanMouthChoices(v.mouths,v.mouth,mouthStyles);
 v.eyeState=choose(v.eyeState,['open','half','closed','happy'],'open') as EyeState;
 v.emotion=choose(v.emotion,['neutral','angry','sad'],'neutral') as FaceSettings['emotion'];
 v.eyeOffsetY=Number.isFinite(v.eyeOffsetY)?Math.max(-20,Math.min(20,v.eyeOffsetY)):0;
 v.browOffsetY=Number.isFinite(v.browOffsetY)?Math.max(-20,Math.min(20,v.browOffsetY)):0;
 if(!/^#[\da-f]{6}$/i.test(v.irisColor))v.irisColor=defaultFace.irisColor;
 return v;
}
export function applyEyePreset(value:FaceSettings,style:string):FaceSettings{
 const adjustments={...value.adjustments};
 for(const key of ['eyes','upper','iris','lower','brow','highlight','pupil'] as const)delete adjustments[key];
 return cleanFace({...value,upper:style,eye:style==='04'?'01':style,lower:style==='04'?'none':style,brow:'original',highlight:'original',eyeState:'open',emotion:'neutral',eyeOffsetY:0,browOffsetY:0,pupilSrc:undefined,highlightSrc:undefined,adjustments});
}
export function faceLayerIds(settings:FaceSettings,state=settings.eyeState){
 const closed=state==='closed'||state==='happy'||settings.upper==='04';
 const upper=settings.upper==='04'?'upper-04-closed':state==='closed'?'upper-common-closed':`upper-${settings.upper}-${state}`;
 const eyeState=state==='half'?'half':'open';
 return {closed,upper,iris:`iris-${settings.eye}-${eyeState}`,white:`white-${settings.eye}-${eyeState}`};
}
const images=new Map<string,Promise<HTMLImageElement>>();
function loadImage(src:string){
 let pending=images.get(src);
 if(!pending){pending=(async()=>{const image=new Image();image.src=src;await image.decode();return image;})();images.set(src,pending);pending.catch(()=>images.delete(src));}
 return pending;
}
export async function loadFaceImages(settings:FaceSettings){
 const ids=new Set<string>();
 for(const state of ['open','half','closed','happy'] as EyeState[]){const layers=faceLayerIds(settings,state);ids.add(layers.upper);ids.add(layers.iris);ids.add(layers.white);}
 ids.add(`original-${settings.upper}`);ids.add(`brow-original-${settings.upper}`);
 for(const [kind,style] of [['lower',settings.lower],['brow',settings.brow],['highlight',settings.highlight]])if(style!=='none')ids.add(`${kind}-${style==='original'?`original-${settings.upper}`:style}`);
 ids.add(`mouth-${settings.mouth}`);
 const result:Record<string,HTMLImageElement>=Object.fromEntries(await Promise.all([...ids].map(async id=>[id,await loadImage(`${import.meta.env.BASE_URL}${faceAssets[id].src}`)])));
 for(const key of ['pupilSrc','highlightSrc'] as const)if(settings[key])result[key]=await loadImage(settings[key]!);
 return result;
}
function canvas(){const c=document.createElement('canvas');c.width=c.height=472;return c;}
const highlightBounds=new WeakMap<HTMLImageElement,ReturnType<typeof detailBounds>[]>();
function placeHighlight(ctx:CanvasRenderingContext2D,image:HTMLImageElement,visibleIris:HTMLCanvasElement,adjustment:FaceAdjustment){
 let bounds=highlightBounds.get(image);
 if(!bounds){const source=canvas(),s=source.getContext('2d')!;s.drawImage(image,0,0,472,472);const pixels=s.getImageData(0,0,472,472).data;bounds=[0,1].map(side=>detailBounds(472,472,pixels,side));highlightBounds.set(image,bounds);}
 const mask=visibleIris.getContext('2d')!.getImageData(0,0,472,472).data;
 bounds.forEach((b,side)=>{
  if(!b)return;const fit=fitHighlight(472,472,mask,b,side);if(!fit)return;
  const sx=b.left/472*image.naturalWidth,sy=b.top/472*image.naturalHeight;
  const width=fit.width*adjustment.size*adjustment.width,height=fit.height*adjustment.size;
  ctx.drawImage(image,sx,sy,(b.right-b.left+1)/472*image.naturalWidth,(b.bottom-b.top+1)/472*image.naturalHeight,fit.x+(fit.width-width)/2,fit.y+adjustment.y,width,height);
 });
}
export function composeFace(settings:FaceSettings,images:Record<string,HTMLImageElement>,state=settings.eyeState){
 const eyes=canvas(),mouth=canvas(),ctx=eyes.getContext('2d')!,m=mouth.getContext('2d')!;
 const layers=faceLayerIds(settings,state),upper=faceAssets[layers.upper],iris=faceAssets[layers.iris];
 const draw=(context:CanvasRenderingContext2D,id:string,dy=0)=>{if(images[id])context.drawImage(images[id],0,dy,472,472);};
 const adjust=(key:keyof FaceAdjustments)=>cleanAdjustment(settings.adjustments?.[key]);
 const drawPair=(context:CanvasRenderingContext2D,id:string,reference:FaceSide[],a:FaceAdjustment,dy=0)=>{
  reference.forEach((s,i)=>{const cy=(s.top+s.bottom)/2;context.save();context.beginPath();context.rect(i?236:0,0,236,472);context.clip();context.translate(s.x+(i?1:-1)*a.spacing,cy+a.y+dy);context.scale(a.size*a.width,a.size);context.translate(-s.x,-cy);draw(context,id);context.restore();});
 };
 const upperAdjust=adjust('upper'),irisAdjust=adjust('iris');
 const lash=upper.sides!.map((s,i)=>transformFaceSide(s,upperAdjust,i));
 // Iris vertical fine-tuning is added after auto alignment so auto fitting
 // cannot cancel a user's slider movement.
 const irisSides=iris.sides!.map((s,i)=>transformFaceSide(s,{...irisAdjust,y:0},i));
 const neutral=(part:keyof FaceAdjustments)=>{const a=adjust(part);return a.size===1&&a.width===1&&a.y===0&&a.spacing===0;};
 const originalPreset=settings.upper==='04'?neutral('upper'):state==='open'&&settings.upper===settings.eye&&settings.lower===settings.eye&&settings.highlight==='original'&&!settings.highlightSrc&&!settings.pupilSrc&&settings.eyeOffsetY===0&&(['upper','iris','lower','highlight','pupil'] as const).every(neutral);
 if(originalPreset){
  // The shipped default artwork is the registration ground truth, including
  // its sclera, pupil, native highlight and eyelid folds. Do not regenerate it.
  draw(ctx,`original-${settings.upper}`);
  const pixels=ctx.getImageData(0,0,472,472),brow=canvas(),b=brow.getContext('2d')!;
  draw(b,`brow-original-${settings.upper}`);const mask=b.getImageData(0,0,472,472).data;
  for(let i=0;i<pixels.data.length;i+=4)if(mask[i+3])pixels.data.fill(0,i,i+4);
  if(settings.upper!=='04'){
   b.clearRect(0,0,472,472);draw(b,layers.iris);const irisMask=b.getImageData(0,0,472,472).data;
   const color=[1,3,5].map(i=>parseInt(settings.irisColor.slice(i,i+2),16));
   for(let i=0;i<pixels.data.length;i+=4)if(irisMask[i+3]>128&&pixels.data[i]>60&&pixels.data[i]<225&&pixels.data[i+3]){
    for(let channel=0;channel<3;channel++)pixels.data[i+channel]=Math.round(pixels.data[i+channel]*.35+color[channel]*.65);
   }
  }
  ctx.putImageData(pixels,0,0);
 }else if(!layers.closed){
  const nativeLash=faceAssets[`upper-${settings.eye}-${state==='half'?'half':'open'}`].sides!;
  const openIris=faceAssets[`iris-${settings.eye}-open`].sides!;
  // A half-open iris is already shorter in the PSD. Keep its lower baseline
  // fixed instead of raising its bottom while also lowering the upper lid.
  const halfBaseline=state==='half'?iris.sides!.reduce((n,s,i)=>n+openIris[i].bottom-s.bottom,0)/2:0;
  const dy=eyePairOffset(lash,irisSides,{lash:nativeLash,iris:iris.sides!},settings.eyeOffsetY)+irisAdjust.y+halfBaseline;
  const unit=canvas(),u=unit.getContext('2d')!;
  // Sclera starts with the exact iris silhouette. The two side wedges are
  // reconstructed against the selected eyelid, rather than a fixed white PNG.
  const drawIris=(context:CanvasRenderingContext2D)=>drawPair(context,layers.iris,iris.sides!,{...irisAdjust,y:0},dy);
  const matching=settings.upper===settings.eye&&neutral('upper')&&neutral('iris')&&settings.eyeOffsetY===0;
  if(matching)draw(u,layers.white,dy);
  else {drawIris(u);u.globalCompositeOperation='source-in';u.fillStyle='white';u.fillRect(0,0,472,472);u.globalCompositeOperation='source-over';}
  if(!matching)lash.forEach((side,index)=>{
   const contour=scleraContour(side,irisSides[index],dy),{A,B,C,D,lid,bottom,leftControls:l,rightControls:r}=contour;
   if(B[1]<=A[1]||C[1]<=D[1])return;
   u.beginPath();u.moveTo(...A);for(const p of lid)u.lineTo(...p);
   u.bezierCurveTo(...r[0],...r[1],...C);
   for(const p of bottom)u.lineTo(...p);
   u.bezierCurveTo(...l[0],...l[1],...A);u.closePath();u.fill();
  });
  const colored=canvas(),c=colored.getContext('2d')!;drawIris(c);
  const aperture=canvas(),a=aperture.getContext('2d')!;
  for(const side of lash){a.beginPath();a.moveTo(side.left,472);for(let x=side.left;x<=side.right;x++)a.lineTo(x,side.edge[x-side.left]-1);a.lineTo(side.right,472);a.closePath();a.fill();}
  const visibleIris=canvas(),v=visibleIris.getContext('2d')!;v.drawImage(colored,0,0);v.globalCompositeOperation='destination-in';v.drawImage(aperture,0,0);
  // Color belongs to the iris only; the generated sclera stays white.
  c.globalCompositeOperation='source-atop';c.fillStyle=settings.irisColor;c.globalAlpha=.65;c.fillRect(0,0,472,472);c.globalAlpha=1;c.globalCompositeOperation='source-over';
  const details=canvas(),d=details.getContext('2d')!;
  if(images.pupilSrc)drawPair(d,'pupilSrc',iris.sides!,adjust('pupil'),dy);
  const highlight=images.highlightSrc??(settings.highlight!=='none'?images[`highlight-${settings.highlight==='original'?`original-${settings.upper}`:settings.highlight}`]:undefined);
  if(highlight)placeHighlight(d,highlight,visibleIris,adjust('highlight'));
  d.globalCompositeOperation='destination-in';drawIris(d);
  c.globalCompositeOperation='source-atop';c.drawImage(details,0,0);c.globalCompositeOperation='source-over';u.drawImage(colored,0,0);
  // Clip both the iris and reconstructed sclera above the eyelid. This boundary
  // comes from its main connected stroke, excluding the decorative flicks.
  u.globalCompositeOperation='destination-in';u.drawImage(aperture,0,0);ctx.drawImage(unit,0,0);
  if(settings.lower!=='none'){
   // Lower lashes remain with the eye bottom in open/half states.
   const reference=faceAssets[`iris-${settings.eye}-open`].sides!;
   const current=irisSides;
   const shift=dy+current.reduce((n,s,i)=>n+s.bottom-reference[i].bottom,0)/2;
   drawPair(ctx,`lower-${settings.lower}`,faceAssets[`lower-${settings.lower}`].sides!,adjust('lower'),shift);
  }
 }
 if(!originalPreset)drawPair(ctx,layers.upper,upper.sides!,upperAdjust);
 // Group controls move the complete eye assembly, including its mask, together.
 const grouped=canvas(),g=grouped.getContext('2d')!,whole=adjust('eyes');
 for(const [i,cx] of [178,297].entries()){g.save();g.beginPath();g.rect(i?236:0,0,236,472);g.clip();g.translate(cx+(i?1:-1)*whole.spacing,272+whole.y);g.scale(whole.size*whole.width,whole.size);g.translate(-cx,-272);g.drawImage(eyes,0,0);g.restore();}
 ctx.clearRect(0,0,472,472);ctx.drawImage(grouped,0,0);
 if(settings.brow!=='none'){
  const browId=`brow-${settings.brow==='original'?`original-${settings.upper}`:settings.brow}`,brows=faceAssets[browId].sides!;
  const baseline=faceAssets[settings.upper==='04'?'upper-04-closed':`upper-${settings.upper}-open`].sides!;
  const descent=lash.reduce((n,l,i)=>n+l.anchor-baseline[i].anchor,0)/2;
  const dy=settings.browOffsetY+(settings.brow==='original'?0:Math.max(-5,Math.min(5,descent*.3)));
  brows.forEach((b,i)=>{
   const cy=(b.inner[1]+b.outer[1])/2;
   ctx.save();ctx.beginPath();ctx.rect(i?236:0,0,236,472);ctx.clip();
   ctx.translate(b.x,cy+dy);ctx.rotate(browExpressionRotation(b,settings.emotion));ctx.translate(-b.x,-cy);
   drawPair(ctx,browId,brows,adjust('brow'));ctx.restore();
  });
 }
 const mouthAdjust=adjust('mouth');m.translate(237,310+mouthAdjust.y);m.scale(mouthAdjust.size*mouthAdjust.width,mouthAdjust.size);m.translate(-237,-310);draw(m,`mouth-${settings.mouth}`);
 return {eyes,mouth};
}
