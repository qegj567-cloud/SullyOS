import {readGlb} from './glb-utils.mjs';
for(const f of ['collar-shirt-rig','stand-collar-rig']){const {json}=await readGlb('public/room3d/wardrobe/'+f+'.glb');console.log(f,json.nodes.map(n=>n.name),json.meshes.map(m=>({name:m.name,materials:m.primitives.map(p=>json.materials[p.material]?.name)})));}
