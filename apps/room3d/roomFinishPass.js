import * as T from 'three';
import {FullScreenQuad} from 'three/addons/postprocessing/Pass.js';

// Keep the source/character edges at full resolution. Only the soft halo is
// sampled at half width/height (one quarter of the expensive 8-tap fragments).
export function createRoomFinishPass(renderer){
 let texture=null,halo=null,width=0,height=0;const size=new T.Vector2();
 const glowMaterial=new T.ShaderMaterial({depthTest:false,depthWrite:false,toneMapped:false,
  uniforms:{source:{value:null},pixel:{value:new T.Vector2()}},
  vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
  fragmentShader:`varying vec2 vUv;uniform sampler2D source;uniform vec2 pixel;
   vec3 bright(vec2 p){vec3 c=sRGBTransferEOTF(texture2D(source,p)).rgb;return c*smoothstep(.58,.94,max(c.r,max(c.g,c.b)));}
   void main(){vec3 halo=vec3(0.);for(int i=0;i<8;i++){float a=float(i)*.78539816;halo+=bright(vUv+vec2(cos(a),sin(a))*pixel*4.);}gl_FragColor=vec4(halo/8.,1.);}`});
 const material=new T.ShaderMaterial({depthTest:false,depthWrite:false,toneMapped:false,
  uniforms:{source:{value:null},halo:{value:null},glow:{value:.12},warmth:{value:0}},
  vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
  fragmentShader:`varying vec2 vUv;uniform sampler2D source;uniform sampler2D halo;uniform float glow;uniform float warmth;
   void main(){vec3 c=sRGBTransferEOTF(texture2D(source,vUv)).rgb;vec3 bloom=texture2D(halo,vUv).rgb;float l=dot(c,vec3(.2126,.7152,.0722));
    c=mix(vec3(l),c,1.04);c=(c-.18)*1.025+.18;
    c+=bloom*glow*(1.-clamp(c,0.,1.)) + vec3(.012,.005,0.)*warmth*smoothstep(.35,.85,l);
    gl_FragColor=vec4(max(c,0.),1.);
    #include <colorspace_fragment>
   }`});
 const quad=new FullScreenQuad(material);
 const glowQuad=new FullScreenQuad(glowMaterial);
 return {render(phase){
  renderer.getDrawingBufferSize(size);
  if(width!==size.x||height!==size.y){texture?.dispose();halo?.dispose();width=size.x;height=size.y;texture=new T.FramebufferTexture(width,height);texture.colorSpace=T.NoColorSpace;texture.minFilter=texture.magFilter=T.LinearFilter;halo=new T.WebGLRenderTarget(Math.ceil(width/2),Math.ceil(height/2),{depthBuffer:false,stencilBuffer:false});material.uniforms.source.value=glowMaterial.uniforms.source.value=texture;material.uniforms.halo.value=halo.texture;}
  glowMaterial.uniforms.pixel.value.set(1/width,1/height);material.uniforms.glow.value=phase==='sunset'?.12:phase==='morning'?.14:phase==='night'?.12:.07;material.uniforms.warmth.value=phase==='sunset'?.45:phase==='night'?.45:0;
  renderer.copyFramebufferToTexture(texture);const clear=renderer.autoClear,target=renderer.getRenderTarget();renderer.autoClear=false;
  try{renderer.setRenderTarget(halo);glowQuad.render(renderer);renderer.setRenderTarget(target);quad.render(renderer);}finally{renderer.setRenderTarget(target);renderer.autoClear=clear;}
 },dispose(){texture?.dispose();halo?.dispose();glowQuad.dispose();glowMaterial.dispose();quad.dispose();material.dispose();}};
}
