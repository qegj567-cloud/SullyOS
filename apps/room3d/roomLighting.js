import * as T from 'three';
import {nowInTimeZone} from '../../utils/timezone';

// Art-directed time bands, not astronomical sunrise/sunset. Preserve readable
// local colours in every phase; use the sky and light colour for atmosphere.
export const ROOM_LIGHT_PHASES={
 morning:{directSun:true,sunPower:4.8,label:'清晨',sky:'#e2efff',ground:'#ddd9ef',ambient:1.3,key:'#fff0da',keyPower:1.8,fill:'#e3efff',fillPower:.55,window:'#ffe6ba',windowPower:.78,background:'#ebe6ef',shade:'#ebefff',sun:'#fff5e7',brightness:1,skyTop:'#a3d3f3',skyBottom:'#ffe7ce',cloud:'#fff9f2',night:0,character:'#fffaf2'},
 day:{label:'白天',sky:'#f4faff',ground:'#e6dfed',ambient:1.85,key:'#fff9eb',keyPower:2.4,fill:'#e7f4ff',fillPower:.65,window:'#fff0ce',windowPower:1,background:'#eee8ef',shade:'#edf3ff',sun:'#fffaf0',brightness:1.04,skyTop:'#70c6fa',skyBottom:'#f4fbff',cloud:'#ffffff',night:0,character:'#ffffff'},
 sunset:{directSun:true,sunPower:4.6,sunContrast:.6,shadeSoftness:.7,label:'夕阳',sky:'#eee9e3',ground:'#d6cfc7',ambient:1.2,key:'#ffe9cf',keyPower:1.8,fill:'#e7e8ec',fillPower:.6,window:'#ffd3a3',windowPower:1,background:'#e9e2da',shade:'#e6e2de',sun:'#ffe9cf',brightness:1,skyTop:'#c4c4cb',skyBottom:'#f7d7b2',cloud:'#fff0df',night:0,character:'#fff5e9'},
 night:{label:'夜晚',sky:'#d2deff',ground:'#cabddc',ambient:1.3,key:'#ffe6c8',keyPower:1.75,fill:'#aec7ff',fillPower:.5,window:'#adcbff',windowPower:.16,background:'#cccbdc',shade:'#dce5ff',sun:'#fff0db',brightness:.86,skyTop:'#24375d',skyBottom:'#6a7397',cloud:'#91a1be',night:1,character:'#f3eeff'},
};
export function roomLightPhase(timeZone,base=new Date()){
 const hour=nowInTimeZone(timeZone,base).getHours();
 return hour>=5&&hour<8?'morning':hour>=8&&hour<16?'day':hour>=16&&hour<19?'sunset':'night';
}
export function resolveRoomLightPhase(mode,timeZone,base){
 return Object.hasOwn(ROOM_LIGHT_PHASES,mode)?mode:roomLightPhase(timeZone,base);
}
// These uniform objects are shared by this editor's materials. Changing time
// updates values only: no rebuild, shader compilation or new render pass.
export function createRoomLightUniforms(){
 return {skySunset:{value:0},roomSunContrast:{value:0},roomShadeSoftness:{value:0},roomShadeTint:{value:new T.Color()},roomSunTint:{value:new T.Color()},roomBrightness:{value:1},skyTop:{value:new T.Color()},skyBottom:{value:new T.Color()},skyCloud:{value:new T.Color()},skyNight:{value:0}};
}
export function updateRoomLightUniforms(uniforms,profile){
 for(const [key,field]of [['roomShadeTint','shade'],['roomSunTint','sun'],['skyTop','skyTop'],['skyBottom','skyBottom'],['skyCloud','cloud']])uniforms[key].value.set(profile[field]);
 uniforms.roomBrightness.value=profile.brightness;uniforms.skyNight.value=profile.night;
 uniforms.roomSunContrast.value=profile.directSun?(profile.sunContrast??1):0;
 uniforms.roomShadeSoftness.value=profile.shadeSoftness??0;
 uniforms.skySunset.value=profile===ROOM_LIGHT_PHASES.sunset?1:0;
}
