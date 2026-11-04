import * as T from 'three';
import {paintPhoto,type PhotoLook} from './photoEffects';
import {photoSize,type PhotoRenderOptions} from './photoFrame';

/** Owns only the frozen photograph, never the house or the visible UI canvas. */
export function createPhotoRenderer(renderer:T.WebGLRenderer,camera:T.OrthographicCamera,capture:()=>void){
 const before={size:renderer.getSize(new T.Vector2()),ratio:renderer.getPixelRatio(),left:camera.left,right:camera.right,top:camera.top,bottom:camera.bottom,view:camera.view?{...camera.view}:null};
 camera.clearViewOffset();
 const raw=document.createElement('canvas');let revision=0,key='',captures=0;
 return {
  invalidate(){revision++;},
  render(out:HTMLCanvasElement,look:PhotoLook,options:PhotoRenderOptions={}){
   const aspect=options.aspect??before.size.x/before.size.y,{width,height}=photoSize(aspect,options.quality);
   const next=`${revision}:${width}:${height}`;
   if(key!==next){
    const span=camera.top-camera.bottom,center=(camera.left+camera.right)/2;
    camera.left=center-span*width/height/2;camera.right=center+span*width/height/2;camera.updateProjectionMatrix();
    // Keep this buffer for the session: changing filters must not resize/recreate
    // every room post-process target or draw all of the furniture again.
    if(renderer.domElement.width!==width||renderer.domElement.height!==height||renderer.getPixelRatio()!==1){renderer.setPixelRatio(1);renderer.setSize(width,height,false);}
    capture();raw.width=width;raw.height=height;raw.getContext('2d',{willReadFrequently:true})!.drawImage(renderer.domElement,0,0);
    key=next;captures++;
   }
   paintPhoto(raw,out,look);
  },
  inspect(){return {captures,width:raw.width,height:raw.height};},
  dispose(){raw.width=raw.height=1;camera.left=before.left;camera.right=before.right;camera.top=before.top;camera.bottom=before.bottom;camera.view=before.view;camera.updateProjectionMatrix();renderer.setPixelRatio(before.ratio);renderer.setSize(before.size.x,before.size.y,false);},
 };
}
