import {expect,it} from 'vitest';
import catalog from '../public/room3d/catalog.json';
import {createHome} from '../apps/room3d/model.js';
import {createPetLife} from '../apps/room3d/petLife.js';
import {petHomeRecord} from './homePetRecords';
import {ContextBuilder} from './context';
import {DB} from './db';
import {loadCharacterContextMessages} from './chatContextRange';
import {buildChatRequestPayload} from './chatRequestPayload';
import type {CharacterProfile,UserProfile} from '../types';
const user={name:'小雨'} as UserProfile;
function setup(){const home=createHome(catalog);home.rooms[0].items=[];home.rooms[0].name='宠物活动室';home.records=[];const life=createPetLife({home:()=>home,catalog,onEvent:(event:any)=>{const record=petHomeRecord(event,home,user.name);if(record)home.records.push(record);}});life.data.autonomy=false;return {home,life};}
it('injects current pet names and species through the shared ContextBuilder, without leaking other homes',async ()=>{
 const {home,life}=setup();const p=life.adopt('pet_cat','年糕');life.adopt('pet_dog','布丁');const char={id:'pet-owner',name:'Sully',home3D:home,timeAwarenessEnabled:false} as CharacterProfile;
 const build=async ()=>(await ContextBuilder.buildCoreContext(char,user));
 expect(await build()).toContain('叫"年糕"的宠物，是一只猫');expect(await build()).toContain('叫"布丁"的宠物，是一只狗');
 p.name='团团';expect(await build()).toContain('叫"团团"');expect(await build()).not.toContain('年糕');
 expect((await ContextBuilder.buildCoreContext({...char,home3D:undefined},user))).not.toContain('家园里的宠物');
});
it('completed care enters the same stored home turn and actual private-chat payload, once; cancelled care does not',async()=>{
 const {home,life}=setup(),p=life.adopt('pet_cat','年糕');home.records=[];
 life.interact(p.id,'feed');life.step(1);expect(home.records).toHaveLength(0);life.runtime.delete(p.id);life.step(1);expect(home.records).toHaveLength(0);
 life.interact(p.id,'feed');for(let i=0;i<6;i++)life.step(1);expect(home.records).toHaveLength(1);expect(home.records[0].text).toBe('宠物「年糕」吃了小雨给的零食');
 life.interact(p.id,'play');for(let i=0;i<6;i++)life.step(1);expect(home.records).toHaveLength(2);
 const char={id:'pet-bridge-test',name:'Sully',home3D:home,contextRangePolicyVersion:1,contextRangeMode:'manual',contextLimit:50} as CharacterProfile;
 await DB.saveCharacter(char);await DB.saveCharacter(char);const rows=await loadCharacterContextMessages(char);expect(rows).toHaveLength(1);
 const payload=await buildChatRequestPayload({ scene: 'chat.private',char,userProfile:user,groups:[],emojis:[],categories:[],historyMsgs:rows,contextLimit:50,realtimeConfig:{weatherEnabled:false,newsEnabled:false} as any});
 expect(JSON.stringify(payload)).toContain('年糕');expect(rows[0].content).toContain('吃了小雨给的零食');expect(rows[0].content).toContain('和小雨玩了一会儿');
});
