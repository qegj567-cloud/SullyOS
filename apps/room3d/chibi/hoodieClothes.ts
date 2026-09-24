import * as T from 'three';
import data from './hoodieClothes.json';
import {BLANK_SCALE} from './blankBody';
import {bodyHeightY,bodyBaseY} from './bodyHeight';
import type {bindBlankBody} from './blankRig';
import {closeFootwearSeams} from './closeFootwearSeams';

/** Extracted Meshy garment, retargeted from its A-pose into the body's bind pose. */
export function prepareHoodie(rig:ReturnType<typeof bindBlankBody>){
 const body=rig.baseGeometry.clone(),p=body.attributes.position,si=body.attributes.skinIndex,sw=body.attributes.skinWeight;
 const boneIndex=Object.fromEntries(rig.skeleton.bones.map((b,i)=>[b.name,i]));
 const resources:Array<{dispose():void}>=[body],meshes:T.SkinnedMesh[]=[];
 data.forEach((sourcePart,partIndex)=>{
  const part={positions:[...sourcePart.positions],indices:[...sourcePart.indices]};
  const legSides:number[]=[];
  if(partIndex){
   // Separate the touching boot seam and transfer weights only from its leg.
   part.positions=[];part.indices=[];const vertices=new Map<string,number>();
   for(let t=0;t<sourcePart.indices.length;t+=3){
    const triangle=sourcePart.indices.slice(t,t+3);
    const side=triangle.reduce((sum,id)=>sum+sourcePart.positions[id*3],0)>=0?1:-1;
    for(const id of triangle){const key=`${side}:${id}`;let target=vertices.get(key);
     if(target===undefined){target=part.positions.length/3;vertices.set(key,target);part.positions.push(...sourcePart.positions.slice(id*3,id*3+3));legSides[target]=side;}
     part.indices.push(target);
    }
   }
  }
  if(partIndex)closeFootwearSeams(part.positions,part.indices,legSides);
  const positions:number[]=[],skinIndex:number[]=[],skinWeight:number[]=[];
  for(let i=0;i<part.positions.length;i+=3){
   const [x,y,z]=part.positions.slice(i,i+3),side=Math.sign(x),ax=Math.abs(x);
   let tx=x*.98,ty=y*.82-.0207,tz=z*1.07,sleeve=0;
   if(partIndex===0){
    const sleeveEdge=.095+.05*(1-T.MathUtils.smoothstep(y,-.14,-.07))-.035*T.MathUtils.smoothstep(y,.03,.13);
    // The hood stays on the chest; only the sleeve swings out of the source A-pose.
    const blend=T.MathUtils.smoothstep(ax,sleeveEdge,sleeveEdge+.045)*(1-T.MathUtils.smoothstep(y,.135,.185));
    const angle=57*Math.PI/180,dx=ax-.068,dy=y-.135;
    const armX=side*(.063+dx*Math.cos(angle)-dy*Math.sin(angle)),armY=.090+(dx*Math.sin(angle)+dy*Math.cos(angle))*.95;
    ty+=.022*T.MathUtils.smoothstep(y,.015,.11);
    tx=T.MathUtils.lerp(tx,armX,blend);ty=T.MathUtils.lerp(ty,armY,blend);sleeve=blend;
   }else{tx=x*.94;ty=y;tz=z;}
   const v=new T.Vector3(tx*BLANK_SCALE,bodyHeightY((ty+.5)*BLANK_SCALE,rig.bodyHeight),tz*BLANK_SCALE);positions.push(v.x,v.y,v.z);
   if(partIndex===0){
    // Smooth shoulder influences in garment space. Nearest-body transfer made
    // adjacent loose-cloth vertices jump between chest/arm and even opposite arms.
    const prefix=side>=0?'L':'R',elbow=T.MathUtils.smoothstep(Math.abs(tx),.18,.24),wrist=T.MathUtils.smoothstep(Math.abs(tx),.285,.326);
    const spine=T.MathUtils.smoothstep(ty,-.12,-.035),chest=T.MathUtils.smoothstep(ty,-.025,.075);
    const weights=[['hips',(1-sleeve)*(1-spine)],['spine',(1-sleeve)*spine*(1-chest)],['chest',(1-sleeve)*spine*chest],
     [`${prefix}_upperArm`,sleeve*(1-elbow)],[`${prefix}_forearm`,sleeve*elbow*(1-wrist)],[`${prefix}_hand`,sleeve*elbow*wrist]] as [string,number][];
    const top=weights.sort((a,b)=>b[1]-a[1]).slice(0,4),sum=top.reduce((s,[,w])=>s+w,0);
    for(const [name,weight] of top){skinIndex.push(boneIndex[name]);skinWeight.push(weight/sum);}
    continue;
   }
   let nearest=0,distance=Infinity;
   for(let k=0;k<p.count;k++){if(partIndex&&Math.sign(p.getX(k))!==legSides[i/3])continue;const d=(p.getX(k)-v.x)**2+(p.getY(k)-v.y)**2+(p.getZ(k)-v.z)**2;if(d<distance){distance=d;nearest=k;}}
   for(let j=0;j<4;j++){let index=si.array[nearest*4+j];
    // The hood belongs to the shoulders, not the head it surrounds.
    if(partIndex===0&&['head','neck'].includes(rig.skeleton.bones[index].name))index=rig.skeleton.bones.indexOf(rig.bones.chest);
    skinIndex.push(index);skinWeight.push(sw.array[nearest*4+j]);
   }
  }
  const geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.Float32BufferAttribute(positions,3));geometry.setIndex(part.indices);geometry.setAttribute('skinIndex',new T.Uint16BufferAttribute(skinIndex,4));geometry.setAttribute('skinWeight',new T.Float32BufferAttribute(skinWeight,4));geometry.computeVertexNormals();
  const material=new T.MeshStandardMaterial({color:partIndex?'#f3eee7':'#d994ae',roughness:1,metalness:0,side:T.DoubleSide});
  let materials:T.Material|T.Material[]=material;
  if(partIndex){
   const shoeMaterial=new T.MeshStandardMaterial({color:'#30231f',roughness:1,metalness:0,side:T.DoubleSide});resources.push(shoeMaterial);materials=[material,shoeMaterial];
   const socks:number[]=[],shoes:number[]=[];
   for(let i=0;i<part.indices.length;i+=3){const ids=part.indices.slice(i,i+3),height=ids.reduce((sum,id)=>sum+part.positions[id*3+1],0)/3;(height<-.427?shoes:socks).push(...ids);}
   geometry.setIndex([...socks,...shoes]);geometry.addGroup(0,socks.length,0);geometry.addGroup(socks.length,shoes.length,1);
  }
  const mesh=new T.SkinnedMesh(geometry,materials);mesh.name=partIndex?'hoodie-boots':'hoodie-top';mesh.frustumCulled=false;mesh.bind(rig.skeleton,rig.mesh.bindMatrix);resources.push(geometry,material);meshes.push(mesh);
 });
 const original=body.index!.clone(),groups=body.groups.map(g=>({...g})),masked:number[]=[],maskedGroups:typeof body.groups=[];
 for(const group of groups){const start=masked.length;
  for(let i=group.start;i<group.start+group.count;i+=3){const ids=[0,1,2].map(j=>original.getX(i+j));
   // All corners must belong to ONE covered region. A long simplified triangle
   // may span from shirt to boot while its middle is exposed thigh.
   const regions=[(x:number,y:number)=>y<-.244,(x:number,y:number)=>y>-.126&&y<(x>.045?.151:.122)&&x<.298];
   const covered=regions.some(region=>ids.every(id=>region(Math.abs(p.getX(id))/BLANK_SCALE,bodyBaseY(p.getY(id),rig.bodyHeight)/BLANK_SCALE-.5)));
   if(!covered)masked.push(...ids);
  }maskedGroups.push({start,count:masked.length-start,materialIndex:group.materialIndex});
 }
 let attached=false,disposed=false;
 const setVisible=(visible:boolean)=>{if(disposed)return;meshes.forEach(m=>m.visible=visible);body.setIndex(visible?masked:original);body.clearGroups();for(const g of visible?maskedGroups:groups)body.addGroup(g.start,g.count,g.materialIndex);};
 setVisible(true);
 return {meshes,resources,setVisible,triangles:meshes.reduce((sum,m)=>sum+m.geometry.index!.count/3,0),attach(){if(attached||disposed)return;attached=true;meshes.forEach(m=>rig.mesh.parent!.add(m));rig.mesh.geometry=body;},dispose(){if(disposed)return;disposed=true;meshes.forEach(m=>m.removeFromParent());if(rig.mesh.geometry===body)rig.mesh.geometry=rig.baseGeometry;resources.forEach(r=>r.dispose());}};
}
export function dressHoodie(rig:ReturnType<typeof bindBlankBody>){const outfit=prepareHoodie(rig);outfit.attach();return outfit;}
