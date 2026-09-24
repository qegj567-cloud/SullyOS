import * as T from 'three';
import {daylightPose} from './windowDaylight.js';

// One reusable hand-drawn four-pane mask, not an AI image or a floor decal.
// Spot projection illuminates actual receiving surfaces; cached shadow maps
// occlude the light behind furniture. Never allocate lights per window/frame.
export function createWindowDaylight(scene){
 const canvas=document.createElement('canvas');canvas.width=canvas.height=128;const ctx=canvas.getContext('2d');ctx.fillStyle='black';ctx.fillRect(0,0,128,128);ctx.filter='blur(3px)';ctx.fillStyle='white';
 for(const x of [19,68])for(const y of [19,68])ctx.fillRect(x,y,41,41);
 const mask=new T.CanvasTexture(canvas);mask.generateMipmaps=false;mask.minFilter=T.LinearFilter;
 const lights=Array.from({length:2},()=>{const light=new T.SpotLight('#fff1ce',32,8,.35,.2,2);light.map=mask;light.castShadow=true;light.shadow.mapSize.set(512,512);light.shadow.camera.near=.08;light.shadow.camera.far=8;light.shadow.normalBias=.008;light.shadow.bias=-.0001;light.shadow.radius=3;light.shadow.blurSamples=6;light.shadow.autoUpdate=false;light.visible=false;scene.add(light,light.target);return light;});
 let sources=[];
 function pose(light,source){light.position.fromArray(source.position);light.target.position.fromArray(source.target);light.angle=source.angle;const intensity=source.settings?.intensity;light.intensity=Number.isFinite(intensity)?Math.max(0,Math.min(100,intensity)):32;light.shadow.needsUpdate=true;}
 return {
  update(candidates,{quality,touch,overview}){const limit=overview||quality==='eco'?0:quality==='clear'&&!touch?2:1;sources=candidates.slice(0,limit);lights.forEach((light,i)=>{light.visible=i<sources.length;if(light.visible)pose(light,sources[i]);});},
  preview(id,item){const i=sources.findIndex(s=>s.id===id);if(i<0)return false;const source=sources[i];Object.assign(source,daylightPose(item,source.size,source.settings));pose(lights[i],source);return true;},
  invalidate(){for(const light of lights)if(light.visible)light.shadow.needsUpdate=true;},
  inspect(){return sources.map(s=>({id:s.id,roomId:s.roomId,position:s.position,target:s.target}));},
  dispose(){for(const light of lights){light.removeFromParent();light.target.removeFromParent();light.dispose();}mask.dispose();sources=[];}
 };
}
