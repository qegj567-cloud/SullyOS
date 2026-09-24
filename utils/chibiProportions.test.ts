import {describe,it,expect} from 'vitest';
import * as T from 'three';
import {createBlankBody,BLANK_SCALE,BLANK_HEAD_SCALE} from '../apps/room3d/chibi/blankBody';
import source from '../apps/room3d/chibi/blankBody.json';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {createBlankMotion} from '../apps/room3d/chibi/blankMotion';
import {dressHoodie} from '../apps/room3d/chibi/hoodieClothes';
import {bodyProportions} from '../apps/room3d/chibi/types';
import {bodyHeightY,bodyBaseY} from '../apps/room3d/chibi/bodyHeight';

describe('chibi proportions',()=>{
 it('gives legs most of the added height while keeping feet fixed and reference space reversible',()=>{
  const ankle=.049*BLANK_SCALE,hip=.38*BLANK_SCALE,neck=.65*BLANK_SCALE;
  for(const h of [.8,1,1.25]){
   for(let y=-.1;y<5;y+=.017)expect(bodyBaseY(bodyHeightY(y,h),h)).toBeCloseTo(y,9);
   expect(bodyHeightY(ankle,h)).toBe(ankle);expect(bodyHeightY(.1,h)).toBe(.1);
   expect(bodyHeightY(neck,h)).toBeCloseTo(neck*h,9);
   const legs=(bodyHeightY(hip,h)-ankle)/(hip-ankle),torso=(bodyHeightY(neck,h)-bodyHeightY(hip,h))/(neck-hip);
   if(h>1)expect(legs-1).toBeGreaterThan((torso-1)*3);
   if(h<1)expect(legs).toBeLessThan(torso);
  }
 });
 it('defaults old saves and clamps invalid or extreme proportions',()=>{
  expect(bodyProportions()).toEqual({headSize:1.04,bodyHeight:1});
  expect(bodyProportions({headSize:NaN,bodyHeight:Infinity})).toEqual({headSize:1.04,bodyHeight:1});
  expect(bodyProportions({headSize:5,bodyHeight:-4})).toEqual({headSize:1.4,bodyHeight:.8});
 });
 it('preserves the authored facial relief at the default head size',()=>{
  const g=createBlankBody('skin'),p=g.attributes.position;
  try{
   for(let i=0;i<p.count;i++)if(source.positions[i*3+1]>=.16){
    expect(p.getZ(i)/(BLANK_SCALE*BLANK_HEAD_SCALE.z*1.04)).toBeCloseTo(source.positions[i*3+2],6);
   }
   expect(g.index!.count).toBe(source.indices.length);
  }finally{g.dispose()}
 });
 it('changes body height independently of head shape, keeps clothing bound and seat contact fixed',()=>{
  const snapshots:any[]=[];
  for(const bodyHeight of [.8,1.25])for(const headSize of [.75,1.4]){
   const g=createBlankBody('skin',{bodyHeight,headSize}),material=new T.MeshBasicMaterial(),root=new T.Group(),mesh=new T.Mesh(g,material),hair=new T.Group();root.add(mesh,hair);
   const rig=bindBlankBody(mesh,hair),outfit=dressHoodie(rig),animate=createBlankMotion(rig,root),head=new T.Box3(),v=new T.Vector3();
   try{
    const p=g.attributes.position;
    for(let i=0;i<p.count;i++)if(source.positions[i*3+1]>.16)head.expandByPoint(v.fromBufferAttribute(p,i));
    rig.setPose('bind');for(let i=0;i<p.count;i++){rig.mesh.getVertexPosition(i,v);expect(v.distanceTo(new T.Vector3().fromBufferAttribute(p,i))).toBeLessThan(.00001);}
    animate(0,'idle','seated');const seat=rig.bones.hips.getWorldPosition(new T.Vector3()).y;
    snapshots.push({bodyHeight,headSize,seat,head:head.getSize(new T.Vector3()),uv:Array.from(g.attributes.uv.array)});
    for(const [motion,posture] of [['wave-calm','standing'],['wave-cute','seated'],['idle','standing']] as const){
     for(let i=0;i<20;i++)animate(i/20,motion,posture);
     for(const m of [rig.mesh,...outfit.meshes]){m.updateWorldMatrix(true,false);for(let i=0;i<m.geometry.attributes.position.count;i++){m.getVertexPosition(i,v);expect(Number.isFinite(v.lengthSq())).toBe(true);}}
    }
   }finally{outfit.resources.forEach(r=>r.dispose());g.dispose();material.dispose();rig.skeleton.dispose();}
  }
  snapshots.forEach(s=>{expect(s.seat).toBeCloseTo(snapshots[0].seat,5);expect(s.uv).toEqual(snapshots[0].uv)});
  expect(snapshots[0].head.distanceTo(snapshots[2].head)).toBeLessThan(.00001);
  expect(snapshots[1].head.y/snapshots[0].head.y).toBeCloseTo(1.4/.75,5);
 });
});
