import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir = await mkdtemp(join(tmpdir(), 'sully-stickers-'));
const site = join(dir, 'site');
const { build, preview } = await import('vite');
const options = {
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    build: {
        outDir: site,
        target: 'esnext',
        minify: false,
        reportCompressedSize: false,
        rollupOptions: { input: 'test/fixtures/chat-stop.html' },
    },
};
console.log('正在打包私聊验收页面。');
await build({
    ...options,
    define: {
        __BUILD_BADGE_VISIBLE__: 'false',
        __BUILD_BRANCH__: JSON.stringify('sticker-qa'),
        __BUILD_COMMIT__: JSON.stringify('test'),
        __BUILD_TIME__: JSON.stringify(''),
        __APP_BUILD_ID__: JSON.stringify('test'),
    },
    plugins: [
        {
            name: 'sticker-qa-db',
            enforce: 'pre',
            transform(code, id) {
                if (id.endsWith('chat-stop.tsx')) return code + '\nglobalThis.__stickerQaDB = DB;\n';
            },
        },
    ],
});
const server = await preview({ ...options, preview: { host: '127.0.0.1', port: 0, open: false } });
const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
console.log('本机验收页已准备，正在启动浏览器。');
let browser, qaPage;
const gif = Buffer.from(
    '47494638396101000100800000000000ffffff21f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b',
    'hex'
);
const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGM8kRfFgA0wYRUdtBIAPOUBoN377ToAAAAASUVORK5CYII=',
    'base64'
);
try {
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_PATH,
        timeout: 45000,
    });
    console.log('浏览器已启动。');
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    const page = (qaPage = await context.newPage());
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(120000);
    const errors = [];
    page.on('pageerror', (e) => {
        errors.push(e.message);
        console.error('页面脚本异常', e.message);
    });
    let modelCalls = 0,
        namingRequest;
    let checkingChat = false;
    const chatRequests = [];
    const suggestions = [
        '轻轻招手',
        '探头',
        '害羞',
        '开心',
        '疑惑',
        '举手',
        '抱抱',
        '眨眼',
        '晚安',
        '偷看',
        '发呆',
        '惊喜',
        '委屈',
        '鼓掌',
        '点头',
        '摇头',
    ];
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === 'cdn.tailwindcss.com')
            return route.fulfill({
                path: 'public/vendor/tailwind-3.4.17.js',
                contentType: 'application/javascript',
            });
        if (url.origin === origin || !['http:', 'https:'].includes(url.protocol)) return route.continue();
        if (url.pathname.endsWith('/chat/completions')) {
            if (checkingChat) {
                chatRequests.push({ url: url.href, body: route.request().postDataJSON() });
                return route.fulfill({ json: { choices: [{ message: { content: '收到啦。' } }] } });
            }
            modelCalls++;
            namingRequest = { url: url.href, body: route.request().postDataJSON() };
            const reply = suggestions.map((name, index) => ({ id: index + 1, name })).reverse();
            return route.fulfill({ json: { choices: [{ message: { content: JSON.stringify(reply) } }] } });
        }
        return route.fulfill({ status: 200, body: '', headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    });
    console.log('正在打开本机测试页。');
    await page.goto(origin + '/test/fixtures/chat-stop.html', { waitUntil: 'commit' });
    await page.waitForFunction(() => !!globalThis.__stickerQaDB);
    console.log('测试页已加载。');
    await page.evaluate(async () => {
        const DB = globalThis.__stickerQaDB;
        await DB.saveCharacter({ id: 'sticker-qa', name: '测试角色', systemPrompt: '测试', avatar: '', timeAwarenessEnabled: false });
        await Promise.all(Array.from({ length: 125 }, (_, i) => DB.saveEmojiCategory({
            id: 'qa-folder-' + i, name: '长名称压力分组' + i, personalOnly: true,
        })));
        localStorage.setItem('os_last_active_char_id', 'sticker-qa');
        localStorage.setItem('sully-chat-input-preferences-v1', JSON.stringify({ sendButtonGenerates: false, autoReply: false }));
        localStorage.setItem('os_realtime_config', JSON.stringify({ weatherEnabled: false, newsEnabled: false }));
        localStorage.setItem(
            'os_api_config',
            JSON.stringify({
                apiKey: 'demo',
                baseUrl: 'https://model.example.test/v1',
                model: '测试主模型',
                visionApi: {
                    enabled: true,
                    baseUrl: 'https://vision.example.test/v1',
                    apiKey: 'separate',
                    model: '独立识图',
                },
            })
        );
    });
    console.log('测试角色已保存。');
    await page.goto(origin + '/test/fixtures/chat-stop.html?char=sticker-qa', {
        waitUntil: 'domcontentloaded',
    });
    const button = (name) => page.getByRole('button', { name, exact: true });
    await button('表情包面板').click();
    await button('批量管理表情').click();
    const library = page.getByRole('dialog', { name: '表情管理', exact: true });
    await library.waitFor();
    console.log('已从私聊打开表情管理。');
    const shellCss = await readFile('index.html', 'utf8');
    const chromeRules = Array.from(
        shellCss.matchAll(/(:root|html\.sully-statusbar-(?:hidden|compact))\s*\{[^{}]*?(--chrome-top:[^;]*;)/g),
        (m) => m[1] + '{' + m[2] + '}'
    ).join('\n');
    assert(chromeRules.includes(':root') && chromeRules.includes('hidden') && chromeRules.includes('compact'));
    await page.addStyleTag({ content: chromeRules });
    const setTop = (safe, mode) =>
        page.evaluate(
            ([safe, mode]) => {
                const root = document.documentElement;
                root.style.setProperty('--safe-top', safe + 'px');
                root.classList.toggle('sully-statusbar-hidden', mode === 'hidden');
                root.classList.toggle('sully-statusbar-compact', mode === 'compact');
            },
            [safe, mode]
        );
    for (const [safe, mode, inset] of [
        [59, 'normal', 83],
        [59, 'compact', 59],
        [59, 'hidden', 59],
        [0, 'hidden', 0],
    ]) {
        await setTop(safe, mode);
        assert.equal(await library.evaluate((el) => parseFloat(getComputedStyle(el).paddingTop)), inset);
        assert((await button('返回聊天').boundingBox()).y >= inset);
    }
    await setTop(59, 'normal');
    const groupPicker = library.getByRole('button', { name: /^选择表情分组，/ });
    for (const width of [320, 390, 960]) {
        await page.setViewportSize({ width, height: 844 });
        await groupPicker.click();
        const list = library.locator('.st-picker-list');
        assert.equal(await list.getByRole('button').count(), 30);
        for (const selector of ['.st-main', '.st-groups', '.st-picker-list']) {
            assert(await library.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth));
        }
        await library.getByRole('searchbox', { name: '搜索表情分组' }).fill('长名称压力分组124');
        await list.getByRole('button', { name: /长名称压力分组124/ }).click();
        assert.match(await groupPicker.textContent(), /长名称压力分组124/);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await button('导入').click();
    await button('粘贴链接').click();
    await button('返回导入').click();
    await button('粘贴链接').click();
    await library.getByRole('textbox', { name: '表情名称和图片链接' }).fill('链接测试--https://img.example.test/link--test.png');
    await button('导入链接').click();
    await groupPicker.waitFor();
    assert.match(await groupPicker.textContent(), /长名称压力分组124/);
    await library.getByRole('button', { name: '链接测试', exact: true }).waitFor();
    await groupPicker.click();
    await library.getByRole('searchbox', { name: '搜索表情分组' }).fill('全部表情');
    await library.locator('.st-picker-list').getByRole('button', { name: /全部表情/ }).click();
    await button('导入').click();
    await page.locator('input[accept="image/*"][multiple]').setInputFiles([
        { name: '猫猫探头.png', mimeType: 'image/png', buffer: png },
        { name: '猫猫探头.gif', mimeType: 'image/gif', buffer: gif },
        { name: '猫猫探头.png', mimeType: 'image/png', buffer: png },
    ]);
    await page.getByText('同名同图 · 跳过', { exact: true }).waitFor();
    await button('确认导入').click();
    await page.getByText(/已导入 2 张，跳过重复 1 张/).waitFor();
    assert.equal(await library.count(), 1);
    await button('完成').click();
    assert.equal(modelCalls, 0);
    const groupInfo = () =>
        page.evaluate(async () => {
            const DB = globalThis.__stickerQaDB;
            return {
                rows: (await DB.getEmojis()).filter((r) => r.name.startsWith('猫猫')),
                groups: await DB.getEmojiCategories(),
            };
        });
    const before = await groupInfo();
    assert.equal(before.rows.length, 2);
    const local = before.groups.find((g) => g.id === before.rows[0].categoryId);
    assert(local.personalOnly);
    const scopedButton = (label) => library.getByRole('button', { name: label, exact: true });
    await library.getByRole('textbox', { name: '搜索表情名称' }).fill('猫猫');
    const selectBoth = async () => {
        await scopedButton('选择').click();
        await scopedButton('全选当前结果').click();
    };
    await selectBoth();
    await scopedButton('导出').click();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '分享 / 保存文件' }).click();
    const download = await downloadEvent;
    const path = join(dir, download.suggestedFilename());
    await download.saveAs(path);
    console.log('已下载 ZIP。');
    const archive = await JSZip.loadAsync(await readFile(path));
    const manifest = JSON.parse(await archive.file('sully-stickers.json').async('string'));
    assert.equal(manifest.items.length, 2);
    for (const row of manifest.items) {
        assert.equal(row.group, '本地表情');
        assert.deepEqual(
            await archive.file(row.path).async('nodebuffer'),
            row.path.endsWith('.gif') ? gif : png
        );
    }
    await scopedButton('删除').click();
    await scopedButton('确认删除').click();
    await page.getByText('已删除 2 张', { exact: true }).first().waitFor();
    assert.equal((await groupInfo()).rows.length, 0);
    await scopedButton('导入').click();
    await page.locator('input[accept=".zip,application/zip"]').setInputFiles(path);
    await button('确认导入').click();
    await page.getByText(/已导入 2 张，跳过重复 0 张/).waitFor();
    await button('完成').click();
    const after = await groupInfo();
    assert.deepEqual(
        after.rows.map((r) => [r.name, r.contentHash, r.categoryId]),
        before.rows.map((r) => [r.name, r.contentHash, r.categoryId])
    );
    await scopedButton('本机空间').click();
    await page
        .getByText(gif.length + png.length + ' B', { exact: true })
        .first()
        .waitFor();
    await scopedButton('角色分配').click();
    const assigned = library.getByRole('checkbox', { name: /本地表情/ });
    assert.equal(await assigned.isChecked(), false);
    await assigned.click();
    await page.waitForFunction(async () => {
        const DB = globalThis.__stickerQaDB;
        return (await DB.getEmojiCategories()).some(
            (g) => g.name === '本地表情' && g.allowedCharacterIds?.includes('sticker-qa')
        );
    });
    await assigned.and(library.locator(':checked')).waitFor();
    await scopedButton('表情库').click();
    await scopedButton('导入').click();
    assert((await scopedButton('返回').boundingBox()).y >= 83);
    const images = await page.evaluate(() =>
        Array.from({ length: 15 }, (_, i) => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = i === 0 ? 1000 : 8;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'rgb(' + i * 15 + ',120,30)';
            ctx.fillRect(0, 0, 8, 8);
            if (i === 0) {
                const pixels = ctx.createImageData(1000, 1000);
                for (let j = 0; j < pixels.data.length; j += 4) {
                    pixels.data[j] = (Math.random() * 256) | 0;
                    pixels.data[j + 1] = 120;
                    pixels.data[j + 3] = j < 1000 * 4 ? 0 : 255;
                }
                ctx.putImageData(pixels, 0, 0);
            }
            return canvas.toDataURL('image/png').split(',')[1];
        })
    );
    await library.locator('input[accept="image/*"][multiple]').setInputFiles([
        ...images.map((data, i) => ({
            name: '批量' + String(i + 1).padStart(2, '0') + '.png',
            mimeType: 'image/png',
            buffer: Buffer.from(data, 'base64'),
        })),
        { name: '批量16.gif', mimeType: 'image/gif', buffer: gif },
    ]);
    await library.getByLabel('导入到').selectOption({ label: '＋ 新建文件夹…' });
    await library.getByLabel('新文件夹名称').fill('压缩验证');
    await scopedButton('创建并选用').click();
    await scopedButton('确认导入').click();
    await scopedButton('为新导入的 16 张看图起名').waitFor();
    const compressed = await page.evaluate(async () => {
        const db = globalThis.__stickerQaDB;
        const row = (await db.getEmojis()).find(e => e.name === '批量01');
        const folder = (await db.getEmojiCategories()).find(g => g.id === row.categoryId);
        const blob = await db.getBlobAsset(row.url.slice('blobref:'.length));
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        const alpha = ctx.getImageData(0, 0, 1, 1).data[3];
        return { size: blob.size, type: blob.type, width: bitmap.width, alpha, folder: folder.name };
    });
    assert.equal(compressed.folder, '压缩验证');
    assert.equal(compressed.type, 'image/webp');
    assert.equal(compressed.width, 768);
    assert(compressed.alpha < 255);
    const originalBytes = Buffer.from(images[0], 'base64').length;
    assert(compressed.size < originalBytes);
    console.log('静态 PNG 压缩实测（字节）', originalBytes, '→', compressed.size);
    await scopedButton('为新导入的 16 张看图起名').click();
    assert((await scopedButton('返回').boundingBox()).y >= 83);
    assert.equal(modelCalls, 0);
    await scopedButton('一键起名').click();
    await library.getByRole('textbox', { name: '批量01的新名称' }).waitFor();
    assert.equal(namingRequest.url, 'https://model.example.test/v1/chat/completions');
    assert.equal(namingRequest.body.model, '测试主模型');
    const sent = namingRequest.body.messages[0].content.filter((p) => p.type === 'image_url');
    assert.equal(sent.length, 16);
    assert.equal(new Set(sent.map((p) => p.image_url.url)).size, 16);
    assert(sent[15].image_url.url.startsWith('data:image/jpeg;base64,'));
    for (const [i, name] of suggestions.entries())
        assert.equal(
            await library
                .getByRole('textbox', { name: '批量' + String(i + 1).padStart(2, '0') + '的新名称' })
                .inputValue(),
            name
        );
    await scopedButton('保存选定名称').click();
    await library.getByRole('textbox', { name: '搜索表情名称' }).fill('轻轻招手');
    await scopedButton('轻轻招手').waitFor();
    assert.equal(modelCalls, 1);
    assert.equal((await library.boundingBox()).width, 390);
    await page.setViewportSize({ width: 1280, height: 800 });
    const desktop = await library.boundingBox();
    assert.deepEqual([desktop.x, desktop.y, desktop.width, desktop.height], [0, 0, 1280, 800]);
    checkingChat = true;
    await scopedButton('返回聊天').click();
    const sentNames = ['猫猫探头', '链接测试'];
    for (const [group, name] of [[local.name, sentNames[0]], ['长名称压力分组124', sentNames[1]]]) {
        if (!(await button(group).isVisible())) await button('表情包面板').click();
        await button(group).click();
        await page.getByRole('button').filter({ has: page.locator('img[alt="' + name + '"]') }).click();
        await page.waitForFunction(async name => (await globalThis.__stickerQaDB.getMessagesByCharId('sticker-qa'))
            .some(m => m.type === 'emoji' && m.metadata?.stickerName === name), name);
    }
    const pendingChatRequest = page.waitForRequest(req => req.url() === 'https://model.example.test/v1/chat/completions');
    await page.locator('[data-guide="generate"]').click();
    const chatMessages = (await pendingChatRequest).postDataJSON().messages;
    const userTurns = chatMessages.filter(m => m.role === 'user');
    for (const name of sentNames)
        assert(userTurns.some(m => typeof m.content === 'string' && m.content.includes('[用户 发送了表情包: ' + name + ']')));
    assert(!/blobref:|image_url|data:image\/|img\.example\.test\/link--test/.test(JSON.stringify(chatMessages)));
    assert(!chatRequests.some(r => r.url.includes('vision.example.test')));
    console.log('已从私聊发送重新导入的本地图片和链接表情，检查主 API 请求均为原有文字格式。');
    assert.deepEqual(errors, []);
    console.log(
        '通过：真实私聊入口，本地多选、同名防覆盖、重复跳过、下载 ZIP、批量删除、原文件重新导入、GIF 字节、分组、容量、角色分配和主 API 单次为 16 张图片命名及状态栏安全区。'
    );
} catch (error) {
    console.error(error);
    if (qaPage) console.error(await qaPage.locator('.st-library').allTextContents());
    throw error;
} finally {
    await browser?.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
    await rm(dir, { recursive: true, force: true });
}
