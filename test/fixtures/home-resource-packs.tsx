import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import * as THREE from 'three';
import {PackImage,confirmResourcePack,useResourcePackInstalled} from '../../apps/room3d/ResourcePackPanel';
import {loadHomeGLTF} from '../../apps/room3d/resourcePackGLTF';
function Fixture(){
 const [result,setResult]=useState('');
 const furniture=useResourcePackInstalled('halloween-furniture'),wardrobe=useResourcePackInstalled('halloween-wardrobe');
 async function load(){
  const models=await Promise.all(['halloween_pumpkin_armchair.glb','wardrobe/halloween-witch-dress.glb'].map(path=>loadHomeGLTF(`${import.meta.env.BASE_URL}room3d/${path}`)));
  const scene=new THREE.Scene();scene.background=new THREE.Color('#eee9e5');scene.add(new THREE.HemisphereLight(0xffffff,0x777777,3));
  const camera=new THREE.PerspectiveCamera(35,1,.01,100);camera.position.set(7,4,9);camera.lookAt(0,1,0);
  models.forEach((model,i)=>{const root=model.scene;root.updateMatrixWorld(true);const bounds=new THREE.Box3().setFromObject(root),scale=2/bounds.getSize(new THREE.Vector3()).y;root.scale.multiplyScalar(scale);const box=new THREE.Box3().setFromObject(root);root.position.sub(box.getCenter(new THREE.Vector3()));root.position.x=i?1.5:-1.5;root.position.y=1;scene.add(root);});
  const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(360,360);document.querySelector('#preview')!.replaceChildren(renderer.domElement);renderer.render(scene,camera);
  let meshes=0,textures=0;scene.traverse((object:any)=>{if(object.isMesh){meshes++;for(const m of Array.isArray(object.material)?object.material:[object.material])if(m.map)textures++;}});
  (window as any).__packRender={meshes,textures,calls:renderer.info.render.calls};setResult(`已加载 ${meshes} 个网格、${textures} 个贴图材质`);
  // Single-frame QA preview: leave pixels visible, release the GPU resources afterwards.
  scene.traverse((object:any)=>{if(object.isMesh){object.geometry.dispose();for(const m of Array.isArray(object.material)?object.material:[object.material]){for(const v of Object.values(m))if((v as any)?.isTexture)(v as any).dispose();m.dispose();}}});renderer.dispose();
 }
 (window as any).__loadPackPreview=load;
 return <><h1>万圣节预览</h1>{[
  {id:'halloween-furniture',name:'南瓜扶手椅',src:'thumbnails/halloween_pumpkin_armchair.png',installed:furniture},
  {id:'halloween-wardrobe',name:'女巫连衣裙',src:'wardrobe/thumbnails/halloween-witch-dress.png',installed:wardrobe},
 ].map(pack=><button key={pack.id} data-pack-locked={!pack.installed} onClick={()=>confirmResourcePack(pack.id).then(ok=>{if(ok)setResult(`已选中${pack.name}`);})}><PackImage style={{width:140,height:160,objectFit:'contain'}} src={`${import.meta.env.BASE_URL}room3d/${pack.src}`} alt=""/><span>{pack.name}</span></button>)}<p id="result">{result}</p><div id="preview"/></>;
}
createRoot(document.querySelector('#root')!).render(<Fixture/>);
