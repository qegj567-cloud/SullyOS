import * as T from 'three';

/** Split the authored centre seam before skinning. A face spanning both feet
 * otherwise stretches into a ribbon when the feet move apart. Keep UVs and
 * normals at the cut, but give each copy only its own leg's influences. */
export function splitHalloweenShoeSeam(geometry:T.BufferGeometry,bones:readonly T.Bone[]){
 const position=geometry.getAttribute('position'),index=geometry.index;
 if(!index)return;
 const crosses=(ids:number[])=>ids.some(i=>position.getX(i)<0)&&ids.some(i=>position.getX(i)>0);
 if(!Array.from({length:index.count/3},(_,t)=>crosses([0,1,2].map(k=>index.getX(t*3+k)))).some(Boolean))return;
 const attributes=Object.entries(geometry.attributes),values=Object.fromEntries(attributes.map(([name])=>[name,[] as number[]]));
 type Vertex=Record<string,number[]>;
 const vertex=(id:number):Vertex=>Object.fromEntries(attributes.map(([name,a])=>[name,Array.from({length:a.itemSize},(_,k)=>a.getComponent(id,k))]));
 const mix=(a:Vertex,b:Vertex):Vertex=>{
  const t=a.position[0]/(a.position[0]-b.position[0]);
  const v=Object.fromEntries(attributes.map(([name])=>[name,a[name].map((n,k)=>T.MathUtils.lerp(n,b[name][k],t))]));
  const weights=new Map<number,number>();
  for(const [source,factor]of [[a,1-t],[b,t]] as const)source.skinIndex.forEach((joint,k)=>weights.set(joint,(weights.get(joint)||0)+source.skinWeight[k]*factor));
  const influences=[...weights].filter(([,w])=>w>0).sort((a,b)=>b[1]-a[1]).slice(0,4);
  v.position[0]=0;v.skinIndex=Array.from({length:4},(_,i)=>influences[i]?.[0]??0);v.skinWeight=Array.from({length:4},(_,i)=>influences[i]?.[1]??0);return v;
 };
 const emit=(v:Vertex,side:number)=>{
  const weights=new Map<number,number>();
  v.skinIndex.forEach((joint,k)=>{const name=bones[joint].name,target=/^[LR]_/.test(name)?bones.findIndex(b=>b.name===(side>0?'L':'R')+name.slice(1)):joint;weights.set(target,(weights.get(target)||0)+v.skinWeight[k]);});
  const list=[...weights].filter(([,w])=>w>0),sum=list.reduce((s,[,w])=>s+w,0);
  v={...v,skinIndex:Array.from({length:4},(_,k)=>list[k]?.[0]??0),skinWeight:Array.from({length:4},(_,k)=>(list[k]?.[1]??0)/sum)};
  for(const [name]of attributes)values[name].push(...v[name]);
 };
 const groups=geometry.groups.length?geometry.groups:[{start:0,count:index.count,materialIndex:0}];
 geometry.clearGroups();let count=0;
 for(const group of groups){const start=count;
  for(let t=group.start;t<group.start+group.count;t+=3){const ids=[0,1,2].map(k=>index.getX(t+k)),triangle=ids.map(vertex);
   if(!crosses(ids)){const side=triangle.reduce((s,v)=>s+v.position[0],0)>=0?1:-1;triangle.forEach(v=>emit(v,side));count+=3;continue;}
   for(const side of [-1,1]){const polygon:Vertex[]=[];for(let k=0;k<3;k++){const a=triangle[k],b=triangle[(k+1)%3],inside=a.position[0]*side>=0;
    if(inside)polygon.push(a);if(inside!==(b.position[0]*side>=0))polygon.push(mix(a,b));}
    for(let k=1;k<polygon.length-1;k++){[polygon[0],polygon[k],polygon[k+1]].forEach(v=>emit(v,side));count+=3;}
   }
  }geometry.addGroup(start,count-start,group.materialIndex);
 }
 for(const [name,a]of attributes)geometry.setAttribute(name,name==='skinIndex'?new T.Uint16BufferAttribute(values[name],a.itemSize):new T.Float32BufferAttribute(values[name],a.itemSize));
 geometry.setIndex(Array.from({length:count},(_,i)=>i));geometry.normalizeNormals();
}
