import catalog from './approvedWardrobe.json';
export const wardrobeSlots={top:'上衣',bottom:'下装',onepiece:'连体',outer:'外套',socks:'袜子',shoes:'鞋子',accessory:'配饰',headwear:'头饰'} as const;
export type WardrobeSlot=keyof typeof wardrobeSlots;
export type ApprovedWardrobe=Partial<Record<WardrobeSlot,string>>;
export const approvedGarments=catalog as Array<{id:string;label:string;slot:WardrobeSlot;asset:string;prefix:string;revision?:string;open?:boolean;hem?:number;bootCover?:number;opening?:number;groundOffset?:number;sleeveless?:boolean;sleeveOnly?:boolean;morph?:string|null}>;
export function cleanApprovedWardrobe(value:unknown):ApprovedWardrobe{
 const result:ApprovedWardrobe={};if(!value||typeof value!=='object')return result;
 for(const slot of Object.keys(wardrobeSlots) as WardrobeSlot[]){const id=(value as ApprovedWardrobe)[slot];if(approvedGarments.some(g=>g.id===id&&g.slot===slot))result[slot]=id;}
 if(result.onepiece){delete result.top;delete result.bottom;}
 return result;
}
export const approvedPresets:Record<string,{label:string;items:ApprovedWardrobe}>={
 original:{label:'初始卫衣搭配',items:{top:'original-hoodie',socks:'original-socks',shoes:'original-shoes'}},
 sailor:{label:'长袖水手服',items:{top:'sailor-long',bottom:'sailor-shorts',socks:'school-socks',shoes:'school-loafers'}},
 summer:{label:'短袖水手服',items:{top:'sailor-short',bottom:'sailor-skirt',socks:'school-socks',shoes:'school-loafers'}},
 cardigan:{label:'开衫搭配',items:{outer:'slouch-cardigan',bottom:'lower-straight',shoes:'shoe-sneakers'}},
 school:{label:'学院搭配',items:{top:'collar-shirt',bottom:'lower-long-skirt',accessory:'necktie',shoes:'buckle-shoes'}},
};
