import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,posix} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function createHomeResourceManifest(){
 const furniture=JSON.parse(readFileSync(resolve(root,'public/room3d/catalog.json'),'utf8')).filter(a=>a.id.startsWith('halloween_'));
 const wardrobe=JSON.parse(readFileSync(resolve(root,'apps/room3d/chibi/approvedWardrobe.json'),'utf8')).filter(a=>a.collection==='halloween');
 return [
  {id:'halloween-furniture',name:'万圣节家具包',description:'12 件家具与预览图',paths:furniture.flatMap(a=>[`room3d/${a.url}`,`room3d/thumbnails/${a.id}.png`])},
  {id:'halloween-wardrobe',name:'万圣节服装包',description:'25 件服装、共用贴图与预览图',paths:wardrobe.flatMap(a=>[`room3d/wardrobe/${a.asset}`,`room3d/wardrobe/thumbnails/${a.id}.png`])},
 ].map(({paths,...pack})=>{
  const entries=new Map();
  function visit(path){
   if(entries.has(path))return;
   if(!path.startsWith('room3d/')||path.includes('..'))throw Error('Invalid pack path: '+path);
   const bytes=readFileSync(resolve(root,'public',path));
   const dependencies=[];
   if(path.endsWith('.glb')){
    const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString('utf8'));
    for(const item of [...gltf.images??[],...gltf.buffers??[]])if(item.uri&&!item.uri.startsWith('data:')){
     if(/^[a-z]+:|^\//i.test(item.uri))throw Error('External dependency: '+item.uri);
     dependencies.push(posix.join(posix.dirname(path),item.uri));
    }
   }
   entries.set(path,{path,bytes:bytes.length,sha256:hash(bytes),dependencies:[...new Set(dependencies)]});
   dependencies.forEach(visit);
  }
  paths.forEach(visit);
  const files=[...entries.values()].sort((a,b)=>a.path.localeCompare(b.path));
  return {...pack,revision:hash(JSON.stringify(files)),bytes:files.reduce((n,f)=>n+f.bytes,0),files};
 });
}
export function writeHomeResourceManifest(){
 const path=resolve(root,'apps/room3d/resourcePacks.generated.json');
 const content=JSON.stringify(createHomeResourceManifest(),null,2)+'\n';
 if(!existsSync(path)||readFileSync(path,'utf8')!==content)writeFileSync(path,content);
}
export function homeResourcePacksPlugin(){
 return {name:'home-resource-packs',buildStart(){writeHomeResourceManifest();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))writeHomeResourceManifest();
