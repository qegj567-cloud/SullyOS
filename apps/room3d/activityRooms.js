import {clone,uid} from './model.js';
import {furnishShowroom,SHOWROOMS} from './showrooms.js';
import {setBoundary} from './topology.js';

// A detached ground-floor annex keeps the main home's cells and walls intact.
export function addActivityRoom(home,key,catalog){
 if(key!=='halloween')throw Error('找不到这间活动小屋');
 const existing=home.rooms.find(r=>r.activityRoom===key);
 if(existing){home.activeRoomId=existing.id;return existing;}
 if(home.rooms.length>=24)throw Error('这座小屋最多可以有 24 个房间');
 const next=clone(home),main=next.rooms.filter(r=>!r.activityRoom),xs=main.map(r=>r.x);
 const candidates=[Math.max(...xs)+2,Math.min(...xs)-2];
 const x=candidates.find(x=>Math.abs(x)<=12&&!next.rooms.some(r=>Math.abs(r.x-x)<=1));
 if(x===undefined)throw Error('主屋两侧没有可放置活动别馆的空间');
 const room={id:uid(),name:SHOWROOMS[key].name,x,z:main[0].z,level:0,wall:SHOWROOMS[key].wall,items:[],activityRoom:key,defaultTemplate:{kind:key,compact:false}};
 furnishShowroom(room,key,catalog);
 next.rooms.push(room);next.activeRoomId=room.id;
 setBoundary(next,room.id,'front',{kind:'wall_high',door:{kind:SHOWROOMS[key].door,at:0,width:2.2}},catalog);
 Object.assign(home,next);return room;
}
