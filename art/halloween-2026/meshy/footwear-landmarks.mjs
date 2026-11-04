import * as T from 'three';
// Match each foot separately in bind space: ankle axis, heel, toe and sole.
export function fitFootwear(g,body,{lowShoe=false}={}){
 const p=g.attributes.position,b=body.geometry.attributes.position,report=[],sides={};
 for(const sign of [-1,1])sides[sign]=Array.from({length:p.count},(_,i)=>i).filter(i=>p.getX(i)*sign>0);
 for(const sign of [-1,1]){
  const ids=[],foot=new T.Box3(),shoe=new T.Box3(),shaft=new T.Box3();
  for(let i=0;i<b.count;i++)if(b.getX(i)*sign>0&&b.getY(i)<.20)foot.expandByPoint(new T.Vector3().fromBufferAttribute(b,i));
  for(const i of sides[sign]){ids.push(i);shoe.expandByPoint(new T.Vector3().fromBufferAttribute(p,i));}
  for(const i of ids)if(p.getY(i)>shoe.min.y+(shoe.max.y-shoe.min.y)*.82)shaft.expandByPoint(new T.Vector3().fromBufferAttribute(p,i));
  const center=shaft.getCenter(new T.Vector3()),target=foot.getCenter(new T.Vector3());
  const minX=sign>0?Math.max(.006,foot.min.x-.015):foot.min.x-.04,maxX=sign>0?foot.max.x+.04:Math.min(-.006,foot.max.x+.015);
  target.x=(minX+maxX)/2;center.x=(shoe.min.x+shoe.max.x)/2;
  const width=maxX-minX,scaleX=width/(shoe.max.x-shoe.min.x),top=lowShoe?.34:.60;
  const front=foot.max.z+.065,back=foot.min.z-.035,ankleZ=.025;
  for(const i of ids){const x=p.getX(i),y=p.getY(i),z=p.getZ(i);p.setXYZ(i,target.x+(x-center.x)*scaleX,-.025+(y-shoe.min.y)*(top+.025)/(shoe.max.y-shoe.min.y),z>=center.z?ankleZ+(z-center.z)*(front-ankleZ)/(shoe.max.z-center.z):ankleZ+(z-center.z)*(ankleZ-back)/(center.z-shoe.min.z));}
  report.push({side:sign>0?'L':'R',ankleX:target.x,soleY:-.025,top,heelZ:back,toeZ:front});
 }
 // Bounds alone do not fit the instep: the current body's foot is deeper
 // than the generated mannequin. Keep the sole, fit the vamp and shaft.
 for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i),sign=x>0?1:-1,w=T.MathUtils.smoothstep(y,.10,.32);const fittedX=T.MathUtils.clamp(Math.abs(x)+Math.max(0,Math.abs(x)-.21)*.25*w,.006,.479);const vamp=1-T.MathUtils.smoothstep(Math.abs(z-.025),.14,.45);p.setXYZ(i,sign*fittedX,y,.025+(z-.025)*(1+.60*w*vamp));}
 return report;
}
