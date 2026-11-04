import * as T from 'three';
export function boundaryLoops(g){
 const p=g.attributes.position,keys=[],points=[],lookup=new Map(),edges=new Map();
 for(let i=0;i<p.count;i++){const v=new T.Vector3().fromBufferAttribute(p,i),key=v.toArray().map(n=>Math.round(n*1e5)).join(',');if(!lookup.has(key)){lookup.set(key,points.length);points.push(v);}keys.push(lookup.get(key));}
 for(let t=0;t<g.index.count;t+=3){const tri=[0,1,2].map(k=>keys[g.index.getX(t+k)]);for(let k=0;k<3;k++){const a=tri[k],b=tri[(k+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`;if(a!==b){const e=edges.get(key);if(e)e.count++;else edges.set(key,{a,b,count:1});}}}
 const neighbors=new Map();for(const e of edges.values())if(e.count===1)for(const [a,b]of [[e.a,e.b],[e.b,e.a]]){if(!neighbors.has(a))neighbors.set(a,[]);neighbors.get(a).push(b);}
 const visited=new Set(),loops=[];for(const start of neighbors.keys()){if(visited.has(start))continue;const ids=[];let last=-1,current=start,closed=false;for(let n=0;n<100000;n++){if(visited.has(current)){closed=current===start;break;}visited.add(current);ids.push(current);const next=(neighbors.get(current)||[]).find(x=>x!==last&&!visited.has(x))??(neighbors.get(current)||[]).find(x=>x===start);if(next===undefined)break;last=current;current=next;}
 const vs=ids.map(i=>points[i]),box=new T.Box3().setFromPoints(vs);loops.push({vertices:vs,closed,count:vs.length,min:box.min.toArray(),max:box.max.toArray()});}
 return loops;
}
