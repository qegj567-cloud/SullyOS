import * as T from 'three';
import {fittingRig} from './wardrobe-fit-utils.mjs';
const r=await fittingRig(),p=r.body.geometry.attributes.position;
for(const y of [.05,.15,.26,1.06,1.9,2.01,2.3,2.46,2.52,2.8]){const box=new T.Box3();for(let i=0;i<p.count;i++)if(Math.abs(p.getY(i)-y)<.05&&(y>1.9?Math.abs(p.getX(i))<.6:p.getX(i)>0))box.expandByPoint(new T.Vector3().fromBufferAttribute(p,i));console.log(y,box.min.toArray(),box.max.toArray());}
for(const b of r.sk.bones.filter(b=>/foot|shin|thigh|spine|hips/.test(b.name)))console.log(b.name,new T.Vector3().setFromMatrixPosition(b.matrixWorld).toArray());
