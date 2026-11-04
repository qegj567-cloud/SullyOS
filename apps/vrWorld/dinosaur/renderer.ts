import { dressHalloweenDinosaur } from './halloweenDinosaur';
import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { prepareToyMotion,toyNose } from './motion';
import { placementError,type GardenPlacement } from '../../../utils/vrWorld/dinosaurPlacement';
import { INTERACTIVE_PROPS } from '../../../utils/vrWorld/dinosaurActivities';
import { makeGardenScene,makeGardenProp } from './scene';
import { gardenResidents,assertGardenPose } from '../../../utils/vrWorld/dinosaurGarden';
import { DINO_GRID } from '../../../utils/vrWorld/dinosaurGrid';
import { defaultDinoPaint } from '../../../utils/vrWorld/dinosaurCatalog';
import { gardenSurfaceHeight } from '../../../utils/vrWorld/dinosaurTerrain';
import { buildGardenActivities, sampleGardenActivity, type GardenActivity } from '../../../utils/vrWorld/dinosaurActivities';
import type { FishingMarketState } from '../../../utils/vrWorld/fishingMarket';
import type { DinoToy, DinoPaint, DinoPose } from '../../../utils/vrWorld/dinosaurTypes';
import { activeGardenMap } from '../../../utils/vrWorld/dinosaurTypes';
export type GardenView='garden'|'portrait';
type Hooks={play:(propId:string)=>void;selectProp:(id:string)=>void;select:(id:string)=>void;place:(pose:DinoPose)=>void;ready:()=>void;error:(message:string)=>void};
type Model={root:T.Group;species:string;paintKey:string;meshes:{mesh:T.Mesh;base:Float32Array}[];effect:T.Sprite;ripple:T.Mesh;fx:T.Group;cookie:T.Mesh;particles:T.InstancedMesh;nose:T.Vector3;particleKind:string;height:number};
export function createGardenRenderer(host:HTMLElement,hooks:Hooks) {
  const renderer=new T.WebGLRenderer({antialias:true,powerPreference:'low-power'});renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.4));renderer.setClearColor('#f2eee3');renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;renderer.shadowMap.autoUpdate=false;
  const canvas=renderer.domElement;canvas.setAttribute('aria-label','可以用手指旋转、缩放和摆放的橡皮泥恐龙箱庭');canvas.setAttribute('role','img');host.appendChild(canvas);
  const scene=new T.Scene();scene.background=new T.Color('#f2eee3');scene.add(new T.HemisphereLight('#fff4df','#a0af99',2.6));
  const sun=new T.DirectionalLight('#fff0d6',2.05);sun.position.set(-4,11,5);sun.castShadow=true;sun.shadow.mapSize.set(512,512);Object.assign(sun.shadow.camera,{left:-8,right:8,top:8,bottom:-8,near:.1,far:27});sun.shadow.normalBias=.03;scene.add(sun);
  const floor=new T.Mesh(new T.PlaneGeometry(100,100),new T.ShadowMaterial({opacity:.11,color:'#6d755f'}));floor.rotation.x=-Math.PI/2;floor.position.y=-.57;floor.receiveShadow=true;scene.add(floor);
  const plinth=new T.Mesh(new T.CylinderGeometry(2.15,2.2,.12,48),new T.MeshStandardMaterial({color:'#d8dfc9',roughness:1}));plinth.position.y=-.06;plinth.receiveShadow=true;scene.add(plinth);
  const camera=new T.OrthographicCamera(-6,6,6,-6,.1,80);const orbit=new OrbitControls(camera,canvas);orbit.enableDamping=true;orbit.enablePan=false;orbit.rotateSpeed=.6;orbit.minZoom=.8;orbit.maxZoom=2;orbit.minPolarAngle=.32;orbit.maxPolarAngle=1.3;orbit.touches.ONE=T.TOUCH.ROTATE;orbit.touches.TWO=T.TOUCH.DOLLY_ROTATE;
  const ring=new T.Mesh(new T.RingGeometry(.45,.49,40),new T.MeshBasicMaterial({color:'#51785b',transparent:true,opacity:.6,side:T.DoubleSide,depthWrite:false}));ring.rotation.x=-Math.PI/2;scene.add(ring);
  const ghost=new T.Mesh(new T.RingGeometry(.44,.49,32),new T.MeshBasicMaterial({color:'#b18370',transparent:true,opacity:.45,side:T.DoubleSide,depthWrite:false}));ghost.rotation.x=-Math.PI/2;ghost.visible=false;scene.add(ghost);
  const hints=new T.InstancedMesh(new T.RingGeometry(.71,.76,4).rotateZ(Math.PI/4),new T.MeshBasicMaterial({color:'#ffffff',transparent:true,opacity:.85,depthWrite:false,side:T.DoubleSide}),DINO_GRID.length);hints.visible=false;hints.renderOrder=4;scene.add(hints);
  const loader=new GLTFLoader(),templates=new Map<string,Promise<T.Group>>(),models=new Map<string,Model>();let world:T.Group|null=null,worldKey='',data:FishingMarketState|null=null,selected='',view:GardenView='garden',preview:DinoPaint|undefined,placing=false,elapsed=0,greeting=-100,disposed=false,failed=false,visible=true,frame=0,last=0,loadGeneration=0;
  let loading=false,active=true,dirty=true,framesRendered=0,shadowUpdates=0,terrainBuilds=0,propBuilds=0,morphBuilds=0,animatedActivities=false,propKey='';
  const props=new Map<string,T.Mesh>(),propActions=new Map<string,GardenActivity>(),particleTransform=new T.Object3D(),noseScratch=new T.Vector3();
  let activities:Record<string,GardenActivity>={},shadowAt=-1,draft:GardenPlacement|undefined,invalid=false,saved:FishingMarketState|undefined,selectedProp='';
  const arrow=new T.Mesh(new T.ConeGeometry(.20,.52,3),new T.MeshBasicMaterial({color:'#d3a25e',depthTest:false}));arrow.renderOrder=9;scene.add(arrow);
  const halo=new T.Mesh(new T.RingGeometry(.73,.80,40),new T.MeshBasicMaterial({color:'#badc8b',transparent:true,opacity:.8,side:T.DoubleSide,depthTest:false,depthWrite:false}));halo.rotation.x=-Math.PI/2;halo.renderOrder=8;scene.add(halo);
  const propHints=new T.Group();scene.add(propHints);
  let propList:T.Mesh[]=[];
  const propMeshes=()=>propList;

  const glyphs=new Map<string,T.CanvasTexture>();
  const glyph=(text:string)=>{if(!glyphs.has(text)){const c=document.createElement('canvas');c.width=128;c.height=64;const ctx=c.getContext('2d')!;if(text==='play'){ctx.fillStyle='#fff9dd';ctx.beginPath();ctx.arc(64,32,28,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#71895d';ctx.lineWidth=3;ctx.stroke();ctx.fillStyle='#71895d';for(const [x,y,r] of [[64,39,9],[50,24,5],[63,19,5],[77,24,5]]){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}}else {ctx.font='500 38px Georgia';ctx.fillStyle='#657c65';ctx.textAlign='center';ctx.fillText(text,64,46);}const texture=new T.CanvasTexture(c);texture.colorSpace=T.SRGBColorSpace;glyphs.set(text,texture);}return glyphs.get(text)!;};
  const surfaceHeight=(x:number,z:number)=>gardenSurfaceHeight(x,z,data?.dinosaurGarden?activeGardenMap(data.dinosaurGarden).theme:'grassland');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  function release(root:T.Object3D){root.traverse(o=>{if(o instanceof T.Mesh||o instanceof T.Sprite){if(o instanceof T.InstancedMesh)o.dispose();if(o instanceof T.Mesh)o.geometry.dispose();(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.dispose());}});}
  const resize=()=>{const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.4,Math.sqrt(1_000_000/(w*h))));renderer.setSize(w,h);const aspect=w/h,half=Math.max(view==='garden'?5.4:2.5,(view==='garden'?11.7:4.8)/(2*aspect));camera.left=-half*aspect;camera.right=half*aspect;camera.top=half;camera.bottom=-half;camera.updateProjectionMatrix();invalidate();};
  const reset=()=>{orbit.enableDamping=false;orbit.target.set(0,view==='garden'?.45:1.2,0);camera.position.copy(orbit.target).add(view==='garden'?new T.Vector3(7,15,19):new T.Vector3(4,3,9.5));camera.zoom=1;orbit.update();orbit.enableDamping=true;resize();};reset();
  const paint=(model:Model,toy:DinoToy,p:DinoPaint)=>{const key=JSON.stringify(p);if(model.paintKey===key)return;model.paintKey=key;const defaults=defaultDinoPaint(toy.speciesId),db=new T.Color(defaults.body),da=new T.Color(defaults.accent),b=new T.Color(p.body),a=new T.Color(p.accent);
    for(const {mesh,base} of model.meshes){const c=mesh.geometry.getAttribute('color'),uv=mesh.geometry.getAttribute('uv');for(let i=0;i<c.count;i++){const u=uv?.getX(i)||0,v=uv?.getY(i)||0;c.setXYZ(i,T.MathUtils.clamp(base[i*3]+(b.r-db.r)*u+(a.r-da.r)*v,0,1),T.MathUtils.clamp(base[i*3+1]+(b.g-db.g)*u+(a.g-da.g)*v,0,1),T.MathUtils.clamp(base[i*3+2]+(b.b-db.b)*u+(a.b-da.b)*v,0,1));}c.needsUpdate=true;}
  };
  const getTemplate=(species:string)=>{if(!templates.has(species))templates.set(species,loader.loadAsync(`${import.meta.env.BASE_URL}dino-models/${species==='halloween-dinosaur'?'tyrannosaurus':species}.glb`).then(g=>{if(species==='halloween-dinosaur')dressHalloweenDinosaur(g.scene);g.scene.traverse(o=>{if(o instanceof T.Mesh){prepareToyMotion(o,species);morphBuilds++;}});return g.scene;}));return templates.get(species)!;};
  async function sync(next:FishingMarketState,id:string,nextView:GardenView,paintPreview?:DinoPaint,placement?:GardenPlacement,invalidDraft=false,savedState?:FishingMarketState){
    if(disposed)return;loading=true;data=next;draft=placement;placing=!!draft;invalid=invalidDraft;saved=savedState;selected=id;preview=paintPreview;const changed=view!==nextView;view=nextView;if(changed){reset();ghost.visible=false;}const gen=++loadGeneration,g=next.dinosaurGarden!;
    DINO_GRID.forEach((c,i)=>{let free=true;try{if(draft&&saved){if(placementError(saved,{...draft,pose:{...c,slotId:c.id,rotation:draft.pose.rotation}}))throw new Error('occupied');}else assertGardenPose(next,{...c,slotId:c.id,rotation:0},id);}catch{free=false;}const matrix=new T.Matrix4().compose(new T.Vector3(c.x,surfaceHeight(c.x,c.z)+.06,c.z),new T.Quaternion().setFromEuler(new T.Euler(-Math.PI/2,0,0)),new T.Vector3(1,1,1));hints.setMatrixAt(i,matrix);hints.setColorAt(i,new T.Color(free?'#eaffc3':'#ba8f85'));});hints.instanceMatrix.needsUpdate=true;if(hints.instanceColor)hints.instanceColor.needsUpdate=true;
    const map=activeGardenMap(g);
    if(map.theme!==worldKey){
      if(world){scene.remove(world);release(world);}props.clear();propList=[];
      world=makeGardenScene({...map,props:[]});scene.add(world);worldKey=map.theme;propKey='';terrainBuilds++;
    }
    const key=JSON.stringify(map.props);
    if(key!==propKey){
      for(const [id,mesh] of props)if(!map.props.some(p=>p.id===id&&p.kind===mesh.userData.propKind)){world!.remove(mesh);release(mesh);props.delete(id);}
      for(const p of map.props){
        let mesh=props.get(p.id);
        if(!mesh){mesh=makeGardenProp(p,map.theme);props.set(p.id,mesh);world!.add(mesh);propBuilds++;}
        mesh.position.set(p.x,surfaceHeight(p.x,p.z),p.z);mesh.rotation.set(0,p.rotation,0);
      }
      propList=[...props.values()];propKey=key;
      release(propHints);propHints.clear();
      for(const p of map.props.filter(p=>INTERACTIVE_PROPS.includes(p.kind))){
        const circle=new T.Mesh(new T.RingGeometry(.57,.60,28),new T.MeshBasicMaterial({color:'#f4efbd',transparent:true,opacity:.6,side:T.DoubleSide,depthWrite:false}));
        circle.rotation.x=-Math.PI/2;circle.position.set(p.x,surfaceHeight(p.x,p.z)+.065,p.z);propHints.add(circle);
        const marker=new T.Sprite(new T.SpriteMaterial({map:glyph('play'),depthTest:false,depthWrite:false}));
        const box=new T.Box3().setFromObject(props.get(p.id)!);marker.position.set(p.x+.35,box.max.y+.17,p.z);marker.scale.set(.65,.325,1);marker.userData.propId=p.id;marker.renderOrder=5;propHints.add(marker);
      }
    }

    activities=buildGardenActivities(map,gardenResidents(next));propActions.clear();
    for(const a of Object.values(activities))if(a.propId)propActions.set(a.propId,a);
    animatedActivities=Object.values(activities).some(a=>a.kind!=='idle');
    const list=view==='garden'?gardenResidents(next):g.toys[id]?[g.toys[id]]:[];const wanted=new Set(list.map(t=>t.catchId));
    for(const [key,m] of models)if(!wanted.has(key)||!list.some(t=>t.catchId===key&&t.speciesId===m.species)){for(const o of [m.root,m.effect,m.ripple,m.fx]){scene.remove(o);release(o);}models.delete(key);}
    try{await Promise.all(list.map(async toy=>{
      if(models.has(toy.catchId))return;const template=await getTemplate(toy.speciesId);if(disposed||gen!==loadGeneration)return;
      const root=template.clone(true),meshes:Model['meshes']=[];root.userData.toyId=toy.catchId;
      root.traverse(o=>{if(o instanceof T.Mesh){o.geometry=o.geometry.clone();o.material=(o.material as T.Material).clone();o.castShadow=true;o.receiveShadow=true;meshes.push({mesh:o,base:new Float32Array(o.geometry.getAttribute('color').array)});}});
      const effect=new T.Sprite(new T.SpriteMaterial({transparent:true,opacity:.75,depthWrite:false}));effect.scale.set(.7,.35,1);
      const ripple=new T.Mesh(new T.RingGeometry(.35,.37,24),new T.MeshBasicMaterial({color:'#e5f4d9',transparent:true,opacity:.6,side:T.DoubleSide,depthWrite:false}));ripple.rotation.x=-Math.PI/2;
      const fx=new T.Group(),cookie=new T.Mesh(new T.CylinderGeometry(.12,.12,.045,10),new T.MeshStandardMaterial({color:'#d6a167',roughness:1}));fx.add(cookie);
      const particles=new T.InstancedMesh(new T.SphereGeometry(.035,6,4),new T.MeshBasicMaterial({color:'#addcda'}),6);particles.instanceMatrix.setUsage(T.DynamicDrawUsage);particles.frustumCulled=false;fx.add(particles);scene.add(fx);
      const height=new T.Box3().setFromObject(root).max.y*.49;
      models.set(toy.catchId,{root,meshes,species:toy.speciesId,paintKey:'',effect,ripple,fx,cookie,particles,nose:toyNose(toy.speciesId),particleKind:'',height});scene.add(root,effect,ripple);
    }));if(disposed||gen!==loadGeneration)return;loading=false;renderer.shadowMap.needsUpdate=true;invalidate();hooks.ready();}catch{if(gen===loadGeneration){loading=false;invalidate();}if(!disposed)hooks.error('有一只模型没能加载，请重新打开箱庭。');}
  }
  function draw(dt:number){elapsed+=dt;if(!data)return;const g=data.dinosaurGarden!;
    hints.visible=placing&&view==='garden';
    propHints.visible=view==='garden';
    for(const [id,m] of models){const toy=g.toys[id];if(!toy)continue;const portrait=view==='portrait',p=portrait?{x:0,z:0,rotation:-.22}:toy.pose;if(!p)continue;const s=portrait?1:.49;
      const hop=reduced.matches?0:Math.max(0,Math.sin((elapsed-greeting)*Math.PI*2))*Math.max(0,1-(elapsed-greeting)/1.2)*.14;
      const activity=activities[id],motion=!portrait&&!placing&&activity?sampleGardenActivity(toy,activity,elapsed,reduced.matches):null;
      const x=motion?.x??p.x,z=motion?.z??p.z;
      m.root.position.set(x,(portrait?.025:surfaceHeight(x,z)+.025)+(motion?.lift??(!portrait?activity?.lift:0)??0),z);if(id===selected)m.root.position.y+=hop;
      m.root.scale.set(s,s*(motion?.squash||1),s);m.root.rotation.set(0,p.rotation,0);
      for(const {mesh} of m.meshes){if(mesh.morphTargetInfluences){mesh.morphTargetInfluences[0]=(motion?.head||0)/.5;mesh.morphTargetInfluences[1]=(motion?.tail||0)/.5;mesh.morphTargetInfluences[2]=(motion?.feet||0)/.2;}
        const mat=mesh.material as T.MeshStandardMaterial;mat.emissive.set(placing&&draft?.id===id?(invalid?'#c47367':'#acdd88'):'#000000');mat.emissiveIntensity=(placing&&draft?.id===id) ? .35 : 0;
      }
      m.fx.visible=!!motion&&['snack','splash','leaves','sniff'].includes(motion.activity);
      m.fx.position.copy(m.root.position);m.fx.rotation.y=p.rotation;
      if(m.fx.visible){
        const nose=noseScratch.copy(m.nose).multiplyScalar(s);nose.y+=(motion?.head||0)*.13;
        m.cookie.visible=motion?.activity==='snack';m.cookie.position.set(nose.x+.06,nose.y-.04,nose.z);m.cookie.rotation.z=Math.PI/2+(motion?.head||0);m.cookie.scale.setScalar(.9+(reduced.matches?0:Math.sin(elapsed*6)*.12));
        m.particles.visible=!reduced.matches;
        if(m.particles.visible){
          const water=motion?.activity==='splash',flower=motion?.activity==='sniff',leaf=motion?.activity==='leaves';
          if(m.particleKind!==motion!.activity){m.particleKind=motion!.activity;(m.particles.material as T.MeshBasicMaterial).color.set(water?'#8fcdd4':flower?'#eab8b4':leaf?'#9aba7a':'#dfb880');}
          particleTransform.scale.set(water?1:1.2,water?1.8:leaf?.4:1,1);
          for(let i=0;i<6;i++){
            const t=(elapsed*(water?1.1:.7)+i/6)%1,a=i*Math.PI/3;
            particleTransform.position.set((water?0:nose.x)+Math.cos(a)*t*(water?.7:.25),(water?.07:nose.y)+Math.sin(t*Math.PI)*(water?.4:.16)-(water?0:t*.23),(water?0:nose.z)+Math.sin(a)*t*(water?.7:.25));
            particleTransform.updateMatrix();m.particles.setMatrixAt(i,particleTransform.matrix);
          }
          m.particles.instanceMatrix.needsUpdate=true;
        }
      }
      m.effect.visible=!!motion&&!reduced.matches&&motion.active>.6&&['nap'].includes(motion.activity);
      if(m.effect.visible){const texture=glyph(motion!.activity==='nap'?'z z':motion!.activity==='sniff'?'✿':'♪');if(m.effect.material.map!==texture){m.effect.material.map=texture;m.effect.material.needsUpdate=true;}m.effect.position.set(x,m.root.position.y+m.height*(motion?.squash||1)+.24+Math.sin(elapsed)*.05,z);}
      m.ripple.visible=motion?.activity==='splash'&&!reduced.matches;
      if(m.ripple.visible){const wave=(elapsed*.6+motion!.phase/22)%1;m.ripple.position.set(x,surfaceHeight(x,z)+.05,z);m.ripple.scale.setScalar(.7+wave*1.5);(m.ripple.material as T.MeshBasicMaterial).opacity=(1-wave)*.65;}
      paint(m,toy,id===selected&&preview?preview:toy.paint);
    }
    for(const mesh of propMeshes()){
      const isDraft=placing&&((draft?.kind==='prop'&&mesh.userData.propId===draft.id)||draft?.companionProp?.id===mesh.userData.propId);
      const isSelected=selectedProp===mesh.userData.propId;
      const interactive=INTERACTIVE_PROPS.includes(mesh.userData.propKind);
      const mat=mesh.material as T.MeshStandardMaterial;mat.emissive.set(isDraft?(invalid?'#d87968':'#bcdf88'):isSelected?'#d9d88d':interactive?'#d9de93':'#000000');mat.emissiveIntensity=isDraft ? .35 : isSelected ? .2 : interactive ? .045 : 0;
      const action=propActions.get(mesh.userData.propId);
      mesh.rotation.z=!placing&&!reduced.matches&&action&&(action.kind==='sniff'||action.kind==='leaves')?Math.sin(elapsed*(action.kind==='leaves'?5:2))*.055:0;
    }
    const anchor=draft?.pose||(selectedProp?activeGardenMap(g).props.find(p=>p.id===selectedProp):undefined);
    halo.visible=!!anchor&&view==='garden';arrow.visible=!!draft&&view==='garden';
    if(anchor){halo.position.set(anchor.x,surfaceHeight(anchor.x,anchor.z)+.09,anchor.z);(halo.material as T.MeshBasicMaterial).color.set(invalid?'#dc9682':'#e2f5a7');(halo.material as T.MeshBasicMaterial).opacity=.8;
      arrow.position.set(anchor.x+Math.cos(anchor.rotation)*.95,surfaceHeight(anchor.x,anchor.z)+.18,anchor.z-Math.sin(anchor.rotation)*.95);arrow.rotation.set(0,anchor.rotation,-Math.PI/2);}
    if(hasAnimation()&&elapsed-shadowAt>1/3){renderer.shadowMap.needsUpdate=true;shadowAt=elapsed;}
    if(world)world.visible=view==='garden';plinth.visible=view==='portrait';const p=g.toys[selected]?.pose;ring.visible=view==='garden'&&!!p&&g.toys[selected]?.mapId===g.activeMapId;if(p){const anchor=!placing?models.get(selected)?.root.position:p;const x=anchor?.x??p.x,z=anchor?.z??p.z;ring.position.set(x,surfaceHeight(x,z)+.035,z);}(ring.material as T.MeshBasicMaterial).opacity=placing?.9:.4;if(renderer.shadowMap.needsUpdate)shadowUpdates++;renderer.render(scene,camera);framesRendered++;
  }
  function hasAnimation(){return !reduced.matches&&((!!selected&&elapsed-greeting<1.2)||(view==='garden'&&!placing&&animatedActivities&&models.size>0));}
  function canRender(){return !disposed&&!loading&&!failed&&active&&visible&&!document.hidden;}
  function invalidate(){dirty=true;resume();}
  function loop(now:number){
    frame=0;if(!canRender())return;
    if(now-last<1000/30){frame=requestAnimationFrame(loop);return;}
    const moved=orbit.update(),animating=hasAnimation();
    if(dirty||moved||animating){const dt=Math.min((now-last)/1000,.06);last=now;dirty=false;draw(dt);}
    if((dirty||moved||hasAnimation())&&!frame)frame=requestAnimationFrame(loop);
  }
  function resume(){
    if(!canRender()){cancelAnimationFrame(frame);frame=0;}
    else if(!frame)frame=requestAnimationFrame(loop);
  }
  orbit.addEventListener('change',invalidate);
  const onMotionChange=()=>{renderer.shadowMap.needsUpdate=true;invalidate();};reduced.addEventListener('change',onMotionChange);
  const intersection=new IntersectionObserver(e=>{visible=e[0]?.isIntersecting??true;resume();});intersection.observe(host);const observer=new ResizeObserver(resize);observer.observe(host);document.addEventListener('visibilitychange',resume);
  const raycaster=new T.Raycaster(),point=new T.Vector2(),plane=new T.Plane(new T.Vector3(0,1,0),-.13);let press:{id:number;x:number;y:number;moved:boolean}|null=null;const touches=new Set<number>();
  const down=(e:PointerEvent)=>{touches.add(e.pointerId);if(touches.size>1){if(press)press.moved=true;}else press={id:e.pointerId,x:e.clientX,y:e.clientY,moved:false};};
  const move=(e:PointerEvent)=>{if(press&&Math.hypot(e.clientX-press.x,e.clientY-press.y)>6)press.moved=true;};
  const up=(e:PointerEvent)=>{touches.delete(e.pointerId);if(!press||press.id!==e.pointerId||press.moved){if(!touches.size)press=null;return;}press=null;const r=canvas.getBoundingClientRect();point.set((e.clientX-r.x)/r.width*2-1,-(e.clientY-r.y)/r.height*2+1);raycaster.setFromCamera(point,camera);
    const markerHit=raycaster.intersectObjects(propHints.children.filter(o=>o instanceof T.Sprite),false)[0];
    let propHit=markerHit||raycaster.intersectObjects(propMeshes(),false)[0];
    if(!propHit&&!placing){const near=propMeshes().map(m=>{const marker=propHints.children.find(o=>o instanceof T.Sprite&&o.userData.propId===m.userData.propId),v=(marker?marker.position.clone():new T.Box3().setFromObject(m).getCenter(new T.Vector3())).project(camera);return {object:m,d:Math.hypot(r.x+(v.x+1)*r.width/2-e.clientX,r.y+(1-v.y)*r.height/2-e.clientY)};}).filter(p=>p.d<22).sort((a,b)=>a.d-b.d)[0];if(near)propHit={object:near.object,distance:Infinity,point:near.object.position.clone()};}

    if(placing&&view==='garden'){
      if(draft?.kind==='dino'&&propHit&&INTERACTIVE_PROPS.includes(activeGardenMap(data!.dinosaurGarden!).props.find(p=>p.id===propHit.object.userData.propId)?.kind!)){hooks.play(propHit.object.userData.propId);return;}
      const p=raycaster.ray.intersectPlane(plane,new T.Vector3());if(p){for(let i=0;i<4;i++){plane.constant=-surfaceHeight(p.x,p.z);raycaster.ray.intersectPlane(plane,p);}plane.constant=-.13;hooks.place({x:p.x,z:p.z,rotation:draft?.pose.rotation||0});}return;
    }
    const hit=raycaster.intersectObjects([...models.values()].map(m=>m.root),true)[0];
    if(propHit&&(markerHit||!hit||propHit.distance<hit.distance)){hooks.selectProp(propHit.object.userData.propId);return;}
    if(!hit)hooks.select('');for(let o:T.Object3D|null=hit?.object||null;o;o=o.parent)if(o.userData.toyId){hooks.select(o.userData.toyId);break;}

  };
  const cancel=(e:PointerEvent)=>{touches.delete(e.pointerId);press=null;};const lost=(e:Event)=>{e.preventDefault();failed=true;resume();hooks.error('3D 画面已暂停，重新打开后会恢复。你的布置已经保存在本机。');};
  canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',cancel);canvas.addEventListener('webglcontextlost',lost);resume();
  return {sync,reset,setActive(value:boolean){active=value;orbit.enabled=value;if(value)invalidate();else resume();},selectProp(id:string){selectedProp=id;invalidate();},greet(){greeting=elapsed;invalidate();},highlight(id:string,before?:DinoPose|null){selected=id;const p=data?.dinosaurGarden?.toys[id]?.pose;if(p){orbit.target.set(p.x,.55,p.z);camera.position.copy(orbit.target).add(new T.Vector3(7,15,19));camera.zoom=1.2;}ghost.visible=!!before;if(before)ghost.position.set(before.x,surfaceHeight(before.x,before.z)+.035,before.z);invalidate();},
    metrics(){return {view,active,framesRendered,shadowUpdates,terrainBuilds,propBuilds,morphBuilds,memory:{...renderer.info.memory},drawingPixels:canvas.width*canvas.height,triangles:renderer.info.render.triangles,drawCalls:renderer.info.render.calls,pixelRatio:renderer.getPixelRatio(),frameCap:30,zoom:camera.zoom,azimuth:orbit.getAzimuthalAngle(),loaded:[...models.keys()],preview:draft?{id:draft.id,pose:draft.pose,invalid}:null,propTargets:propMeshes().map(m=>{const r=canvas.getBoundingClientRect(),marker=propHints.children.find(o=>o instanceof T.Sprite&&o.userData.propId===m.userData.propId),v=(marker?marker.position.clone():new T.Box3().setFromObject(m).getCenter(new T.Vector3())).project(camera);return {id:m.userData.propId,kind:m.userData.propKind,x:r.x+(v.x+1)*r.width/2,y:r.y+(1-v.y)*r.height/2};}),activities:Object.fromEntries([...models].map(([id,m])=>[id,{...activities[id],position:{x:m.root.position.x,y:m.root.position.y,z:m.root.position.z,rotation:m.root.rotation.y},morph:m.meshes[0]?.mesh.morphTargetInfluences,screen:(()=>{const r=canvas.getBoundingClientRect(),v=m.root.position.clone().add(new T.Vector3(0,m.height*.5,0)).project(camera);return {x:r.x+(v.x+1)*r.width/2,y:r.y+(1-v.y)*r.height/2};})()}]))};},
    project(p:{x:number;z:number}){const r=canvas.getBoundingClientRect(),v=new T.Vector3(p.x,surfaceHeight(p.x,p.z),p.z).project(camera);return {x:r.x+(v.x+1)*r.width/2,y:r.y+(1-v.y)*r.height/2};},
    advance(ms:number){cancelAnimationFrame(frame);frame=0;for(let i=0;canRender()&&i<Math.ceil(ms/33.333);i++)draw(Math.min(33.333,ms-i*33.333)/1000);last=performance.now();resume();},
    dispose(){disposed=true;++loadGeneration;cancelAnimationFrame(frame);intersection.disconnect();observer.disconnect();document.removeEventListener('visibilitychange',resume);reduced.removeEventListener('change',onMotionChange);orbit.removeEventListener('change',invalidate);orbit.dispose();canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',cancel);canvas.removeEventListener('webglcontextlost',lost);release(scene);glyphs.forEach(t=>t.dispose());templates.forEach(p=>void p.then(release).catch(()=>{}));sun.shadow.dispose();renderer.dispose();renderer.forceContextLoss();canvas.remove();},
  };
}
