// Offline publishing: pnpm node art/chibi/import-face-psd.mjs <source.psd>
// Reads every authored variant, including hidden layers. Never modifies the PSD.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readPsd,initializeCanvas} from 'ag-psd';
import {measureFaceLandmarks} from '../../apps/room3d/chibi/faceLandmarks.ts';
const sharpDirectory=fs.readdirSync('node_modules/.pnpm').find(n=>/^sharp@/.test(n));
if(!sharpDirectory)throw Error('The offline publisher needs the installed sharp package');
const {default:sharp}=await import(pathToFileURL(path.resolve(`node_modules/.pnpm/${sharpDirectory}/node_modules/sharp/lib/index.js`)).href);
const source=process.argv[2];if(!source)throw Error('Supply the PSD path');
const bytes=fs.readFileSync(source);
initializeCanvas(()=>{throw Error('Canvas not used')},(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}));
const psd=readPsd(bytes,{useImageData:true,skipCompositeImageData:true,skipThumbnail:true});
if(psd.width!==472||psd.height!==472)throw Error('Expected the registered 472 × 472 artwork');
const directory='public/room3d/face';fs.mkdirSync(directory,{recursive:true});
const assets={};
const state=name=>/半/.test(name)?'half':/笑|开心/.test(name)?'happy':'open';
async function visit(layers,parents=[]){
 for(const layer of layers){
  const names=[...parents,layer.name];
  if(layer.children){await visit(layer.children,names);continue;}
  if(!layer.imageData)continue;
  const [group,style]=names;let id;
  if(group==='后发1')id=`back1_${style}`;
  else if(group==='眼睛')id=`${names.length===4?'white':'iris'}-${style}-${state(layer.name)}`;
  else if(group==='上睫毛')id=`upper-${style}-${style==='04'?'closed':state(layer.name)}`;
  else if(group==='下睫毛')id=`lower-${style}`;
  else if(group==='高光')id=`highlight-${style}`;
  else if(group==='眉毛')id=`brow-${style==='图层 4'?'04':style}`;
  else if(layer.name==='普通闭眼')id='upper-common-closed';
  else if(group==='嘴'&&names.length===3)id=`mouth-${style==='闭合'?'closed':style==='张大'?'open':'smile'}-${layer.name.replace(' 副本','')}`;
  // Two loose mouth copies are preserved in the source; the grouped copies
  // define the published choices, avoiding duplicate entries without states.
  if(!id)continue;
  if(assets[id])throw Error(`Duplicate asset ${id}`);
  const raw=new Uint8ClampedArray(472*472*4);
  const image=layer.imageData;
  for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){
   const tx=(layer.left??0)+x,ty=(layer.top??0)+y;
   if(tx<0||tx>=472||ty<0||ty>=472)continue;
   const a=(y*image.width+x)*4,b=(ty*472+tx)*4;
   raw.set(image.data.subarray(a,a+4),b);raw[b+3]=Math.round(raw[b+3]*(layer.opacity??1));
  }
  const png=await sharp(Buffer.from(raw),{raw:{width:472,height:472,channels:4}}).png().toBuffer();
  const output=id.startsWith('back1_')?`public/like520/parts/${id}.png`:`${directory}/${id}.png`;
  fs.writeFileSync(output,png);
  assets[id]={src:output.replace('public/',''),sourceLayer:names.join('/'),sha256:createHash('sha256').update(png).digest('hex'),...(/^(upper|iris|white|brow|lower)-/.test(id)?{sides:measureFaceLandmarks(472,472,raw)}:{})};
 }
}
await visit(psd.children);
const manifest={version:1,canvas:472,source:{file:path.basename(source),sha256:createHash('sha256').update(bytes).digest('hex')},assets};
fs.writeFileSync('apps/room3d/chibi/faceAssets.json',JSON.stringify(manifest,null,2)+'\n');
console.log(`Published ${Object.keys(assets).length} authored layers, including four replacement back-hair textures.`);
