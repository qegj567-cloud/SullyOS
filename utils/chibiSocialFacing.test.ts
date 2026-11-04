import {it,expect,vi,afterEach} from 'vitest';
import * as T from 'three';
import {readFileSync} from 'node:fs';
import {createSocialScene} from '../apps/room3d/chibi/selectedSocial';
import {selectedMotions} from '../apps/room3d/chibi/selectedMotions';
import type {ChibiVisitor} from '../apps/room3d/chibi/visitor';
import {splitMotionHeading} from '../apps/room3d/chibi/motionHeading';
import {isSeasonalSocial} from '../apps/room3d/chibi/seasonalSocial';
import {isPrincessCarry} from '../apps/room3d/chibi/intimacyMotion';
const clip=(id:string)=>JSON.parse(readFileSync(`public/room3d/motions/selected/${id}.json`,'utf8'));
afterEach(()=>vi.unstubAllGlobals());
function actor(z:number){
 const root=new T.Group();root.position.z=z;root.rotation.y=z>0?Math.PI:0;let hips=new T.Quaternion();
 return {visitor:{root,motionScale:.4,setActionExpression:()=>{},animate:()=>hips.identity(),finishPose:()=>{},classicPoint:()=>new T.Vector3(),classicContact:()=>{},applySelectedFrame:(f:any,w:number)=>hips.identity().slerp(f.rotations.hips,w)} as unknown as ChibiVisitor,
 facing:()=>new T.Vector3(0,0,1).applyQuaternion(hips).applyQuaternion(root.quaternion)};
}
const signed=(v:T.Vector3)=>Math.atan2(v.x,v.z);
const change=(a:number,b:number)=>Math.atan2(Math.sin(b-a),Math.cos(b-a));
it('uses one shortest heading transition on entry and release for all imported paired actions',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>clip(url.split('/').pop()!.replace('.json',''))})));
 for(const e of selectedMotions.filter(e=>e.participants===2&&!e.source.startsWith('SullyOS procedural')&&!isSeasonalSocial(e.id)&&!isPrincessCarry(e.id))){
  const actors=[actor(1.2),actor(-1.2)],runtime=createSocialScene(actors.map((a,i)=>({id:String(i),visitor:a.visitor})));
  await runtime.start(e.id,'0','1');const approach=runtime.inspect().session!.duration-e.duration-1.2;
  for(const start of [approach,approach+e.duration+.6]){
   const headings:number[][]=[[],[]];
   for(let i=0;i<=60;i++){runtime.seek(start+.6*i/60);actors.forEach((a,j)=>headings[j].push(signed(a.facing())));}
   for(const [role,values] of headings.entries()){
    const travelled=values.slice(1).reduce((sum,v,i)=>sum+Math.abs(change(values[i],v)),0);
    const shortest=Math.abs(change(values[0],values.at(-1)!));
    expect(travelled,`${e.id} role ${role} ${start===approach?'entry':'release'}`).toBeLessThanOrEqual(shortest+.035);
   }
  }
 }
});
it('preserves captured rotations including intentional turns, leaning and quaternion sign changes',()=>{
 for(const e of selectedMotions.filter(e=>!e.source.startsWith('SullyOS procedural')))for(const a of clip(e.id).actors){
  for(let i=0;i<a.times.length;i+=7){
   const q=new T.Quaternion().fromArray(a.tracks.hips,i*4).normalize();
   for(const sign of [1,-1]){
    const input=new T.Quaternion(q.x*sign,q.y*sign,q.z*sign,q.w*sign),{heading,lean}=splitMotionHeading(input);
    expect(heading.clone().multiply(lean).angleTo(input)).toBeLessThan(1e-6);
    const point=new T.Vector3(.3,.5,.2),oldLocal=point.clone().applyQuaternion(input.clone().invert());
    const newLocal=point.clone().applyQuaternion(heading.clone().invert()).applyQuaternion(lean.clone().invert());
    expect(newLocal.distanceTo(oldLocal)).toBeLessThan(1e-6);
   }
  }
 }
});
it('orients a solo greeting toward its partner while paired clips ignore that target',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>clip(url.split('/').pop()!.replace('.json',''))})));
 const single=selectedMotions.find(e=>e.participants===1&&!e.source.startsWith('SullyOS procedural'))!;
 const a=actor(0),runtime=createSocialScene([{id:'a',visitor:a.visitor}],{facingTarget:new T.Vector3(3,0,0)});
 await runtime.start(single.id,'a');runtime.seek(runtime.inspect().session!.duration-.3);
 const baseline=actor(0),solo=createSocialScene([{id:'a',visitor:baseline.visitor}]);await solo.start(single.id,'a');solo.seek(solo.inspect().session!.duration-.3);expect(a.visitor.root.quaternion.angleTo(baseline.visitor.root.quaternion)).toBeCloseTo(Math.PI/2,4);
 const pair=selectedMotions.find(e=>e.participants===2&&!e.source.startsWith('SullyOS procedural')&&!isPrincessCarry(e.id))!;
 const make=(target?:T.Vector3)=>{const residents=[actor(1),actor(-1)];return {residents,runtime:createSocialScene(residents.map((a,i)=>({id:String(i),visitor:a.visitor})),{facingTarget:target})};};
 const normal=make(),withTarget=make(new T.Vector3(100,0,0));await normal.runtime.start(pair.id,'0','1');await withTarget.runtime.start(pair.id,'0','1');normal.runtime.seek(1);withTarget.runtime.seek(1);expect(normal.residents[0].visitor.root.quaternion.angleTo(withTarget.residents[0].visitor.root.quaternion)).toBeLessThan(1e-6);
});
