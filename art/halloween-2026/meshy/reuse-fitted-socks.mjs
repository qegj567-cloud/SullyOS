import fs from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import * as T from 'three';
import {readGlb,packGlb,stripImages} from './glb-utils.mjs';
import {saveGlb} from '../../jellyfish-home/asset-geometry.mjs';
import {fitApprovedSock} from './fit-sock-bridge.mjs';
const dir='art/halloween-2026/meshy/fitted-socks';await fs.mkdir(dir,{recursive:true});
const {json,bin}=await readGlb('public/room3d/wardrobe/sailor-girl.glb');
const bytes=packGlb(stripImages(json),bin),root=(await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene;
let sock;const remove=[];root.traverse(o=>{if(o.isMesh){if(o.name==='Sailor_socks')sock=o;else remove.push(o);}});remove.forEach(o=>o.removeFromParent());
if(!sock?.isSkinnedMesh||sock.skeleton.bones.length!==48)throw Error('Expected the approved 48-bone sock');
const fingerprint=g=>Object.fromEntries(['position','skinIndex','skinWeight'].map(k=>[k,createHash('sha256').update(Buffer.from(g.attributes[k].array.buffer)).digest('hex')]));
const before=fingerprint(sock.geometry),p=sock.geometry.attributes.position,uv=[];
fitApprovedSock(sock);
for(let i=0;i<p.count;i++)uv.push(.5,p.getY(i)/.24);
sock.geometry.setAttribute('uv',new T.Float32BufferAttribute(uv,2));sock.name='Halloween_fitted_socks';sock.material=new T.MeshStandardMaterial({color:0xffffff,roughness:.88});
await saveGlb(root,dir+'/base.glb');
function crc32(b){let c=0xffffffff;for(const n of b){c^=n;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length);t.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([t,data])),8+data.length);return out;}
function stripePng(a,b){const h=Buffer.alloc(13);h.writeUInt32BE(1);h.writeUInt32BE(2,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,...a,0,...b]))),chunk('IEND',Buffer.alloc(0))]);}
const report=[];
for(const [id,secondary]of [['ghost',[101,33,151]],['pumpkin',[33,28,42]]]){
 const {json:j,bin:b}=await readGlb(dir+'/base.glb'),png=stripePng([255,114,18],secondary),offset=Math.ceil(b.length/4)*4,newBin=Buffer.alloc(offset+png.length);b.copy(newBin);png.copy(newBin,offset);
 const view=j.bufferViews.length;j.bufferViews.push({buffer:0,byteOffset:offset,byteLength:png.length});j.buffers[0].byteLength=newBin.length;
 j.images=[{bufferView:view,mimeType:'image/png'}];j.samplers=[{magFilter:9728,minFilter:9728,wrapS:10497,wrapT:10497}];j.textures=[{source:0,sampler:0}];j.materials=[{name:id+'_striped_knit',pbrMetallicRoughness:{baseColorTexture:{index:0},metallicFactor:0,roughnessFactor:.88}}];
 for(const m of j.meshes)for(const p of m.primitives)p.material=0;
 await fs.writeFile(dir+'/'+id+'-socks.glb',packGlb(j,newBin));
 report.push({id:id+'-socks',source:'public/room3d/wardrobe/sailor-girl.glb#Sailor_socks',triangles:sock.geometry.index.count/3,bones:48,topologyUnchanged:true,fitMethod:'existing fitSockSurface on current 48-bone body',sourceFingerprint:before,fittedFingerprint:fingerprint(sock.geometry),status:'reused-approved-fit; pending outfit and motion QA'});
}
await fs.writeFile(dir+'/manifest.json',JSON.stringify(report,null,2));console.log(report);
