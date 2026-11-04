import fs from 'node:fs/promises';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshBVH} from 'three-mesh-bvh';
import {loadTextured,subset,embedTexture} from './textured-geometry.mjs';
import {saveGlb} from '../../jellyfish-home/asset-geometry.mjs';
import {readGlb,packGlb,stripImages} from './glb-utils.mjs';
import {boundaryLoops} from './boundary-loops.mjs';
import {fitPumpkinCuffs} from './fit-pumpkin-cuffs.mjs';
import {clipY} from './clip-garment.mjs';
const dir='art/halloween-2026/meshy',out=dir+'/assembled';
await fs.mkdir(out,{recursive:true});
const bytes=await fs.readFile(dir+'/current-body.glb');
const root=(await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene;
let body;root.traverse(o=>{if(o.isSkinnedMesh)body=o;});
root.updateMatrixWorld(true);body.skeleton.update();
const sk=body.skeleton,bg=body.geometry,bp=bg.attributes.position,bi=bg.attributes.skinIndex,bw=bg.attributes.skinWeight;
const tree=new MeshBVH(bg,{indirect:true}),p0=new T.Vector3(),p1=new T.Vector3(),p2=new T.Vector3(),bar=new T.Vector3();
const legTrees={};for(const side of [-1,1]){const ids=[];for(let t=0;t<bg.index.count;t+=3){const tri=[0,1,2].map(k=>bg.index.getX(t+k));if(tri.every(i=>bp.getX(i)*side>0&&bp.getY(i)<2.1))ids.push(...tri);}const geo=subset(bg,ids);legTrees[side]={geo,tree:new MeshBVH(geo,{indirect:true})};}
const joint=name=>{const id=sk.bones.findIndex(b=>b.name===name);if(id<0)throw Error(name);return id;};
let kind='pumpkin';
function smoothFittedNormals(g){g.computeVertexNormals();const p=g.attributes.position,n=g.attributes.normal,groups=new Map(),keys=[];for(let i=0;i<p.count;i++){const key=[p.getX(i),p.getY(i),p.getZ(i)].map(x=>Math.round(x*1e5)).join(',');keys.push(key);if(!groups.has(key))groups.set(key,new T.Vector3());groups.get(key).add(new T.Vector3().fromBufferAttribute(n,i));}for(let i=0;i<p.count;i++){const v=groups.get(keys[i]).normalize();n.setXYZ(i,v.x,v.y,v.z);}}
function bind(g,part){
 smoothFittedNormals(g);
 const p=g.attributes.position,joints=[],weights=[];
 for(let i=0;i<p.count;i++){
  const v=new T.Vector3().fromBufferAttribute(p,i),map=new Map();
  if(part==='hat')map.set(joint('head'),1);
  else if(part==='collar'){const arm=T.MathUtils.smoothstep(Math.abs(v.x),.43,.78)*.8;map.set(joint('chest'),1-arm);map.set(joint((v.x>0?'L':'R')+'_upperArm'),arm);}
  else if(part==='hood-lining')map.set(joint('head'),1);
  else if(part==='boots'){
   const side=v.x>0?'L':'R',blend=T.MathUtils.smoothstep(v.y,.27,.68);
   map.set(joint(side+'_foot'),1-blend);map.set(joint(side+'_shin'),blend);
  }
  else if(part==='hooded-top'&&v.y>3.32){const blend=T.MathUtils.smoothstep(v.y,3.32,3.65);map.set(joint('chest'),1-blend);map.set(joint('head'),blend);}
  else if(part==='romper'&&v.y<2.95&&v.y>2.03||part==='hooded-top'&&v.y<2.98&&Math.abs(v.x)<.65){
   const blend=T.MathUtils.smoothstep(v.y,2.20,2.95);map.set(joint('hips'),1-blend);map.set(joint('chest'),blend);
  }
  else{
   const ref=(part==='boots'||v.y<1.9)?legTrees[Math.sign(v.x)||1]:{geo:bg,tree};
   const query=part==='hooded-top'&&Math.abs(v.x)>.65&&v.y>2.45?v.clone().setY(3.125):v;
   const hit=ref.tree.closestPointToPoint(query),tri=[0,1,2].map(k=>ref.geo.index.getX(hit.faceIndex*3+k)),rp=ref.geo.attributes.position,ri=ref.geo.attributes.skinIndex,rw=ref.geo.attributes.skinWeight;
   p0.fromBufferAttribute(rp,tri[0]);p1.fromBufferAttribute(rp,tri[1]);p2.fromBufferAttribute(rp,tri[2]);
   T.Triangle.getBarycoord(hit.point,p0,p1,p2,bar);
   tri.forEach((vi,n)=>{for(let k=0;k<4;k++){let ji=ri.getComponent(vi,k),name=sk.bones[ji].name;
    if(/_(thumb|index|middle|ring|pinky)/.test(name))ji=joint(name[0]+'_hand');
    if((part==='boots'||v.y<1.9)&&/^[LR]_/.test(name)&&name[0]!== (v.x>0?'L':'R'))continue;
    const weight=rw.getComponent(vi,k)*bar.getComponent(n);map.set(ji,(map.get(ji)||0)+weight);
   }});
  }
  const list=[...map].filter(([,w])=>w>1e-6).sort((a,b)=>b[1]-a[1]).slice(0,4),sum=list.reduce((n,q)=>n+q[1],0);
  if(sum<.0001)throw Error('Unbound vertex '+part+' '+i);
  for(let k=0;k<4;k++){joints.push(list[k]?.[0]??0);weights.push((list[k]?.[1]??0)/sum);}
 }
 g.setAttribute('skinIndex',new T.Uint16BufferAttribute(joints,4));g.setAttribute('skinWeight',new T.Float32BufferAttribute(weights,4));
 const m=new T.SkinnedMesh(g,new T.MeshStandardMaterial({name:'HalloweenAtlas',color:0xffffff,roughness:.9,side:T.DoubleSide}));
 m.name='Halloween_'+kind+'_'+part;m.userData={part:part==='collar'?'romper':['hood-lining','hood-underlay'].includes(part)?'hooded-top':part,source:'Meshy accepted reduced model; mannequin removed',body:'current 48-bone project body'};
 root.add(m);m.bind(sk,body.bindMatrix);return m;
}
// Extract by material colour AND anatomical region. A colour alone is never
// sufficient: tan buckles and highlights are retained outside exposed skin.
function skinColor(c){const [r,g,b]=c;return r>g+3&&g>b+3&&r-b<100&&r<g*1.5;}
let source=await loadTextured(dir+'/reduced/pumpkin-costume-34000.glb');
const g=source.geo,p=g.attributes.position,uv=g.attributes.uv,buckets={hat:[],sleeves:[],romper:[],collar:[],boots:[]};
const removed=[];
for(let t=0;t<g.index.count;t+=3){
 const ids=[0,1,2].map(k=>g.index.getX(t+k)),v=new T.Vector3(),u=new T.Vector2();
 for(const i of ids){v.add(new T.Vector3().fromBufferAttribute(p,i));u.add(new T.Vector2().fromBufferAttribute(uv,i));}v.divideScalar(3);u.divideScalar(3);
 const ax=Math.abs(v.x),color=source.sample(u.x,u.y),skin=skinColor(color),green=color[1]>color[0]*1.08&&color[1]>color[2]*1.08;let part;
 if(v.y>.55){if(!skin)part='hat';}
 else if(v.y<-.67)part='boots';
 else if(v.y>-.255&&v.y<.38){
  const exposed=skin&&(ax>.53||v.y>.30&&ax<.10||v.y<-.17);
  if(!exposed)part=green&&ax<.33&&v.y>.18?'collar':(ax>.34||ax>.235&&v.y>.195)?'sleeves':'romper';
  // Replace the fused AI shoulder with the approved narrow-shoulder mother.
  // The source cuff, forearm artwork and flared sleeve remain unchanged.
  // The design's plain purple shirt uses the approved fitted sweater. Keep
  // Meshy's decorated wrist bands and orange leaf cuffs, not its fused tubes.
  if(color[2]>color[1]*1.2&&ax>.15&&ax<.48&&v.y>.16)part=null;
  if(part==='sleeves'&&ax<.48)part=null;
  // The extracted AI cuff has holes where its mannequin was fused into it.
  // Replace only that broken purple lower band with approved sailor shorts.
  if(v.y<-.14&&(color[2]>color[1]*1.15||v.y<-.19))part=null;
 }
 if(part)buckets[part].push(...ids);else removed.push(...ids);
}
const meshes=[];
let cuffFit;
for(const [part,ids]of Object.entries(buckets)){
 const geo=part==='boots'?clipY(subset(g,ids),-Infinity,-.70):subset(g,ids),pos=geo.attributes.position;
 for(let i=0;i<pos.count;i++){
  let x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);
  if(part==='hat'){x*=3.0;y=(y-.70)*3.0+4.36;z=z*3.05;}
  else if(part==='boots'){const side=Math.sign(x)||1;x=side*.280+(x-side*.100)*2.6;y=(y+.950)*2.6;z=z*2.6+.06;}
  else {x*=2.65;y=y*2.60+2.43;z*=2.65;
   if(y>2.75)y+=.05*T.MathUtils.smoothstep(Math.abs(x),.4,.9);
  }
  const c=source.sample(geo.attributes.uv.getX(i),geo.attributes.uv.getY(i)),green=c[1]>c[0]*1.08&&c[1]>c[2]*1.08;
  if(part==='sleeves'&&Math.abs(x)>.43&&y>2.75&&!green){y=3.16+(y-3.125)*1.30;z=-.01+(z+.01)*1.30;}
  pos.setXYZ(i,x,y,z);
 }
 if(part==='boots'){
  // Keep the boot shaft outside the fitted sock. The previous source shaft
  // was narrower than our ankle, so the purple strap disappeared into it.
  for(let i=0;i<pos.count;i++){const v=new T.Vector3().fromBufferAttribute(pos,i),side=v.x>=0?1:-1,scale=1+.20*T.MathUtils.smoothstep(v.y,.28,.43);pos.setXYZ(i,side*.28+(v.x-side*.28)*scale,v.y,.032+(v.z-.032)*scale);}
 }
 // Preserve source normals (same shape and UV); only normalise for the small
 // anisotropic fitting scale, never recalculate across texture seams.
 const normals=geo.attributes.normal;for(let i=0;i<normals.count;i++){const n=new T.Vector3().fromBufferAttribute(normals,i).normalize();normals.setXYZ(i,n.x,n.y,n.z);}
 const mesh=bind(geo,part);
 meshes.push(mesh);
}
// Green belongs to the leaf collar and buckles, not the purple undershirt.
// Split only the erroneous sleeve islands into a purple material; source UVs
// and all intended embroidery/candy/collar artwork remain untouched.
for(const mesh of [...meshes]){if(mesh.userData.part!=='sleeves')continue;const g=mesh.geometry,p=g.attributes.position,uv=g.attributes.uv,keep=[],correct=[];
 for(let t=0;t<g.index.count;t+=3){const ids=[0,1,2].map(k=>g.index.getX(t+k)),u=new T.Vector2(),v=new T.Vector3();ids.forEach(i=>{u.add(new T.Vector2().fromBufferAttribute(uv,i));v.add(new T.Vector3().fromBufferAttribute(p,i));});u.divideScalar(3);v.divideScalar(3);const c=source.sample(u.x,u.y),green=c[1]>c[0]*1.08&&c[1]>c[2]*1.08;(green&&(Math.abs(v.x)>.74||v.y<3.18)?correct:keep).push(...ids);}
 if(!correct.length)continue;mesh.geometry=subset(g,keep);const patch=new T.SkinnedMesh(subset(g,correct),new T.MeshStandardMaterial({name:'corrected_purple_sleeve',color:'#4c1877',roughness:.9,side:T.DoubleSide}));patch.name='Halloween_pumpkin_sleeve_colour_repair';patch.userData={...mesh.userData};root.add(patch);patch.bind(sk,body.bindMatrix);meshes.push(patch);
}
// The generated figure has no hidden shirt torso. Reuse our approved fitted
// sweater torso to make the extracted sleeves independently wearable.
const mother=await readGlb('public/room3d/wardrobe/fitted-sweater-rig.glb');
const mb=packGlb(stripImages(mother.json),mother.bin),mr=(await new GLTFLoader().parseAsync(mb.buffer.slice(mb.byteOffset,mb.byteOffset+mb.byteLength),'')).scene;
mr.traverse(m=>{if(!m.isSkinnedMesh||!m.name.startsWith('Apparel_'))return;
 const gg=m.geometry,pp=gg.attributes.position,ids=[];
 for(let t=0;t<gg.index.count;t+=3){const tri=[0,1,2].map(k=>gg.index.getX(t+k));ids.push(...tri);}
 if(!ids.length)return;const torso=clipY(subset(gg,ids).applyMatrix4(m.bindMatrix),-1.30,1.30,0);torso.morphAttributes={};
 const mesh=bind(torso,'sleeves');mesh.name='Halloween_pumpkin_undershirt_torso';mesh.material=new T.MeshStandardMaterial({name:'approved_purple_shirt',color:'#4c1877',roughness:.9,side:T.DoubleSide});meshes.push(mesh);
});
const shortsSource=await readGlb('public/room3d/wardrobe/sailor-school-user.glb'),shortsBytes=packGlb(stripImages(shortsSource.json),shortsSource.bin),shortsRoot=(await new GLTFLoader().parseAsync(shortsBytes.buffer.slice(shortsBytes.byteOffset,shortsBytes.byteOffset+shortsBytes.byteLength),'')).scene;
shortsRoot.traverse(m=>{if(!m.isSkinnedMesh||!m.name.startsWith('Sailor_pants'))return;
 const geo=m.geometry.clone().applyMatrix4(m.bindMatrix),p=geo.attributes.position;
 for(let i=0;i<p.count;i++){const y=p.getY(i);p.setY(i,y-.08*(1-T.MathUtils.smoothstep(y,1.95,2.25)));}
 const mesh=bind(geo,'romper');mesh.name='Halloween_pumpkin_fitted_shorts';mesh.material=new T.MeshStandardMaterial({name:'approved_purple_cuffs',color:'#4c1877',roughness:.9,side:T.DoubleSide});
 cuffFit={...fitPumpkinCuffs(geo,legTrees,sk),source:'sailor-school-user.glb#Sailor_pants',sourceTriangles:548};smoothFittedNormals(geo);meshes.push(mesh);console.log('Cuff fit',cuffFit);
});
// Preview body is deliberately a separate original project mesh; wearable
// exports contain the skeleton and clothing only, with no generated human.
body.name='CurrentBody';
await saveGlb(root,out+'/pumpkin-preview.glb');
await embedTexture(out+'/pumpkin-preview.glb',source,'HalloweenAtlas');
body.removeFromParent();
// Root bone was originally below the body. Keep it when exporting clothes.
root.attach(sk.bones[0]);root.updateMatrixWorld(true);
await saveGlb(root,out+'/pumpkin-wearables.glb');await embedTexture(out+'/pumpkin-wearables.glb',source,'HalloweenAtlas');
const report={source:'reduced/pumpkin-costume-34000.glb',body:'current-body.glb',bones:sk.bones.length,parts:meshes.map(m=>({name:m.name,triangles:m.geometry.index.count/3})),removedTriangles:removed.length/3,cuffFit,status:'fitting candidate; visual and motion QA in progress'};
await fs.writeFile(out+'/manifest.json',JSON.stringify(report,null,2));console.log(report);
// The ghost source contains only the hooded top and a generated mannequin.
// Keep the complete hood/top silhouette; discard its head, hands and legs.
meshes.forEach(m=>m.removeFromParent());kind='ghost';source=await loadTextured(dir+'/reduced/ghost-top-24000.glb');
const gg=source.geo,gp=gg.attributes.position,guv=gg.attributes.uv,kept=[];
for(let t=0;t<gg.index.count;t+=3){const ids=[0,1,2].map(k=>gg.index.getX(t+k)),v=new T.Vector3(),uv=new T.Vector2();for(const i of ids){v.add(new T.Vector3().fromBufferAttribute(gp,i));uv.add(new T.Vector2().fromBufferAttribute(guv,i));}v.divideScalar(3);uv.divideScalar(3);
 const color=source.sample(uv.x,uv.y),skin=skinColor(color),exposed=v.y<-.13||Math.abs(v.x)>.64||v.y>.31&&v.y<.77&&Math.abs(v.x)<.36||v.y>.27&&Math.abs(v.x)<.075;
 if(v.y>-.30&&!(skin&&exposed))kept.push(...ids);
}
const ghost=subset(gg,kept),pos=ghost.attributes.position;
for(let i=0;i<pos.count;i++){
 const sy=pos.getY(i),head=T.MathUtils.smoothstep(sy,.28,.43);let x=pos.getX(i)*T.MathUtils.lerp(2.45,3.05,head),y=T.MathUtils.lerp(sy*2.4+2.62,3.32+(sy-.30)*3.4,head),z=pos.getZ(i)*T.MathUtils.lerp(2.65,3.15,head);
 const origin=y>3.5?new T.Vector3(0,y,0):Math.abs(x)>.40?new T.Vector3(x,3.125,-.01):null;
 if(origin){const point=new T.Vector3(x,y,z),d=point.clone().sub(origin),r=d.length();if(r>1e-6){d.normalize();const hit=tree.raycastFirst(new T.Ray(origin,d),T.DoubleSide);if(hit&&hit.distance<1&&r<hit.distance+.035){point.copy(origin).addScaledVector(d,hit.distance+.035);[x,y,z]=point.toArray();}}}
 pos.setXYZ(i,x,y,z);
}
const gm=bind(ghost,'hooded-top');
// Close the two small ear welds in the existing inner hood. These local lining
// patches do not cover the face opening or add another mannequin/head.
const boundary=boundaryLoops(ghost).flatMap(l=>l.vertices),patches=[];
// The fused source never had lining behind the generated skull. Reuse the
// existing hood back surface, offset inward, instead of leaving a white disc
// visible through the empty hood when the real body is switched off.
const liningIds=[];for(let t=0;t<ghost.index.count;t+=3){const ids=[0,1,2].map(k=>ghost.index.getX(t+k)),p=ghost.attributes.position,n=ghost.attributes.normal;if(ids.every(i=>p.getY(i)>3.60&&p.getZ(i)<-.16)&&ids.reduce((a,i)=>a+n.getZ(i),0)<-.9)liningIds.push(...ids);}
const lining=subset(ghost,liningIds);for(let i=0;i<lining.attributes.position.count;i++){const p=lining.attributes.position,n=lining.attributes.normal;p.setXYZ(i,p.getX(i)-n.getX(i)*.018,p.getY(i)-n.getY(i)*.018,p.getZ(i)-n.getZ(i)*.018);}const lm=bind(lining,'hood-lining');lm.material=new T.MeshStandardMaterial({name:'hood_inner_back_lining',color:'#51128a',roughness:.9,side:T.DoubleSide});patches.push(lm);
function hull(points){const a=points.sort((a,b)=>a.y-b.y||a.z-b.z),cross=(a,b,c)=>(b.y-a.y)*(c.z-a.z)-(b.z-a.z)*(c.y-a.y),lo=[],hi=[];for(const v of a){while(lo.length>1&&cross(lo.at(-2),lo.at(-1),v)<=0)lo.pop();lo.push(v);}for(const v of a.slice().reverse()){while(hi.length>1&&cross(hi.at(-2),hi.at(-1),v)<=0)hi.pop();hi.push(v);}return lo.slice(0,-1).concat(hi.slice(0,-1));}
for(const side of [-1,1]){const region=boundary.filter(v=>v.x*side>.70&&v.x*side<.88&&v.y>3.65&&v.y<4.15&&v.z>-.11&&v.z<.13),loop=hull(region);
 if(loop.length<3)continue;const center=loop.reduce((a,v)=>a.add(v),new T.Vector3()).divideScalar(loop.length),points=loop.map(v=>new T.Vector3(center.x,center.y+(v.y-center.y)*1.08,center.z+(v.z-center.z)*1.08)),geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(points.flatMap(v=>v.toArray()),3));const ids=[];for(let i=1;i<points.length-1;i++)ids.push(0,i,i+1);geo.setIndex(ids);geo.computeVertexNormals();const m=bind(geo,'hood-lining');m.material=new T.MeshStandardMaterial({name:'hood_lining_repair',color:'#51128a',roughness:.9,side:T.DoubleSide});patches.push(m);}
