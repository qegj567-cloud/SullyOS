import * as T from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {ROOM_EDGES} from './building.js';
import {wallVisible} from './topology.js';
import {wallFinishPanels,floorFinishBounds} from './finishes.js';
import {windowOpenings,subtractOpenings} from './windowOpenings.js';

// Tiny mathematical patterns on shared standard materials: no image downloads,
// textures, per-tile meshes, or animation. Coordinates are measured in room units.
export function createRoomFinishes(){
 const materials=new Map(),used=new Set();
 function material(kind,style,color,trim='#624336'){
  const key=[kind,style,color,trim].join('/');used.add(key);if(materials.has(key))return materials.get(key);
  // The floor is already above the shell. Depth bias here can pull it in front
  // of thin rugs; only wallpaper needs an offset from its supporting wall.
  const m=new T.MeshStandardMaterial({color,roughness:kind==='floor'&&style==='marble'?.52:.93,polygonOffset:kind==='wall',polygonOffsetFactor:-2,polygonOffsetUnits:-2});m.name=key;
  const formula=kind==='floor'?{
   wood:'vec2 q=vec2(vFinishUV.x/1.8+mod(floor(vFinishUV.y/.34),2.)*.5,vFinishUV.y/.34); vec2 f=fract(q); float d=min(min(f.x,1.-f.x),min(f.y,1.-f.y));float aa=max(fwidth(d),.001);float line=1.-smoothstep(.012-aa,.012+aa,d); shade=-line*.20+.035*sin(floor(q.y)*2.3);',
   tile:'vec2 f=fract(vFinishUV/.72);float d=min(min(f.x,1.-f.x),min(f.y,1.-f.y));float aa=max(fwidth(d),.001);float line=1.-smoothstep(.012-aa,.012+aa,d);shade=line*.23;',
   marble:`vec2 q=vec2(vFinishUV.x+vFinishUV.y,vFinishUV.x-vFinishUV.y)*.70710678/1.05;
    vec2 f=abs(fract(q)-.5);float edge=.5-max(f.x,f.y);float aa=max(fwidth(edge),.002);
    float grout=1.-smoothstep(.006-aa,.006+aa,edge);
    float corner=1.-smoothstep(.13-aa,.13+aa,1.-f.x-f.y);
    float rim=min(${floorFinishBounds[2].toFixed(4)}-abs(vFinishUV.x),${floorFinishBounds[3].toFixed(4)}-abs(vFinishUV.y));
    float raa=max(fwidth(rim),.002);float field=smoothstep(.47-raa,.47+raa,rim);
    float border=1.-smoothstep(.055-raa,.055+raa,abs(rim-.25));
    float pin=1.-smoothstep(.012-raa,.012+raa,abs(rim-.40));
    float vein=pow(abs(sin(vFinishUV.x*3.1+vFinishUV.y*1.9+.7*sin(vFinishUV.y*3.)+.25*sin(vFinishUV.x*8.))),18.);
    diffuseColor.rgb*=1.-.055*vein;
    diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.42),grout*field*.35);
    diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.025),max(corner*field,max(border,pin*.7)));`,
   checker:'shade=mod(floor(vFinishUV.x/.72)+floor(vFinishUV.y/.72),2.)*.25;',
   stone:'vec2 q=vec2(vFinishUV.x/1.1+mod(floor(vFinishUV.y/.55),2.)*.5,vFinishUV.y/.55);vec2 f=fract(q);float d=min(min(f.x,1.-f.x),min(f.y,1.-f.y));float aa=max(fwidth(d),.001);shade=(1.-smoothstep(.018-aa,.018+aa,d))*.24+.025*sin(floor(q.x)*2.1+floor(q.y)*3.7);',
   parquet:'vec2 q=vFinishUV/.96;vec2 f=fract(q);if(mod(floor(q.x)+floor(q.y),2.)>0.5)f=f.yx;float d=min(min(f.x,1.-f.x),min(fract(f.y*4.),1.-fract(f.y*4.))/4.);float aa=max(fwidth(d),.001);shade=-(1.-smoothstep(.01-aa,.01+aa,d))*.13+.025*sin(floor(q.x)*3.+floor(q.y));',
  }[style]:{
   framed:'float rail=1.-smoothstep(.025,.05,abs(vFinishUV.y-.38));diffuseColor.rgb=mix(diffuseColor.rgb,finishTrim,rail);',
   stripe:'shade=step(.56,fract(vFinishUV.x/.32))*.15;',
   dot:'vec2 q=vec2(vFinishUV.x/.42+mod(floor(vFinishUV.y/.42),2.)*.5,vFinishUV.y/.42);shade=(1.-smoothstep(.075,.105,length(fract(q)-.5)))*-.18;',
   panel:'float lower=1.-step(1.25,vFinishUV.y);float seam=1.-smoothstep(.012,.026,min(fract(vFinishUV.x/.58),1.-fract(vFinishUV.x/.58)));shade=-lower*(.12+seam*.08)+(1.-smoothstep(.02,.035,abs(vFinishUV.y-1.25)))*.16;',
   timber:'float f=fract(vFinishUV.x/.36);float aa=max(fwidth(f),.001);shade=-(1.-smoothstep(.018-aa,.018+aa,min(f,1.-f)))*.16+.025*sin(floor(vFinishUV.x/.36)*2.3);',
   tile:'vec2 f=fract(vFinishUV/.34);float d=min(min(f.x,1.-f.x),min(f.y,1.-f.y));float aa=max(fwidth(d),.001);shade=(1.-smoothstep(.018-aa,.018+aa,d))*.25;',
   spa:'float lower=1.-step(1.18,vFinishUV.y);diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.21,.22,.26),lower);vec2 f=fract(vFinishUV/vec2(.8,.48));float d=min(min(f.x,1.-f.x),min(f.y,1.-f.y));float aa=max(fwidth(d),.001);shade=lower*(1.-smoothstep(.012-aa,.012+aa,d))*.12;',
  }[style];
  if(formula){m.onBeforeCompile=shader=>{
   shader.vertexShader='varying vec2 vFinishUV;\n'+shader.vertexShader.replace('#include <uv_vertex>','#include <uv_vertex>\nvFinishUV=uv;');
   shader.uniforms.finishTrim={value:new T.Color(trim)};
   shader.fragmentShader='uniform vec3 finishTrim;\nvarying vec2 vFinishUV;\n'+shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>\nfloat shade=0.;${formula}\ndiffuseColor.rgb=mix(diffuseColor.rgb,shade>=0.?vec3(1.):vec3(0.),abs(shade));`);
  };m.customProgramCacheKey=()=>kind+'/'+style;}
  materials.set(key,m);return m;
 }
 function mesh(g,mat,roomId){g.userData.owned=true;const m=new T.Mesh(g,mat);m.userData.roomId=roomId;m.receiveShadow=true;return m;}
 function panelGeometry(p,holes=[]){
  if(holes.length&&!p.arch)return new T.ShapeGeometry(subtractOpenings(p,holes).map(q=>{const s=new T.Shape();s.moveTo(q.lo,q.bottom);s.lineTo(q.hi,q.bottom);s.lineTo(q.hi,q.top);s.lineTo(q.lo,q.top);s.closePath();return s;}));
  const shape=new T.Shape();shape.moveTo(p.lo,p.top);shape.lineTo(p.lo,p.bottom);
  if(p.arch){const mid=(p.lo+p.hi)/2,w=(p.hi-p.lo)/2;for(let i=0;i<=24;i++){const a=Math.PI-i*Math.PI/24;shape.lineTo(mid+Math.cos(a)*w,p.bottom+Math.sin(a)*.24);}}
  else shape.lineTo(p.hi,p.bottom);
  shape.lineTo(p.hi,p.top);shape.closePath();return new T.ShapeGeometry(shape);
 }
 function add(room,home,catalog,wallView){
  const root=new T.Group();root.name='room-finishes';
  if(room.floorStyle&&room.floorStyle!=='original'){
   const [x,z,X,Z]=floorFinishBounds,g=new T.PlaneGeometry(X-x,Z-z),uv=g.attributes.uv;
   for(let i=0;i<uv.count;i++)uv.setXY(i,x+uv.getX(i)*(X-x),z+uv.getY(i)*(Z-z));
   const floor=mesh(g,material('floor',room.floorStyle,room.floor||'#dfc7ad'),room.id);floor.rotation.x=-Math.PI/2;floor.position.y=.16;root.add(floor);
  }
  for(const p of wallFinishPanels(home,room,catalog)){
   const holes=windowOpenings(room,p.edge,catalog).map(o=>({...o,bottom:o.bottom-.15,top:o.top-.15}));
   const e=ROOM_EDGES[p.edge],g=panelGeometry(p,holes),pos=g.attributes.position,uv=g.attributes.uv;
   const inward=-Math.sign(e.at),flip=e.axis==='z'?inward:-inward;
   // ShapeGeometry has physical XY UVs. Orient the plane inward; maintain the
   // same along-wall coordinates when flipped, so arch openings stay aligned.
   for(let i=0;i<pos.count;i++){const along=pos.getX(i),y=pos.getY(i);uv.setXY(i,along,y);pos.setX(i,along*flip);}
   if(flip<0){const idx=g.index;for(let i=0;i<idx.count;i+=3){const v=idx.getX(i);idx.setX(i,idx.getX(i+2));idx.setX(i+2,v);}g.computeVertexNormals();}
   const wall=mesh(g,material('wall',room.wallStyle||'solid',room.wall,room.trim),room.id);
   wall.rotation.y=e.axis==='z'?(inward>0?0:Math.PI):(inward>0?Math.PI/2:-Math.PI/2);
   if(e.axis==='x'){wall.position.x=e.at+inward*.112;}else wall.position.z=e.at+inward*.112;
   wall.position.y=.15;wall.userData.boundaryEdge=p.edge;if(p.itemId)wall.userData.itemId=p.itemId;
   wall.visible=wallVisible(wallView,p.edge,p.internal);root.add(wall);
   if(['framed','spa','panel'].includes(room.wallStyle)&&p.bottom<.2&&p.top>4){
    const frame=new T.Group();frame.visible=wall.visible;frame.userData.boundaryEdge=p.edge;frame.userData.roomId=room.id;
    const add=(along,y,width,height)=>{const geo=new RoundedBoxGeometry(width,height,.16,1,.018),beam=mesh(geo,material('trim','solid',room.trim||'#624336'),room.id);beam.position.set(e.axis==='x'?-along:along,y,0);frame.add(beam);};
    add(p.lo+.08,2.4,.16,4.55);add(p.hi-.08,2.4,.16,4.55);add((p.lo+p.hi)/2,4.6,p.hi-p.lo,.18);
    frame.rotation.y=e.axis==='z'?0:Math.PI/2;frame.position[e.axis]=e.at+inward*.18;root.add(frame);
   }
  }
  return root;
 }
 return {add,begin(){used.clear();},end(){for(const [key,m]of materials)if(!used.has(key)){m.dispose();materials.delete(key);}},dispose(){for(const m of materials.values())m.dispose();materials.clear();},get count(){return materials.size;}};
}
