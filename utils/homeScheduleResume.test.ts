// @vitest-environment jsdom
import React,{act} from 'react';import {createRoot} from 'react-dom/client';import {it,expect,vi} from 'vitest';import {useHomeSchedule} from '../apps/room3d/useHomeSchedule';
const m=vi.hoisted(()=>({load:vi.fn(),presence:vi.fn()}));
vi.mock('./dailySchedule',()=>({getDailyScheduleForChar:m.load}));vi.mock('./homePresence',()=>({homePresence:m.presence}));vi.mock('./scheduleFeature',()=>({isScheduleFeatureOn:()=>true}));vi.mock('./scheduleTime',()=>({getCurrentScheduleSlotIndex:()=>0}));
vi.mock('./homeVisits',()=>({readHomeVisits:async()=>[],presentHomeVisit:()=>undefined,HOME_VISITS_EVENT:'home-visits-changed'}));
it('restores the scheduled room on reentry, and publishes the current activity',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 m.load.mockResolvedValue({date:'test',slots:[{startTime:'09:00',activity:'阅读'}]});m.presence.mockReturnValue({kind:'home',roomId:'study'});
 const editor:any={setResidentRoom:vi.fn(),setScheduleLabel:vi.fn(),finishAutonomousAction:vi.fn()};const char:any={id:'c',name:'C'};
 function Harness({suspended}:{suspended:boolean}){useHomeSchedule(editor,char,false,suspended);return null;}
 const host=document.createElement('div'),root=createRoot(host);
 try{await act(async()=>root.render(React.createElement(Harness,{suspended:false})));expect(editor.setResidentRoom).toHaveBeenLastCalledWith('study',true);expect(editor.setScheduleLabel).toHaveBeenLastCalledWith('C · 09:00 阅读');
 await act(async()=>root.render(React.createElement(Harness,{suspended:true})));editor.setResidentRoom.mockClear();
 await act(async()=>root.render(React.createElement(Harness,{suspended:false})));expect(editor.setResidentRoom).toHaveBeenLastCalledWith('study',true);
 }finally{await act(async()=>root.unmount());}
});
