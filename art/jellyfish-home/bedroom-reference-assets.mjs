// Authored geometry for the September bedroom reference. No image sampling,
// textures, UVs or vertex colors. Run with pnpm node from the project root.
import fs from 'node:fs/promises';
import * as T from 'three';
import {RoundedBoxGeometry} from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {mergeGeometries,mergeVertices} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {saveGlb} from './asset-geometry.mjs';

const palette={woodLight:'#ffffff',cream:'#eee5d5',paper:'#faf2e4',sage:'#81916b',leaf:'#698348',leafLight:'#91a762',earth:'#6c5743',walnut:'#795c46',ink:'#3c3739',gold:'#bea477',glass:'#b8d0d2',lavender:'#ad97bd',night:'#666579',pink:'#d8bcb1',glow:'#fff0b8'};
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
 for(let i=0;i<7;i++){const a=i*2.399,dx=Math.cos(a)*s*.22,dz=Math.sin(a)*s*.22,top=y+s*(.6+(i%3)*.11);line([[x,y+s*.27,z],[x+dx*.5,top-.1,z+dz*.5],[x+dx,top,z+dz]],.007,'leaf');leaf(x+dx,top,z+dz,s*.17,-Math.cos(a)*.9,i%2?'leafLight':'leaf');}
}
function vine(x,y,z,length=.95){
 line([[x,y,z],[x+.03,y-.3,z+.08],[x-.04,y-length*.7,z+.10],[x+.01,y-length,z+.13]],.011,'leaf');
 for(let i=0;i<10;i++){const t=i/10;leaf(x+(i%2?1:-1)*.08,y-t*length,z+.10,.087,i%2?-.8:.8,i%3?'leaf':'leafLight');}
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
 const size=new T.Box3().setFromObject(combined).getSize(new T.Vector3()).toArray(),triangles=combined.children.reduce((sum,m)=>sum+m.geometry.index.count/3,0),id='bedroom_ref_'+suffix;
 if(triangles>=4000)throw Error(`${id}: ${triangles} triangles exceeds furniture budget`);
 if(extra.support){const s=extra.support;extra={...extra,support:{...s,height:s.height-b.min.y,center:[(s.center?.[0]??0)-c.x,(s.center?.[1]??0)-c.z]}};}
 const a={id,name,surface,collection:'bedroom',url:id+'.glb',revision:'bedroom-reference-1',size,default:[0,surface==='wall'?2:.15,0],boxes:[[-size[0]/2,0,-size[2]/2,size[0]/2,size[1],size[2]/2]],paintMaterials,...extra};
 const ix=catalog.findIndex(a=>a.id===id);if(ix<0)catalog.push(a);else catalog[ix]=a;
 const bytes=await saveGlb(combined,'public/room3d/'+id+'.glb');report.push({id,triangles,bytes,size,groups:groups.size});
}
function cabinet(w,h,d,{slats=false,cream=false,bench=false}={}){
 const mat=cream?'cream':'woodLight';
 box(w,.065,d,0,h-.0325,0,'woodLight',.015);box(w-.04,.065,d-.03,0,.06,0,mat);box(w-.04,h-.10,.04,0,h/2,-d/2+.02,mat);
 for(const x of [-w/2+.04,w/2-.04,-w*.18,w*.18])box(.06,h-.1,d-.025,x,h/2,0,mat);
 if(!bench)for(const x of [-w*.34,w*.34]){box(w*.28,h-.16,.045,x,h/2,d/2-.035,mat);if(slats)for(let j=-4;j<=4;j++)box(.028,h-.22,.025,x+j*w*.028,h/2,d/2-.002,'walnut');}
 box(w*.34,.045,d-.04,0,h*.51,0,'woodLight');books(-w*.12,.10,.015,3,h*.37);storage(w*.04,h*.54,.01,w*.25,h*.25,d*.65);
 if(bench){books(-w*.40,.10,0,5,h*.7);storage(w*.32,.10,.005,w*.25,h*.51,d*.7,'sage');}
}

