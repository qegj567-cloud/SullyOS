import fs from 'node:fs/promises';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {mergeGeometries,mergeVertices} from 'three/addons/utils/BufferGeometryUtils.js';
import {MeshoptSimplifier} from 'three/addons/libs/meshopt_simplifier.module.js';
import {MeshBVH} from 'three-mesh-bvh';
import {sliceBands} from '../../chibi/clothing-import-utils.mjs';
import {readGeometry,splitParts,compactGeometry,saveGlb} from '../../jellyfish-home/asset-geometry.mjs';
const dir='art/halloween-2026/meshy';await fs.mkdir(dir+'/fitted',{recursive:true});
const colors={white:'#f9f1e7',purple:'#652197',orange:'#ff7212',black:'#211c2a',green:'#a4cf2c',gold:'#e8b747'};
const material=name=>new T.MeshStandardMaterial({name:'halloween_'+name,color:colors[name],roughness:.83,side:T.DoubleSide});
const smooth=T.MathUtils.smoothstep;
function clip(g,planes){
 const p=g.attributes.position,positions=[];
 for(let i=0;i<g.index.count;i+=3){let poly=[0,1,2].map(k=>new T.Vector3().fromBufferAttribute(p,g.index.getX(i+k)));
  for(const distance of planes){const cut=[];for(let k=0;k<poly.length;k++){const a=poly[k],b=poly[(k+1)%poly.length],da=distance(a),db=distance(b);if(da>=0)cut.push(a);if((da>=0)!==(db>=0))cut.push(a.clone().lerp(b,da/(da-db)));}poly=cut;if(!poly.length)break;}
  for(let k=1;k<poly.length-1;k++)for(const v of [poly[0],poly[k],poly[k+1]])positions.push(...v.toArray());
 }const result=new T.BufferGeometry();result.setAttribute('position',new T.Float32BufferAttribute(positions,3));return mergeVertices(result,1e-6);
}
async function body(){const b=await fs.readFile(dir+'/current-body.glb');return (await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene;}
const report=[];
for(const kind of ['ghost','pumpkin']){
 const [g]=await readGeometry(kind==='pumpkin'?dir+'/halloween-batch-02/pumpkin-costume-t2.glb':dir+'/halloween-batch-01/ghost-costume.glb'),parts=splitParts(g);
 const part=async index=>compactGeometry(g,parts[index].ids);
 const combine=async indices=>mergeGeometries(await Promise.all(indices.map(part)));
 const defs=[];
 if(kind==='ghost'){
  defs.push({id:'ghost-hood',label:'幽灵连帽上衣',slot:'top',limit:3950,geos:[{g:clip(await part(0),[v=>v.y+.103]),paint:v=>{
   const ax=Math.abs(v.x);
   if(v.y>.17)return 'white';
   if(v.y<-.055){const wave=.013*Math.cos(Math.atan2(v.z,v.x)*6);return v.y<-.087+wave?'purple':v.y<-.070+wave?'orange':'white';}
   if(ax>.275)return ax>.300?'purple':'orange';return 'white';
  }},{g:await combine([8,9]),paint:()=> 'purple'},{g:await part(5),paint:()=> 'orange'},{g:await combine([12,13,14,15,16]),paint:()=> 'black'}]});
  defs.push({id:'ghost-shorts',label:'幽灵装短裤',slot:'bottom',limit:2000,geos:[{g:clip(await part(0),[v=>-.101-v.y]),paint:()=> 'purple'}]});
  defs.push({id:'ghost-socks',label:'橙紫条纹长袜',slot:'socks',limit:1600,geos:[{g:clip(await part(1),[v=>v.y+.407,v=>-.168-v.y]),paint:v=>Math.floor((v.y+.407)/.028)%2?'purple':'orange'}]});
  defs.push({id:'ghost-shoes',label:'幽灵绿扣皮鞋',slot:'shoes',limit:2500,geos:[{g:clip(await part(1),[v=>-.407-v.y]),paint:()=> 'black'},{g:await combine([6,7]),paint:()=> 'green'}]});
 }else{
  const [detailed]=await readGeometry(dir+'/halloween-batch-01/pumpkin-costume.glb'),details=splitParts(detailed);
  const face=await compactGeometry(detailed,[8,14,15].flatMap(i=>details[i].ids));
  const faceTarget=new MeshBVH(await part(0),{indirect:true}),faceRay=new T.Ray();
  for(let i=0;i<face.attributes.position.count;i++){const p=face.attributes.position,x=p.getX(i),y=p.getY(i);faceRay.set(new T.Vector3(x,y,1),new T.Vector3(0,0,-1));const hit=faceTarget.raycastFirst(faceRay,T.DoubleSide);if(hit)p.setZ(i,Math.max(p.getZ(i),1-hit.distance+.002));}
  defs.push({id:'pumpkin-suit',label:'南瓜连体衣',slot:'onepiece',limit:3750,geos:[{g:await part(0),paint:v=>v.y<-.082?'purple':'orange'},
   {g:await combine([5,6]),paint:v=>Math.abs(v.x)>.286?'orange':'purple'},
   {g:await combine([19,20,23,24,25,27]),paint:()=> 'green'},
   {g:await combine([26,29,31,32,33,34,37]),paint:()=> 'purple'},
   {g:face,paint:()=> 'black'},{g:await part(7),paint:()=> 'purple'}]});
  defs.push({id:'pumpkin-socks',label:'橙黑条纹长袜',slot:'socks',limit:1500,geos:[{g:clip(await combine([11,12]),[v=>v.y+.383,v=>-.231-v.y]),paint:v=>Math.floor((v.y+.383)/.023)%2?'orange':'black'}]});
  defs.push({id:'pumpkin-boots',label:'南瓜叶扣短靴',slot:'shoes',limit:2600,geos:[{g:await combine([8,9]),paint:()=> 'black'},{g:await combine([14,15]),paint:()=> 'green'},{g:await combine([17,18,35,36]),paint:()=> 'purple'}]});
  defs.push({id:'pumpkin-hat',label:'南瓜贝雷帽',slot:'headwear',limit:2500,geos:[{g:await part(4),paint:()=> 'orange'},{g:await combine([13,16,21,22,30]),paint:()=> 'green'}]});
 }
 const allRoot=await body();let skin;allRoot.traverse(o=>{if(o.isSkinnedMesh)skin=o;});const sk=skin.skeleton,bp=skin.geometry.attributes.position,bi=skin.geometry.attributes.skinIndex,bw=skin.geometry.attributes.skinWeight;
 const bodyTree=new MeshBVH(skin.geometry.clone(),{indirect:true}),ray=new T.Ray();
 for(const def of defs){
  const sourceCount=def.geos.reduce((n,x)=>n+x.g.index.count/3,0),buckets={};
  for(const {g:original,paint}of def.geos){
   const budget=Math.max(10,Math.floor(def.limit*(original.index.count/3)/sourceCount));
   await MeshoptSimplifier.ready;
   let indices=new Uint32Array(original.index.array);
   if(indices.length>budget*3)[indices]=MeshoptSimplifier.simplify(indices,original.attributes.position.array,3,budget*3,.04);
   let geo=await compactGeometry(original,Array.from(indices));
   if(def.slot==='socks')geo=sliceBands(geo,Array.from({length:12},(_,i)=>kind==='ghost'?-.407+i*.028:-.383+i*.023));
   if(def.id==='pumpkin-suit')geo=sliceBands(geo,[-.082]);
   if(def.id==='ghost-hood'){
    // Split faces at painted borders so large triangles never make a sawtooth.
    const surfaces=[v=>v.x-.275,v=>v.x-.300,v=>v.x+.275,v=>v.x+.300,
     v=>v.y+.087-.013*Math.cos(Math.atan2(v.z,v.x)*6),v=>v.y+.070-.013*Math.cos(Math.atan2(v.z,v.x)*6)];
    for(const f of surfaces)geo=mergeGeometries([clip(geo,[f]),clip(geo,[v=>-f(v)])]);
   }
   const p=geo.attributes.position;
   for(let i=0;i<geo.index.count;i+=3){const ids=[0,1,2].map(k=>geo.index.getX(i+k)),v=new T.Vector3();for(const id of ids)v.add(new T.Vector3().fromBufferAttribute(p,id));v.divideScalar(3);const name=paint(v);(buckets[name]??=[]).push(...ids.map(id=>new T.Vector3().fromBufferAttribute(p,id)));}
  }
  const nodes=[];
  for(const [name,vertices]of Object.entries(buckets)){
   const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(vertices.flatMap(v=>v.toArray()),3));const clean=mergeVertices(geo,1e-6),p=clean.attributes.position;
   for(let i=0;i<p.count;i++){
    let x=p.getX(i),y=p.getY(i),z=p.getZ(i);const head=smooth(y,.16,.23);
    x*=5.3*(1+.12*head);z*=5.3*(1+.09*head);y=kind==='pumpkin'?(y+.5)*5+.02:(y+.475)*5.3+.02;
    if(kind==='pumpkin'&&Math.abs(x)>.65&&y>2.9&&y<3.6)y+=3.125-((.12+.5)*5+.02);
    // Source feet are narrower than the current straight-legged doll.
    if(['socks','shoes'].includes(def.slot)){const side=Math.sign(x)||1;x=side*.260+(x-side*(kind==='ghost'?.197:.265))*1.2;z*=1.28;}
    // Fit existing source surfaces radially to the real mannequin. Preserve
    // wider cloth; only push actual intersections out by a small clearance.
    let origin;
    if(['socks','shoes'].includes(def.slot))origin=new T.Vector3(Math.sign(x)*.260,y,.04);
    else if(y>2.8&&y<3.65&&Math.abs(x)>.45)origin=new T.Vector3(x,3.125,.0);
    else if(y<2.1&&def.slot==='bottom')origin=new T.Vector3(Math.sign(x)*.260,y,.04);
    else if(y>2.8&&y<3.4&&['top','onepiece'].includes(def.slot))origin=new T.Vector3(0,y,0);
    if(origin){const point=new T.Vector3(x,y,z),delta=point.clone().sub(origin),r=delta.length();if(r>.00001){ray.set(origin,delta.divideScalar(r));const hit=bodyTree.raycastFirst(ray,T.DoubleSide);if(hit&&hit.distance<1&&r<hit.distance+.05)point.copy(origin).addScaledVector(ray.direction,hit.distance+.05);[x,y,z]=point.toArray();}}
    p.setXYZ(i,x,y,z);
   }
   clean.computeVertexNormals();const joints=[],weights=[];
   for(let i=0;i<p.count;i++){
    const x=p.getX(i),y=p.getY(i),z=p.getZ(i);let list;
    if(def.slot==='headwear')list=[[sk.bones.findIndex(b=>b.name==='head'),1]];
    else {
     const near=[];for(let v=0;v<bp.count;v++){
      if((def.slot==='socks'||def.slot==='shoes'||y<1.95)&&Math.sign(x)!==Math.sign(bp.getX(v)))continue;
      if(def.id==='ghost-hood'&&y>3.45&&bp.getY(v)<3.4)continue;
      const d=(x-bp.getX(v))**2+(y-bp.getY(v))**2+(z-bp.getZ(v))**2;let at=near.findIndex(q=>d<q.d);if(at<0)at=near.length;if(at<4){near.splice(at,0,{v,d});near.length=Math.min(4,near.length);}
     }
     const map=new Map();for(const {v,d}of near)for(let n=0;n<4;n++){let joint=bi.getComponent(v,n);const bone=sk.bones[joint].name;if(/_(thumb|index|middle|ring|pinky)/.test(bone))joint=sk.bones.findIndex(b=>b.name===bone[0]+'_hand');const w=bw.getComponent(v,n)/Math.max(.00001,d);map.set(joint,(map.get(joint)||0)+w);}list=[...map].filter(([,w])=>w>0).sort((a,b)=>b[1]-a[1]).slice(0,4);
    }
    const total=list.reduce((n,[,w])=>n+w,0);if(!total)throw Error('Missing skin weights');for(let n=0;n<4;n++){joints.push(list[n]?.[0]??0);weights.push((list[n]?.[1]??0)/total);}
   }
   clean.setAttribute('skinIndex',new T.Uint16BufferAttribute(joints,4));clean.setAttribute('skinWeight',new T.Float32BufferAttribute(weights,4));
   const mesh=new T.SkinnedMesh(clean,material(name));mesh.name='Halloween_'+def.id+'_'+name;allRoot.add(mesh);mesh.bind(sk,skin.bindMatrix);nodes.push(mesh);
  }
  const triangles=nodes.reduce((n,x)=>n+x.geometry.index.count/3,0),bounds=new T.Box3();nodes.forEach(n=>{n.geometry.computeBoundingBox();bounds.union(n.geometry.boundingBox);});
  const only=new T.Group();nodes.forEach(n=>{const g=n.geometry.clone();g.deleteAttribute('skinIndex');g.deleteAttribute('skinWeight');const m=new T.Mesh(g,n.material);m.name=n.name;only.add(m);});await saveGlb(only,dir+'/fitted/'+def.id+'-only.glb');
  report.push({id:'halloween-'+def.id,label:def.label,slot:def.slot,prefix:'Halloween_'+def.id+'_',asset:kind+'-fitted.glb',triangles,sourceTriangles:sourceCount,hem:bounds.min.y,...(def.slot==='shoes'?{opening:kind==='ghost'?.38:.60}:{}),status:'fitting-candidate'});
 }
 await saveGlb(allRoot,dir+'/fitted/'+kind+'-fitted.glb');
}
await fs.writeFile(dir+'/fitted/manifest.json',JSON.stringify(report,null,2));console.log(report.map(x=>({id:x.id,triangles:x.triangles})));
