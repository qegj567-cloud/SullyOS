import {mkdir, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({channel:'msedge', headless:true});
const context = await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,reducedMotion:'reduce'});
const page = await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await mkdir('output/bibi-settings',{recursive:true});
try {
    await page.goto('http://127.0.0.1:5181/test/fixtures/bibi-settings.html');
    const countdown=page.getByRole('button',{name:'请先阅读 · 10s'});
    await countdown.waitFor();assert(await countdown.isDisabled());
    await page.getByRole('button',{name:'知道了，开始逛'}).click();
    assert.equal(await page.locator('.friend-feed').getAttribute('data-theme'),'moments');
    await page.screenshot({path:'output/bibi-settings/home-moments.png'});
    await page.getByRole('button',{name:'哔哔设置',exact:true}).click();
    await page.getByRole('navigation',{name:'设置目录'}).waitFor();
    await page.screenshot({path:'output/bibi-settings/directory.png'});
    assert.equal(await page.locator('.ff-settings-directory input,.ff-settings-directory textarea').count(),0);
    const rows=await page.locator('.ff-settings-menu button').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().height));
    assert(rows.every(h=>h>=44&&h<=65),`Unexpected menu row heights: ${rows}`);
    for(const [name,slug] of [['外观与阅读','appearance'],['互动方式','interaction'],['真实内容','content'],['角色与小号','accounts'],['角色与内容权重','weights']]){
        await page.getByRole('button',{name:new RegExp(`^${name}`)}).click();
        await page.getByRole('heading',{name,exact:true}).waitFor();
        assert.equal(await page.locator('.ff-preferences-section').count(),1);
        await page.screenshot({path:`output/bibi-settings/${slug}.png`});
        assert(await page.locator('.friend-feed-scroll').evaluate(n=>n.scrollWidth<=n.clientWidth),'Horizontal overflow');
        await page.keyboard.press('Escape');
        await page.getByRole('navigation',{name:'设置目录'}).waitFor();
    }
    await page.getByRole('button',{name:'管理动态来源'}).click();
    await page.getByRole('button',{name:'管理微博连接'}).click();
    await page.keyboard.press('Escape');
    await page.locator('.friend-feed-header').getByRole('heading',{name:'动态来源'}).waitFor();
    await page.getByRole('button',{name:'返回上一级'}).click();
    await page.getByRole('navigation',{name:'设置目录'}).waitFor();
    await page.getByRole('button',{name:'重新查看入门引导'}).click();
    await page.keyboard.press('Escape');
    await page.getByRole('navigation',{name:'设置目录'}).waitFor();
    for(const width of [320,768]){
        await page.setViewportSize({width,height:844});
        assert(await page.locator('.friend-feed-scroll').evaluate(n=>n.scrollWidth<=n.clientWidth));
        await page.screenshot({path:`output/bibi-settings/directory-${width}.png`});
    }
    await page.setViewportSize({width:390,height:844});
    await page.goto('http://127.0.0.1:5181/test/fixtures/bibi-settings.html?many=1');
    await page.getByRole('button',{name:'哔哔设置',exact:true}).click();
    await page.getByRole('button',{name:/^角色与内容权重/}).click();
    const weights=page.locator('[aria-label="角色权重"]');
    assert.equal(await weights.locator('input[type=number]').count(),10);
    await page.getByLabel('角色权重分组',{exact:true}).selectOption('story');
    await page.getByRole('button',{name:'角色权重下一页',exact:true}).click();
    await page.getByLabel('角色070的抽取权重',{exact:true}).fill('0');
    await page.screenshot({path:'output/bibi-settings/weights-125.png'});
    await page.getByLabel('搜索角色',{exact:true}).fill('角色119');
    assert.equal(await weights.locator('input[type=number]').count(),1);
    await page.getByLabel('搜索角色',{exact:true}).fill('');
    await page.getByRole('button',{name:'角色权重下一页',exact:true}).click();
    assert.equal(await page.getByLabel('角色070的抽取权重',{exact:true}).inputValue(),'0');
    await page.getByRole('button',{name:'取消',exact:true}).click();
    await page.getByRole('button',{name:/^角色与小号/}).click();
    await page.locator('summary[aria-label="编辑角色账号"]').click();
    await page.getByLabel('编辑角色账号列表分组',{exact:true}).selectOption('story');
    await page.getByRole('button',{name:'编辑角色账号列表下一页',exact:true}).click();
    await page.getByRole('button',{name:'角色070',exact:true}).click();
    await page.locator('summary[aria-label="编辑角色账号"]').click();
    await page.locator('.ff-character-picker[open]').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.ff-character-picker:not([open])').waitFor();
    assert.equal(await page.getByRole('heading',{name:'角色与小号',exact:true}).count(),1);
    await page.keyboard.press('Escape');
    await page.getByRole('navigation',{name:'设置目录'}).waitFor();
    assert.equal(await page.locator('body').getAttribute('data-closed'),null);
    await page.keyboard.press('Escape');
    for(const theme of ['island','moments','insta','journal']){
        await page.getByRole('button',{name:'哔哔设置',exact:true}).click();
        await page.getByRole('button',{name:/^外观与阅读/}).click();
        await page.locator(`label:has(input[value="${theme}"])`).click();
        await page.getByRole('button',{name:'保存设置',exact:true}).click();
        await page.getByRole('navigation',{name:'设置目录'}).waitFor();
        await page.keyboard.press('Escape');
        for(const width of [320,390]){
            await page.setViewportSize({width,height:844});
            const geometry=await page.locator('.ff-classic-header').evaluate(n=>{
                const header=n.getBoundingClientRect(),title=n.querySelector('h1').getBoundingClientRect();
                return {offset:Math.abs((title.left+title.right-header.left-header.right)/2),overflow:n.scrollWidth>n.clientWidth,
                    buttons:[...n.querySelectorAll('button')].map(b=>getComputedStyle(b).backgroundColor)};
            });
            assert(geometry.offset<1,`${theme} title is off center: ${JSON.stringify(geometry)}`);
            assert(!geometry.overflow,`${theme} header overflow`);
            assert(geometry.buttons.every(color=>color==='rgba(0, 0, 0, 0)'),`${theme} unwanted button backgrounds`);
            assert.equal(await page.locator('.friend-feed-views').count(),0);
            assert(await page.getByRole('button',{name:'发布新动态',exact:true}).isVisible());
            await page.screenshot({path:`output/bibi-settings/home-${theme}-${width}.png`});
        }
        await page.getByRole('button',{name:'我的主页',exact:true}).click();
        await page.getByRole('button',{name:'更换主页封面',exact:true}).waitFor();
        await page.screenshot({path:`output/bibi-settings/profile-${theme}.png`});
        await page.keyboard.press('Escape');
    }
    await page.getByRole('button',{name:'我的主页',exact:true}).click();
    await page.getByRole('button',{name:'更换主页封面',exact:true}).click();
    await page.getByLabel('选择主页封面',{exact:true}).setInputFiles('output/bibi-settings/home-moments.png');
    await page.getByRole('button',{name:'保存封面',exact:true}).click();
    await page.locator('.ff-classic-profile .ff-cover-image').waitFor();
    await page.reload();
    await page.getByRole('button',{name:'我的主页',exact:true}).click();
    await page.locator('.ff-classic-profile .ff-cover-image').waitFor();
    await page.getByRole('button',{name:'更换主页封面',exact:true}).click();
    await page.getByRole('button',{name:'恢复默认封面',exact:true}).click();
    await page.getByRole('button',{name:'取消',exact:true}).click();
    assert.equal(await page.locator('.ff-classic-profile .ff-cover-image').count(),1);
    await page.getByRole('button',{name:'更换主页封面',exact:true}).click();
    await page.getByRole('button',{name:'恢复默认封面',exact:true}).click();
    await page.getByRole('button',{name:'保存封面',exact:true}).click();
    await page.locator('.ff-classic-profile').waitFor();
    assert.equal(await page.locator('.ff-classic-profile .ff-cover-image').count(),0);
    assert.deepEqual(errors,[]);
    const report={separatePages:5,menuRows:rows.length,backNavigation:'passed',characters:125,rowsPerPage:10,widths:[320,390,768],headers:4,coverPersistence:'passed',defaultTheme:'moments',guideCountdown:10,errors};
    await writeFile('output/bibi-settings/report.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
} catch(error) {
    await page.screenshot({path:'output/bibi-settings/failure.png'});
    console.log(JSON.stringify({errors,text:await page.locator('body').innerText()}));
    throw error;
} finally {await context.close();await browser.close();}
