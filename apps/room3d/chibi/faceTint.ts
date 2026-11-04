import {colorHsl,hslToRgb,resolveTint,type CreatorHairTint} from './creatorHairTint';
export type EyeTint=Pick<CreatorHairTint,'hueIdx'|'sat'|'light'|'color'>;
export type EyeDye=string|EyeTint;
/** Chibi applyEyesTint, including its original palette parameters and linework setting. */
export function tintIrisPixels(pixels:Uint8ClampedArray,color:EyeDye,mask?:Uint8ClampedArray,preserveLineart=25){
 const tint=typeof color==='string'?colorHsl(color):resolveTint(color),TH=preserveLineart,SOFT=10;
 for(let i=0;i<pixels.length;i+=4){
  if(!pixels[i+3]||(mask&&!mask[i+3]))continue;
  const gray=.299*pixels[i]+.587*pixels[i+1]+.114*pixels[i+2];
  if(gray>=235){pixels[i]=pixels[i+1]=pixels[i+2]=255;continue;}
  if(TH>0&&gray<=TH){pixels[i]=pixels[i+1]=pixels[i+2]=0;continue;}
  const rgb=hslToRgb(tint.h,tint.s,Math.max(5,Math.min(95,gray/255*100+tint.lightOffset)));
  for(let c=0;c<3;c++)pixels[i+c]=TH>0&&gray<=TH+SOFT?Math.round(rgb[c]*((gray-TH)/SOFT)):rgb[c];
 }
}

/** Screen-left / screen-right, matching the 2D creator. Untouched sides stay original. */
export function tintIrisPairPixels(pixels:Uint8ClampedArray,width:number,colors:{L?:EyeDye;R?:EyeDye},mask?:Uint8ClampedArray,preserveLineart=25){
 for(let start=0;start<pixels.length;start+=width*4){
  for(const [offset,end,color] of [[0,Math.ceil(width/2)*4,colors.L],[Math.ceil(width/2)*4,width*4,colors.R]] as const){
   if(color&&(typeof color!=='string'||/^#[\da-f]{6}$/i.test(color)))tintIrisPixels(pixels.subarray(start+offset,start+end),color,mask?.subarray(start+offset,start+end),preserveLineart);
  }
 }
}
