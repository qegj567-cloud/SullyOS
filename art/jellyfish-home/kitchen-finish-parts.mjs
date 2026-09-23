import fs from 'node:fs/promises';
import {KITCHEN_MATERIAL_COLORS} from '../../apps/room3d/showroomGroups.js';
const catalog=JSON.parse(await fs.readFile('public/room3d/catalog.json','utf8'));
const labels={woodLight:'台面饰面','showroom-charcoal':'黑色面板','showroom-blue':'水槽','showroom-stone':'金属配件','kitchen-cream':'浅色配件','kitchen-dark':'深色配件','kitchen-ceramic':'顶饰','kitchen-pink':'门贴','kitchen-fruit':'小装饰','kitchen-metal':'金属把手'};
for(const [id,colors]of Object.entries(KITCHEN_MATERIAL_COLORS)){
 const a=catalog.find(a=>a.id===id),b=await fs.readFile('public/room3d/'+a.url),g=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)));
 const parts=new Map((a.colorParts||[]).map(p=>[p.material,p]));
 for(const name of Object.keys(colors)){
  if(!g.materials.some(m=>m.name===name))throw Error(id+' missing '+name);
  // Register existing material names for validated per-instance overrides.
  parts.set(name,{material:name,label:labels[name]||name,color:colors[name]});
 }
 a.colorParts=[...parts.values()];
}
await fs.writeFile('public/room3d/catalog.json',JSON.stringify(catalog,null,2)+'\n');
