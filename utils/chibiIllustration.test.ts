import {describe,it,expect,vi} from 'vitest';
import * as T from 'three';
import {setCharacterIllustration,setCharacterRoomLighting} from '../apps/room3d/chibi/illustration';
import {setCharacterIllustration as baselineIllustration} from '../art/toon-style-2026/illustration-before';

const compile=(material:T.MeshStandardMaterial)=>{
 const shader={uniforms:{},vertexShader:'',fragmentShader:T.ShaderLib.standard.fragmentShader};
 material.onBeforeCompile(shader as any,{} as T.WebGLRenderer);
 return shader;
};
const lighting=()=>({roomShadeTint:{value:new T.Color('#b2b9dd')},roomSunTint:{value:new T.Color('#ffe8cd')},roomBrightness:{value:1},roomSunContrast:{value:0}});
describe('character illustration integration',()=>{
 it('switches to the exact previous shader and back without losing room uniforms or stacking garment hooks',()=>{
  const mesh=new T.Mesh(new T.PlaneGeometry(),new T.MeshStandardMaterial());
  const hook=vi.fn();mesh.material.onBeforeCompile=hook;
  const lights=lighting();setCharacterIllustration(mesh,true,'modern');setCharacterRoomLighting(mesh,lights);
  const modern=compile(mesh.material).fragmentShader;
  const baseline=new T.Mesh(new T.PlaneGeometry(),new T.MeshStandardMaterial());baselineIllustration(baseline);
  for(let i=0;i<3;i++){
   setCharacterIllustration(mesh,true,'legacy');const old=compile(mesh.material);
   expect(old.fragmentShader).toBe(compile(baseline.material).fragmentShader);
   expect((old.uniforms as any).roomBrightness).toBe(lights.roomBrightness);
   setCharacterIllustration(mesh,true,'modern');expect(compile(mesh.material).fragmentShader).toBe(modern);
  }
  expect(hook).toHaveBeenCalledTimes(7);
 });
 it('composes existing garment hooks and restores exact material settings without changing textures or geometry',()=>{
  const map=new T.Texture(),m=new T.MeshStandardMaterial({map,alphaTest:.2,side:T.DoubleSide});
  const color=m.color.clone(),hook=vi.fn((s:any)=>{s.uniforms.garmentDye={value:.6};});
  m.onBeforeCompile=hook;const key=()=> 'garment-dye';m.customProgramCacheKey=key;
  const root=new T.Group(),mesh=new T.Mesh(new T.PlaneGeometry(),m);root.add(mesh);const geometry=mesh.geometry;
  setCharacterIllustration(root);const shader=compile(m);
  expect(hook).toHaveBeenCalledOnce();expect(shader.uniforms).toHaveProperty('garmentDye');
  expect(m.map).toBe(map);expect(m.color.equals(color)).toBe(true);expect(m.alphaTest).toBe(.2);expect(m.side).toBe(T.DoubleSide);
  expect(mesh.geometry).toBe(geometry);expect(root.children).toHaveLength(1);
  setCharacterIllustration(root,false);
  expect(m.onBeforeCompile).toBe(hook);expect(m.customProgramCacheKey).toBe(key);expect(m.toneMapped).toBe(true);
 });
 it('shares changing room uniforms without recompiling and isolates different rooms',()=>{
  const a=new T.Mesh(new T.PlaneGeometry(),new T.MeshStandardMaterial()),b=a.clone();b.material=a.material.clone();
  const lightsA=lighting(),lightsB=lighting();
  for(const [root,lights]of [[a,lightsA],[b,lightsB]] as const){setCharacterIllustration(root);setCharacterRoomLighting(root,lights);}
  const shaderA=compile(a.material),shaderB=compile(b.material),version=a.material.version;
  setCharacterRoomLighting(a,lightsA);setCharacterIllustration(a);lightsA.roomBrightness.value=.86;
  expect(a.material.version).toBe(version);
  expect((shaderA.uniforms as any).roomBrightness.value).toBe(.86);
  expect((shaderB.uniforms as any).roomBrightness.value).toBe(1);
  expect(a.receiveShadow).toBe(true);
 });
 it('keeps face, hair and cloth shader programs separate when materials otherwise match',()=>{
  const root=new T.Group();
  for(const name of ['face','front-hair-sheet','cloth']){
   const m=new T.MeshStandardMaterial();m.userData.illustrationFace=name==='face';
   const mesh=new T.Mesh(new T.PlaneGeometry(),m);mesh.name=name;root.add(mesh);
  }
  setCharacterIllustration(root);
  const keys=root.children.map(o=>(o as T.Mesh<T.BufferGeometry,T.MeshStandardMaterial>).material.customProgramCacheKey());
  expect(new Set(keys).size).toBe(3);
 });
});
