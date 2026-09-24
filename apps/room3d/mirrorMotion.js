// Rigid poses only: no limb stretching, mesh rebuilding or saved outfit edits.
export function mirrorFrame(kind,time){
 const t=Math.max(0,Number.isFinite(time)?time:0),outfit=kind==='mirror-outfit',phase=t%4;
 if(outfit){const smooth=Math.sin(t*1.6),check=phase<2;
  return {yaw:Math.sin(t*1.25)*.16,tilt:Math.sin(t*1.5)*.035,nod:check?.065:0,
   hands:check?[[-.30,.43+.025*smooth,.23],[.30,.43-.025*smooth,.23]]:[[-.43,.50,.11],[.43,.50,.11]]};
 }
 return {yaw:Math.sin(t*1.4)*.07,tilt:-.07+Math.sin(t*2)*.025,nod:.015,
  hands:[[-.36,.47,.12],[.43,.72+Math.sin(t*3)*.045,.13]]};
}
