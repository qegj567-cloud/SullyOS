import {furniturePaintMaterials} from '../../apps/room3d/furniturePaint.js';
// Reviewed geometry-only Meshy sources. Colors are authored here, never sampled
// from source images or baked into vertex colors.
import fs from 'node:fs/promises';import * as T from 'three';
import {RoundedBoxGeometry} from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {mergeGeometries,mergeVertices,toCreasedNormals} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {readGeometry,splitParts,compactGeometry,saveGlb} from './asset-geometry.mjs';
const make=(name,color,roughness=.8,glow=0)=>{const m=new T.MeshStandardMaterial({color,roughness});m.name=name;if(glow){m.emissive.set(color);m.emissiveIntensity=glow;}return m;};
const m={cream:make('gaming-shell','#efe9e1'),accent:make('gaming-accent','#ab9dc9'),dark:make('gaming-graphite','#424858'),rubber:make('gaming-rubber','#292e39'),metal:make('gaming-metal','#8792a4',.5),screen:make('gaming-screen','#56798a',.55,.12),mint:make('gaming-mint','#a4cdbf'),pink:make('gaming-pink','#ddb4c8'),led:make('gaming-led','#b3bbeb',.65,.25),warm:make('gaming-lamp','#ffefc6',.7,.3),wood:make('woodLight','#fff')};
m.wood.color.setRGB(.8227857351303101,.5972017645835876,.3915724754333496);
const catalog=JSON.parse(await fs.readFile('public/room3d/catalog.json','utf8')),report=[];
const root=()=>new T.Group();
function add(r,g,mat){const mesh=new T.Mesh(g,mat);r.add(mesh);return mesh;}
function box(r,size,pos,mat,radius=0){const g=radius?mergeVertices(new RoundedBoxGeometry(...size,1,radius)):new T.BoxGeometry(...size);g.deleteAttribute('uv');g.translate(...pos);add(r,g,mat);}
async function part(r,g,p,mat,role){const raw=await compactGeometry(g,p.ids),mesh=add(r,mergeVertices(toCreasedNormals(raw,Math.PI/3)),mat);if(role)mesh.userData.gamingRole=role;}
async function load(i){const geos=await readGeometry(`art/jellyfish-home/sources/gaming-${i}-geometry.glb`),g=mergeGeometries(geos);return {g,parts:splitParts(g)};}
async function emit(id,name,r,width,surface,{yscale=1,...extra}={}){
 r.updateMatrixWorld(true);const buckets=new Map();r.traverse(o=>{if(!o.isMesh)return;const g=o.geometry.clone().applyMatrix4(o.matrixWorld),key=o.material.uuid+'/'+(o.userData.gamingRole||'');if(!buckets.has(key))buckets.set(key,{mat:o.material,role:o.userData.gamingRole,gs:[]});g.deleteAttribute('uv');g.deleteAttribute('color');if(!g.index){const indexed=mergeVertices(g);g.dispose();buckets.get(key).gs.push(indexed);}else{buckets.get(key).gs.push(g);}});
 const result=root();for(const {mat,role,gs}of buckets.values()){const mesh=new T.Mesh(mergeGeometries(gs),mat);if(role)mesh.userData.gamingRole=role;result.add(mesh);}
 const b=new T.Box3().setFromObject(result),size=b.getSize(new T.Vector3()),c=b.getCenter(new T.Vector3()),scale=width/size.x;
 result.traverse(o=>{if(o.isMesh)o.geometry.translate(-c.x,-b.min.y,-c.z).scale(scale,scale*yscale,scale);});size.multiply(new T.Vector3(scale,scale*yscale,scale));
 const bytes=await saveGlb(result,`public/room3d/${id}.glb`),a={id,name,surface,url:`${id}.glb`,size:size.toArray(),default:[0,.15,0],boxes:[[-size.x/2,0,-size.z/2,size.x/2,size.y,size.z/2]],paintMaterials:['gaming-accent'],collection:'gaming',...extra};
 const names=[];result.traverse(o=>{if(o.isMesh)names.push(o.material.name)});a.paintMaterials=furniturePaintMaterials(a,names);
 const old=catalog.findIndex(a=>a.id===id);if(old<0)catalog.push(a);else catalog[old]=a;
 let triangles=0;result.traverse(o=>{if(o.isMesh)triangles+=o.geometry.index.count/3;});report.push({id,name,bytes,triangles,materials:buckets.size,size:a.size});return {a,point:([x,y,z])=>[(x-c.x)*scale,(y-b.min.y)*scale*yscale,(z-c.z)*scale],scale,sy:scale*yscale};
}
// 1: Preserve the braced legs and upper riser. Rebuild only the uneven support
// planes, so accessories contact flat wood instead of the original wavy mesh.
{
 const {g,parts}=await load(1),r=root();
 for(const p of parts){if([2101,2112,1889,1185,1179,1965].includes(p.id))continue;const c=p.center;await part(r,g,p,c.y<-.25?m.rubber:Math.abs(c.x)>.38?m.accent:m.metal);}
 box(r,[1,.052,.46],[0,.143,.007],m.wood,.008);box(r,[.87,.023,.184],[.002,.231,-.138],m.wood,.006);
 const {a,point,scale}=await emit('gaming_desk','双层电竞桌',r,3.4,'floor',{yscale:.78});
 const low=point([0,.169,.007]),high=point([.002,.2425,-.138]);
 a.support={shape:'rect',width:3.24,depth:.46*scale-.06,height:low[1],center:[low[0],low[2]],areas:[{shape:'rect',width:.87*scale-.06,depth:.184*scale-.025,height:high[1],center:[high[0],high[2]]}]};
 // Keep a walkable knee recess; collision slabs and legs follow actual geometry.
 a.boxes=[[-1.7,low[1]-.18,-.76,1.7,low[1],.79],[-1.58,0,-1.0,-1.28,low[1],1.0],[1.28,0,-1.0,1.58,low[1],1.0],[-1.48,high[1]-.09,high[2]-.34,1.48,high[1],high[2]+.34]];
}
// 2: Independent triple display, keyboard, mouse+pad, and one repeatable speaker.
{
 const {g,parts}=await load(2),monitor=root(),keyboard=root(),mouse=root(),speaker=root();
 for(const p of parts){const c=p.center;
  if([1556,1948].includes(p.id)){if(p.id===1556)await part(speaker,g,p,m.cream);continue;}
  if(c.z>.06&&c.y<-.24){if([2089,2112].includes(p.id))await part(mouse,g,p,p.id===2089?m.accent:m.rubber);else if(p.id===1896)await part(keyboard,g,p,m.dark);continue;}
  // Thin cables become noise at room scale; keep the solid arm and base.
  if([1739,2184,806,979].includes(p.id))continue;
  if([2068,2130,2175].includes(p.id)){
   const indices=g.index,positions=g.attributes.position,front=[],edge=[];
   for(let k=0;k<p.ids.length;k+=3){const ids=p.ids.slice(k,k+3),v=ids.map(i=>new T.Vector3().fromBufferAttribute(positions,i)),n=v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).normalize(),c=v[0].clone().add(v[1]).add(v[2]).multiplyScalar(1/3);(n.z>.45&&c.y>.008&&c.y<.27?front:edge).push(...ids);}
   if(front.length)await part(monitor,g,{ids:front},m.screen);if(edge.length)await part(monitor,g,{ids:edge},m.dark);
  }else await part(monitor,g,p,p.center.y<-.23?m.accent:m.metal);
 }
 // Keycaps are simple solid boxes, no text image or generated graphics.
 for(let row=0;row<5;row++)for(let col=0;col<13;col++)box(keyboard,[.028,.013,.039],[-.325+col*.033,.298*-1+ .012,.097+row*.055],row===0||col===0?m.accent:(row+col)%9===0?m.mint:m.cream);
 box(keyboard,[.19,.013,.031],[-.13,-.279,.38],m.accent);
 speaker.clear();box(speaker,[.14,.18,.13],[0,.09,0],m.cream,.012);for(const [y,r]of [[.067,.044],[.137,.02]]){const driver=new T.CylinderGeometry(r,r,.008,20);driver.rotateX(Math.PI/2);driver.translate(0,y,.067);add(speaker,driver,m.rubber);}
 // Shorten the support column; move all three screens down rigidly. Their
 // aspect ratios and the tabletop contact footprint stay unchanged.
 const monitorHeight=y=>y-(.42/2.32)*T.MathUtils.clamp((y+.2431640625)/(.2431640625-.055),0,1);
 monitor.traverse(o=>{if(!o.isMesh)return;const p=o.geometry.attributes.position;for(let i=0;i<p.count;i++)p.setY(i,monitorHeight(p.getY(i)));p.needsUpdate=true;o.geometry.computeVertexNormals();});
 const monitorAsset=await emit('gaming_monitors','三屏显示器',monitor,2.32,'tabletop'),base=monitorAsset.point([0,-.303,-.297]);monitorAsset.a.contact={width:.20*monitorAsset.scale,depth:.203*monitorAsset.scale,center:[base[0],base[2]]};
 monitorAsset.a.boxes=[2131,2080,1881,2068,2130,2175,2187,2007].map(id=>{const p=parts.find(p=>p.id===id),point=v=>monitorAsset.point([v.x,monitorHeight(v.y),v.z]);return [...point(p.box.min),...point(p.box.max)];});
 await emit('gaming_keyboard','奶油机械键盘',keyboard,.95,'tabletop');await emit('gaming_mouse','鼠标与桌垫',mouse,.60,'tabletop');await emit('gaming_speaker','桌面小音箱',speaker,.35,'tabletop',{paintMaterials:['gaming-shell']});
}
// 3: Shelf props remain an intentional display collection inside the cabinet.
{
 const {g,parts}=await load(3),r=root();for(const p of parts){const c=p.center,s=p.box.getSize(new T.Vector3());let mat=m.cream;
  if(s.x>.39&&s.y<.04)mat=m.wood;else if(c.y<-.19&&c.z>.10)mat=m.accent;else if(Math.abs(c.x)<.18&&c.y>.2)mat=c.x<0?m.pink:m.mint;else if(c.y>.035&&c.y<.16&&Math.abs(c.x)<.18)mat=p.count>300?m.dark:m.accent;else if(c.y>-.19&&c.y<.025&&Math.abs(c.x)<.18)mat=[m.mint,m.accent,m.cream][p.id%3];await part(r,g,p,mat);}
 await emit('gaming_display','游戏收藏展示柜',r,1.35,'floor');
}
// 4: Empty wheeled drawers, separate task lamp, memo pad and phone stand.
{
 const {g,parts}=await load(4),drawer=root(),lamp=root(),notes=root(),phone=root();
 for(const p of parts){if([2154,2018].includes(p.id))continue;
  if(p.id===2059){await part(notes,g,p,m.cream);continue;}if(p.id===1656){await part(phone,g,p,m.accent);continue;}
  if(p.center.y>.155){await part(lamp,g,p,p.center.y>.40?m.warm:m.accent);continue;}
  await part(drawer,g,p,p.center.y<-.44?m.rubber:[2164,2138,1786].includes(p.id)?m.accent:m.cream);
 }
 box(drawer,[.537,.038,.477],[.001,.145,-.001],m.wood,.005);box(drawer,[.50,.538,.015],[0,-.128,-.207],m.cream);
 const {a}=await emit('gaming_drawers','滚轮三层抽屉柜',drawer,1.05,'floor',{yscale:.84});a.support={shape:'rect',width:.98,depth:.86,height:a.size[1]};
 const lampAsset=await emit('gaming_lamp','折臂桌灯',lamp,.55,'tabletop'),foot=lampAsset.point([-.021,.157,-.139]);lampAsset.a.contact={width:.138*lampAsset.scale,depth:.138*lampAsset.scale,center:[foot[0],foot[2]]};
 await emit('gaming_notepad','桌面便签本',notes,.29,'tabletop',{paintMaterials:['gaming-shell']});await emit('gaming_phone_stand','手机支架',phone,.30,'tabletop');
}
// 5/6: Freestanding accessory organizer and steering-wheel stand (no seat).
{
 const {g,parts}=await load(5),r=root();for(const p of parts){let mat=m.accent;
  if(p.id===2120)mat=m.dark;else if(p.center.y<-.4)mat=m.cream;else if([1900,1412,1944].includes(p.id))mat=m.led;else if([2089,2170,2121,2081].includes(p.id))mat=m.cream;else if(p.center.x>.18&&p.center.y<0)mat=m.mint;await part(r,g,p,mat);}
 await emit('gaming_organizer','游戏配件展示架',r,1.65,'floor');
}
{
 const {g,parts}=await load(6),r=root();for(const p of parts){let mat=m.metal;
  if([2113,1886].includes(p.id)||p.center.y<-.435)mat=m.rubber;else if(p.id===2192||p.id===1281||p.id===2197)mat=m.accent;else if(p.center.y>.15)mat=m.dark;else if(p.center.y<-.17&&Math.abs(p.center.x+.08)<.25)mat=m.dark;await part(r,g,p,mat,[2113,1365,324,1228].includes(p.id)?'wheel':undefined);}
 // Fit the screen inside the existing X/Z footprint so saved wheel/seat poses
 // stay exactly aligned. Author in normalized world units, then return to source.
 const bounds=new T.Box3().setFromObject(r),center=bounds.getCenter(new T.Vector3()),unit=1.6/bounds.getSize(new T.Vector3()).x,screen=root();
 box(screen,[1.54,.91,.105],[0,2.12,-.48],m.dark,.04);
 box(screen,[.09,1.05,.10],[0,1.17,-.52],m.metal);
 box(screen,[.72,.075,.30],[0,.68,-.48],m.accent,.018);
 box(screen,[1.42,.79,.008],[0,2.12,-.423],m.screen);
 // A miniature road scene is geometry, not an image or image-derived colors.
 const polygon=(points,mat,z)=>{const shape=new T.Shape(points.map(p=>new T.Vector2(...p))),g=new T.ShapeGeometry(shape);g.translate(0,0,z);g.deleteAttribute('uv');add(screen,g,mat);};
 polygon([[-.71,1.725],[.71,1.725],[.71,2.07],[-.71,2.07]],m.mint,-.417);
 polygon([[-.49,1.725],[.49,1.725],[.07,2.16],[-.07,2.16]],m.dark,-.411);
 for(const [y,w,h]of [[1.80,.024,.065],[1.96,.016,.047],[2.08,.008,.023]])box(screen,[w,h,.003],[0,y,-.406],m.cream);
 const screenBoxes=[[-.77,1.665,-.533,.77,2.575,-.403],[-.045,.645,-.57,.045,1.695,-.47],[-.36,.6425,-.63,.36,.7175,-.33]];
 screen.traverse(o=>{if(o.isMesh)o.geometry.scale(1/unit,1/unit,1/unit).translate(center.x,bounds.min.y,center.z);});r.add(screen);
 const race=await emit('gaming_racing','赛车屏幕与方向盘架',r,1.60,'floor');const wheel=race.point([-.0786,.2852,.3066]);race.a.boxes=[...parts.map(p=>[...race.point(p.box.min.toArray()),...race.point(p.box.max.toArray())]),...screenBoxes];race.a.activity={kind:'race',position:[wheel[0],.98,wheel[2]+.48],rotation:180,hands:[[wheel[0]-.22,wheel[1],wheel[2]+.025],[wheel[0]+.22,wheel[1],wheel[2]+.025]]};
}
// 7: Separate boom microphone, headphones+stand, webcam and charging dock.
{
 const {g,parts}=await load(7),mic=root(),headphones=root(),camera=root(),dock=root();
 for(const p of parts){const c=p.center;
  if(c.z<-.15){await part(camera,g,p,[1619,2149].includes(p.id)?m.dark:m.cream);continue;}
  if(c.x>.07&&c.y<-.20){await part(dock,g,p,p.id===2194?m.cream:p.id===2029?m.accent:m.dark);continue;}
  if(c.x<-.30||c.y>.095){await part(mic,g,p,[1858,1979,2208].includes(p.id)?m.dark:m.accent);continue;}
  await part(headphones,g,p,[1744,2134].includes(p.id)?m.rubber:[1838,2002].includes(p.id)?m.accent:m.cream);
 }
 const micAsset=await emit('gaming_microphone','悬臂麦克风',mic,.76,'tabletop');micAsset.a.boxes=mic.children.map(mesh=>{mesh.geometry.computeBoundingBox();const b=mesh.geometry.boundingBox;return [...micAsset.point(b.min.toArray()),...micAsset.point(b.max.toArray())];});await emit('gaming_headphones','耳机与支架',headphones,.48,'tabletop');await emit('gaming_webcam','桌面摄像头',camera,.29,'tabletop');await emit('gaming_controller_dock','双手柄充电座',dock,.64,'tabletop');
}
// 8/9 are the only original files carrying image maps. Only their clean geometry
// enters the repository; the electronics and light colors are all chosen above.
{
 const {g,parts}=await load(8),r=root();for(const p of parts){const c=p.center;let mat=m.metal;
  if(p.id===2095)mat=m.cream;else if(c.y>.395)mat=m.accent;else if(c.y<-.44)mat=m.rubber;else if([2030,2032,1838,1847,1828].includes(p.id))mat=m.led;else if(c.z<.03&&c.y>-.23&&c.y<.28)mat=m.dark;else if(c.y<-.10)mat=m.accent;await part(r,g,p,mat);}
 await emit('gaming_pc','猫耳游戏机箱',r,1.02,'floor');
}
{
 const {g,parts}=await load(9),r=root();for(const p of parts){let mat=m.dark;if([1966,2173,2170,2124,2115].includes(p.id))mat=m.led;else if(p.center.y>.43||p.center.y<-.425)mat=m.accent;await part(r,g,p,mat);}
 await emit('gaming_light','分段氛围立灯',r,.78,'floor');
}


