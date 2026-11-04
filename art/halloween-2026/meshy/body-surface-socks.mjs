import fs from 'node:fs/promises';
import * as T from 'three';
import {fittingRig} from './wardrobe-fit-utils.mjs';
import {clipY} from './clip-garment.mjs';
import {saveGlb} from '../../jellyfish-home/asset-geometry.mjs';
import {embedTexture} from './textured-geometry.mjs';
import {readGlb,packGlb} from './glb-utils.mjs';
const dir='art/halloween-2026/meshy/fitted-socks',report=[];
for(const [id,top]of [['witch',1.25],['apprentice',1.32],['ghost',1.55]]){
 const r=await fittingRig(),g=clipY(r.body.geometry,.33,top),p=g.attributes.position,n=g.attributes.normal,uv=[];
 function wave(x,y,z){return id==='witch'?Math.sin(Math.atan2(z-.03,x-(x>0?.22:-.22))*8)*.01*T.MathUtils.smoothstep(y,top-.07,top-.025):0;}
 for(let i=0;i<p.count;i++){const normal=new T.Vector3().fromBufferAttribute(n,i).normalize(),y=p.getY(i)+wave(p.getX(i),p.getY(i),p.getZ(i));p.setXYZ(i,p.getX(i)+normal.x*.006,y,p.getZ(i)+normal.z*.006);uv.push(.5,p.getY(i)/.24);}
 g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));
 const mesh=new T.SkinnedMesh(g,new T.MeshStandardMaterial({color:id==='witch'?'#17131d':'#ffffff',roughness:.9,side:T.DoubleSide}));mesh.name='Halloween_'+id+'_body_surface_socks';mesh.userData={part:'socks',source:'CurrentBody leg surface with original skin weights',offset:.006,top};r.root.add(mesh);mesh.bind(r.sk,r.body.bindMatrix);
 if(id==='witch'){const rim=clipY(r.body.geometry,top-.035,top),rp=rim.attributes.position,rn=rim.attributes.normal;for(let i=0;i<rp.count;i++){const normal=new T.Vector3().fromBufferAttribute(rn,i).normalize(),y=rp.getY(i)+wave(rp.getX(i),rp.getY(i),rp.getZ(i));rp.setXYZ(i,rp.getX(i)+normal.x*.007,y,rp.getZ(i)+normal.z*.007);}const orange=new T.SkinnedMesh(rim,new T.MeshStandardMaterial({color:'#ff811a',roughness:.9,side:T.DoubleSide}));orange.name='Halloween_witch_orange_sock_edge';orange.userData={part:'socks'};r.root.add(orange);orange.bind(r.sk,r.body.bindMatrix);}
 const old=await readGlb(dir+'/'+id+'-socks.glb'),im=old.json.images?.[0],bv=im&&old.json.bufferViews[im.bufferView],source=bv?{textureBytes:old.bin.subarray(bv.byteOffset||0,(bv.byteOffset||0)+bv.byteLength),mime:im.mimeType}:null;
 r.clothesOnly();const file=dir+'/'+id+'-socks.glb';await saveGlb(r.root,file);if(source){await embedTexture(file,source);const {json,bin}=await readGlb(file);for(const s of json.samplers){s.minFilter=9728;s.magFilter=9728;}await fs.writeFile(file,packGlb(json,bin));}
 report.push({id,top,offset:.006,triangles:g.index.count/3,source:'current body',weights:'original, clipped edges blend bone contributions'});
}
await fs.writeFile(dir+'/body-surface-report.json',JSON.stringify(report,null,2));console.log(report);
