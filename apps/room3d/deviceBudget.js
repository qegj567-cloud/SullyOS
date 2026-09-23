import {ROOM_HALF,ROOM_STEP} from './dimensions.js';
export const PHONE_BUDGET={rooms:5,furniture:20};
export function isPhoneBrowser({userAgent='',mobile=false,coarse=false,width=Infinity,height=Infinity}={}){
 return mobile||/iPhone|iPod|Android.*Mobile/i.test(userAgent)||coarse&&Math.min(width,height)<=600;
}
// Count physical instances in each original floor tile, not merged enclosures
// or support-group ownership. Storing an item releases its display allowance.
export function furnishingCounts(home,catalog){
 const structural=new Set(catalog.filter(a=>a.building).map(a=>a.id)),counts=new Map(home.rooms.map(r=>[r.id,0]));
 for(const owner of home.rooms)for(const item of owner.items){
  if(item.stored||structural.has(item.assetId))continue;
  const x=owner.x*ROOM_STEP.x+item.x,z=owner.z*ROOM_STEP.z+item.z;
  const fits=r=>r.level===owner.level&&Math.abs(x-r.x*ROOM_STEP.x)<=ROOM_HALF.x+.001&&Math.abs(z-r.z*ROOM_STEP.z)<=ROOM_HALF.z+.001;
  const tile=fits(owner)?owner:home.rooms.find(fits)||owner;
  counts.set(tile.id,counts.get(tile.id)+1);
 }
 return counts;
}
export function phoneBudgetError(before,after,catalog){
 if(after.rooms.length>Math.max(PHONE_BUDGET.rooms,before?.rooms.length||0))return '手机端每个角色最多 5 块房间面积；拆墙合并也按原面积计数';
 const old=before?furnishingCounts(before,catalog):new Map(),next=furnishingCounts(after,catalog);
 for(const r of after.rooms)if(next.get(r.id)>Math.max(PHONE_BUDGET.furniture,old.get(r.id)||0))return `「${r.name}」这块房间面积最多摆 ${PHONE_BUDGET.furniture} 件家具，先收纳或移到其他区域；桌面摆件分别计数`;
 return '';
}
