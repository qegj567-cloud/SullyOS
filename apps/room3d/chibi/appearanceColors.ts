import {resolveTint,tintCreatorHairPixels,type CreatorHairTint} from './creatorHairTint';
export type PartSurface = HTMLImageElement | HTMLCanvasElement;
export const validAppearanceColor = (value?:string) => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value) ? value : undefined;
const cache = new WeakMap<PartSurface, Map<string, HTMLCanvasElement>>();
const shadowIds=new WeakMap<PartSurface,number>();let nextShadowId=0;
/** Preserve alpha, linework and painted shading; never modify the source artwork. */
export function tintAppearancePixels(pixels:Uint8ClampedArray,width:number,height:number,color:string,tip?:string,tint?:CreatorHairTint,preserveLineart=25) {
 tintCreatorHairPixels(pixels,width,height,resolveTint(tint??{hueIdx:0,sat:50,light:0,color,gradientColor:validAppearanceColor(tip)}),preserveLineart);
}
export function tintAppearancePart(image:PartSurface,color:string,tip?:string,tint?:CreatorHairTint,shadow?:PartSurface) {
 const threshold=Number(image.dataset?.creatorLineart??25);
 if(shadow&&!shadowIds.has(shadow))shadowIds.set(shadow,++nextShadowId);
 const key=JSON.stringify([color,validAppearanceColor(tip),tint,threshold,shadow&&shadowIds.get(shadow)]);
 let colors=cache.get(image);if(!colors){colors=new Map();cache.set(image,colors);}
 const hit=colors.get(key);if(hit)return hit;
 const canvas=document.createElement('canvas');canvas.width=('naturalWidth' in image?image.naturalWidth:image.width)||472;canvas.height=('naturalHeight' in image?image.naturalHeight:image.height)||472;
 const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0,canvas.width,canvas.height);
 const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);tintAppearancePixels(pixels.data,canvas.width,canvas.height,color,tip,tint,threshold);ctx.putImageData(pixels,0,0);
 // Match renderTintedLayer's high-quality 1.5x pass before captureCreatorLayer
 // reduces to 472px. Skipping it changes antialiasing at dark strand edges.
 const upscaled=document.createElement('canvas');upscaled.width=Math.round(canvas.width*1.5);upscaled.height=Math.round(canvas.height*1.5);
 const smooth=upscaled.getContext('2d')!;smooth.imageSmoothingEnabled=true;smooth.imageSmoothingQuality='high';smooth.drawImage(canvas,0,0,upscaled.width,upscaled.height);
 const output=document.createElement('canvas');output.width=output.height=472;const final=output.getContext('2d')!;
 if(shadow)final.drawImage(shadow,0,0,472,472);
 final.drawImage(upscaled,0,0,472,472);
 if(colors.size>=8)colors.delete(colors.keys().next().value!);
 colors.set(key,output);return output;
}
