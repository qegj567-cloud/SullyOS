import fs from 'node:fs/promises';
import * as T from 'three';
import {mergeGeometries,mergeVertices,toCreasedNormals} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {MeshoptSimplifier} from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
import {RoundedBoxGeometry} from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {readGeometry,compactGeometry,saveGlb} from './asset-geometry.mjs';
import {showroomParts} from './showroom-parts.mjs';
await MeshoptSimplifier.ready;
const rebuild=process.argv.includes('--extract'),sourceDir='art/jellyfish-home/sources/showrooms';
await fs.mkdir(sourceDir,{recursive:true});await fs.mkdir('output/showrooms',{recursive:true});
// Visually authored from the supplied room references. No pixel sampling,
// texture baking, vertex colors or AI image data in the output.
const palette={cream:'#e9e0d2',sage:'#82917d',olive:'#81854c',lavender:'#a39cb6',pink:'#d5b5b7',blue:'#89bfc4',stone:'#7f818b',charcoal:'#34303a',walnut:'#6c4638',wood:'#ffffff'};
const mats=Object.fromEntries(Object.entries(palette).map(([key,color])=>{const m=new T.MeshStandardMaterial({color,roughness:.83});m.name=key==='wood'?'woodLight':'showroom-'+key;return [key,m];}));
mats.wood.color.setRGB(.8227857351303101,.5972017645835876,.3915724754333496);
for(const side of ['left','right']){mats['pillow-'+side]=new T.MeshStandardMaterial({color:side==='left'?'#82917d':'#d9c5b7',roughness:.9});mats['pillow-'+side].name='pillow-'+side;}
function clip(g,bounds){
 const p=g.attributes.position,idx=g.index,out=[];
 for(let k=0;k<idx.count;k+=3){let poly=[0,1,2].map(j=>{const i=idx.getX(k+j);return [p.getX(i),p.getY(i),p.getZ(i)];});
  if([0,1,2].some(a=>poly.every(v=>v[a]<bounds[0][a])||poly.every(v=>v[a]>bounds[1][a])))continue;
  for(let a=0;a<3;a++)for(let side=0;side<2;side++){const val=bounds[side][a],inside=v=>side?v[a]<=val:v[a]>=val,next=[];for(let i=0;i<poly.length;i++){const A=poly[i],B=poly[(i+1)%poly.length],ai=inside(A),bi=inside(B);if(ai)next.push(A);if(ai!==bi){const t=(val-A[a])/(B[a]-A[a]);next.push(A.map((v,j)=>v+(B[j]-v)*t));}}poly=next;}
  for(let j=1;j<poly.length-1;j++)out.push(...poly[0],...poly[j],...poly[j+1]);
 }
 return mergeVertices(new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(out,3)),1e-5);
}
async function reduce(g,target){let index=new Uint32Array(g.index.array);if(index.length>target*3){[index]=MeshoptSimplifier.simplify(index,g.attributes.position.array,3,target*3,.15,['Permissive']);if(index.length>target*3)[index]=MeshoptSimplifier.simplify(index,g.attributes.position.array,3,target*3,1,['Permissive']);}return compactGeometry(g,index);}
if(rebuild){
 for(let source=2;source<=6;source++){
  const raw=mergeGeometries(await readGeometry('output/showroom-source/'+source+'.glb'));raw.computeBoundingBox();
  const box=raw.boundingBox,c=box.getCenter(new T.Vector3()),size=box.getSize(new T.Vector3()),unit=Math.max(size.x,size.y,size.z)*1.3/850;
  for(const a of showroomParts.filter(a=>a.source===source)){
   const [x,z,X,Z]=a.rect,bounds=[[c.x+(x-500)*unit,a.y[0],c.z+(z-425)*unit],[c.x+(X-500)*unit,a.y[1],c.z+(Z-425)*unit]];
   let g=clip(raw,bounds);g=await reduce(g,12000);
   const r=new T.Group();r.add(new T.Mesh(g,mats.cream));await saveGlb(r,sourceDir+'/'+a.id+'.glb');console.log('extracted',a.id,g.index.count/3);
  }
 }
}
const catalog=JSON.parse(await fs.readFile('public/room3d/catalog.json','utf8')),report=[];
function repairBox(root,size,position,material,r=.025){const g=mergeVertices(new RoundedBoxGeometry(...size,1,r));g.deleteAttribute('uv');g.translate(...position);root.add(new T.Mesh(g,material));}
for(const a of showroomParts){
 let g=mergeGeometries(await readGeometry(sourceDir+'/'+a.id+'.glb'));g=await reduce(g,2800);if(a.rotate)g.rotateY(a.rotate*Math.PI/180);
 g.computeBoundingBox();let b=g.boundingBox,s=b.getSize(new T.Vector3()),c=b.getCenter(new T.Vector3());g.translate(-c.x,-b.min.y,-c.z);g.scale(a.width/s.x,a.height/s.y,(a.depth||a.width*s.z/s.x)/s.z);g.computeBoundingBox();s=g.boundingBox.getSize(new T.Vector3());
 // Preserve the coarse cabinet as one object, with a closed usable top after
 // removing fused countertop clutter. The missing supports are rebuilt below.
 const extra=[];if(a.top){const top=new T.BoxGeometry(s.x,.07,s.z);top.translate(0,s.y-.035,0);top.deleteAttribute('uv');extra.push(top);}if(a.back){const back=new T.BoxGeometry(s.x,s.y,.04);back.translate(0,s.y/2,-s.z/2+.02);back.deleteAttribute('uv');extra.push(back);}
 g.computeVertexNormals();g=mergeVertices(toCreasedNormals(g,Math.PI/2.4));
 const p=g.attributes.position,idx=g.index,buckets=new Map();
 for(let i=0;i<idx.count;i+=3){const ids=[idx.getX(i),idx.getX(i+1),idx.getX(i+2)],y=ids.reduce((n,k)=>n+p.getY(k),0)/3;
  const tone=a.tone==='stone'?'stone':a.top&&y>s.y-.08?'wood':a.tone;
  if(!buckets.has(tone))buckets.set(tone,[]);buckets.get(tone).push(...ids);
 }
 const root=new T.Group();for(const [tone,ids]of buckets){const patch=g.clone();patch.setIndex(ids);root.add(new T.Mesh(patch,mats[tone]));}
 if(extra.length)root.add(new T.Mesh(mergeGeometries(extra),mats.wood));
 // Fused rooms do not contain the backs/undersides hidden by walls or floors.
 // Rebuild these structural volumes; keep the extracted shelves and fronts.
 if(['study_shelf','study_tower','living_console','bedroom_low_shelf','bedroom_bench'].includes(a.id)){
  repairBox(root,[s.x,s.y,.07],[0,s.y/2,-s.z/2+.035],mats.wood);
  repairBox(root,[s.x,.07,s.z],[0,.04,0],mats.wood);
  for(const sign of [-1,1])repairBox(root,[.065,s.y,s.z],[sign*(s.x/2-.0325),s.y/2,0],mats.wood);
 }
 if(['kitchen_counter','kitchen_range','bedroom_dresser','wardrobe'].includes(a.id)){
  // The wardrobe's side was fused to a hanging plant and the room wall. Its
  // two-door silhouette is rebuilt rather than shipping stray leaves/cutouts.
  if(a.id==='wardrobe')root.clear();
  repairBox(root,[s.x-.10,s.y-.10,s.z*.82],[0,s.y/2,-s.z*.08],mats[a.tone]);
  repairBox(root,[s.x,.07,s.z],[0,s.y-.035,0],a.room==='kitchen'?mats.charcoal:mats.wood);
  const cols=a.id==='wardrobe'?2:a.id==='kitchen_counter'?4:2,rows=a.id==='bedroom_dresser'?3:1;
  for(let x=0;x<cols;x++)for(let y=0;y<rows;y++){
   const w=(s.x-.12)/cols-.02,h=(s.y-.19)/rows-.018,cx=(x-(cols-1)/2)*(w+.02),cy=.07+(y+.5)*(h+.018);
   const panel=new T.BoxGeometry(w,h,.035);panel.deleteAttribute('uv');panel.translate(cx,cy,s.z*.36);root.add(new T.Mesh(panel,mats[a.tone]));
   const handle=new T.BoxGeometry(Math.min(.23,w*.4),.032,.045);handle.deleteAttribute('uv');handle.translate(cx,cy+h*.32,s.z*.39);root.add(new T.Mesh(handle,mats.charcoal));
  }
 }
 if(a.id==='kitchen_range'){
  repairBox(root,[s.x*.68,s.y*.48,.026],[0,s.y*.43,s.z*.405],mats.charcoal,.01);
  for(const x of [-s.x*.25,s.x*.25])for(const z of [-s.z*.23,s.z*.23]){const ring=new T.TorusGeometry(.13,.019,4,12);ring.rotateX(Math.PI/2);ring.translate(x,s.y+.012,z);ring.deleteAttribute('uv');root.add(new T.Mesh(ring,mats.stone));}
 }
 if(a.id==='kitchen_counter'){
  const basin=new T.BoxGeometry(s.x*.23,.018,s.z*.62);basin.deleteAttribute('uv');basin.translate(0,s.y+.005,0);root.add(new T.Mesh(basin,mats.blue));
  const curve=new T.CatmullRomCurve3([new T.Vector3(0,s.y,-s.z*.37),new T.Vector3(0,s.y+.20,-s.z*.37),new T.Vector3(0,s.y+.24,-s.z*.19),new T.Vector3(0,s.y+.16,-s.z*.15)]),faucet=new T.TubeGeometry(curve,12,.024,5,false);faucet.deleteAttribute('uv');root.add(new T.Mesh(faucet,mats.stone));
 }
 if(['study_desk','study_tea_table','living_table'].includes(a.id)){
  // Retain the tabletop silhouette; replace torn legs and fused chair remnants.
  root.clear();repairBox(root,[s.x,.11,s.z],[0,s.y-.055,0],mats.wood,.09);
  for(const x of [-1,1])for(const z of [-1,1])repairBox(root,[.12,s.y-.10,.12],[x*(s.x/2-.14),(s.y-.10)/2,z*(s.z/2-.14)],mats.wood,.02);
  for(const z of [-1,1])repairBox(root,[s.x-.20,.15,.065],[0,s.y-.18,z*(s.z/2-.13)],mats.wood);
 }
 if(a.id==='kitchen_island'){
  root.clear();repairBox(root,[s.x-.18,s.y-.10,s.z-.12],[0,(s.y-.10)/2,0],mats.wood);
  repairBox(root,[s.x,.10,s.z],[0,s.y-.05,0],mats.cream);
  for(const x of [-s.x*.24,s.x*.24]){repairBox(root,[s.x*.45,s.y*.70,.035],[x,s.y*.49,s.z/2-.035],mats.wood);repairBox(root,[.23,.035,.045],[x,s.y*.73,s.z/2],mats.charcoal,.01);}
 }
 if(a.id==='spa_lantern'){
  root.clear();for(const x of [-1,1])for(const z of [-1,1])repairBox(root,[.05,s.y,.05],[x*(s.x/2-.025),s.y/2,z*(s.z/2-.025)],mats.walnut,.008);
  repairBox(root,[s.x-.075,s.y-.15,s.z-.075],[0,s.y/2,0],mats.cream,.008);
  for(const y of [.03,s.y-.03])repairBox(root,[s.x,.06,s.z],[0,y,0],mats.walnut,.008);
 }
 if(a.id==='spa_chest'){repairBox(root,[s.x*.94,s.y*.8,s.z*.87],[0,s.y*.40,0],mats.wood);}
 if(a.id==='spa_pool'){
  const water=new T.CircleGeometry(1,48);water.rotateX(-Math.PI/2);water.scale(s.x*.36,1,s.z*.29);water.translate(0,s.y*.27,0);water.deleteAttribute('uv');root.add(new T.Mesh(water,mats.blue));
 }
 if(a.id==='bed'){
  // White bedding and the gray-green folded throw in the reference. Cut the
  // triangles at two exact planes so the material seam cannot zigzag by face.
  root.clear();for(const [lo,hi,mat]of [[-s.z/2,.12,mats.cream],[.12,.88,mats.sage],[.88,s.z/2,mats.cream]]){const patch=clip(g,[[-s.x/2,-.01,lo],[s.x/2,s.y+.01,hi]]);patch.computeVertexNormals();root.add(new T.Mesh(patch,mat));}
 }
 if(['bed','living_sofa'].includes(a.id)){
  const zones=a.id==='bed'?[['pillow-left',[[-1.04,.82,-1.19],[.04,1.34,-.70]]],['pillow-right',[[.14,.81,-1.14],[1.08,1.30,-.61]]]]:[['pillow-left',[[-1.24,.61,.12],[-.39,1.14,.71]]],['pillow-right',[[.31,.60,-.16],[1.31,1.20,.48]]]];
  for(const [name,bounds]of zones)for(const m of [...root.children]){
   if(m.material!==mats.cream)continue;root.remove(m);let remaining=[[-10,-10,-10],[10,10,10]];
   for(let axis=0;axis<3;axis++)for(let side=0;side<2;side++){
    const piece=structuredClone(remaining);piece[1-side][axis]=bounds[side][axis];
    const patch=clip(m.geometry,piece);if(patch.index.count){patch.computeVertexNormals();root.add(new T.Mesh(patch,m.material));}
    remaining[side][axis]=bounds[side][axis];
   }
   const cushion=clip(m.geometry,bounds);if(cushion.index.count){cushion.computeVertexNormals();root.add(new T.Mesh(cushion,mats[name]));}
  }
 }
 // Collapse material groups so each instance costs only one draw per color.
 const combined=new T.Group(),groups=new Map();for(const mesh of root.children){const key=mesh.material.name;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(mesh);}
 for(const meshes of groups.values())combined.add(new T.Mesh(mergeVertices(mergeGeometries(meshes.map(o=>o.geometry.toNonIndexed()))),meshes[0].material));
 const total=combined.children.reduce((n,m)=>n+m.geometry.index.count/3,0);
 if(total>3850)for(const m of combined.children){m.geometry=await reduce(m.geometry,Math.floor(m.geometry.index.count/3*3800/total));m.geometry.computeVertexNormals();}
 if(['bed','living_sofa'].includes(a.id)){
  // Share normals across newly cut color boundaries; a paint seam is not a fold.
  const smooth=mergeVertices(mergeGeometries(combined.children.map(m=>{const g=m.geometry.clone();g.deleteAttribute('normal');return g;})),1e-5);smooth.computeVertexNormals();
  const ps=smooth.attributes.position,ns=smooth.attributes.normal,byPosition=new Map(),key=(p,i)=>[p.getX(i),p.getY(i),p.getZ(i)].map(v=>Math.round(v*1e5)).join(',');
  for(let i=0;i<ps.count;i++)byPosition.set(key(ps,i),[ns.getX(i),ns.getY(i),ns.getZ(i)]);
  for(const m of combined.children){const p=m.geometry.attributes.position,n=m.geometry.attributes.normal;for(let i=0;i<p.count;i++){const v=byPosition.get(key(p,i));if(v)n.setXYZ(i,...v);}}
 }
 s=new T.Box3().setFromObject(combined).getSize(new T.Vector3());
 const id='show_'+a.id,asset={id,name:a.name,surface:'floor',url:id+'.glb',collection:a.room,showroomSource:a.source,size:s.toArray(),default:[0,.15,0],boxes:[[-s.x/2,0,-s.z/2,s.x/2,s.y,s.z/2]],paintMaterials:[mats[a.tone].name],revision:a.id==='wardrobe'?'showrooms-wardrobe-wide-1':'showrooms-cushions-3'};
 if(a.support)asset.support={shape:'rect',width:s.x-.12,depth:s.z-.12,height:s.y};
 if(a.id==='spa_chest')asset.support={shape:'rect',width:s.x-.08,depth:s.z-.08,height:s.y};
 if(['bed','living_sofa'].includes(a.id))asset.colorParts=[{material:'pillow-left',label:'左侧枕头',color:'#82917d'},{material:'pillow-right',label:'右侧枕头',color:'#d9c5b7'}];
 if(a.seat)asset.seats=(a.width>3?[-.94,.94]:[0]).map((x,i)=>({id:String(i),label:a.width>3?(i?'右边':'左边'):'坐垫',position:[x,a.seat,a.id==='living_sofa'?.55:0],rotation:0}));
 if(a.bed)asset.beds=[-.94,.94].map((x,i)=>({id:String(i),label:i?'右边':'左边',position:[x,a.bed,.15],rotation:0}));
 let triangles=0;combined.traverse(o=>{if(o.isMesh)triangles+=o.geometry.index.count/3;});if(triangles>=4000)throw Error(id+' over budget '+triangles);
 const bytes=await saveGlb(combined,'public/room3d/'+id+'.glb'),old=catalog.findIndex(v=>v.id===id);if(old<0)catalog.push(asset);else catalog[old]=asset;report.push({id,triangles,bytes,groups:groups.size,size:asset.size});
}
await fs.writeFile('public/room3d/catalog.json',JSON.stringify(catalog,null,2)+'\n');await fs.writeFile('output/showrooms/assets-report.json',JSON.stringify(report,null,2));console.log(report);
// Apply the current study cabinet finish after legacy source reconstruction.
await import('./study-cabinet-finishes.mjs');


// Restore the coffee cabinet and kitchen accessories after a full rebuild.
await import('./repair-dresser.mjs');
await import('./kitchen-finish-parts.mjs');
await import('./kitchenware-assets.mjs');
await import('./kitchen-reference-assets.mjs');
