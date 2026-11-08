import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({load:vi.fn()}));
vi.mock('./dailySchedule',()=>({getDailyScheduleForChar:m.load}));
import {ContextBuilder} from './context';
import {DatePrompts} from './datePrompts';
import {buildHomeConversationPrompt} from './homeConversation';
const char:any={id:'c',name:'C',scheduleFeatureEnabled:true,customTimezoneEnabled:true,customTimezone:'America/New_York'};
const user:any={name:'U'};
const schedule={slots:[{startTime:'00:00',activity:'夜间安排'},{startTime:'09:00',activity:'日程标记画画'},{startTime:'22:00',activity:'晚间安排'}]};
beforeEach(()=>{m.load.mockReset().mockResolvedValue(schedule);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-07-26T13:30:00Z'));});
afterEach(()=>vi.useRealTimers());
it('default core includes current and full-day schedule even with false; changes are read each request',async()=>{
 let core=await ContextBuilder.buildCoreContext(char,user,false);
 expect(core).toContain('日程标记画画');expect(core).toContain('晚间安排');expect(core).toContain('当前时段：09:00');
 expect(m.load).toHaveBeenCalledWith(char);
 m.load.mockResolvedValue({slots:[{startTime:'00:00',activity:'已更新日程'}]});
 core=await ContextBuilder.buildCoreContext(char,user);
 expect(core).toContain('已更新日程');expect(core).not.toContain('日程标记画画');
});
it('feature off avoids loading; missing schedule does not generate anything',async()=>{
 expect(await ContextBuilder.buildCoreContext({...char,scheduleFeatureEnabled:false},user)).not.toContain('日程标记画画');
 expect(m.load).not.toHaveBeenCalled();m.load.mockResolvedValue(null);
 expect(await ContextBuilder.buildCoreContext(char,user)).not.toContain('日程标记画画');
});
it('private-chat split injects schedule once, worker templates defer it to execution',async()=>{
 const stable=await ContextBuilder.buildCoreContext(char,user,true,undefined,undefined,undefined,{deferVolatile:true});
 expect(stable).not.toContain('日程标记画画');expect(m.load).not.toHaveBeenCalled();
 const live=await ContextBuilder.buildVolatileCoreState(char);
 expect(live).toContain('日程标记画画');expect(m.load).toHaveBeenCalledTimes(1);
 m.load.mockClear();expect(await ContextBuilder.buildVolatileCoreState(char,{scheduleDelivery:'worker'})).not.toContain('日程标记画画');expect(m.load).not.toHaveBeenCalled();
});
it('home and date peek both include the same schedule without emotion opt-in',async()=>{
 const home=await buildHomeConversationPrompt(char,user,{roomId:'r',roomName:'客厅',present:true,busy:false,activity:'',actions:[]});
 const peek=await DatePrompts.buildPeekPayload({char,userProfile:user,allMsgs:[],emojis:[]});
 for(const text of [home,peek.messages.map(message=>message.content).join('\n')])expect(text).toContain('日程标记画画');
 expect(peek.messages[0].content).not.toContain('日程标记画画');
});

it('the lightweight role-settings entry also sees an enabled schedule',async()=>{
 expect(await ContextBuilder.buildRoleSettingsContext(char,{skipMemories:true})).toContain('日程标记画画');
});
