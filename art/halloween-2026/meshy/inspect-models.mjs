import fs from 'node:fs/promises';
import * as T from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {readGeometry,splitParts,compactGeometry,saveGlb} from '../../jellyfish-home/asset-geometry.mjs';
const root='art/halloween-2026/meshy';
const reports=[];
const second=process.argv.includes('--second');
for(const id of second?['pumpkin-costume-t2','ghost-top-t2','pumpkin-hat-t2']:['pumpkin-costume','ghost-costume','pumpkin-lantern']){
 const file=root+(second?'/halloween-batch-02/':'/halloween-batch-01/')+id+'.glb';
 const raw=await fs.readFile(file),json=JSON.parse(raw.subarray(20,20+raw.readUInt32LE(12)));
 const geometries=await readGeometry(file),geometry=mergeGeometries(geometries),parts=splitParts(geometry),group=new T.Group();
 const report={id,sourceMeshes:json.meshes.length,sourceImages:json.images?.length||0,triangles:geometry.index.count/3,parts:[]};
 for(const [i,part]of parts.entries()){
  const g=await compactGeometry(geometry,part.ids);const m=new T.Mesh(g,new T.MeshStandardMaterial({color:new T.Color().setHSL((i*.618)%1,.65,.55),roughness:1,side:T.DoubleSide}));m.name='part_'+i;group.add(m);
  report.parts.push({index:i,triangles:part.count,min:part.box.min.toArray(),max:part.box.max.toArray(),center:part.center.toArray()});
 }
 await saveGlb(group,root+'/'+id+'-parts.glb');reports.push(report);
}
await fs.writeFile(root+(second?'/geometry-report-02.json':'/geometry-report.json'),JSON.stringify(reports,null,2));
console.log(reports.map(r=>({id:r.id,triangles:r.triangles,parts:r.parts.map(p=>({index:p.index,triangles:p.triangles,min:p.min.map(n=>+n.toFixed(3)),max:p.max.map(n=>+n.toFixed(3))}))})));
