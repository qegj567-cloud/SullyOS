import * as T from 'three';
// Allocated once, reused by every action, disposed with the room editor.
export function createKitchenWorkEffects(resident){
 const root=new T.Group();root.name='kitchen-work';root.visible=false;resident.add(root);
 const resources=[],m=color=>{const v=new T.MeshStandardMaterial({color,roughness:.72});resources.push(v);return v;};
 const white=m('#f3eee3'),ink=m('#303238'),water=m('#a5d9e8'),food=m('#e5c675'),wood=m('#aa805c');
 function mesh(parent,g,mat){resources.push(g);const o=new T.Mesh(g,mat);parent.add(o);return o;}
 const plate=new T.Group();root.add(plate);mesh(plate,new T.CylinderGeometry(.22,.19,.025,24),white);
 const rim=mesh(plate,new T.TorusGeometry(.20,.012,4,24),white);rim.rotation.x=Math.PI/2;rim.position.y=.018;
 const sponge=mesh(root,new T.BoxGeometry(.11,.045,.08),food);
 const cup=new T.Group();root.add(cup);mesh(cup,new T.CylinderGeometry(.09,.075,.15,16),white);
 const coffee=mesh(cup,new T.CircleGeometry(.08,16),wood);coffee.rotation.x=-Math.PI/2;coffee.position.y=.077;
 const handle=mesh(cup,new T.TorusGeometry(.052,.012,5,12),white);handle.position.x=.09;
 const pan=new T.Group();root.add(pan);mesh(pan,new T.CylinderGeometry(.22,.18,.12,16),ink);
 const rice=mesh(pan,new T.CylinderGeometry(.195,.195,.015,16),food);rice.position.y=.062;
 const ladle=mesh(root,new T.CylinderGeometry(.016,.016,.38,8),wood);
 const flow=mesh(root,new T.CylinderGeometry(.012,.012,1,6),water);
 const stool=new T.Group();root.add(stool);
 const step=mesh(stool,new T.BoxGeometry(.78,.30,.72),white);step.position.y=.15;
 const top=mesh(stool,new T.BoxGeometry(.78,.28,.42),white);top.position.set(0,.44,-.15);
 const bubbles=Array.from({length:7},()=>mesh(root,new T.SphereGeometry(.028,6,4),white));
 const steam=Array.from({length:5},()=>mesh(root,new T.SphereGeometry(.035,6,4),white));
 const v=new T.Vector3(),up=new T.Vector3(0,1,0);
 function local(point){resident.updateWorldMatrix(true,false);return resident.worldToLocal(new T.Vector3(...point));}
 function segment(o,a,b){v.copy(b).sub(a);o.position.copy(a).add(b).multiplyScalar(.5);o.scale.y=v.length();o.quaternion.setFromUnitVectors(up,v.normalize());}
 return {root,update(task,time,hands){
  root.visible=!!task?.carrying||['work','pickup','putback'].includes(task?.stage);if(!root.visible)return;
  stool.visible=(task.lift||0)>.01;stool.position.set(0,-(task.lift||0),0);
  plate.visible=task.kind==='wash';cup.visible=task.kind==='coffee';pan.visible=task.kind==='cook';
  sponge.visible=task.kind==='wash'&&task.stage==='work';ladle.visible=task.kind==='cook';flow.visible=task.stage==='work'&&(task.kind==='wash'||task.kind==='coffee'&&time<4);
  const left=new T.Vector3(...hands[0]),right=new T.Vector3(...hands[1]),center=left.clone().add(right).multiplyScalar(.5);
  plate.position.copy(center);plate.rotation.x=.2;cup.position.copy(left);cup.position.y+=.02;
  sponge.position.copy(right);sponge.position.y+=.02;
  const point=task.kind==='wash'?task.sink.point:task.source.point;
  const at=local(point);pan.position.copy(at);pan.position.y+=.07;
  if(task.kind==='coffee'&&task.stage==='work'){
   // Fill the cup at the machine, then pick it up for a small satisfied sip.
   const brew=at.clone();brew.y+=.035;
   cup.position.copy(brew).lerp(left,Math.min(1,Math.max(0,(time-4)/1.2)));
   if(time>6)cup.position.y+=Math.sin(Math.min(1,(time-6)/2)*Math.PI)*.10;
  }
  if(ladle.visible){const end=pan.position.clone();end.y+=.12;segment(ladle,right,end);ladle.scale.y*=1/.38;}
  if(flow.visible){
   const tap=task.kind==='wash'&&task.sink.tap?local(task.sink.tap):at.clone().add(new T.Vector3(0,.22,0));
   const end=task.kind==='coffee'?cup.position.clone().add(new T.Vector3(0,.07,0)):tap.clone().add(new T.Vector3(0,-.17,0));
   flow.material=task.kind==='coffee'?wood:water;segment(flow,tap,end);
  }
  bubbles.forEach((b,i)=>{b.visible=sponge.visible;b.position.copy(center).add(new T.Vector3(Math.sin(i*2.4+time)*.14,.05+(i%3)*.02,Math.cos(i*2.4)*.12));});
  steam.forEach((s,i)=>{s.visible=task.stage==='work'&&task.kind!=='wash';s.position.copy(task.kind==='cook'?pan.position:cup.position);s.position.add(new T.Vector3(Math.sin(time+i)*.05,.12+(time*.10+i*.06)%.35,Math.cos(i)*.05));s.scale.setScalar(.5+((i+time)%3)*.2);});
 },clear(){root.visible=false;},dispose(){root.removeFromParent();resources.forEach(r=>r.dispose());}};
}
