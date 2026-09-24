import {it,expect} from 'vitest';
import catalog from '../public/room3d/catalog.json';
import {createHome,moveFurniture} from '../apps/room3d/model.js';
import {addShowroom} from '../apps/room3d/showrooms.js';
import {windowOpenings,subtractOpenings} from '../apps/room3d/windowOpenings.js';
it('moves and removes the aperture with its window, leaving ordinary windows untouched',()=>{
 const h=createHome(catalog),r=addShowroom(h,'living',catalog),w=r.items.find(i=>i.assetId==='living_ref_window')!;
 const before=windowOpenings(r,'back',catalog);expect(before).toHaveLength(1);expect(windowOpenings(r,'left',catalog)).toHaveLength(0);
 moveFurniture(r,w.id,{x:w.x-.1},catalog);expect(windowOpenings(r,'back',catalog)[0].lo).toBeCloseTo(before[0].lo-.1);
 r.items.find(i=>i.id===w.id)!.stored=true;expect(windowOpenings(r,'back',catalog)).toHaveLength(0);
 expect(windowOpenings(addShowroom(h,'study',catalog),'back',catalog)).toHaveLength(0);
});
it('cuts a true opening, preserving only the remaining wall area',()=>{
 const p={lo:-5,hi:5,bottom:.15,top:4.7},hole={lo:-2,hi:3,bottom:.5,top:4.3},parts=subtractOpenings(p,[hole]);
 expect(parts.reduce((sum,p)=>sum+(p.hi-p.lo)*(p.top-p.bottom),0)).toBeCloseTo(45.5-19);
 for(const p of parts)expect(p.hi<=hole.lo||p.lo>=hole.hi||p.top<=hole.bottom||p.bottom>=hole.top).toBe(true);
});
