import {describe,it,expect} from 'vitest';
import {createMirrorJourney,mirrorJourneyFrame} from '../apps/room3d/mirrorJourney.js';
const activity={position:[0,.18,0],rotation:Math.PI,wardrobePose:{position:[0,.18,-3.4],rotation:0}};
describe('outfit trips',()=>{
 it('walks two round trips, pauses at each destination and finishes at the mirror',()=>{
  const j=createMirrorJourney(activity,activity.position,(a,b)=>[a,b]);
  expect(j.phases.filter(p=>p.motion==='walk')).toHaveLength(4);
  expect(j.phases.filter(p=>p.motion!=='walk').map(p=>p.destination)).toEqual(['wardrobe','mirror','wardrobe','mirror']);
  const moving=mirrorJourneyFrame(j,1);expect(moving.position[2]).toBeCloseTo(-1.7);expect(moving.motion).toBe('walk');
  expect(mirrorJourneyFrame(j,2.5).position).toEqual(activity.wardrobePose.position);
  const done=mirrorJourneyFrame(j,j.duration+100);expect(done.done).toBe(true);expect(done.position).toEqual(activity.position);
 });
 it('teleports immediately when no route exists, including blocked return paths',()=>{
  const j=createMirrorJourney(activity,activity.position,()=>null);
  expect(j.phases).toHaveLength(4);expect(j.phases.every(p=>p.teleported)).toBe(true);
  expect(mirrorJourneyFrame(j,0).position).toEqual(activity.wardrobePose.position);
  expect(mirrorJourneyFrame(j,1.8).position).toEqual(activity.position);
  expect(mirrorJourneyFrame(j,5.4).position).toEqual(activity.wardrobePose.position);
  expect(mirrorJourneyFrame(j,j.duration).done).toBe(true);
 });
 it('follows all detour segments rather than crossing obstacles',()=>{
  const j=createMirrorJourney(activity,activity.position,(a,b)=>[a,[2,.18,a[2]],[2,.18,b[2]],b]);
  const f=mirrorJourneyFrame(j,2);expect(f.position[0]).toBe(2);expect(f.position[2]).toBeCloseTo(-1.4);
 });
});
