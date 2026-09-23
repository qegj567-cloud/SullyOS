import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import * as T from 'three';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {saveGlb} from './asset-geometry.mjs';
// Replace the torn room-extraction mesh, not just cover its protruding scraps.
// Preserve footprint, support height, IDs and all per-instance paint targets.
const catalog=JSON.parse(await fs.readFile('public/room3d/catalog.json','utf8'));
const a=catalog.find(a=>a.id==='show_bedroom_dresser');
const [w,h,d]=a.size,groups=new Map();
const cream=new T.MeshStandardMaterial({color:'#e9e0d2',roughness:.83});cream.name='showroom-cream';
const wood=new T.MeshStandardMaterial({roughness:.83});wood.name='woodLight';wood.color.setRGB(.8227857351303101,.5972017645835876,.3915724754333496);
const ink=new T.MeshStandardMaterial({color:'#34303a',roughness:.83});ink.name='showroom-charcoal';
function box(x,y,z,sx,sy,sz,m){const g=new T.BoxGeometry(sx,sy,sz);g.deleteAttribute('uv');g.translate(x,y,z);if(!groups.has(m))groups.set(m,[]);groups.get(m).push(g);}
box(0,(h-.07)/2,-.03,w-.04,h-.07,d-.10,cream);
for(const side of [-1,1])box(side*(w/2-.045),(h-.07)/2,0,.05,h-.07,d-.06,cream);
box(0,h-.035,0,w,.07,d,wood);
box(0,.035,0,w-.16,.07,d-.14,ink);
for(let col=0;col<2;col++)for(let row=0;row<3;row++){
 const pw=(w-.12)/2-.018,ph=(h-.19)/3-.018,x=(col-.5)*(pw+.018),y=.07+(row+.5)*(ph+.018);
 box(x,y,d/2-.045,pw,ph,.028,cream);
 box(x,y+ph*.29,d/2-.0175,.23,.032,.035,ink);
}
const root=new T.Group();for(const [m,gs]of groups)root.add(new T.Mesh(mergeGeometries(gs),m));
const triangles=root.children.reduce((n,o)=>n+o.geometry.index.count/3,0);assert.equal(triangles,204);
const bounds=new T.Box3().setFromObject(root),size=bounds.getSize(new T.Vector3());
for(let i=0;i<3;i++)assert.ok(Math.abs(size.getComponent(i)-a.size[i])<.00001);
assert.ok(Math.abs(bounds.min.y)<.00001);
const bytes=await saveGlb(root,'public/room3d/'+a.url);a.revision='dresser-solid-panels-1';
await fs.writeFile('public/room3d/catalog.json',JSON.stringify(catalog,null,2)+'\n');
console.log({id:a.id,triangles,bytes,size:a.size,support:a.support});
