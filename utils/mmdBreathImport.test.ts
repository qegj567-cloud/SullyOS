import {describe,expect,it} from 'vitest';
// Offline JavaScript importer; deliberately not part of the browser bundle.
// @ts-expect-error Offline script has no declaration file.
import {rotationEase,sampleRotation} from '../art/chibi/import-mmd-breath.mjs';
describe('VMD rotation timing',()=>{
 it('uses destination-key Bezier timing rather than a linear blend',()=>{
  const curve=Array(64).fill(0);curve[3]=0;curve[7]=0;curve[11]=127;curve[15]=0;
  expect(rotationEase(curve,.5)).toBeCloseTo(.125,5);
  const keys=[{frameNum:0,rotation:[0,0,0,1],interpolation:Array(64).fill(127)},{frameNum:30,rotation:[0,0,1,0],interpolation:curve}];
  expect(sampleRotation(keys,15).z).toBeCloseTo(Math.sin(Math.PI*.125/2),5);
  expect(sampleRotation(keys,30).z).toBe(1);
  expect(sampleRotation(keys,60).z).toBe(1);
 });
 it('holds one-frame keys until the destination frame',()=>{
  const keys=[{frameNum:0,rotation:[0,0,0,1]},{frameNum:1,rotation:[0,0,1,0]}];
  expect(sampleRotation(keys,.5).w).toBe(1);expect(sampleRotation(keys,1).z).toBe(1);
 });
});
