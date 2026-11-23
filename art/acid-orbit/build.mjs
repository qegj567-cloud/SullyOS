import {readFile, writeFile} from 'node:fs/promises';
const css = (await readFile(new URL('./acid-orbit.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const bubble = (textColor, backgroundColor) => ({textColor, backgroundColor, borderRadius:21, opacity:1, tailMode:'none',voiceBarBg:'#292b41',voiceBarActiveBg:'#47405f',voiceBarBtnColor:'#c4b0ff',voiceBarWaveColor:'#e2d6ff',voiceBarTextColor:'#f4efff'});
const preset = {
  format:'sullyos-chat-decoration',version:1,name:'ACID ORBIT · 酸性星轨',
  parts:{
    layout:{chatAvatarMode:'grouped',chatAvatarShape:'circle',chatAvatarSize:'medium',chatAvatarVisibility:'both',chatAvatarPlacement:'beside',chatAvatarAlign:'top',chatBubbleStyle:'modern',chatMessageSpacing:'spacious',chatShowTimestamp:'always',chatHeaderStyle:'default',chatInputStyle:'rounded',chatChromeStyle:'soft',chatHeaderAlign:'left',chatHeaderDensity:'default',chatStatusStyle:'subtle',chatSendButtonStyle:'circle',chatModuleAlign:'center',chatHideHeaderBuffs:false},
    bubbles:{id:'acid-orbit',name:'酸性星轨',type:'custom',user:bubble('#25223f','#d4c8f6'),ai:bubble('#f1edff','#292b40')},
    background:{image:null,style:'plain'},
    psyche:{styleId:'stellar'},css
  }
};
await writeFile(new URL('./acid-orbit.sully.json',import.meta.url),JSON.stringify(preset,null,2)+'\n');
console.log('Generated acid-orbit.sully.json');
