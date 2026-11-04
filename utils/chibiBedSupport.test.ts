import {it,expect,vi} from 'vitest';
import * as T from 'three';
import {readFileSync} from 'node:fs';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import catalog from '../public/room3d/catalog.json';
import {seatTransform} from '../apps/room3d/seating.js';
import {body2BedTransform,bedFootSurface} from '../apps/room3d/bedMotion.js';
import {createBlankBody,BLANK_SCALE} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {createBlankMotion} from '../apps/room3d/chibi/blankMotion';
import {bodyHeightY} from '../apps/room3d/chibi/bodyHeight';
import {bedSurfaceHeight} from '../apps/room3d/chibi/bedLegContact';

const room={id:'r',items:[{id:'bed',assetId:'show_bed',x:0,y:.15,z:0,rotation:0}]};
const selection={roomId:'r',itemId:'bed',seatId:'1',bed:true};
it('matches the shipped curved foot surface in both sleeping lanes',async()=>{
 const bytes=readFileSync('public/room3d/show_bed.glb');
 const {scene}=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');scene.updateMatrixWorld(true);
 const ray=new T.Raycaster(),seat=seatTransform(room,catalog,selection,true);
 for(const x of [-.7,.7])for(const [z,y] of seat.bed.footSurface){
  ray.set(new T.Vector3(x,2,z),new T.Vector3(0,-1,0));
  expect(Math.abs(ray.intersectObject(scene,true)[0].point.y-y)).toBeLessThan(.012);
 }
 scene.traverse(o=>{if(o instanceof T.Mesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});
});
it.each([.8,1,1.25])('settles heels on the bed curve at body height %s without stretching bones or rescanning a held pose',bodyHeight=>{
 for(const headSize of [1,1.25])for(const yaw of [0,Math.PI/2]){
 const parent=new T.Group(),body=new T.Group(),hair=new T.Group(),geometry=createBlankBody('skin',{bodyHeight,headSize}),material=new T.MeshBasicMaterial();parent.add(body);body.add(new T.Mesh(geometry,material),hair);
 const rig=bindBlankBody(body.children[0] as T.Mesh,hair,true),animate=createBlankMotion(rig,body),lengths=rig.skeleton.bones.map(b=>b.position.length());
 body.updateMatrixWorld(true);rig.skeleton.update();rig.mesh.computeBoundingBox();const maxY=new T.Box3().setFromObject(body).max.y,scale=2.8/BLANK_SCALE,hip=bodyHeightY(.38*BLANK_SCALE,bodyHeight);
 const rotated={...room,items:[{...room.items[0],rotation:yaw*180/Math.PI}]};
 const seat=body2BedTransform(seatTransform(rotated,catalog,selection,true),(maxY-hip)*scale,hip*scale),profile=bedFootSurface(seat,scale);
 parent.rotation.y=yaw;parent.position.set(4,7,-3);parent.scale.setScalar(scale);
 const pose={kind:'bed-rest',hands:[],bedTime:3,bedFootSurface:profile};animate(3,'sleep','lying',pose);body.updateMatrixWorld(true);rig.skeleton.update();
 const p=new T.Vector3(),inverse=parent.matrixWorld.clone().invert(),g=geometry.attributes,min={L:Infinity,R:Infinity};
 for(let i=0;i<g.position.count;i++)for(const side of ['L','R'] as const){
  let weight=0;for(let j=0;j<4;j++)if([side+'_foot',side+'_toe'].includes(rig.skeleton.bones[g.skinIndex.getComponent(i,j)].name))weight+=g.skinWeight.getComponent(i,j);
  if(weight>.5){rig.mesh.getVertexPosition(i,p);rig.mesh.localToWorld(p).applyMatrix4(inverse);min[side]=Math.min(min[side],p.y-bedSurfaceHeight(p.z,0,profile));}
 }
 for(const gap of Object.values(min)){expect(gap*scale).toBeGreaterThan(-.025);expect(gap*scale).toBeLessThan(.065);}
 rig.skeleton.bones.forEach((bone,i)=>expect(bone.position.length()).toBeCloseTo(lengths[i],8));
 const snapshot=rig.skeleton.bones.map(b=>b.quaternion.clone()),scan=vi.spyOn(rig.mesh,'getVertexPosition');animate(3,'sleep','lying',pose);
 expect(scan).not.toHaveBeenCalled();scan.mockRestore();rig.skeleton.bones.forEach((bone,i)=>expect(bone.quaternion.angleTo(snapshot[i])).toBeLessThan(.0001));
 animate(0,'idle','standing');rig.skeleton.bones.forEach((bone,i)=>expect(bone.position.length()).toBeCloseTo(lengths[i],8));
 geometry.dispose();material.dispose();rig.skeleton.dispose();
 }
});