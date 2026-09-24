import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {splitParts,saveGlb} from '../jellyfish-home/asset-geometry.mjs';

// Recolor the existing fitted coat, keeping its pattern and original skinning.
// Only the small brass buttons, fine piping and buckle inset add geometry.
const directory='output/cardigan-controller/clothing-0920b',file=`${directory}/belt-coat-rig.glb`;
const bytes=await fs.readFile(file),root=(await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length),'')).scene;
const cloth=root.getObjectByName('Apparel_belt-coat_0'),details=root.getObjectByName('Apparel_belt-coat_1');
if(!cloth?.isSkinnedMesh||!details?.isSkinnedMesh)throw Error('Expected original belt-coat cloth and detail meshes');
const prior=[];root.traverse(o=>{if(o.name.startsWith('Apparel_belt-coat_color-'))prior.push(o);});prior.forEach(o=>o.removeFromParent());
const hash=g=>{const h=crypto.createHash('sha256');for(const key of ['position','uv','skinIndex','skinWeight'])if(g.attributes[key])h.update(Buffer.from(g.attributes[key].array.buffer,g.attributes[key].array.byteOffset,g.attributes[key].array.byteLength));if(g.index)h.update(Buffer.from(g.index.array.buffer,g.index.array.byteOffset,g.index.array.byteLength));return h.digest('hex');};
const originalHashes=[hash(cloth.geometry),hash(details.geometry)];
const palette={body:'#171e2b',lapel:'#171e2b',belt:'#0d1015',antiqueGold:'#bda05f'};
const colors=Object.fromEntries(Object.entries(palette).map(([key,value])=>[key,new T.Color(value)]));
const smooth=T.MathUtils.smoothstep,depthKnots=[[2.55,.48],[2.70,.445],[2.90,.378],[3.06,.299],[3.20,.222],[3.35,.025],[3.45,-.09]];
function lapelDepth(y){for(let i=0;i<depthKnots.length-1;i++){const a=depthKnots[i],b=depthKnots[i+1];if(y<=b[0])return T.MathUtils.lerp(a[1],b[1],T.MathUtils.clamp((y-a[0])/(b[0]-a[0]),0,1));}return -.09;}
const p=cloth.geometry.attributes.position,colorArray=[],lapelMask=[];
for(let i=0;i<p.count;i++){
 const x=p.getX(i),y=p.getY(i),z=p.getZ(i),front=smooth(z,lapelDepth(y)-.007,lapelDepth(y)+.008)*smooth(y,2.545,2.59)*(1-smooth(Math.abs(x),.50,.59));
 const rear=smooth(y,3.26,3.34)*(1-smooth(Math.abs(x),.42,.52))*(1-smooth(z,-.03,.04));
 lapelMask.push(Math.max(front,rear));
 colorArray.push(...colors.body.toArray());
}
cloth.geometry.setAttribute('color',new T.Float32BufferAttribute(colorArray,3));
// Equal default colors still need distinct editable regions. Preserve the
// authored lapel blend explicitly instead of guessing it from identical RGB.
cloth.geometry.setAttribute('_lapel',new T.Float32BufferAttribute(lapelMask,1));
cloth.material=new T.MeshStandardMaterial({name:'Near-black navy wool and matching lapels',color:0xffffff,vertexColors:true,roughness:.91,metalness:0,side:T.DoubleSide});
cloth.material.userData.wardrobePaletteAttribute='_lapel';
const parts=splitParts(details.geometry),dp=details.geometry.attributes.position,detailColors=new Float32Array(dp.count*3);
if(parts.length!==6)throw Error(`Expected six buckle/belt components, found ${parts.length}`);
for(const[partIndex,part]of parts.entries())for(const id of new Set(part.ids)){
 const metal=[2,3,4].includes(partIndex);
 const color=metal?colors.antiqueGold:colors.belt;detailColors.set(color.toArray(),id*3);
}
details.geometry.setAttribute('color',new T.BufferAttribute(detailColors,3));
details.material=new T.MeshStandardMaterial({name:'Black belt and brass hardware',color:0xffffff,vertexColors:true,roughness:.64,metalness:.22,side:T.DoubleSide});
const index=cloth.geometry.attributes.skinIndex,weight=cloth.geometry.attributes.skinWeight,normal=cloth.geometry.attributes.normal;
function trimPath(ids){
 const positions=[],normals=[],joints=[],weights=[],indices=[];
 const centers=ids.map(id=>new T.Vector3().fromBufferAttribute(p,id).addScaledVector(new T.Vector3().fromBufferAttribute(normal,id).normalize(),.0045));
 for(let j=0;j<ids.length;j++){
  const id=ids[j],tangent=centers[Math.min(j+1,ids.length-1)].clone().sub(centers[Math.max(0,j-1)]).normalize();
  const outward=new T.Vector3().fromBufferAttribute(normal,id).normalize(),across=new T.Vector3().crossVectors(tangent,outward).normalize();outward.crossVectors(across,tangent).normalize();
  for(let k=0;k<4;k++){const a=k*Math.PI/2,n=outward.clone().multiplyScalar(Math.cos(a)).addScaledVector(across,Math.sin(a));positions.push(...centers[j].clone().addScaledVector(n,.0035).toArray());normals.push(...n.toArray());for(let c=0;c<4;c++){joints.push(index.getComponent(id,c));weights.push(weight.getComponent(id,c));}}
  if(j)for(let k=0;k<4;k++){const a=(j-1)*4+k,b=j*4+k,c=j*4+(k+1)%4,d=(j-1)*4+(k+1)%4;indices.push(a,b,d,b,c,d);}
 }
 const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(positions,3));g.setAttribute('normal',new T.Float32BufferAttribute(normals,3));g.setAttribute('skinIndex',new T.Uint16BufferAttribute(joints,4));g.setAttribute('skinWeight',new T.Float32BufferAttribute(weights,4));g.setIndex(indices);return g;
}
// Existing lapel perimeter vertices, following the source's asymmetric fold.
const piping=mergeGeometries([
 trimPath([391,554,1027,271,269]),
 trimPath([646,476,475,489,490]),
 trimPath([387,388,1033,972,424,423,426,461,457]),
],false);
function attach(g,name,material){const m=new T.SkinnedMesh(g,material);m.name='Apparel_belt-coat_color-'+name;cloth.parent.add(m);m.bind(cloth.skeleton,cloth.bindMatrix);return m;}
const tip=new T.BufferGeometry(),tipPositions=[],tipJoints=[],tipWeights=[],detailIndex=details.geometry.attributes.skinIndex,detailWeight=details.geometry.attributes.skinWeight;
for(const [id,top]of [[93,false],[94,false],[94,true],[93,true]]){const v=new T.Vector3().fromBufferAttribute(dp,id);v.z+=.003;if(top){v.x-=.0025;v.y+=.027;v.z-=.0025;}tipPositions.push(...v.toArray());for(let k=0;k<4;k++){tipJoints.push(detailIndex.getComponent(id,k));tipWeights.push(detailWeight.getComponent(id,k));}}
tip.setAttribute('position',new T.Float32BufferAttribute(tipPositions,3));tip.setAttribute('skinIndex',new T.Uint16BufferAttribute(tipJoints,4));tip.setAttribute('skinWeight',new T.Float32BufferAttribute(tipWeights,4));tip.setIndex([0,1,2,0,2,3]);tip.computeVertexNormals();
// Small paired brass buttons follow the existing front panels. Their weights
// come from the hit triangle; no torso/coat surface is rebuilt for decoration.
const buttons=[],surface=new T.Mesh(cloth.geometry,new T.MeshBasicMaterial({side:T.DoubleSide})),caster=new T.Raycaster();
for(const y of [2.26,2.03,1.80])for(const x of [-.17,.17]){
 caster.set(new T.Vector3(x,y,3),new T.Vector3(0,0,-1));
 const hit=caster.intersectObject(surface,false)[0];if(!hit||!hit.face)throw Error(`Missing button surface at ${x},${y}`);
 const ids=[hit.face.a,hit.face.b,hit.face.c],ps=ids.map(id=>new T.Vector3().fromBufferAttribute(p,id));
 const bary=new T.Triangle(...ps).getBarycoord(hit.point,new T.Vector3()),mix=new Map();
 ids.forEach((id,j)=>{for(let k=0;k<4;k++){const bone=index.getComponent(id,k);mix.set(bone,(mix.get(bone)??0)+weight.getComponent(id,k)*bary.getComponent(j));}});
 const influences=[...mix].sort((a,b)=>b[1]-a[1]).slice(0,4),sum=influences.reduce((s,b)=>s+b[1],0);
 const g=new T.CylinderGeometry(.026,.026,.012,10,1).rotateX(Math.PI/2).translate(x,y,hit.point.z+.008);g.deleteAttribute('uv');g.clearGroups();
 const joints=[],weights=[];for(let i=0;i<g.attributes.position.count;i++)for(let k=0;k<4;k++){joints.push(influences[k]?.[0]??0);weights.push((influences[k]?.[1]??0)/sum);}
 g.setAttribute('skinIndex',new T.Uint16BufferAttribute(joints,4));g.setAttribute('skinWeight',new T.Float32BufferAttribute(weights,4));buttons.push(g);
}
surface.material.dispose();
attach(mergeGeometries([piping,tip,...buttons],false),'fine-piping',new T.MeshStandardMaterial({name:'Brass buttons and fine collar piping',color:palette.antiqueGold,roughness:.5,metalness:.45,side:T.DoubleSide}));
// The source buckle is a shallow solid plate. A black two-triangle centre
// makes its existing bronze perimeter read as a buckle frame.
const buckle=parts[2],cx=(buckle.box.min.x+buckle.box.max.x)/2,cy=(buckle.box.min.y+buckle.box.max.y)/2;
const nearest=[...new Set(buckle.ids)].sort((a,b)=>Math.hypot(dp.getX(a)-cx,dp.getY(a)-cy)-Math.hypot(dp.getX(b)-cx,dp.getY(b)-cy))[0];
const inset=new T.BufferGeometry(),di=details.geometry.attributes.skinIndex,dw=details.geometry.attributes.skinWeight,ii=[],iw=[];
inset.setAttribute('position',new T.Float32BufferAttribute([cx-.084,cy-.050,buckle.box.max.z+.0015,cx+.084,cy-.050,buckle.box.max.z+.0015,cx+.084,cy+.050,buckle.box.max.z+.0015,cx-.084,cy+.050,buckle.box.max.z+.0015],3));inset.setIndex([0,1,2,0,2,3]);inset.computeVertexNormals();for(let v=0;v<4;v++)for(let k=0;k<4;k++){ii.push(di.getComponent(nearest,k));iw.push(dw.getComponent(nearest,k));}inset.setAttribute('skinIndex',new T.Uint16BufferAttribute(ii,4));inset.setAttribute('skinWeight',new T.Float32BufferAttribute(iw,4));attach(inset,'buckle-inset',new T.MeshStandardMaterial({color:palette.belt,roughness:.72,side:T.DoubleSide}));
if(originalHashes[0]!==hash(cloth.geometry)||originalHashes[1]!==hash(details.geometry))throw Error('Original geometry or weights changed');
const garments=[];root.traverse(o=>{if(o.isMesh&&o.name.startsWith('Apparel_belt-coat_'))garments.push(o);});
const triangles=garments.reduce((s,m)=>s+m.geometry.index.count/3,0),meta={id:'belt-coat',label:'系带长外套',triangles,drawCalls:garments.length,palette,revision:'navy-brass-0921-2',originalGeometryPreserved:true,originalGeometryHashes:originalHashes,addedTriangles:triangles-2441};
root.userData.apparel={...root.userData.apparel,...meta};await saveGlb(root,file);
const emittedBytes=await fs.readFile(file),emitted=(await new GLTFLoader().parseAsync(emittedBytes.buffer.slice(emittedBytes.byteOffset,emittedBytes.byteOffset+emittedBytes.length),'')).scene;
let maxWeightRoundTripDifference=0;
for(const original of [cloth,details]){
 const exported=emitted.getObjectByName(original.name).geometry;
 for(const key of ['position','uv','skinIndex','skinWeight','index']){
  const a=key==='index'?original.geometry.index?.array:original.geometry.attributes[key]?.array,b=key==='index'?exported.index?.array:exported.attributes[key]?.array;
  if(!a&&!b)continue;if(!a||!b||a.length!==b.length)throw Error(`Export changed ${original.name}/${key} layout`);
  for(let i=0;i<a.length;i++){const error=Math.abs(a[i]-b[i]);if(key==='skinWeight')maxWeightRoundTripDifference=Math.max(maxWeightRoundTripDifference,error);if(error>(key==='skinWeight'?2e-7:0))throw Error(`Export changed ${original.name}/${key}: ${error}`);}
 }
}
meta.maxWeightRoundTripDifference=maxWeightRoundTripDifference;
const only=new T.Group();for(const m of garments){const geometry=m.geometry.clone();geometry.deleteAttribute('skinIndex');geometry.deleteAttribute('skinWeight');const plain=new T.Mesh(geometry,m.material);plain.name=m.name;only.add(plain);}await saveGlb(only,`${directory}/belt-coat-only.glb`);
for(const kind of ['rig','only'])await fs.copyFile(`${directory}/belt-coat-${kind}.glb`,`public/room3d/wardrobe/belt-coat-${kind}.glb`);
await fs.writeFile(`${directory}/belt-coat-color-manifest.json`,JSON.stringify(meta,null,2));console.log(JSON.stringify(meta));
