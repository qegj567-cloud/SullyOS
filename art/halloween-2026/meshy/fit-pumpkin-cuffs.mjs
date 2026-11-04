import * as T from 'three';

// Same local surface/weight transfer used by fitSockSurface: fit to the actual
// leg at the opening, then check chords as well as vertices. Keep the authored
// hem height, UVs and topology. No body-mask expansion.
export function fitPumpkinCuffs(g,legTrees,skeleton){
 const p=g.attributes.position,si=g.attributes.skinIndex,sw=g.attributes.skinWeight;
 const rest=new Map(skeleton.bones.map((b,i)=>[b.name,new T.Vector3().setFromMatrixPosition(skeleton.boneInverses[i].clone().invert())]));
 const eligible=new Set(),groups=new Map(),keys=[];
 for(let i=0;i<p.count;i++){const v=new T.Vector3().fromBufferAttribute(p,i),key=v.toArray().map(x=>Math.round(x*1e5)).join(',');keys[i]=key;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(i);if(v.y<2.075)eligible.add(i);}
 const ray=new T.Ray(),v=new T.Vector3(),bary=new T.Vector3(),tri=new T.Triangle();
 function surface(point){const side=point.x>=0?'L':'R',thigh=rest.get(side+'_thigh'),knee=rest.get(side+'_shin');
  const origin=knee.clone().lerp(thigh,T.MathUtils.clamp((point.y-knee.y)/(thigh.y-knee.y),0,1));origin.y=point.y;
  const delta=point.clone().sub(origin),radius=delta.length();if(radius<1e-6)return null;
  const direction=delta.divideScalar(radius),ref=legTrees[point.x>=0?1:-1];ray.set(origin,direction);
  const hit=ref.tree.raycastFirst(ray,T.DoubleSide,0,.65);if(!hit?.face)return null;
  return {origin,direction,hit,ref,gap:radius-hit.distance};
 }
 const samples=[[1,0,0],[0,1,0],[0,0,1],[.5,.5,0],[0,.5,.5],[.5,0,.5],[1/3,1/3,1/3]];
 function scan(){let minimum=Infinity,count=0;const moves=new Map();
  for(let t=0;t<g.index.count;t+=3){const ids=[0,1,2].map(k=>g.index.getX(t+k));if(!ids.every(i=>eligible.has(i))||!ids.every(i=>Math.sign(p.getX(i))===Math.sign(p.getX(ids[0]))))continue;
   // Rolled hems include horizontal return faces. Their centre lies inside
   // the leg opening by design; treating those as side walls creates spikes.
   tri.setFromAttributeAndIndices(p,...ids);const normal=tri.getNormal(new T.Vector3());if(Math.abs(normal.y)>.65)continue;
   const middle=tri.getMidpoint(new T.Vector3()),midHit=surface(middle);if(!midHit||normal.dot(midHit.direction)<.25)continue;
   for(const w of samples){const point=new T.Vector3();ids.forEach((i,k)=>point.addScaledVector(v.fromBufferAttribute(p,i),w[k]));const hit=surface(point);if(!hit)continue;minimum=Math.min(minimum,hit.gap);count++;
    if(hit.gap<.025)ids.forEach((i,k)=>{if(w[k])moves.set(keys[i],Math.max(moves.get(keys[i])||0,(.027-hit.gap)*1.15));});
   }
  }return {minimum,count,moves};
 }
 const before=scan(),moved=new Set();
 for(let pass=0;pass<10;pass++){
  const check=scan();if(!check.moves.size)break;
  for(const [key,distance]of check.moves){const ids=groups.get(key),point=new T.Vector3().fromBufferAttribute(p,ids[0]),hit=surface(point);if(!hit)continue;point.addScaledVector(hit.direction,distance);for(const id of ids){p.setXYZ(id,point.x,point.y,point.z);moved.add(id);}}
 }
 // Local skin weights follow the same skin surface on this leg, including
 // hips/thigh blending. Never query the opposite leg at the inseam.
 let rebound=0;
 for(const i of eligible){if(p.getY(i)>2.035)continue;const hit=surface(v.fromBufferAttribute(p,i));if(!hit)continue;const {ref}=hit,face=hit.hit.face,bp=ref.geo.attributes.position,bi=ref.geo.attributes.skinIndex,bw=ref.geo.attributes.skinWeight;
  tri.setFromAttributeAndIndices(bp,face.a,face.b,face.c);tri.getBarycoord(hit.hit.point,bary);const map=new Map();
  [face.a,face.b,face.c].forEach((id,k)=>{for(let n=0;n<4;n++){const bone=bi.getComponent(id,n),w=bw.getComponent(id,n)*bary.getComponent(k);if(w>0)map.set(bone,(map.get(bone)||0)+w);}});
  const top=[...map].sort((a,b)=>b[1]-a[1]).slice(0,4),sum=top.reduce((a,x)=>a+x[1],0);if(sum<1e-8)continue;
  for(let k=0;k<4;k++){si.setComponent(i,k,top[k]?.[0]||0);sw.setComponent(i,k,(top[k]?.[1]||0)/sum);}rebound++;
 }
 // The open lower tube belongs to its own thigh, rather than the pelvis.
 // Blend upward inside the roomy pumpkin shell, away from the visible rim.
 for(let i=0;i<p.count;i++){if(p.getY(i)>2.23)continue;const side=p.getX(i)>=0?'L':'R',thigh=skeleton.bones.findIndex(b=>b.name===side+'_thigh'),hips=skeleton.bones.findIndex(b=>b.name==='hips'),weight=1-T.MathUtils.smoothstep(p.getY(i),1.97,2.23);si.setXYZW(i,thigh,hips,0,0);sw.setXYZW(i,weight,1-weight,0,0);}
 const after=scan();p.needsUpdate=si.needsUpdate=sw.needsUpdate=true;
 return {sampleCount:after.count,beforeMinimumGap:before.minimum,afterMinimumGap:after.minimum,movedVertices:moved.size,reboundVertices:rebound,hemHeightUnchanged:true,topologyUnchanged:true};
}
