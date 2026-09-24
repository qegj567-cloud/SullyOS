import {clearance,gamingPoint} from './gaming.js';

// Reviewed mirror faces, in furniture-local coordinates. This registry also
// survives asset re-export; neither names nor storage categories grant actions.
const MIRRORS={
 suite_floor_mirror:{x:0,front:.10},
 suite_dressing_mirror:{x:0,front:.02},
 bedroom_ref_dresser_top:{x:-.84,front:-.075},
 bedroom_mirror:{x:0,front:.03},
 bedroom_vanity:{x:0,front:0},
};
const WARDROBES=new Set(['show_wardrobe','bedroom_wardrobe','bedroom_ref_wardrobe']);
export const isMirror=a=>!!MIRRORS[a?.id];
export const isWardrobe=a=>WARDROBES.has(a?.id);
export const isMirrorAction=kind=>kind==='mirror-admire'||kind==='mirror-outfit';
export function mirrorActivities(room,catalog,{headWidth=1.5}={}){
 const results=[],asset=id=>catalog.find(a=>a.id===id),owner=i=>i.ownerRoomId||room.id;
 for(const item of room.items){
  const a=asset(item.assetId),spec=MIRRORS[a?.id];if(item.stored||!spec)continue;
  const parent=item.supportId&&room.items.find(i=>i.id===item.supportId&&!i.stored);
  // A floating/stored desktop mirror is never usable.
  if(a.surface==='tabletop'&&!parent)continue;
  const normal=item.rotation*Math.PI/180,rotation=normal+Math.PI;
  const front=Math.max(spec.front,parent?asset(parent.assetId).size[2]/2:0);
  let pose=null;
  for(const distance of [.90,1.10,1.30,1.50])for(const shift of [0,-.24,.24]){
   const p=gamingPoint(item,[spec.x+shift,0,front+distance]),candidate={position:[p[0],.18,p[2]],rotation};
   if(!pose&&!clearance(room,catalog,candidate,[],headWidth+.12))pose=candidate;
  }
  const fallback=gamingPoint(item,[spec.x,0,front+1.1]);
  const base={itemId:item.id,roomId:owner(item),seat:null,...pose||{position:[fallback[0],.18,fallback[2]],rotation},hands:[[-.39,.52,.12],[.39,.52,.12]],reason:pose?'':'镜子前太挤啦，留一点站立和转身的空间'};
  const dependencies=parent?[parent.id]:[];
  results.push({...base,kind:'mirror-admire',label:'臭美',dependencies});
  const wardrobe=room.items.find(i=>!i.stored&&owner(i)===owner(item)&&isWardrobe(asset(i.assetId)));
  if(wardrobe){
   const depth=asset(wardrobe.assetId).size[2]/2;let wardrobePose=null;
   for(const distance of [.8,1,1.3,1.6,2])for(const shift of [0,-.45,.45,-.9,.9]){
    const p=gamingPoint(wardrobe,[shift,0,depth+distance]),candidate={position:[p[0],.18,p[2]],rotation:wardrobe.rotation*Math.PI/180+Math.PI};
    if(!wardrobePose&&!clearance(room,catalog,candidate,[],headWidth+.12))wardrobePose=candidate;
   }
   results.push({...base,kind:'mirror-outfit',label:'穿搭',wardrobeId:wardrobe.id,wardrobePose,reason:base.reason||(!wardrobePose?'衣柜前没有安全的落脚位置，请留一点空间':''),dependencies:[...dependencies,wardrobe.id]});
  }
 }
 return results;
}
