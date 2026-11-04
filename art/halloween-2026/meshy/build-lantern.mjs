import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import * as T from 'three';
import {readGeometry,compactGeometry,saveGlb} from '../../jellyfish-home/asset-geometry.mjs';
import {sliceBands} from '../../chibi/clothing-import-utils.mjs';
const dir='art/halloween-2026/meshy',id='halloween_pumpkin_lantern';
const [source]=await readGeometry(dir+'/halloween-batch-01/pumpkin-lantern.glb');
const simplified=await compactGeometry(source,Array.from(source.index.array),3100);
const geometry=sliceBands(simplified,[.095,.17,.215,.365]);
const colors={pumpkin:'#ff690b',leaf:'#8bbf22',iron:'#24202c',light:'#ffcb32'};
const mats=Object.fromEntries(Object.entries(colors).map(([name,color])=>[name,new T.MeshStandardMaterial({name:'halloween_'+name,color,roughness:name==='iron'?.55:.8,...(name==='light'?{emissive:'#ffb322',emissiveIntensity:.55}:{})})]));
function region(v,n){
 if(v.y>.17){
  const ring=Math.hypot(v.x-.001,v.y-.305);
  if(v.y>.365||(v.y>.29&&v.x>.09)||(ring>.115&&v.y>.215))return 'iron';
  if(v.y<.215&&Math.hypot(v.x,v.z)>.07)return 'iron';
  return 'leaf';
 }
 if(v.y>.095&&Math.hypot(v.x,v.z)<.25)return 'leaf';
 // The generated recesses have inset back walls. Paint the recessed front
 // geometry directly, without reading pixels or carrying source textures.
 const shell=.405*Math.sqrt(Math.max(0,1-(v.x/.405)**2-((v.y+.135)/.345)**2));
 if(v.z>.08&&Math.abs(v.x)<.28&&v.y<.10&&shell-v.z>(v.y<-.16?.035:.075)&&n.z>.25)return 'light';
 return 'pumpkin';
}
const p=geometry.attributes.position,buckets={};
for(let i=0;i<geometry.index.count;i+=3){const ids=[0,1,2].map(k=>geometry.index.getX(i+k)),vs=ids.map(id=>new T.Vector3().fromBufferAttribute(p,id)),v=vs[0].clone().add(vs[1]).add(vs[2]).divideScalar(3),n=vs[1].clone().sub(vs[0]).cross(vs[2].clone().sub(vs[0])).normalize(),name=region(v,n);(buckets[name]??=[]).push(...ids);}
const root=new T.Group();geometry.computeBoundingBox();const b=geometry.boundingBox,size=b.getSize(new T.Vector3()),center=b.getCenter(new T.Vector3()),scale=.36/size.x;
for(const [name,ids]of Object.entries(buckets)){const g=await compactGeometry(geometry,ids);g.translate(-center.x,-b.min.y,-center.z).scale(scale,scale,scale);const mesh=new T.Mesh(g,mats[name]);mesh.name=id+'_'+name;root.add(mesh);}
const triangles=root.children.reduce((n,m)=>n+m.geometry.index.count/3,0);if(triangles>=4000)throw Error('Lantern exceeds per-piece budget');
await saveGlb(root,dir+'/pumpkin-lantern-colored.glb');
const finalSize=size.multiplyScalar(scale).toArray(),report={id,name:'万圣节南瓜提灯',surface:'tabletop',url:id+'.glb',size:finalSize,default:[0,.15,0],boxes:[[-finalSize[0]/2,0,-finalSize[2]/2,finalSize[0]/2,finalSize[1],finalSize[2]/2]],collection:'living',paintMaterials:Object.keys(mats).map(k=>'halloween_'+k),colorParts:Object.entries(colors).map(([name,color])=>({material:'halloween_'+name,label:{pumpkin:'南瓜',leaf:'叶片',iron:'提环',light:'灯芯'}[name],color})),triangles};
await fs.writeFile(dir+'/lantern-entry.json',JSON.stringify(report,null,2));console.log(report);
