import {createHalloweenColorController} from '/apps/room3d/chibi/halloweenColors.ts';
import {halloweenPalette} from '/apps/room3d/chibi/halloweenPalettes.ts';

export const colorPresets=[
 {id:'original',name:'经典万圣节',colors:null},
 {id:'midnight',name:'午夜黑白',colors:['#16151d','#22212b','#80818c','#c5c7d1']},
 {id:'crimson',name:'绯红晚宴',colors:['#711a30','#191720','#9a3448','#c69f61']},
 {id:'moonlight',name:'月光蓝银',colors:['#3c648b','#202a48','#8dbdc6','#cadbe6']},
];
const names={witch:['南瓜女巫','黑白学院','绯红魔女','月夜女巫'],count:['万圣伯爵','黑银伯爵','血色伯爵','蓝夜伯爵'],apprentice:['南瓜药剂','夜班药剂','玫瑰药剂','冰霜药剂'],shorts:['糖果派对','黑灰蝙蝠','莓果糖','蓝莓糖'],ghost:['南瓜幽灵','黑白幽灵','玫瑰幽灵','冰蓝幽灵'],pumpkin:['经典南瓜','墨色南瓜','红丝绒南瓜','月光南瓜']};
export function presetsFor(outfit){return colorPresets.map((p,i)=>({...p,name:names[outfit]?.[i]||p.name}));}

// Recolor clothing only, after the original atlas and material color have been
// sampled. Original shadows, embroidery and neutral white/black are retained.
export function installPresets(parts,outfit){
 const controllers=[];
 for(const meshes of parts.values())for(const mesh of meshes){mesh.material=mesh.material.clone();controllers.push(createHalloweenColorController(mesh.material,outfit==='shorts'));}
 return id=>{const p=colorPresets.find(p=>p.id===id)||colorPresets[0];for(const update of controllers)update(halloweenPalette(outfit,p.id));return p.id;};
}
