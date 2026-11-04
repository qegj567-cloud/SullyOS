import {MathUtils} from 'three';
import {seatChangeDuration} from './chibi/roomMotionFrame.ts';
import {meshyMotions} from './chibi/meshyMotions.ts';

export function body2BedTransform(seat,headToHip,hipHeight=0){
 if(!seat?.bed)return seat;
 const forward=seat.bed.headEnd+headToHip-seat.bed.anchorZ;
 const root=meshyMotions.sleep.root;
 const sleepStart=[0,(root[1]-root.at(-2))*hipHeight,(root[2]-root.at(-1))*hipHeight];
 return {...seat,pose:'bed',sleepStart,position:[seat.position[0]+Math.sin(seat.rotation)*forward,seat.position[1],seat.position[2]+Math.cos(seat.rotation)*forward]};
}
/** Convert the reviewed mattress profile into the unscaled motion-body frame. */
export function bedFootSurface(seat,scale=1){
 if(!seat?.bed?.footSurface||!(scale>0))return undefined;
 const b=seat.bed,along=Math.sin(seat.rotation)*(seat.position[0]-b.center[0])+Math.cos(seat.rotation)*(seat.position[2]-b.center[2]);
 return b.footSurface.map(([z,y])=>[(z-along)/scale,(b.center[1]+y-seat.position[1])/scale]);
}
export function bedEntry(seat,map,offset=[0,0]){
 const spec=seat.bed;if(!spec)return null;
 const c=Math.cos(spec.itemRotation),s=Math.sin(spec.itemRotation);
 // Align along the bed with the imported clip's first seated pelvis, not its
 // final lying anchor. This removes the long sideways slide after sitting.
 const dz=seat.position?Math.sin(spec.itemRotation)*(seat.position[0]-spec.center[0])+Math.cos(spec.itemRotation)*(seat.position[2]-spec.center[2])+(seat.sleepStart?.[2]??0):.7;
 // Do not enter from the opposite side and slide a seated resident across the
 // whole mattress to the selected sleeping slot.
 for(const side of [spec.side])for(const z of [dz,.7,1.1,-.2].filter(z=>Math.abs(z-dz)<=.45))for(const gap of [.55,.8,1.05]){
  const x=side*(spec.halfWidth+gap),p=[spec.center[0]+c*x+s*z,.18,spec.center[2]-s*x+c*z];
  if(map.free(p[0]+offset[0],p[2]+offset[1]))return p;
 }
 return null;
}
export function bedChangeFrame(time,rising=false){
 const duration=seatChangeDuration('bed'),t=MathUtils.clamp(time/duration,0,1),seconds=(rising?1-t:t)*duration,step=(a,b)=>MathUtils.smootherstep(seconds,a,b);
 // Turn and take a short backward step while standing, then load the edge.
 // Raise the legs before a single supported turn into the source's first pose.
 const stepping=(rising?-1:1)*step(.1,.35)*(1-step(1.05,1.25));
 return {weight:step(1.25,2.1),edgeTravel:step(.45,1.25),legLift:step(2.15,2.65),inboard:step(2.7,3.65),turn:step(0,.45),clipBlend:step(2.7,3.792),stepping,recline:MathUtils.clamp((seconds-3.792)/meshyMotions.sleep.duration,0,1),lean:0,done:t>=1};
}
export function bedEdge(seat,front){
 const b=seat.bed,c=Math.cos(b.itemRotation),s=Math.sin(b.itemRotation),dx=front[0]-b.center[0],dz=front[2]-b.center[2];
 const side=Math.sign(c*dx-s*dz),x=side*(b.edgeX??b.halfWidth-.18),z=s*dx+c*dz;
 return {position:[b.center[0]+c*x+s*z,b.edgeY===undefined?seat.position[1]:b.center[1]+b.edgeY,b.center[2]-s*x+c*z],rotation:b.itemRotation+side*Math.PI/2};
}
export function bedChangePose(change,time){
 const f=bedChangeFrame(time,change.rising),mix=MathUtils.lerp;
 const offset=change.sleepStart??[0,0,0],sin=Math.sin(change.rotation),cos=Math.cos(change.rotation);
 const clipStart=[change.seat[0]+sin*offset[2],change.seat[1]+offset[1],change.seat[2]+cos*offset[2]];
 const distance=Math.hypot(change.front[0]-change.edge.position[0],change.front[2]-change.edge.position[2]);
 // Stop the standing feet outside the blanket. Transfer the pelvis backwards
 // as the knees bend, not by walking upright through the mattress first.
 const outside=Math.min(.7,distance)/Math.max(distance,.001);
 const standing=change.edge.position.map((v,i)=>i===1?change.front[1]:mix(v,change.front[i],outside));
 const position=change.front.map((v,i)=>mix(mix(mix(v,standing[i],f.edgeTravel),change.edge.position[i],f.weight),clipStart[i],f.inboard));
 // Root lift compensates for the rig's pelvis lowering; do not lift the
 // standing body into the air while it is still reaching the mattress.
 position[1]=mix(change.front[1],mix(change.edge.position[1],clipStart[1],f.inboard),f.weight);
 const turn=(from,to,t)=>from+Math.atan2(Math.sin(to-from),Math.cos(to-from))*t;
 const rotation=turn(turn(change.startRotation,change.edge.rotation,f.turn),change.rotation,f.inboard);
 // The source already contains this hip offset. Gradually hand it ownership
 // instead of adding its translation a second time at the clip boundary.
 position[0]-=Math.sin(rotation)*offset[2]*f.clipBlend;
 position[1]-=offset[1]*f.clipBlend;
 position[2]-=Math.cos(rotation)*offset[2]*f.clipBlend;
 return {...f,position,rotation};
}
