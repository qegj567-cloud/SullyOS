import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {packGlb} from './glb-utils.mjs';
const require=createRequire(new URL('../../../tmp/halloween-compress/package.json',import.meta.url));
const {NodeIO,PropertyType}=require('@gltf-transform/core');
const {ALL_EXTENSIONS,EXTMeshoptCompression}=require('@gltf-transform/extensions');
const {weld,quantize,prune}=require('@gltf-transform/functions');
const {MeshoptEncoder,MeshoptDecoder}=require('meshoptimizer');
await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready]);
const base='art/halloween-2026/meshy',dest=base+'/wardrobe-compressed-items';
await fs.mkdir(dest,{recursive:true});
const manifest=base+'/wardrobe-source-manifest.json';
try{await fs.access(manifest);}catch{await fs.copyFile(base+'/published-wardrobe.json',manifest);}
const defs=JSON.parse(await fs.readFile(manifest,'utf8'));
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder});
const report=[];const textures=new Map();
for(const def of defs){
 const doc=await io.read(base+'/wardrobe-texture-small/'+def.asset);
 for(const node of doc.getRoot().listNodes())if(node.getMesh()&&!node.getName().startsWith(def.prefix))node.setMesh(null).setSkin(null);
 await doc.transform(prune({propertyTypes:[PropertyType.MESH,PropertyType.PRIMITIVE,PropertyType.PRIMITIVE_TARGET,PropertyType.SKIN,PropertyType.ACCESSOR]}));
 for(const mesh of doc.getRoot().listMeshes())for(const p of mesh.listPrimitives()){
  const values=p.getAttribute('POSITION')?.getArray();
  if(values)for(let i=0;i<values.length;i++)values[i]=Math.round(values[i]*65536)/65536;
 }
 await doc.transform(weld(),quantize({pattern:/^(NORMAL|TEXCOORD_)/,quantizeNormal:12,quantizeTexcoord:14,normalizeWeights:false,cleanup:false}),prune({propertyTypes:[PropertyType.ACCESSOR]}));
 doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.QUANTIZE});
 const raw=Buffer.from(await io.writeBinary(doc)),jsonLength=raw.readUInt32LE(12),j=JSON.parse(raw.subarray(20,20+jsonLength)),bin=raw.subarray(28+jsonLength);
 const ranges=[],removedViews=new Set(),shared=[];
 for(const image of j.images??[]){
  const v=j.bufferViews[image.bufferView];if(v.byteLength<1024)continue;
  const data=bin.subarray(v.byteOffset,v.byteOffset+v.byteLength),hash=createHash('sha256').update(data).digest('hex').slice(0,12),file=`halloween-texture-${hash}.jpg`;
  await fs.writeFile(dest+'/'+file,data);textures.set(file,data.length);shared.push(file);
  ranges.push([v.byteOffset,(v.byteOffset+v.byteLength+3)&~3]);removedViews.add(image.bufferView);delete image.bufferView;image.uri=file;
 }
 ranges.sort((a,b)=>a[0]-b[0]);
 const offset=value=>value-ranges.reduce((sum,[a,b])=>sum+(b<=value?b-a:0),0);
 const chunks=[];let cursor=0;for(const[a,b]of ranges){chunks.push(bin.subarray(cursor,a));cursor=b;}chunks.push(bin.subarray(cursor));const compact=Buffer.concat(chunks);
 const remap=new Map();j.bufferViews=j.bufferViews.filter((v,i)=>{if(removedViews.has(i))return false;remap.set(i,remap.size);return true;});
 function rewrite(object){if(!object||typeof object!=='object')return;if(object.buffer===0&&typeof object.byteOffset==='number')object.byteOffset=offset(object.byteOffset);if(typeof object.bufferView==='number')object.bufferView=remap.get(object.bufferView);for(const value of Object.values(object))rewrite(value);}
 rewrite(j);j.buffers[0].byteLength=compact.length;
 const out=packGlb(j,compact),file=def.id+'.glb';await fs.writeFile(dest+'/'+file,out);
 const record={id:def.id,label:def.label,file,bytes:out.length,sharedTextures:shared,triangles:j.meshes.reduce((s,m)=>s+m.primitives.reduce((s,p)=>s+j.accessors[p.indices].count/3,0),0),revision:createHash('sha256').update(out).digest('hex').slice(0,12)};report.push(record);console.log(record.label,record.bytes);
}
await fs.writeFile(base+'/wardrobe-item-compression-report.json',JSON.stringify({items:report,textures:[...textures].map(([file,bytes])=>({file,bytes})),totalBytes:report.reduce((s,r)=>s+r.bytes,0)+[...textures.values()].reduce((s,n)=>s+n,0)},null,2));
