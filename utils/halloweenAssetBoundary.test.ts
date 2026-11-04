import {readdirSync,readFileSync} from 'node:fs';
import {join,extname} from 'node:path';
import {describe,it,expect} from 'vitest';
import wardrobe from '../apps/room3d/chibi/approvedWardrobe.json';

describe('Halloween release asset boundary',()=>{
 it('keeps reference pictures and design packs outside the project',()=>{
  const forbidden:string[]=[];
  function scan(dir:string){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())scan(path);else if(/\.(png|jpe?g|webp|svg|zip)$/i.test(extname(path)))forbidden.push(path);}}
  scan('art/halloween-2026');expect(forbidden).toEqual([]);
 });
 it('can republish all Halloween garments using release metadata alone',()=>{
  const published=JSON.parse(readFileSync('art/chibi/halloween-wardrobe.json','utf8'));
  expect(published).toEqual(wardrobe.filter(g=>'collection' in g&&g.collection==='halloween'));
 });
});
