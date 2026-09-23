import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import * as T from 'three';
import {mergeGeometries,mergeVertices,toCreasedNormals} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {readGeometry,splitParts,compactGeometry,saveGlb} from './asset-geometry.mjs';
const g=mergeGeometries(await readGeometry('art/jellyfish-home/sources/kitchenware/geometry.glb')),parts=splitParts(g);
const catalog=JSON.parse(await fs.readFile('public/room3d/catalog.json','utf8')),report=[];
const mat=(name,color,roughness=.8)=>Object.assign(new T.MeshStandardMaterial({color,roughness}),{name});
const white=mat('porcelain','#eeeeec'),black=mat('charcoal','#292c30'),metal=mat('steel','#a0a6ac',.4),wood=mat('woodLight','#ffffff'),bread=mat('bread','#c2a47a'),crumb=mat('crumb','#e8d4ab');
wood.color.setRGB(.8227857351303101,.5972017645835876,.3915724754333496);
async function extract(ids,paint,width){
 const root=new T.Group();for(const id of ids){const p=parts.find(p=>p.id===id);assert.ok(p,'missing source part '+id);let geo=await compactGeometry(g,p.ids);geo=mergeVertices(toCreasedNormals(geo,Math.PI/3));root.add(new T.Mesh(geo,paint(id)));}
 const b=new T.Box3().setFromObject(root),c=b.getCenter(new T.Vector3()),scale=width/(b.max.x-b.min.x);
 for(const o of root.children)o.geometry.translate(-c.x,-b.min.y,-c.z).scale(scale,scale,scale);
 return root;
}
async function emit(id,name,root,surface='tabletop'){
 root.updateMatrixWorld(true);const buckets=new Map();root.traverse(o=>{if(!o.isMesh)return;const geo=o.geometry.clone().applyMatrix4(o.matrixWorld);geo.deleteAttribute('uv');geo.deleteAttribute('color');if(!buckets.has(o.material))buckets.set(o.material,[]);buckets.get(o.material).push(geo);});
 const clean=new T.Group();for(const [m,gs]of buckets)clean.add(new T.Mesh(mergeGeometries(gs),m));
 const b=new T.Box3().setFromObject(clean),c=b.getCenter(new T.Vector3()),s=b.getSize(new T.Vector3());for(const o of clean.children)o.geometry.translate(-c.x,-b.min.y,-c.z);
 const triangles=clean.children.reduce((n,o)=>n+o.geometry.index.count/3,0);assert.ok(triangles<4000);
 const a={id,name,surface,collection:'kitchen',url:id+'.glb',size:s.toArray(),default:[0,surface==='wall'?2:.15,0],boxes:[[-s.x/2,0,-s.z/2,s.x/2,s.y,s.z/2]],paintMaterials:[buckets.has(white)?white.name:buckets.has(black)?black.name:wood.name],revision:'kitchenware-1'};
 const index=catalog.findIndex(a=>a.id===id);if(index<0)catalog.push(a);else catalog[index]=a;
 const bytes=await saveGlb(clean,'public/room3d/'+a.url);report.push({id,triangles,bytes,size:s.toArray()});
}
await emit('kitchenware_pot','黑白双耳汤锅',await extract([2566,2551,2590,502],id=>id===2566?white:black,.62));
await emit('kitchenware_board','砧板与切片面包',await extract([2542,2626,2043],id=>id===2542?wood:id===2626?bread:crumb,.58));
await emit('kitchenware_tools','黑陶厨具筒',await extract([2980,2986,3026],id=>id===2986?black:metal,.32));
await emit('kitchenware_spices','黑白调料罐组',await extract([3406,4114,1570,4068,3046,877,1598],id=>[4068,877,1598].includes(id)?black:white,.7));
await emit('kitchenware_plates','白瓷叠盘',await extract([2538,2546,477],()=>white,.42));
await emit('kitchenware_rail','金属挂杆与锅铲',await extract([4088,4190,4202,1610,1641,1726,4429],id=>id===4429?black:metal,1.05),'wall');
// Two settings form one small movable serving set, preserving full source cups
// and plate meshes. No table/cabinet is included in these assets.
const settings=new T.Group();
for(const x of [-.3,.3]){
 const plate=await extract([477],()=>white,.42);plate.position.set(x,0,.1);settings.add(plate);
 const cup=await extract([2832,2893],()=>black,.22);cup.position.set(x,0,-.22);settings.add(cup);
}
await emit('kitchenware_settings','双人白瓷杯盘',settings);
const coffee=new T.Group();
const machine=await extract([3689,4616,3732,3698,4615,4600,4604],id=>[3689,3732].includes(id)?white:id===3698?metal:black,.38);
machine.position.x=-.42;coffee.add(machine);
const saucers=await extract([2538,2546,477],()=>white,.35);saucers.position.set(.32,0,.02);coffee.add(saucers);
const spareCup=await extract([2832,2893],()=>white,.2);spareCup.position.set(.72,0,.05);coffee.add(spareCup);
await emit('kitchenware_coffee','咖啡机与杯碟',coffee);
// Counter height was ray-checked against the original top (1.15). Support only
// the two dry worktops; the sink and faucet in the middle cannot hold props.
catalog.find(a=>a.id==='show_kitchen_counter').support={shape:'rect',width:1.65,depth:.78,height:1.15,center:[-1.5,0],areas:[{shape:'rect',width:1.65,depth:.78,height:1.15,center:[1.5,0]}]};
catalog.find(a=>a.id==='show_kitchen_range').support={shape:'rect',width:1.63,depth:.84,height:1.181};
await fs.writeFile('public/room3d/catalog.json',JSON.stringify(catalog,null,2)+'\n');
await fs.writeFile('art/jellyfish-home/sources/kitchenware/report.json',JSON.stringify(report,null,2)+'\n');console.log(report);
