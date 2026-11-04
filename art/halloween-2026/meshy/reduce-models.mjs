import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MeshoptSimplifier} from 'three/addons/libs/meshopt_simplifier.module.js';
import {readGlb,packGlb} from './glb-utils.mjs';
const dir='art/halloween-2026/meshy',out=dir+'/reduced';await fs.mkdir(out,{recursive:true});await MeshoptSimplifier.ready;
const config=process.argv[2]?JSON.parse(await fs.readFile(process.argv[2],'utf8')):null;
const specs=config?.specs||[['pumpkin-costume',[45000,34000,30000]],['ghost-top',[32000,24000,14000]],['pumpkin-lantern',[15000,12000,10000]]],report=[];
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const [id,targets]of specs){
 const file=dir+'/'+(config?.batch||'halloween-batch-04-texture')+'/'+id+'-smooth.glb',raw=await fs.readFile(file),{json:source,bin}=await readGlb(file);
 const read=ai=>{const a=source.accessors[ai],v=source.bufferViews[a.bufferView],size={5126:4,5125:4,5123:2,5121:1}[a.componentType],n={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];if(a.sparse||!size||!n)throw Error('Unsupported accessor');const array=new ({5126:Float32Array,5125:Uint32Array,5123:Uint16Array,5121:Uint8Array}[a.componentType])(a.count*n),start=(v.byteOffset||0)+(a.byteOffset||0),stride=v.byteStride||size*n;for(let i=0;i<a.count;i++)for(let k=0;k<n;k++){const offset=start+i*stride+k*size;array[i*n+k]=a.componentType===5126?bin.readFloatLE(offset):size===4?bin.readUInt32LE(offset):size===2?bin.readUInt16LE(offset):bin[offset];}return {array,n,accessor:a};};
 const primitives=source.meshes.flatMap(m=>m.primitives),before=primitives.reduce((n,p)=>n+source.accessors[p.indices].count/3,0);
 if(source.skins?.length||primitives.some(p=>p.targets))throw Error('This pass is only for the unrigged generation sources');
 for(const target of targets){
  const j=structuredClone(source),chunks=[];let length=0,faces=0,vertices=0,maxError=0;j.bufferViews=[];j.accessors=[];
  function append(bytes,target){const pad=(4-length%4)%4;if(pad){chunks.push(Buffer.alloc(pad));length+=pad;}const index=j.bufferViews.length;j.bufferViews.push({buffer:0,byteOffset:length,byteLength:bytes.length,...(target?{target}:{})});chunks.push(bytes);length+=bytes.length;return index;}
  function accessor(array,n,template,target){const a={...template,bufferView:append(Buffer.from(array.buffer,array.byteOffset,array.byteLength),target),byteOffset:0,count:array.length/n};delete a.min;delete a.max;delete a.sparse;if(template.type==='VEC3'&&target===34962){a.min=Array.from({length:3},(_,k)=>{let value=Infinity;for(let i=k;i<array.length;i+=3)value=Math.min(value,array[i]);return value;});a.max=Array.from({length:3},(_,k)=>{let value=-Infinity;for(let i=k;i<array.length;i+=3)value=Math.max(value,array[i]);return value;});}j.accessors.push(a);return j.accessors.length-1;}
  for(let mi=0;mi<source.meshes.length;mi++)for(let pi=0;pi<source.meshes[mi].primitives.length;pi++){
   const p=source.meshes[mi].primitives[pi],dest=j.meshes[mi].primitives[pi],attributes=Object.fromEntries(Object.entries(p.attributes).map(([k,v])=>[k,read(v)])),positions=attributes.POSITION.array,uv=attributes.TEXCOORD_0.array,normals=attributes.NORMAL.array,indices=new Uint32Array(read(p.indices).array),packed=new Float32Array(positions.length/3*5);
   for(let i=0;i<positions.length/3;i++)packed.set([normals[i*3],normals[i*3+1],normals[i*3+2],uv[i*2],uv[i*2+1]],i*5);
   // Freeze atlas seam vertices: sliding a seam can sample a neighboring atlas island.
   const coincident=new Map(),lock=new Uint8Array(positions.length/3);
   for(let i=0;i<lock.length;i++){const key=[0,1,2].map(k=>Math.round(positions[i*3+k]*1e5)).join(',');if(!coincident.has(key))coincident.set(key,[]);coincident.get(key).push(i);}
   for(const ids of coincident.values()){const first=ids[0];if(ids.some(i=>Math.abs(uv[i*2]-uv[first*2])+Math.abs(uv[i*2+1]-uv[first*2+1])>1e-6))for(const i of ids)lock[i]=1;}
   const desired=Math.max(1,Math.floor(target*(indices.length/3)/before));
   const [reduced,error]=MeshoptSimplifier.simplifyWithAttributes(indices,positions,3,packed,5,[.5,.5,.5,10,10],lock,Math.min(indices.length,desired*3),.005,['LockBorder']);
   const remap=new Map(),used=[],newIndices=new Uint32Array(reduced.length);for(let i=0;i<reduced.length;i++){const old=reduced[i];if(!remap.has(old)){remap.set(old,used.length);used.push(old);}newIndices[i]=remap.get(old);}
   dest.attributes={};for(const [name,{array,n,accessor:a}]of Object.entries(attributes)){const compact=new array.constructor(used.length*n);used.forEach((old,i)=>compact.set(array.subarray(old*n,old*n+n),i*n));dest.attributes[name]=accessor(compact,n,a,34962);}
   dest.indices=accessor(newIndices,1,{componentType:5125,type:'SCALAR'},34963);faces+=newIndices.length/3;vertices+=used.length;maxError=Math.max(maxError,error);
  }
  // Retain active texture bytes verbatim; discard unused maps left by the soft-material pass.
  const usedTextures=new Set();function visit(o){if(!o||typeof o!=='object')return;for(const [key,v]of Object.entries(o)){if(key.endsWith('Texture')&&v?.index!==undefined)usedTextures.add(v.index);else visit(v);}}visit(j.materials);
  const textureMap=new Map(),imageMap=new Map(),images=[],textures=[],textureHashes=[];
  for(const old of usedTextures){const tex=structuredClone(source.textures[old]);if(!imageMap.has(tex.source)){const image=source.images[tex.source];if(image.uri)throw Error('Expected embedded texture');const v=source.bufferViews[image.bufferView],bytes=bin.subarray(v.byteOffset||0,(v.byteOffset||0)+v.byteLength);imageMap.set(tex.source,images.length);images.push({...image,bufferView:append(bytes)});textureHashes.push(hash(bytes));}tex.source=imageMap.get(tex.source);textureMap.set(old,textures.length);textures.push(tex);}
  function remapTextures(o){if(!o||typeof o!=='object')return;for(const [key,v]of Object.entries(o)){if(key.endsWith('Texture')&&v?.index!==undefined)v.index=textureMap.get(v.index);else remapTextures(v);}}remapTextures(j.materials);j.images=images;j.textures=textures;j.buffers=[{byteLength:length}];
  const output=packGlb(j,Buffer.concat(chunks)),name=id+'-'+target+'.glb';await fs.writeFile(out+'/'+name,output);
  const entry={id,file:name,source:file,sourceSha256:hash(raw),target,triangles:faces,originalTriangles:before,reductionPercent:Number(((1-faces/before)*100).toFixed(1)),vertices,maxAttributeAwareError:maxError,bytes:output.length,originalBytes:raw.length,textureHashes,positionsAndUVs:'retained source vertices; no texture resampling',status:'visual-comparison'};report.push(entry);console.log({id,target,faces,reduction:entry.reductionPercent,mb:(output.length/1048576).toFixed(2)});
 }
}
await fs.writeFile(out+'/'+(config?.report||'manifest.json'),JSON.stringify(report,null,2));
