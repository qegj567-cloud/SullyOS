import fs from 'node:fs/promises';
import * as T from 'three';
import {MeshoptSimplifier} from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
await MeshoptSimplifier.ready;
import {mergeGeometries,mergeVertices} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {readGeometry,compactGeometry,saveGlb} from '../../jellyfish-home/asset-geometry.mjs';
const dir='art/pets/halloween-2026',manifest=JSON.parse(await fs.readFile('art/pets/manifest.json','utf8'));
for(const name of ['hamster','jellyfish']){
 const source=mergeGeometries(await readGeometry(`${dir}/${name}-source.glb`));source.computeBoundingBox();const box=source.boundingBox,center=box.getCenter(new T.Vector3()),scale=.8/(box.max.x-box.min.x);
 source.translate(-center.x,-box.min.y,-center.z);if(name==='hamster')source.scale(1,1,.52);source.scale(scale,scale,scale);
 if(name==='jellyfish'){
  // Remove the source's small mouth relief while preserving the surrounding bell.
  const p=source.attributes.position,neighbors=Array.from({length:p.count},()=>new Set());
  for(let i=0;i<source.index.count;i+=3){const ids=[source.index.getX(i),source.index.getX(i+1),source.index.getX(i+2)];for(const a of ids)for(const b of ids)if(a!==b)neighbors[a].add(b);}
  for(let pass=0;pass<12;pass++){const next=new Float32Array(p.array);for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i),weight=Math.max(0,1-Math.abs(x)/.09)*Math.max(0,1-Math.abs(y-.35)/.075);if(z<.15||!weight)continue;let sum=0;for(const j of neighbors[i])sum+=p.getZ(j);next[i*3+2]=z+(sum/neighbors[i].size-z)*weight*.7;}p.array.set(next);}
 }
 const sourceTriangles=source.index.count/3,g=await compactGeometry(source,MeshoptSimplifier.simplify(new Uint32Array(source.index.array),source.attributes.position.array,3,name==='jellyfish'?5400:6900,.025)[0]),root=new T.Group();root.name='pet_'+name;
 const colors=name==='hamster'?{body:'#cc9863',markings:'#f6e6cc',ears:'#d79797',feet:'#d7aaa0',eyes:'#34322f',nose:'#a15e69'}:{body:'#b4a6cc',rim:'#92c5c0',tentacles:'#c5bbdb',cheeks:'#dfb2b9',eyes:'#343a4b'};
 const materials=Object.fromEntries(Object.entries(colors).map(([role,color])=>[role,new T.MeshStandardMaterial({name:'pet-'+role,color,roughness:.85})]));
 const base=new T.Mesh(g,materials.body);root.add(base);root.updateMatrixWorld(true);
 const surface=(x,y,offset=.013)=>{const hit=new T.Raycaster(new T.Vector3(x,y,2),new T.Vector3(0,0,-1)).intersectObject(base)[0];return hit?new T.Vector3(x,y,hit.point.z+offset):null;};
 const patch=(role,x,y,rx,ry)=>{const vertices=[],indices=[],steps=24,rings=3;for(let r=0;r<=rings;r++)for(let j=0;j<steps;j++){const a=j/steps*Math.PI*2,p=surface(x+Math.cos(a)*rx*r/rings,y+Math.sin(a)*ry*r/rings);if(!p)return;vertices.push(...p.toArray());}for(let r=0;r<rings;r++)for(let j=0;j<steps;j++){const a=r*steps+j,b=r*steps+(j+1)%steps,c=a+steps,d=b+steps;indices.push(a,c,b,b,c,d);}const pg=new T.BufferGeometry();pg.setAttribute('position',new T.Float32BufferAttribute(vertices,3));pg.setIndex(indices);pg.computeVertexNormals();root.add(new T.Mesh(pg,materials[role]));};
 const bead=(role,x,y,rx,ry,depth,label)=>{const point=surface(x,y,.018);if(!point)throw Error('No face surface');const sphere=new T.SphereGeometry(1,12,8);sphere.deleteAttribute('uv');const mesh=new T.Mesh(sphere,materials[role]);mesh.name=label||role;mesh.position.copy(point);mesh.scale.set(rx,ry,depth);root.add(mesh);};
 if(name==='hamster'){
  patch('markings',0,.22,.21,.16);for(const s of [-1,1]){patch('markings',s*.22,.32,.135,.095);patch('ears',s*.205,.565,.047,.055);patch('feet',s*.16,.04,.046,.027);bead('eyes',s*.128,.365,.023,.027,.016,s<0?'Eye left':'Eye right');}bead('nose',0,.335,.022,.017,.016);
 }else{
  for(const s of [-1,1]){patch('cheeks',s*.155,.375,.033,.018);bead('eyes',s*.108,.428,.023,.027,.018,s<0?'Eye left':'Eye right');}

  // Solid anatomical color bands are geometry, never image textures.
  const clip=(poly,height,above)=>{const result=[];for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length],insideA=above?a.p.y>=height:a.p.y<=height,insideB=above?b.p.y>=height:b.p.y<=height;if(insideA)result.push(a);if(insideA!==insideB){const t=(height-a.p.y)/(b.p.y-a.p.y);result.push({p:a.p.clone().lerp(b.p,t),n:a.n.clone().lerp(b.n,t).normalize()});}}return result;};
  root.remove(base);for(const [role,lo,hi]of [['body',.31,2],['rim',.25,.31],['tentacles',-1,.25]]){const positions=[],normals=[],indices=[];for(let i=0;i<g.index.count;i+=3){let poly=[0,1,2].map(k=>{const id=g.index.getX(i+k);return {p:new T.Vector3().fromBufferAttribute(g.attributes.position,id),n:new T.Vector3().fromBufferAttribute(g.attributes.normal,id)};});poly=clip(clip(poly,lo,true),hi,false);for(let j=1;j<poly.length-1;j++)for(const vertex of [poly[0],poly[j],poly[j+1]]){indices.push(positions.length/3);positions.push(...vertex.p.toArray());normals.push(...vertex.n.toArray());}}const piece=new T.BufferGeometry();piece.setAttribute('position',new T.Float32BufferAttribute(positions,3));piece.setAttribute('normal',new T.Float32BufferAttribute(normals,3));piece.setIndex(indices);root.add(new T.Mesh(piece,materials[role]));}
 }
 // Merge same-color parts, preserving the separately named eye meshes.
 root.updateMatrixWorld(true);const packed=new T.Group(),buckets=new Map();for(const mesh of root.children){const key=mesh.name.startsWith('Eye ')?mesh.name:mesh.material.name;if(!buckets.has(key))buckets.set(key,{material:mesh.material,geometries:[]});buckets.get(key).geometries.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));}
 for(const [key,b]of buckets){const mesh=new T.Mesh(mergeVertices(mergeGeometries(b.geometries),1e-5),b.material);mesh.name=key;packed.add(mesh);}
 const size=new T.Box3().setFromObject(packed).getSize(new T.Vector3()).toArray(),triangles=packed.children.reduce((n,m)=>n+m.geometry.index.count/3,0);if(triangles>=4000)throw Error(name+' budget '+triangles);
 const bytes=await saveGlb(packed,`public/room3d/pets/${name}.glb`),entry={id:'pet_'+name,source:`halloween-2026/${name}-source.glb`,sourceTriangles,triangles,bytes,size,colors,drawCalls:packed.children.length};const index=manifest.findIndex(a=>a.id===entry.id);if(index<0)manifest.push(entry);else manifest[index]=entry;console.log(entry);
}
await fs.writeFile('art/pets/manifest.json',JSON.stringify(manifest,null,2)+'\n');
