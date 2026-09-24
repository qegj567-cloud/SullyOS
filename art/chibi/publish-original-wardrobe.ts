import * as T from 'three';
import {GLTFExporter} from 'three/examples/jsm/exporters/GLTFExporter.js';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createBlankBody,BLANK_SCALE} from '../../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../../apps/room3d/chibi/blankRig';
import {prepareHoodie} from '../../apps/room3d/chibi/hoodieClothes';

// Reuse the original runtime fit and weights, rather than rebuilding the outfit.
class Reader {result:unknown;onloadend?:()=>void;readAsArrayBuffer(b:Blob){void b.arrayBuffer().then(v=>{this.result=v;this.onloadend?.();});}}
(globalThis as unknown as {FileReader:unknown}).FileReader=Reader;
const scene=new T.Scene(),body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial()),hair=new T.Group();scene.add(body,hair);
const rig=bindBlankBody(body,hair,true);rig.setPose('bind');const original=prepareHoodie(rig);
// The skeleton is normally parented to the body. Export it independently,
// with clothing only, so catalog items cannot import a duplicate body.
scene.attach(rig.bones.root);rig.mesh.removeFromParent();hair.removeFromParent();
const definitions=[
 {id:'original-hoodie',label:'初始连帽卫衣',slot:'top',part:0,group:undefined},
 {id:'original-socks',label:'初始长袜',slot:'socks',part:1,group:0},
 {id:'original-shoes',label:'初始便鞋',slot:'shoes',part:1,group:1},
];
const entries=[];
for(const def of definitions){
 const source=original.meshes[def.part],g=new T.BufferGeometry(),sourceIndex=source.geometry.index!,group=def.group===undefined?{start:0,count:sourceIndex.count}:source.geometry.groups[def.group];
 const used:number[]=[],remap=new Map<number,number>(),indices:number[]=[];
 for(let i=group.start;i<group.start+group.count;i++){const old=sourceIndex.getX(i);if(!remap.has(old)){remap.set(old,used.length);used.push(old);}indices.push(remap.get(old)!);}
 for(const [name,attr] of Object.entries(source.geometry.attributes)){
  const array=new (attr.array.constructor as {new(length:number):typeof attr.array})(used.length*attr.itemSize);
  used.forEach((old,i)=>{for(let j=0;j<attr.itemSize;j++)array[i*attr.itemSize+j]=attr.array[old*attr.itemSize+j];});
  g.setAttribute(name,new T.BufferAttribute(array,attr.itemSize,attr.normalized));
 }
 g.setIndex(indices);g.computeBoundingBox();g.computeBoundingSphere();
 const material=(Array.isArray(source.material)?source.material[def.group??0]:source.material).clone(),mesh=new T.SkinnedMesh(g,material);mesh.name=def.id;mesh.bind(rig.skeleton,rig.mesh.bindMatrix);scene.add(mesh);
 entries.push({id:def.id,label:def.label,slot:def.slot,asset:'original-outfit.glb',prefix:def.id,...(def.slot==='shoes'?{opening:(.5-.427)*BLANK_SCALE}:{}),triangles:indices.length/3});
}
scene.updateMatrixWorld(true);rig.skeleton.update();
const glb=await new GLTFExporter().parseAsync(scene,{binary:true,onlyVisible:true}) as ArrayBuffer,bytes=Buffer.from(glb),revision=createHash('sha256').update(bytes).digest('hex').slice(0,12);
mkdirSync('public/room3d/wardrobe',{recursive:true});writeFileSync('public/room3d/wardrobe/original-outfit.glb',bytes);
const published=entries.map(e=>({...e,revision}));writeFileSync('art/chibi/original-wardrobe.json',JSON.stringify(published,null,2)+'\n');
const catalogPath='apps/room3d/chibi/approvedWardrobe.json',catalog=JSON.parse(readFileSync(catalogPath,'utf8')).filter((e:{id:string})=>!definitions.some(d=>d.id===e.id));
writeFileSync(catalogPath,JSON.stringify([...catalog,...published],null,2)+'\n');
console.log(JSON.stringify({bytes:bytes.length,items:published}));original.dispose();
