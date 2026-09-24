// Authored geometry for the supplied living-room reference. No image sampling,
// textures, UVs or vertex colors. Run with pnpm node from the project root.
import fs from 'node:fs/promises';
import * as T from 'three';
import {RoundedBoxGeometry} from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {mergeGeometries,mergeVertices} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
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
 const size=new T.Box3().setFromObject(combined).getSize(new T.Vector3()).toArray(),triangles=combined.children.reduce((sum,m)=>sum+m.geometry.index.count/3,0),id='living_ref_'+suffix;
 if(triangles>=4000)throw Error(`${id}: ${triangles} triangles exceeds furniture budget`);
 if(extra.support){const s=extra.support;extra={...extra,support:{...s,height:s.height-b.min.y,center:[(s.center?.[0]??0)-c.x,(s.center?.[1]??0)-c.z]}};}
 const a={id,name,surface,collection:'living',url:id+'.glb',revision:'living-reference-1',size,default:[0,surface==='wall'?2:.15,0],boxes:[[-size[0]/2,0,-size[2]/2,size[0]/2,size[1],size[2]/2]],paintMaterials,...extra};
 const ix=catalog.findIndex(a=>a.id===id);if(ix<0)catalog.push(a);else catalog[ix]=a;
 const bytes=await saveGlb(combined,'public/room3d/'+id+'.glb');report.push({id,triangles,bytes,size,groups:groups.size});
}
// Floor-to-ceiling glazing with folded green curtains, warm sheer panels and railing relief.
function curtain(cx,w,h,mat,z){const g=new T.PlaneGeometry(w,h,24,8),p=g.attributes.position;for(let i=0;i<p.count;i++){const x=p.getX(i);p.setZ(i,Math.cos((x/w+.5)*Math.PI*12)*.045);}
g.computeVertexNormals();mats[mat].side=T.DoubleSide;mesh(g,mat,cx,h/2+.08,z);}
root=new T.Group();box(5.45,3.76,.07,0,1.88,0,'glass');for(const x of [-2.75,0,2.75])box(.075,3.9,.13,x,1.95,.075,'walnut');
for(const y of [.045,3.85])box(5.58,.09,.19,0,y,.09,'woodLight');
for(const x of [-1.08,1.08])curtain(x,1.15,3.68,'paper',.17);
for(const x of [-2.30,2.30]){curtain(x,.88,3.76,'sage',.24);box(.87,.07,.08,x,1.48,.29,'sage');}
box(5.66,.10,.24,0,3.94,.14,'walnut',.035);box(5.48,.045,.27,0,.045,.16,'cream');
for(let i=-5;i<=5;i++)box(.035,.62,.035,i*.35,.43,.11,'cream');box(3.85,.04,.06,0,.74,.12,'cream');
await save('window','鼠尾草双帘落地采光窗','wall',['sage'],{wallOpening:{width:5.46,bottom:.04,top:3.87,inset:.16},daylight:true,daylightSettings:{reach:5.8,intensity:75}});
// Low oak media cabinet with woven/slatted door fronts and real open center shelves.
root=new T.Group();for(const y of [.12,.82])box(3.40,.09,.70,0,y,0);
for(const x of [-1.65,-.57,.57,1.65])box(.07,.67,.65,x,.47,0);
box(3.3,.67,.045,0,.47,-.32);box(1.06,.055,.63,0,.46,.02);
for(const x of [-1.11,1.11]){box(.96,.57,.04,x,.47,.33,'woodLight');for(let j=-7;j<=7;j++)box(.028,.50,.02,x+j*.058,.47,.36,'cream');box(.026,.12,.035,x+.33,.47,.39,'walnut');}
for(const x of [-1.42,1.42])for(const z of [-.22,.22])box(.10,.12,.10,x,.06,z);
storage(0,.17,.06,.76,.17,.46,'cream');box(.85,.12,.42,0,.60,.02,'ink');
await save('console','原木格栅电视柜','floor',['woodLight'],{support:{shape:'rect',width:3.28,depth:.60,height:.865}});
root=new T.Group();box(2.62,1.49,.095,0,.88,0,'ink',.025);box(2.48,1.35,.012,0,.89,.056,'ink');
box(.075,.20,.075,0,.12,0,'ink');box(.92,.035,.34,0,.018,.015,'ink',.015);
await save('television','深灰窄边电视','tabletop',['ink']);
function lowCabinet(){box(1.05,.065,.48,0,.08,0);box(1.05,.065,.48,0,.85,0);for(const x of [-.49,0,.49])box(.055,.74,.44,x,.47,0);box(.99,.75,.04,0,.46,-.22);books(-.38,.115,0,4,.56);books(.12,.115,0,3,.47);}
root=new T.Group();lowCabinet();await save('bookcase','原木矮书架','floor',['woodLight'],{support:{shape:'rect',width:.95,depth:.43,height:.8825}});
root=new T.Group();lowCabinet();box(.62,.08,.37,0,.93,0,'ink',.02);cylinder(.15,.15,.016,-.08,.98,0,'ink',20);cylinder(.035,.035,.018,-.08,.99,0,'cream');line([[.22,.98,-.11],[.17,1.01,0],[.05,1.01,.08]],.015,'gold');plant(.36,.89,.02,.29);
await save('record_cabinet','原木唱片柜与唱机','floor',['woodLight']);
root=new T.Group();lamp(.23,0,0,.52,false);frame(-.23,0,0,.25,.32,'woodLight');await save('bookcase_top','边柜相框与球灯','tabletop',['woodLight'],{contact:{width:.78,depth:.31}});
root=new T.Group();plant(0,0,0,.35);await save('console_plant','电视柜小盆栽','tabletop',['cream']);
root=new T.Group();box(1.6,.065,.37,0,.08,0);box(1.6,.065,.37,0,.66,0);books(-.32,.115,0,6,.38);frame(.36,.70,0,.28,.37);frame(.03,.70,0,.23,.3);plant(-.51,.70,0,.38);vine(-.67,.7,.1,.63);
await save('wall_shelf','原木双层相框绿植壁架','wall',['woodLight']);
root=new T.Group();mesh(new T.CylinderGeometry(.27,.27,.06,32).rotateX(Math.PI/2),'woodLight',0,.28,0);mesh(new T.CircleGeometry(.235,32),'cream',0,.28,.035);
line([[0,.28,.045],[.02,.42,.045]],.012,'ink');line([[0,.28,.045],[-.12,.33,.045]],.011,'ink');for(let i=0;i<12;i++){const a=i*Math.PI/6;ball(.009,.009,.007,Math.sin(a)*.207,.28+Math.cos(a)*.207,.046,'walnut',6);}
await save('clock','暖木圆形挂钟','wall',['woodLight']);
root=new T.Group();box(.57,.67,.57,0,.335,0,'cream',.045);box(.48,.014,.48,0,.678,0,'earth');line([[0,.67,0],[.04,1.35,.03],[-.03,2.60,0]],.035,'walnut');
for(let i=0;i<12;i++){const a=i*2.4,y=1.13+i*.12,dx=Math.cos(a)*(.49-i*.012),dz=Math.sin(a)*.35;line([[0,y-.22,0],[dx,y,dz]],.014,'walnut');for(let j=0;j<3;j++)leaf(dx*(.5+j*.25),y+j*.12,dz,.13,(i%2?1:-1)*.8,i%2?'leaf':'leafLight');}
await save('tree','奶油方盆枝叶树','floor',['cream'],{waterable:true});
root=new T.Group();box(1.20,.038,.53,0,.019,0,'woodLight',.04);plant(.18,.045,0,.42);cup(.47,.04,.03);cup(-.35,.04,.03);storage(-.06,.05,-.06,.23,.06,.27,'cream');
await save('tea_tray','茶几绿植双杯托盘','tabletop',['woodLight']);
root=new T.Group();box(.49,.08,.36,0,.04,0,'sage');box(.43,.065,.32,.025,.11,0,'paper');diffuser(0,.15,0);await save('books','茶几书本与香薰','tabletop',['sage']);
root=new T.Group();box(5.6,.026,4.6,0,.013,0,'paper',.025);for(let x=-2.65;x<2.8;x+=.76)box(.017,.005,4.50,x,.030,0,'sage');for(let z=-2.15;z<2.3;z+=.76)box(5.5,.005,.017,0,.030,z,'sage');await save('rug','奶油绿线大格地毯','rug',['paper']);

