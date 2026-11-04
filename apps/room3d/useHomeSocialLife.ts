import {useEffect} from 'react';
import type {HomeEditor} from './editor.js';
import {DB} from '../../utils/db';
import {homeSocialPair} from '../../utils/homeSocialRelations';

/** Independent guest clocks; local choices never call an API. */
export function useHomeSocialLife(editor:HomeEditor|undefined,ownerId:string|undefined,enabled:boolean,onError:(message:string)=>void){
 useEffect(()=>{if(!editor||!ownerId||!enabled)return;let disposed=false,running=false;
  const clocks=new Map<string,number>();
  const tick=async()=>{if(running||document.hidden||editor.isSocialReplyBusy()||editor.getState().autonomy===false)return;running=true;
   try{const members=editor.getPresentResidents().filter(p=>p.id!=='user'),now=Date.now();
    for(const id of clocks.keys())if(!members.some(p=>p.id===id))clocks.delete(id);
    const chars=await Promise.all(members.map(p=>DB.getCharacter(p.id)));if(disposed)return;
    for(const p of members){if(p.id===ownerId)continue;if(!clocks.has(p.id)){clocks.set(p.id,now+8000+Math.random()*10000);continue;}if(now<clocks.get(p.id)!)continue;
     const char=chars.find(c=>c?.id===p.id);if(!char)continue;
     const options=editor.getGuestActions(p.id);if(!options.length)continue;
     const pace={quiet:1.6,normal:1,lively:.65}[editor.getState().activityFrequency||'normal'];
     clocks.set(p.id,now+(18000+Math.random()*18000)*pace);
     const targets=chars.filter((c):c is NonNullable<typeof c>=>!!c&&c.id!==char.id).filter(other=>{const pair=homeSocialPair(char,other);return pair.receptive&&!pair.blocked&&Math.random()<pair.approach;});
     if(targets.length&&Math.random()<.25&&!editor.getHomeScene().busy&&editor.getResidentPosture?.(p.id)==='standing'){
      const target=targets[Math.floor(Math.random()*targets.length)];if(editor.getResidentPosture?.(target.id)==='standing'&&!editor.getResidentScene(target.id).busy){await editor.playSocial('cmu-18_08',p.id,target.id,'local');break;}
     }
     const stand=options.find(a=>a.kind==='stand'),seats=options.filter(a=>a.kind==='sit');
     const choice=stand||(seats.length&&Math.random()<.45?seats[Math.floor(Math.random()*seats.length)]:options[Math.floor(Math.random()*Math.min(2,options.length))]);
     editor.performGuestAction(p.id,choice.id);
    }
   }catch(error){if(!disposed)onError(error instanceof Error?error.message:'居民活动读取失败');}finally{running=false;}
  };
  void tick();const timer=setInterval(()=>void tick(),3000);return()=>{disposed=true;clearInterval(timer);};
 },[editor,ownerId,enabled]);
}
