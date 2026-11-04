import fs from 'node:fs/promises';
import * as T from 'three';
import {readGeometry,compactGeometry,saveGlb} from '../../jellyfish-home/asset-geometry.mjs';
const source='art/halloween-2026/interactions',dest='public/room3d/props/halloween';
await fs.mkdir(dest,{recursive:true});
const report=[];
for(const [id,size,budget] of [['pumpkin-pail',.43,2600],['wrapped-candy',.16,900],['little-ghost',.38,1900]]){
 const geometries=await readGeometry(`${source}/${id}-source.glb`),root=new T.Group(),box=new T.Box3();
 geometries.forEach(g=>{g.computeBoundingBox();box.union(g.boundingBox);});
 const extent=box.getSize(new T.Vector3()),center=box.getCenter(new T.Vector3()),scale=size/Math.max(...extent.toArray());
 const total=geometries.reduce((n,g)=>n+g.index.count/3,0);let triangles=0;
 for(const original of geometries){
  const g=await compactGeometry(original,Array.from(original.index.array),Math.floor(budget*original.index.count/3/total));
  g.translate(-center.x,-center.y,-center.z).scale(scale,scale,scale);
  const p=g.attributes.position,colors=[];
  for(let i=0;i<p.count;i++){
   const x=p.getX(i),y=p.getY(i),z=p.getZ(i);let color;
   if(id==='pumpkin-pail')color=y>extent.y*scale*.13?'#343026':'#f98c29';
   else if(id==='wrapped-candy')color=Math.abs(x)>extent.x*scale*.26?'#f8d76d':'#c28ae3';
   else color='#fff5da';
   const c=new T.Color(color);colors.push(c.r,c.g,c.b);
  }
  g.setAttribute('color',new T.Float32BufferAttribute(colors,3));
  // Keep handle grip at the origin; the bucket hangs below the palm.
  if(id==='pumpkin-pail')g.translate(0,-extent.y*scale*.46,0);
  if(id==='little-ghost')g.translate(0,extent.y*scale*.50,0);
  const m=new T.Mesh(g,new T.MeshStandardMaterial({vertexColors:true,roughness:.9}));m.name=id;root.add(m);triangles+=g.index.count/3;
 }
 if(id==='little-ghost'){
  // The generated face is shallow and disappeared under diffuse room light.
  // Add solid ink inserts on the actual front surface, without source textures.
  const ink=new T.MeshStandardMaterial({color:'#302738',roughness:1});
  for(const [x,y,rx,ry] of [[-.031,.108,.012,.018],[.031,.108,.012,.018],[0,.065,.009,.012]]){
   const ray=new T.Raycaster(new T.Vector3(x,y+extent.y*scale*.5,1),new T.Vector3(0,0,-1));root.updateMatrixWorld(true);
   const hit=ray.intersectObjects(root.children,false)[0];if(!hit)continue;
   const g=new T.SphereGeometry(1,12,8);g.deleteAttribute('uv');const eye=new T.Mesh(g,ink);eye.scale.set(rx,ry,.003);eye.position.copy(hit.point).z+=.001;eye.name='ghost-ink';root.add(eye);triangles+=g.index.count/3;
  }
 }
 if(triangles>=4000)throw Error('Prop exceeds budget');
 const bytes=await saveGlb(root,`${dest}/${id}.glb`);report.push({id,sourceTriangles:total,triangles,bytes,sourceBounds:extent.toArray(),size,grip:id==='pumpkin-pail'?'handle top':id==='little-ghost'?'bottom':'center'});
}
await fs.writeFile(`${source}/asset-report.json`,JSON.stringify(report,null,2));console.log(report);
