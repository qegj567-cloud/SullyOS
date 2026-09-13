import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
const out='output/boot-jellyfish';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
const url='http://127.0.0.1:5183/test/fixtures/boot-jellyfish.html';
try {
 await page.goto(url);await page.locator('.sully-boot-bell').waitFor();
 await page.waitForTimeout(1500);await page.screenshot({path:out+'/mobile.png'});
 assert.equal(await page.locator('.sully-boot').getAttribute('data-cinematic'),'true');
 assert.equal(await page.locator('.sully-boot img, .sully-boot canvas, .sully-boot svg').count(),0);
 assert.equal(await page.locator('.sully-boot').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(18, 18, 26)');
 await page.waitForTimeout(1500);assert.equal(await page.locator('.sully-boot').getAttribute('data-phase'),'enter');
 await page.evaluate(()=>window.dispatchEvent(new Event('boot-ready')));await page.getByText('已进入桌面').waitFor();
 await page.reload();assert.equal(await page.locator('.sully-boot').getAttribute('data-cinematic'),'false');
 await page.getByRole('button',{name:'SullyOS·糯米机，轻触进入'}).focus();await page.keyboard.press('Enter');await page.getByText('已进入桌面').waitFor();
 await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>sessionStorage.clear());await page.goto(url);
 assert.equal(await page.locator('.sully-boot').getAttribute('data-cinematic'),'false');
 assert.equal(await page.locator('.sully-boot-jelly').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.setViewportSize({width:320,height:568});await page.screenshot({path:out+'/small-reduced.png'});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.emulateMedia({reducedMotion:'no-preference'});await page.evaluate(()=>sessionStorage.clear());await page.setViewportSize({width:1440,height:900});await page.goto(url);await page.waitForTimeout(1500);await page.screenshot({path:out+'/desktop.png'});

 await page.goto(url+'?ready');await page.getByText('已进入桌面').waitFor();
 await page.goto('http://127.0.0.1:5183/test/fixtures/boot-choice.html');
 const classic=page.getByRole('button',{name:'原版 壁纸柔光 · 文字浮现'});
 const jelly=page.getByRole('button',{name:'水母 紫色星光 · 小水母'});
 await classic.click(); await page.getByText('已保存',{exact:true}).waitFor(); await page.reload(); await classic.waitFor();
 assert.equal(await classic.getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'预览所选开场'}).click();
 await page.locator('[aria-label="SullyOS·糯米机"]').waitFor();
 assert.equal(await page.locator('.sully-boot').count(),0);
 await page.locator('[aria-label="SullyOS·糯米机"]').click();await jelly.click();await page.getByText('已保存',{exact:true}).waitFor();await page.reload();await jelly.waitFor();
 assert.equal(await jelly.getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'预览所选开场'}).click();await page.locator('.sully-boot').waitFor();
 await page.screenshot({path:out+'/selected-jellyfish.png'});
 assert.deepEqual(errors,[]);console.log('PASS CSS artwork, exact background, no image/canvas/SVG, data gate, automatic exit, session short mode, keyboard skip, reduced motion, responsive layouts');
}finally{await browser.close();}
