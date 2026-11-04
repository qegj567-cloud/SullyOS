import * as T from 'three';
import catalog from './selectedMotionCatalog.json';
export const motionCategories={greet:'招呼与示好',talk:'聊天交流',care:'关心照顾',close:'亲密',play:'玩闹活动',mischief:'恶作剧',conflict:'闹别扭',self:'自己的小动作'};
export const selectedMotions=catalog;
export type SelectedMotion=typeof catalog[number];
export interface MotionTrack {duration:number;times:number[];tracks:Record<string,number[]>;positions:number[];points:Record<string,number[]>;hipHeight:number}
export interface SelectedClip {version:number;id:string;source?:'meshy-text-to-motion';duration:number;actors:MotionTrack[]}
export interface MotionFrame {rotations:Record<string,T.Quaternion>;position:T.Vector3;points:Record<string,T.Vector3>;hipHeight:number}
const cache=new Map<string,Promise<SelectedClip>>();
export function loadSelectedMotion(id:string){
 const entry=catalog.find(e=>e.id===id);if(!entry)return Promise.reject(Error('这个动作没有被选中'));
 if(!cache.has(id))cache.set(id,fetch(`${import.meta.env.BASE_URL}room3d/motions/selected/${entry.file}`).then(async r=>{
  if(!r.ok)throw Error('动作读取失败，请重试');const clip=await r.json() as SelectedClip;
  if(clip.version!==1||clip.id!==id||clip.actors.length!==entry.participants)throw Error('动作数据不匹配');return clip;
 }).catch(e=>{cache.delete(id);throw e;}));return cache.get(id)!;
}
/** Clamp the last frame: paired actions never wrap independently. */
export function sampleSelected(track:MotionTrack,time:number):MotionFrame {
 const times=track.times,t=T.MathUtils.clamp(time,0,track.duration);let low=0,high=times.length-1;
 while(low+1<high){const mid=(low+high)>>1;if(times[mid]<=t)low=mid;else high=mid;}
 const blend=T.MathUtils.clamp((t-times[low])/(times[high]-times[low]||1),0,1);
 const vector=(values:number[])=>new T.Vector3().fromArray(values,low*3).lerp(new T.Vector3().fromArray(values,high*3),blend);
 return {rotations:Object.fromEntries(Object.entries(track.tracks).map(([name,v])=>[name,new T.Quaternion().fromArray(v,low*4).slerp(new T.Quaternion().fromArray(v,high*4),blend)])),position:vector(track.positions),points:Object.fromEntries(Object.entries(track.points).map(([n,v])=>[n,vector(v)])),hipHeight:track.hipHeight};
}
