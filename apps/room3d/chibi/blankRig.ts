import * as T from 'three';
import source from './blankBody.json';
import {BLANK_SCALE} from './blankBody';
import {bodyHeightY} from './bodyHeight';
import {BLANK_FINGERS,fingerWeights,type HandSide} from './blankFingers';

export type RigPose='bind'|'relaxed'|'reference'|'arm'|'knee'|'head';
const smooth=T.MathUtils.smoothstep;
// Little Figure source coordinates; preserve its original rest proportions.

export function bindBlankBody(original:T.Mesh,hair:T.Group,forearmTwist=false){
 const bodyHeight=original.geometry.userData.bodyHeight??1;
 const at=(x:number,y:number,z=0)=>new T.Vector3(x*BLANK_SCALE,bodyHeightY((y+.5)*BLANK_SCALE,bodyHeight),z*BLANK_SCALE);
 const bones:T.Bone[]=[],named:Record<string,T.Bone>={},indices:Record<string,number>={};
 const add=(name:string,parent:string|null,position:T.Vector3)=>{
  const bone=new T.Bone();bone.name=name;bone.position.copy(position);
  if(parent){const parentWorld=named[parent].userData.rest as T.Vector3;bone.position.sub(parentWorld);named[parent].add(bone);}
  bone.userData.rest=position.clone();indices[name]=bones.length;bones.push(bone);named[name]=bone;return bone;
 };
 add('root',null,new T.Vector3());add('hips','root',at(0,-.12));
 add('spine','hips',at(0,-.035));add('chest','spine',at(0,.078));
 add('neck','chest',at(0,.13));add('head','neck',at(0,.15));
 for(const [side,prefix] of [[1,'L'],[-1,'R']] as const){
  add(`${prefix}_clavicle`,'chest',at(side*.025,.092));
  add(`${prefix}_upperArm`,`${prefix}_clavicle`,at(side*.063,.090,-.002));
  add(`${prefix}_forearm`,`${prefix}_upperArm`,at(side*.21,.090,-.002));
  add(`${prefix}_hand`,`${prefix}_forearm`,at(side*.305,.090,.004));
  add(`${prefix}_thigh`,'hips',at(side*.049,-.13,.006));
  add(`${prefix}_shin`,`${prefix}_thigh`,at(side*.049,-.30,.012));
  add(`${prefix}_foot`,`${prefix}_shin`,at(side*.049,-.451,-.001));
  add(`${prefix}_toe`,`${prefix}_foot`,at(side*.049,-.483,.045));
 }
 // Append finger joints after the original 22 bones to retain existing indices.
 const fingerJoints:Array<{name:string;side:HandSide;axis:T.Vector3;curl:number}>=[];
 for(const [side,prefix] of [[1,'L'],[-1,'R']] as const)for(const finger of BLANK_FINGERS){
  const a=new T.Vector3(...finger.start),b=new T.Vector3(...finger.tip),mid=a.clone().lerp(b,.55);
  const base=`${prefix}_${finger.name}`,tip=`${base}_tip`;
  add(base,`${prefix}_hand`,at(side*a.x,a.y,a.z));add(tip,base,at(side*mid.x,mid.y,mid.z));
  const axis=new T.Vector3(b.z-a.z,0,-side*(b.x-a.x)).normalize();
  fingerJoints.push({name:base,side:prefix,axis,curl:finger.name==='thumb'?.8:1.05},{name:tip,side:prefix,axis,curl:finger.name==='thumb'?1:1.3});
 }
 // Append roll helpers without changing the original bone indices.
 if(forearmTwist)for(const [side,prefix] of [[1,'L'],[-1,'R']] as const){
  add(`${prefix}_twist1`,`${prefix}_forearm`,at(side*.245,.090,-.002+.006*(.245-.21)/.095));
  add(`${prefix}_twist2`,`${prefix}_forearm`,at(side*.278,.090,-.002+.006*(.278-.21)/.095));
  add(`${prefix}_twist3`,`${prefix}_forearm`,at(side*.2925,.090,-.002+.006*(.2925-.21)/.095));
 }
 const setHandCurl=(side:HandSide,amount:number,targets?:Record<string,T.Quaternion>)=>{
  const value=Number.isFinite(amount)?T.MathUtils.clamp(amount,0,1):0;
  for(const joint of fingerJoints)if(joint.side===side)(targets?.[joint.name]??named[joint.name].quaternion).setFromAxisAngle(joint.axis,value*joint.curl);
 };
 const g=original.geometry,skinIndices:number[]=[],skinWeights:number[]=[];
 for(let i=0;i<g.attributes.position.count;i++){
  const [x,y,z]=source.positions.slice(i*3,i*3+3),ax=Math.abs(x),prefix=x>=0?'L':'R';
  const weights=new Map<string,number>();
  const put=(name:string,value:number)=>{if(value>0)weights.set(name,(weights.get(name)||0)+value);};
  if(y>.125){
   const head=smooth(y,.132,.158);put('neck',1-head);put('head',head);
  }else if(y<-.105){
   const leg=1-smooth(y,-.20,-.105),knee=smooth(y,-.33,-.27),ankle=1-smooth(y,-.47,-.43);
   const toes=(1-smooth(y,-.47,-.452))*smooth(z,.022,.061);
   put('hips',1-leg);put(`${prefix}_thigh`,leg*knee);
   put(`${prefix}_shin`,leg*(1-knee)*(1-ankle));
   put(`${prefix}_foot`,leg*(1-knee)*ankle*(1-toes));put(`${prefix}_toe`,leg*(1-knee)*ankle*toes);
  }else{
   // Share the outer shoulder with the upper arm around the narrower joint.
   const arm=smooth(ax,.047,.093)*smooth(y,.015,.06);
   const elbow=smooth(ax,.182,.235),wrist=smooth(ax,.284,.326),clavicle=1-smooth(ax,.05,.093);
   put(`${prefix}_clavicle`,arm*clavicle);put(`${prefix}_upperArm`,arm*(1-clavicle)*(1-elbow));
   put(`${prefix}_forearm`,arm*(1-clavicle)*elbow*(1-wrist));put(`${prefix}_hand`,arm*(1-clavicle)*elbow*wrist);
   const chest=smooth(y,-.015,.075),spine=smooth(y,-.105,-.025),neck=smooth(y,.10,.13);
   put('hips',(1-arm)*(1-spine));put('spine',(1-arm)*spine*(1-chest));
   put('chest',(1-arm)*spine*chest*(1-neck));put('neck',(1-arm)*spine*chest*neck);
  }
  if(forearmTwist&&ax>.21&&ax<.326&&y<.125&&y>.025){
   const w=(weights.get(`${prefix}_forearm`)??0)+(weights.get(`${prefix}_hand`)??0);
   // Reference rig keeps the wrist shared with the forearm into the palm.
   const knots=[.21,.245,.278,.2925,.326];
   const a=ax<knots[1]?0:ax<knots[2]?1:ax<knots[3]?2:3;
   const t=T.MathUtils.clamp((ax-knots[a])/(knots[a+1]-knots[a]),0,1);
   const names=[`${prefix}_forearm`,`${prefix}_twist1`,`${prefix}_twist2`,`${prefix}_twist3`,`${prefix}_hand`];
   weights.delete(`${prefix}_forearm`);weights.delete(`${prefix}_hand`);
   put(names[a],w*(1-t));put(names[a+1],w*t);
  }
  if(ax>.305&&y<.125&&y>.025){
   const finger=fingerWeights(ax,y,z);
   if(finger&&finger.weight>0){
    for(const [name,value] of weights)weights.set(name,value*(1-finger.weight));
    put(`${prefix}_${finger.name}`,finger.weight*(1-finger.distal));put(`${prefix}_${finger.name}_tip`,finger.weight*finger.distal);
   }
  }
  const top=[...weights].sort((a,b)=>b[1]-a[1]).slice(0,4),sum=top.reduce((s,v)=>s+v[1],0);
  if(!sum)top.push(['hips',1]);
  for(let j=0;j<4;j++){skinIndices.push(top[j]?indices[top[j][0]]:0);skinWeights.push(top[j]?top[j][1]/(sum||1):0);}
 }
 g.setAttribute('skinIndex',new T.Uint16BufferAttribute(skinIndices,4));g.setAttribute('skinWeight',new T.Float32BufferAttribute(skinWeights,4));
 const mesh=new T.SkinnedMesh(g,original.material);mesh.name=original.name;mesh.castShadow=original.castShadow;mesh.receiveShadow=original.receiveShadow;mesh.frustumCulled=false;
 const parent=original.parent!;parent.remove(original);parent.add(mesh);mesh.add(bones[0]);
 parent.updateWorldMatrix(true,true);const skeleton=new T.Skeleton(bones);mesh.bind(skeleton);
 // Preserve the fitted rest placement while parenting all hair to the head bone.
 named.head.attach(hair);
 for(const bone of bones)delete bone.userData.rest;
 let current:RigPose='bind';
 const setPose=(pose:RigPose)=>{
  current=pose;for(const b of bones)b.rotation.set(0,0,0);
  if(pose!=='bind')for(const [side,prefix] of [[1,'L'],[-1,'R']] as const)named[`${prefix}_upperArm`].rotation.z=-side*1.15;
  if(pose==='reference'){
   // Quiet standing pose: planted feet, a slight torso lean and loose arms.
   named.spine.rotation.set(-.06,0,.025);
   named.chest.rotation.x=-.035;
   named.head.rotation.set(.075,-.10,-.025);
   for(const [side,prefix] of [[1,'L'],[-1,'R']] as const){
    named[`${prefix}_clavicle`].rotation.z=-side*.035;
    named[`${prefix}_upperArm`].rotation.set(.035,0,-side*1.43);
    named[`${prefix}_forearm`].rotation.set(-.08,0,-side*.025);
    named[`${prefix}_hand`].rotation.z=side*.075;
   }
  }
  if(pose==='arm'){named.L_upperArm.rotation.z=.25;named.L_forearm.rotation.z=1.05;named.L_hand.rotation.z=.12;}
  if(pose==='knee'){named.L_thigh.rotation.x=-.65;named.L_shin.rotation.x=1.15;named.L_foot.rotation.x=-.3;}
  if(pose==='head'){named.head.rotation.y=.48;named.head.rotation.z=.10;}
  mesh.updateWorldMatrix(true,true);skeleton.update();Object.assign(mesh,{boundingBox:null,boundingSphere:null});
 };
 const inspect=()=>({bones:bones.length,vertices:g.attributes.position.count,pose:current,skinned:mesh.isSkinnedMesh});
 return {mesh,baseGeometry:g,skeleton,bones:named,setPose,setHandCurl,inspect,bodyHeight};
}
