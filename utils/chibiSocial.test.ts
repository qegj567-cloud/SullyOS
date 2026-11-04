import {it,expect,vi,afterEach} from 'vitest';
import * as T from 'three';
import fs from 'node:fs';
import {createSocialScene,socialActions} from '../apps/room3d/chibi/social';
import {sampleSelected,selectedMotions} from '../apps/room3d/chibi/selectedMotions';
import type {ChibiVisitor} from '../apps/room3d/chibi/visitor';
const clips=Object.fromEntries(selectedMotions.map(e=>[e.id,JSON.parse(fs.readFileSync(`public/room3d/motions/selected/${e.file}`,'utf8'))]));
function actor(){return {root:new T.Group(),motionScale:.4,animate:vi.fn(),setActionExpression:vi.fn(),finishPose:vi.fn(),applySelectedFrame:vi.fn(),classicPoint:()=>new T.Vector3(),classicContact:vi.fn()} as unknown as ChibiVisitor;}
function scene(options={}){const visitors=[actor(),actor(),actor()];visitors.forEach((v,i)=>v.root.position.set(i*2,0,0));return {visitors,runtime:createSocialScene(visitors.map((visitor,i)=>({id:String(i),visitor})),options)};}
function mockFetch(){vi.stubGlobal('fetch',vi.fn(async(url:string)=>({ok:true,json:async()=>clips[url.split('/').pop()!.replace('.json','')]})));}
afterEach(()=>vi.unstubAllGlobals());
it('ships exactly the confirmed motions, with finite normalized rotations and clamped paired timelines',()=>{
 expect(selectedMotions).toHaveLength(48);expect(selectedMotions.filter(e=>e.participants===2)).toHaveLength(27);
 for(const e of selectedMotions){const clip=clips[e.id];expect(clip.actors).toHaveLength(e.participants);for(const track of clip.actors){for(const t of [0,e.duration*.25,e.duration*.5,e.duration*.75,e.duration]){const frame=sampleSelected(track,t);expect(frame.position.toArray().every(Number.isFinite)).toBe(true);for(const q of Object.values(frame.rotations) as T.Quaternion[])expect(q.length()).toBeCloseTo(1,3);}expect(sampleSelected(track,1e6).position.toArray()).toEqual(sampleSelected(track,track.duration).position.toArray());}}
});
it('assigns two roles while leaving an observer stationary, and releases at completion',async()=>{
 mockFetch();const {visitors,runtime}=scene();const observer=visitors[2].root.position.clone();
 await runtime.start('cmu-22_07','0','1');runtime.seek(1.5);
 expect(runtime.inspect().session?.participants).toEqual(['0','1']);expect(visitors[2].root.position.equals(observer)).toBe(true);expect(visitors[2].applySelectedFrame).not.toHaveBeenCalled();
 runtime.advance(100);expect(runtime.inspect().session).toBeNull();
 await runtime.start('cmu-22_05','2','1');runtime.cancel();expect(runtime.inspect().session).toBeNull();
});
it('single-person boxing never animates the selected partner',async()=>{
 mockFetch();const {visitors,runtime}=scene();await runtime.start('cmu-13_17','1','0');runtime.seek(2);
 expect(runtime.inspect().session?.participants).toEqual(['1']);expect(visitors[0].applySelectedFrame).not.toHaveBeenCalled();expect(visitors[1].applySelectedFrame).toHaveBeenCalled();
});
it('rejects invalid, unselected, duplicate or mixed-body sessions',async()=>{
 mockFetch();const {runtime}=scene();await expect(runtime.start('hug-me-airyaa','0','1')).rejects.toThrow();await expect(runtime.start('cmu-22_07','0','0')).rejects.toThrow();await expect(runtime.start('cmu-22_07','0','missing')).rejects.toThrow();
 const visitor=actor();expect(()=>createSocialScene([{id:'u',visitor},{id:'u',visitor}])).toThrow();expect(()=>createSocialScene([{id:'u',visitor},{id:'c',visitor:{...visitor,rig:{} as any}}])).toThrow();
});
it('rejects an obstructed complete trajectory before moving either resident',async()=>{
 mockFetch();const canPlace=vi.fn(()=>false),{visitors,runtime}=scene({canPlace}),before=visitors.map(v=>v.root.position.toArray());
 await expect(runtime.start('cmu-20_10','0','1')).rejects.toThrow('空地');expect(canPlace).toHaveBeenCalled();expect(visitors.map(v=>v.root.position.toArray())).toEqual(before);expect(runtime.inspect().session).toBeNull();expect(runtime.inspect().loading).toBe(false);
});
it('cancel during a fetch cannot resurrect a session',async()=>{
 let resolve!:(v:unknown)=>void;vi.stubGlobal('fetch',()=>new Promise(r=>{resolve=r;}));const {runtime}=scene();
 const pending=runtime.start('vrma-9563c582418bd5b5','0');runtime.cancel();resolve({ok:true,json:async()=>clips['vrma-9563c582418bd5b5']});expect(await pending).toBe(false);expect(runtime.inspect().session).toBeNull();expect(runtime.inspect().loading).toBe(false);
});
it('a failed fetch leaves residents idle and can be retried',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:true,json:async()=>clips['vrma-7cac053d27467ce6']});vi.stubGlobal('fetch',fetch);const {runtime}=scene();
 await expect(runtime.start('vrma-7cac053d27467ce6','0')).rejects.toThrow('读取失败');expect(runtime.inspect().loading).toBe(false);expect(runtime.inspect().session).toBeNull();
 expect(await runtime.start('vrma-7cac053d27467ce6','0')).toBe(true);expect(fetch).toHaveBeenCalledTimes(2);
});

