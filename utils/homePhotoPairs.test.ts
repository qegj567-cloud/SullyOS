import {describe,it,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import pairs from '../apps/room3d/chibi/photoPairCatalog.json';
import provenance from '../art/photo-mode-2026/portrait-sources.json';
import {selectedMotions,sampleSelected} from '../apps/room3d/chibi/selectedMotions';
import {photoLibrary,loadPhotoClip} from '../apps/room3d/photoLibrary';
import {homePhotoActionAllowed,homeSocialActionAllowed,isRomanticMotion} from '../apps/room3d/homeRomance';
afterEach(()=>vi.unstubAllGlobals());
describe('Meshy portrait pairs',()=>{
 it('keeps all six photo-only pairs outside home/social action execution',()=>{
  expect(pairs).toHaveLength(6);
  for(const p of pairs){
   expect(selectedMotions.some(m=>m.id===p.id)).toBe(false);
   expect(homeSocialActionAllowed({romanticPairs:[['a','b']]},p.id,'a','b')).toBe(false);
   expect(photoLibrary.find(m=>m.id===p.id)).toMatchObject({photoOnly:true,participants:2,kind:'pair',defaultTime:3.5});
  }
 });
 it('requires the explicit selected romantic pair for the back-hug, while friend poses stay available',()=>{
  const home={romanticPairs:[['a','b']] as [string,string][]};
  expect(isRomanticMotion('photo-peek')).toBe(true);
  expect(homePhotoActionAllowed(home,'photo-peek','a','b')).toBe(true);
  expect(homePhotoActionAllowed(home,'photo-peek','b','a')).toBe(true);
  expect(homePhotoActionAllowed(home,'photo-peek','a','c')).toBe(false);
  expect(homePhotoActionAllowed(home,'photo-heart','a','c')).toBe(true);
  expect(homePhotoActionAllowed(home,'unregistered','a','b')).toBe(false);
 });
 it('ships only hash-verified animation tracks with synchronized finite samples and actual motion',()=>{
  for(const p of pairs){
   const bytes=fs.readFileSync(`public/room3d/motions/photo-pairs/${p.id}.json`),clip=JSON.parse(bytes.toString());
   expect(createHash('sha256').update(bytes).digest('hex')).toBe(provenance.find(e=>e.id===p.id)!.sha256);
   expect(clip.source).toBe('meshy-text-to-motion');expect(clip.actors).toHaveLength(2);
   expect(clip.actors[0].times).toEqual(clip.actors[1].times);
   for(const a of clip.actors){
    expect(a.times).toHaveLength(121);expect(a.times.at(-1)).toBe(6);
    for(const values of Object.values(a.tracks) as number[][]){expect(values).toHaveLength(484);expect(values.every(Number.isFinite)).toBe(true);}
    const first=sampleSelected(a,0),last=sampleSelected(a,6);
    expect(first.rotations.R_upperArm.angleTo(last.rotations.R_upperArm)).toBeGreaterThan(.01);
    for(const t of [0,1,3.5,6])for(const q of Object.values(sampleSelected(a,t).rotations))expect(q.length()).toBeCloseTo(1,4);
   }
  }
 });
 it('retries a failed lazy fetch and rejects an asset with the wrong participant count',async()=>{
  const clip=JSON.parse(fs.readFileSync('public/room3d/motions/photo-pairs/photo-heart.json','utf8'));
  const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({...clip,actors:[clip.actors[0]]})}).mockResolvedValue({ok:true,json:async()=>clip});vi.stubGlobal('fetch',fetch);
  await expect(loadPhotoClip('photo-heart')).rejects.toThrow('姿势数据不匹配');
  await expect(loadPhotoClip('photo-heart')).resolves.toMatchObject({id:'photo-heart'});
  expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[0][0]).toContain('/motions/photo-pairs/photo-heart.json');
 });
});
