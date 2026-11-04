import {readGlb,packGlb,stripImages} from './glb-utils.mjs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import * as T from 'three';
const {json,bin}=await readGlb('public/room3d/wardrobe/sailor-girl.glb');
const b=packGlb(stripImages(json),bin),root=(await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene;root.updateMatrixWorld(true);
root.traverse(o=>{if(o.name.startsWith('Sailor_socks'))console.log({name:o.name,bounds:new T.Box3().setFromObject(o),matrix:o.matrixWorld.elements,triangles:o.geometry.index.count/3,bones:o.skeleton.bones.length});});
