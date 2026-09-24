import fs from 'node:fs/promises';import {paletteRole} from '../../apps/room3d/roomPalettes.js';
const c=JSON.parse(await fs.readFile('public/room3d/catalog.json','utf8'));
for(const a of c){if(!a.url||!/^(show_|suite_|living_ref_|bedroom_ref_|study_ref_|bathroom_ref_|gaming_|bath_|kitchen_|kitchenware_|bedroom_)/.test(a.id))continue;
 const b=await fs.readFile('public/room3d/'+a.url),g=JSON.parse(b.subarray(20,20+b.readUInt32LE(12)));a.paletteMaterials=[];a.colorParts??=[];
 for(const m of g.materials||[]){const role=paletteRole(m.name,a.id);if(!role||/television/.test(a.id))continue;a.paletteMaterials.push(m.name);
  if(!a.colorParts.some(p=>p.material===m.name)){const rgb=m.pbrMetallicRoughness?.baseColorFactor||[1,1,1];const hex='#'+rgb.slice(0,3).map(v=>Math.round(255*(v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055)).toString(16).padStart(2,'0')).join('');a.colorParts.push({material:m.name,label:({body:'主体',accent:'主题色',soft:'柔和点缀',dark:'深色框架',light:'灯光细节',wood:'木质主体',woodDark:'木质边框',warmDetail:'绳柱与金属'})[role],color:hex});}
 }
}
await fs.writeFile('public/room3d/catalog.json',JSON.stringify(c,null,2)+'\n');console.log('Registered palette materials for',c.filter(a=>a.paletteMaterials?.length).length,'assets');
