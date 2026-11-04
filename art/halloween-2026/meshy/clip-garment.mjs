import * as T from 'three';
// Exact seam clipping interpolates existing UVs, instead of leaving saw-tooth
// triangle selection at a horizontal waist/cuff. It never caps the opening.
export function clipY(g,min=-Infinity,max=Infinity,axis=1){
 const names=Object.keys(g.attributes),arrays=Object.fromEntries(names.map(n=>[n,[]]));let count=0;
 const lerp=(a,b,t)=>{const v=Object.fromEntries(names.map(n=>[n,a[n].map((v,k)=>v+(b[n][k]-v)*t)]));if(a.skinIndex&&a.skinWeight){const weights=new Map();for(const [source,factor]of [[a,1-t],[b,t]])for(let k=0;k<4;k++)weights.set(source.skinIndex[k],(weights.get(source.skinIndex[k])||0)+source.skinWeight[k]*factor);const top=[...weights].filter(([,w])=>w>0).sort((a,b)=>b[1]-a[1]).slice(0,4),sum=top.reduce((n,[,w])=>n+w,0);v.skinIndex=Array.from({length:4},(_,k)=>top[k]?.[0]||0);v.skinWeight=Array.from({length:4},(_,k)=>(top[k]?.[1]||0)/sum);}return v;};
 for(let i=0;i<g.index.count;i+=3){let poly=[0,1,2].map(k=>{const id=g.index.getX(i+k);return Object.fromEntries(names.map(n=>[n,Array.from({length:g.attributes[n].itemSize},(_,j)=>g.attributes[n].getComponent(id,j))]));});
  for(const [level,sign]of [[min,1],[max,-1]]){if(!Number.isFinite(level))continue;const next=[];for(let k=0;k<poly.length;k++){const a=poly[k],b=poly[(k+1)%poly.length],insideA=(a.position[axis]-level)*sign>=0,insideB=(b.position[axis]-level)*sign>=0;if(insideA)next.push(a);if(insideA!==insideB)next.push(lerp(a,b,(level-a.position[axis])/(b.position[axis]-a.position[axis])));}poly=next;}
  for(let k=1;k<poly.length-1;k++)for(const v of [poly[0],poly[k],poly[k+1]]){for(const n of names)arrays[n].push(...v[n]);count++;}
 }
 const result=new T.BufferGeometry();for(const n of names)result.setAttribute(n,n==='skinIndex'?new T.Uint16BufferAttribute(arrays[n],g.attributes[n].itemSize):new T.Float32BufferAttribute(arrays[n],g.attributes[n].itemSize));result.setIndex(Array.from({length:count},(_,i)=>i));return result;
}
