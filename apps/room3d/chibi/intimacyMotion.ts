import {poseSeatedHug} from './seatedHug';
import {posePrincessCarry} from './princessCarry';
import type {ChibiVisitor} from './visitor';
import type {contactSolver} from './socialContact';
import {poseHug} from './hugMotion';

type Resident={visitor:ChibiVisitor;solver:ReturnType<typeof contactSolver>};

export const isPrincessCarry=(id:string)=>id==='home-princess-carry'||id==='home-princess-carried';
export const isIntimacy=(id:string)=>id==='home-hug'||isPrincessCarry(id);
/** Pose only: called after idle reset; translations live under the navigation root. */
export function poseIntimacy(action:string,both:Resident[],time:number,seatedIndex?:number){
 const [a,b]=both.map(r=>r.visitor);
 if(!a.rig||!b.rig)return;
 if(action==='home-hug'){if(seatedIndex===0||seatedIndex===1)poseSeatedHug(both,time,seatedIndex);else poseHug(both,time);return;}
 posePrincessCarry(both,time);
}
