import {readFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
// Use the real shell CSS rules, with injected measured insets instead of device hardware.
const index=await readFile('index.html','utf8');
const shellCSS=[':root','html.sully-statusbar-hidden','html.sully-statusbar-compact'].map(selector=>{
    const start=index.indexOf(`${selector} {`),end=index.indexOf('}',start);
    assert(start>=0);return index.slice(start,end+1);
}).join('\n');
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
await mkdir('output/bibi-settings',{recursive:true});
let checks=0;
async function checkInsets(embedded=false){
    for(const inset of [0,44,62])for(const mode of ['standard','hidden','compact']){
        await page.evaluate(({inset,mode})=>{
            const root=document.documentElement;
            root.style.setProperty('--standalone-safe-area-top',`${inset}px`);
            root.style.setProperty('--standalone-safe-area-bottom','34px');
            root.classList.toggle('sully-statusbar-hidden',mode==='hidden');
            root.classList.toggle('sully-statusbar-compact',mode==='compact');
        },{inset,mode});
        const geometry=await page.locator('.friend-feed').evaluate(app=>{
            const header=app.querySelector('header'),back=header.querySelector('button'),a=app.getBoundingClientRect(),h=header.getBoundingClientRect(),b=back.getBoundingClientRect();
            return {top:h.top-a.top,buttonTop:b.top-a.top,width:b.width,height:b.height,paddingBottom:parseFloat(getComputedStyle(app).paddingBottom),heightOverflow:app.getBoundingClientRect().bottom>innerHeight+1};
        });
        const top=embedded?0:mode==='hidden'?inset:mode==='compact'?Math.max(inset,24):inset+24;
        assert.equal(geometry.top,top,JSON.stringify({inset,mode,embedded,geometry}));
        assert(geometry.buttonTop>=top&&geometry.width>=44&&geometry.height>=44,JSON.stringify(geometry));
        assert.equal(geometry.paddingBottom,embedded?0:34);
        assert(!geometry.heightOverflow,'Safe padding must stay inside the app bounds');checks++;
    }
}
try{
    await page.goto('http://127.0.0.1:5181/test/fixtures/bibi-settings.html');
    await page.getByRole('button',{name:'知道了，开始逛'}).click();
    await page.addStyleTag({content:shellCSS});
    for(const theme of ['moments','island','insta','journal','weibo','twitter']){
        await page.getByRole('button',{name:'哔哔设置',exact:true}).click();
        await page.getByRole('button',{name:/^外观与阅读/}).click();
        await page.locator(`label:has(input[value="${theme}"])`).click();
        await page.getByRole('button',{name:'保存设置',exact:true}).click();
        await page.getByRole('navigation',{name:'设置目录'}).waitFor();
        await checkInsets();
        await page.keyboard.press('Escape');
        await checkInsets();
        if(theme==='moments')await page.screenshot({path:'output/bibi-settings/ios-inset-62-compact.png'});
    }
    await page.goto('http://127.0.0.1:5181/test/fixtures/bibi-settings.html?embedded=1');
    await page.locator('.ff-classic-header').waitFor();
    await page.addStyleTag({content:shellCSS});
    await checkInsets(true);
    await page.getByRole('button',{name:'哔哔设置',exact:true}).click();
    await checkInsets(true);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({checks,themes:6,insets:[0,44,62],modes:['standard','hidden','compact'],embedded:'passed',errors}));
}finally{await context.close();await browser.close();}
