import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
const out='output/chat-decoration';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>localStorage.setItem('sully-chat-decoration-announcement-v1:chat','seen'));
try{
 await page.goto('http://127.0.0.1:5183/test/fixtures/chat-decoration.html');
 const panel=page.getByRole('complementary',{name:'ChatApp 装扮'});await panel.waitFor();
 const tab=name=>panel.getByRole('navigation').getByRole('button',{name,exact:true});
 const state=()=>page.evaluate(()=>window.decorationQA);
 await page.screenshot({path:out+'/layout.png'});
 const transparency=panel.getByRole('slider',{name:'面板透明度'});await transparency.focus();assert.equal(await transparency.inputValue(),'100');await transparency.press('End');for(let i=0;i<8;i++)await transparency.press('ArrowLeft');assert.equal(await transparency.inputValue(),'60');assert.equal(await panel.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(250, 249, 252, 0.6)');assert.equal(await panel.evaluate(el=>getComputedStyle(el).opacity),'1');await page.screenshot({path:out+'/transparent.png'});
 await panel.getByRole('checkbox',{name:/单独调整布局/}).uncheck();assert.equal((await state()).char.chatFineTune.enabled,false);assert.equal((await state()).char.chatFineTune.chatBubbleFontSize,15);
 await tab('气泡').click();await panel.getByRole('button',{name:/Dream/}).click();assert.equal((await state()).char.bubbleStyle,'dream');assert((await state()).char.chromeCustomCss.includes('letter-spacing'));
 await page.screenshot({path:out+'/bubbles.png'});
 await tab('声音').click();await panel.getByRole('button',{name:'风铃',exact:true}).click();assert.equal((await state()).char.chatSound.src,'chime');
 await panel.getByText('绑定到进阶样式一起分享',{exact:true}).click();assert((await state()).char.chromeCustomCss.includes('@sully-sound'));assert.equal((await state()).char.chatSound,undefined);
 await panel.getByText('绑定到进阶样式一起分享',{exact:true}).click();assert.equal((await state()).char.chatSound.src,'chime');assert((await state()).char.chromeCustomCss.includes('letter-spacing'));
 await panel.getByRole('group',{name:'正在设置'}).getByRole('button',{name:'全局默认',exact:true}).click();await panel.getByRole('button',{name:'叮',exact:true}).click();assert.equal((await state()).theme.chatSound.src,'ding');assert.equal((await state()).char.chatSound.src,'chime');
 await tab('进阶').click();await page.screenshot({path:out+'/css.png'});await page.getByRole('button',{name:'还原全局 CSS',exact:true}).click();assert((await state()).char.chromeCustomCss.includes('letter-spacing'));
 await panel.getByRole('group',{name:'正在设置'}).getByRole('button',{name:'Sully专属',exact:true}).click();await page.getByRole('button',{name:'还原此角色 CSS',exact:true}).click();assert.equal((await state()).char.chromeCustomCss,'');assert.equal((await state()).char.chatSound.src,'chime');
 await tab('背景').click();await panel.getByLabel('选择背景图片').setInputFiles('public/icons/jellyfish-192.png');assert((await state()).char.chatBackground.startsWith('blob:'));
 await panel.getByRole('button',{name:'移除专属背景，跟随全局'}).click();assert.equal((await state()).char.chatBackground,undefined);
 await panel.getByRole('button',{name:'看效果',exact:true}).click();assert.equal(await panel.isVisible(),false);await page.getByRole('textbox',{name:'预览消息'}).fill('完整的聊天预览');await page.getByRole('button',{name:'发送预览消息'}).click();await page.getByText('完整的聊天预览',{exact:true}).waitFor();await page.screenshot({path:out+'/full-preview.png'});await page.getByRole('button',{name:'返回装扮',exact:true}).click();await tab('布局').click();
 await page.setViewportSize({width:320,height:568});await page.screenshot({path:out+'/small.png'});const bounds=await panel.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=321&&bounds.y>=0);
 await panel.getByRole('button',{name:'完成',exact:true}).click();assert.equal(await panel.count(),0);
 await page.goto('http://127.0.0.1:5183/test/fixtures/sar-user-module.html');await page.waitForFunction(()=>!!window.sarQA);
 await page.evaluate(async()=>{const DB=window.sarQA.DB;await DB.saveCharacter({id:'decoration-real',name:'装扮测试',avatar:'',systemPrompt:'测试',showThinkingChain:false});await DB.saveUserProfile({name:'小雨',avatar:'',bio:''});await DB.saveMessage({charId:'decoration-real',role:'assistant',type:'text',content:'来换个喜欢的样子吧。'});localStorage.setItem('os_last_active_char_id','decoration-real');});
 await page.reload();await page.locator('.sully-chat-name').filter({hasText:'装扮测试'}).waitFor();
 await page.getByRole('button',{name:'聊天功能',exact:true}).click();await page.getByRole('button',{name:'第 2 页',exact:true}).click();
 assert.equal(await page.getByRole('button',{name:'白框',exact:true}).count(),0);
 await page.getByRole('button',{name:'聊天装扮',exact:true}).click();await panel.waitFor();
 await tab('气泡').click();await panel.getByRole('button',{name:/Dream/}).click();
 for(let i=0;i<30;i++){if(await page.evaluate(async()=>(await window.sarQA.DB.getAllCharacters()).find(c=>c.id==='decoration-real')?.bubbleStyle==='dream'))break;await page.waitForTimeout(100);}
 assert.equal(await page.evaluate(async()=>(await window.sarQA.DB.getAllCharacters()).find(c=>c.id==='decoration-real').bubbleStyle),'dream');
 await page.screenshot({path:out+'/real-chat.png'});await panel.getByRole('button',{name:'看效果',exact:true}).click();assert.equal(await panel.isVisible(),false);const composer=await page.locator('.sully-chat-inputbar').boundingBox();const back=await page.getByRole('button',{name:'返回装扮',exact:true}).boundingBox();assert(back.y+back.height<composer.y);await page.screenshot({path:out+'/real-full-preview.png'});await page.getByRole('button',{name:'返回装扮',exact:true}).click();await panel.waitFor();assert.deepEqual(errors,[]);
 console.log('PASS tabs, layout preservation, bubble selection, sound binding, global/character isolation, CSS reset, background upload/removal, collapse and 320px');
}finally{await browser.close();}
