import {createLocalId} from '../../utils/localId.js';
import {normalizeRomanticPairs} from './homeRomance';
import {normalizePetLife} from './petState.js';
import {furnitureGroup,dockCandidates,dockSlots,isDockChair,isDockTable} from './furnitureDock.js';
import {validateFinishes} from './finishes.js';
import {ROOM_HALF,ROOM_SIZE_VERSION,MAX_BUILDING_LENGTH,migrateRoomSize} from './dimensions.js';
import {buildingScale} from './building.js';
import {snapToWall,wallCandidates,wallPlacementError} from './wallMount.js';
import {validateBoundaries,insideFloors,boundaryBoxes,boundary,neighbor,OPPOSITE} from './topology.js';
export const clone=value=>JSON.parse(JSON.stringify(value));
export const STEP=.2;
export const DIRECTIONS={left:[-1,0,0],right:[1,0,0],front:[0,1,0],back:[0,-1,0],up:[0,0,1],down:[0,0,-1]};
export const PALETTE=['#A99BE8','#F2B8D5','#91C9F4','#A5B99A','#E8BD8F','#FFF2E3'];
export const uid=createLocalId;
export function createHome(catalog){
 const starter=catalog.filter(a=>['table','rug'].includes(a.id));
 const room={id:uid(),name:'水母小屋',x:0,z:0,level:0,wall:'#FFF2E3',items:starter.map(a=>({id:uid(),assetId:a.id,x:a.default[0],y:a.default[1],z:a.default[2],rotation:0,color:null,stored:false}))};
 return {version:1,assetVersion:2,roomSizeVersion:ROOM_SIZE_VERSION,activeRoomId:room.id,rooms:[room]};
}
function addStarterProps(room,catalog){
 for(const id of ['open_book','tea_mug','jelly_lamp']){const a=catalog.find(a=>a.id===id);if(a&&room.items.length<100)try{room.items.push(findPlace(a,room,catalog))}catch{}}
}
export function validateHome(raw,catalog){
 if(!raw||raw.version!==1||!Array.isArray(raw.rooms)||raw.rooms.length<1||raw.rooms.length>24)throw Error('小屋存档格式不正确');
 raw=structuredClone(raw);
 if(raw.romanticPairs!==undefined)raw.romanticPairs=normalizeRomanticPairs(raw.romanticPairs);
 if(raw.socialMemberIds!==undefined){if(!Array.isArray(raw.socialMemberIds)||raw.socialMemberIds.some(id=>typeof id!=='string'||!id))throw Error('小屋邀请名单格式不正确');raw.socialMemberIds=[...new Set(raw.socialMemberIds)].slice(0,3);}
 if(raw.roomSizeVersion!=null&&![1,ROOM_SIZE_VERSION].includes(raw.roomSizeVersion))throw Error('不支持这个房间尺寸版本');
 const assets=new Set(catalog.map(a=>a.id)),cells=new Set(),ids=new Set();
 for(const r of raw.rooms){
  if(typeof r.id!=='string'||ids.has(r.id)||typeof r.name!=='string'||r.name.length>40||![r.x,r.z,r.level].every(Number.isInteger)||Math.abs(r.x)>12||Math.abs(r.z)>12||r.level<0||r.level>5)throw Error('房间信息不正确');
  ids.add(r.id);const key=[r.x,r.z,r.level].join();if(cells.has(key))throw Error('房间位置重复');cells.add(key);
  if(r.fixedPalette!=null&&r.fixedPalette!=='halloween')throw Error('房间主题配色不正确');
  if(r.activityRoom!=null&&(r.activityRoom!=='halloween'||r.level!==0||raw.rooms.filter(v=>v.activityRoom===r.activityRoom).length!==1))throw Error('活动别馆信息不正确');
  if(!/^#[0-9a-f]{6}$/i.test(r.wall)||!Array.isArray(r.items)||r.items.length>100)throw Error('房间内容不正确');
  for(const part of ['trim','floor'])if(r[part]!=null&&!/^#[0-9a-f]{6}$/i.test(r[part]))throw Error('房屋颜色不正确');
  validateFinishes(r);
  for(const i of r.items){
   if(i.assetId==='wooden_window_left'&&assets.has('wooden_window')){i.assetId='wooden_window';i.rotation=(i.rotation+90)%360;}
   if(typeof i.id!=='string'||ids.has(i.id)||!assets.has(i.assetId)||i.assetId==='shell'||![i.x,i.y,i.z,i.rotation].every(Number.isFinite)||Math.abs(i.x)>8||Math.abs(i.z)>8||i.y<-.5||i.y>8||![0,90,180,270].includes(i.rotation)||typeof i.stored!=='boolean'||i.color!==null&&!/^#[0-9a-f]{6}$/i.test(i.color))throw Error('家具信息不正确');
   ids.add(i.id);
   if(i.materialColors!=null){const allowed=new Set((catalog.find(a=>a.id===i.assetId)?.colorParts||[]).map(p=>p.material));if(typeof i.materialColors!=='object'||Array.isArray(i.materialColors)||Object.entries(i.materialColors).some(([name,color])=>!allowed.has(name)||typeof color!=='string'||!/^#[0-9a-f]{6}$/i.test(color)))throw Error('家具局部配色不正确');}
   if(i.length!=null&&(!catalog.find(a=>a.id===i.assetId)?.building||!Number.isFinite(i.length)||i.length<.4||i.length>MAX_BUILDING_LENGTH))throw Error('墙段长度需要在 0.4 到 10 之间');
  }
 }
 migrateRoomSize(raw,catalog);
 validateBoundaries(raw);
 if(!raw.rooms.some(r=>r.id===raw.activeRoomId))throw Error('找不到当前房间');
 const result=clone(raw);
 for(const room of result.rooms){
  for(const i of room.items){const a=catalog.find(a=>a.id===i.assetId);if(a?.surface==='wall'&&!i.stored&&wallPlacementError(i,a,room,catalog)){const snapped=snapToWall(i,a,room,catalog);if(snapped)Object.assign(i,snapped);else i.stored=true;}}
  for(const i of room.items)if(i.supportId!=null){
   const parent=room.items.find(p=>p.id===i.supportId);
   if(typeof i.supportId!=='string'||!parent||parent.id===i.id||!catalog.find(a=>a.id===parent.assetId)?.support||catalog.find(a=>a.id===i.assetId)?.surface!=='tabletop'||parent.stored!==i.stored)throw Error('台面承托关系不正确');
   if(!i.stored&&supportError(i,room,catalog))throw Error('桌上物件超出台面');
  }
  for(const i of room.items){
   if(i.dockDisabled!=null&&typeof i.dockDisabled!=='boolean')throw Error('桌椅吸附设置不正确');
   if(i.dockId!=null){const parent=room.items.find(p=>p.id===i.dockId),a=catalog.find(a=>a.id===i.assetId);
    if(typeof i.dockId!=='string'||parent===i||!parent||!isDockChair(a)||!isDockTable(catalog.find(a=>a.id===parent.assetId))||parent.stored!==i.stored||typeof i.dockSlot!=='string')throw Error('桌椅组合关系不正确');
    const pose=dockSlots(parent,i,room,catalog).find(p=>p.dockSlot===i.dockSlot);
    if(!pose||Math.hypot(pose.x-i.x,pose.z-i.z)>.04||Math.abs(pose.y-i.y)>.025||pose.rotation!==i.rotation||i.dockDisabled){delete i.dockId;delete i.dockSlot;}
   }
  }
  const occupiedDocks=new Set();for(const i of room.items)if(i.dockId){const key=i.dockId+'/'+i.dockSlot;if(occupiedDocks.has(key))throw Error('同一桌椅吸附位不能重复占用');occupiedDocks.add(key);}
  // Older exact presets gain a link without moving a user's furniture.
  for(const i of room.items.filter(i=>!i.stored&&!i.dockId&&!i.dockDisabled&&isDockChair(catalog.find(a=>a.id===i.assetId)))){
   const pose=dockCandidates(i,room,catalog,.025).find(p=>p.rotation===i.rotation&&Math.abs(p.y-i.y)<.025&&!placementError(p,room,catalog));
   if(pose){i.dockId=pose.dockId;i.dockSlot=pose.dockSlot;}
  }
  if(!result.assetVersion){for(const i of room.items)if(catalog.find(a=>a.id===i.assetId)?.surface==='tabletop'&&!i.supportId)i.stored=true;addStarterProps(room,catalog)}
  for(const i of room.items)if(!i.stored&&catalog.find(a=>a.id===i.assetId)?.surface==='tabletop'&&!i.supportId)throw Error('桌上物件需要台面');
  // The lowered monitor now occupies the old streaming preset's boom space.
  // Only repair that exact obsolete preset position when it actually collides;
  // preserve instance IDs/colors and leave individually arranged microphones alone.
  for(const mic of room.items.filter(i=>!i.stored&&i.assetId==='gaming_microphone')){
   const desk=room.items.find(i=>i.id===mic.supportId&&i.assetId==='gaming_desk'&&!i.stored);
   if(!desk||mic.rotation!==desk.rotation)continue;
   const angle=desk.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),dx=mic.x-desk.x,dz=mic.z-desk.z;
   if(Math.abs(c*dx-s*dz+.96)>.005||Math.abs(s*dx+c*dz-.29)>.005)continue;
   if(!room.items.some(i=>!i.stored&&i.supportId===desk.id&&i.assetId==='gaming_monitors')||!placementError(mic,room,catalog))continue;
   const scale=catalog.find(a=>a.id===desk.assetId).size[0]/3.4;
   const next={...mic,x:desk.x+(-c*.925+s*.575)*scale,z:desk.z+(s*.925+c*.575)*scale};
   if(!placementError(next,room,catalog))Object.assign(mic,next);
  }
  // The petal sofa grew wider. Keep valid old placements; relocate only those
  // now intersecting a wall/furniture, retaining identity and chosen fabric color.
  for(const i of room.items)if(!room.boundaries&&i.assetId==='petal_sofa'&&!i.stored&&placementError(i,room,catalog)){
   try{const next=findPlace(catalog.find(a=>a.id===i.assetId),room,catalog,i.id);Object.assign(i,next,{color:i.color});}catch{i.stored=true;}
  }
 }
 if(result.petLife)result.petLife=normalizePetLife(result.petLife,result,catalog);
 result.assetVersion=2;return result;
}
export const isWaterablePlant=a=>a?.surface==='floor'&&a.waterable===true;
export function furnitureType(a){return a.holdable?'plush':a.category==='pets'?'pets':a.building?'building':isWaterablePlant(a)?'plants':a.seats?.length||['chair','sofa','petal_sofa'].includes(a.id)?'seating':a.support?'table':a.surface==='rug'?'rug':a.surface==='tabletop'?'tabletop':['left','back','wall'].includes(a.surface)?'wall':a.surface==='ceiling'?'ceiling':'floor'}
export const TYPE_LABELS={all:'全部',gaming:'电竞',kitchen:'厨房',bathroom:'浴室',bedroom:'卧室',pets:'宠物',plush:'玩偶',seating:'座椅',rug:'地毯',table:'桌台',tabletop:'桌上小物',plants:'绿植',floor:'落地',wall:'墙饰',ceiling:'吊挂',building:'墙体 / 栅栏',doors:'门'};
export function supportSurfaces(asset){const s=asset?.support;return s?[s,...s.areas??[]].sort((a,b)=>b.height-a.height):[];}
function supportError(i,room,catalog){
 const parent=room.items.find(p=>p.id===i.supportId&&!p.stored),a=catalog.find(a=>a.id===i.assetId),surfaces=supportSurfaces(catalog.find(a=>a.id===parent?.assetId));
 if(!parent||!surfaces.length)return '请把小物件放到桌台上';
 const matching=surfaces.filter(s=>Math.abs(i.y-parent.y-s.height)<=.025);if(!matching.length)return '小物件需要贴着台面';
 const angle=-parent.rotation*Math.PI/180,c=Math.cos(angle),sn=Math.sin(angle);
 let points=[];
 if(a.contact){const f=a.contact,t=i.rotation*Math.PI/180;for(const x of [-f.width/2,f.width/2])for(const z of [-f.depth/2,f.depth/2]){const px=x+(f.center?.[0]??0),pz=z+(f.center?.[1]??0);points.push([i.x+Math.cos(t)*px+Math.sin(t)*pz,i.z-Math.sin(t)*px+Math.cos(t)*pz]);}}
 else for(const b of boxes(i,a))for(const x of [b[0],b[3]])for(const z of [b[2],b[5]])points.push([x,z]);
 const local=points.map(([x,z])=>{const dx=x-parent.x,dz=z-parent.z;return [c*dx+sn*dz,-sn*dx+c*dz];});
 for(const s of matching){const cx=s.center?.[0]??0,cz=s.center?.[1]??0;
  if(!local.every(([x,z])=>s.shape==='circle'?Math.hypot(x-cx,z-cz)<=s.radius+.001:Math.abs(x-cx)<=s.width/2+.001&&Math.abs(z-cz)<=s.depth/2+.001))continue;
  const minX=Math.min(...local.map(p=>p[0])),maxX=Math.max(...local.map(p=>p[0])),minZ=Math.min(...local.map(p=>p[1])),maxZ=Math.max(...local.map(p=>p[1]));
  if(surfaces.some(high=>high.height>s.height+.025&&high.shape==='rect'&&maxX>(high.center?.[0]??0)-high.width/2&&minX<(high.center?.[0]??0)+high.width/2&&maxZ>(high.center?.[1]??0)-high.depth/2&&minZ<(high.center?.[1]??0)+high.depth/2))continue;
  return '';
 }
 return '小物件要完整放在同一层台面内';
}
export function snapToSupport(i,room,catalog){
 if(catalog.find(a=>a.id===i.assetId)?.surface!=='tabletop')return i;
 for(const parent of room.items){if(parent.stored)continue;for(const s of supportSurfaces(catalog.find(a=>a.id===parent.assetId))){
  const next={...i,y:parent.y+s.height,supportId:parent.id};if(!supportError(next,room,catalog))return next;}
 }
 return {...i,supportId:null};
}
export function snapToFurniture(item,room,catalog){
 if(!isDockChair(catalog.find(a=>a.id===item.assetId)))return item;
 const free={...item,dockId:null,dockSlot:null};
 return dockCandidates(free,room,catalog).find(next=>!placementError(next,{...room,items:room.items.map(i=>i.id===item.id?next:i)},catalog))||free;
}
export function moveFurniture(room,id,patch,catalog){
 const original=room.items.find(i=>i.id===id);if(!original)throw Error('找不到家具');
 const a=catalog.find(a=>a.id===original.assetId),proposed={...original,...patch};
 let next=a?.surface==='wall'?snapToWall(proposed,a,room,catalog):snapToSupport(proposed,room,catalog);if(!next)throw Error('没有能放下这件物品的高墙');
 next=snapToFurniture(next,room,catalog);
 const candidates=previewFurniture(room,id,next).items;
 const test={...room,items:candidates};for(const i of furnitureGroup(test,id)){const why=placementError(i,test,catalog);if(why)throw Error(why)}
 room.items=candidates;
}
// Visual placement only: transform the item and its supported props together,
// without collision rejection or changing the saved layout.
export function previewFurniture(room,id,patch){
 const original=room.items.find(i=>i.id===id);if(!original)throw Error('找不到家具');
 const members=new Set(furnitureGroup(room,id).map(i=>i.id));
 const next={...original,...patch},angle=(next.rotation-original.rotation)*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
 return {...room,items:room.items.map(i=>i.id===id?next:members.has(i.id)?{...i,x:next.x+c*(i.x-original.x)+s*(i.z-original.z),z:next.z-s*(i.x-original.x)+c*(i.z-original.z),y:i.y+next.y-original.y,rotation:(i.rotation+next.rotation-original.rotation+360)%360}:i)};
}
export function addRoom(home,direction){
 const room=home.rooms.find(r=>r.id===home.activeRoomId),delta=DIRECTIONS[direction];
 if(!delta)throw Error('未知扩建方向');
 const [x,z,level]=[room.x+delta[0],room.z+delta[1],room.level+delta[2]];
 const existing=home.rooms.find(r=>r.x===x&&r.z===z&&r.level===level);
 if(existing){home.activeRoomId=existing.id;return existing}
 if(home.rooms.length>=24)throw Error('这座小屋最多可以有 24 个房间');
 if(level<0||level>5||Math.abs(x)>12||Math.abs(z)>12)throw Error('已经到达扩建边界（最多六层）');
 if(level>0&&!home.rooms.some(r=>r.x===x&&r.z===z&&r.level===level-1))throw Error('先在下面扩建一间房，再往上盖');
 const next={id:uid(),name:`新房间 ${home.rooms.length+1}`,x,z,level,wall:'#FFF2E3',items:[]};
 for(const edge of Object.keys(OPPOSITE)){const other=neighbor(home,next,edge);if(other?.boundaries?.[OPPOSITE[edge]])next.boundaries={...next.boundaries,[edge]:clone(boundary(other,OPPOSITE[edge]))};}
 home.rooms.push(next);home.activeRoomId=next.id;return next;
}
export function findResidentSpot(room,catalog){
 const obstacles=[...boundaryBoxes(room,catalog),...room.items.filter(i=>!i.stored&&!['rug','ceiling'].includes(catalog.find(a=>a.id===i.assetId)?.surface)).flatMap(i=>boxes(i,catalog.find(a=>a.id===i.assetId)))];
 for(let z=ROOM_HALF.z-.65;z>=-ROOM_HALF.z+.65;z-=.25)for(const x of Array.from({length:Math.ceil((ROOM_HALF.x-.85)/.35)*2-1},(_,k)=>k===0?0:Math.ceil(k/2)*.35*(k%2?1:-1))){
  const body=[x-.28,.18,z-.28,x+.28,.7,z+.28],head=[x-.7,.7,z-.52,x+.7,1.8,z+.52];
  if(!obstacles.some(b=>[body,head].some(a=>a[0]<b[3]&&a[3]>b[0]&&a[1]<b[4]&&a[4]>b[1]&&a[2]<b[5]&&a[5]>b[2])))return [x,.18,z];
 }
 return null;
}
export function boxes(item,asset){
 const a=item.rotation*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
 const scale=asset.building?buildingScale(item):1;
 return asset.boxes.map(b=>{
  const p=[[b[0],b[2]],[b[0],b[5]],[b[3],b[2]],[b[3],b[5]]].map(([x,z])=>[item.x+c*x*scale+s*z,item.z-s*x*scale+c*z]);
  return [Math.min(...p.map(v=>v[0])),item.y+b[1],Math.min(...p.map(v=>v[1])),Math.max(...p.map(v=>v[0])),item.y+b[4],Math.max(...p.map(v=>v[1]))];
 });
}
export function placementError(item,room,catalog){
 const a=catalog.find(a=>a.id===item.assetId);if(!a)return '找不到这件家具';
 if(a.building&&item.length!=null&&(!Number.isFinite(item.length)||item.length<.4||item.length>MAX_BUILDING_LENGTH))return '墙段长度需要在 0.4 到 10 之间';
 if(a.surface==='tabletop'){const why=supportError(item,room,catalog);if(why)return why}
 if(a.surface==='wall'){const why=wallPlacementError(item,a,room,catalog);if(why)return why}
 const turned=item.rotation%180!==0,width=a.size[0]*(a.building?buildingScale(item):1),halfX=(turned?a.size[2]:width)/2,halfZ=(turned?width:a.size[2])/2;
 if(a.surface==='floor'||a.surface==='rug'){
  const bounds=a.building?[ROOM_HALF.x+.121,ROOM_HALF.z+.121]:[ROOM_HALF.x-.09,ROOM_HALF.z-.10];
  const outside=room.floorCells&&!a.building?!insideFloors([item.x-halfX,item.z-halfZ,item.x+halfX,item.z+halfZ],room.floorCells):Math.abs(item.x)+halfX>bounds[0]||Math.abs(item.z)+halfZ>bounds[1];
  if(outside)return a.building?'墙段不能超出房屋四周，请缩短或移动':'家具要完整放在地板内';
 }
 if(a.surface==='back'&&(Math.abs(item.x)+a.size[0]/2>ROOM_HALF.x-.12||item.y<.15||item.y+a.size[1]>4.92))return '请放在后墙范围内';
 if(a.surface==='left'&&(Math.abs(item.z)+a.size[2]/2>ROOM_HALF.z-.15||item.y<.15||item.y+a.size[1]>4.92))return '请放在左墙范围内';
 const mine=boxes(item,a);
 if(!a.building&&a.surface!=='rug')for(const u of mine)for(const v of room.obstacles??[]){if(u[0]<v[3]-.045&&u[3]>v[0]+.045&&u[1]<v[4]-.045&&u[4]>v[1]+.045&&u[2]<v[5]-.045&&u[5]>v[2]+.045)return '这里会碰到墙体或门框';}
 for(const other of room.items){
  if(other.id===item.id||other.stored||other.id===item.supportId||other.supportId===item.id)continue;const b=catalog.find(a=>a.id===other.assetId);if(!b)continue;
  // Allow corner / T junctions, but do not silently stack parallel segments.
  if(a.building&&b.building){
   if(item.rotation%180!==other.rotation%180)continue;
   const along=item.rotation%180===0?0:2,across=along===0?2:0,u=mine[0],v=boxes(other,b)[0];
   if(Math.min(u[along+3],v[along+3])-Math.max(u[along],v[along])>.24&&Math.min(u[across+3],v[across+3])-Math.max(u[across],v[across])>.04)return '这里已有墙段，选中它可以切换类型';
   continue;
  }
  const bTurn=other.rotation%180!==0,bWidth=b.size[0]*(b.building?buildingScale(other):1),bX=(bTurn?b.size[2]:bWidth)/2,bZ=(bTurn?bWidth:b.size[2])/2;
  if(Math.abs(item.x-other.x)>=halfX+bX||Math.abs(item.z-other.z)>=halfZ+bZ||item.y>=other.y+b.size[1]||other.y>=item.y+a.size[1])continue;
  const otherBoxes=boxes(other,b);for(const u of mine)for(const v of otherBoxes){
   if(u[0]<v[3]-.045&&u[3]>v[0]+.045&&u[1]<v[4]-.045&&u[4]>v[1]+.045&&u[2]<v[5]-.045&&u[5]>v[2]+.045)return `这里会碰到${b.name}`;
  }
 }
 return '';
}
export function findPlace(asset,room,catalog,itemId=uid(),length){
 const item={id:itemId,assetId:asset.id,x:asset.default[0],y:asset.default[1],z:asset.default[2],rotation:0,color:null,stored:false};
 if(isDockChair(asset)){const docked=dockCandidates(item,room,catalog,Infinity).find(i=>!placementError(i,room,catalog));if(docked)return docked;}
 if(asset.surface==='back')item.z-=(ROOM_HALF.z-2.65);if(asset.surface==='left')item.x-=(ROOM_HALF.x-3.1);
 if(asset.building&&length!=null)item.length=length;
 if(asset.surface==='wall'){
  for(const c of wallCandidates(item,asset,room,catalog)){if(!placementError(c.item,room,catalog))return c.item;
   const along=c.face.axis==='z'?'x':'z';for(let y=c.face.bottom+.1;y<=c.face.top-asset.size[1];y+=.2)for(let pos=c.face.lo+asset.size[0]/2+.02;pos<=c.face.hi-asset.size[0]/2-.02;pos+=.2){const next={...c.item,[along]:pos,y};if(!placementError(next,room,catalog))return next;}
  }
  throw Error('高墙上暂时没有足够位置放窗户');
 }
 if(asset.surface==='tabletop'){
  // Search in each support's own frame. A turned cabinet must receive its TV
  // facing the same way, rather than trying only the world's zero-degree pose.
  const offsets=limit=>{if(limit<-.001)return [];const values=[0];for(let n=.12;n<limit;n+=.12)values.push(n,-n);if(limit>.001)values.push(limit,-limit);return values;};
  for(const parent of room.items){if(parent.stored)continue;
   const angle=parent.rotation*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle);
   for(const surface of supportSurfaces(catalog.find(a=>a.id===parent.assetId))){
    for(const turn of [0,90,180,270]){
     const rotation=(parent.rotation+turn)%360,t=rotation*Math.PI/180,foot=asset.contact??{width:asset.size[0],depth:asset.size[2]},ac=foot.center??[0,0];
     const halfX=(surface.shape==='circle'?surface.radius:surface.width/2)-(turn%180?foot.depth:foot.width)/2,halfZ=(surface.shape==='circle'?surface.radius:surface.depth/2)-(turn%180?foot.width:foot.depth)/2;
     for(const z of offsets(halfZ))for(const x of offsets(halfX)){
      const px=x+(surface.center?.[0]??0),pz=z+(surface.center?.[1]??0);
      const test={...item,rotation,x:parent.x+c*px+s*pz-Math.cos(t)*ac[0]-Math.sin(t)*ac[1],z:parent.z-s*px+c*pz+Math.sin(t)*ac[0]-Math.cos(t)*ac[1],y:parent.y+surface.height,supportId:parent.id};
      if(!placementError(test,room,catalog))return test;
     }
    }
   }
  }
  throw Error('没有可用台面，先放一张桌台，或收纳桌上的物件');
 }
 if(['floor','rug'].includes(asset.surface))item.y=.15;
 if(['back','left'].includes(asset.surface))item.y=Math.min(item.y,4.9-asset.size[1]);
 if(!placementError(item,room,catalog))return item;
 const step=asset.building?STEP:.25;
 for(let z=-ROOM_HALF.z+.2;z<=ROOM_HALF.z-.2;z+=step)for(let x=-ROOM_HALF.x+.2;x<=ROOM_HALF.x-.2;x+=step){
  const test={...item,x:asset.surface==='left'?item.x:x,z:asset.surface==='back'?item.z:z};
  if(!placementError(test,room,catalog))return test;
 }
 throw Error('房间里暂时放不下，先收纳一些家具或扩建一间房');
}
