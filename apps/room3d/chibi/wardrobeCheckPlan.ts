import {approvedGarments,type ApprovedWardrobe,type WardrobeSlot} from './approvedWardrobe';
import {garmentLayeringAssignments,layeringProfiles,layeringForGarment} from './wardrobeLayering';

type Garment={id:string;slot:WardrobeSlot};
export function validateLayeringCatalog(catalog:Garment[]=approvedGarments){
 const errors:string[]=[];
 const allowed:Record<string,unknown[]>={inner:['generic','loose-shirt','sailor','surface-shell'],outer:['generic','posed'],skin:['standard','whole-surface'],preserveSkirtOutline:[true,false],lower:['narrow','wide','long-skirt']};
 for(const [name,profile] of Object.entries(layeringProfiles))for(const [key,value] of Object.entries(profile)){
  if(!allowed[key]?.includes(value))errors.push(`${name}: 无效配置 ${key}=${String(value)}`);
 }
 for(const g of catalog){
  const profile=layeringProfiles[garmentLayeringAssignments[g.id]];
  if(!profile){errors.push(`${g.id}: 缺少有效叠穿配置`);continue;}
  if(['top','onepiece'].includes(g.slot)&&!profile.inner)errors.push(`${g.id}: 缺少内搭结构`);
  if(g.slot==='outer'&&!profile.outer)errors.push(`${g.id}: 缺少外套结构`);
  if(g.slot==='bottom'&&!profile.lower)errors.push(`${g.id}: 缺少下装结构`);
  if(profile.inner&&!['top','onepiece'].includes(g.slot))errors.push(`${g.id}: 内搭配置与槽位不符`);
  if(profile.outer&&g.slot!=='outer')errors.push(`${g.id}: 外套配置与槽位不符`);
  if(profile.lower&&g.slot!=='bottom')errors.push(`${g.id}: 下装配置与槽位不符`);
  if(profile.preserveSkirtOutline&&profile.lower!=='long-skirt')errors.push(`${g.id}: 裙边保护与结构不符`);
 }
 return errors;
}

/** Incremental acceptance matrix. Partners come from the catalog so adding an
 * outer automatically includes it in subsequent inner-garment checks. */
export function planWardrobeChecks(ids:string[],catalog:Garment[]=approvedGarments):ApprovedWardrobe[]{
 const errors=validateLayeringCatalog(catalog);if(errors.length)throw Error(errors.join('\n'));
 for(const id of ids)if(!catalog.some(g=>g.id===id))throw Error(`未知服装：${id}`);
 const inSlot=(slot:WardrobeSlot)=>catalog.filter(g=>g.slot===slot);
 const representatives=(slot:WardrobeSlot,key:(id:string)=>string|undefined)=>{
  const seen=new Set<string>();return inSlot(slot).filter(g=>{const k=key(g.id)??'generic';if(seen.has(k))return false;seen.add(k);return true;});
 };
 const tops=representatives('top',id=>layeringForGarment(id).inner);
 const bottoms=representatives('bottom',id=>layeringForGarment(id).lower);
 const outfits=new Map<string,ApprovedWardrobe>();
 const add=(w:ApprovedWardrobe)=>{const sorted=Object.fromEntries(Object.entries(w).sort());outfits.set(JSON.stringify(sorted),sorted);};
 for(const g of catalog.filter(g=>ids.includes(g.id))){
  add({[g.slot]:g.id}); // Also catch broken assets without masking hiding them.
  if(g.slot==='top'){
   for(const outer of inSlot('outer')){
    add({top:g.id,outer:outer.id});
    // A waistband adjustment can reintroduce a waist/coat collision, so include
    // the lowerwear context instead of checking independent pairs only.
    for(const bottom of bottoms)add({top:g.id,outer:outer.id,bottom:bottom.id});
   }
   for(const bottom of bottoms)add({top:g.id,bottom:bottom.id});
  }else if(g.slot==='outer'){
   for(const top of tops){add({outer:g.id,top:top.id});for(const bottom of bottoms)add({outer:g.id,top:top.id,bottom:bottom.id});}
   for(const onepiece of inSlot('onepiece'))add({outer:g.id,onepiece:onepiece.id});
  }else if(g.slot==='bottom'){
   for(const top of tops)add({bottom:g.id,top:top.id});
   for(const outer of inSlot('outer'))add({bottom:g.id,outer:outer.id,top:tops[0]?.id});
   for(const shoes of inSlot('shoes'))add({bottom:g.id,shoes:shoes.id});
  }else if(g.slot==='onepiece'){
   for(const outer of inSlot('outer'))add({onepiece:g.id,outer:outer.id});
  }else if(g.slot==='shoes'){
   for(const socks of inSlot('socks'))add({shoes:g.id,socks:socks.id});
   for(const bottom of inSlot('bottom'))add({shoes:g.id,bottom:bottom.id});
  }else if(g.slot==='socks'){
   for(const shoes of inSlot('shoes'))add({socks:g.id,shoes:shoes.id});
  }else if(g.slot==='accessory'){
   for(const top of tops)add({accessory:g.id,top:top.id});
   for(const outer of inSlot('outer'))add({accessory:g.id,outer:outer.id});
  }
 }
 return [...outfits.values()];
}
