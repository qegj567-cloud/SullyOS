import * as T from 'three';
import {mergeVertices} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
// Cut the geometry at the colour boundary instead of colouring whole crossing triangles.
export function cutSurface(g,distance){
 const p=g.attributes.position,n=g.attributes.normal,result=[];
 for(const sign of [-1,1]){const vertices=[],normals=[];
  for(let i=0;i<g.index.count;i+=3){const poly=[0,1,2].map(k=>{const id=g.index.getX(i+k);return {p:new T.Vector3().fromBufferAttribute(p,id),n:new T.Vector3().fromBufferAttribute(n,id)};}),cut=[];
   for(let k=0;k<3;k++){const a=poly[k],b=poly[(k+1)%3],da=sign*distance(a.p),db=sign*distance(b.p);if(da>=0)cut.push(a);if((da>=0)!==(db>=0)){const t=da/(da-db);cut.push({p:a.p.clone().lerp(b.p,t),n:a.n.clone().lerp(b.n,t).normalize()});}}
   for(let k=1;k<cut.length-1;k++)for(const v of [cut[0],cut[k],cut[k+1]]){vertices.push(...v.p.toArray());normals.push(...v.n.toArray());}
  }
  const out=new T.BufferGeometry();out.setAttribute('position',new T.Float32BufferAttribute(vertices,3));out.setAttribute('normal',new T.Float32BufferAttribute(normals,3));result.push(mergeVertices(out,1e-6));
 }
 return result;
}
export function chairCushion(v){return Math.max((v.x/.37)**2+((v.y+.05)/.34)**2-1,(-v.z-.24)*5,(-v.y-.30)*5,(v.y-.17)*5);}
