import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
const out='output/app-icon-choice';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const manifest=()=>page.locator('link[rel="manifest"]').getAttribute('href');
try{
    await page.goto('http://127.0.0.1:5183/test/fixtures/app-icon-choice.html');
    await page.getByRole('button',{name:'水母 · 已选',exact:true}).waitFor();
    await page.screenshot({path:out+'/choices.png'});
    await page.getByRole('button',{name:'经典',exact:true}).click();
    await page.getByRole('button',{name:'经典 · 已选',exact:true}).waitFor();
    assert((await manifest()).endsWith('manifest-classic.webmanifest'));
    assert.equal(await page.locator('link[rel="apple-touch-icon"]').count(),1);
    await page.reload();await page.getByRole('button',{name:'经典 · 已选',exact:true}).waitFor();
    assert((await manifest()).endsWith('manifest-classic.webmanifest'));
    await page.locator('input[type="file"]').setInputFiles('public/icons/jellyfish-512.png');
    await page.getByText('已设置自定义图标',{exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('link[rel="manifest"]').href.startsWith('blob:'));
    await page.getByRole('button',{name:'水母',exact:true}).click();
    await page.getByRole('button',{name:'水母 · 已选',exact:true}).waitFor();
    assert((await manifest()).endsWith('/manifest.webmanifest'));
    assert(new URL(await page.locator('link[rel="apple-touch-icon"]').getAttribute('href'),page.url()).pathname.endsWith('jellyfish-180.png'));
    await page.reload();await page.getByRole('button',{name:'水母 · 已选',exact:true}).waitFor();
    await page.setViewportSize({width:320,height:740});await page.screenshot({path:out+'/choices-320.png'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);console.log('PASS built-in choices, manifest, reload, custom upload, reset, 320px');
}finally{await browser.close();}
