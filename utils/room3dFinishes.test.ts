import {describe,it,expect} from 'vitest';
import catalog from '../public/room3d/catalog.json';
import {createHome,addRoom,validateHome} from '../apps/room3d/model.js';
import {wallFinishPanels} from '../apps/room3d/finishes.js';
import {setBoundary} from '../apps/room3d/topology.js';
describe('per-room floor and wallpaper finishes',()=>{
 it.each(['checker','marble'])('preserves %s and distinct wall finishes through validation without changing neighbors',(floorStyle)=>{const h=createHome(catalog),a=h.rooms[0],b=addRoom(h,'right');Object.assign(a,{wallStyle:'stripe',floorStyle,wall:'#91C9F4'});Object.assign(b,{wallStyle:'dot',floorStyle:'wood',wall:'#F2B8D5'});expect(validateHome(h,catalog)).toEqual(h);expect(wallFinishPanels(h,a,catalog).find(p=>p.edge==='right')?.internal).toBe(true);expect(wallFinishPanels(h,b,catalog).find(p=>p.edge==='left')?.internal).toBe(true);});
 it('rejects unknown style values, leaving legacy layouts unchanged',()=>{const h=createHome(catalog);expect(validateHome(h,catalog)).toEqual(h);h.rooms[0].floorStyle='unknown' as any;expect(()=>validateHome(h,catalog)).toThrow('样式');});
 it('keeps openings clear and removes finishes with the wall, never papers fences',()=>{const h=createHome(catalog),a=h.rooms[0];setBoundary(h,a.id,'back',{kind:'wall_high',door:{kind:'arch',at:.4,width:2}},catalog);const p=wallFinishPanels(h,a,catalog).filter(p=>p.edge==='back');expect(p).toHaveLength(3);expect(p.find(p=>p.arch)).toMatchObject({lo:-.6,hi:1.4,bottom:2.2});expect(p.filter(p=>!p.arch).every(p=>p.hi<=-.6||p.lo>=1.4)).toBe(true);setBoundary(h,a.id,'back',{kind:'open'},catalog);expect(wallFinishPanels(h,a,catalog).some(p=>p.edge==='back')).toBe(false);setBoundary(h,a.id,'left',{kind:'wall_fence'},catalog);expect(wallFinishPanels(h,a,catalog).some(p=>p.edge==='left')).toBe(false);});
});
