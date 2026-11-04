import fs from 'node:fs/promises';
export async function readGlb(file){
 const b=await fs.readFile(file),length=b.readUInt32LE(12),json=JSON.parse(b.subarray(20,20+length));
 return {json,bin:b.subarray(28+length)};
}
export function packGlb(json,bin){
 const text=Buffer.from(JSON.stringify(json)),jl=Math.ceil(text.length/4)*4,bl=Math.ceil(bin.length/4)*4,out=Buffer.alloc(28+jl+bl);
 out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(jl,12);out.writeUInt32LE(0x4e4f534a,16);out.fill(32,20,20+jl);text.copy(out,20);out.writeUInt32LE(bl,20+jl);out.writeUInt32LE(0x004e4942,24+jl);bin.copy(out,28+jl);return out;
}
export function stripImages(json){
 json.images=[];json.textures=[];json.materials=[{pbrMetallicRoughness:{baseColorFactor:[.8,.8,.8,1],metallicFactor:0,roughnessFactor:1}}];
 for(const m of json.meshes)for(const p of m.primitives)p.material=0;
 return json;
}
