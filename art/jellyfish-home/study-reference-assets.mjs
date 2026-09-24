// Authored geometry for the supplied study reference. No image sampling,
// textures, UVs or vertex colors. Run with pnpm node from the project root.
import fs from 'node:fs/promises';
import * as T from 'three';
import {RoundedBoxGeometry} from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {mergeGeometries,mergeVertices} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {saveGlb} from './asset-geometry.mjs';

const palette={woodLight:'#ffffff',cream:'#eadfc9',paper:'#f4ead5',sage:'#858d67',leaf:'#698348',leafLight:'#91a762',earth:'#6c5743',walnut:'#795c46',ink:'#434638',gold:'#bea477',glass:'#b8d0d2',lavender:'#ad97bd',night:'#666579',pink:'#d8bcb1',glow:'#fff0b8'};
const mats=Object.fromEntries(Object.entries(palette).map(([name,color])=>{const m=new T.MeshStandardMaterial({color,roughness:.83});m.name=name;return [name,m];}));
mats.woodLight.color.setRGB(.8227857351303101,.5972017645835876,.3915724754333496);
mats.glow.emissive.set('#ffdda0');mats.glow.emissiveIntensity=.65;
mats.glass.metalness=.18;mats.glass.roughness=.24;
mats.leaf.side=mats.leafLight.side=T.DoubleSide;
let root;
function mesh(g,mat,x=0,y=0,z=0,rz=0){g.deleteAttribute('uv');g.rotateZ(rz);g.translate(x,y,z);root.add(new T.Mesh(g,mats[mat]));}
function box(w,h,d,x,y,z,mat='woodLight',radius=0){mesh(radius?new RoundedBoxGeometry(w,h,d,1,Math.min(radius,w/3,h/3,d/3)):new T.BoxGeometry(w,h,d),mat,x,y,z);}
function ball(rx,ry,rz,x,y,z,mat='cream',segments=10){const g=new T.SphereGeometry(1,segments,6);g.scale(rx,ry,rz);mesh(g,mat,x,y,z);}
function cylinder(rt,rb,h,x,y,z,mat='woodLight',segments=12){mesh(new T.CylinderGeometry(rt,rb,h,segments),mat,x,y,z);}
function line(points,r=.012,mat='walnut'){mesh(new T.TubeGeometry(new T.CatmullRomCurve3(points.map(p=>new T.Vector3(...p))),Math.max(4,points.length*3),r,4,false),mat);}
function leaf(x,y,z,s,a,mat='leaf'){
 const g=new T.SphereGeometry(1,6,4);g.scale(s*.48,s,s*.12);g.rotateZ(a);g.rotateY(z*3);mesh(g,mat,x,y,z);
}
function plant(x,y,z,s=.6){
 cylinder(s*.18,s*.135,s*.28,x,y+s*.14,z,'cream');cylinder(s*.15,s*.15,.012,x,y+s*.279,z,'earth');
 for(let i=0;i<7;i++){const a=i*2.399,dx=Math.cos(a)*s*.22,dz=Math.sin(a)*s*.22,top=y+s*(.6+(i%3)*.11);line([[x,y+s*.27,z],[x+dx*.5,top-.1,z+dz*.5],[x+dx,top,z+dz]],.007,'leaf');leaf(x+dx,top,z+dz,s*.27,-Math.cos(a)*.9,i%2?'leafLight':'leaf');}
}
function vine(x,y,z,length=.95){
 line([[x,y,z],[x+.03,y-.3,z+.08],[x-.04,y-length*.7,z+.10],[x+.01,y-length,z+.13]],.011,'leaf');
 for(let i=0;i<7;i++){const t=i/10;leaf(x+(i%2?1:-1)*.08,y-t*length,z+.10,.115,i%2?-.8:.8,i%3?'leaf':'leafLight');}
}
function books(x,y,z,n=5,s=.4){for(let i=0;i<n;i++){const w=.075,h=s*(.7+(i%3)*.12),X=x+i*.085;box(w,h,.26,X,y+h/2,z,['cream','sage','paper','sage'][i%4]);box(w*.7,.013,.008,X,y+h*.78,z+.133,'gold');}}
function storage(x,y,z,w=.55,h=.27,d=.36,mat='cream'){box(w,h,d,x,y+h/2,z,mat,.025);box(w+.025,.035,d+.025,x,y+h,z,mat,.009);box(w*.23,.025,.009,x,y+h*.6,z+d/2+.008,'gold');}
function cup(x,y,z){cylinder(.075,.056,.13,x,y+.065,z,'cream');cylinder(.06,.06,.007,x,y+.132,z,'earth');mesh(new T.TorusGeometry(.044,.012,4,10),'cream',x+.071,y+.075,z);cylinder(.105,.105,.014,x,y+.007,z,'paper');}
function diffuser(x,y,z){box(.14,.18,.14,x,y+.09,z,'walnut',.015);box(.075,.08,.008,x,y+.10,z+.075,'paper');for(let i=-1;i<=1;i++)line([[x,y+.18,z],[x+i*.07,y+.46,z+i*.02]],.005,'gold');}
function frame(x,y,z,w=.3,h=.38,mat='walnut',picture='sage'){
 box(w,h,.036,x,y+h/2,z,mat);box(w-.036,h-.045,.009,x,y+h/2,z+.026,'paper');
 ball(w*.19,h*.16,.007,x-w*.08,y+h*.59,z+.034,picture,8);box(w*.055,h*.24,.007,x,y+h*.35,z+.035,'walnut');
}
function photo(x,y,z,w=.18,h=.24){box(w,h,.012,x,y+h/2,z,'paper');box(w*.80,h*.65,.008,x,y+h*.57,z+.011,'night');ball(w*.17,h*.14,.006,x,y+h*.64,z+.017,'pink',6);box(w*.34,h*.20,.005,x,y+h*.43,z+.017,'sage');box(.023,.05,.016,x,y+h,z+.016,'gold');}
function lamp(x,y,z,s=.7,pleated=true){
 cylinder(s*.16,s*.19,s*.06,x,y+s*.03,z,'walnut');cylinder(s*.035,s*.035,s*.36,x,y+s*.23,z,'gold');
 if(pleated){const g=new T.CylinderGeometry(s*.18,s*.32,s*.38,32,1,true),p=g.attributes.position;for(let i=0;i<p.count;i++){const a=Math.atan2(p.getZ(i),p.getX(i)),k=1+Math.cos(a*16)*.045;p.setXYZ(i,p.getX(i)*k,p.getY(i),p.getZ(i)*k);}g.computeVertexNormals();mats.glow.side=T.DoubleSide;mesh(g,'glow',x,y+s*.54,z);cylinder(s*.175,s*.175,.015,x,y+s*.735,z,'cream');}
 else ball(s*.24,s*.24,s*.24,x,y+s*.44,z,'glow',12);
}
const catalog=JSON.parse(await fs.readFile('public/room3d/catalog.json','utf8')),report=[];
async function save(suffix,name,surface,paintMaterials,extra={}){
 root.updateMatrixWorld(true);const b=new T.Box3().setFromObject(root),c=b.getCenter(new T.Vector3()),groups=new Map();
 root.traverse(o=>{if(!o.isMesh)return;const g=o.geometry.clone().applyMatrix4(o.matrixWorld);g.translate(-c.x,-b.min.y,-c.z);if(!groups.has(o.material))groups.set(o.material,[]);groups.get(o.material).push(g.index?g.toNonIndexed():g);});
 const combined=new T.Group();for(const [m,gs]of groups)combined.add(new T.Mesh(mergeVertices(mergeGeometries(gs)),m));
 const size=new T.Box3().setFromObject(combined).getSize(new T.Vector3()).toArray(),triangles=combined.children.reduce((sum,m)=>sum+m.geometry.index.count/3,0),id='study_ref_'+suffix;
 if(triangles>=4000)throw Error(`${id}: ${triangles} triangles exceeds furniture budget`);
 if(extra.support){const s=extra.support;extra={...extra,support:{...s,height:s.height-b.min.y,center:[(s.center?.[0]??0)-c.x,(s.center?.[1]??0)-c.z]}};}
 const a={id,name,surface,collection:'gaming',url:id+'.glb',revision:'study-reference-1',size,default:[0,surface==='wall'?2:.15,0],boxes:[[-size[0]/2,0,-size[2]/2,size[0]/2,size[1],size[2]/2]],paintMaterials,...extra};
 const ix=catalog.findIndex(a=>a.id===id);if(ix<0)catalog.push(a);else catalog[ix]=a;
 const bytes=await saveGlb(combined,'public/room3d/'+id+'.glb');report.push({id,triangles,bytes,size,groups:groups.size});
}
// Broad roller-blind window and two sill plants; opaque glass uses existing daylight.
root=new T.Group();box(2.65,1.72,.09,0,.86,0,'glass');
for(const x of [-1.34,0,1.34])box(.065,1.84,.16,x,.92,.04);
for(const y of [.04,1.80])box(2.75,.075,.20,0,y,.04);
box(2.88,.08,.40,0,.06,.12,'cream');box(2.78,.51,.05,0,1.55,.145,'cream');
box(2.8,.035,.06,0,1.30,.16);mesh(new T.CylinderGeometry(.075,.075,2.88,12).rotateZ(Math.PI/2),'paper',0,1.88,.13);
plant(-1.04,.1,.18,.46);plant(1.04,.1,.18,.43);
await save('window','书房绿植卷帘大窗','wall',['cream'],{daylight:true,daylightSettings:{distance:4.8,intensity:65}});
// Printer, paper tray, globe lamp and plant are one movable cabinet-top set.
root=new T.Group();box(.79,.31,.44,.50,.18,0,'paper',.035);box(.67,.08,.03,.50,.17,.235,'ink');
box(.67,.028,.27,.50,.1,.29,'cream');box(.67,.026,.27,.5,.123,.31,'paper');box(.63,.025,.32,.50,.355,0,'cream');
box(.05,.022,.04,.79,.356,.07,'sage');lamp(-.70,0,0,.56,false);plant(-.17,0,0,.48);
await save('printer_set','打印机与球灯绿植','tabletop',['cream'],{contact:{width:1.65,depth:.55}});
root=new T.Group();plant(-.33,0,0,.67);plant(.34,0,.02,.50);await save('cabinet_plants','书柜顶部双盆绿植','tabletop',['cream']);
// Left memo board with geometric notes; pictures are authored shapes, no sampled image.
root=new T.Group();box(1.12,1.18,.065,0,.59,0,'woodLight');
for(let r=0;r<5;r++)for(let c=0;c<6;c++)cylinder(.009,.009,.01,-.46+c*.18,.13+r*.22,.04,'walnut',5);
photo(-.29,.66,.052,.22,.28);photo(.05,.61,.052,.22,.28);box(.28,.33,.012,.30,.36,.05,'paper');box(.31,.24,.012,-.29,.26,.05,'paper');
for(let i=0;i<3;i++)box(.18,.009,.008,-.29,.22+i*.04,.06,'sage');
box(1.22,.065,.32,0,1.26,0,'cream');plant(-.28,1.30,0,.45);vine(-.52,1.27,.12,.8);
await save('memo','绿植留言板与便笺','wall',['woodLight']);
// Right wall books, framed picture and climbing greenery.
root=new T.Group();for(const y of [.1,.72])box(1.44,.065,.35,0,y,0);
books(-.44,.135,.01,6,.4);plant(.47,.135,0,.34);frame(.26,.755,0,.27,.35);plant(-.38,.755,0,.47);vine(-.63,.79,.05,.57);
await save('wall_shelves','书房双层书本绿植壁架','wall',['woodLight']);
root=new T.Group();box(1.05,.60,.045,0,.30,0,'cream');photo(-.31,.23,.036,.20,.25);photo(-.03,.23,.036,.20,.25);
mesh(new T.TorusGeometry(.18,.025,5,18),'ink',.30,.29,.11);for(const x of [.13,.47])box(.09,.19,.09,x,.20,.12,'ink',.02);
box(.20,.17,.009,-.18,.1,.03,'paper');await save('headphone_board','耳机与相片挂板','wall',['cream']);
root=new T.Group();box(.33,.065,.32,0,.035,0,'ink');
for(const x of [-.12,.12])box(.035,1.78,.035,x,.93,0,'ink');
for(let i=0;i<4;i++){box(.23,.35,.13,0,.27+i*.43,0,'glow',.02);box(.30,.028,.18,0,.47+i*.43,0,'ink');}
await save('floor_light','书房暖白格栅落地灯','floor',['ink']);
root=new T.Group();for(const y of [.19,.67,1.15]){box(.73,.055,.48,0,y,0,'ink');storage(0,y+.03,0,.56,.25,.37,'sage');}
for(const x of [-.34,.34])for(const z of [-.20,.20]){box(.035,1.25,.035,x,.72,z,'ink');ball(.065,.075,.055,x,.09,z,'ink',8);}
plant(.18,1.43,0,.38);await save('cart','书房带轮文件收纳车','floor',['ink']);
root=new T.Group();box(4.20,.025,3.25,0,.013,0,'sage');
for(const x of [-2.0,2.0])box(.045,.005,3.08,x,.029,0,'paper');for(const z of [-1.51,1.51])box(4.04,.005,.045,0,.029,z,'paper');
await save('rug','书房奶油双边绿地毯','rug',['sage']);
root=new T.Group();box(1.62,.025,.72,0,.013,0,'cream',.03);for(const z of [-.31,.31])box(1.49,.004,.025,0,.029,z,'woodLight');for(const x of [-.73,.73])box(.025,.004,.61,x,.029,0,'woodLight');
await save('entry_mat','书房奶油迎宾垫','rug',['cream']);
root=new T.Group();cylinder(.10,.12,.04,0,.02,0,'sage');line([[0,.04,0],[0,.45,-.07],[0,.73,.04]],.022,'sage');cylinder(.07,.14,.14,0,.69,.12,'sage');cylinder(.115,.115,.012,0,.615,.12,'glow');
await save('task_lamp','鼠尾草折臂工作灯','tabletop',['sage'],{contact:{width:.24,depth:.24,center:[0,-.06]}});
await fs.writeFile('public/room3d/catalog.json',JSON.stringify(catalog,null,2)+'\n');await fs.mkdir('output/study-reference',{recursive:true});await fs.writeFile('output/study-reference/assets-report.json',JSON.stringify(report,null,2));console.log(report);
