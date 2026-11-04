import{spawnSync}from'node:child_process';import{createRequire}from'node:module';
const base='art/halloween-2026/meshy',python=process.env.HALLOWEEN_PYTHON||'python';
createRequire(new URL('../../../tmp/halloween-compress/package.json',import.meta.url)).resolve('@gltf-transform/core');
const stages=[[python,['-c','from PIL import Image']],[python,[base+'/prepare-furniture-textures.py']],...[['repair-window-overlap.mjs','--publish'],['repair-window-glass-uv.mjs'],['compress-furniture.mjs'],['publish-furniture.mjs']].map(args=>[process.execPath,[base+'/'+args[0],...args.slice(1)]])];
for(const[command,args]of stages){const result=spawnSync(command,args,{stdio:'inherit'});if(result.error||result.status!==0)throw Error('Furniture rebuild failed at '+args.join(' '));}