root=new T.Group();cabinet(3.15,.91,.68,{slats:true});await save('sideboard','暖木格栅书柜','floor',['woodLight'],{support:{shape:'rect',width:3.03,depth:.57,height:.91}});
root=new T.Group();cabinet(2.85,1.02,.70,{cream:true});await save('dresser','奶油开放梳妆柜','floor',['cream'],{support:{shape:'rect',width:2.72,depth:.58,height:1.02}});
root=new T.Group();cabinet(2.45,.56,.68,{bench:true});await save('bench','书本与收纳盒床尾凳','floor',['woodLight'],{support:{shape:'rect',width:2.30,depth:.56,height:.56}});
root=new T.Group();box(2.10,2.85,.90,0,1.425,0,'cream',.025);box(2.24,.09,1.02,0,2.83,0,'woodLight',.018);
for(const x of [-.52,.52]){box(1.015,2.73,.042,x,1.41,.47,'cream',.012);box(.19,.045,.055,x,2.11,.505,'ink',.014);}
photo(.47,.98,.504,.20,.27);photo(.28,1.32,.504,.17,.23);photo(.62,1.6,.504,.22,.28);vine(.97,2.84,.50,.97);
await save('wardrobe','相片双门高衣柜','floor',['cream'],{support:{shape:'rect',width:2.10,depth:.90,height:2.875}});
root=new T.Group();storage(-.42,0,-.03,.72,.38,.54);storage(.38,0,.025,.82,.33,.59,'sage');plant(.91,0,.02,.42);
// The box-and-pot set has a measured contact footprint on the cabinet top.
await save('wardrobe_top','衣柜收纳盒与绿植','tabletop',['sage'],{contact:{width:1.96,depth:.65}});

root=new T.Group();lamp(-1.14,0,0,.55,false);plant(-.60,0,0,.68);for(let i=0;i<2;i++)box(.48,.065,.28,.27,.035+i*.07,0,i?'sage':'walnut');cat(.27,.15,0,.25,false,'cream');cup(-.05,0,.02);diffuser(.93,0,.01);
await save('sideboard_top','球灯绿植与书香摆件','tabletop',['cream'],{contact:{width:2.75,depth:.48}});

root=new T.Group();
const rim=new T.TorusGeometry(1,.058,6,40);rim.scale(.42,.57,.55);mesh(rim,'woodLight',-.81,.70,-.09);const glass=new T.CircleGeometry(1,40);glass.scale(.395,.54,1);mesh(glass,'glass',-.81,.70,-.075);box(.12,.19,.07,-.81,.12,-.09);box(.59,.05,.27,-.81,.025,-.06);
frame(-1.05,0,.12,.22,.27);lamp(-.25,0,.02,.5,false);plant(.21,0,-.03,.47);cup(-.54,0,.15);cat(.62,.08,0,.43,false,'lavender');box(.43,.065,.31,.65,.032,0,'paper');
box(.47,.21,.32,1.11,.105,0,'woodLight');for(let i=0;i<3;i++)frame(.96+i*.14,.10,-.045+i*.028,.13,.26+i*.018,'walnut',i%2?'sage':'night');
await save('dresser_top','椭圆镜与梳妆小物','tabletop',['woodLight'],{contact:{width:2.64,depth:.52}});

