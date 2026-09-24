import fs from 'node:fs';
import {Color} from 'three';

// Stable region IDs are saved in outfits. Material indices refer to the shipped
// GLBs, never to traversal order or Three's generated material names.
const labels = {
 'original-hoodie':['卫衣'], 'original-socks':['袜子'], 'original-shoes':['鞋面'],
 'slouch-cardigan':['衣身与罗纹','纽扣'],
 'sailor-skirt':['裙身','内衬'], 'school-socks':['袜子'], 'school-loafers':['鞋面'],
 'lower-long-skirt':['裙身'], 'lower-straight':['裤身'], 'lower-cargo':['裤身'], 'lower-cropped':['裤身'], 'lower-shorts':['裤身'],
 'shoe-geta':['木底','鞋带'], 'shoe-boots':['鞋身','鞋口'], 'shoe-sneakers':['鞋身','拼色'],
 'lace-midboots':['鞋身','鞋带','鞋孔'], 'buckle-shoes':['鞋身','搭扣'], 'tall-boots':['鞋身'],
 'collar-shirt':['衣身','袖口','门襟','领片','纽扣'],
 'ruffle-apron':['围裙','系带'], 'bow-headband':['荷叶边','蝴蝶结与缎带'],
 'school-blazer':['衣身','口袋','驳领','纽扣'], 'stand-collar':['衣身','纽扣','口袋'],
 'necktie':['领带'], 'bow-tie':['领结'], 'fitted-camisole':['衣身'], 'fitted-turtleneck':['衣身'], 'fitted-sweater':['衣身'],
 'school-swimsuit':['泳衣'], 'basic-tee':['衣身','领边'], 'swim-shorts':['裤身'], 'maid-sleeves':['袖身与荷叶边','系带'],
 'qipao':['衣身','袖边','领口','滚边','盘扣'],
};
const region=(id,label,color,targets)=>({id,label,color,targets});
const target=(material,source)=>({material,...(source?{source}:{})});
const painted=(material)=>[
 region('navy','深色布料','#353d50',[target(material,'#353d50')]),
 region('ivory','浅色布料与条纹','#e8eae5',[target(material,'#e8eae5')]),
];
const special={
 'sailor-long':painted(1), 'sailor-shorts':painted(1),
 'sailor-short':[
  region('navy','领口与深色布料','#353d50',[target(5,'#353d50'),target(7)]),
  region('ivory','衣身与浅色条纹','#e8eae5',[target(5,'#e8eae5'),target(6),target(8)]),
 ],
 'belt-coat':[
  region('body','衣身','#171e2b',[target(1,'#171e2b')]),
  region('lapel','翻领','#171e2b',[target(1,'#171e2b')]),
  region('belt','腰带','#0d1015',[target(2,'#0d1015'),target(4)]),
  region('metal','金属扣与细边','#bda05f',[target(2,'#bda05f'),target(3)]),
 ],
 'hood-parka':[
  region('body','衣身','#343539',[target(1,'#343539')]),
  region('lining','帽内','#656366',[target(1,'#656366')]),
  region('cuff','袖口拼色','#79767a',[target(1,'#79767a')]),
  region('trim','抽绳与饰边','#89868a',[target(2,'#89868a')]),
  region('patch','肩部饰片','#292a2d',[target(2,'#292a2d')]),
  region('pocket','口袋','#3b3c40',[target(2,'#3b3c40')]),
  region('metal','按扣','#bfc1c5',[target(3)]),
 ],
};
const catalog=JSON.parse(fs.readFileSync('apps/room3d/chibi/approvedWardrobe.json','utf8'));
const output={};
for(const garment of catalog){
 const bytes=fs.readFileSync(`public/room3d/wardrobe/${garment.asset}`);
 const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
 const materials=[...new Set(gltf.nodes.filter(n=>n.mesh!==undefined&&n.name.startsWith(garment.prefix)).flatMap(n=>gltf.meshes[n.mesh].primitives.map(p=>p.material)))];
 if(special[garment.id]){output[garment.id]=special[garment.id];continue;}
 if(labels[garment.id]?.length!==materials.length)throw Error(`Color regions need review: ${garment.id}`);
 output[garment.id]=materials.map((index,i)=>{
  const rgb=gltf.materials[index].pbrMetallicRoughness?.baseColorFactor??[1,1,1];
  return region(`material-${index}`,labels[garment.id][i],`#${new Color().fromArray(rgb).getHexString()}`,[target(index)]);
 });
}
fs.writeFileSync('apps/room3d/chibi/wardrobeColorRegions.json',`{\n${Object.entries(output).map(([id,regions])=>`  ${JSON.stringify(id)}: ${JSON.stringify(regions)}`).join(',\n')}\n}\n`);
console.log(`Published color regions for ${catalog.length} garments.`);
