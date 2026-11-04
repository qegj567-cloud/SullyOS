import * as T from 'three';

// A continuous two-leaf collar with a real neck opening and a thin closed edge.
// This replaces the fragmented mannequin/cloth boundary in the generated mesh.
export function addWitchCollar(rig){
 const positions=[],indices=[],segments=48,rows=8;
 const outer=new T.CatmullRomCurve3([
  new T.Vector3(.025,3.28,.29),new T.Vector3(.23,3.16,.43),
  new T.Vector3(.33,3.31,.27),new T.Vector3(.355,3.34,.02),
  new T.Vector3(.28,3.29,-.23),new T.Vector3(.15,3.23,-.30),new T.Vector3(0,3.23,-.31)
 ]);
 for(const sign of [-1,1]){
  const start=positions.length/3,stride=rows+1,layerSize=(segments+1)*stride;
  for(let layer=0;layer<2;layer++)for(let i=0;i<=segments;i++){
   const u=i/segments,a=u*Math.PI,inner=new T.Vector3(.205*Math.sin(a),3.355,.185*Math.cos(a)),edge=outer.getPoint(u);
   for(let j=0;j<=rows;j++){
    const t=j/rows,v=inner.clone().lerp(edge,t);v.y+=.027*Math.sin(Math.PI*t);v.y-=layer*.014;positions.push(sign*v.x,v.y,v.z);
   }
  }
  const tri=(a,b,c)=>sign>0?indices.push(start+a,start+b,start+c):indices.push(start+a,start+c,start+b);
  for(let i=0;i<segments;i++)for(let j=0;j<rows;j++){
   const a=i*stride+j,b=a+stride;tri(a,b,a+1);tri(b,b+1,a+1);
   tri(a+layerSize,a+1+layerSize,b+layerSize);tri(b+layerSize,a+1+layerSize,b+1+layerSize);
  }
  const rim=[];for(let i=0;i<=segments;i++)rim.push(i*stride);for(let j=1;j<=rows;j++)rim.push(segments*stride+j);for(let i=segments-1;i>=0;i--)rim.push(i*stride+rows);for(let j=rows-1;j>0;j--)rim.push(j);
  for(let k=0;k<rim.length;k++){const a=rim[k],b=rim[(k+1)%rim.length];tri(a,a+layerSize,b);tri(b,a+layerSize,b+layerSize);}
 }
 // Curved shirt inset behind the knot, covering the removed broken white bib.
 const start=positions.length/3;
 for(let i=0;i<=10;i++){const t=i/10,y=3.20-.24*t,width=.31*(1-t)+.055*t;for(let j=0;j<=12;j++){const x=(j/12*2-1)*width;positions.push(x,y,.315-.14*x*x+.02*Math.sin(Math.PI*t));if(i&&j){const a=start+(i-1)*13+j-1,b=a+13;indices.push(a,a+1,b,b,a+1,b+1);}}}
 const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(positions,3));g.setIndex(indices);
 const mesh=rig.bind(g,'cravat','witch');mesh.name='Halloween_witch_tailored_collar';mesh.userData.part='dress';mesh.userData.source='Tailored collar for current body';mesh.material=new T.MeshStandardMaterial({name:'Ivory collar',color:'#eee4d6',roughness:.85,side:T.DoubleSide});return mesh;
}