root=new T.Group();cat(0,0,0,.78,true);await save('sleeping_cat','蜷睡黑白猫摆件','tabletop',['ink']);
root=new T.Group();for(let i=0;i<5;i++){const a=i*Math.PI*2/5;ball(.34,.22,.34,Math.cos(a)*.27,.22,Math.sin(a)*.27,'sage',12);}ball(.10,.035,.10,0,.443,0,'gold',10);
await save('flower_pouf','鼠尾草花瓣坐墩','floor',['sage'],{seats:[{id:'center',label:'花心',position:[0,.45,0],rotation:0}]});
root=new T.Group();cylinder(.43,.43,.065,0,.64,0,'woodLight',24);for(const a of [0,2.094,4.188])line([[Math.cos(a)*.20,.60,Math.sin(a)*.20],[Math.cos(a)*.29,.03,Math.sin(a)*.29]],.037,'woodLight');
await save('tea_table','床边圆木小茶几','floor',['woodLight'],{support:{shape:'circle',radius:.39,height:.6725}});
root=new T.Group();box(.39,.04,.27,0,.02,0,'sage');box(.34,.033,.23,0,.055,0,'paper');cup(.03,.075,0);await save('tea','书本与一杯热茶','tabletop',['sage']);
root=new T.Group();box(.75,.65,.68,0,.325,0,'woodLight',.02);for(const y of [.2,.47]){box(.67,.22,.035,0,y,.35,'woodLight',.007);box(.18,.025,.03,0,y+.04,.38,'gold',.007);}box(.81,.055,.73,0,.665,0,'woodLight',.012);
await save('nightstand','两抽床头柜','floor',['woodLight'],{support:{shape:'rect',width:.72,depth:.64,height:.6925}});
root=new T.Group();lamp(.05,0,-.06,.74);box(.25,.035,.18,-.20,.018,.07,'sage');diffuser(.27,0,.12);await save('bedside_top','暖光褶皱床头灯与香氛','tabletop',['cream'],{contact:{width:.65,depth:.48}});
root=new T.Group();cylinder(.25,.29,.055,0,.0275,0,'gold',18);cylinder(.025,.025,1.94,0,1.01,0,'gold');lamp(0,1.80,0,.74);await save('floor_lamp','奶油褶皱落地灯','floor',['gold']);

root=new T.Group();for(const y of [.62,1.35])box(1.64,.065,.36,0,y,0,'woodLight',.008);for(const x of [-.75,.75])box(.045,1.58,.055,x,.84,-.15,'cream');books(-.64,.66,0,4,.45);storage(.39,.66,0,.66,.38,.30);plant(-.40,1.39,0,.32);cat(.10,1.39,0,.43,false);plant(.66,1.39,0,.32);vine(.75,1.55,.17,1.14);
for(const [x,y]of [[-.61,.11],[-.27,.0],[.10,.16]])photo(x,y,.02,.22,.29);box(.40,.48,.018,.47,.27,-.06,'paper');for(let i=0;i<3;i++)for(let j=0;j<5;j++)box(.021,.023,.008,.32+j*.072,.14+i*.09,-.044,'gold');
await save('wall_rack','书与黑猫的双层墙架','wall',['woodLight']);
root=new T.Group();box(.95,1.24,.05,0,.62,0,'night');for(const x of [-.49,.49])box(.04,1.30,.075,x,.62,.01);for(const y of [-.01,1.25])box(1.02,.04,.075,0,y,.01);
const crescent=new T.Shape();crescent.absarc(0,0,.14,.6,Math.PI*2-.6,false);crescent.quadraticCurveTo(-.02,-.06,.115,.079);mesh(new T.ShapeGeometry(crescent,20),'gold',.14,.96,.041);
for(let i=0;i<6;i++)ball(.009,.009,.004,-.34+(i%3)*.29,.71+Math.floor(i/3)*.39,.041,'paper',6);
for(const [x,y,s]of [[-.20,.31,.25],[.10,.25,.27],[.31,.37,.20]])ball(s,.12,.009,x,y,.046,'pink',10);
await save('moon_art','月色云朵浮雕画','wall',['woodLight']);
root=new T.Group();for(const [x,y]of [[-.34,.19],[0,0],[.32,.24]])photo(x,y,0,.21,.28);await save('photo_string','夹子相片小墙饰','wall',['paper']);

