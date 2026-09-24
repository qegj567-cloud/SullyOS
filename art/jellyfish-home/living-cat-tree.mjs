import fs from 'node:fs/promises';import * as T from 'three';import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';import {readGeometry,splitParts,compactGeometry,saveGlb} from './asset-geometry.mjs';
const src=process.argv[2]||'art/jellyfish-home/sources/showrooms/living-collection-geometry.glb';const [g]=await readGeometry(src),parts=splitParts(g).filter(p=>p.box.min.y>-.005&&p.box.min.z>.07&&p.box.max.x<-.26);if(!parts.length)throw Error('No cat tree geometry');
const mats={cream:new T.MeshStandardMaterial({color:'#eee3ce',roughness:.93}),sage:new T.MeshStandardMaterial({color:'#858d67',roughness:.95}),rope:new T.MeshStandardMaterial({color:'#ccb697',roughness:1})};for(const [name,m]of Object.entries(mats))m.name=name;
const source=new T.Group(),batches={cream:[],sage:[],rope:[]};
// The upper tray and middle perch were one fused triangular web. Replace that
// entire component with closed perches, keeping the original separate posts.
const fused=parts.find(p=>p.box.min.y>.23&&p.box.max.y<.38&&p.box.getSize(new T.Vector3()).z>.18);
if(!fused)throw Error('Expected fused upper perch component');
batches.cream=[];batches.sage=[];batches.rope=[];
for(const p of parts.filter(p=>p!==fused)){
 const s=p.box.getSize(new T.Vector3()),mat=s.y>.09&&s.x<.045?'rope':s.y<.038&&p.center.y>.09?'sage':'cream';
 batches[mat].push(await compactGeometry(g,p.ids));
}
const perch=new T.CylinderGeometry(1,1,.018,24);perch.scale(.067,1,.064);perch.translate(-.438,.244,.25);perch.deleteAttribute('uv');batches.cream.push(perch);
const pad=new T.CylinderGeometry(1,1,.006,24);pad.scale(.058,1,.055);pad.translate(-.438,.256,.25);pad.deleteAttribute('uv');batches.sage.push(pad);
const bowl=new T.LatheGeometry([[0,.344],[.047,.344],[.064,.351],[.066,.372],[.060,.378],[.055,.371],[.054,.355],[0,.355]].map(p=>new T.Vector2(...p)),24);bowl.translate(-.433,0,.174);bowl.deleteAttribute('uv');batches.cream.push(bowl);
for(const [name,gs]of Object.entries(batches))if(gs.length){for(const g of gs)g.deleteAttribute('normal');const merged=mergeGeometries(gs);merged.computeVertexNormals();source.add(new T.Mesh(merged,mats[name]));}
const box=new T.Box3().setFromObject(source),size=box.getSize(new T.Vector3()),c=box.getCenter(new T.Vector3()),scale=2.15/size.y;
for(const m of source.children)m.geometry.translate(-c.x,-box.min.y,-c.z).scale(scale,scale,scale);
const finalSize=new T.Box3().setFromObject(source).getSize(new T.Vector3()).toArray(),triangles=source.children.reduce((n,m)=>n+m.geometry.index.count/3,0);if(triangles>=4000)throw Error('Over budget');
await fs.mkdir('art/jellyfish-home/sources/showrooms',{recursive:true});await saveGlb(source,'art/jellyfish-home/sources/showrooms/living-cat-tree-geometry.glb');await saveGlb(source,'public/room3d/living_ref_cat_tree.glb');const cat=JSON.parse(await fs.readFile('public/room3d/catalog.json','utf8'));const asset={id:'living_ref_cat_tree',name:'鼠尾草软垫猫爬架',surface:'floor',collection:'living',url:'living_ref_cat_tree.glb',revision:'sage-cat-2',size:finalSize,default:[0,.15,0],boxes:[[-finalSize[0]/2,0,-finalSize[2]/2,finalSize[0]/2,finalSize[1],finalSize[2]/2]],paintMaterials:['cream'],colorParts:[{material:'sage',label:'软垫',color:'#858d67'},{material:'rope',label:'绳柱',color:'#ccb697'}]};const ix=cat.findIndex(a=>a.id===asset.id);if(ix<0)cat.push(asset);else cat[ix]=asset;await fs.writeFile('public/room3d/catalog.json',JSON.stringify(cat,null,2)+'\n');console.log({parts:parts.length,triangles,size:finalSize});

