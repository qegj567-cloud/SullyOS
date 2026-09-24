// Authored geometry for the supplied bathroom reference. No image sampling,
// textures, UVs or vertex colors. Run with pnpm node from the project root.
import fs from 'node:fs/promises';
import * as T from 'three';
import {RoundedBoxGeometry} from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {mergeGeometries,mergeVertices} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {saveGlb} from './asset-geometry.mjs';

const palette={woodLight:'#ffffff',cream:'#eee5d5',paper:'#faf2e4',sage:'#81916b',leaf:'#698348',leafLight:'#91a762',earth:'#6c5743',walnut:'#795c46',ink:'#303b30',gold:'#bea477',glass:'#b8d0d2',lavender:'#ad97bd',night:'#666579',pink:'#d8bcb1',glow:'#fff0b8'};
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
 for(let i=0;i<4;i++){const a=i*2.399,dx=Math.cos(a)*s*.22,dz=Math.sin(a)*s*.22,top=y+s*(.6+(i%3)*.11);line([[x,y+s*.27,z],[x+dx*.5,top-.1,z+dz*.5],[x+dx,top,z+dz]],.007,'leaf');leaf(x+dx,top,z+dz,s*.22,-Math.cos(a)*.9,i%2?'leafLight':'leaf');}
}
function vine(x,y,z,length=.95){
 line([[x,y,z],[x+.03,y-.3,z+.08],[x-.04,y-length*.7,z+.10],[x+.01,y-length,z+.13]],.011,'leaf');
 for(let i=0;i<7;i++){const t=i/10;leaf(x+(i%2?1:-1)*.08,y-t*length,z+.10,.115,i%2?-.8:.8,i%3?'leaf':'leafLight');}
}
function books(x,y,z,n=5,s=.4){for(let i=0;i<n;i++){const w=.075,h=s*(.7+(i%3)*.12),X=x+i*.085;box(w,h,.26,X,y+h/2,z,['cream','sage','paper','pink'][i%4]);box(w*.7,.013,.008,X,y+h*.78,z+.133,'gold');}}
function storage(x,y,z,w=.55,h=.27,d=.36,mat='cream'){box(w,h,d,x,y+h/2,z,mat,.025);box(w+.025,.035,d+.025,x,y+h,z,mat,.009);box(w*.23,.025,.009,x,y+h*.6,z+d/2+.008,'gold');}
function cup(x,y,z){cylinder(.075,.056,.13,x,y+.065,z,'cream');cylinder(.06,.06,.007,x,y+.132,z,'earth');mesh(new T.TorusGeometry(.044,.012,4,10),'cream',x+.071,y+.075,z);cylinder(.105,.105,.014,x,y+.007,z,'paper');}
function diffuser(x,y,z){box(.14,.18,.14,x,y+.09,z,'walnut',.015);box(.075,.08,.008,x,y+.10,z+.075,'paper');for(let i=-1;i<=1;i++)line([[x,y+.18,z],[x+i*.07,y+.46,z+i*.02]],.005,'gold');}
function frame(x,y,z,w=.3,h=.38,mat='walnut',picture='sage'){
 box(w,h,.036,x,y+h/2,z,mat);box(w-.036,h-.045,.009,x,y+h/2,z+.026,'paper');
 ball(w*.19,h*.16,.007,x-w*.08,y+h*.59,z+.034,picture,8);box(w*.055,h*.24,.007,x,y+h*.35,z+.035,'walnut');
}
function photo(x,y,z,w=.18,h=.24){box(w,h,.012,x,y+h/2,z,'paper');box(w*.80,h*.65,.008,x,y+h*.57,z+.011,'night');ball(w*.17,h*.14,.006,x,y+h*.64,z+.017,'pink',6);box(w*.34,h*.20,.005,x,y+h*.43,z+.017,'sage');box(.023,.05,.016,x,y+h,z+.016,'gold');}
function cat(x,y,z,s=.5,sleep=false,mat='ink'){
 ball(s*.40,s*(sleep?.19:.32),s*.25,x,y+s*(sleep?.19:.30),z,mat);
 const hx=x-s*.23,hy=y+s*(sleep?.23:.61),hz=z+s*.1;
 ball(s*.24,s*.22,s*.22,hx,hy,hz,mat);
 for(const dx of [-.15,.15]){const g=new T.ConeGeometry(s*.09,s*.21,4);g.rotateZ(dx>0?-.2:.2);mesh(g,mat,hx+dx*s,hy+s*.19,hz);}
 for(const dx of [-.11,.11]){if(sleep)box(s*.095,.012,.008,hx+dx*s,hy,hz+s*.215,'paper');else{ball(s*.038,s*.055,.013,hx+dx*s,hy+s*.01,hz+s*.21,'gold',6);ball(.009,.018,.009,hx+dx*s,hy+s*.01,hz+s*.22,'ink',6);}}
 ball(.018,.015,.012,hx,hy-s*.07,hz+s*.225,'pink',6);
 for(const dx of [-.21,.18])ball(s*.14,s*.085,s*.15,x+dx*s,y+s*.075,z+s*.18,'paper',8);
 line([[x+s*.27,y+s*.16,z-.03],[x+s*.47,y+s*.15,z-.04],[x+s*.49,y+s*.28,z+.05]],s*.06,mat);
}
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
 const size=new T.Box3().setFromObject(combined).getSize(new T.Vector3()).toArray(),triangles=combined.children.reduce((sum,m)=>sum+m.geometry.index.count/3,0),id='bathroom_ref_'+suffix;
 if(triangles>=4000)throw Error(`${id}: ${triangles} triangles exceeds furniture budget`);
 if(extra.support){const s=extra.support;extra={...extra,support:{...s,height:s.height-b.min.y,center:[(s.center?.[0]??0)-c.x,(s.center?.[1]??0)-c.z]}};}
 const a={id,name,surface,collection:'bathroom',url:id+'.glb',revision:'bathroom-reference-1',size,default:[0,surface==='wall'?2:.15,0],boxes:[[-size[0]/2,0,-size[2]/2,size[0]/2,size[1],size[2]/2]],paintMaterials,...extra};
 const ix=catalog.findIndex(a=>a.id===id);if(ix<0)catalog.push(a);else catalog[ix]=a;
 const bytes=await saveGlb(combined,'public/room3d/'+id+'.glb');report.push({id,triangles,bytes,size,groups:groups.size});
}
function bottle(x,y,z,s=.3,mat='sage'){cylinder(s*.22,s*.24,s*.65,x,y+s*.325,z,mat,10);cylinder(s*.1,s*.1,s*.18,x,y+s*.74,z,'ink',8);box(s*.3,s*.23,.009,x,y+s*.34,z+s*.237,'paper');box(s*.25,s*.05,s*.07,x+s*.06,y+s*.84,z,'ink');}
function towel(x,y,z,w=.45,mat='cream'){box(w,.10,.29,x,y+.05,z,mat,.035);box(w*.83,.009,.20,x,y+.105,z,mat,.018);}
root=new T.Group();box(1.75,.07,.42,0,.07,0);box(1.75,.07,.42,0,.53,0);for(const x of [-.84,.84])box(.065,.53,.40,x,.3,0);for(let i=0;i<2;i++){towel(-.40,.11+i*.10,0,.62,'sage');towel(.38,.11+i*.10,0,.62);}plant(-.59,.57,0,.52);bottle(.12,.57,0,.28);diffuser(.57,.57,0);await save('towel_shelf','原木毛巾双层壁架','wall',['woodLight']);
root=new T.Group();box(1.05,.07,.36,0,.045,0);for(const x of [-.32,0])bottle(x,.08,0,.26);plant(.35,.08,0,.40);await save('toilet_shelf','如厕区洗护壁架','wall',['woodLight']);
root=new T.Group();frame(0,0,0,.65,.86,'woodLight');for(let i=0;i<4;i++)leaf((i%2?1:-1)*.09,.2+i*.13,.046,.10,i%2?-.8:.8,'sage');await save('botanical','鼠尾草植物装饰画','wall',['woodLight']);
root=new T.Group();box(2.05,.78,.12,0,.39,0,'sage');box(1.85,.59,.014,0,.39,.07,'glass');for(const x of [-.97,.97])box(.095,.78,.23,x,.39,.05,'cream');for(const y of [.05,.73])box(2.05,.10,.23,0,y,.05,'cream');box(2.05,.06,.34,0,.05,.08,'cream');plant(.69,.08,.11,.36);bottle(-.70,.08,.11,.20);await save('window','暖白横向采光窗','wall',['cream'],{daylight:true});
root=new T.Group();cylinder(.19,.14,.24,0,1.08,0,'cream');for(const x of [-.14,.14])line([[x,1.15,0],[0,1.85,0]],.007,'ink');plant(0,1.15,0,.38);vine(-.13,1.04,.07,.91);vine(.12,1.06,.08,.70);await save('hanging_plant','角落垂吊绿萝','wall',['cream']);
root=new T.Group();plant(-.18,1.02,0,.46);vine(.02,1.05,0,.90);vine(.15,1.04,.01,.67);await save('trailing_plant','柜边垂藤盆栽','wall',['cream'],{contact:{width:.30,depth:.30}});
root=new T.Group();box(.96,.06,.09,0,.68,0,'woodLight');for(const x of [-.38,0,.38]){line([[x,.68,.05],[x,.58,.10],[x,.61,.15]],.014,'ink');box(.23,.46,.045,x,.32,.09,x===0?'cream':'sage',.015);}await save('towel_hooks','沐浴毛巾挂钩','wall',['cream']);
root=new T.Group();box(.42,.87,.085,0,.58,0,'cream',.035);for(const x of [-.27,.27])box(.17,.66,.10,x,.61,0,'cream',.035);box(.43,.035,.11,0,.49,.015,'woodLight');line([[0,.99,0],[.08,1.09,0],[.11,1.03,0]],.017,'ink');root.scale.set(1.25,1.7,1);await save('robe','暖白浴袍壁挂','wall',['cream']);
root=new T.Group();box(1.10,.045,.77,0,.023,0,'sage',.03);for(let i=-4;i<=4;i++)box(.098,.02,.72,i*.118,.054,0,'sage',.012);await save('shower_mat','鼠尾草防滑条板垫','rug',['sage']);
root=new T.Group();box(1.8,.034,.84,0,.017,0,'sage',.05);box(1.69,.017,.73,0,.039,0,'paper',.04);for(let i=-13;i<=13;i++)box(.025,.007,.66,i*.06,.05,0,'cream');await save('bath_mat','奶油绿边长浴垫','rug',['sage']);
root=new T.Group();for(let i=0;i<8;i++){const a=i*Math.PI/4;ball(.26,.018,.26,Math.cos(a)*.35,.02,Math.sin(a)*.35,'sage',10);}for(let i=0;i<5;i++){const a=i*Math.PI*2/5;ball(.17,.012,.17,Math.cos(a)*.20,.046,Math.sin(a)*.20,'cream',8);}cylinder(.15,.15,.015,0,.06,0,'sage');await save('flower_mat','奶油花朵如厕地垫','rug',['sage']);
root=new T.Group();for(const x of [-.16,.16]){ball(.125,.025,.22,x,.03,0,'woodLight',10);ball(.128,.072,.14,x,.09,-.05,'cream',10);}await save('slippers','暖白浴室拖鞋','rug',['cream']);
root=new T.Group();cylinder(.25,.20,.57,0,.285,0,'woodLight',16);cylinder(.218,.218,.012,0,.579,0,'earth',16);towel(0,.585,0,.32);for(let i=0;i<18;i++){const a=i*Math.PI/9;line([[Math.sin(a)*.20,.03,Math.cos(a)*.20],[Math.sin(a)*.25,.56,Math.cos(a)*.25]],.009,'cream');}await save('basket','原木编织小篓','floor',['woodLight']);
root=new T.Group();box(.92,.055,.45,0,.028,0,'woodLight',.02);for(const [x,z,s]of [[-.30,0,.37],[-.08,.09,.34],[.15,-.04,.30]])bottle(x,.06,z,s);plant(.31,.06,.02,.40);await save('laundry_top','洗衣台洗护与盆栽','tabletop',['sage'],{contact:{width:.95,depth:.48}});
root=new T.Group();for(const x of [-.28,.0,.27])bottle(x,0,0,.25);await save('cabinet_top','柜顶洗浴瓶罐','tabletop',['sage']);
root=new T.Group();box(.54,.05,.31,0,.025,0,'woodLight');plant(0,.05,0,.68);await save('shower_plant','淋浴顶角绿植','wall',['cream']);
await fs.writeFile('public/room3d/catalog.json',JSON.stringify(catalog,null,2)+'\n');await fs.mkdir('output/bathroom-reference',{recursive:true});await fs.writeFile('output/bathroom-reference/assets-report.json',JSON.stringify(report,null,2));console.log(report);
