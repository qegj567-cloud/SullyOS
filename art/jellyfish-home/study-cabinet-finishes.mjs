// Rebuild the two study cabinets at their existing dimensions: separate painted
// carcasses, shelf boards, book covers and storage boxes; no image textures.
import fs from 'node:fs/promises';
import * as T from 'three';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {saveGlb} from './asset-geometry.mjs';
const catalog=JSON.parse(await fs.readFile('public/room3d/catalog.json','utf8'));
const colors={shell:'#45463c',shelf:'#eadfc9',green:'#858d67',paper:'#e6dcc8',handle:'#303328'};
const mats=Object.fromEntries(Object.entries(colors).map(([key,color])=>{const m=new T.MeshStandardMaterial({color,roughness:.78});m.name='study-'+key;return [key,m];}));
for(const id of ['show_study_tower','show_study_shelf']){
 const a=catalog.find(a=>a.id===id),[w,h,d]=a.size,parts={};
 const box=(size,pos,key)=>{const g=new T.BoxGeometry(...size);g.deleteAttribute('uv');g.translate(...pos);(parts[key]??=[]).push(g);};
 box([w,h,.06],[0,h/2,-d/2+.03],'shell');
 for(const x of [-1,1])box([.075,h,d],[x*(w/2-.0375),h/2,0],'shell');
 const rows=id==='show_study_tower'?5:2,cols=id==='show_study_tower'?1:3,step=(h-.12)/rows,cw=(w-.15)/cols;
 for(let r=0;r<=rows;r++)box([w-.15,.06,d-.03],[0,.06+r*step,.015],'shelf');
 for(let c=1;c<cols;c++)box([.05,h-.12,d-.04],[-w/2+.075+c*cw,h/2,.01],'shell');
 for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
  const left=-w/2+.075+c*cw,base=.09+r*step;
  if((r+c)%3===0){
   box([cw*.8,step*.65,d*.73],[left+cw/2,base+step*.325,.04],'green');
   box([cw*.2,.04,.024],[left+cw/2,base+step*.40,d*.365+.055],'handle');
  }else{
   for(let b=0;b<4;b++){
    const bw=cw*.13,bh=step*(.62+(b%3)*.08),x=left+cw*.16+b*cw*.17;
    box([bw,bh,d*.65],[x,base+bh/2,.02],b%2?'shelf':'green');
    box([bw*.68,.024,.012],[x,base+bh*.8,d*.325+.028],'paper');
   }
  }
 }
 const root=new T.Group();for(const [key,gs]of Object.entries(parts))root.add(new T.Mesh(mergeGeometries(gs),mats[key]));
 let triangles=0;root.traverse(o=>{if(o.isMesh)triangles+=o.geometry.index.count/3;});if(triangles>=4000)throw Error('Cabinet over budget');
 await saveGlb(root,'public/room3d/'+a.url);a.paintMaterials=['study-shell'];
 a.colorParts=[{material:'study-shelf',label:'层板与白色书脊',color:colors.shelf},{material:'study-green',label:'收纳盒与绿色书脊',color:colors.green}];
 a.revision='study-painted-1';console.log(id,triangles);
 a.support={shape:'rect',width:w-.08,depth:d-.04,height:h};
}
await fs.writeFile('public/room3d/catalog.json',JSON.stringify(catalog,null,2)+'\n');
