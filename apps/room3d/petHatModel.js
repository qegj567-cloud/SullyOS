import * as T from 'three';
import {normalizePetHat} from './petWardrobe.js';
const material=(name,color)=>new T.MeshStandardMaterial({name:'pet-hat-'+name,color,roughness:.9});
/** Independent removable geometry. Its resources are owned by this instance. */
export function createPetHat(id){
 if(!normalizePetHat(id))return null;
 const root=new T.Group();root.name='pet-hat-'+id;root.userData.petHat=true;
 const add=(g,m,x=0,y=0,z=0)=>{g.deleteAttribute('uv');const mesh=new T.Mesh(g,m);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;mesh.userData.petHat=true;root.add(mesh);return mesh;};
 if(id==='witch'){
  const purple=material('felt','#48415d'),green=material('ribbon','#8caa79'),gold=material('buckle','#d8ba72');
  const brim=add(new T.CylinderGeometry(.55,.55,.065,24),purple,0,.025);brim.scale.z=.86;
  const points=[new T.Vector2(.31,.04),new T.Vector2(.32,.10),new T.Vector2(.26,.34),new T.Vector2(.17,.57),new T.Vector2(.08,.78),new T.Vector2(0,.91)];
  const crown=new T.LatheGeometry(points,20),p=crown.attributes.position;
  for(let i=0;i<p.count;i++){const y=p.getY(i);p.setX(i,p.getX(i)+Math.max(0,y-.35)**2*.8);}crown.computeVertexNormals();add(crown,purple);
  add(new T.CylinderGeometry(.291,.322,.115,20),green,0,.16);
  const buckle=add(new T.TorusGeometry(.06,.014,4,4),gold,0,.16,.31);buckle.rotation.z=Math.PI/4;
 }else{
  const orange=material('pumpkin','#d99152'),stem=material('stem','#71966a'),dark=material('face','#4f4051');
  for(let i=0;i<6;i++){const a=i*Math.PI/3,m=add(new T.SphereGeometry(.27,12,8),orange,Math.sin(a)*.19,.18,Math.cos(a)*.19);m.scale.set(.9,.74,.9);}
  const stalk=add(new T.CylinderGeometry(.055,.075,.18,8),stem,.015,.44,0);stalk.rotation.z=-.22;
  const leaf=add(new T.SphereGeometry(.09,8,5),stem,.11,.40,0);leaf.scale.set(1.5,.22,.7);leaf.rotation.z=.3;
  for(const x of [-.12,.12]){const eye=add(new T.ConeGeometry(.049,.077,3),dark,x,.23,.416);eye.rotation.x=Math.PI/2;}
 }
 return root;
}
/** Fit to the actual head surface near the eyes, avoiding tails and ears. */
export function attachPetHat(visual,id,asset){
 const hat=createPetHat(id);if(!hat)return null;
 const scale=visual.scale.clone();visual.scale.setScalar(1);visual.updateWorldMatrix(true,true);
 const bounds=new T.Box3().setFromObject(visual),eyes=new T.Box3(),meshes=[];
 visual.traverse(o=>{if(!o.isMesh)return;meshes.push(o);if((Array.isArray(o.material)?o.material:[o.material]).some(m=>m.name==='pet-eyes'))eyes.union(new T.Box3().setFromObject(o));});
 const size=bounds.getSize(new T.Vector3()),center=eyes.isEmpty()?bounds.getCenter(new T.Vector3()):eyes.getCenter(new T.Vector3());
 center.z-=size.z*.12;center.y=bounds.max.y+.1;
 const hit=new T.Raycaster(center,new T.Vector3(0,-1,0)).intersectObjects(meshes,false)[0];
 const top=hit?.point??new T.Vector3(0,bounds.max.y,0);hat.position.copy(visual.worldToLocal(top.clone()));hat.position.y-=.015;
 const width=T.MathUtils.clamp(size.x*.47,.24,.42);hat.scale.setScalar(width);hat.rotation.z=id==='witch'?-.12:0;
 visual.add(hat);visual.scale.copy(scale);visual.updateWorldMatrix(true,true);return hat;
}
