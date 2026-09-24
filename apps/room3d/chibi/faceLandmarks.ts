/** Landmarks in the original 472px artwork; never normalize each part's bounds. */
export interface FaceSide {
 left:number; right:number; top:number; bottom:number; x:number; anchor:number;
 outer:[number,number]; inner:[number,number]; edge:number[];
}
const median=(values:number[])=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
export function measureFaceLandmarks(width:number,height:number,pixels:ArrayLike<number>):FaceSide[]{
 return [0,1].map(side=>{
  const columns:Array<{x:number;top:number;bottom:number;center:number}>=[];
  let top=height,bottom=0;
  for(let x=side?width/2:0;x<(side?width:width/2);x++){
   const runs:Array<[number,number]>=[];let start=-1;
   for(let y=0;y<=height;y++){
    const ink=y<height&&pixels[(y*width+x)*4+3]>80;
    if(ink&&start<0)start=y;
    if(!ink&&start>=0){runs.push([start,y-1]);start=-1;}
   }
   if(!runs.length)continue;
   // A detached decorative flick above the lash is not the eyelid itself.
   runs.sort((a,b)=>(b[1]-b[0])-(a[1]-a[0]));const run=runs[0];
   columns.push({x,top:run[0],bottom:run[1],center:(run[0]+run[1])/2});
   top=Math.min(top,run[0]);bottom=Math.max(bottom,run[1]);
  }
  if(!columns.length)throw new Error('Face part is missing one side');
  const left=columns[0].x,right=columns.at(-1)!.x,x=(left+right)/2;
  const central=columns.filter(c=>Math.abs(c.x-x)<=Math.max(2,(right-left)*.16));
  const endpoint=(fraction:number):[number,number]=>{
   const target=left+(right-left)*fraction;
   const sample=columns.reduce((best,c)=>Math.abs(c.x-target)<Math.abs(best.x-target)?c:best);
   return [sample.x,sample.center];
  };
  const edge=Array.from({length:right-left+1},(_,i)=>{
   const target=left+i;
   return columns.reduce((best,c)=>Math.abs(c.x-target)<Math.abs(best.x-target)?c:best).bottom;
  });
  return {left,right,top,bottom,x,anchor:median(central.map(c=>c.top)),outer:endpoint(side?.88:.12),inner:endpoint(side?.12:.88),edge};
 });
}
export function eyePairOffset(lash:FaceSide[],iris:FaceSide[],authored:{lash:FaceSide[];iris:FaceSide[]},manual=0){
 // The PSD layers already share a registered canvas. Preserve the native
 // lash-to-iris gap; only compensate for a different lid or edited dimensions.
 // In particular, an untouched matching pair must have exactly zero offset.
 return lash.reduce((sum,l,i)=>sum+l.anchor-iris[i].anchor-(authored.lash[i].anchor-authored.iris[i].anchor),0)/2+manual;
}

export type EyePoint=[number,number];
/** Closed eye aperture: lash A→D, soft flank D→C, iris C→B, flank B→A.
 * A/B/C/D here refer to the user's sclera diagram, not the earlier alignment anchors.
 */
export function scleraContour(lash:FaceSide,iris:FaceSide,offsetY:number){
 const edge=(side:FaceSide,x:number)=>side.edge[Math.max(0,Math.min(side.edge.length-1,Math.round(x)-side.left))];
 // Stop inside the thin flick at each lash end. Never use the decorative tail
 // as an eye corner, which would produce pointed white wings.
 const ax=Math.round(lash.left+(lash.right-lash.left)*.12),dx=Math.round(lash.right-(lash.right-lash.left)*.12);
 const A:EyePoint=[ax,edge(lash,ax)-1],D:EyePoint=[dx,edge(lash,dx)-1];
 const bx=Math.round(iris.left+(iris.right-iris.left)*.28),cx=Math.round(iris.right-(iris.right-iris.left)*.28);
 const B:EyePoint=[bx,edge(iris,bx)+offsetY],C:EyePoint=[cx,edge(iris,cx)+offsetY];
 const lid:EyePoint[]=Array.from({length:dx-ax+1},(_,i)=>[ax+i,edge(lash,ax+i)-1]);
 const bottom:EyePoint[]=Array.from({length:cx-bx+1},(_,i)=>[cx-i,edge(iris,cx-i)+offsetY]);
 const leftWidth=Math.max(0,B[0]-A[0]),rightWidth=Math.max(0,D[0]-C[0]);
 const leftHeight=Math.max(0,B[1]-A[1]),rightHeight=Math.max(0,C[1]-D[1]);
 const leftControls:EyePoint[]=[[B[0]-leftWidth*.52,B[1]],[A[0]+leftWidth*.12,A[1]+leftHeight*.68]];
 const rightControls:EyePoint[]=[[D[0]-rightWidth*.12,D[1]+rightHeight*.68],[C[0]+rightWidth*.52,C[1]]];
 return {A,B,C,D,lid,bottom,leftControls,rightControls};
}
export function browExpressionRotation(side:FaceSide,expression:'neutral'|'angry'|'sad'){
 if(expression==='neutral')return 0;
 const dx=Math.abs(side.inner[0]-side.outer[0]);
 const native=Math.atan2(side.inner[1]-side.outer[1],dx);
 const direction=expression==='angry'?1:-1;
 // Retain C/D's native slope. Already expressive brows need a smaller delta.
 const degrees=native*direction>.08?3:6;
 return direction*degrees*Math.PI/180*(side.inner[0]>side.outer[0]?1:-1);
}

export interface DetailBounds {left:number;top:number;right:number;bottom:number}
export function detailBounds(width:number,height:number,pixels:ArrayLike<number>,side:number):DetailBounds|undefined {
 let left=width,top=height,right=-1,bottom=-1;
 for(let y=0;y<height;y++)for(let x=side?width/2:0;x<(side?width:width/2);x++)if(pixels[(y*width+x)*4+3]>16){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
 return right<left?undefined:{left,top,right,bottom};
}
/** Largest undistorted highlight that fits below the eyelid, one eye at a time. */
export function fitHighlight(width:number,height:number,mask:ArrayLike<number>,source:DetailBounds,side:number){
 const columns:Array<{x:number;top:number;bottom:number}>=[];
 for(let x=side?width/2:0;x<(side?width:width/2);x++){
  let top=height,bottom=-1;
  for(let y=0;y<height;y++)if(mask[(y*width+x)*4+3]>128){top=Math.min(top,y);bottom=Math.max(bottom,y);}
  if(bottom>=top)columns.push({x,top,bottom});
 }
 if(!columns.length)return undefined;
 const sw=source.right-source.left+1,sh=source.bottom-source.top+1;
 const eyeCenter=(columns[0].x+columns.at(-1)!.x)/2;
 const originalCenter=(source.left+source.right)/2;
 // Try the original size first; prefer its authored horizontal placement.
 // Only a genuinely shorter aperture (e.g. half closed) reduces both axes.
 for(let step=0;step<=49;step++){
  const scale=1-step*.02,dw=sw*scale,dh=sh*scale;
  for(const center of [originalCenter,eyeCenter,eyeCenter-3,eyeCenter+3]){
   const left=Math.round(center-dw/2),right=Math.ceil(left+dw);
   const span=columns.filter(c=>c.x>=left&&c.x<=right);
   if(span.length<right-left+1)continue;
   const top=Math.max(...span.map(c=>c.top))+1,bottom=Math.min(...span.map(c=>c.bottom))-1;
   if(top+dh<=bottom)return {x:left,y:top,width:dw,height:dh,scale};
  }
 }
 return undefined;
}
