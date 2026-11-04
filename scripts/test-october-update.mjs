import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const dir='output/october-update';mkdirSync(dir,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
const headings=['彼方也要万圣节！','家里也要过万圣！','来哔哔，聊点日常'];
try{
    for(const [width,height] of [[390,844],[320,568],[1100,920]]){
        await page.setViewportSize({width,height});await page.goto('http://127.0.0.1:5177/test/fixtures/october-update.html');
        for(let step=0;step<3;step++){
            await page.getByRole('heading',{name:headings[step],exact:true}).waitFor();
            await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth));
            const box=await page.getByRole('dialog').boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height);
            const action=page.getByRole('button',{name:step===2?'知道啦':'下一页',exact:true});const a=await action.boundingBox();assert(a.y>=0&&a.y+a.height<=height);
            assert.equal(await page.getByRole('dialog').evaluate(d=>d.scrollWidth>d.clientWidth),false);
            assert.equal(await page.locator('.october-release-scroll').evaluate(d=>d.scrollWidth>d.clientWidth),false);
            assert.equal(await page.getByRole('dialog').getByRole('link').count(),0);
            assert.equal(await page.evaluate(()=>localStorage.getItem('sullyos_update_2026_10_halloween_seen')),null);
            if(step>0) assert.equal(await page.locator('dialog h2').evaluate(h=>h===document.activeElement),true);
            await page.screenshot({path:dir+'/page-'+(step+1)+'-'+width+'.png'});
            await page.locator('.october-release-scroll').evaluate(el=>el.scrollTop=el.scrollHeight);
            await page.screenshot({path:dir+'/details-'+(step+1)+'-'+width+'.png'});
            if(step===1){
                await page.getByRole('button',{name:'上一页',exact:true}).click();
                await page.getByRole('heading',{name:headings[0],exact:true}).waitFor();
                assert.equal(await page.locator('.october-release-scroll').evaluate(el=>el.scrollTop),0);
                await page.getByRole('button',{name:'下一页',exact:true}).click();
                await page.getByRole('heading',{name:headings[1],exact:true}).waitFor();
            }
            await action.click();
        }
        await page.getByText('已关闭预览',{exact:true}).waitFor();
        assert.equal(new URL(page.url()).pathname,'/test/fixtures/october-update.html');
        assert.equal(await page.evaluate(()=>localStorage.getItem('sullyos_update_2026_10_halloween_seen')),null);
        await page.getByRole('button',{name:'重新看弹窗'}).click();
        await page.getByRole('button',{name:'下一页',exact:true}).click();
        await page.keyboard.press('Escape');await page.getByText('已关闭预览',{exact:true}).waitFor();
    }
    assert.deepEqual(errors,[]);writeFileSync(dir+'/result.json',JSON.stringify({passed:true,pages:3,viewports:3,errors},null,2));
}finally{await browser.close();}
