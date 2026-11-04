import {attachPetHat} from '/apps/room3d/petHatModel.js';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {paintPanel} from '/apps/room3d/paintPanel.js';
import {applyFurnitureColorPreset,setFurniturePrimaryColor,resetFurnitureColors} from '/apps/room3d/furniturePaint.js';
const catalog=await fetch('/room3d/catalog.json').then(r=>r.json()),assets=catalog.filter(a=>a.petSpecies&&(!new URLSearchParams(location.search).has('new')||['hamster','jellyfish'].includes(a.petSpecies)));
const renderer=new T.WebGLRenderer({canvas:document.querySelector('canvas'),antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor('#f3f1eb');renderer.setScissorTest(true);
const views=[],gallery=document.querySelector('.gallery');let selected=0;
for(const a of assets){
 const figure=document.createElement('figure');figure.setAttribute('aria-label',a.name);figure.tabIndex=0;figure.innerHTML=`<div class="viewport"></div><figcaption>${a.name}<small></small></figcaption>`;gallery.append(figure);
 const scene=new T.Scene(),camera=new T.PerspectiveCamera(32,1,.01,100);scene.background=new T.Color('#e7e9e1');scene.add(new T.HemisphereLight('#fff9ec','#9da99d',2.0));const sun=new T.DirectionalLight('#ffffff',1.7);sun.position.set(-3,5,4);scene.add(sun);
 const root=(await new GLTFLoader().loadAsync('/room3d/'+a.url+(a.revision?'?v='+a.revision:''))).scene;scene.add(root);attachPetHat(root,new URLSearchParams(location.search).get('hat'),a);let triangles=0;
 root.traverse(o=>{if(o.isMesh){triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3;o.material=o.material.clone();o.material.userData.original=o.material.color.clone();}});
 figure.querySelector('small').textContent=`${triangles.toLocaleString()} 面`;
 const bounds=new T.Box3().setFromObject(root),target=bounds.getCenter(new T.Vector3()),span=Math.max(...bounds.getSize(new T.Vector3()).toArray())*1.18;camera.position.copy(target).add(new T.Vector3(.18,.26,2.0).multiplyScalar(span));
 const controls=new OrbitControls(camera,figure.querySelector('.viewport'));controls.target.copy(target);controls.enablePan=false;controls.minDistance=.5;controls.maxDistance=5;controls.update();controls.addEventListener('change',render);
 const entry={a,figure,root,scene,camera,controls,item:{color:null}};views.push(entry);
 figure.addEventListener('click',()=>{selected=views.indexOf(entry);panel();});figure.addEventListener('keydown',e=>{if(e.key==='Enter'){selected=views.indexOf(entry);panel();}});
}
function render(){
 renderer.setSize(innerWidth,innerHeight,false);renderer.setScissorTest(false);renderer.clear();renderer.setScissorTest(true);
 for(const v of views){const r=v.figure.querySelector('.viewport').getBoundingClientRect();if(r.bottom<0||r.top>innerHeight)continue;v.camera.aspect=r.width/r.height;v.camera.updateProjectionMatrix();renderer.setViewport(r.left,innerHeight-r.bottom,r.width,r.height);renderer.setScissor(r.left,innerHeight-r.bottom,r.width,r.height);renderer.render(v.scene,v.camera);}
}
function panel(){const v=views[selected];document.querySelector('aside h2').textContent=v.a.name;document.querySelector('#paint').innerHTML=paintPanel(v.item,v.a);views.forEach((o,i)=>o.figure.setAttribute('aria-selected',String(i===selected)));render();}
function color(){const v=views[selected];v.root.traverse(o=>{if(o.isMesh){const c=v.item.materialColors?.[o.material.name]||(v.a.paintMaterials.includes(o.material.name)?v.item.color:null);o.material.color.copy(o.material.userData.original);if(c)o.material.color.set(c);}});panel();}
document.querySelector('#paint').addEventListener('click',e=>{const d=e.target.closest('button')?.dataset;if(!d)return;const v=views[selected];if(d.action==='color-preset')applyFurnitureColorPreset(v.item,v.a,d.value);if(d.action==='color')setFurniturePrimaryColor(v.item,v.a,d.value||null);if(d.action==='reset-all-colors')resetFurnitureColors(v.item);color();});
document.querySelector('#paint').addEventListener('change',e=>{const v=views[selected],input=e.target;if(input.matches('[data-furniture-color]'))setFurniturePrimaryColor(v.item,v.a,input.value);else if(input.dataset.materialColor)v.item.materialColors={...v.item.materialColors,[input.dataset.materialColor]:input.value};color();});
addEventListener('resize',render);addEventListener('scroll',render);panel();
window.__pets={views,select(i){selected=i;panel();},render};
