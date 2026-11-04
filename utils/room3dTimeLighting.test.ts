import {describe,it,expect} from 'vitest';
import {ROOM_LIGHT_PHASES,roomLightPhase,resolveRoomLightPhase,createRoomLightUniforms,updateRoomLightUniforms} from '../apps/room3d/roomLighting.js';

describe('home daylight follows the owner clock',()=>{
 it.each([[4,59,'night'],[5,0,'morning'],[7,59,'morning'],[8,0,'day'],[15,59,'day'],[16,0,'sunset'],[18,59,'sunset'],[19,0,'night'],[23,59,'night'],[0,0,'night']])('handles the %i:%i boundary', (hour,minute,phase)=>{
  expect(roomLightPhase(undefined,new Date(2026,9,2,hour as number,minute as number))).toBe(phase);
 });
 it('uses the owner timezone once, including a half-hour zone, rather than the device clock',()=>{
  const instant=new Date('2026-10-02T10:45:00Z');
  expect(roomLightPhase('Asia/Shanghai',instant)).toBe('sunset');
  expect(roomLightPhase('America/New_York',instant)).toBe('morning');
  expect(roomLightPhase('Asia/Kolkata',instant)).toBe('sunset');
 });
 it('keeps manual selection through clock changes; invalid stored modes fall back to automatic',()=>{
  for(const at of ['2026-10-02T00:00:00Z','2026-10-02T12:00:00Z'])expect(resolveRoomLightPhase('day','Asia/Shanghai',new Date(at))).toBe('day');
  expect(resolveRoomLightPhase('bad-mode','Asia/Shanghai',new Date('2026-10-02T12:00:00Z'))).toBe('night');
 });
 it('changes the existing GPU uniform values without replacing their shared references',()=>{
  const uniforms=createRoomLightUniforms(),original={...uniforms},sky=uniforms.skyTop.value;
  updateRoomLightUniforms(uniforms,ROOM_LIGHT_PHASES.day);const day=sky.getHex();
  updateRoomLightUniforms(uniforms,ROOM_LIGHT_PHASES.sunset);
  expect(uniforms.roomShadeSoftness.value).toBeGreaterThan(0);
  updateRoomLightUniforms(uniforms,ROOM_LIGHT_PHASES.night);
  expect(uniforms.roomShadeSoftness.value).toBe(0);
  for(const key of Object.keys(original))expect(uniforms[key]).toBe(original[key]);
  expect(uniforms.skyTop.value).toBe(sky);expect(sky.getHex()).not.toBe(day);expect(uniforms.skyNight.value).toBe(1);
 });
});
