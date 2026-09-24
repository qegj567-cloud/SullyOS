import {expect,it} from 'vitest';
import data from '../apps/room3d/chibi/hoodieClothes.json';
import {closeFootwearSeams} from '../apps/room3d/chibi/closeFootwearSeams';
it('closes both medial ankle/sole cuts while retaining both authored cuffs and every original vertex',()=>{
 const source=data[1],positions:number[]=[],indices:number[]=[],sides:number[]=[],vertices=new Map<string,number>();
 for(let t=0;t<source.indices.length;t+=3){const tri=source.indices.slice(t,t+3),side=tri.reduce((n,i)=>n+source.positions[i*3],0)>=0?1:-1;
  for(const i of tri){const key=`${side}:${i}`;let id=vertices.get(key);if(id===undefined){id=positions.length/3;vertices.set(key,id);positions.push(...source.positions.slice(i*3,i*3+3));sides[id]=side;}indices.push(id);}
 }
 const base=positions.slice(),faces=indices.slice();
 const boundary=()=>{const edges=new Map<string,{a:number;b:number;n:number}>();for(let t=0;t<indices.length;t+=3)for(let j=0;j<3;j++){const a=indices[t+j],b=indices[t+(j+1)%3],key=[a,b].sort((a,b)=>a-b).join(':');const e=edges.get(key);if(e)e.n++;else edges.set(key,{a,b,n:1});}return [...edges.values()].filter(e=>e.n===1);};
 const medial=(e:{a:number;b:number})=>[e.a,e.b].every(i=>Math.abs(positions[i*3])<.012&&positions[i*3+1]<-.26);
 const before=boundary(),cuffs=before.filter(e=>!medial(e));expect(before.filter(medial)).toHaveLength(38);
 closeFootwearSeams(positions,indices,sides);
 expect(positions).toEqual(base);expect(indices.slice(0,faces.length)).toEqual(faces);expect(boundary().filter(medial)).toHaveLength(0);expect(boundary()).toEqual(cuffs);
 expect(indices.length-faces.length).toBe(90);
 for(let t=faces.length;t<indices.length;t+=3)expect(new Set(indices.slice(t,t+3).map(i=>sides[i])).size).toBe(1);
 const once=indices.slice();closeFootwearSeams(positions,indices,sides);expect(indices).toEqual(once);
});
