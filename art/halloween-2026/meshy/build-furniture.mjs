import fs from 'node:fs/promises';
import * as T from 'three';
import {createHash} from 'node:crypto';
import {readGeometry,splitParts,compactGeometry,saveGlb} from '../../jellyfish-home/asset-geometry.mjs';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {cutSurface,chairCushion} from './furniture-repairs.mjs';
const base='art/halloween-2026/meshy',out='public/room3d';
const colors={purple:'#54217c',orange:'#ee7219',black:'#242129',green:'#91b935',gold:'#dca84b',cream:'#fff0cf',glass:'#382247'};
const labels={purple:'紫绒',orange:'南瓜橙',black:'黑色框架',green:'魔法绿',gold:'金色饰边',cream:'象牙白',glass:'紫色镜面'};
export const specs=[
 {id:'bat-sofa',name:'蝙蝠双人沙发',width:3.9,batch:9,max:7900,seats:[[-.94,.845,.38],[.94,.845,.38]]},
 {id:'coffin-coffee-table',name:'棺木月牙茶几',width:2.7,batch:9,max:5900,support:{shape:'rect',width:1.9,depth:.85,height:.64}},
 {id:'pumpkin-armchair',name:'南瓜扶手椅',width:2.1,batch:9,max:6700,seats:[[0,.55,.70]]},
 {id:'potion-bookcase',name:'魔药尖顶书柜',height:3.5,batch:9,max:7900},
 {id:'haunted-fireplace',name:'幽宅魔火壁炉',width:2.6,batch:10,max:7900,support:{shape:'rect',width:1.75,depth:.40,height:1.49,center:[0,-.08]}},
 {id:'ghost-floor-lamp',name:'幽灵落地灯',height:2.65,batch:10,max:5900},
 {id:'gothic-curtain-window',name:'哥特月夜帘窗',width:3.6,batch:10,max:7900,surface:'wall'},
 {id:'bat-rug',name:'蝙蝠花边地毯',width:3.6,batch:10,max:3900,surface:'rug'},
 {id:'cauldron-planter',name:'魔药蘑菇坩埚',width:1.0,batch:11,max:5900},
 {id:'cat-ear-mirror',sourceId:'cat-mirror',name:'猫耳穿衣镜',height:2.65,batch:11,max:5900},
 {id:'bat-pumpkin-clock',sourceId:'pumpkin-bat-clock',name:'蝙蝠南瓜挂钟',width:1.55,batch:11,max:3900,surface:'wall'},
];
function paint(id,p,v,n){const c=p.center,s=p.box.getSize(new T.Vector3()),x=Math.abs(v.x),y=v.y,z=v.z;
 if(id==='bat-sofa'){
  if(p.count<1000&&c.y>0)return y>p.box.max.y-.025?'green':'orange';
  if(y<-.15)return 'black';
  return 'purple';
 }
 if(id==='coffin-coffee-table'){if(p.count<250)return 'gold';if(c.y<0)return 'black';if(y>.098)return x>.40||Math.abs(z)>.19?'orange':'purple';return 'black';}
 if(id==='pumpkin-armchair'){if(c.y>.2)return 'green';if(c.y<-.35)return 'black';if(z>-.29&&x<.32&&y<.15&&y>-.33&&Math.hypot(v.x/ .36,(z+.05)/.49)<1)return 'purple';return 'orange';}
 if(id==='potion-bookcase'){
  if(c.z>.09&&c.y<-.2&&s.x<.07)return 'cream';
  if(c.y>.3&&s.x<.1)return 'orange';
  if(c.y>-.2&&c.y<.22&&s.x<.13&&s.y<.22){if(s.z<.12)return c.x>.065?'orange':'green';return ['purple','orange','green','gold'][Math.abs(Math.round(c.x*90))%4];}
  if(s.x>.3&&z<-.09&&y>-.2)return 'purple';return 'black';
 }
 if(id==='haunted-fireplace'){
  if(p.id===4158||Math.abs(c.x)<.14&&c.y>-.22&&s.x<.04)return 'green';
  if([4148,4161,3884,3752,4059,4169].includes(p.id))return 'orange';
  if(s.y<.04&&s.x>.6&&c.y>.09)return 'orange';
  if(p.id===4190)return 'gold';return 'black';
 }
 if(id==='ghost-floor-lamp'){
  if(c.y>.2)return 'cream';
  if(c.y<-.3)return 'orange';if(s.x<.12&&s.y>.4)return 'black';return 'purple';
 }
 if(id==='gothic-curtain-window'){
  if([4065,4184,3922,4017].includes(p.id)||s.x<.12&&s.y<.12&&Math.abs(c.x)>.3&&c.y<0&&c.y>-.13)return 'green';
  if(Math.abs(c.x)>.27&&s.y>.2)return Math.abs(c.x)>.40?'orange':'purple';
  if(Math.abs(c.x)>.2&&c.y>.27&&s.x<.08)return 'gold';
  if(s.z<.012&&c.y>-.2&&Math.abs(c.x)<.18&&s.x<.16)return 'glass';
  if(p.id===4177)return z<-.025?'glass':'black';return 'black';
 }
 if(id==='bat-rug')return p.count>2000?'orange':p.count>600?'black':'purple';
 if(id==='cauldron-planter'){
  if([3129,3080,3008].includes(p.id))return 'purple';
  if(c.y>.15&&s.x<.09)return 'cream';
  if([3055,3083,185].includes(p.id))return 'cream';
  return c.y>.045||p.id===2896?'green':'black';
 }
 if(id==='cat-ear-mirror')return 'black';
 if(id==='bat-pumpkin-clock'){
  if(p.id!==2094)return 'gold';
  if(y>.17&&x<.12)return 'green';
  if(x>.18)return 'black';
  return Math.hypot(v.x/.16,(y+.053)/.14)<1&&z>.012?'black':'orange';
 }
 return 'purple';
}
const report=[];
for(const spec of specs){
 const source=`${base}/halloween-batch-${String(spec.batch).padStart(2,'0')}-furniture/${spec.sourceId||spec.id}.glb`;
 try{await fs.access(source);}catch{continue;}
 if(process.argv[2]&&!spec.id.includes(process.argv[2]))continue;
 const geometries=await readGeometry(source);if(spec.id==='bat-rug')for(const g of geometries)g.rotateX(-Math.PI/2).scale(1,.28,1.445);
 const total=geometries.reduce((n,g)=>n+g.index.count/3,0),bounds=new T.Box3();for(const g of geometries){g.computeBoundingBox();bounds.union(g.boundingBox);}const size=bounds.getSize(new T.Vector3()),center=bounds.getCenter(new T.Vector3()),scale=spec.width?spec.width/size.x:spec.height/size.y;
 const buckets={};
 for(const geometry of geometries)for(const part of splitParts(geometry)){
  const g=await compactGeometry(geometry,part.ids,Math.max(8,Math.floor(spec.max*part.count/total))),pos=g.attributes.position,groups={};
  const repair=spec.id==='pumpkin-armchair'&&part.count>4000?[chairCushion,'purple','orange']:null;
  if(repair){
   const pieces=cutSurface(g,repair[0]);
   for(const [i,g2]of pieces.entries()){if(!g2.index.count)continue;g2.translate(-center.x,-bounds.min.y,-center.z).scale(scale,scale,scale);(buckets[repair[i+1]]??=[]).push(g2);}continue;
  }
  for(let i=0;i<g.index.count;i+=3){const ids=[0,1,2].map(k=>g.index.getX(i+k)),vs=ids.map(k=>new T.Vector3().fromBufferAttribute(pos,k)),v=vs[0].clone().add(vs[1]).add(vs[2]).divideScalar(3),n=vs[1].clone().sub(vs[0]).cross(vs[2].clone().sub(vs[0])).normalize(),color=paint(spec.id,part,v,n);(groups[color]??=[]).push(...ids);}
  for(const [color,ids]of Object.entries(groups)){const g2=await compactGeometry(g,ids);g2.translate(-center.x,-bounds.min.y,-center.z).scale(scale,scale,scale);(buckets[color]??=[]).push(g2);}
 }
 if(spec.id==='gothic-curtain-window'){
  const shape=new T.Shape();shape.moveTo(-.185,-.2);shape.lineTo(.185,-.2);shape.lineTo(.185,.13);shape.quadraticCurveTo(.14,.25,0,.32);shape.quadraticCurveTo(-.14,.25,-.185,.13);shape.closePath();
  const pane=new T.ExtrudeGeometry(shape,{depth:.008,bevelEnabled:false,curveSegments:8});pane.translate(0,0,-.045).translate(-center.x,-bounds.min.y,-center.z).scale(scale,scale,scale);pane.deleteAttribute('uv');pane.setIndex(Array.from({length:pane.attributes.position.count},(_,i)=>i));(buckets.glass??=[]).push(pane);
  const moon=new T.Shape(),r=.045;moon.absarc(0,0,r,Math.PI/3,5*Math.PI/3,false);moon.quadraticCurveTo(-.003,0,r*.5,r*Math.sqrt(3)/2);moon.closePath();
  const decorations=[[moon,-.085,.15]];
  for(const [x,y,radius]of [[.09,.13,.016],[-.10,-.04,.012],[.085,-.085,.01]]){const star=new T.Shape();for(let i=0;i<10;i++){const angle=Math.PI/2+i*Math.PI/5,rad=i%2?radius*.42:radius;star[i?'lineTo':'moveTo'](Math.cos(angle)*rad,Math.sin(angle)*rad);}star.closePath();decorations.push([star,x,y]);}
  for(const [shape,x,y]of decorations){const g=new T.ShapeGeometry(shape,12);g.deleteAttribute('uv');g.translate(x,y,.025).translate(-center.x,-bounds.min.y,-center.z).scale(scale,scale,scale);(buckets.gold??=[]).push(g);}
 }
 if(spec.id==='cat-ear-mirror'){
  const shape=new T.Shape();shape.moveTo(-.15,-.335);shape.lineTo(.15,-.335);shape.lineTo(.15,.245);shape.quadraticCurveTo(.15,.335,0,.35);shape.quadraticCurveTo(-.15,.335,-.15,.245);shape.closePath();
  const pane=new T.ShapeGeometry(shape,12),p=pane.attributes.position;for(let i=0;i<p.count;i++)p.setZ(i,.142-.15*p.getY(i));pane.computeVertexNormals();pane.deleteAttribute('uv');pane.translate(-center.x,-bounds.min.y,-center.z).scale(scale,scale,scale);(buckets.glass??=[]).push(pane);
 }
 if(spec.id==='ghost-floor-lamp')for(const x of [-.031,.031]){
  const eye=new T.CircleGeometry(1,24);eye.scale(.025,.044,1).translate(x,.385,.052);eye.deleteAttribute('uv');eye.translate(-center.x,-bounds.min.y,-center.z).scale(scale,scale,scale);(buckets.black??=[]).push(eye);
 }
 const root=new T.Group();for(const [color,gs]of Object.entries(buckets)){const mesh=new T.Mesh(mergeGeometries(gs),new T.MeshStandardMaterial({name:'halloween_'+color,color:colors[color],roughness:color==='gold'?.48:.87,metalness:color==='gold'?.2:0}));mesh.name=spec.id+'_'+color;root.add(mesh);}
 const id='halloween_'+spec.id.replaceAll('-','_'),file=id+'.glb',triangles=root.children.reduce((n,m)=>n+m.geometry.index.count/3,0),final=size.multiplyScalar(scale).toArray();
 await saveGlb(root,`${out}/${file}`);const bytes=await fs.readFile(`${out}/${file}`),entry={id,name:spec.name,url:file,surface:spec.surface||'floor',size:final,default:[0,.15,0],boxes:[[-final[0]/2,0,-final[2]/2,final[0]/2,final[1],final[2]/2]],collection:'living',revision:createHash('sha256').update(bytes).digest('hex').slice(0,12),paintMaterials:Object.keys(buckets).map(k=>'halloween_'+k),colorParts:Object.keys(buckets).map(k=>({material:'halloween_'+k,label:labels[k],color:colors[k]})),...(spec.support?{support:spec.support}:{}),...(spec.seats?{seats:spec.seats.map((position,i)=>({id:String(i),label:spec.seats.length>1?['左侧','右侧'][i]:'中间',position,rotation:0}))}:{})};
 if(spec.surface==='rug'){entry.boxes=[];}
 report.push({entry,triangles,bytes:bytes.length,source,sourceTriangles:total});console.log(spec.id,triangles,final.map(x=>+x.toFixed(3)));
}
const path=`${base}/furniture-report.json`,old=await fs.readFile(path,'utf8').then(JSON.parse).catch(()=>[]),combined=[...old.filter(x=>!report.some(r=>r.entry.id===x.entry.id)),...report];await fs.writeFile(path,JSON.stringify(combined,null,2));