// User-selected cat-ear chair: preserve its silhouette, cushions and armrests.
// Seat is forward of the tall back, with enough room for the chibi's head.
{
 const g=mergeGeometries(await readGeometry('art/jellyfish-home/sources/gaming-chair-geometry.glb')),parts=splitParts(g),r=root();
 for(const p of parts){let mat=m.metal;
  if(p.id===2185)mat=m.cream;
  else if([2098,1909,1981,2190,2162,2022,2195].includes(p.id))mat=m.accent;
  else if(p.center.y<-.43)mat=m.rubber;
  else if([2128,1895].includes(p.id))mat=m.dark;
  else if(p.id===2011||p.id===2137)mat=m.cream;
  await part(r,g,p,mat);
 }
 const chair=await emit('gaming_chair','猫耳电竞椅',r,1.50,'floor');
 chair.a.boxes=parts.map(p=>[...chair.point(p.box.min.toArray()),...chair.point(p.box.max.toArray())]);
 chair.a.seats=[{id:'center',label:'座位',position:chair.point([-.016,-.104,.17]),rotation:0}];
}
// User-supplied twin cabinet: preserve the full-height body, marquee and upper
// displays. Rebuild circular interfaces as clean tilted geometry, with no images.
{
 const g=mergeGeometries(await readGeometry('art/jellyfish-home/sources/gaming-arcade-geometry.glb')),parts=splitParts(g),r=root();
 const cyan=make('gaming-arcade-cyan','#8acfdc'),yellow=make('gaming-arcade-yellow','#eed487');
 for(const p of parts){
  if([2103,2080,2124,1789,1780,1913].includes(p.id))continue;
  let mat=m.cream;
  if([2190,2145,1873].includes(p.id))mat=cyan;
  else if([2166,1289,2098,1924,2075,1218,2169,1995,553,2082,727,1109,2177,2173,1883,1585].includes(p.id))mat=m.dark;
  else if([2087,1524,1592].includes(p.id))mat=m.accent;
  else if([2097,1930,2179].includes(p.id))mat=m.pink;
  await part(r,g,p,mat);
 }
 // Upper widescreens sit inside the original frames.
 for(const x of [-.245,.245])box(r,[.262,.084,.006],[x,.199,.078],m.screen,.005);
 const stationData=[];
 for(const [id,x]of [['left',-.245],['right',.245]]){
  const face=root();face.position.set(x,-.055,.159);face.rotation.x=-.30;r.add(face);
  const disc=new T.CylinderGeometry(.130,.130,.008,48);disc.rotateX(Math.PI/2);add(face,disc,m.screen);
  const rim=new T.TorusGeometry(.157,.023,5,48);add(face,rim,m.dark);
  const halo=new T.TorusGeometry(.134,.003,4,48);halo.translate(0,0,.008);add(face,halo,m.led);
  const buttons=[];
  for(let k=0;k<8;k++){
   const angle=k*Math.PI/4,key=new T.TorusGeometry(.157,.019,5,5,.49);key.scale(1,1,.50);key.rotateZ(angle-.245);key.translate(0,0,.021);
   add(face,key,[cyan,m.pink,yellow,m.cream][k%4]).userData.gamingRole=`rhythm-key-${id}-${k}`;
   buttons.push(new T.Vector3(Math.cos(angle)*.157,Math.sin(angle)*.157,.037));
  }
  // Hand-authored geometric notes; no copied logos, text or screen artwork.
  for(const [nx,ny,mat]of [[-.044,.026,m.pink],[.042,-.024,cyan],[.005,.068,yellow]]){
   const note=new T.TorusGeometry(.012,.004,4,12);note.translate(nx,ny,.007);add(face,note,mat);
  }
  face.updateMatrixWorld(true);stationData.push({id,x,buttons:buttons.map(v=>face.localToWorld(v).toArray())});
 }
 const arcade=await emit('gaming_maimai','双屏圆环音游机',r,3.10,'floor',{paintMaterials:['gaming-arcade-cyan']});
 // Slice the actual sloping surfaces vertically. A full-height AABB would
 // invent a wall in front of the upper screen and block every high jump.
 arcade.a.boxes=[];r.updateMatrixWorld(true);r.traverse(mesh=>{
  if(!mesh.isMesh)return;const geo=mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);geo.computeBoundingBox();
  const pos=geo.attributes.position,idx=geo.index,box=geo.boundingBox,n=Math.max(1,Math.ceil((box.max.y-box.min.y)/.045));
  for(let slice=0;slice<n;slice++){
   const low=box.min.y+(box.max.y-box.min.y)*slice/n,high=box.min.y+(box.max.y-box.min.y)*(slice+1)/n,bounds=new T.Box3();
   for(let i=0;i<(idx?.count||pos.count);i+=3){const vs=[0,1,2].map(k=>new T.Vector3().fromBufferAttribute(pos,idx?idx.getX(i+k):i+k));
    if(Math.min(...vs.map(v=>v.y))>high||Math.max(...vs.map(v=>v.y))<low)continue;
    for(let k=0;k<3;k++){const v=vs[k],w=vs[(k+1)%3];if(v.y>=low&&v.y<=high)bounds.expandByPoint(v);
     for(const y of [low,high])if((v.y<y&&w.y>y)||(v.y>y&&w.y<y))bounds.expandByPoint(v.clone().lerp(w,(y-v.y)/(w.y-v.y)));
    }
   }
   if(!bounds.isEmpty())arcade.a.boxes.push([...arcade.point(bounds.min.toArray()),...arcade.point(bounds.max.toArray())]);
  }geo.dispose();
 });
 arcade.a.activity={kind:'rhythm',stations:stationData.map(s=>{
  const buttons=s.buttons.map(arcade.point),position=arcade.point([s.x,-.5,.415]);
  // Each beat has a reviewed landing-to-apex path. Follow the inclined face
  // slightly forward on higher jumps, so the tiny hands never stretch.
  const patterns=[[5,7],[4,0],[3,1],[2],[4,0],[6]];
  const beats=patterns.map(keys=>{const y=Math.max(...keys.map(k=>buttons[k][1]))-.49,z=Math.max(...keys.map(k=>buttons[k][2]))+.50;
   return {position:[position[0],y,z],targets:keys.map(k=>buttons[k]),keys:keys.map(k=>`rhythm-key-${s.id}-${k}`)};
  });
  return {id:s.id,label:s.id==='left'?'左侧':'右侧',position,rotation:180,hands:[buttons[5],buttons[7]],beats};
 })};
}
await fs.writeFile('public/room3d/catalog.json',JSON.stringify(catalog,null,2)+'\n');await fs.mkdir('output/gaming-room',{recursive:true});await fs.writeFile('output/gaming-room/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));

await import('./study-gaming-finishes.mjs');
