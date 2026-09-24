import {describe,it,expect} from 'vitest';
import catalog from '../public/room3d/catalog.json';
import {createHome,validateHome} from '../apps/room3d/model.js';
import {addShowroom} from '../apps/room3d/showrooms.js';
import {exportRoomLayout,parseRoomLayout,applyRoomLayout} from '../apps/room3d/roomSharing.js';

describe('single room sharing',()=>{
 const setup=()=>{const home=createHome(catalog),room=addShowroom(home,'study',catalog);return {home,room};};
 it('exports a portable allowlisted room without personal metadata or stored inventory',()=>{
  const {room}=setup();room.secret='private';room.items[0].secret='private';room.items.push({id:'stored',assetId:'gaming_pc',x:0,y:.15,z:0,rotation:0,color:null,stored:true});
  const snapshot=structuredClone(room),data=exportRoomLayout(room,catalog),text=JSON.stringify(data);
  expect(text).not.toContain('private');expect(data.room.items.some(i=>i.id==='stored'||i.stored)).toBe(false);expect(text).not.toContain(room.id);expect(data.room.items).toHaveLength(27);
  expect(data.room.x).toBe(0);expect(parseRoomLayout(text,catalog).items).toHaveLength(27);expect(room).toEqual(snapshot);
 });
 it('applies with fresh identities and intact tabletop/dock links while preserving neighbors and inventory',()=>{
  const {home,room}=setup(),data=exportRoomLayout(room,catalog);const before=structuredClone(home.rooms[0]);
  room.items.push({id:'stored',assetId:'gaming_pc',x:0,y:.15,z:0,rotation:0,color:null,stored:true});
  const next=applyRoomLayout(home,room.id,parseRoomLayout(data,catalog),catalog),r=next.rooms.find(r=>r.id===room.id)!;
  expect(next.rooms[0]).toEqual(before);expect(r.items.find(i=>i.id==='stored')?.stored).toBe(true);
  expect(r.items.filter(i=>i.supportId)).toHaveLength(data.room.items.filter(i=>i.supportId).length);
  for(const i of r.items.filter(i=>!i.stored)){expect(data.room.items.some(a=>a.id===i.id)).toBe(false);for(const key of ['supportId','dockId'])if(i[key])expect(r.items.some(a=>a.id===i[key])).toBe(true);}
  expect(validateHome(next,catalog)).toEqual(next);expect(home.rooms.find(r=>r.id===room.id)!.items[0].id).toBe(room.items[0].id);
 });
 it('rejects missing assets, versions, broken links and non-finite poses before changing a home',()=>{
  const {home,room}=setup(),base=exportRoomLayout(room,catalog),before=structuredClone(home);
  for(const edit of [(d:any)=>d.version=99,(d:any)=>d.room.items[0].assetId='unknown',(d:any)=>d.room.items[0].x=Infinity,(d:any)=>d.room.items.find(i=>i.supportId).supportId='missing']){
   const d=structuredClone(base);edit(d);expect(()=>parseRoomLayout(d,catalog)).toThrow();expect(home).toEqual(before);
  }
  expect(()=>parseRoomLayout('x'.repeat(1024*1024+1),catalog)).toThrow('过大');expect(()=>parseRoomLayout('{bad',catalog)).toThrow('无法读取');
 });
});
