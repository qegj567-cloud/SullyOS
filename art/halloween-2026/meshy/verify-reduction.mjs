import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readGlb} from './glb-utils.mjs';
const dir='art/halloween-2026/meshy/reduced',manifest=JSON.parse(await fs.readFile(dir+'/manifest.json','utf8')),hash=b=>createHash('sha256').update(b).digest('hex');
for(const entry of manifest){
 assert.equal(hash(await fs.readFile(entry.source)),entry.sourceSha256,'Original source modified');
 const {json:j,bin}=await readGlb(dir+'/'+entry.file);let faces=0;
 for(const mesh of j.meshes)for(const p of mesh.primitives){const a=j.accessors[p.indices],v=j.bufferViews[a.bufferView],start=(v.byteOffset||0)+(a.byteOffset||0),count=j.accessors[p.attributes.POSITION].count;assert.equal(a.componentType,5125);assert.equal(a.count%3,0);faces+=a.count/3;
  for(let i=0;i<a.count;i++)assert.ok(bin.readUInt32LE(start+i*4)<count,'Out-of-range index');
  for(const ai of Object.values(p.attributes)){const attr=j.accessors[ai];assert.equal(attr.count,count);if(attr.componentType===5126){const view=j.bufferViews[attr.bufferView],n={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[attr.type],offset=(view.byteOffset||0)+(attr.byteOffset||0);for(let k=0;k<attr.count*n;k++)assert.ok(Number.isFinite(bin.readFloatLE(offset+k*4)));}}
 }
 assert.equal(faces,entry.triangles);assert.ok(faces<entry.originalTriangles);
 const imageHashes=j.images.map(image=>{const v=j.bufferViews[image.bufferView];return hash(bin.subarray(v.byteOffset||0,(v.byteOffset||0)+v.byteLength));});assert.deepEqual(imageHashes,entry.textureHashes,'Texture bytes changed');
 const {json:original,bin:originalBin}=await readGlb(entry.source),texture=original.materials[0].pbrMetallicRoughness.baseColorTexture.index,originalView=original.bufferViews[original.images[original.textures[texture].source].bufferView];assert.equal(imageHashes[0],hash(originalBin.subarray(originalView.byteOffset||0,(originalView.byteOffset||0)+originalView.byteLength)));
}
const targets={'pumpkin-costume':34000,'ghost-top':24000,'pumpkin-lantern':12000},selected=manifest.filter(r=>r.target===targets[r.id]).map(r=>({...r,status:'static front/side/back reviewed; fitting and animation pending'}));
await fs.writeFile(dir+'/selected.json',JSON.stringify(selected,null,2));console.log('PASS: '+manifest.length+' GLBs; indices, finite attributes, counts, original hashes and exact base-color texture bytes.');console.log(selected.map(r=>({id:r.id,triangles:r.triangles,reduction:r.reductionPercent})));
