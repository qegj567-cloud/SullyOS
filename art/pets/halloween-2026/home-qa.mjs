import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1200,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5204/test/fixtures/home-pets.html',{waitUntil:'commit'});await page.waitForFunction(()=>window.__homeEditor,{},{timeout:120000});
 if(await page.getByRole('button',{name:'知道了',exact:true}).count())await page.getByRole('button',{name:'知道了',exact:true}).click();
 await page.evaluate(()=>{const s=window.__homeEditor.getPetSystem();s.open(s.life.data.pets.find(p=>p.assetId==='pet_hamster').id);});
 await page.locator('[data-pet-action="detail-tab"][data-tab="wardrobe"]').click();await page.locator('[data-pet-hat="witch"]').click();
 assert.equal(await page.locator('[data-pet-hat="witch"]').getAttribute('aria-pressed'),'true');await page.screenshot({path:'art/pets/halloween-2026/home-wardrobe.png'});
 assert.deepEqual(errors,[]);console.log('Home3DView wardrobe verified');
}finally{await browser.close();}
