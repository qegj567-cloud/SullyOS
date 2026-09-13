import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const out = 'output/sar-user-module'; mkdirSync(out, { recursive: true });
let targets = [], mode = 'json';
const requests = [];
const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const rewritten = ['讨……讨你厌！', '蛋是坏你……不是！你是坏蛋！'];
    const user = mode === 'json' ? JSON.stringify(targets.map((target, index) => ({id: target.id, surface: rewritten[index]})).reverse())
        : '[2026-09-13 16:04]\n' + rewritten.join('\n[2026-09-13 16:04]\n');
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({choices:[{message:{content:`<SAR_MODULE_OUTPUT><CHAR_TRUE>我知道你原本想说什么。\n模块让话变了个样子。</CHAR_TRUE><CHAR_SURFACE></CHAR_SURFACE><USER_SURFACE>${user}</USER_SURFACE></SAR_MODULE_OUTPUT>`},finish_reason:'stop'}]}));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:390,height:844}});
page.on('requestfailed', r => console.log('REQUEST FAILED', r.url(), r.failure()));
page.on('response', r => {if(r.status()>=400) console.log('HTTP',r.status(),r.url());});
const errors = []; page.on('pageerror', e => errors.push(e.message));
try {
    await page.goto('http://127.0.0.1:5183/test/fixtures/sar-user-module.html');
    await page.waitForFunction(() => !!window.sarQA);
    await page.evaluate(async port => {
        const {DB, module, installSARModuleOnUser} = window.sarQA;
        const char = {id:'qa-sar',name:'装载模块的角色',avatar:'',systemPrompt:'测试',showThinkingChain:false};
        await DB.saveCharacter(char);
        await DB.saveUserProfile({name:'小雨',avatar:'',bio:'',vrState:{enabled:true, sarModule:installSARModuleOnUser(module,char,1)}});
        await DB.saveMessage({charId:char.id,role:'user',type:'text',content:'以前说的话'});
        await DB.saveMessage({charId:char.id,role:'assistant',type:'text',content:'以前的回复'});
        await DB.saveMessage({charId:char.id,role:'user',type:'text',content:'讨厌你！'});
        await DB.saveMessage({charId:char.id,role:'user',type:'text',content:'你是坏蛋！'});
        localStorage.setItem('os_last_active_char_id',char.id);
        localStorage.setItem('os_api_config', JSON.stringify({baseUrl:`http://127.0.0.1:${port}/v1`,apiKey:'qa-only',model:'qa-only',stream:false}));
    }, server.address().port);
    await page.reload(); await page.locator('.sully-chat-name').filter({hasText:'装载模块的角色'}).waitFor();
    for (const round of ['json','legacy']) {
        await page.getByRole('button',{name:'收起模块悬浮窗'}).click();
        mode = round;
        targets = (await page.evaluate(() => window.sarQA.DB.getMessagesByCharId('qa-sar',true))).slice(-2);
        await page.locator('.sully-chat-trigger').click();
        for (let attempt = 0; attempt < 150; attempt++) {
            const ready = await page.evaluate(async ids => {
                const all = await window.sarQA.DB.getMessagesByCharId('qa-sar', true);
                return ids.every(id => all.find(m => m.id === id)?.metadata?.sarModuleSurface) && all.at(-1).role === 'assistant';
            }, targets.map(t=>t.id));
            if (ready) break;
            if (attempt === 149) throw new Error('Reply did not persist user surfaces');
            await page.waitForTimeout(200);
        }

        const all = await page.evaluate(() => window.sarQA.DB.getMessagesByCharId('qa-sar',true));
        assert(!all[0].metadata?.sarModuleSurface,'history is untouched');
        for (let i=0;i<targets.length;i++) {
            const stored = all.find(m=>m.id===targets[i].id);
            assert.equal(stored.content,targets[i].content);
            assert.equal(stored.metadata.sarModuleSurface.surface, i===0?'讨……讨你厌！':'蛋是坏你……不是！你是坏蛋！');
            const bubble = page.locator(`#chat-msg-${stored.id}`);
            await bubble.getByText('查看原话').click();
            assert((await bubble.innerText()).includes(targets[i].content));
        }
        if (round==='json') {
            const prompt=requests.flatMap(req=>req.messages).map(m=>m.content).join('\n');
            assert(prompt.includes(JSON.stringify(targets.map(({id,content})=>({id,content})))));
            assert(prompt.includes('USER_SURFACE 的聊天专用格式'));
            await page.evaluate(async () => {
                await window.sarQA.DB.saveMessage({charId:'qa-sar',role:'user',type:'text',content:'讨厌你！'});
                await window.sarQA.DB.saveMessage({charId:'qa-sar',role:'user',type:'text',content:'你是坏蛋！'});
            });
            await page.reload(); await page.locator('.sully-chat-trigger').waitFor();
        }
    }
    await page.getByRole('button',{name:'展开模块悬浮窗'}).click();
    const monitor = page.locator('.sar-module-monitor');
    assert((await monitor.innerText()).includes('装载者：装载模块的角色'));
    await page.screenshot({path:`${out}/expanded.png`});
    await page.getByRole('button',{name:'收起模块悬浮窗'}).click();
    assert((await monitor.innerText()).includes('小雨（我）'));
    await page.setViewportSize({width:320,height:740});
    const bounds=await monitor.boundingBox(); assert(bounds.x>=0 && bounds.x+bounds.width<=320);
    await page.screenshot({path:`${out}/collapsed-320.png`});
    assert.deepEqual(errors,[]);
    writeFileSync(`${out}/result.json`,JSON.stringify({success:true,requests:requests.length,errors},null,2));
    console.log('PASS: actual Chat id mapping / legacy timestamps / canonical toggle / history boundary / monitor 320px');
} catch (error) { console.log({errors, url:page.url(), body:await page.locator('body').innerText()}); throw error; }
finally {await browser.close(); server.close();}