// Broad window with a deep sill, tied-back pleats, curtain rings and real
// separate supported sill decor. Curtains are shaped surfaces, not painted.
root=new T.Group();const W=3.60,H=2.04;
box(W,H,.024,0,H/2,-.13,'glass');for(const x of [-W/2,0,W/2])box(.055,H,.09,x,H/2,-.08);for(const y of [.015,H-.015])box(W+.07,.06,.12,0,y,-.065);
box(W+.14,.07,.48,0,.01,.03,'woodLight',.014);
const rod=new T.CylinderGeometry(.025,.025,W+.55,10);rod.rotateZ(Math.PI/2);mesh(rod,'gold',0,H+.10,.13);
for(const sign of [-1,1]){
 const g=new T.PlaneGeometry(.69,H+.04,16,18),p=g.attributes.position;
 for(let i=0;i<p.count;i++){const u=p.getX(i)/.69+.5,v=p.getY(i)/(H+.04)+.5,pinch=Math.exp(-Math.pow((v-.30)/.13,2)),w=.69*(1-.43*pinch);p.setXYZ(i,sign*(W/2-.15)+(u-.5)*w+sign*.10*pinch,(H+.04)*v,.14+Math.cos(u*Math.PI*10)*.045*(1-.30*pinch));}g.computeVertexNormals();mats.cream.side=T.DoubleSide;mesh(g,'cream');
 box(.44,.115,.08,sign*(W/2-.05),H*.30,.18,'sage',.018);
 for(let j=0;j<6;j++){const ring=new T.TorusGeometry(.044,.009,4,8);ring.rotateY(Math.PI/2);mesh(ring,'gold',sign*(W/2-.15)+(j-2.5)*.12,H+.085,.13);}
}
await save('window','系带布帘与宽窗台','wall',['cream'],{daylight:true,daylightSettings:{reach:4.8,intensity:80},support:{shape:'rect',width:3.45,depth:.37,height:.07,center:[0,0]}});
root=new T.Group();plant(-1.08,0,0,.62);cat(-.29,0,.01,.48,false,'cream');plant(.35,0,0,.59);plant(1.01,0,0,.37);
await save('sill_garden','窗台小猫与绿植','tabletop',['cream'],{contact:{width:2.72,depth:.30}});

root=new T.Group();box(5.70,.032,5.40,0,.016,0,'cream',.016);for(const x of [-2.74,2.74])box(.032,.006,5.17,x,.036,0,'woodLight');for(const z of [-2.58,2.58])box(5.5,.006,.032,0,.036,z,'woodLight');for(let i=0;i<60;i++)for(const z of [-2.72,2.72])box(.012,.012,.10,-2.67+i*.09,.018,z,'paper');
await save('rug','暖白织边大地毯','rug',['cream']);
root=new T.Group();cylinder(.17,.15,.45,0,.225,0,'cream',20);cylinder(.145,.145,.008,0,.454,0,'earth',20);await save('bin','奶油圆纸篓','floor',['cream']);
root=new T.Group();box(1.32,.025,.73,0,.0125,0,'cream',.012);
for(const x of [-.62,.62])box(.022,.008,.64,x,.028,0,'gold');for(const z of [-.32,.32])box(1.26,.008,.022,0,.028,z,'gold');
ball(.22,.014,.18,-.22,.036,-.02,'pink',12);for(const x of [-.36,-.08])ball(.075,.014,.075,x,.036,-.18,'pink',8);for(const x of [-.29,-.15])ball(.012,.012,.014,x,.052,-.07,'walnut',6);
for(const x of [.24,.48]){ball(.09,.024,.17,x,.04,.02,'paper',10);ball(.09,.055,.095,x,.08,-.045,'cream',10);for(const dx of [-.027,.027])ball(.009,.009,.009,x+dx,.125,-.067,'walnut',6);}
await save('entry_mat','猫咪门垫与软拖鞋','rug',['cream']);

await fs.writeFile('public/room3d/catalog.json',JSON.stringify(catalog,null,2)+'\n');
await fs.writeFile('art/jellyfish-home/sources/showrooms/bedroom-reference-report.json',JSON.stringify(report,null,2)+'\n');
console.log(report);