it('walks both residents before the shared action and cancels without teleporting home',async()=>{
 mockFetch();const {visitors,runtime}=scene();visitors[0].root.position.x=-4;visitors[1].root.position.x=4;const starts=visitors.slice(0,2).map(v=>v.root.position.clone());
 await runtime.start('cmu-22_07','0','1');expect(runtime.inspect().session?.phase).toBe('approach');expect(visitors[0].root.position.equals(starts[0])).toBe(true);
 runtime.advance(.2);for(let i=0;i<2;i++){expect(visitors[i].root.position.distanceTo(starts[i])).toBeGreaterThan(0);expect(visitors[i].root.position.distanceTo(starts[i])).toBeLessThan(.25);expect(visitors[i].animate).toHaveBeenCalledWith(.2,'walk');expect(visitors[i].applySelectedFrame).not.toHaveBeenCalled();}
 const positions=visitors.map(v=>v.root.position.clone());runtime.cancel();visitors.forEach((v,i)=>expect(v.root.position.equals(positions[i])).toBe(true));
});
it('rejects an unreachable approach without moving either participant',async()=>{mockFetch();const {visitors,runtime}=scene({findPath:()=>null});const before=visitors.map(v=>v.root.position.clone());await expect(runtime.start('cmu-22_07','0','1')).rejects.toThrow('空地');visitors.forEach((v,i)=>expect(v.root.position.equals(before[i])).toBe(true));});

it('follows the supplied route around obstacles and stays at the interaction after completion',async()=>{
 mockFetch();const {visitors,runtime}=scene({findPath:(from:T.Vector3,to:T.Vector3)=>[from.clone(),new T.Vector3(from.x,from.y,2),new T.Vector3(to.x,to.y,2),to.clone()]});const starts=visitors.map(v=>v.root.position.clone());
 await runtime.start('cmu-22_07','0','1');runtime.advance(.4);expect(visitors[0].root.position.z).toBeGreaterThan(0);expect(visitors[0].root.position.x).toBeCloseTo(starts[0].x);
 runtime.seek(10000);const last=visitors.map(v=>v.root.position.clone());runtime.advance(.01);expect(runtime.inspect().session).toBeNull();visitors.forEach((v,i)=>expect(v.root.position.equals(last[i])).toBe(true));
});

it('finishes paired interaction facing one another',async()=>{mockFetch();const {visitors,runtime}=scene();await runtime.start('cmu-22_07','0','1');runtime.seek(10000);runtime.advance(.01);for(let i=0;i<2;i++){const toward=visitors[1-i].root.position.clone().sub(visitors[i].root.position).setY(0).normalize();const forward=new T.Vector3(0,0,1).applyQuaternion(visitors[i].root.quaternion);expect(forward.dot(toward)).toBeCloseTo(1,5);}});

it('hug walks into place, reaches both arms to the partner, and releases face to face',async()=>{
 mockFetch();const {visitors,runtime}=scene();await runtime.start('home-hug','0','1');
 expect(runtime.inspect().session?.phase).toBe('approach');
 runtime.advance(1.5);runtime.advance(1);
 expect(visitors[0].classicContact).toHaveBeenCalled();expect(visitors[1].classicContact).toHaveBeenCalled();
 runtime.advance(20);expect(runtime.inspect().session).toBeNull();
 for(let i=0;i<2;i++){const forward=new T.Vector3(0,0,1).applyQuaternion(visitors[i].root.quaternion),toward=visitors[1-i].root.position.clone().sub(visitors[i].root.position).normalize();expect(forward.dot(toward)).toBeCloseTo(1,4);}
});

