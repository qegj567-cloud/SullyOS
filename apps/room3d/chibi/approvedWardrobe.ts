import catalog from './approvedWardrobe.json';
import builtinOutfits from './builtinOutfits.json';
import halloweenOutfits from './halloweenOutfits.json';
import type {SavedOutfit} from './outfitLibrary';
export const wardrobeSlots={top:'上衣',bottom:'下装',onepiece:'连体',outer:'外套',socks:'袜子',shoes:'鞋子',accessory:'配饰',headwear:'头饰',ears:'兽耳',tail:'尾巴'} as const;
export type WardrobeSlot=keyof typeof wardrobeSlots;
export type ApprovedWardrobe=Partial<Record<WardrobeSlot,string>>;
export const approvedGarments=catalog as Array<{id:string;label:string;slot:WardrobeSlot;asset:string;prefix:string;collection?:string;halloweenPart?:string;halloweenOutfit?:string;colorMode?:string;revision?:string;open?:boolean;hem?:number;bootCover?:number;opening?:number;groundOffset?:number;sleeveless?:boolean;sleeveOnly?:boolean;morph?:string|null}>;
export function cleanApprovedWardrobe(value:unknown):ApprovedWardrobe{
 const result:ApprovedWardrobe={};if(!value||typeof value!=='object')return result;
 for(const slot of Object.keys(wardrobeSlots) as WardrobeSlot[]){const id=(value as ApprovedWardrobe)[slot];if(approvedGarments.some(g=>g.id===id&&g.slot===slot))result[slot]=id;}
 if(result.onepiece){delete result.top;delete result.bottom;}
 return result;
}
export const approvedPresets:Record<string,{label:string;items:ApprovedWardrobe;clothes?:SavedOutfit['clothes'];collection?:string}>={
 ...Object.fromEntries(halloweenOutfits.map(p=>[p.id,{...p,items:p.items as ApprovedWardrobe,clothes:p.clothes as SavedOutfit['clothes']}])),
 original:{label:'初始卫衣搭配',items:{top:'original-hoodie',socks:'original-socks',shoes:'original-shoes'}},
 sailor:{label:'长袖水手服',items:{top:'sailor-long',bottom:'sailor-shorts',socks:'school-socks',shoes:'school-loafers'}},
 summer:{label:'短袖水手服',items:{top:'sailor-short',bottom:'sailor-skirt',socks:'school-socks',shoes:'school-loafers'}},
 ...Object.fromEntries(builtinOutfits.map((outfit,index)=>[`curated-${index+1}`,{label:outfit.name,items:outfit.clothes.wardrobe as ApprovedWardrobe,clothes:outfit.clothes as SavedOutfit['clothes']} ])),
};
