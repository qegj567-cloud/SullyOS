import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const out = 'output/chat-stream-handover'; mkdirSync(out, { recursive: true });
const lines = ['第一句流式测试', '第二句流式测试', '第三句流式测试'];
const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.end(); return; }
    for await (const _ of req) { /* drain request */ }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const content of ['第一句', '流式测试\n', `${lines[1]}\n`, lines[2]]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    res.end('data: [DONE]\n\n');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = []; page.on('pageerror', e => errors.push(e.stack || e.message));
const messages = () => page.evaluate(() => window.streamQA.DB.getMessagesByCharId('qa-stream', true));
const preview = page.locator('[data-stream-preview]');
const release = () => page.evaluate(() => { const g = window.streamQA.gate; const next = g.release; g.release = null; next?.(); });
try {
    await page.goto('http://127.0.0.1:5183/test/fixtures/chat-stream-handover.html');
    await page.waitForFunction(() => !!window.streamQA);
    await page.evaluate(async port => {
        const { DB } = window.streamQA;
        await DB.saveCharacter({ id: 'qa-stream', name: '流式测试角色', avatar: '', systemPrompt: '测试', showThinkingChain: false });
        await DB.saveMessage({ charId: 'qa-stream', role: 'user', type: 'text', content: '回复三句话' });
        localStorage.setItem('os_last_active_char_id', 'qa-stream');
        localStorage.setItem('os_api_config', JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'qa-only', model: 'qa-only', stream: true }));
        localStorage.removeItem('sully-chat-input-preferences-v1');
    }, server.address().port);
    await page.reload();
    await page.locator('.sully-chat-name').filter({ hasText: '流式测试角色' }).waitFor();
    const start = async (failAt = 0) => {
        await page.evaluate(failAt => Object.assign(window.streamQA.gate, { enabled: true, attempts: 0, failAt, release: null }), failAt);
        await page.locator('.sully-chat-trigger').click();
        await page.waitForFunction(() => window.streamQA.gate.attempts === 2 && !!window.streamQA.gate.release);
        await page.waitForTimeout(120);
    };
    for (let round = 0; round < 2; round++) {
        const baseline = await messages();
        const previous = baseline.filter(m => m.role === 'assistant');
        await start();
        assert.equal(await preview.count(), 3, 'all previews remain after first message persists');
        const first = (await messages()).filter(m => m.role === 'assistant').at(-1);
        assert.equal(await page.locator(`#chat-msg-${first.id}`).count(), 0, 'persisted counterpart is hidden while preview is visible');
        for (const old of previous) assert.equal(await page.locator(`#chat-msg-${old.id}`).count(), 1, 'previous streamed rounds remain visible');
        await page.evaluate(() => {
            window.streamFrames = []; window.sampleStream = true;
            const sample = () => {
                if (!window.sampleStream) return;
                window.streamFrames.push({ preview: document.querySelectorAll('[data-stream-preview]').length, bubbles: document.querySelectorAll('.sully-bubble-ai').length });
                requestAnimationFrame(sample);
            }; requestAnimationFrame(sample);
        });
        await release();
        await page.waitForFunction(() => window.streamQA.gate.attempts === 3 && !!window.streamQA.gate.release);
        await page.waitForTimeout(120);
        assert.equal(await preview.count(), 3, 'all previews remain after second message persists');
        await page.screenshot({ path: `${out}/round-${round}-persisting.png` });
        await release();
        await page.waitForFunction(() => document.querySelectorAll('[data-stream-preview]').length === 0);
        await page.waitForTimeout(120);
        const final = (await messages()).filter(m => m.role === 'assistant');
        assert.equal(final.length, previous.length + 3);
        assert.deepEqual(final.slice(-3).map(m => m.content), lines);
        for (const message of final.slice(-3)) {
            const node = page.locator(`#chat-msg-${message.id}`);
            assert.equal(await node.count(), 1);
            assert.equal(await node.locator('.animate-fade-in').count(), 0, 'handover does not replay bubble entrance');
            assert(!(await node.getAttribute('class')).includes('animate-fade-in'), 'handover does not replay row entrance');
        }
        const frames = await page.evaluate(() => { window.sampleStream = false; return window.streamFrames; });
        assert(frames.length > 0);
        assert(frames.every(frame => frame.bubbles === final.length), `no disappearance or duplication: ${JSON.stringify(frames)}`);
        writeFileSync(`${out}/frames-${round}.json`, JSON.stringify(frames));
    }
    await start(2);
    assert.equal(await preview.count(), 3);
    await release();
    await page.waitForFunction(() => document.querySelectorAll('[data-stream-preview]').length === 0);
    const partial = await messages();
    assert.equal(partial.filter(m => m.role === 'assistant').length, 7, 'failed unsaved previews are removed, persisted bubble remains');
    assert(partial.some(m => m.role === 'system' && m.content.includes('QA simulated persistence failure')));
    assert.equal(await page.locator('.sully-bubble-ai').count(), 7);
    assert.deepEqual(errors, []);
    console.log('PASS: actual SSE + Chat/useChatAI/postprocessing/IndexedDB; two rounds of 3 bubbles remain stable during slow writes, no duplicate entrance; partial failure cleans preview.');
} catch (error) { await page.screenshot({ path: `${out}/failure.png` }); console.error(errors, (await page.locator('body').innerText()).slice(-2000)); throw error; }
finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
