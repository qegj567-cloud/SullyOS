import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {readGlb,packGlb} from './glb-utils.mjs';
const base='art/halloween-2026/meshy',dest='public/room3d/wardrobe';
// Fail before replacing production assets when the offline compressor is missing.
createRequire(new URL('../../../tmp/halloween-compress/package.json',import.meta.url)).resolve('@gltf-transform/core');
const python=process.env.HALLOWEEN_PYTHON||'python';
const pythonCheck=spawnSync(python,['-c','from PIL import Image'],{stdio:'inherit'});
if(pythonCheck.error||pythonCheck.status!==0)throw Error('Set HALLOWEEN_PYTHON to a Python executable with Pillow before publishing.');
const outfits={
 witch:{label:'南瓜女巫',parts:{dress:['onepiece','女巫连衣裙'],hat:['headwear','女巫帽'],boots:['shoes','女巫搭扣靴'],socks:['socks','女巫波浪口袜']}},
 count:{label:'蝙蝠伯爵',parts:{tailcoat:['outer','伯爵燕尾外套'],trousers:['bottom','伯爵长裤'],boots:['shoes','伯爵短靴'],waistcoat:['top','伯爵马甲'],cravat:['accessory','伯爵领巾']}},
 apprentice:{label:'药剂学徒',parts:{coat:['top','药剂师上衣'],apron:['accessory','药剂围裙'],shorts:['bottom','药剂师短裤'],cap:['headwear','药剂师软帽'],boots:['shoes','药剂师系带靴'],socks:['socks','药剂师条纹袜']}},
 shorts:{label:'糖果短裤',parts:{shorts:['bottom','万圣糖果短裤']}},
 ghost:{label:'幽灵装',parts:{'hooded-top':['top','幽灵连帽上衣'],shorts:['bottom','幽灵短裤'],shoes:['shoes','幽灵搭扣鞋'],socks:['socks','幽灵条纹袜']}},
 pumpkin:{label:'南瓜装',parts:{hat:['headwear','南瓜帽'],sleeves:['accessory','南瓜内搭袖'],romper:['onepiece','南瓜连体衣'],boots:['shoes','南瓜搭扣靴'],socks:['socks','南瓜条纹袜']}},
};
const entries=[],sets=[],regions={};
const themes=[['original','经典万圣节',null],['midnight','黑白午夜',['#16151d','#22212b','#80818c','#c5c7d1']],['crimson','绯红晚宴',['#711a30','#191720','#9a3448','#c69f61']],['moonlight','月光蓝银',['#3c648b','#202a48','#8dbdc6','#cadbe6']]];
for(const [outfit,def]of Object.entries(outfits)){
 const files=[`${base}/assembled/${outfit}-wearables.glb`];
 if(def.parts.socks)files.push(`${base}/fitted-socks/${outfit}-socks.glb`);
 if(outfit==='ghost')files.push(`${base}/assembled/ghost-shorts-wearables.glb`,`${base}/assembled/ghost-shoes-wearables.glb`);
 const found=new Map();
 for(const [fi,file]of files.entries()){
  const {json,bin}=await readGlb(file),asset=`halloween-${outfit}-${fi}.glb`;
  for(const node of json.nodes){if(node.mesh===undefined||node.skin===undefined)continue;const part=file.includes('fitted-socks')?'socks':node.extras?.part;if(!def.parts[part])throw Error('Unknown part '+file+' '+node.name+' '+part);const id=`halloween-${outfit}-${part}`,prefix=id+'__';node.name=prefix+node.name;found.set(part,{asset,prefix});}
  await fs.writeFile(`${dest}/${asset}`,packGlb(json,bin));
 }
 const wardrobe={};
 for(const [part,[slot,label]]of Object.entries(def.parts)){
  const id=`halloween-${outfit}-${part}`,ref=found.get(part);if(!ref)throw Error('Missing '+id);
  const bytes=await fs.readFile(`${dest}/${ref.asset}`),revision=createHash('sha256').update(bytes).digest('hex').slice(0,12);
  const entry={id,label,slot,...ref,revision,collection:'halloween',halloweenPart:part,halloweenOutfit:outfit,colorMode:'halloween',...(part==='sleeves'?{sleeveOnly:true}:{}),...(slot==='shoes'?{opening:part==='shoes'?.28:.595}:{}),...(slot==='outer'?{open:true}:{})};
  entries.push(entry);wardrobe[slot]=id;
  const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString()),targets=[...new Set(gltf.nodes.filter(n=>n.mesh!==undefined&&n.name.startsWith(ref.prefix)).flatMap(n=>gltf.meshes[n.mesh].primitives.map(p=>p.material)))].map(material=>({material}));
  regions[id]=['orange','purple','green','gold'].map((key,i)=>({id:key,label:['主色','副色','装饰色','金属色'][i],color:['#ee7916','#522478','#99bc27','#d9b448'][i],targets}));
 }
 if(outfit==='shorts')continue;
 for(const [theme,name,colors]of themes){const wardrobeColors={};if(colors)for(const id of Object.values(wardrobe))wardrobeColors[id]=Object.fromEntries(['orange','purple','green','gold'].map((key,i)=>[key,colors[i]]));sets.push({id:`halloween-${outfit}-${theme}`,label:def.label+' · '+name,collection:'halloween',items:wardrobe,clothes:{wardrobe,wardrobeColors,wardrobeFits:{},wardrobeLayering:false}});}
}
async function merge(path,fn){const data=JSON.parse(await fs.readFile(path,'utf8'));await fs.writeFile(path,JSON.stringify(fn(data),null,2)+'\n');}
await merge('apps/room3d/chibi/approvedWardrobe.json',old=>[...old.filter(g=>g.collection!=='halloween'),...entries]);
await merge('apps/room3d/chibi/wardrobeColorRegions.json',old=>({...old,...regions}));
await merge('apps/room3d/chibi/wardrobeLayering.json',old=>({...old,garments:{...old.garments,...Object.fromEntries(entries.map(g=>[g.id,g.slot==='bottom'?'wide-bottom':g.slot==='outer'?'generic-outer':['top','onepiece'].includes(g.slot)?'generic-top':'separate']))}}));
await fs.writeFile('apps/room3d/chibi/halloweenOutfits.json',JSON.stringify(sets,null,2)+'\n');
await fs.writeFile(`${base}/published-wardrobe.json`,JSON.stringify(entries,null,2)+'\n');
console.log(`Published ${entries.length} items, ${sets.length} outfits`);
await fs.writeFile(`${base}/wardrobe-source-manifest.json`,JSON.stringify(entries,null,2));
for(const [command,args] of [[python,[`${base}/compress-wardrobe-textures.py`,'--refresh-masters']],[process.execPath,[`${base}/compress-wardrobe-items.mjs`]],[process.execPath,[`${base}/publish-compressed-wardrobe.mjs`]]]){
 const result=spawnSync(command,args,{stdio:'inherit'});if(result.error||result.status!==0)throw Error('Halloween compression failed; do not release the uncompressed assets.');
}
