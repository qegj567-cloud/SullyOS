import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
await mkdir('output/vr-library',{recursive:true});
const browser=await chromium.launch({headless:true});
try {
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
    const page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:5177/test/fixtures/kanata.html');
    await page.getByRole('button',{name:'书库',exact:true}).waitFor();
    await page.evaluate(async()=>{
        const {DB}=await import('/utils/db.ts');
        // This is a fresh Playwright context; the app may already have seeded its default character.
        await DB.saveCharacter({id:'qa-reader',name:'阅读测试',avatar:'',systemPrompt:'QA',vrState:{enabled:true,activityMode:'manual',intervalMinutes:120,novelBookmarks:{'qa-0':1}}});
        for(let i=0;i<26;i++)await DB.saveVRNovel({id:`qa-${i}`,title:`旧书 ${String(i).padStart(2,'0')}`,author:'测试作者',segments:[{idx:0,text:'旧书正文不变。',chars:8}],totalChars:8,createdAt:1,updatedAt:1});
        await DB.saveVRAnnotation({id:'qa-annotation',novelId:'qa-0',segIdx:0,authorId:'qa-reader',authorName:'阅读测试',content:'这条批注要保留。',createdAt:1});
    });
    await page.reload();
    const btn=name=>page.getByRole('button',{name,exact:true});
    await btn('书库').click();
    const lib=page.getByRole('region',{name:'彼方书库'});
    await lib.getByText('旧书 00',{exact:true}).waitFor();
    await btn('分类').click();
    await page.getByLabel('分类名称',{exact:true}).fill('网文');await btn('新建分类').click();
    await page.locator('.vrl-category-row').filter({hasText:'网文'}).waitFor();
    await page.getByLabel('分类名称',{exact:true}).fill('严肃文学');await btn('新建分类').click();
    await page.locator('.vrl-category-row').filter({hasText:'严肃文学'}).waitFor();
    await btn('分类').click();await btn('整理').click();
    await btn('选择本页').click();
    await page.getByLabel('移入分类',{exact:true}).selectOption({label:'网文'});await btn('移入分类').click();
    await page.getByText('已选 0 本',{exact:true}).waitFor();
    await btn('整理').click();
    const categories=page.getByRole('navigation',{name:'书籍分类'});
    await categories.getByRole('button',{name:/^网文/}).click();
    assert.equal(await page.locator('.vrl-book').count(),12);
    await page.locator('.vrl-readers summary').click();
    await page.locator('.vrl-reader-list').getByRole('button',{name:/阅读测试/}).click();
    await btn('按分类').click();
    await page.locator('.vrl-preference-list').getByRole('button',{name:/^网文/}).click();
    await page.screenshot({path:'output/vr-library/02-preference.png'});
    await btn('保存偏好').click();
    await page.waitForFunction(async()=>{const {DB}=await import('/utils/db.ts');return (await DB.getAllCharacters()).find(c=>c.id==='qa-reader')?.vrState?.novelReadingMode==='categories';});
    // New imports inherit the active category; no second character preference edit.
    await btn('上架').click();
    assert.equal(await page.getByLabel('上架书籍分类').locator('option:checked').innerText(),'网文');
    await page.getByPlaceholder('书名（必填）').fill('新归入的小说');
    await page.getByPlaceholder('粘贴正文…').fill('新书正文。今晚的小镇下着雨，街角亮起一盏灯。');
    await btn('上架到书库').click();
    await page.waitForFunction(async()=>{const {DB}=await import('/utils/db.ts');return (await DB.getVRNovels()).some(n=>n.title==='新归入的小说');});
    const snapshot=await page.evaluate(async()=>{
        const {DB}=await import('/utils/db.ts'),{readableNovels}=await import('/utils/vrWorld/library.ts');
        const books=await DB.getVRNovels(),c=(await DB.getAllCharacters()).find(c=>c.id==='qa-reader');
        return {categories:await DB.getVRLibraryCategories(),eligible:readableNovels(books,c).map(n=>n.title),annotations:await DB.getVRAnnotations('qa-0'),bookmark:c.vrState.novelBookmarks['qa-0']};
    });
    assert(snapshot.eligible.includes('新归入的小说'));assert.equal(snapshot.eligible.length,13);assert.equal(snapshot.annotations[0].content,'这条批注要保留。');assert.equal(snapshot.bookmark,1);
    await btn('分类').click();
    await page.locator('.vrl-category-row').filter({hasText:'网文'}).getByRole('button',{name:'重命名'}).click();
    await page.getByLabel('分类名称',{exact:true}).fill('网络小说');await btn('保存名称').click();
    await page.locator('.vrl-category-row').filter({hasText:'网络小说'}).waitFor();
    await btn('分类').click();await page.reload();await btn('书库').click();
    await categories.getByRole('button',{name:/^网络小说/}).click();
    assert.equal(await page.locator('.vrl-book').count(),12);
    await page.screenshot({path:'output/vr-library/01-library.png'});
    for(const [width,height] of [[320,568],[844,390]]){
        await page.setViewportSize({width,height});
        await page.evaluate(()=>{document.documentElement.style.setProperty('--chrome-top','59px');document.documentElement.style.setProperty('--safe-bottom','34px');});
        await page.locator('.vrl-readers summary').click();
        await page.locator('.vrl-reader-list').getByRole('button',{name:/阅读测试/}).click();
        const close=btn('关闭阅读偏好'),box=await close.boundingBox();assert(box.y>=59&&box.y+box.height<height);
        const save=await btn('保存偏好').boundingBox();assert(save.y+save.height<=height-34);
        await page.screenshot({path:`output/vr-library/preference-${width}.png`});await close.click();
        await page.locator('.vrl-readers summary').click();
    }
    // Both the category registry and book assignments participate in the existing backup format.
    const backup=await page.evaluate(async()=>{const {DB}=await import('/utils/db.ts');const b=await DB.exportFullData();return {categories:b.vrSettings.find(x=>x.id==='library-categories-v1'),book:b.vrNovels.find(x=>x.title==='新归入的小说'),char:b.characters.find(x=>x.id==='qa-reader')};});
    assert.equal(backup.categories.categories.find(x=>x.id===snapshot.categories[0].id).name,'网络小说');
    assert.equal(backup.book.categoryId,backup.char.vrState.preferredNovelCategoryIds[0]);
    // Removing a category moves its books to Uncategorized and never widens reading scope.
    await btn('分类').click();await page.locator('.vrl-category-row').filter({hasText:'网络小说'}).getByRole('button',{name:'移除分类'}).click();await page.getByRole('dialog').getByRole('button',{name:'移除分类',exact:true}).click();
    await page.waitForFunction(async()=>{const {DB}=await import('/utils/db.ts');return !(await DB.getVRLibraryCategories()).some(c=>c.name==='网络小说');});
    const empty=await page.evaluate(async()=>{const {DB}=await import('/utils/db.ts'),{readableNovels}=await import('/utils/vrWorld/library.ts');return readableNovels(await DB.getVRNovels(),(await DB.getAllCharacters()).find(c=>c.id==='qa-reader')).length;});assert.equal(empty,0);
    assert.deepEqual(errors,[]);
    console.log('PASS categories, bulk move, preferences, new upload inheritance, bookmark/annotation preservation, rename/reload, backup, category removal and mobile safe area.');
} finally {await browser.close();}
