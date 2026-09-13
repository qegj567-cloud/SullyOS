import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
mkdirSync('output/chat-decoration',{recursive:true});
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:5183/test/fixtures/chat-decoration.html?appearance=1');
 const notice=page.getByRole('dialog',{name:'喜欢的样子，在一处调好。'});await notice.waitFor();
 assert.equal(await page.evaluate(()=>localStorage.getItem('sully-chat-decoration-announcement-v1:appearance')),null);
 await page.screenshot({path:'output/chat-decoration/announcement.png'});
 await page.setViewportSize({width:320,height:568});await page.screenshot({path:'output/chat-decoration/announcement-small.png'});
 assert.equal(await notice.evaluate(el=>el.scrollWidth>el.clientWidth),false);
 await notice.getByRole('button',{name:'知道了'}).click();
 assert.equal(await page.evaluate(()=>localStorage.getItem('sully-chat-decoration-announcement-v1:appearance')),'seen');
 await page.reload();await page.getByRole('heading',{name:'外观定制'}).waitFor();assert.equal(await notice.count(),0);
 assert.equal(await page.getByRole('button',{name:'聊天界面',exact:true}).count(),0);
 // ChatApp must announce the move before the user has found the decoration entry.
 await page.goto('http://127.0.0.1:5183/test/fixtures/sar-user-module.html');await page.waitForFunction(()=>!!window.sarQA);
 await page.evaluate(async()=>{await window.sarQA.DB.saveCharacter({id:'entry-fix',name:'入口测试',avatar:'',systemPrompt:'测试'});localStorage.setItem('os_last_active_char_id','entry-fix');});
 await page.reload();await notice.waitFor();
 assert.equal(await page.getByRole('complementary',{name:'ChatApp 装扮'}).count(),0);
 assert.equal(await page.evaluate(()=>localStorage.getItem('sully-chat-decoration-announcement-v1:chat')),null);
 await notice.getByRole('button',{name:'知道了'}).click();
 assert.equal(await page.evaluate(()=>localStorage.getItem('sully-chat-decoration-announcement-v1:chat')),'seen');
 await page.getByRole('button',{name:'聊天功能',exact:true}).click();
 for(const width of [320,390]){
  await page.setViewportSize({width,height:844});let first;
  for(let i=1;i<=3;i++){
   await page.getByRole('button',{name:'第 '+i+' 页',exact:true}).click();
   const grid=page.getByRole('group',{name:'聊天功能第 '+i+' 页',exact:true});
   assert.equal(await grid.getByRole('button').count(),i===3?2:8);
   const bounds=await grid.boundingBox();if(!first)first=bounds;else{assert.equal(bounds.height,first.height);assert.equal(bounds.y,first.y);}
   assert.equal(await grid.evaluate(el=>el.scrollWidth>el.clientWidth),false);
   if(i===2){await grid.getByRole('button',{name:'聊天装扮',exact:true}).waitFor();await grid.getByRole('button',{name:'相册',exact:true}).waitFor();}
   if(i===3){await grid.getByRole('button',{name:'记忆链接',exact:true}).waitFor();await grid.getByRole('button',{name:'收藏',exact:true}).waitFor();}
   await page.screenshot({path:'output/chat-decoration/actions-'+width+'-'+i+'.png'});
  }
 }
 // Swipe boundaries and action clicks still work with the new pagination.
 const swipe=async(dx)=>{const surface=page.getByRole('group',{name:/聊天功能第/}).locator('..');await surface.evaluate((el,delta)=>{for(const [type,x] of [['touchstart',200],['touchmove',200+delta],['touchend',200+delta]]){const event=new Event(type,{bubbles:true});Object.defineProperty(event,type==='touchend'?'changedTouches':'touches',{value:[{clientX:x,clientY:600}]});el.dispatchEvent(event);}},dx);};
 await swipe(-100);assert.equal(await page.getByRole('button',{name:'第 3 页',exact:true}).getAttribute('aria-current'),'page');
 await swipe(100);assert.equal(await page.getByRole('button',{name:'第 2 页',exact:true}).getAttribute('aria-current'),'page');
 // A synthesized click after swiping is swallowed; a subsequent deliberate click opens the panel.
 await page.getByRole('button',{name:'聊天装扮',exact:true}).click();await page.getByRole('button',{name:'聊天装扮',exact:true}).click();
 await page.getByRole('complementary',{name:'ChatApp 装扮'}).waitFor();assert.equal(await notice.count(),0);
 await page.reload();await page.getByRole('button',{name:'聊天功能',exact:true}).waitFor();assert.equal(await notice.count(),0);
 // An acknowledgement from the originally shipped decoration-only notice is also respected.
 await page.evaluate(()=>{localStorage.removeItem('sully-chat-decoration-announcement-v1:chat');localStorage.setItem('sully-chat-decoration-announcement-v1:decoration','seen');});
 await page.reload();await page.getByRole('button',{name:'聊天功能',exact:true}).waitFor();assert.equal(await notice.count(),0);
 await page.goto('http://127.0.0.1:5183/test/fixtures/chat-decoration.html');assert.equal(await notice.count(),0);
 await page.reload();await page.getByRole('complementary',{name:'ChatApp 装扮'}).waitFor();assert.equal(await notice.count(),0);
 const panel=page.getByRole('complementary',{name:'ChatApp 装扮'});const state=()=>page.evaluate(()=>window.decorationQA);
 const group=title=>panel.locator('details').filter({has:page.locator('summary').filter({hasText:title})});
 await group('头部与在线状态').locator('summary').click();await group('头部与在线状态').getByRole('button',{name:'圆点在线',exact:true}).click();
 assert.equal((await state()).char.chatAppearance.chatStatusStyle,'dot');assert.equal((await state()).theme.chatStatusStyle,undefined);
 await group('气泡与头像').locator('summary').click();await group('气泡与头像').getByRole('button',{name:'每条都显示 每条消息都带头像',exact:true}).click();
 assert.equal((await state()).char.chatAppearance.chatAvatarMode,'every_message');
 await group('表情包与输入栏').locator('summary').click();await group('表情包与输入栏').getByRole('button',{name:'大 160px · 旧版',exact:true}).click();assert.equal((await state()).char.chatAppearance.chatEmojiSize,'large');
 await panel.getByRole('checkbox',{name:/单独调整布局/}).uncheck();assert.equal((await state()).char.chatAppearance.chatEmojiSize,'large');assert.equal((await state()).char.chatFineTune.enabled,false);
 await panel.getByRole('group',{name:'正在设置'}).getByRole('button',{name:'全局默认',exact:true}).click();await group('头部与在线状态').locator('summary').click();await group('头部与在线状态').getByRole('button',{name:'状态胶囊',exact:true}).click();assert.equal((await state()).theme.chatStatusStyle,'pill');assert.equal((await state()).char.chatAppearance.chatStatusStyle,'dot');
 assert.deepEqual(errors,[]);console.log('PASS ChatApp entry notice, legacy acknowledgement, 8/8/2 action pages, stable height at 320/390px, swipes, moved controls and scope isolation');
}finally{await browser.close();}