// Reuse the approved body's shoulder shell beneath the generated cloth seam.
mr.traverse(m=>{if(!m.isSkinnedMesh||!m.name.startsWith('Apparel_'))return;const g=m.geometry,p=g.attributes.position,ids=[];for(let t=0;t<g.index.count;t+=3){const tri=[0,1,2].map(k=>g.index.getX(t+k));if(tri.every(i=>Math.abs(p.getX(i))<.85&&p.getY(i)>2.97))ids.push(...tri);}if(!ids.length)return;const geo=subset(g,ids);geo.applyMatrix4(m.bindMatrix);geo.morphAttributes={};const mesh=bind(geo,'hood-underlay');mesh.material=new T.MeshStandardMaterial({name:'approved_white_shoulder_underlay',color:'#f4eff4',roughness:.9,side:T.DoubleSide});patches.push(mesh);});
await saveGlb(root,out+'/ghost-wearables.glb');await embedTexture(out+'/ghost-wearables.glb',source,'HalloweenAtlas');
report.ghost={source:'reduced/ghost-top-24000.glb',triangles:gm.geometry.index.count/3,repairTriangles:patches.reduce((n,m)=>n+m.geometry.index.count/3,0),removedTriangles:(gg.index.count-kept.length)/3,bones:sk.bones.length};await fs.writeFile(out+'/manifest.json',JSON.stringify(report,null,2));console.log(report.ghost);
