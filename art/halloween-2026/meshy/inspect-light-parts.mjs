import fs from 'node:fs/promises';
import * as T from 'three';
import {readGeometry,splitParts,compactGeometry,saveGlb} from '../../jellyfish-home/asset-geometry.mjs';
const dir='art/halloween-2026/meshy';
for(const [id,n]of [['pumpkin-costume',34000],['ghost-top',24000]]){
 const [g]=await readGeometry(`${dir}/reduced/${id}-${n}.glb`),parts=splitParts(g),root=new T.Group(),report=[];
 for(const [i,p]of parts.entries()){report.push({i,count:p.count,min:p.box.min.toArray(),max:p.box.max.toArray()});const mesh=new T.Mesh(await compactGeometry(g,p.ids),new T.MeshStandardMaterial({color:new T.Color().setHSL((i*.618)%1,.6,.55),roughness:1,side:T.DoubleSide}));mesh.name='part_'+i;root.add(mesh);}
 await saveGlb(root,`${dir}/reduced/${id}-parts.glb`);await fs.writeFile(`${dir}/reduced/${id}-parts.json`,JSON.stringify(report,null,2));console.log(id,report);
}