it.each(['cmu-22_03','cmu-22_09','cmu-22_01'])('keeps the seated recipient anchored during %s, including cancellation',async action=>{mockFetch();const done=vi.fn(),pose={kind:'seat-rest',seatHeight:.7};const {visitors,runtime}=scene({pinned:{id:'1',pose},onComplete:done});const position=visitors[1].root.position.clone(),rotation=visitors[1].root.quaternion.clone();await runtime.start(action,'0','1');for(const t of [.1,1,3]){runtime.advance(t);expect(visitors[1].root.position.equals(position)).toBe(true);expect(visitors[1].root.quaternion.equals(rotation)).toBe(true);}runtime.advance(100);expect(done).toHaveBeenCalledOnce();expect(visitors[1].animate).toHaveBeenLastCalledWith(0,'idle','seated',pose);expect(visitors[1].root.position.equals(position)).toBe(true);runtime.cancel();expect(done).toHaveBeenCalledOnce();});

it('assigns the crouching comfort track to the initiator and seated track to the recipient',async()=>{
 mockFetch();const {visitors,runtime}=scene({pinned:{id:'1',pose:{kind:'seat-rest'}}});
 await runtime.start('cmu-22_03','0','1');
 const session=runtime.inspect().session!;const time=2;
 runtime.seek(session.duration-socialActions['cmu-22_03'].duration+time+.6);
 expect(runtime.inspect().session?.participants).toEqual(['0','1']);
 const initiator=(visitors[0].applySelectedFrame as any).mock.calls.at(-1)[0];
 const recipient=(visitors[1].applySelectedFrame as any).mock.calls.at(-1)[0];
 const capture=clips['cmu-22_03'];
 expect(initiator.rotations.L_upperArm.angleTo(sampleSelected(capture.actors[1],time).rotations.L_upperArm)).toBeLessThan(1e-6);
 expect(recipient.rotations.L_upperArm.angleTo(sampleSelected(capture.actors[0],time).rotations.L_upperArm)).toBeLessThan(1e-6);
 expect(visitors[1].root.position.toArray()).toEqual([2,0,0]);
});
it('keeps shoulder rub behind its seated recipient and mixed hugs in front, across headings',async()=>{
 mockFetch();for(const action of ['cmu-22_09','home-hug'])for(const angle of [0,Math.PI/2])for(const seated of action==='home-hug'?['0','1']:['1']){
  const visitors=[actor(),actor()];visitors[0].root.position.set(-3,.18,0);visitors[1].root.position.set(0,.7,0);visitors[Number(seated)].root.rotation.y=angle;
  const fixed=visitors[Number(seated)].root.position.clone(),q=visitors[Number(seated)].root.quaternion.clone();const runtime=createSocialScene(visitors.map((visitor,i)=>({id:String(i),visitor})),{pinned:{id:seated,pose:{}}});
  await runtime.start(action,'0','1');const duration=runtime.inspect().session!.duration;runtime.seek(duration-1);
  expect(visitors[Number(seated)].root.position.distanceTo(fixed)).toBeLessThan(1e-8);expect(visitors[Number(seated)].root.quaternion.angleTo(q)).toBeLessThan(1e-8);
  const offset=visitors[1-Number(seated)].root.position.clone().sub(fixed).applyQuaternion(q.clone().invert());expect(action==='cmu-22_09'?offset.z<0:offset.z>0).toBe(true);expect(Math.abs(offset.x)).toBeLessThan(1e-6);
 }
});

it('separates walking and final standing clearance from the temporary action sweep',async()=>{
 mockFetch();const phases:number[]=[];const {runtime}=scene({canPlace:(paths:T.Vector3[][])=>{phases.push(paths[0].length);return true;},canPerform:vi.fn(()=>true)});
 await runtime.start('cmu-22_07','0','1');expect(phases).toHaveLength(2);expect(phases[0]).toBeGreaterThan(1);expect(phases[1]).toBe(1);
});
it('relaxed animation never bypasses a blocked route, final footprint or room boundary',async()=>{
 mockFetch();for(const blocked of ['route','finish','motion']){let n=0;const {runtime}=scene({canPlace:()=>{n++;return blocked==='route'?false:blocked==='finish'?n!==2:true;},canPerform:()=>blocked!=='motion'});await expect(runtime.start('cmu-22_07','0','1')).rejects.toThrow('空地');}
});
