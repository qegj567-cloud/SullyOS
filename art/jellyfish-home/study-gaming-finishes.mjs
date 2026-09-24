// Register optional per-part paint controls without changing other rooms' instances.
import fs from 'node:fs/promises';
const c=JSON.parse(await fs.readFile('public/room3d/catalog.json','utf8'));
const finishes={'gaming-shell':['奶油外壳','#eee3cf'],'gaming-graphite':['暖炭黑框','#45463c'],'gaming-metal':['暖灰金属','#96947f'],'gaming-rubber':['深色软垫','#363a31'],'gaming-screen':['屏幕底色','#4c6051'],'gaming-mint':['浅绿细节','#a3ad88'],'gaming-led':['柔和灯条','#dfd8b3']};
for(const a of c.filter(a=>a.collection==='gaming'&&a.id.startsWith('gaming_'))){
 const b=await fs.readFile('public/room3d/'+a.url),g=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)).toString()),names=new Set(g.materials.map(m=>m.name));
 a.colorParts=(a.colorParts||[]).filter(p=>!finishes[p.material]);
 for(const [material,[label,color]]of Object.entries(finishes))if(names.has(material))a.colorParts.push({material,label,color});
}
await fs.writeFile('public/room3d/catalog.json',JSON.stringify(c,null,2)+'\n');
