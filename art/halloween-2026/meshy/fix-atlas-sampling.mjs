import fs from 'node:fs/promises';
import {readGlb,packGlb} from './glb-utils.mjs';
const dir='art/halloween-2026/meshy/assembled';
// Meshy atlases have insufficient padding for a full mip chain. Sampling
// base level avoids neighboring islands bleeding into dark cloth at distance.
for(const name of (await fs.readdir(dir)).filter(n=>n.endsWith('-wearables.glb'))){const file=dir+'/'+name,{json,bin}=await readGlb(file);for(const s of json.samplers||[])s.minFilter=9729;await fs.writeFile(file,packGlb(json,bin));console.log(name);}
