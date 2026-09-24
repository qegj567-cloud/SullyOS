// A finite, elapsed-time itinerary. Positions are room-local; navigation is
// supplied by the editor so room offsets and obstacles use its existing map.
export function createMirrorJourney(activity,start,pathTo){
 const phases=[];let position=[...start],duration=0;
 for(let round=0;round<2;round++)for(const [destination,pose,hold] of [['wardrobe',activity.wardrobePose,1.8],['mirror',activity,3.6]]){
  const path=pathTo(position,pose.position);
  if(path)for(let i=1;i<path.length;i++){
   const a=path[i-1],b=path[i],length=Math.hypot(b[0]-a[0],b[2]-a[2]);
   if(length<.001)continue;
   phases.push({start:duration,end:duration+=length/1.7,from:a,to:b,rotation:Math.atan2(b[0]-a[0],b[2]-a[2]),motion:'walk',destination,round});
  }
  phases.push({start:duration,end:duration+=hold,from:pose.position,to:pose.position,rotation:pose.rotation,motion:'mirror-outfit',destination,round,teleported:!path});
  position=pose.position;
 }
 return {phases,duration};
}
export function mirrorJourneyFrame(journey,time){
 const t=Math.max(0,time),phase=journey.phases.find(p=>t<p.end)||journey.phases.at(-1),mix=Math.min(1,Math.max(0,(t-phase.start)/(phase.end-phase.start)));
 return {...phase,position:phase.from.map((n,i)=>n+(phase.to[i]-n)*mix),time:t-phase.start,done:t>=journey.duration};
}
