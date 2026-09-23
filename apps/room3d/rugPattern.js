// Two-triangle rugs; local position provides pattern coordinates without UVs
// or image memory. Compose with the furniture lighting shader.
export function applyRugPattern(material,geometry,pattern){
 geometry.computeBoundingBox();const b=geometry.boundingBox,w=b.max.x-b.min.x,d=b.max.z-b.min.z;
 const prior=material.onBeforeCompile,priorKey=material.customProgramCacheKey();
 material.onBeforeCompile=shader=>{
  prior.call(material,shader);
  shader.vertexShader='varying vec2 vRug;\n'+shader.vertexShader;
  shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>\nvRug=position.xz/vec2(${w.toFixed(6)},${d.toFixed(6)});`);
  shader.fragmentShader='varying vec2 vRug;\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
   vec2 p=vRug;float edge=max(abs(p.x),abs(p.y));
   float ink=0.0;
   ${pattern==='check'?`ink=mod(floor((p.x+.5)*12.0)+floor((p.y+.5)*3.0),2.0);`:`
   vec2 q=p*vec2(1.7,.90);
   float head=1.0-smoothstep(.985,1.015,length(q/vec2(.30,.245)));
   float ears=step(-.35,q.y)*step(q.y,-.13)*(1.0-smoothstep((q.y+.35)*.42,(q.y+.35)*.42+.006,abs(abs(q.x)-.18)));
   ink=max(head,ears);
   float eyes=(1.0-smoothstep(.017,.025,length(q-vec2(.10,-.025))))+(1.0-smoothstep(.017,.025,length(q-vec2(-.10,-.025))));
   float nose=1.0-smoothstep(.012,.019,length(q-vec2(0,.045)));
   ink*=1.0-clamp(eyes+nose,0.0,1.0);
   `}
   ink*=1.0-smoothstep(.445,.458,edge);
   float seam=smoothstep(.472,.476,edge)*(1.0-smoothstep(.482,.486,edge));
   diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.78,.76,.70),max(ink,seam*.65));
  `);
 };
 material.customProgramCacheKey=()=>priorKey+'-rug-'+pattern+'-'+w+'-'+d;
}
