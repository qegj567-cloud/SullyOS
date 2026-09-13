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
 await page.goto('http://127.0.0.1:5183/test/fixtures/chat-decoration.html');await notice.waitFor();await notice.getByRole('button',{name:'知道了'}).click();
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
 assert.deepEqual(errors,[]);console.log('PASS independent first-entry notices, acknowledgement persistence, old Appearance entry removal, moved controls and scope isolation');
}finally{await browser.close();}
