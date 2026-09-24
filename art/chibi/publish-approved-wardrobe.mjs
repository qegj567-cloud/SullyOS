import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const root='output/cardigan-controller',dest='public/room3d/wardrobe';fs.mkdirSync(dest,{recursive:true});const items=[];const copied=new Set();
function add(id,label,slot,file,prefix,extra={}){let asset=path.basename(file);if(!copied.has(file)){fs.copyFileSync(path.join(root,file),path.join(dest,asset));copied.add(file);}const revision=createHash('sha256').update(fs.readFileSync(path.join(dest,asset))).digest('hex').slice(0,12);items.push({id,label,slot,asset,prefix,...extra,revision});}
add('slouch-cardigan','半落肩开衫','outer','cardigan-rig-detail.glb','Little_Cardigan',{open:true});
for(const [id,label,slot,prefix]of [['sailor-long','长袖水手服','top','Sailor_top'],['sailor-shorts','水手短裤','bottom','Sailor_pants']])add(id,label,slot,'sailor-school-user.glb',prefix,{hem:1.83});
for(const [id,label,slot,prefix]of [['sailor-short','短袖水手服','top','Sailor_top'],['sailor-skirt','水手百褶裙','bottom','Sailor_skirt'],['school-socks','贴身长袜','socks','Sailor_socks'],['school-loafers','圆头乐福鞋','shoes','Sailor_shoes']])add(id,label,slot,'sailor-girl.glb',prefix,{hem:1.82,opening:slot==='socks'?.96:.32});
for(const m of JSON.parse(fs.readFileSync(root+'/lowerwear/manifest.json')))add('lower-'+m.id,m.label,'bottom','lowerwear/'+m.id+'-rig.glb','Lowerwear_',{hem:m.hem,bootCover:m.bootCover,triangles:m.triangles,drawCalls:m.drawCalls});
for(const m of JSON.parse(fs.readFileSync(root+'/shoes/manifest.json')))add((m.id==='shorts'?'lower-':'shoe-')+m.id,m.label,m.id==='shorts'?'bottom':'shoes','shoes/'+m.id+'-rig.glb',m.id==='shorts'?'Lowerwear_':'Footwear_',m);
for(const m of JSON.parse(fs.readFileSync(root+'/clothing-0920b/manifest.json'))){const slot=m.opening!==undefined?'shoes':m.head?'headwear':m.accessory?'accessory':['belt-coat','hood-parka','school-blazer'].includes(m.id)?'outer':m.id==='ruffle-apron'?'accessory':'top';add(m.id,m.label,slot,'clothing-0920b/'+m.id+'-rig.glb',slot==='shoes'?'Footwear_':'Apparel_',m);}
for(const file of ['manifest.json','manifest-tailored.json','manifest-sleeves.json','manifest-qipao.json']){const full=path.join(root,'procedural-basics',file);if(fs.existsSync(full))for(const m of JSON.parse(fs.readFileSync(full)))add(m.id,m.label,m.slot,`procedural-basics/${m.id}-rig.glb`,m.prefix??'Apparel_',m);}
// Keep our stable prefixed IDs rather than source manifest IDs.
for(const i of items){if(['geta','boots','sneakers'].includes(i.id))i.id='shoe-'+i.id;if(i.id==='shorts')i.id='lower-shorts';}
// The initial outfit is exported from prepareHoodie by publish-original-wardrobe.mjs.
if(fs.existsSync('art/chibi/original-wardrobe.json'))for(const entry of JSON.parse(fs.readFileSync('art/chibi/original-wardrobe.json','utf8'))){const bytes=fs.readFileSync(path.join(dest,entry.asset));items.push({...entry,revision:createHash('sha256').update(bytes).digest('hex').slice(0,12)});}
// New assets must explicitly choose a construction profile; never silently
// inherit a guess from an ID prefix. The acceptance command checks slot/schema.
const layering=JSON.parse(fs.readFileSync('apps/room3d/chibi/wardrobeLayering.json','utf8'));
for(const item of items)if(!layering.profiles[layering.garments[item.id]])throw Error(`${item.id}: 请先在 wardrobeLayering.json 登记叠穿结构，再运行 pnpm wardrobe:check ${item.id}`);
fs.writeFileSync('apps/room3d/chibi/approvedWardrobe.json',JSON.stringify(items,null,2));console.log('Published',items.length,'pieces from',copied.size,'rig assets');
