import fs from 'node:fs/promises';
import * as T from 'three';
import {loadTextured,subset,embedTexture} from './textured-geometry.mjs';
import {fittingRig} from './wardrobe-fit-utils.mjs';
import {saveGlb} from '../../jellyfish-home/asset-geometry.mjs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {readGlb,packGlb,stripImages} from './glb-utils.mjs';
import {clipY} from './clip-garment.mjs';
import {fitFootwear} from './footwear-landmarks.mjs';
import {addWitchCollar} from './witch-collar.mjs';

const dir='art/halloween-2026/meshy',out=dir+'/assembled';
const specs={witch:{file:'witch-40000',arm:.25,waist:.025,boots:-.68,legCenter:.085},count:{file:'count-34000',arm:.30,waist:.01,boots:-.65,legCenter:.085},apprentice:{file:'apprentice-38000',arm:.265,waist:.09,boots:-.74,legCenter:.085},shorts:{file:'shorts-22000',waist:.09,hem:-.29,legCenter:.085}};
function skin(c){const [r,g,b]=c;return r>135&&g>105&&b>90&&r>=g*.97&&g>=b*.94&&r-b<100&&Math.max(r,g,b)-Math.min(r,g,b)<100;}
function lerpY(y,anchors){for(let i=1;i<anchors.length;i++)if(y<=anchors[i][0])return T.MathUtils.lerp(anchors[i-1][1],anchors[i][1],(y-anchors[i-1][0])/(anchors[i][0]-anchors[i-1][0]));const a=anchors.at(-2),b=anchors.at(-1);return b[1]+(y-b[0])*(b[1]-a[1])/(b[0]-a[0]);}
const reports=[];
for(const id of (process.argv.length>2?process.argv.slice(2):Object.keys(specs))){
 const spec=specs[id],source=await loadTextured(dir+'/reduced/'+spec.file+'.glb'),g=source.geo,p=g.attributes.position,uv=g.attributes.uv,buckets={},rig=await fittingRig();let removed=0;
 for(let t=0;t<g.index.count;t+=3){const ids=[0,1,2].map(k=>g.index.getX(t+k)),v=new T.Vector3(),u=new T.Vector2();for(const i of ids){v.add(new T.Vector3().fromBufferAttribute(p,i));u.add(new T.Vector2().fromBufferAttribute(uv,i));}v.divideScalar(3);u.divideScalar(3);const c=source.sample(u.x,u.y),ax=Math.abs(v.x),isSkin=skin(c);let part;
  if(id==='shorts'){if(v.y<.12&&v.y>-.38&&!(isSkin&&(v.y<-.31||v.y>.025)))part='shorts';}
  if(id==='witch'){
   if(v.y>.43&&!isSkin)part='hat';
   else if(v.y<spec.boots)part='boots';
   else if(v.y>-.47&&v.y<.38&&!(isSkin&&(ax>.58||v.y>.33&&ax<.08||v.y<-.425)))part=ax>.26&&v.y>-.08?'sleeves':'dress';
   if(v.y>.10&&v.y<.40&&ax<.30&&c[0]>90&&c[1]>85&&c[2]>75&&Math.max(...c)-Math.min(...c)<65)part='collar';
   if(part==='dress'&&v.y>.10&&v.y<.34&&ax<.30){
    const light=ids.filter(i=>{const q=source.sample(uv.getX(i),uv.getY(i));return q[0]>120&&q[1]>115&&q[2]>100&&Math.max(...q)-Math.min(...q)<75;}).length;
    if(light>=2)part='collar';
   }
   if(part!=='hat'&&v.y>.34&&v.y<.44&&ax<.085)part=null;
  }
  if(id==='count'){
   if(v.y<spec.boots)part='boots';
   else if(v.y<.43&&!(isSkin&&(ax>.62||v.y>.38))){
    if(v.y<-.05&&(v.y<-.14||ax<.165)&&!(v.z<-.10&&v.y>-.22))part='trousers';
    else if(v.z>.10&&ax<.08&&v.y>.205&&c[0]>c[2]*1.35)part='cravat';
    else if(v.z>.075&&ax<.09&&v.y>-.01&&v.y<.23)part='waistcoat';
    else part='tailcoat';
   }
  }
  if(id==='apprentice'){
   if(v.y>.43&&!isSkin&&(v.y>.69||v.z<-.05||ax>.24))part='cap';
   else if(v.y<spec.boots)part='boots';
   else if(v.y>-.435&&v.y<-.19)part='shorts';
   else if(v.y>-.20&&v.y<.38&&!(isSkin&&(ax>.54||v.y>.35&&ax<.08))){
    part=v.y<.10&&v.z>-.055?'apron':'coat';
   }
  }
  if(id==='apprentice'&&part==='coat'&&v.y>.345&&ax<.15&&c[0]>c[2]*.95&&c[1]>c[2]*.9)part=null;
  if(part)(buckets[part]??=[]).push(...ids);else removed++;
 }
 const meshes=[];
 for(const [part,ids]of Object.entries(buckets)){
  if(part==='collar')continue;
  let geo=subset(g,ids);
  if(part==='boots')geo=clipY(geo,-Infinity,spec.boots);
  if(part==='shorts')geo=clipY(geo,id==='shorts'?-.34:-.414,id==='shorts'?.08:Infinity);
  const pos=geo.attributes.position;geo.computeBoundingBox();const sourceWaist=geo.boundingBox.max.y,targetWaist=rig.sk.bones.find(b=>b.name==='spine').getWorldPosition(new T.Vector3()).y;
  for(let i=0;i<pos.count;i++){
   let x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);const sign=x>=0?1:-1;
   if(['hat','cap'].includes(part)){const center=id==='witch'?.62:.65;x*=3.0;y=(y-center)*3.0+4.18;z*=3.0;}
   else if(part==='boots'){x=sign*.28+(x-sign*spec.legCenter)*2.6;y=(y+.952)*(.60/(spec.boots+.952));z=z*2.6+.035;}
   else if(id==='shorts'){const rise=T.MathUtils.smoothstep(y,-.16,sourceWaist);x*=T.MathUtils.lerp(2.65,2.05,rise);y=lerpY(y,[[-.34,1.50],[-.16,1.91],[sourceWaist,targetWaist]]);z*=T.MathUtils.lerp(2.65,2.25,rise);}
   else{
    x*=2.65;z*=2.65;
    y=lerpY(y,id==='witch'?[[-.952,0],[spec.boots,.60],[-.47,1.62],[spec.waist,2.52],[spec.arm,3.125],[.40,3.40]]:[[-.952,0],[spec.boots,.60],[-.4,1.35],[spec.waist,2.52],[spec.arm,3.125],[.40,3.40]]);
    // Shared continuous deformation across material/part boundaries; splitting
    // a garment must not give its coincident seam vertices different positions.
    if(['witch','apprentice'].includes(id)&&['dress','sleeves','coat','apron','collar'].includes(part)){const arm=T.MathUtils.smoothstep(Math.abs(x),.30,.85),upper=T.MathUtils.smoothstep(y,1.5,2.3);x*=1+.28*upper*(1-arm);z*=1+upper*T.MathUtils.lerp(.40,.28,arm);y+=.09*T.MathUtils.smoothstep(y,2.3,2.95);}
    if(id==='count'&&['tailcoat','waistcoat','cravat'].includes(part)){const arm=T.MathUtils.smoothstep(Math.abs(x),.3,.85),upper=T.MathUtils.smoothstep(y,2.1,2.6);x*=1+.08*upper*(1-arm);z*=1+.15*upper;y+=.045*T.MathUtils.smoothstep(y,2.25,2.95);}
    if(id==='count'&&part==='trousers'&&y<1.2){const w=1-T.MathUtils.smoothstep(y,.85,1.2);x=sign*.28+(x-sign*.28)*(1+.15*w);z=.03+(z-.03)*(1+.15*w);}
   }
   if(id==='witch'&&['dress','sleeves','collar'].includes(part)){const shoulder=T.MathUtils.smoothstep(Math.abs(x),.28,.43)*(1-T.MathUtils.smoothstep(Math.abs(x),.65,.95))*T.MathUtils.smoothstep(y,2.95,3.18);y+=.11*shoulder;}
   pos.setXYZ(i,x,y,z);
  }
  if(part==='boots')fitFootwear(geo,rig.body);
  if(part!=='collar')rig.fitSurface(geo,part);const mesh=rig.bind(geo,part,id);if(id==='witch'&&['sleeves','collar'].includes(part))mesh.userData.part='dress';if(part==='collar')mesh.material=new T.MeshStandardMaterial({name:'clean_white_collar',color:'#fff8ef',roughness:.9,side:T.DoubleSide});meshes.push(mesh);
 }
 if(id==='witch')meshes.push(addWitchCollar(rig));
 if(id==='count'){
  // A fitted cloth lining bridges the generated trouser/boot seam without
  // enlarging the body mask. Reuse the approved sock surface on its own leg.
  const sock=await readGlb(dir+'/fitted-socks/base.glb'),sb=packGlb(stripImages(sock.json),sock.bin),sr=(await new GLTFLoader().parseAsync(sb.buffer.slice(sb.byteOffset,sb.byteOffset+sb.byteLength),'')).scene;
  sr.traverse(m=>{if(!m.isSkinnedMesh)return;const geo=clipY(m.geometry.clone().applyMatrix4(m.bindMatrix),.48,.82);geo.morphAttributes={};const lining=rig.bind(geo,'trousers',id);lining.name='Halloween_count_ankle_lining';lining.material=new T.MeshStandardMaterial({name:'approved_ankle_lining',color:'#171719',roughness:.9,side:T.DoubleSide});meshes.push(lining);});
  const mother=await readGlb('public/room3d/wardrobe/fitted-sweater-rig.glb'),b=packGlb(stripImages(mother.json),mother.bin),mr=(await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene;
  mr.traverse(m=>{if(!m.isSkinnedMesh||!m.name.startsWith('Apparel_'))return;const g=m.geometry.clone().applyMatrix4(m.bindMatrix),p=g.attributes.position,ids=[];for(let t=0;t<g.index.count;t+=3){const tri=[0,1,2].map(k=>g.index.getX(t+k));if(tri.every(i=>p.getY(i)>2.22&&p.getY(i)<3.13&&Math.abs(p.getX(i))<.43&&p.getZ(i)<.08))ids.push(...tri);}const geo=subset(g,ids);geo.morphAttributes={};const m2=rig.bind(geo,'waistcoat',id);m2.material=new T.MeshStandardMaterial({name:'approved_waistcoat_back',color:'#431d63',roughness:.9,side:T.DoubleSide});meshes.push(m2);});
 }

 // Restore hidden cloth behind the original mannequin seams using the approved
 // fitted sweater. This is a garment lining, not retained generated skin.
 if(id==='apprentice'){
  const mother=await readGlb('public/room3d/wardrobe/fitted-sweater-rig.glb'),b=packGlb(stripImages(mother.json),mother.bin),mr=(await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene;
  mr.traverse(m=>{if(!m.isSkinnedMesh||!m.name.startsWith('Apparel_'))return;const g=m.geometry.clone().applyMatrix4(m.bindMatrix),p=g.attributes.position,ids=[];for(let t=0;t<g.index.count;t+=3){const tri=[0,1,2].map(k=>g.index.getX(t+k));if(tri.every(i=>p.getY(i)<2.53&&Math.abs(p.getX(i))<.55))ids.push(...tri);}const geo=subset(g,ids);geo.morphAttributes={};const mesh=rig.bind(geo,'coat',id);mesh.name='Halloween_apprentice_hidden_shirt_waist';mesh.material=new T.MeshStandardMaterial({name:'approved_shirt_waist',color:'#a8cd25',roughness:.9,side:T.DoubleSide});meshes.push(mesh);});
  const pants=await readGlb('public/room3d/wardrobe/sailor-school-user.glb'),pb=packGlb(stripImages(pants.json),pants.bin),pr=(await new GLTFLoader().parseAsync(pb.buffer.slice(pb.byteOffset,pb.byteOffset+pb.byteLength),'')).scene;
  pr.traverse(m=>{if(!m.isSkinnedMesh||!m.name.startsWith('Sailor_pants'))return;const geo=clipY(m.geometry.clone().applyMatrix4(m.bindMatrix),1.77,Infinity);geo.morphAttributes={};rig.fitSurface(geo,'shorts');const mesh=rig.bind(geo,'shorts',id);mesh.name='Halloween_apprentice_hidden_short_waist';mesh.material=new T.MeshStandardMaterial({name:'approved_short_waist',color:'#3b1454',roughness:.9,side:T.DoubleSide});meshes.push(mesh);});
 }
 rig.clothesOnly();await saveGlb(rig.root,out+'/'+id+'-wearables.glb');await embedTexture(out+'/'+id+'-wearables.glb',source,'HalloweenAtlas');
 const report={id,source:'reduced/'+spec.file+'.glb',bones:48,parts:meshes.map(m=>({part:m.userData.part,triangles:m.geometry.index.count/3})),removedTriangles:removed,texturePreserved:true};reports.push(report);console.log(report);
}
await fs.writeFile(out+'/remaining-manifest.json',JSON.stringify(reports,null,2));
