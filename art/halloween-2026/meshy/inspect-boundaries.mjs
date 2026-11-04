import {loadTextured} from './textured-geometry.mjs';
import {boundaryLoops} from './boundary-loops.mjs';
const s=await loadTextured('art/halloween-2026/meshy/assembled/ghost-wearables.glb');console.log(boundaryLoops(s.geo).map(({vertices,...report})=>report));
