import fs from 'node:fs/promises';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {readGlb,packGlb,stripImages} from './glb-utils.mjs';
import {fitApprovedSock} from './fit-sock-bridge.mjs';
import {saveGlb} from '../../jellyfish-home/asset-geometry.mjs';
import {embedTexture} from './textured-geometry.mjs';
const dir='art/halloween-2026/meshy/fitted-socks',base=await readGlb(dir+'/base.glb'),report=[];
for(const [id,top]of [['pumpkin',1.43],['ghost',1.55],['apprentice',1.32],['witch',1.42]]){
 const old=await readGlb(dir+'/'+id+'-socks.glb'),texture=old.json.images?.[0],view=texture&&old.json.bufferViews[texture.bufferView],source=view?{textureBytes:old.bin.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength),mime:texture.mimeType}:null;
 const b=packGlb(stripImages(base.json),base.bin),root=(await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene;
 root.traverse(m=>{if(!m.isSkinnedMesh)return;const p=m.geometry.attributes.position,uv=m.geometry.attributes.uv;let max=-Infinity;for(let i=0;i<p.count;i++)max=Math.max(max,p.getY(i));for(let i=0;i<p.count;i++){const y=p.getY(i);if(y>.26)p.setY(i,.26+(y-.26)*(top-.26)/(max-.26));uv.setXY(i,.5,p.getY(i)/.24);}fitApprovedSock(m);m.material=new T.MeshStandardMaterial({color:id==='witch'?'#21172b':'#ffffff',roughness:.9});m.userData={part:'socks',top,source:'Sailor_socks + approved fitSockSurface'};});
 const file=dir+'/'+id+'-socks.glb';await saveGlb(root,file);if(source&&id!=='witch'){await embedTexture(file,source);const {json,bin}=await readGlb(file);for(const sampler of json.samplers){sampler.magFilter=9728;sampler.minFilter=9728;}await fs.writeFile(file,packGlb(json,bin));}report.push({id,top,bodyMaskTop:top-.06,triangles:1156,bones:48});
}
await fs.writeFile(dir+'/lengths.json',JSON.stringify(report,null,2));console.log(report);
