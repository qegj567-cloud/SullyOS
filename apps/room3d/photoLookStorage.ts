import {photoLooks,type PhotoLook} from './photoEffects';

export const PHOTO_LOOK_LIBRARY_KEY='sully.home.photo-look-library.v1';
export interface SavedPhotoLook {id:string;name:string;look:PhotoLook}
export function readPhotoLooks():SavedPhotoLook[]{
 try{
  const value=JSON.parse(localStorage.getItem(PHOTO_LOOK_LIBRARY_KEY)||'[]');
  if(!Array.isArray(value))return [];
  return value.filter(p=>p&&typeof p.id==='string'&&typeof p.name==='string'&&p.look&&Object.prototype.hasOwnProperty.call(photoLooks,p.look.preset)&&
   ([['glow',0,3],['fringe',0,1],['vignette',0,1],['exposure',.5,1.6]] as const).every(([key,min,max])=>typeof p.look[key]==='number'&&Number.isFinite(p.look[key])&&p.look[key]>=min&&p.look[key]<=max)).slice(0,60);
 }catch{return [];}
}
export function writePhotoLooks(items:SavedPhotoLook[]){localStorage.setItem(PHOTO_LOOK_LIBRARY_KEY,JSON.stringify(items));}
export function samePhotoLook(a:PhotoLook,b:PhotoLook){return a.preset===b.preset&&a.glow===b.glow&&a.fringe===b.fringe&&a.vignette===b.vignette&&a.exposure===b.exposure;}
