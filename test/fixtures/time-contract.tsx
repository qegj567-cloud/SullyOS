import ChatCharacterProfile from '../../components/chat/ChatCharacterProfile';
import { MusicPreviewProvider } from '../../context/MusicContext';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import TimeContractCalendar from '../../components/schedule/TimeContractCalendar';
import Launcher from '../../apps/Launcher';
import { Capacitor, registerPlugin } from '@capacitor/core';
const alarmCalls: unknown[] = [];
const nativeFixture = new URLSearchParams(location.search).has('native');
if (nativeFixture) {
 Capacitor.getPlatform = () => 'android'; Capacitor.isNativePlatform = () => true;
 Capacitor.isPluginAvailable = name => name === 'SystemAlarm';
 registerPlugin('SystemAlarm', { web: async () => ({ getStatus: async () => ({ available:true }), createAlarm: async (options:unknown) => { alarmCalls.push(options); return {opened:true}; } }) });
}
const { default: ScheduleApp } = await import('../../apps/ScheduleApp');
import { OSPreviewProvider } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { resolveTimeContractTheme } from '../../utils/timeContract';
import { getLocalDateKey } from '../../utils/localDate';
import type { Task, Anniversary } from '../../types';
const emotionRole:any={id:'profile-qa',name:'小梨',avatar:'',scheduleFeatureEnabled:true,emotionConfig:{enabled:true},activeBuffs:[{id:'one',name:'calm',label:'安心',description:'听见熟悉的声音，放松了一点。',intensity:2}],buffInjection:'原来的安心'};
const today = getLocalDateKey();
const tasks: Task[] = Array.from({length: 75}, (_, i) => ({ id: 'task-'+i, title: i === 0 ? '今天记得整理资料和准备下周需要的用品' : '生活待办 '+i, deadline: today, supervisorId: '', tone: 'gentle', createdAt: i, isCompleted: i === 74 }));
const anniversaries: Anniversary[] = [{id:'anniversary', title:'值得纪念的一天', date:today, charId:'', aiThought:'<thinking>不能显示的推理</thinking>今天也要好好生活。'}];
Object.assign(window, { contractQA: { DB, today, alarmCalls } });
function Fixture() {
 const [view,setView]=useState('calendar'); const [theme,setTheme]=useState({scheduleAppTheme:'minimal'}); const [ready,setReady]=useState(false);
 const [data,setData]=useState({tasks,anniversaries});
 useEffect(() => { void (async()=> { for (const t of await DB.getAllTasks()) await DB.deleteTask(t.id); for (const a of await DB.getAllAnniversaries()) await DB.deleteAnniversary(a.id); for(const t of tasks) await DB.saveTask(t); for(const a of anniversaries) await DB.saveAnniversary(a); await DB.saveCharacter(emotionRole); setReady(true); })(); }, []);
 useEffect(()=>{const refresh=async()=>setData({tasks:await DB.getAllTasks(),anniversaries:await DB.getAllAnniversaries()});window.addEventListener('time-contract-changed',refresh);return()=>window.removeEventListener('time-contract-changed',refresh);},[]);
 const os:any={ theme, updateTheme:(patch:any)=>setTheme(prev=>({...prev,...patch})), openApp:(id:string)=>setView(id), closeApp:()=>setView('calendar'), characters:[], characterGroups:[], apiConfig:{apiKey:'',baseUrl:'',model:''}, userProfile:{name:'测试用户'}, addToast:()=>{}, activeCharacterId:null, isDataLoaded:true, unreadMessages:{}, lastMsgTimestamp:0, customIcons:{}, virtualTime:{hours:9,minutes:0} };
 return <OSPreviewProvider value={os}><MusicPreviewProvider value={{ current:null, playing:false, progress:0, duration:0 } as any}><div className="h-full flex flex-col bg-[#eee8dd]">
 <nav className="shrink-0 flex gap-2 p-2 text-xs"><button onClick={()=>setView('calendar')}>桌面</button><button onClick={()=>setView('launcher')}>完整桌面</button><button onClick={()=>setView('profile')}>角色名片</button><button onClick={()=>setView('schedule')}>时光契约</button>{['cyber','soft','minimal','system'].map(mode=><button key={mode} onClick={()=>setTheme({scheduleAppTheme:mode})}>{mode}</button>)}</nav>
 <div className="flex-1 min-h-0 overflow-hidden">{ready && (view==='profile' ? <ChatCharacterProfile character={emotionRole} schedule={null} onClose={()=>setView('calendar')} onSchedule={()=>{}} onPlayTheater={()=>{}} onMemory={()=>{}} /> : view==='launcher' ? <Launcher /> : view==='calendar' ? <TimeContractCalendar contentColor="#554433" openApp={os.openApp} anniversaries={data.anniversaries} tasks={data.tasks} characters={[]} mode={resolveTimeContractTheme(theme.scheduleAppTheme)} paper /> : view==='appearance' ? <p>外观入口已打开</p> : <ScheduleApp />)}</div>
 </div></MusicPreviewProvider></OSPreviewProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
