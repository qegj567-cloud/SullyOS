import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {idleResidentsKeepDrawing} from '../apps/room3d/renderQuality.js';

const editor=readFileSync(new URL('../apps/room3d/editor.js',import.meta.url),'utf8');

describe('room idle drawing',()=>{
 it('lets power-saving and reduced-motion scenes stop drawing while other residents only stand idle',()=>{
  expect(idleResidentsKeepDrawing(true,false,false,false)).toBe(false);
  expect(idleResidentsKeepDrawing(true,false,true,true)).toBe(false);
 });
 it('keeps drawing while a resident still has an unfinished action',()=>{
  expect(idleResidentsKeepDrawing(true,true,false,false)).toBe(true);
  expect(idleResidentsKeepDrawing(true,true,true,true)).toBe(true);
 });
 it('keeps Balanced and Clear breathing whenever another resident is present',()=>{
  for(const busy of [false,true]){
   expect(idleResidentsKeepDrawing(true,busy,true,false)).toBe(true);
   expect(idleResidentsKeepDrawing(false,busy,true,false)).toBe(false);
  }
  expect(idleResidentsKeepDrawing(false,true,false,false)).toBe(false);
 });
 // editor.js 的渲染循环在闭包里，只能按源码形态钉住这两道闸。
 it('routes the frame loop through the quality-aware check',()=>{
  const tick=editor.slice(editor.indexOf('function tick('),editor.indexOf("document.addEventListener('visibilitychange'"));
  expect(tick).not.toContain('hasIdleResidents()');
  expect(tick.match(/idleResidentsLive\(/g)).toHaveLength(2);
 });
 it('releases the WebGL context when the room is disposed',()=>{
  expect(editor).toMatch(/renderer\.dispose\(\);[^;]*renderer\.forceContextLoss\(\);/);
  expect(editor).toContain('function renderScene(){if(destroyed)return;');
 });
});
