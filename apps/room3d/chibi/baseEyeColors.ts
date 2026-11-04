import {tintIrisPairPixels} from './faceTint';
import type {PartSurface} from './appearanceColors';
import {faceEyeDyes,type FaceSettings} from './faceAppearance';
const cache=new WeakMap<PartSurface,WeakMap<PartSurface,Map<string,HTMLCanvasElement>>>();
/** Dye the original source, never repeatedly recolor the already dyed 2D export. */
export function colorBaseEyes(baked:PartSurface,raw:PartSurface|undefined,face:FaceSettings){
 const colors=faceEyeDyes(face,true);
 if(!colors.L&&!colors.R)return baked;
 const source=raw??baked,threshold=Number(source.dataset?.creatorLineart??face.preserveLineart??25),key=JSON.stringify([colors,threshold]);
 let sources=cache.get(baked);if(!sources){sources=new WeakMap();cache.set(baked,sources);}
 let variants=sources.get(source);if(!variants){variants=new Map();sources.set(source,variants);}
 const hit=variants.get(key);if(hit)return hit;
 const work=document.createElement('canvas');work.width=('naturalWidth' in source?source.naturalWidth:source.width)||472;work.height=('naturalHeight' in source?source.naturalHeight:source.height)||472;
 const w=work.getContext('2d',{willReadFrequently:true})!;w.drawImage(source,0,0,work.width,work.height);
 const pixels=w.getImageData(0,0,work.width,work.height);tintIrisPairPixels(pixels.data,work.width,colors,undefined,threshold);w.putImageData(pixels,0,0);
 // Match Chibi's native-resolution dye → 1.5x high-quality pass → exported layer.
 const up=document.createElement('canvas');up.width=Math.round(work.width*1.5);up.height=Math.round(work.height*1.5);
 const u=up.getContext('2d')!;u.imageSmoothingEnabled=true;u.imageSmoothingQuality='high';u.drawImage(work,0,0,up.width,up.height);
 const canvas=document.createElement('canvas');canvas.width=canvas.height=472;
 const ctx=canvas.getContext('2d')!;ctx.drawImage(up,0,0,472,472);
 for(const [x,color] of [[0,colors.L],[236,colors.R]] as const)if(!color){ctx.clearRect(x,0,236,472);ctx.drawImage(baked,x,0,236,472,x,0,236,472);}
 if(variants.size>=8)variants.delete(variants.keys().next().value!);
 variants.set(key,canvas);return canvas;
}
