import {expect,it} from 'vitest';
import {beautyShareContents,selectBeautyShareContents} from './beautyShareContents';
const pack={type:'sully_appearance_preset',version:1,name:'作品',theme:{wallpaper:'image',chatSound:{src:'personal-sound'},chatDefaultBubbleStyle:'b1',chatChromeCustomCss:'/* @sully-sound {"src":"personal"} */ .header{color:red} /* @sully-sound {"src":"second"} */'},chatThemes:[{id:'b1',name:'蓝'},{id:'b2',name:'粉'}]};
it('keeps all supported contents by default and exposes what will be shared',()=>{
 expect(selectBeautyShareContents(pack)).toEqual(pack);expect(beautyShareContents(pack).map(x=>x.key)).toEqual(['theme','css','layout','bubbles','sound']);
});
it('omits deselected sound and bubbles only in the outgoing copy, including embedded sound directives',()=>{
 const original=structuredClone(pack);const result=selectBeautyShareContents(pack,{sound:false,bubbles:false});
 expect(result.theme).not.toHaveProperty('chatSound');expect(result.theme.chatChromeCustomCss).not.toContain('sully-sound');
 expect(result.theme.chatChromeCustomCss).toContain('.header{color:red}');expect(result.theme.wallpaper).toBe('image');
 expect(result).not.toHaveProperty('chatThemes');expect(result.theme).not.toHaveProperty('chatDefaultBubbleStyle');expect(pack).toEqual(original);
});
it('keeps bubbles when only sound is unchecked and vice versa',()=>{
 expect(selectBeautyShareContents(pack,{sound:false,bubbles:true}).chatThemes).toEqual(pack.chatThemes);
 expect(selectBeautyShareContents(pack,{sound:true,bubbles:false}).theme.chatSound).toEqual(pack.theme.chatSound);
});
it('also allows omitting a chat outfit sound and an explicit mute',()=>{
 const chat={format:'sullyos-chat-decoration',parts:{css:'.header{}',sound:null,bubbles:{name:'气泡'}}};
 expect(beautyShareContents(chat).some(x=>x.key==='sound')).toBe(true);
 expect(selectBeautyShareContents(chat,{sound:false,bubbles:false}).parts).toEqual({css:'.header{}'});
});

it('lists every structured whitebox part and keeps only checked sections',()=>{
 const whitebox={format:'sullyos-chat-decoration',parts:{css:'.header{color:red} /* sully-composer:avatar */ .frame{} /* end-sully-composer:avatar */ /* sully-composer:background */ .bg{} /* end-sully-composer:background */',layout:{chatAvatarShape:'square'},bubbles:{name:'粉'},background:{image:'background'},psyche:{styleId:'echo'},sound:{src:'bell'}}};
 expect(beautyShareContents(whitebox).map(x=>x.key)).toEqual(['css','layout','bubbles','avatar','background','psyche','sound']);
 const selected=selectBeautyShareContents(whitebox,{css:false,layout:false,bubbles:false,background:false,sound:false});
 expect(Object.keys(selected.parts).sort()).toEqual(['css','psyche']);expect(selected.parts.css).toContain('.frame{}');expect(selected.parts.css).not.toContain('.bg{}');expect(selected.parts.css).not.toContain('.header');
});
it('supports each app style and keeps sound declarations when CSS alone is deselected',()=>{
 for(const part of ['date','story','schedule','journal'])expect(beautyShareContents({format:'sullyos-chat-decoration',parts:{[part]:{preset:'paper'}}}).map(x=>x.key)).toEqual([part]);
 const result=selectBeautyShareContents(pack,{css:false});expect(result.theme.chatSound.src).toBe('personal');expect(result.theme.chatChromeCustomCss).toBeUndefined();
});
it('removes each desktop auxiliary section without dropping the base theme',()=>{
 const value={...pack,customIcons:{chat:'icon'},chatLayout:{id:'layout'},theme:{...pack.theme,chatBackground:'bg',chatBackgroundStyle:'plain',chatPsyche:{styleId:'echo'},scheduleCardAppearance:{preset:'paper'},journalAppearance:{preset:'paper'},storyAppearance:{preset:'novel'}}};
 const result=selectBeautyShareContents(value,{icons:false,css:false,layout:false,bubbles:false,background:false,psyche:false,sound:false,schedule:false,journal:false,story:false});
 expect(result.theme).toEqual({wallpaper:'image'});expect(result.customIcons).toBeUndefined();expect(result.chatThemes).toBeUndefined();expect(result.chatLayout).toBeUndefined();
});
