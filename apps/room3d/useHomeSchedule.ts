import {useEffect,useRef,useState} from 'react';
import type {CharacterProfile,ScheduleSlot} from '../../types';
import type {HomeEditor} from './editor.js';
import {getDailyScheduleForChar} from '../../utils/dailySchedule';
import {homePresence} from '../../utils/homePresence';
import {isScheduleFeatureOn} from '../../utils/scheduleFeature';
import {getCurrentScheduleSlotIndex} from '../../utils/scheduleTime';
import {chooseHomeAction} from '../../utils/homeAutonomy';
import {readHomeVisits,presentHomeVisit,HOME_VISITS_EVENT} from '../../utils/homeVisits';

export function useHomeSchedule(editor:HomeEditor|undefined,character:CharacterProfile|undefined,ready:boolean,suspended:boolean){
 const [away,setAway]=useState(false),[plan,setPlan]=useState<{key:string;roomId:string;activity:string}>();
 const [currentSchedule,setCurrentSchedule]=useState<Pick<ScheduleSlot,'startTime'|'activity'>|null>(null);
 const latest=useRef(character);latest.current=character;
 const attempted=useRef(new Set<string>());
 useEffect(()=>()=>{editor?.finishAutonomousAction?.();},[editor,plan?.key]);
 useEffect(()=>{
  if(!editor||!character||suspended)return;
  setCurrentSchedule(null);
  let cancelled=false,first=true;
  const refresh=async()=>{
   const char=latest.current!;
   try{const visit=presentHomeVisit(await readHomeVisits(),char.id);if(cancelled)return;if(visit){editor.setResidentRoom(null,first);first=false;editor.setScheduleLabel(char.name+' · 正在串门');setCurrentSchedule(null);setAway(true);setPlan(undefined);return;}}catch(error){console.error('[Home visit] presence',error);return;}
   if(!isScheduleFeatureOn(char)){editor.setResidentRoom(undefined,first);first=false;editor.setScheduleLabel('');setCurrentSchedule(null);setAway(false);setPlan(undefined);return;}
   try{
    const now=new Date(),schedule=await getDailyScheduleForChar(char,now);if(cancelled)return;
    const position=homePresence(schedule,char,now),slot=schedule?.slots[getCurrentScheduleSlotIndex(schedule.slots,char,now)];
    editor.setResidentRoom(position?.kind==='home'?position.roomId:position?.kind==='away'?null:undefined,first);first=false;
    editor.setScheduleLabel(slot?char.name+' · '+slot.startTime+' '+slot.activity:'');
    setCurrentSchedule(slot?{startTime:slot.startTime,activity:slot.activity}:null);
    setAway(position?.kind==='away');
    setPlan(position?.kind==='home'&&slot?{key:`${schedule!.date}:${slot.startTime}:${position.roomId}:${slot.activity}`,roomId:position.roomId,activity:slot.activity}:undefined);
   }catch{/* A transient DB failure must not invent presence. */}
  };
  void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},60000);
  const focus=()=>{if(!document.hidden)void refresh();};document.addEventListener('visibilitychange',focus);window.addEventListener(HOME_VISITS_EVENT,focus);
  return()=>{cancelled=true;clearInterval(timer);document.removeEventListener('visibilitychange',focus);window.removeEventListener(HOME_VISITS_EVENT,focus);};
 },[editor,suspended,character?.id,character?.scheduleFeatureEnabled,character?.scheduleStyle,character?.customTimezone,character?.customTimezoneEnabled]);
 useEffect(()=>{
  if(!editor||!ready||suspended||!plan)return;
  const run=()=>{
   if(document.hidden||attempted.current.has(plan.key)||editor.getState?.().autonomy===false)return;
   const scene=editor.getHomeScene();if(!scene.present||scene.roomId!==plan.roomId||scene.busy)return;
   const action=chooseHomeAction(plan.activity,scene.actions);if(!action){attempted.current.add(plan.key);return;}
   const result=editor.performHomeAction(action.id,'local');
   // Once per slot: manual interruptions never cause an immediate restart.
   attempted.current.add(plan.key);
  };
  run();const timer=setInterval(run,15000);return()=>clearInterval(timer);
 },[editor,ready,suspended,plan?.key]);
 return {away,currentSchedule};
}
