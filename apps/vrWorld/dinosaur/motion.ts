import * as T from 'three';
/** Three tiny morph channels keep each toy at one draw call, including eyes and markings. */
export function prepareToyMotion(mesh:T.Mesh,species:string) {
  const tall=['halloween-dinosaur','tyrannosaurus','velociraptor','parasaurolophus','dinosaur-fossil'].includes(species);
  const long=['brachiosaurus','plesiosaur','aiven-chimera'].includes(species);
  const pivot=new T.Vector3(long?.25:.4,long?1.2:tall?1.45:.65,0);
  const pos=mesh.geometry.getAttribute('position'),head=new Float32Array(pos.count*3),tail=new Float32Array(pos.count*3),feet=new Float32Array(pos.count*3);
  const v=new T.Vector3(),delta=new T.Vector3(),td=new T.Vector3(),tailPivot=new T.Vector3(-.7,.7,0),headAxis=new T.Vector3(0,0,1),tailAxis=new T.Vector3(0,1,0);
  for(let i=0;i<pos.count;i++){
    v.fromBufferAttribute(pos,i);const w=T.MathUtils.smoothstep(v.x,long?.05:.35,long?.5:.9)*T.MathUtils.smoothstep(v.y,long?.9:tall?1.1:.2,long?1.55:tall?1.6:.6);
    delta.copy(v).sub(pivot).applyAxisAngle(headAxis,.5).add(pivot).sub(v).multiplyScalar(w);
    delta.toArray(head,i*3);
    const tw=T.MathUtils.smoothstep(-v.x,.7,1.65);td.copy(v).sub(tailPivot).applyAxisAngle(tailAxis,.5).add(tailPivot).sub(v).multiplyScalar(tw);
    td.toArray(tail,i*3);feet[i*3+1]=Math.sign(v.z)*T.MathUtils.smoothstep(.5-v.y,0,.3)*.2;
  }
  mesh.geometry.morphTargetsRelative=true;
  mesh.geometry.morphAttributes.position=[new T.BufferAttribute(head,3),new T.BufferAttribute(tail,3),new T.BufferAttribute(feet,3)];mesh.updateMorphTargets();
  return pivot;
}
export function toyNose(species:string) {
  if(species==='aiven-chimera')return new T.Vector3(1.5,2.92,0);
  return new T.Vector3(1.2,species==='brachiosaurus'?2.95:species==='plesiosaur'?1.9:['halloween-dinosaur','tyrannosaurus','velociraptor','parasaurolophus','dinosaur-fossil'].includes(species)?1.68:species==='spinosaurus'?1.08:species==='pteranodon'?1.36:.4,0);
}
