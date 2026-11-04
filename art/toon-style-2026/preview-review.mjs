import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const dir='art/toon-style-2026/preview';await fs.mkdir(dir,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const report={errors:[],failed:[]};
try{
 const page=await browser.newPage({viewport:{width:1200,height:800}});page.setDefaultTimeout(120000);
 page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});page.on('requestfailed',r=>report.failed.push({url:r.url(),failure:r.failure()}));
 await page.goto('http://127.0.0.1:5206/test/fixtures/chibi-toon.html',{waitUntil:'domcontentloaded',timeout:120000});
 await page.waitForFunction(()=>document.querySelectorAll('.puppet canvas').length===2&&Array.from(document.querySelectorAll('.puppet')).every(p=>Number(p.dataset.drawCalls)>0));
 await page.waitForTimeout(1200);await page.screenshot({path:dir+'/front.png'});report.front=await page.evaluate(()=>JSON.parse(window.render_game_to_text()));
 await page.getByRole('slider',{name:'转动人物'}).fill('-115');await page.waitForTimeout(500);await page.screenshot({path:dir+'/side.png'});report.side=await page.evaluate(()=>JSON.parse(window.render_game_to_text()));
}catch(error){report.failure=error.message;const page=browser.contexts()[0]?.pages()[0];if(page){report.text=await page.locator('body').innerText({timeout:1000}).catch(()=> '');await page.screenshot({path:dir+'/failure.png'});}}
finally{await fs.writeFile(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();}
