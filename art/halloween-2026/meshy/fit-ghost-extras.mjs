import fs from 'node:fs/promises';
import * as T from 'three';
import {loadTextured,subset,embedTexture} from './textured-geometry.mjs';
import {fittingRig} from './wardrobe-fit-utils.mjs';
import {clipY} from './clip-garment.mjs';
import {saveGlb} from '../../jellyfish-home/asset-geometry.mjs';
import {fitFootwear} from './footwear-landmarks.mjs';
const dir='art/halloween-2026/meshy',report=[];
for(const part of ['shorts','shoes']){
 const source=await loadTextured(dir+'/reduced/ghost-'+part+'-22000.glb'),g=source.geo,p=g.attributes.position,uv=g.attributes.uv,ids=[];
 for(let t=0;t<g.index.count;t+=3){const tri=[0,1,2].map(k=>g.index.getX(t+k)),v=new T.Vector3(),u=new T.Vector2();for(const i of tri){v.add(new T.Vector3().fromBufferAttribute(p,i));u.add(new T.Vector2().fromBufferAttribute(uv,i));}v.divideScalar(3);u.divideScalar(3);const c=source.sample(u.x,u.y),skin=c[0]>140&&c[1]>110&&c[2]>95&&Math.max(...c)-Math.min(...c)<100;
  if(part==='shorts'?v.y<.08&&v.y>-.285&&!skin:v.y<-.73&&!skin)ids.push(...tri);
 }
 const geo=clipY(subset(g,ids),part==='shorts'?-.272:-Infinity,part==='shorts'?.054:Infinity),pos=geo.attributes.position,rig=await fittingRig();
 for(let i=0;i<pos.count;i++){const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i),sign=x>=0?1:-1;if(part==='shorts')pos.setXYZ(i,sign*.28+(x-sign*.105)*2.65,1.57+(y+.272)*(.72/.326),z*2.65);else pos.setXYZ(i,sign*.28+(x-sign*.09)*2.7,(y+.952)*2.05,z*2.7+.02);}
 if(part==='shoes')fitFootwear(geo,rig.body,{lowShoe:true});
 if(part==='shorts')for(let i=0;i<pos.count;i++){const y=pos.getY(i);pos.setY(i,1.57+(y-1.57)*(.95/.72));}
 rig.fitSurface(geo,part);rig.bind(geo,part,'ghost');rig.clothesOnly();const file=dir+'/assembled/ghost-'+part+'-wearables.glb';await saveGlb(rig.root,file);await embedTexture(file,source,'HalloweenAtlas');report.push({part,triangles:geo.index.count/3,file,bones:48});
}
await fs.writeFile(dir+'/assembled/ghost-extras-manifest.json',JSON.stringify(report,null,2));console.log(report);
