import * as T from 'three';

/** Close only the medial holes created when the touching original leg shells
 * were separated. Cuff boundaries stay open; existing vertices/weights stay
 * intact. Earcut triangulates the non-convex loop in its medial YZ plane. */
export function closeFootwearSeams(positions:number[],indices:number[],sides:number[]){
 const edges=new Map<string,{a:number;b:number;count:number}>();
 for(let i=0;i<indices.length;i+=3)for(let j=0;j<3;j++){
  const a=indices[i+j],b=indices[i+(j+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`;
  const e=edges.get(key);if(e)e.count++;else edges.set(key,{a,b,count:1});
 }
 const open=[...edges.values()].filter(e=>e.count===1),next=new Map(open.map(e=>[e.a,e.b])),seen=new Set<number>();
 for(const edge of open){
  if(seen.has(edge.a))continue;
  const loop:number[]=[];let id:number|undefined=edge.a;
  while(id!==undefined&&!seen.has(id)){seen.add(id);loop.push(id);id=next.get(id);}
  if(id!==edge.a||loop.length<3)continue;
  // The authored cuff is around y=-.235; only the cut at x=0 is missing.
  if(!loop.every(i=>Math.abs(positions[i*3])<.012&&positions[i*3+1]<-.26&&sides[i]===sides[edge.a]))continue;
  const contour=loop.map(i=>new T.Vector2(positions[i*3+1],positions[i*3+2]));
  for(const tri of T.ShapeUtils.triangulateShape(contour,[])){
   const ids=tri.map(i=>loop[i]),a=new T.Vector3().fromArray(positions,ids[0]*3),b=new T.Vector3().fromArray(positions,ids[1]*3),c=new T.Vector3().fromArray(positions,ids[2]*3);
   // Outward on the inner side of each separated leg.
   if(b.sub(a).cross(c.sub(a)).x*sides[edge.a]>0)ids.reverse();
   indices.push(...ids);
  }
 }
}
