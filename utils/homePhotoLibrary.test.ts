import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import poses from '../apps/room3d/chibi/photoPoseCatalog.json';
import selected from '../art/chibi/motion-sources/home-approved-selection.json';
import sources from '../art/chibi/motion-sources/home-source-catalog.json';
import {photoLibrary} from '../apps/room3d/photoLibrary';
import {selectedMotions} from '../apps/room3d/chibi/selectedMotions';
describe('photo library approved assets',()=>{
 it('uses exactly approved original static poses and the complete production motion catalog',()=>{
  const allowed=new Set(selected.entries.map(e=>e.id));const expected=sources.filter(e=>e.kind==='pose'&&allowed.has(e.id));
  expect(poses.map(p=>p.id).sort()).toEqual(expected.map(p=>p.id).sort());
  expect(expected.every(p=>p.files.every(f=>f.includes('/poses01/')||f.includes('/poses03/')))).toBe(true);
  expect(photoLibrary.filter(p=>p.kind!=='pose'&&!p.photoOnly).map(p=>p.id)).toEqual(selectedMotions.map(p=>p.id));
 });
 it('ships finite static tracks and original source thumbnails',()=>{
  for(const p of poses){const clip=JSON.parse(fs.readFileSync(`public/room3d/motions/photo/${p.file}`,'utf8'));expect(clip.id).toBe(p.id);expect(clip.actors).toHaveLength(1);const a=clip.actors[0];for(const values of Object.values(a.tracks) as number[][]){expect(values).toHaveLength(8);expect(values.every(Number.isFinite)).toBe(true);}expect(a.positions.every(Number.isFinite)).toBe(true);expect(fs.existsSync(`public/room3d/motions/photo/${p.thumbnail}`)).toBe(true);}
 });
});
