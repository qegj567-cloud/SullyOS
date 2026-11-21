import {readFile,writeFile,mkdir} from 'node:fs/promises';
const dark=JSON.parse(await readFile(new URL('./acid-orbit.sully.json',import.meta.url),'utf8'));
dark.name='星轨 · 深空';
const light=structuredClone(dark);light.name='星轨 · 雾紫';
const lavender=await readFile(new URL('./lavender.css',import.meta.url),'utf8');
const cardPalette=await readFile(new URL('./lavender-card-palette.css',import.meta.url),'utf8');
light.parts.css=light.parts.css.replaceAll('%231c2036','%23e9e0f2').replaceAll("stroke='%23d9cbed'","stroke='%23765b8d'")+'\n'+lavender.replace('/* @lavender-card-palette */',cardPalette.trim()).replace(/\r\n/g,'\n');
light.parts.bubbles.name='雾紫星轨';light.parts.bubbles.id='acid-orbit-lavender';
for(const side of ['ai','user'])Object.assign(light.parts.bubbles[side],{textColor:'#493958',backgroundColor:side==='ai'?'#f5effa':'#dcc9f0',voiceBarBg:'#eee5f7',voiceBarActiveBg:'#ded0ee',voiceBarTextColor:'#584367',voiceBarWaveColor:'#9478af'});
await mkdir(new URL('../../presets/chat/',import.meta.url),{recursive:true});
for(const [id,preset] of [['acid-orbit',dark],['acid-orbit-lavender',light]]){
 await writeFile(new URL('../../presets/chat/'+id+'.json',import.meta.url),JSON.stringify(preset,null,2)+'\n');
 await writeFile(new URL('./'+id+'.sully.json',import.meta.url),JSON.stringify(preset,null,2)+'\n');
}
