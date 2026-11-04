import {it,expect} from 'vitest';
import {homeMap,homeDisplayX} from '../apps/room3d/homeMap.js';
it('shows the requested stacked positions and exactly one current-room marker',()=>{
 const rooms=([['客厅',0,0],['卫生间',1,0],['厨房',2,0],['卧室',1,1],['书房',2,1],['空房',2,2]] as const).map(([name,x,level],i)=>({id:String(i+1),name,x,z:0,level,wall:'#ffffff'}));
 const html=homeMap({rooms,activeRoomId:'4'});
 expect(html.match(/aria-current="location"/g)).toHaveLength(1);
 expect(html).toContain('data-id="4" aria-label="进入卧室" aria-current="location"');
 expect(html).toContain('grid-column:3 / span 2;grid-row:1');
 expect(html).toContain('grid-column:1 / span 2;grid-row:3');
});
it('escapes room names before putting them into map markup',()=>{
 const html=homeMap({rooms:[{id:'a',name:'<img src=x>',x:0,z:0,level:0,wall:'#ffffff'}],activeRoomId:'a'});
 expect(html).not.toContain('<img');expect(html).toContain('&lt;img src=x&gt;');
});

it('offers the optional annex before creation and switches to the existing room without duplicate entries',()=>{
 const home={rooms:[{id:'a',name:'客厅',x:0,z:0,level:0,wall:'#ffffff'}],activeRoomId:'a'};
 const before=JSON.stringify(home),html=homeMap(home);
 expect(html).toContain('data-action="activity-room" data-value="halloween"');expect(JSON.stringify(home)).toBe(before);
 const existing=homeMap({...home,rooms:[...home.rooms,{id:'annex',name:'万圣节魔法小屋',x:2,z:0,level:0,wall:'#663977',activityRoom:'halloween' as const}]});
 expect(existing).not.toContain('data-action="activity-room"');expect(existing).toContain('data-action="room" data-id="annex"');
 expect(existing.match(/🎃 活动别馆/g)).toHaveLength(1);
});

it('centers both upper floors of the existing six-room home without changing navigation cells',()=>{const rooms=[{x:0,z:0,level:0},{x:1,z:0,level:0},{x:2,z:0,level:0},{x:1,z:0,level:1},{x:2,z:0,level:1},{x:2,z:0,level:2}];expect(rooms.map(r=>homeDisplayX({rooms},r))).toEqual([0,1,2,.5,1.5,1]);expect(rooms.map(r=>r.x)).toEqual([0,1,2,1,2,2]);});

it('collapses the map without losing its expand control',()=>{const home={rooms:[{id:'a',name:'客厅',x:0,z:0,level:0,wall:'#ffffff'}],activeRoomId:'a'};expect(homeMap(home,undefined,true)).toContain('aria-label="展开小屋平面图" aria-expanded="false"');expect(homeMap(home,undefined,true)).toContain('<div hidden');expect(homeMap(home)).toContain('aria-label="收起小屋平面图" aria-expanded="true"');});
