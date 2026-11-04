import fs from 'node:fs/promises';
import {readGlb,packGlb} from './glb-utils.mjs';
const dir=process.argv[2]||'art/halloween-2026/meshy/halloween-batch-04-texture';
for(const id of (process.argv.length>3?process.argv.slice(3):['pumpkin-costume','ghost-top','pumpkin-lantern'])){
 const {json:j,bin}=await readGlb(dir+'/'+id+'-textured.glb');let output=Buffer.from(bin);
 const get=ai=>{const a=j.accessors[ai],v=j.bufferViews[a.bufferView],size={5126:4,5125:4,5123:2}[a.componentType],components={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type],stride=v.byteStride||size*components,offset=(v.byteOffset||0)+(a.byteOffset||0);if(!size||!components)throw Error('Unsupported accessor');return {a,read:(i,k=0)=>a.componentType===5126?bin.readFloatLE(offset+i*stride+k*size):size===4?bin.readUInt32LE(offset+i*stride+k*size):bin.readUInt16LE(offset+i*stride+k*size)};};
 for(const m of j.meshes)for(const p of m.primitives){
  const pos=get(p.attributes.POSITION),idx=get(p.indices),groups=new Map(),keys=[],coords=[];
  for(let i=0;i<pos.a.count;i++){const v=[pos.read(i,0),pos.read(i,1),pos.read(i,2)],key=v.map(n=>Math.round(n*1e5)).join(',');keys.push(key);coords.push(v);if(!groups.has(key))groups.set(key,[0,0,0]);}
  for(let i=0;i<idx.a.count;i+=3){const ids=[idx.read(i),idx.read(i+1),idx.read(i+2)],[a,b,c]=ids.map(n=>coords[n]),u=b.map((n,k)=>n-a[k]),v=c.map((n,k)=>n-a[k]),normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];for(const id of ids){const sum=groups.get(keys[id]);normal.forEach((n,k)=>sum[k]+=n);}}
  const normals=Buffer.alloc(pos.a.count*12);for(let i=0;i<pos.a.count;i++){const n=groups.get(keys[i]),length=Math.hypot(...n)||1;n.forEach((x,k)=>normals.writeFloatLE(x/length,i*12+k*4));}
  const offset=Math.ceil(output.length/4)*4,next=Buffer.alloc(offset+normals.length);output.copy(next);normals.copy(next,offset);output=next;
  const vi=j.bufferViews.length;j.bufferViews.push({buffer:0,byteOffset:offset,byteLength:normals.length,target:34962});p.attributes.NORMAL=j.accessors.length;j.accessors.push({bufferView:vi,componentType:5126,count:pos.a.count,type:'VEC3'});delete p.attributes.TANGENT;
 }
 // Keep Meshy's color artwork; use smooth geometric normals and a soft toy finish.
 for(const m of j.materials){delete m.normalTexture;delete m.pbrMetallicRoughness.metallicRoughnessTexture;m.pbrMetallicRoughness.metallicFactor=0;m.pbrMetallicRoughness.roughnessFactor=id==='pumpkin-lantern'?.65:.9;}
 j.buffers[0].byteLength=output.length;await fs.writeFile(dir+'/'+id+'-smooth.glb',packGlb(j,output));console.log(id,'smoothed, UV and color textures preserved');
}
