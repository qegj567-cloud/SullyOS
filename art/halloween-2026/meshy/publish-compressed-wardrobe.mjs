import fs from 'node:fs';import{createHash}from'node:crypto';
const base='art/halloween-2026/meshy',report=JSON.parse(fs.readFileSync(base+'/wardrobe-item-compression-report.json')),byId=new Map(report.items.map(r=>[r.id,r]));
for(const r of [...report.items,...report.textures]){const b=fs.readFileSync(base+'/wardrobe-compressed-items/'+r.file);if(b.length!==r.bytes)throw Error('Size mismatch: '+r.file);if(r.revision&&createHash('sha256').update(b).digest('hex').slice(0,12)!==r.revision)throw Error('Revision mismatch: '+r.file);}
for(const r of [...report.items,...report.textures])fs.copyFileSync(base+'/wardrobe-compressed-items/'+r.file,'public/room3d/wardrobe/'+r.file);
for(const file of ['apps/room3d/chibi/approvedWardrobe.json',base+'/published-wardrobe.json','art/chibi/halloween-wardrobe.json']){const defs=JSON.parse(fs.readFileSync(file));for(const d of defs){const r=byId.get(d.id);if(r){d.asset=r.file;d.revision=r.revision;}}fs.writeFileSync(file,JSON.stringify(defs,null,2));}
console.log({before:96047560,after:report.totalBytes,items:report.items.length,textures:report.textures.length});
const live=new Set(JSON.parse(fs.readFileSync('apps/room3d/chibi/approvedWardrobe.json')).map(d=>d.asset));
const source=JSON.parse(fs.readFileSync(base+'/wardrobe-source-manifest.json'));
for(const file of new Set(source.map(d=>d.asset)))if(/^halloween-(witch|count|apprentice|shorts|ghost|pumpkin)-[0-3]\.glb$/.test(file)&&!live.has(file)&&fs.existsSync(base+'/wardrobe-size-masters/'+file)&&fs.existsSync('public/room3d/wardrobe/'+file))fs.unlinkSync('public/room3d/wardrobe/'+file);
