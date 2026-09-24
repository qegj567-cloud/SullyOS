// Recover the native preset details from the shipped 01–07 references.
// The PSD remains the source for editable lashes, irises and expression variants.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {measureFaceLandmarks} from '../../apps/room3d/chibi/faceLandmarks.ts';
const require=createRequire(import.meta.url);
const sharp=require(path.resolve('node_modules/.pnpm',fs.readdirSync('node_modules/.pnpm').find(n=>n.startsWith('sharp@')),'node_modules/sharp'));
const assets={};
for(let n=1;n<=7;n++){
 const id=String(n).padStart(2,'0'),src=`like520/parts/eyes_${id}.png`,bytes=fs.readFileSync(`public/${src}`);
 const original=await sharp(bytes).ensureAlpha().raw().toBuffer(),seen=new Uint8Array(472*472),components=[];
 for(let i=0;i<seen.length;i++)if(!seen[i]&&original[i*4+3]){
  const pixels=[i];seen[i]=1;let top=472;
  for(let k=0;k<pixels.length;k++){
   const j=pixels[k],x=j%472,y=Math.floor(j/472);top=Math.min(top,y);
   for(const p of [x?j-1:-1,x<471?j+1:-1,j-472,j+472])if(p>=0&&p<seen.length&&!seen[p]&&original[p*4+3]){seen[p]=1;pixels.push(p);}
  }
  if(pixels.length>100)components.push({pixels,top});
 }
 const brows=components.sort((a,b)=>a.top-b.top).slice(0,2),brow=new Uint8Array(original.length),highlight=new Uint8Array(original.length);
 for(const b of brows)for(const p of b.pixels)brow.set(original.subarray(p*4,p*4+4),p*4);
 const iris=id==='04'?null:await sharp(`public/room3d/face/iris-${id}-open.png`).ensureAlpha().raw().toBuffer();
 if(iris)for(let p=0;p<original.length;p+=4){
  if(iris[p+3]<128||original[p]<210||original[p+1]<210||original[p+2]<210)continue;
  highlight.set([255,255,255,Math.round(original[p+3]*Math.min(1,(Math.min(original[p],original[p+1],original[p+2])-210)/35))],p);
 }
 assets[`original-${id}`]={src,sha256:createHash('sha256').update(bytes).digest('hex'),source:src};
 for(const [kind,raw] of [['brow',brow],['highlight',highlight]]){
  const output=`room3d/face/${kind}-original-${id}.png`,png=await sharp(Buffer.from(raw),{raw:{width:472,height:472,channels:4}}).png().toBuffer();
  fs.writeFileSync(`public/${output}`,png);
  assets[`${kind}-original-${id}`]={src:output,source:src,sha256:createHash('sha256').update(png).digest('hex'),...(kind==='brow'?{sides:measureFaceLandmarks(472,472,raw)}:{})};
 }
}
fs.writeFileSync('apps/room3d/chibi/faceOriginals.json',JSON.stringify({assets},null,2)+'\n');
console.log('Published registered original preset details for 01–07.');
