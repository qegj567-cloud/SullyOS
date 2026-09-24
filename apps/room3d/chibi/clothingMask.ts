import * as T from 'three';

/** Refine only mask boundaries below preserveAboveY.
 * Skin weights interpolate as bone/weight pairs (never interpolate bone IDs).
 * Shoulder layering can preserve whole original faces: interpolated rest
 * positions and weights do not preserve the original posed triangle surface.
 * The original geometry remains available for exact undressing/restoration.
 */
export function createClothingMask(source:T.BufferGeometry,covers:(p:T.Vector3)=>boolean,preserveAboveY=Infinity){
 const names=Object.keys(source.attributes),arrays=Object.fromEntries(names.map(name=>[name,Array.from(source.attributes[name].array)]));
 const originalCount=source.attributes.position.count,midpoints=new Map<string,number>(),point=new T.Vector3();
 const covered:boolean[]=Array.from({length:originalCount},(_,i)=>covers(point.fromBufferAttribute(source.attributes.position,i)));
 const index:number[]=[],groups:typeof source.groups=[];
 const midpoint=(a:number,b:number)=>{
  const key=a<b?`${a}:${b}`:`${b}:${a}`;const old=midpoints.get(key);if(old!==undefined)return old;
  const n=arrays.position.length/3;midpoints.set(key,n);
  for(const name of names){if(name==='skinIndex'||name==='skinWeight')continue;const size=source.attributes[name].itemSize;for(let j=0;j<size;j++)arrays[name].push((arrays[name][a*size+j]+arrays[name][b*size+j])/2);}
  const weights=new Map<number,number>();for(const v of [a,b])for(let j=0;j<4;j++){const bone=arrays.skinIndex[v*4+j],w=arrays.skinWeight[v*4+j]/2;weights.set(bone,(weights.get(bone)??0)+w);}
  const top=[...weights].sort((a,b)=>b[1]-a[1]).slice(0,4),sum=top.reduce((s,v)=>s+v[1],0);
  for(let j=0;j<4;j++){arrays.skinIndex.push(top[j]?.[0]??0);arrays.skinWeight.push((top[j]?.[1]??0)/(sum||1));}
  point.fromArray(arrays.normal,n*3).normalize().toArray(arrays.normal,n*3);
  covered.push(covers(point.fromArray(arrays.position,n*3)));return n;
 };
 const emit=(a:number,b:number,c:number,depth:number)=>{
  const states=[covered[a],covered[b],covered[c]];
  point.set((arrays.position[a*3]+arrays.position[b*3]+arrays.position[c*3])/3,(arrays.position[a*3+1]+arrays.position[b*3+1]+arrays.position[c*3+1])/3,(arrays.position[a*3+2]+arrays.position[b*3+2]+arrays.position[c*3+2])/3);
  const center=covers(point);
  if(states.every(Boolean)&&center)return;
  if(Math.max(arrays.position[a*3+1],arrays.position[b*3+1],arrays.position[c*3+1])>=preserveAboveY){index.push(a,b,c);return;}
  if(states.every(v=>!v)&&!center){index.push(a,b,c);return;}
  if(depth===3){if(!center)index.push(a,b,c);return;}
  const ab=midpoint(a,b),bc=midpoint(b,c),ca=midpoint(c,a);emit(a,ab,ca,depth+1);emit(ab,b,bc,depth+1);emit(ca,bc,c,depth+1);emit(ab,bc,ca,depth+1);
 };
 for(const group of source.groups){const start=index.length;for(let t=group.start;t<group.start+group.count;t+=3)emit(source.index!.getX(t),source.index!.getX(t+1),source.index!.getX(t+2),0);groups.push({...group,start,count:index.length-start});}
 const geometry=new T.BufferGeometry();for(const name of names){const attr=source.attributes[name];geometry.setAttribute(name,name==='skinIndex'?new T.Uint16BufferAttribute(arrays[name],attr.itemSize):new T.Float32BufferAttribute(arrays[name],attr.itemSize));}geometry.setIndex(index);geometry.groups=groups;geometry.userData={...source.userData};return geometry;
}
