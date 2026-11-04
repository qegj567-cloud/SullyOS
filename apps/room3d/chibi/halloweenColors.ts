import * as T from 'three';
// Palette matches the accepted Halloween try-on; uniforms belong to one material instance.
export function createHalloweenColorController(material:T.MeshStandardMaterial,shorts=false){
 const active=new T.Vector4(),uniforms={enabled:{value:1},orange:{value:new T.Color()},purple:{value:new T.Color()},green:{value:new T.Color()},gold:{value:new T.Color()},active:{value:active}};
 material.onBeforeCompile=shader=>{
  for(const [key,value]of Object.entries(uniforms))shader.uniforms['dye_'+key]=value;
  shader.fragmentShader='uniform float dye_enabled;\nuniform vec3 dye_orange,dye_purple,dye_green,dye_gold;\nuniform vec4 dye_active;\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
    if(dye_enabled>0.5){
     vec3 c=diffuseColor.rgb;float hi=max(c.r,max(c.g,c.b)),lo=min(c.r,min(c.g,c.b));
     vec3 target=c;float changed=0.0;float selected=-1.0;
     if(hi>${shorts?'0.0001':'0.018'}&&(hi-lo)/hi>0.24){
      if(c.g>c.r*1.10&&c.g>c.b*1.15){target=dye_green;selected=2.0;changed=dye_active.z;}
      else if(c.r>c.b*1.7&&c.g>c.b*1.3){target=c.g>c.r*0.53?dye_gold:dye_orange;changed=c.g>c.r*0.53?dye_active.w:dye_active.x;}
      else if(c.b>c.g*1.4){target=dye_purple;changed=dye_active.y;}
      ${shorts?'else {target=dye_orange;changed=dye_active.x;}':''}
     }
     if(changed>0.5)diffuseColor.rgb=target*clamp(pow(hi,0.32)*1.15,0.30,1.15);
    }`);

 };
 material.customProgramCacheKey=()=> 'halloween-colors-v2-'+shorts;
 return (values?:Record<string,string>)=>{(['orange','purple','green','gold'] as const).forEach((key,i)=>{const value=values?.[key];const valid=typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);active.setComponent(i,valid?1:0);if(valid)uniforms[key].value.set(value);});};
}
