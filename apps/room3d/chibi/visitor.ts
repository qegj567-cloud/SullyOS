import * as THREE from 'three';
import {buildBody,loadBody} from './FbxBody';
import {BLANK_SCALE} from './blankBody';
import {dressHoodie} from './hoodieClothes';
import {dressApprovedWardrobe} from './approvedClothing';
import type {Parts,Motion,Posture,HairSettings,ActivityPose} from './types';
import type {RollResult} from './CreatorRollBridge';
export const NEW_BODY_HOME_PERCENT=172;

export async function decodeParts(result:RollResult):Promise<Parts>{
 const parts:Parts={};
 await Promise.all(Object.entries(result.layers).map(async([key,url])=>{const img=new Image();img.src=url;await img.decode();parts[key]=img;}));
 return parts;
}
export async function createVisitor(parts:Parts,hair?:HairSettings){
 const source=await loadBody();
 let body:ReturnType<typeof buildBody>;
 try{body=buildBody(source,parts,'outfit',hair);try{await body.setFaceSettings(hair?.face);}catch(e){body.resources.forEach(r=>r.dispose());throw e;}}
 finally{source.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});}
 let updateOutfitPose:(()=>void)|undefined;
 const root=new THREE.Group();root.name='little-world-chibi';root.add(body.root);
 if(body.rig){try{if(hair?.wardrobe!==undefined){const outfit=await dressApprovedWardrobe(body.rig,hair.wardrobe,hair.wardrobeFits,hair.wardrobeColors,hair.wardrobeLayering);body.resources.push(outfit);updateOutfitPose=outfit.updatePose;}else{const outfit=dressHoodie(body.rig);body.resources.push(...outfit.resources);}}catch(e){body.resources.forEach(r=>r.dispose());throw e;}}
 // Approved home size: 172% of the original 1.4-unit height baseline.
 // Scale the whole hierarchy so hair, clothing and the skeleton stay aligned.
 body.root.scale.setScalar(hair?.bodyShape==='blank'?1.4/BLANK_SCALE*(NEW_BODY_HOME_PERCENT/100):.7);
 // Keep the painted features legible under the room's brighter directional light.
 body.root.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=false;o.receiveShadow=false;for(const m of Array.isArray(o.material)?o.material:[o.material])if(m instanceof THREE.MeshStandardMaterial){m.emissive.set('#ffffff');m.emissiveIntensity=.04;}}});
 let disposed=false;
 // The body keeps its original contact plane; action feet hang independently.
 return {root,rig:body.rig,seatOffset:0,animate(time:number,motion:Motion,posture:Posture='standing',activity?:ActivityPose){body.animate(time,motion,posture,activity);updateOutfitPose?.();},dispose(){if(disposed)return;disposed=true;root.removeFromParent();for(const resource of body.resources)resource.dispose();}};
}
export type ChibiVisitor=Awaited<ReturnType<typeof createVisitor>>;
