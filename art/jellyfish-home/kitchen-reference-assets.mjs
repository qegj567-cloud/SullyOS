import fs from 'node:fs/promises';import assert from 'node:assert/strict';import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {mergeGeometries,mergeVertices} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {saveGlb} from './asset-geometry.mjs';
const catalog=JSON.parse(await fs.readFile('public/room3d/catalog.json','utf8')),report=[];
const mat=(name,color)=>Object.assign(new T.MeshStandardMaterial({color,roughness:.8}),{name});
const black=mat('charcoal','#292b2e'),white=mat('porcelain','#efede6'),steel=mat('steel','#a0a5a9'),leaf=mat('leaf','#658348'),lightLeaf=mat('leaf-light','#8ca65e'),soil=mat('soil','#484137'),fruit=mat('fruit','#96a357');
function mesh(root,g,m,x=0,y=0,z=0){g.deleteAttribute('uv');g.deleteAttribute('color');const o=new T.Mesh(g,m);o.position.set(x,y,z);root.add(o);return o;}
const box=(r,x,y,z,w,h,d,m=black)=>mesh(r,new T.BoxGeometry(w,h,d),m,x,y,z);
const cylinder=(r,x,y,z,rt,rb,h,m=white,n=10)=>mesh(r,new T.CylinderGeometry(rt,rb,h,n),m,x,y,z);
async function asset(r,id,x,y,z,width){const a=catalog.find(a=>a.id===id),b=await fs.readFile('public/room3d/'+a.url),o=(await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene;o.scale.setScalar(width/a.size[0]);o.position.set(x,y,z);r.add(o);return o;}
function plant(r,x,y,z,trailing=false){
 cylinder(r,x,y+.11,z,.13,.095,.22);cylinder(r,x,y+.222,z,.112,.112,.008,soil);
 for(let j=0;j<9;j++){const a=j*2.4,rad=.09+(j%3)*.03;const o=mesh(r,new T.SphereGeometry(1,6,4),j%2?leaf:lightLeaf,x+Math.cos(a)*rad,y+.28+(j%3)*.045,z+Math.sin(a)*rad);o.scale.set(.085,.15,.026);o.rotation.set(.4*Math.sin(a),a,.8*Math.cos(a));}
 if(trailing)for(let branch=0;branch<2;branch++){
  const points=[];for(let j=0;j<7;j++)points.push(new T.Vector3(x+.09*branch+.06*Math.sin(j*.9),y+.25-j*.12,z+.12+j*.018));
  mesh(r,new T.TubeGeometry(new T.CatmullRomCurve3(points),9,.009,4,false),leaf);
  for(let j=1;j<7;j++){const p=points[j],o=mesh(r,new T.SphereGeometry(1,6,4),j%2?leaf:lightLeaf,p.x+(j%2?.05:-.05),p.y,p.z);o.scale.set(.065,.105,.022);o.rotation.z=j%2?.5:-.5;}
 }
}
async function emit(id,name,root,surface){
 root.updateMatrixWorld(true);const groups=new Map();root.traverse(o=>{if(!o.isMesh)return;const g=o.geometry.clone().applyMatrix4(o.matrixWorld);g.deleteAttribute('uv');g.deleteAttribute('color');if(!groups.has(o.material))groups.set(o.material,[]);groups.get(o.material).push(g.index?g.toNonIndexed():g);});
 const out=new T.Group();for(const [m,gs]of groups)out.add(new T.Mesh(mergeVertices(mergeGeometries(gs)),m));
 const b=new T.Box3().setFromObject(out),s=b.getSize(new T.Vector3()),c=b.getCenter(new T.Vector3());for(const o of out.children)o.geometry.translate(-c.x,-b.min.y,-c.z);
 const triangles=out.children.reduce((n,o)=>n+o.geometry.index.count/3,0);assert.ok(triangles<4000,id+' '+triangles);
 const a={id,name,url:id+'.glb',collection:'kitchen',surface,size:s.toArray(),default:[0,surface==='wall'?2:.15,0],boxes:[[-s.x/2,0,-s.z/2,s.x/2,s.y,s.z/2]],paintMaterials:[...groups.keys()].some(m=>m.name==='porcelain')?['porcelain']:['charcoal'],revision:'kitchen-reference-1'};
 const i=catalog.findIndex(a=>a.id===id);if(i<0)catalog.push(a);else catalog[i]=a;
 const bytes=await saveGlb(out,'public/room3d/'+a.url);report.push({id,triangles,bytes,size:s.toArray()});
}
// One compact prep station: reusable board/tools plus a closed draining tray
// and upright plates. Fits entirely on the dry left-hand worktop.
const prep=new T.Group();await asset(prep,'kitchenware_board',-.08,0,.02,.52);await asset(prep,'kitchenware_tools',-.64,0,-.03,.25);
box(prep,.52,.025,0,.54,.05,.56);for(const x of [.27,.77])box(prep,x,.11,0,.025,.17,.56);for(const z of [-.267,.267])box(prep,.52,.11,z,.54,.17,.025);
for(const x of [.36,.51,.66]){const plate=cylinder(prep,x,.235,0,.19,.19,.025,white,16);plate.rotation.z=Math.PI/2-.1;}
await emit('kitchen_ref_prep','砧板厨具与沥水盘架',prep,'tabletop');
// Hood and its utensil rail form a wall workstation. Hood center remains
// directly above the existing hob; no countertop or stove mesh is replaced.
const hood=new T.Group();box(hood,0,.77,0,1.8,.22,.86);box(hood,0,.665,.12,1.54,.025,.58,steel);
const slope=new T.CylinderGeometry(.46,.9,.48,4,1,false,Math.PI/4);slope.scale(1,.95,.49);mesh(hood,slope,black,0,1.1,-.02);
box(hood,0,1.64,-.2,.6,.85,.38);for(let j=0;j<3;j++)box(hood,.48+j*.1,.77,.438,.045,.026,.006,steel);
await asset(hood,'kitchenware_rail',-1.67,0,-.23,1.0);
await emit('kitchen_ref_hood','黑色烟机与厨具挂杆',hood,'wall');
// Two shelves share a frame and contain jars, a small cat print and plants.
const shelves=new T.Group();for(const y of [.58,1.36])box(shelves,0,y,0,2.12,.075,.38);
for(const x of [-.88,.88])box(shelves,x,.97,-.16,.04,.91,.055);
for(let j=0;j<3;j++){cylinder(shelves,-.68+j*.32,.79,0,.11,.11,.32);cylinder(shelves,-.68+j*.32,.96,0,.115,.115,.035,black);box(shelves,-.68+j*.32,.79,.112,.1,.09,.005,steel);}
plant(shelves,.68,.62,.03,true);plant(shelves,.64,1.40,.02,true);
box(shelves,-.52,1.69,-.09,.47,.59,.045);box(shelves,-.52,1.69,-.061,.39,.51,.01,white);
const cat=mesh(shelves,new T.SphereGeometry(1,10,6),black,-.52,1.67,-.046);cat.scale.set(.10,.095,.012);
for(const x of [-.59,-.45]){mesh(shelves,new T.ConeGeometry(.045,.12,3),black,x,1.76,-.046);mesh(shelves,new T.SphereGeometry(.012,6,4),white,x<-.5?-.55:-.49,1.68,-.03);}
await emit('kitchen_ref_shelves','双层绿植调料壁架',shelves,'wall');
// Island breakfast vignette: cups, flowers and fruit stay within its surface.
const breakfast=new T.Group();await asset(breakfast,'kitchenware_settings',0,.04,.16,.86);
box(breakfast,0,.018,.1,1.02,.036,.62,black);
cylinder(breakfast,-.7,.11,-.15,.075,.105,.22,white,12);
for(let j=0;j<5;j++){
 const a=j*2.4,x=-.7+Math.cos(a)*.08,z=-.15+Math.sin(a)*.08,y=.4+(j%2)*.07;
 const stem=new T.CatmullRomCurve3([new T.Vector3(-.7,.16,-.15),new T.Vector3(x,.3,z),new T.Vector3(x,y,z)]);
 mesh(breakfast,new T.TubeGeometry(stem,4,.01,4,false),leaf);
 const bloom=mesh(breakfast,new T.SphereGeometry(1,8,5),white,x,y,z);bloom.scale.set(.055,.09,.055);
 const foliage=mesh(breakfast,new T.SphereGeometry(1,6,4),lightLeaf,x+.025,.3,z);foliage.scale.set(.04,.1,.012);foliage.rotation.z=.5;
}
cylinder(breakfast,.65,.07,-.04,.22,.14,.14,white,12);
for(let j=0;j<4;j++)mesh(breakfast,new T.SphereGeometry(.085,8,5),fruit,.65+Math.cos(j*2.4)*.10,.16+(j===3?.055:0),-.04+Math.sin(j*2.4)*.08);
await emit('kitchen_ref_breakfast','早餐花果与杯盘托盘',breakfast,'tabletop');
const windowGroup=new T.Group();await asset(windowGroup,'suite_window_kitchen',0,0,0,2.36);
const sill=mat('woodLight','#ffffff');sill.color.setRGB(.8227857351303101,.5972017645835876,.3915724754333496);
box(windowGroup,0,.04,.075,2.36,.08,.45,sill);
const sillPlant=new T.Group();plant(sillPlant,0,0,0);sillPlant.scale.setScalar(.65);sillPlant.position.set(-.77,.085,.19);windowGroup.add(sillPlant);
for(const [x,h]of [[-.29,.20],[.02,.16]]){cylinder(windowGroup,x,.08+h/2,.08,.09,.09,h,white);cylinder(windowGroup,x,.09+h,.08,.093,.093,.025,black);}
await emit('kitchen_ref_window','绿植罐饰黑框厨房窗',windowGroup,'wall');
Object.assign(catalog.find(a=>a.id==='kitchen_ref_window'),{daylight:true,paintMaterials:['ink']});
// Open shelving: accessible from the kitchen side, with visible storage tiers.
const rack=new T.Group();
for(const x of [-.63,.63])for(const z of [-.27,.27])box(rack,x,1.1,z,.045,2.2,.045);
for(const y of [.16,.72,1.28,1.84])box(rack,0,y,0,1.32,.055,.59);
for(const y of [.19,.75])for(const x of [-.33,.33]){
 box(rack,x,y+.19,0,.53,.38,.45,white);box(rack,x,y+.19,.229,.16,.05,.008,black);
 for(let j=0;j<4;j++)box(rack,x-.20+j*.13,y+.19,.236,.015,.28,.006,steel);
}
await asset(rack,'kitchenware_plates',-.31,1.315,0,.48);
for(const x of [.16,.44]){cylinder(rack,x,1.48,0,.105,.105,.32);cylinder(rack,x,1.65,0,.11,.11,.035,black);}
plant(rack,-.39,1.87,0,true);cylinder(rack,.30,2.02,0,.16,.16,.30);cylinder(rack,.30,2.18,0,.17,.17,.04,black);
await emit('kitchen_ref_rack','黑框四层餐厨收纳架',rack,'floor');
const cart=new T.Group();
for(const x of [-.40,.40])for(const z of [-.25,.25]){
 const wheel=cylinder(cart,x,.09,z,.09,.09,.06,black,10);wheel.rotation.z=Math.PI/2;
 box(cart,x,.63,z,.035,1.0,.035,steel);
}
for(const y of [.24,.68,1.10]){
 box(cart,0,y,0,.89,.04,.61);
 for(const z of [-.29,.29])box(cart,0,y+.06,z,.89,.10,.025);
 for(const x of [-.43,.43])box(cart,x,y+.06,0,.025,.10,.61);
}
for(const x of [-.18,.15]){cylinder(cart,x,.42,0,.10,.10,.30);cylinder(cart,x,.585,0,.07,.07,.035,black);}
box(cart,0,.84,0,.62,.27,.42,white);box(cart,0,.85,.217,.19,.04,.009,black);
plant(cart,.20,1.12,0);await asset(cart,'kitchenware_tools',-.22,1.12,0,.24);
box(cart,-.46,1.17,0,.035,.25,.035,steel);box(cart,.46,1.17,0,.035,.25,.035,steel);box(cart,0,1.30,0,.95,.035,.035,steel);
await emit('kitchen_ref_trolley','三层备餐带轮推车',cart,'floor');
// A single horizontal quad per rug. Its pattern is a procedural material,
// not another mesh or a bitmap. Lift above the room finish without z-fighting.
for(const [id,name,w,d,pattern]of [['kitchen_ref_runner','黑白格备餐长毯',3.7,.82,'check'],['kitchen_ref_mat','猫咪迎宾小地毯',1.7,.90,'cat']]){
 const g=new T.PlaneGeometry(w,d).rotateX(-Math.PI/2).translate(0,.026,0);g.deleteAttribute('uv');
 const root=new T.Group();root.add(new T.Mesh(g,black));const bytes=await saveGlb(root,'public/room3d/'+id+'.glb');
 const a={id,name,url:id+'.glb',collection:'kitchen',surface:'rug',size:[w,.026,d],default:[0,.15,0],boxes:[[-w/2,0,-d/2,w/2,.026,d/2]],paintMaterials:['charcoal'],rugPattern:pattern,revision:'kitchen-storage-1'};
 const i=catalog.findIndex(a=>a.id===id);if(i<0)catalog.push(a);else catalog[i]=a;report.push({id,triangles:2,bytes,size:a.size});
}
await fs.writeFile('public/room3d/catalog.json',JSON.stringify(catalog,null,2)+'\n');await fs.writeFile('art/jellyfish-home/sources/kitchenware/reference-report.json',JSON.stringify(report,null,2)+'\n');console.log(report);
