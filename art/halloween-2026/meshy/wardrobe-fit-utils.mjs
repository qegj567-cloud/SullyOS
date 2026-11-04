import fs from 'node:fs/promises';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshBVH} from 'three-mesh-bvh';
import {subset} from './textured-geometry.mjs';

export async function fittingRig(){
 const bytes=await fs.readFile('art/halloween-2026/meshy/current-body.glb');
 const root=(await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene;
 let body;root.traverse(o=>{if(o.isSkinnedMesh)body=o;});root.updateMatrixWorld(true);
 const sk=body.skeleton,bg=body.geometry,tree=new MeshBVH(bg,{indirect:true}),legs={};
 for(const sign of [-1,1]){const ids=[],p=bg.attributes.position;for(let t=0;t<bg.index.count;t+=3){const tri=[0,1,2].map(k=>bg.index.getX(t+k));if(tri.every(i=>p.getX(i)*sign>0&&p.getY(i)<2.25))ids.push(...tri);}const geo=subset(bg,ids);legs[sign]={geo,tree:new MeshBVH(geo,{indirect:true})};}
 const joint=n=>{const i=sk.bones.findIndex(b=>b.name===n);if(i<0)throw Error(n);return i;};
 function bind(g,part,id){
  smooth(g);const p=g.attributes.position,si=[],sw=[];
  for(let i=0;i<p.count;i++){
   const v=new T.Vector3().fromBufferAttribute(p,i),side=v.x>=0?'L':'R',map=new Map();
   if(['hat','cap'].includes(part))map.set(joint('head'),1);
   else if(part==='cravat')map.set(joint('chest'),1);
   else if(part==='boots'||part==='shoes'){const w=T.MathUtils.smoothstep(v.y,.25,.65);map.set(joint(side+'_foot'),1-w);map.set(joint(side+'_shin'),w);}
   else if(['shorts','trousers'].includes(part)){
    const thigh=T.MathUtils.smoothstep(v.y,1.00,1.27),hips=T.MathUtils.smoothstep(v.y,1.97,2.28);
    map.set(joint(side+'_shin'),(1-thigh)*(1-hips));map.set(joint(side+'_thigh'),thigh*(1-hips));map.set(joint('hips'),hips);
   }else if((['dress','apron','tailcoat'].includes(part)&&v.y<2.65)||Math.abs(v.x)<.43){const w=T.MathUtils.smoothstep(v.y,2.23,3.0);map.set(joint('hips'),1-w);map.set(joint('chest'),w);}
   else{
    const query=v.clone();if(Math.abs(v.x)>.48&&(v.y>2.4||part==='sleeves'))query.y=3.125;
    const hit=tree.closestPointToPoint(query),ids=[0,1,2].map(k=>bg.index.getX(hit.faceIndex*3+k));
    const tri=new T.Triangle(...ids.map(i=>new T.Vector3().fromBufferAttribute(bg.attributes.position,i))),bary=tri.getBarycoord(hit.point,new T.Vector3());
    ids.forEach((vi,n)=>{for(let k=0;k<4;k++){let ji=bg.attributes.skinIndex.getComponent(vi,k),name=sk.bones[ji].name;if(/_(thumb|index|middle|ring|pinky)/.test(name))ji=joint(name[0]+'_hand');const w=bg.attributes.skinWeight.getComponent(vi,k)*bary.getComponent(n);map.set(ji,(map.get(ji)||0)+w);}});
   }
   const list=[...map].filter(([,w])=>w>1e-7).sort((a,b)=>b[1]-a[1]).slice(0,4),sum=list.reduce((n,[,w])=>n+w,0);if(!sum)throw Error('Unbound '+part);
   for(let k=0;k<4;k++){si.push(list[k]?.[0]||0);sw.push((list[k]?.[1]||0)/sum);}
  }
  g.setAttribute('skinIndex',new T.Uint16BufferAttribute(si,4));g.setAttribute('skinWeight',new T.Float32BufferAttribute(sw,4));
  const m=new T.SkinnedMesh(g,new T.MeshStandardMaterial({name:'HalloweenAtlas',color:0xffffff,roughness:.9,side:T.DoubleSide}));
  m.name='Halloween_'+id+'_'+part;m.userData={part,body:'current 48-bone project body',source:'Meshy, mannequin removed'};root.add(m);m.bind(sk,body.bindMatrix);return m;
 }
 function fitSurface(g,part){
  const p=g.attributes.position;
  if(!['shorts','trousers','hat','cap','collar'].includes(part))return;
  // Fit authored vertices to the local body cross-section; preserve UVs and hem heights.
  for(let i=0;i<p.count;i++){
   const v=new T.Vector3().fromBufferAttribute(p,i);let origin,ref=tree,margin=.035;
   if(['shorts','trousers'].includes(part)&&v.y<1.99){const sign=v.x>=0?1:-1,thigh=new T.Vector3().setFromMatrixPosition(sk.boneInverses[joint((sign>0?'L':'R')+'_thigh')].clone().invert()),knee=new T.Vector3().setFromMatrixPosition(sk.boneInverses[joint((sign>0?'L':'R')+'_shin')].clone().invert());origin=knee.lerp(thigh,T.MathUtils.clamp((v.y-knee.y)/(thigh.y-knee.y),0,1));origin.y=v.y;ref=legs[sign].tree;margin=.045;}
   else if(part==='collar'){origin=new T.Vector3(0,v.y,0);margin=.035;}
   else if(['hat','cap'].includes(part)&&v.y<4.9){origin=new T.Vector3(0,v.y,0);margin=.075;}
   else if(!['boots','shoes','hat','cap'].includes(part)&&v.y>2.65&&Math.abs(v.x)>.42)origin=new T.Vector3(v.x,3.125,-.01);
   else if(v.y>2.0&&v.y<3.18&&!['boots','shoes'].includes(part))origin=new T.Vector3(0,v.y,0);
   if(!origin)continue;const d=v.clone().sub(origin),r=d.length();if(r<1e-5)continue;d.normalize();const hit=ref.raycastFirst(new T.Ray(origin,d),T.DoubleSide,0,1.3);if(hit&&r<hit.distance+margin){v.copy(origin).addScaledVector(d,hit.distance+margin);p.setXYZ(i,v.x,v.y,v.z);}
  }
  // Checking vertices alone misses skin through long, thin triangles. Match
  // the cuff fitter: also check face centres and edge midpoints, moving all
  // coincident UV vertices together. Do not expand inward-facing hem returns.
  // The hat is a rigid head shell. Broad cloth sleeves need their authored
  // drape; applying the head-style radial solver there folds the cuffs.
  if(!['hat','cap'].includes(part))return;
  const groups=new Map(),keys=[];for(let i=0;i<p.count;i++){const key=[p.getX(i),p.getY(i),p.getZ(i)].map(x=>Math.round(x*1e5)).join(',');keys[i]=key;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(i);}
  function radial(v){let origin,ref=tree;
   if(['hat','cap'].includes(part)){if(v.y<3.6||v.y>4.88)return;origin=new T.Vector3(0,v.y,0);}
   else if(['shorts','trousers'].includes(part)&&v.y<2.0){const side=v.x>=0?'L':'R',a=new T.Vector3().setFromMatrixPosition(sk.boneInverses[joint(side+'_thigh')].clone().invert()),b=new T.Vector3().setFromMatrixPosition(sk.boneInverses[joint(side+'_shin')].clone().invert());origin=b.lerp(a,T.MathUtils.clamp((v.y-b.y)/(a.y-b.y),0,1));origin.y=v.y;ref=legs[v.x>=0?1:-1].tree;}
   else if(v.y>2.7&&Math.abs(v.x)>.42)origin=new T.Vector3(v.x,3.125,-.01);
   else if(v.y>2.05&&v.y<3.30&&Math.abs(v.x)<.44)origin=new T.Vector3(0,v.y,0);
   if(!origin)return;const direction=v.clone().sub(origin),radius=direction.length();if(radius<1e-5)return;direction.normalize();const hit=ref.raycastFirst(new T.Ray(origin,direction),T.DoubleSide,0,1.3);if(hit)return {direction,gap:radius-hit.distance};
  }
  for(let pass=0;pass<4;pass++){const moves=new Map();for(let t=0;t<g.index.count;t+=3){const ids=[0,1,2].map(k=>g.index.getX(t+k)),tri=new T.Triangle(...ids.map(i=>new T.Vector3().fromBufferAttribute(p,i))),normal=tri.getNormal(new T.Vector3()),middle=tri.getMidpoint(new T.Vector3()),hit=radial(middle);if(!hit||normal.dot(hit.direction)<.2)continue;
    for(const weights of [[1/3,1/3,1/3],[.5,.5,0],[.5,0,.5],[0,.5,.5]]){const point=new T.Vector3();ids.forEach((i,k)=>point.addScaledVector(new T.Vector3().fromBufferAttribute(p,i),weights[k]));const sample=radial(point);if(!sample||sample.gap>=.025)continue;for(const i of ids)moves.set(keys[i],Math.max(moves.get(keys[i])||0,Math.min(.075,(.027-sample.gap)*1.05)));}
   }if(!moves.size)break;for(const [key,distance]of moves){const ids=groups.get(key),v=new T.Vector3().fromBufferAttribute(p,ids[0]),hit=radial(v);if(!hit)continue;v.addScaledVector(hit.direction,distance);for(const i of ids)p.setXYZ(i,v.x,v.y,v.z);}
  }
 }
 function clothesOnly(){root.attach(sk.bones[0]);body.removeFromParent();root.updateMatrixWorld(true);}
 return {root,body,sk,tree,legs,bind,fitSurface,clothesOnly};
}
export function smooth(g){g.computeVertexNormals();const p=g.attributes.position,n=g.attributes.normal,groups=new Map(),keys=[];for(let i=0;i<p.count;i++){const key=[p.getX(i),p.getY(i),p.getZ(i)].map(x=>Math.round(x*1e5)).join(',');keys.push(key);if(!groups.has(key))groups.set(key,new T.Vector3());groups.get(key).add(new T.Vector3().fromBufferAttribute(n,i));}for(let i=0;i<p.count;i++){const v=groups.get(keys[i]).normalize();if(v.lengthSq()<.5)v.set(0,1,0);n.setXYZ(i,v.x,v.y,v.z);}}