// Preserve the approved sofa silhouette and seat locations; add a low-poly arm throw.
const sofaBytes=await fs.readFile('public/room3d/show_living_sofa.glb');
root=(await new GLTFLoader().parseAsync(sofaBytes.buffer.slice(sofaBytes.byteOffset,sofaBytes.byteOffset+sofaBytes.byteLength),'')).scene;
const cloth=new T.BufferGeometry(),positions=[],indices=[],path=[[1.22,.98],[1.53,1.06],[1.79,.97],[1.80,.19]];
for(let u=0;u<4;u++)for(let v=0;v<=16;v++){const z=-.19+v*.047;positions.push(path[u][0]+(u===3?Math.sin(v*Math.PI/2)*.012:0),path[u][1]+Math.cos(v*Math.PI/2)*.014,z);}
for(let u=0;u<3;u++)for(let v=0;v<16;v++){const a=u*17+v;indices.push(a,a+17,a+1,a+1,a+17,a+18);}
cloth.setAttribute('position',new T.Float32BufferAttribute(positions,3));cloth.setIndex(indices);cloth.computeVertexNormals();mats.sage.side=T.DoubleSide;mesh(cloth,'sage');
for(let v=0;v<6;v++)box(.014,.09,.018,1.80,.15,-.15+v*.12,'sage');
const baseSofa=catalog.find(a=>a.id==='show_living_sofa');
await save('sofa','奶油沙发与鼠尾草搭毯','floor',baseSofa.paintMaterials,{seats:baseSofa.seats,colorParts:[...baseSofa.colorParts,{material:'sage',label:'扶手搭毯',color:'#858d67'}]});

await fs.writeFile('public/room3d/catalog.json',JSON.stringify(catalog,null,2)+'\n');await fs.mkdir('output/living-reference',{recursive:true});await fs.writeFile('output/living-reference/assets-report.json',JSON.stringify(report,null,2));console.log(report);
