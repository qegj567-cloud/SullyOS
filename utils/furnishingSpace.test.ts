import {expect,it} from 'vitest';
import {furnishingSpaceError} from '../apps/room3d/furnishingSpace.js';
import catalog from '../public/room3d/catalog.json';
import {createStarterHome,defaultRoomLayout} from '../apps/room3d/starterHome.js';
import {applyRoomLayout} from '../apps/room3d/roomSharing.js';
const assets=[{id:'block',surface:'floor',size:[.3,2,8],boxes:[[-.15,0,-4,.15,2,4]]},{id:'ball',surface:'floor',size:[.3,.3,.3],boxes:[[-.15,0,-.15,.15,.3,.15]]}];
const home=()=>({rooms:[{id:'r',name:'客厅',x:0,z:0,level:0,wall:'#ffffff',items:[]}]});
const item=(assetId:string)=>({id:'new',assetId,x:0,y:.15,z:0,rotation:0,stored:false});
it('allows small toys but rejects new furniture that cuts the walking area in half',()=>{
 const before=home(),after=home();after.rooms[0].items.push(item('ball') as never);expect(furnishingSpaceError(before,after,assets)).toBe('');
 after.rooms[0].items=[item('block') as never];expect(furnishingSpaceError(before,after,assets)).toContain('通道');
 expect(furnishingSpaceError(after,before,assets)).toBe('');
});
it('ignores color changes and allows clearing already blocked layouts',()=>{
 const before=home();before.rooms[0].items=[item('block') as never];const after=structuredClone(before);(after.rooms[0].items[0] as any).color='#ff0000';
 expect(furnishingSpaceError(before,after,assets)).toBe('');
});
it('restores every starter room with stable room IDs, chosen palette, stored items and other rooms intact',()=>{
 for(let n=0;n<6;n++){
  const before=createStarterHome(catalog,'aqua'),room=before.rooms[n],source=defaultRoomLayout(before,room,catalog)!;
  const baseline=room.items.map(i=>[i.assetId,i.x,i.y,i.z,i.color]);
  if(room.items.length){room.items[0].stored=true;room.items[0].supportId=null;room.items[0].dockId=null;}
  const stored=structuredClone(room.items.filter(i=>i.stored));room.name='自定义名字';source.name=room.name;
  const restored=applyRoomLayout(before,room.id,source,catalog);
  expect(restored.rooms[n].id).toBe(room.id);expect(restored.rooms[n].name).toBe(room.name);
  expect(restored.rooms[n].wall).toBe('#eff5f5');
  expect(restored.rooms[n].items.filter(i=>!i.stored).map(i=>[i.assetId,i.x,i.y,i.z,i.color])).toEqual(baseline);
  expect(restored.rooms[n].items.filter(i=>i.stored)).toEqual(stored);
  expect(restored.rooms.filter(r=>r.id!==room.id)).toEqual(before.rooms.filter(r=>r.id!==room.id));
 }
});
