import {describe,it,expect,vi,afterEach} from 'vitest';
import * as T from 'three';
import pairs from '../apps/room3d/chibi/photoPairCatalog.json';
const mocks=vi.hoisted(()=>({load:vi.fn(),create:vi.fn()}));
vi.mock('../apps/room3d/chibi/photoPairPose',async()=>({photoPairs:(await import('../apps/room3d/chibi/photoPairCatalog.json')).default,createPhotoPairPose:mocks.create}));
vi.mock('../apps/room3d/photoLibrary',()=>({photoLibrary:[],loadPhotoClip:mocks.load}));
import {createPhotoSession} from '../apps/room3d/photoSession.js';
afterEach(()=>vi.clearAllMocks());
function fixture(){
 const roots=[new T.Group(),new T.Group(),new T.Group()];roots.forEach((r,i)=>r.position.set(i*2,.18,1));
 const actors=roots.map((root,i)=>({id:String(i),root,person:{animate:vi.fn(),finishPose:vi.fn(),setPhotoExpression:vi.fn(),faceState:{eyes:'open',mouth:'base'}}}));
 const camera=new T.OrthographicCamera(-3,3,3,-3);camera.position.set(3,4,8);const pose=vi.fn((t,yaw)=>{roots[0].position.x=10+t;roots[0].rotation.y=yaw;});mocks.create.mockReturnValue({pose});
 const session=createPhotoSession({actors,camera,controls:{target:new T.Vector3()},invalidate:vi.fn(),canInteract:()=>true});
 return {roots,actors,camera,pose,session};
}
describe('photo-only pair lifetime',()=>{
 it('restores staged transforms on single-pose switch, follows the camera without reloading, and leaves observers alone',async()=>{
  mocks.load.mockResolvedValue({});const {session,roots,pose,actors,camera}=fixture(),before=roots.map(r=>r.position.clone());
  await session.interaction(pairs[0].id,'0','1',3.5);expect(pose).toHaveBeenLastCalledWith(3.5,0);
  session.camera({yaw:90});expect(pose).toHaveBeenLastCalledWith(3.5,Math.PI/2);expect(mocks.load).toHaveBeenCalledTimes(1);
  session.prepare()();expect(actors[0].person.setPhotoExpression).toHaveBeenLastCalledWith('open','smile');expect(actors[2].person.setPhotoExpression).toHaveBeenLastCalledWith('open','base');
  await session.pose('0','idle');expect(roots.map(r=>r.position.toArray())).toEqual(before.map(p=>p.toArray()));
  const calls=pose.mock.calls.length;session.camera({yaw:45});expect(pose).toHaveBeenCalledTimes(calls);
  session.restore();expect(camera.position.toArray()).toEqual([3,4,8]);expect(actors[0].person.setPhotoExpression).toHaveBeenLastCalledWith('open','base');
 });
 it('cannot resurrect a delayed loaded pair after exit or a newer single action',async()=>{
  for(const exit of [false,true]){
   let resolve!:(value:unknown)=>void;mocks.load.mockReturnValue(new Promise(r=>resolve=r));mocks.create.mockClear();
   const {session}=fixture(),pending=session.interaction(pairs[0].id,'0','1',2);
   if(exit)session.restore();else await session.pose('0','idle');resolve({});await pending;expect(mocks.create).not.toHaveBeenCalled();
  }
 });
});
