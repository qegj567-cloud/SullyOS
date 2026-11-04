import {describe,it,expect} from 'vitest';
import catalog from '../public/room3d/catalog.json';
import {createStarterHome,defaultRoomLayout} from '../apps/room3d/starterHome.js';
import {addActivityRoom} from '../apps/room3d/activityRooms.js';
import {applyRoomPalette,ROOM_PALETTES} from '../apps/room3d/roomPalettes.js';
import {applyShowroomStyle} from '../apps/room3d/showrooms.js';
import {validateHome} from '../apps/room3d/model.js';
import {phoneBudgetError} from '../apps/room3d/deviceBudget.js';
import {homeMap,homeDisplayX} from '../apps/room3d/homeMap.js';
import {exportRoomLayout,parseRoomLayout,applyRoomLayout} from '../apps/room3d/roomSharing.js';
import {furnishingSpaceError} from '../apps/room3d/furnishingSpace.js';

describe('optional Halloween annex',()=>{
 it('preserves all six rooms and centered map cells, fits phone limits and survives a save',()=>{
  const home=createStarterHome(catalog),before=structuredClone(home),positions=home.rooms.map(r=>homeDisplayX(home,r));
  home.activeRoomId=home.rooms[5].id;
  const annex=addActivityRoom(home,'halloween',catalog);
  expect(home.rooms.slice(0,6)).toEqual(before.rooms);
  expect(annex).toMatchObject({x:4,z:0,level:0,activityRoom:'halloween',fixedPalette:'halloween'});
  expect(annex.items).toHaveLength(12);
  expect(home.rooms.slice(0,6).map(r=>homeDisplayX(home,r))).toEqual(positions);
  expect(phoneBudgetError(before,home,catalog)).toBe('');expect(phoneBudgetError(null,home,catalog)).toBe('');
  expect(furnishingSpaceError(before,home,catalog,{headWidth:1.8,walkClearance:true})).toBe('');
  expect(validateHome(JSON.parse(JSON.stringify(home)),catalog)).toEqual(home);
  const html=homeMap(home,annex.id);expect(html).toContain('🎃 活动别馆');expect(html).not.toContain('<small>7</small>');
  expect(html.match(/aria-current="location"/g)).toHaveLength(1);
  expect(html).toContain('grid-column:1 / -1;grid-row:4;');
 });
 it('reuses the existing annex and does not grant an eighth ordinary room',()=>{
  const home=createStarterHome(catalog),annex=addActivityRoom(home,'halloween',catalog),before=structuredClone(home);
  home.activeRoomId=home.rooms[0].id;expect(addActivityRoom(home,'halloween',catalog).id).toBe(annex.id);expect(home).toEqual(before);
  const next=structuredClone(home);next.rooms.push({...structuredClone(home.rooms[5]),id:'extra',x:8,level:0});
  expect(phoneBudgetError(home,next,catalog)).toContain('6');
 });
 it('preserves Halloween colors for every bulk palette and shared layouts, while normal rooms still change',()=>{
  const home=createStarterHome(catalog),annex=addActivityRoom(home,'halloween',catalog),before=structuredClone(annex);
  for(const key of Object.keys(ROOM_PALETTES)){for(const room of home.rooms)applyRoomPalette(room,key,catalog);expect(annex).toEqual(before);expect(home.rooms[0].wall).toBe(ROOM_PALETTES[key].wall);}
  applyShowroomStyle(annex,'living');expect(annex).toEqual(before);
  const shared=parseRoomLayout(JSON.stringify(exportRoomLayout(annex,catalog)),catalog),copy=structuredClone(shared);
  applyRoomPalette(shared,'blush',catalog);expect(shared).toEqual(copy);
  const reset=applyRoomLayout(home,annex.id,defaultRoomLayout(home,annex,catalog),catalog);
  expect(reset.rooms.at(-1).activityRoom).toBe('halloween');expect(reset.rooms.at(-1).fixedPalette).toBe('halloween');
 });
 it('fails atomically if the annex cannot be furnished or has no side space',()=>{
  const home=createStarterHome(catalog),before=structuredClone(home);
  expect(()=>addActivityRoom(home,'halloween',catalog.filter(a=>a.id!=='halloween_bat_sofa'))).toThrow();expect(home).toEqual(before);
  home.rooms[0].x=-12;home.rooms[1].x=12;const full=structuredClone(home);
  expect(()=>addActivityRoom(home,'halloween',catalog)).toThrow('两侧');expect(home).toEqual(full);
 });
});
