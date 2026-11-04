import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const stage=process.argv[2]||'after',browser=await chromium.launch({channel:'msedge',headless:true});
try{const page=await browser.newPage({viewport:{width:1100,height:900}});await page.goto('http://127.0.0.1:5199/art/halloween-2026/meshy/assembled/index.html?outfit=pumpkin');await page.waitForFunction(()=>window.ready,{},{timeout:60000});if(stage==='nomask')await page.locator('#mask').uncheck();await page.locator('aside').evaluate(e=>e.style.display='none');
 for(const pose of ['costume','bind','knee']){await page.selectOption('#pose',pose,{force:true});for(const view of ['front','side','back']){
  await page.evaluate(view=>{const f=window.fitting;f.camera.position.set(view==='side'?3.6:0,2.06,view==='front'?3.6:view==='back'?-3.6:0);f.controls.target.set(0,1.95,0);f.controls.update();f.render();},view);
  await page.screenshot({path:`art/halloween-2026/meshy/assembled/cuffs-${stage}-${pose}-${view}.png`});
 }}console.log(stage,'9 close views captured');}finally{await browser.close();}
