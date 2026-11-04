import fs from 'node:fs';import {createHash} from 'node:crypto';
const base='art/halloween-2026/meshy',report=JSON.parse(fs.readFileSync(base+'/furniture-report.json')),lantern=JSON.parse(fs.readFileSync(base+'/lantern-entry.json'));
for(const r of report)if(r.triangles>8000)throw Error(r.entry.id+' over budget');
lantern.revision=createHash('sha256').update(fs.readFileSync(base+'/pumpkin-lantern-colored.glb')).digest('hex').slice(0,12);
let entries=[...report.map(r=>r.entry),lantern];if(entries.length!==12)throw Error('Expected 12 furniture assets');
const textureReport=base+'/furniture-texture-report.json';
if(fs.existsSync(textureReport)){
 const textured=JSON.parse(fs.readFileSync(textureReport));if(textured.length!==12||new Set(textured.map(r=>r.entry.id)).size!==12||textured.some(r=>r.triangles>8000||!entries.some(e=>e.id===r.entry.id)))throw Error('Incomplete textured furniture release');
 if(textured.some(r=>r.compression!=='meshopt-lossless-webp90')||textured.find(r=>r.entry.id==='halloween_gothic_curtain_window')?.repair!=='overlap-removed-and-left-pane-clean-back-uv')throw Error('Run rebuild-furniture-runtime.mjs: compression and window repairs must precede publishing.');
 for(const r of textured){const bytes=fs.readFileSync(base+'/furniture-textured-runtime/'+r.entry.url);if(createHash('sha256').update(bytes).digest('hex').slice(0,12)!==r.entry.revision)throw Error('Texture revision mismatch');}
 for(const r of textured)fs.copyFileSync(base+'/furniture-textured-runtime/'+r.entry.url,'public/room3d/'+r.entry.url);
 entries=textured.map(r=>r.entry);
}else fs.copyFileSync(base+'/pumpkin-lantern-colored.glb','public/room3d/'+lantern.url);
const file='public/room3d/catalog.json',old=JSON.parse(fs.readFileSync(file));fs.writeFileSync(file,JSON.stringify([...old.filter(a=>!entries.some(e=>e.id===a.id)),...entries],null,2));fs.writeFileSync(base+'/furniture-catalog.json',JSON.stringify(entries,null,2));console.log('Published',entries.length);
