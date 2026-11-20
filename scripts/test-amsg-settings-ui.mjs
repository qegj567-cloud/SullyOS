import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = 'output/amsg-settings-qa';
mkdirSync(out, { recursive: true });
if (!process.env.AMSG_QA_SKIP_BUILD) await build({
  configFile: false, plugins: [react()], publicDir: false, logLevel: 'warn',
  define: { __BUILD_BADGE_VISIBLE__: 'false' },
  build: { outDir: `${out}/site`, emptyOutDir: false, minify: false, rollupOptions: { input: 'test/fixtures/amsg-settings.html', external: ['katex'] } },
});
const site = path.resolve(`${out}/site`);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const vendor = pathname === '/vendor/tailwind-3.4.17.js';
    const file = vendor ? path.resolve('public/vendor/tailwind-3.4.17.js') : path.resolve(site, '.' + pathname);
    if (!vendor && !file.startsWith(site + path.sep)) { response.writeHead(403).end(); return; }
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
let page;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AMSG_QA_BROWSER_CHANNEL ? { channel: process.env.AMSG_QA_BROWSER_CHANNEL } : {}) });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
  await page.addInitScript(() => Object.assign(window, { __BUILD_BRANCH__: 'qa', __BUILD_COMMIT__: 'preview', __BUILD_TIME__: 'QA', __APP_BUILD_ID__: 'amsg-settings-qa' }));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const base = `http://127.0.0.1:${server.address().port}/test/fixtures/amsg-settings.html`;
  if (process.env.AMSG_QA_PERF_ONLY) {
    const { measureAmsgSettings } = await import('./amsg-settings-performance.mjs');
    await measureAmsgSettings(page, base, out);
    assert.deepEqual(errors, []);
  } else {
  await page.goto(`${base}?platform=apk`);
  await page.getByRole('button', { name: /^主动消息 2.0/ }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 0);
  await page.screenshot({ path: `${out}/section-390.png`, animations: 'disabled' });
  await page.getByRole('button', { name: /^主动消息 2.0/ }).click();
  const detail = page.getByRole('dialog', { name: '主动消息 2.0', exact: true });
  const sidebar = detail.getByRole('tablist', { name: '主动消息分区', exact: true });
  // Exercise the shell's normal / compact / hidden / contained safe-area
  // values without adding a second hardcoded iPhone status-bar spacer.
  for (const top of [83, 59, 24, 0]) {
    await page.evaluate(value => document.documentElement.style.setProperty('--chrome-top', `${value}px`), top);
    const back = detail.getByRole('button', { name: '返回上一级', exact: true });
    const headerPadding = await detail.locator(':scope > .amsg-detail-header').evaluate(element => parseFloat(getComputedStyle(element).paddingTop));
    assert.equal(headerPadding, top);
    assert.ok((await back.boundingBox()).y - (await detail.boundingBox()).y >= top);
    assert.equal(await back.evaluate(element => { const rect = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); }), true);
  }
  await page.evaluate(() => document.documentElement.style.setProperty('--chrome-top', '59px'));
  await page.screenshot({ path: `${out}/safe-header-390.png`, animations: 'disabled' });
  await page.evaluate(() => document.documentElement.style.removeProperty('--chrome-top'));
  assert.deepEqual(await sidebar.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label'))), ['功能总览', '通知与设备', '功能设置']);
  const config = detail.getByRole('region', { name: '主动消息配置内容', exact: true });
  const subnav = config.getByRole('tablist', { name: '功能设置分区', exact: true });
  const openConnection = async () => {
    await sidebar.getByRole('tab', { name: '功能设置', exact: true }).click();
    await subnav.getByRole('tab', { name: '连接与迁移', exact: true }).click();
  };
  assert.equal(await sidebar.getByRole('tab', { name: '功能总览', exact: true }).getAttribute('aria-selected'), 'true');
  const master = config.getByRole('switch', { name: '主动消息 2.0 总开关', exact: true });
  const instant = config.getByRole('switch', { name: '即时对话总开关', exact: true });
  await master.waitFor();
  assert.equal(await master.isChecked(), true);
  assert.equal(await instant.isChecked(), true);
  const linRow = config.getByRole('button', { name: '配置 林 的主动消息', exact: true });
  const yueRow = config.getByRole('button', { name: '配置 月 的主动消息', exact: true });
  assert.match(await linRow.innerText(), /主动消息：已启用[\s\S]*即时对话：跟随全局/);
  assert.match(await yueRow.innerText(), /主动消息：未启用[\s\S]*即时对话：单独关闭/);
  for (const width of [320, 390, 900]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await config.locator('.amsg-detail-scroll').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    assert.equal(await sidebar.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    console.log('Overview layout:', { width, switchGroupHeight: (await config.locator('.amsg-overview-controls').boundingBox()).height });
    await page.screenshot({ path: `${out}/overview-${width}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // Both entry points use the real character form and functional updater; changing
  // one preference must not change scheduling or another character's preference.
  await config.getByRole('button', { name: '配置 林 的主动消息', exact: true }).click();
  const linPage = page.getByRole('dialog', { name: '林 · 主动消息', exact: true });
  await linPage.getByRole('switch', { name: '角色即时对话', exact: true }).waitFor();
  await linPage.getByRole('region', { name: '消息排期' }).getByText('暂无排期', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="角色即时对话"]')?.disabled);
  assert.equal(await page.getByRole('dialog').count(), 1);
  await linPage.getByRole('switch', { name: '角色即时对话', exact: true }).click();
  assert.equal(await linPage.getByRole('switch', { name: '角色主动消息', exact: true }).isChecked(), true);
  await linPage.getByRole('button', { name: '调整', exact: true }).click();
  const pacing = page.getByRole('dialog', { name: '主动频率', exact: true });
  await pacing.waitFor();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const sizes = await pacing.locator('select').evaluateAll(elements => elements.map(element => ({ width: element.offsetWidth, height: element.offsetHeight })));
    assert.equal(sizes.length, 5);
    assert.ok(sizes.every(size => size.height <= 36 && size.width <= 120));
    assert.equal(await pacing.locator('.amsg-detail-scroll').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: `${out}/pacing-compact-${width}.png`, animations: 'disabled' });
  }
  assert.equal((await pacing.getByRole('switch', { name: '允许每天／每周重复' }).boundingBox()).width, 36);
  assert.equal(await page.getByRole('dialog').count(), 1);
  await pacing.getByRole('button', { name: '返回上一级', exact: true }).click();
  await linPage.waitFor();
  await linPage.getByRole('button', { name: '返回上一级', exact: true }).click();
  assert.match(await linRow.innerText(), /主动消息：已启用[\s\S]*即时对话：单独关闭/);
  assert.match(await yueRow.innerText(), /主动消息：未启用[\s\S]*即时对话：单独关闭/);
  await config.getByRole('button', { name: '配置 月 的主动消息', exact: true }).click();
  const yuePage = page.getByRole('dialog', { name: '月 · 主动消息', exact: true });
  await yuePage.getByRole('switch', { name: '角色主动消息', exact: true }).click();
  assert.equal(await yuePage.getByRole('switch', { name: '角色即时对话', exact: true }).isChecked(), false);
  await page.keyboard.press('Escape');
  assert.match(await yueRow.innerText(), /主动消息：已启用[\s\S]*即时对话：单独关闭/);
  await master.click();
  await config.getByText('全局已暂停 · 聊天在本机生成', { exact: true }).waitFor();
  await config.locator('.amsg-detail-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: `${out}/overview-paused-390.png`, animations: 'disabled' });
  assert.equal(await instant.isChecked(), true);
  assert.match(await linRow.innerText(), /主动消息：已启用[\s\S]*即时对话：单独关闭/);
  assert.equal(await instant.isDisabled(), true);
  await master.click();
  await config.getByRole('switch', { name: '主动消息 2.0 总开关', exact: true, checked: true }).waitFor();
  assert.equal(await instant.isChecked(), true);
  assert.equal(await instant.isDisabled(), false);
  await instant.click();
  assert.equal(await instant.isChecked(), false);
  await instant.click();
  assert.equal(await instant.isChecked(), true);
  await page.getByRole('dialog', { name: '等「发送中」消失后再离开' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: '等「发送中」消失后再离开' }).count(), 0);
  assert.equal(await detail.isVisible(), true);
  assert.match(await yueRow.innerText(), /即时对话：单独关闭/);
  await openConnection();
  await config.getByText('已保存后台连接', { exact: true }).waitFor();
  for (const width of [320, 390, 900]) {
    await page.setViewportSize({ width, height: 844 });
    // Long and short sections must keep the same top padding and navigation position.
    const headerTop = (await detail.locator(':scope > .amsg-detail-header').boundingBox()).y;
    for (const name of ['后台地址与维护', '运行体检', '云端数据', '高级维护', '连接与迁移']) {
      await subnav.getByRole('tab', { name, exact: true }).click();
      await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
      const position = await subnav.evaluate(element => {
        const scroll = element.closest('.amsg-detail-scroll');
        return { top: element.getBoundingClientRect().top, expectedTop: scroll.getBoundingClientRect().top + parseFloat(getComputedStyle(scroll.firstElementChild).paddingTop), scrollTop: scroll.scrollTop };
      });
      assert.ok(Math.abs(position.top - position.expectedTop) < 1, `${width}px ${name}: section navigation keeps top spacing`);
      assert.equal(position.scrollTop, 0);
      assert.equal((await detail.locator(':scope > .amsg-detail-header').boundingBox()).y, headerTop);
    }
    assert.equal(await config.locator('.amsg-detail-scroll').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: `${out}/config-${width}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await subnav.getByRole('tab', { name: '后台地址与维护', exact: true }).click();
  const input = config.getByPlaceholder('https://amsg.你的账号.workers.dev');
  assert.equal(await input.isEnabled(), true);
  await input.fill('');
  assert.equal(await input.isEnabled(), true, 'temporarily clearing an existing address must not lock its editor');
  await input.fill('https://custom.example.invalid');
  for (const width of [320, 390, 900]) {
    await page.setViewportSize({ width, height: 844 });
    const scroll = config.locator('.amsg-detail-scroll');
    assert.equal(await scroll.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    assert.equal(await scroll.evaluate(element => getComputedStyle(element).scrollbarWidth), 'none');
    assert.equal(await subnav.evaluate(element => getComputedStyle(element).scrollbarWidth), 'none');
    assert.equal(await scroll.evaluate(element => getComputedStyle(element).overflowY), 'auto');
    await scroll.evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: `${out}/maintenance-${width}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 480 });
  const maintenanceScroll = config.locator('.amsg-detail-scroll');
  await maintenanceScroll.hover();
  await page.mouse.wheel(0, 200);
  await page.waitForFunction(() => document.querySelector('.amsg-embedded-page .amsg-detail-scroll')?.scrollTop > 0);
  await maintenanceScroll.evaluate(element => { element.scrollTop = 0; });
  await page.setViewportSize({ width: 390, height: 844 });
  await sidebar.getByRole('tab', { name: '通知与设备', exact: true }).click();
  assert.equal(await config.getByRole('radio', { name: '系统推送', exact: true }).isDisabled(), true);
  assert.equal(await config.getByRole('radio', { name: '第三方推送 App', exact: true }).isChecked(), true);
  assert.equal(await config.getByRole('radio', { checked: true }).count(), 1);
  assert.equal(await config.getByRole('combobox', { name: '第三方接收方案', exact: true }).inputValue(), 'ntfy');
  await config.getByText('已登记（就是这台设备）', { exact: true }).waitFor();
  await config.getByRole('button', { name: '发送测试通知', exact: true }).click();
  await config.getByText('已发出 · 请查看通知栏', { exact: true }).waitFor();
  assert.equal(await config.getByRole('button', { name: '重置订阅', exact: true }).count(), 0);
  for (const width of [320, 390, 900]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await config.locator('.amsg-detail-scroll').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await config.locator('.amsg-detail-scroll').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: `${out}/apk-status-${width}.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 1450 });
  await page.screenshot({ path: `${out}/notification-reference-390.png`, animations: 'disabled' });
  await openConnection();
  await subnav.getByRole('tab', { name: '后台地址与维护', exact: true }).click();
  assert.equal(await input.inputValue(), 'https://custom.example.invalid');
  await subnav.getByRole('tab', { name: '连接与迁移', exact: true }).click();
  await config.getByRole('button', { name: /给新设备一份连接码/ }).click();
  await config.getByRole('button', { name: '生成连接码', exact: true }).click();
  const connectionCode = await config.getByRole('textbox', { name: '本机连接码', exact: true }).inputValue();
  assert.match(connectionCode, /^SULLY-AMSG2:/);
  await detail.getByRole('button', { name: '返回上一级', exact: true }).click();
  assert.equal(await config.getByRole('textbox', { name: '本机连接码', exact: true }).count(), 0);
  await detail.getByRole('button', { name: '返回上一级', exact: true }).click();
  assert.equal(await config.getByRole('button', { name: '生成连接码', exact: true }).count(), 0);
  await config.getByText('已保存后台连接', { exact: true }).waitFor();
  // Reconfiguration is an explicit choice, and a historic success marker does
  // not bypass a fresh check of the connection currently shown in the form.
  await config.getByRole('button', { name: '重新配置', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await config.getByRole('region', { name: '重新配置向导', exact: true }).waitFor();
  await page.screenshot({ path: `${out}/reconfigure-390.png`, animations: 'disabled' });
  await config.getByRole('button', { name: '保留后台，重新配置', exact: true }).click();
  assert.equal(await detail.getByRole('button', { name: '验证后继续', exact: true }).isEnabled(), false);
  await config.getByRole('button', { name: '重新连接并验证', exact: true }).click();
  await detail.getByRole('button', { name: '下一步', exact: true }).click();
  await config.getByText('让消息能送到手机上', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '返回上一级', exact: true }).click();
  await config.getByText('先确认后台连接', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '返回上一级', exact: true }).click();
  await config.getByRole('button', { name: '后台也重新部署', exact: true }).click();
  await config.getByLabel('Cloudflare API Token', { exact: true }).waitFor();
  assert.equal(await config.getByRole('textbox', { name: '粘贴连接码', exact: true }).count(), 0);
  await page.screenshot({ path: `${out}/reconfigure-token-390.png`, animations: 'disabled' });
  await detail.getByRole('button', { name: '返回上一级', exact: true }).click();
  await config.getByRole('button', { name: '取消重新配置', exact: true }).click();
  await config.getByText('已保存后台连接', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 1450 });
  await sidebar.getByRole('tab', { name: '功能设置', exact: true }).click();
  assert.equal(await subnav.getByRole('tab').count(), 5);
  assert.equal(await subnav.getByRole('tab').first().getAttribute('aria-label'), '连接与迁移');
  assert.equal(await subnav.getByRole('tab').nth(1).getAttribute('aria-label'), '后台地址与维护');
  await subnav.getByRole('tab', { name: '高级维护', exact: true }).click();
  await config.getByRole('button', { name: '推送凭据（VAPID）', exact: true }).click();
  const vapid = page.getByRole('dialog').filter({ has: page.getByPlaceholder('BA…（点下方「生成新密钥对」自动生成）') });
  await vapid.waitFor();
  await vapid.getByPlaceholder('BA…（点下方「生成新密钥对」自动生成）').fill('preview-public-key');
  await vapid.getByRole('button', { name: '返回上一级', exact: true }).click();
  assert.equal(await subnav.getByRole('tab', { name: '高级维护', exact: true }).getAttribute('aria-selected'), 'true');
  await subnav.getByRole('tab', { name: '云端数据', exact: true }).click();
  await config.getByRole('button', { name: '打开云端数据管理', exact: true }).click();
  await page.getByRole('dialog', { name: '云端数据管理', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1);
  await page.getByRole('dialog', { name: '云端数据管理', exact: true }).getByRole('button', { name: '返回上一级', exact: true }).click();
  assert.equal(await subnav.getByRole('tab', { name: '云端数据', exact: true }).getAttribute('aria-selected'), 'true');
  await subnav.getByRole('tab', { name: '云端数据', exact: true }).press('Home');
  assert.equal(await subnav.getByRole('tab', { name: '连接与迁移', exact: true }).getAttribute('aria-selected'), 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/features-390.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^主动消息 2.0/ }).waitFor();
  // Fresh device: existing backend and deployment are distinct paths.
  await page.goto(`${base}?platform=apk&new`);
  await page.getByRole('button', { name: /^主动消息 2.0/ }).click();
  await config.getByText('首次使用，或在新设备上接回已有配置。', { exact: true }).waitFor();
  assert.equal(await sidebar.getByRole('tab', { name: '功能设置', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await subnav.getByRole('tab', { name: '连接与迁移', exact: true }).getAttribute('aria-selected'), 'true');
  await subnav.getByRole('tab', { name: '后台地址与维护', exact: true }).click();
  assert.equal(await config.getByPlaceholder('https://amsg.你的账号.workers.dev').isDisabled(), true);
  assert.equal(await config.locator('.amsg-connection-gated[inert]').filter({ visible: true }).count(), 1);
  await page.screenshot({ path: `${out}/disconnected-maintenance-390.png`, animations: 'disabled' });
  await config.getByRole('button', { name: '前往连接与迁移', exact: false }).click();
  assert.equal(await subnav.getByRole('tab', { name: '连接与迁移', exact: true }).getAttribute('aria-selected'), 'true');
  await config.getByText('首次使用，或在新设备上接回已有配置。', { exact: true }).waitFor();
  await sidebar.getByRole('tab', { name: '功能总览', exact: true }).click();
  assert.equal(await config.locator('[aria-label="主动消息 2.0 总开关"]').isDisabled(), true);
  assert.equal(await config.locator('[aria-label="即时对话总开关"]').isDisabled(), true);
  assert.equal(await config.locator('.amsg-overview-character').first().isDisabled(), true);
  assert.equal(await config.locator('.amsg-connection-gated[inert]').filter({ visible: true }).count(), 1);
  await page.screenshot({ path: `${out}/disconnected-overview-390.png`, animations: 'disabled' });
  await sidebar.getByRole('tab', { name: '通知与设备', exact: true }).click();
  assert.equal(await config.locator('.amsg-connection-gated[inert]').filter({ visible: true }).count(), 1);
  assert.equal(await config.getByRole('button', { name: '发送测试通知', exact: true }).count(), 0);
  await page.screenshot({ path: `${out}/disconnected-push-390.png`, animations: 'disabled' });
  await config.getByRole('button', { name: '前往连接与迁移', exact: false }).click();
  await config.getByText('首次使用，或在新设备上接回已有配置。', { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/welcome-390.png`, animations: 'disabled' });
  await config.getByRole('button', { name: /已有后台／换设备/ }).click();
  await config.getByRole('textbox', { name: '粘贴连接码', exact: true }).fill(connectionCode);
  await config.getByRole('button', { name: '读取连接码', exact: true }).click();
  await config.getByRole('button', { name: '验证并连接这台设备', exact: true }).waitFor();
  assert.equal(await config.locator('.amsg-connection-preview').getByText(/连接码不包含角色和聊天记录/).filter({ visible: true }).count(), 1);
  // Preview reads locally; this test does not connect to a real Worker.
  await page.screenshot({ path: `${out}/transfer-390.png`, animations: 'disabled' });
  await detail.getByRole('button', { name: '返回上一级', exact: true }).click();
  await config.getByRole('button', { name: '读取连接码', exact: true }).waitFor();
  assert.equal(await config.getByRole('textbox', { name: '粘贴连接码', exact: true }).inputValue(), connectionCode);
  await page.evaluate(() => window.amsgSettingsBack());
  await config.getByText('首次使用，或在新设备上接回已有配置。', { exact: true }).waitFor();
  await config.getByRole('button', { name: /第一次使用/ }).click();
  await sidebar.getByRole('tab', { name: '通知与设备', exact: true }).click();
  await openConnection();
  await config.getByText('第 1 步，共 4 步', { exact: false }).waitFor();
  assert.equal(await detail.getByRole('button', { name: '装好后继续', exact: true }).isDisabled(), true);
  await page.screenshot({ path: `${out}/guide-390.png`, animations: 'disabled' });
  await config.getByRole('button', { name: '已有后台／换设备', exact: true }).click();
  await config.getByRole('textbox', { name: '粘贴连接码', exact: true }).waitFor();
  await detail.getByRole('button', { name: '返回上一级', exact: true }).click();
  await config.getByText('第 1 步，共 4 步', { exact: false }).waitFor();
  await detail.getByRole('button', { name: '返回上一级', exact: true }).click();
  await config.getByText('首次使用，或在新设备上接回已有配置。', { exact: true }).waitFor();
  await config.getByRole('button', { name: /第一次使用/ }).click();
  await page.keyboard.press('Escape');
  await config.getByText('首次使用，或在新设备上接回已有配置。', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '返回上一级', exact: true }).click();
  await page.getByRole('button', { name: /^主动消息 2.0/ }).waitFor();
  // Hundreds of characters: bounded rendering, composed filters and page return.
  await page.goto(`${base}?many&platform=apk`);
  await page.getByRole('button', { name: /^主动消息 2.0/ }).click();
  await config.getByText('共 302 位', { exact: true }).waitFor();
  assert.equal(await config.locator('.amsg-overview-character').count(), 12);
  const category = config.getByRole('combobox', { name: '角色分类', exact: true });
  const search = config.getByRole('searchbox', { name: '搜索角色', exact: true });
  const pageNumber = config.getByRole('combobox', { name: '角色页码', exact: true });
  assert.equal(await config.getByRole('button', { name: '上一页角色', exact: true }).isDisabled(), true);
  await config.getByRole('button', { name: '下一页角色', exact: true }).click();
  assert.equal(await pageNumber.inputValue(), '1');
  await pageNumber.selectOption('25');
  assert.equal(await config.locator('.amsg-overview-character').count(), 2);
  assert.equal(await config.getByRole('button', { name: '下一页角色', exact: true }).isDisabled(), true);
  await config.getByRole('button', { name: '配置 角色 299 的主动消息', exact: true }).click();
  await page.getByRole('dialog', { name: '角色 299 · 主动消息', exact: true }).getByRole('button', { name: '返回上一级', exact: true }).click();
  assert.equal(await pageNumber.inputValue(), '25');
  await category.selectOption('friends');
  assert.equal(await pageNumber.inputValue(), '0');
  await search.fill('角色 ３００');
  await config.getByText('没有符合条件的角色。', { exact: true }).waitFor();
  await category.selectOption('__ungrouped__');
  assert.equal(await config.locator('.amsg-overview-character').count(), 1);
  await config.getByRole('button', { name: '配置 角色 300 的主动消息', exact: true }).waitFor();
  await search.fill('');
  await category.selectOption('empty');
  assert.equal(await config.locator('.amsg-overview-character').count(), 0);
  assert.equal(await pageNumber.count(), 0);
  await category.selectOption('all');
  await search.fill('林');
  await search.press('Escape');
  assert.equal(await detail.isVisible(), true);
  assert.equal(await search.evaluate(element => element === document.activeElement), false);
  await search.fill('');
  await search.press('Enter');
  await config.locator('.amsg-detail-scroll').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: `${out}/many-characters-390.png`, animations: 'disabled' });
  // Both role-panel presentations share one saved character state, like the two
  // production hosts' OSContext updateCharacter callbacks. No real Worker calls.
  await page.goto(`${base}?shared&platform=apk`);
  await page.getByRole('button', { name: '聊天中的主动消息设置', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="角色即时对话"]')?.disabled);
  assert.equal(await page.locator('input[type="datetime-local"]').count(), 0);
  const roleSwitches = page.getByRole('region', { name: '角色功能开关', exact: true });
  assert.ok((await roleSwitches.boundingBox()).height <= 101);
  await page.screenshot({ path: `${out}/chat-role-settings-390.png`, animations: 'disabled' });
  await page.getByRole('button', { name: /新建定时任务/ }).click();
  await page.locator('input[type="datetime-local"]').waitFor();
  assert.equal(await page.getByRole('switch', { name: '角色主动消息', exact: true }).count(), 0);
  await page.screenshot({ path: `${out}/chat-manual-task-390.png`, animations: 'disabled' });
  await page.getByRole('button', { name: '返回角色设置', exact: true }).click();
  assert.equal(await page.locator('input[type="datetime-local"]').count(), 0);
  await page.getByRole('switch', { name: '角色即时对话', exact: true }).click();
  await page.getByRole('switch', { name: '角色主动消息', exact: true }).click();
  await page.getByText(/关闭尚未保存/).waitFor();
  await page.getByRole('button', { name: '关闭 2.0', exact: true }).click();
  // Already-disabled roles still need the original cleanup retry action when
  // cancelling tasks or purging their cloud state previously failed.
  await page.getByRole('button', { name: '聊天中的主动消息设置', exact: true }).click();
  await page.getByRole('button', { name: '关闭 2.0', exact: true }).waitFor();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: /^主动消息 2.0/ }).click();
  await linRow.waitFor();
  assert.match(await linRow.innerText(), /主动消息：未启用[\s\S]*即时对话：单独关闭/);
  await linRow.click();
  await linPage.getByRole('switch', { name: '角色主动消息', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="角色即时对话"]')?.disabled);
  await linPage.getByRole('switch', { name: '角色即时对话', exact: true }).click();
  await linPage.getByRole('button', { name: '返回上一级', exact: true }).click();
  await detail.getByRole('button', { name: '返回上一级', exact: true }).click();
  await page.getByRole('button', { name: '聊天中的主动消息设置', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="角色即时对话"]')?.disabled);
  assert.equal(await page.getByRole('switch', { name: '角色主动消息', exact: true }).isChecked(), true);
  assert.equal(await page.getByRole('switch', { name: '角色即时对话', exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  // Connected browser: exclusive push selection still supports keyboard input.
  await page.goto(base);
  await page.getByRole('button', { name: /^主动消息 2.0/ }).click();
  await sidebar.getByRole('tab', { name: '通知与设备', exact: true }).click();
  const systemPush = config.getByRole('radio', { name: '系统推送', exact: true });
  const thirdPartyPush = config.getByRole('radio', { name: '第三方推送 App', exact: true });
  assert.equal(await systemPush.isDisabled(), false);
  await systemPush.press('ArrowDown');
  assert.equal(await thirdPartyPush.isChecked(), true);
  assert.equal(await config.getByRole('radio', { checked: true }).count(), 1);
  await thirdPartyPush.press('ArrowUp');
  assert.equal(await systemPush.isChecked(), true);
  assert.equal(await config.getByRole('radio', { checked: true }).count(), 1);
  assert.equal(await config.getByRole('combobox', { name: '第三方接收方案', exact: true }).count(), 0);
  // Actual Settings host: disconnected pages are gated; host focus/scroll return.
  await page.goto(`${base}?full&new`);
  const entry = page.getByRole('button', { name: /^主动消息 2.0/ });
  await entry.scrollIntoViewIfNeeded();
  const entryElement = page.locator('button.amsg-settings-entry');
  const originalScroll = await entryElement.evaluate(element => element.closest('.overflow-y-auto').scrollTop);
  await entry.click();
  await config.getByText('首次使用，或在新设备上接回已有配置。', { exact: true }).waitFor();
  await sidebar.getByRole('tab', { name: '通知与设备', exact: true }).click();
  await config.getByRole('button', { name: '前往连接与迁移', exact: false }).waitFor();
  assert.equal(await entryElement.evaluate(element => Boolean(element.closest('[inert]'))), true);
  await page.evaluate(() => window.amsgSettingsBack());
  await detail.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.matches('button.amsg-settings-entry'));
  assert.equal(await entryElement.evaluate(element => element === document.activeElement), true);
  assert.equal(await entryElement.evaluate(element => element.closest('.overflow-y-auto').scrollTop), originalScroll);
  // Exercise the actual deployment collision and read-only discovery over mocked
  // CF responses. No real Token, Worker, database or subscription is involved.
  const cfCalls = [];
  let allowReplacement = false;
  let deployedBindings = [{ name: 'AMSG_MASTER_KEY', type: 'secret_text' }];
  let drainRemaining = 1860;
  let schedules = [];
  await page.route('https://raw.githubusercontent.com/Tosd0/sullyos-workers/main/amsg/**', route => route.request().url().endsWith('worker.bundle.js')
    ? route.fulfill({ body: 'src_default as default' + ' '.repeat(110000) }) : route.fulfill({ status: 404, body: '' }));
  await page.route('https://sullyos-amsg.fixture-owner.workers.dev/**', route => route.fulfill({ json: { ok: true } }));
  await page.route('https://custom.example.test/**', route => route.fulfill({ json: { ok: true } }));
  await page.route('**/cf-api*', async route => {
    const request = route.request();
    const apiPath = new URL(request.url()).searchParams.get('path');
    if (!apiPath) { await route.fulfill({ json: { relay: 'cf-api', version: 1 }, headers: { 'Access-Control-Allow-Origin': '*' } }); return; }
    const method = request.headers()['x-cf-method'];
    cfCalls.push({ method, path: apiPath });
    if (method !== 'GET' && !allowReplacement) { await route.abort(); return; }
    let result;
    if (apiPath === '/user/tokens/verify') result = { status: 'active' };
    else if (apiPath.startsWith('/accounts?')) result = [{ id: 'fixture-account', name: '测试账号' }];
    else if (apiPath.endsWith('/scripts')) result = [{ id: 'sullyos-amsg' }];
    else if (apiPath.endsWith('/settings')) result = { bindings: deployedBindings };
    else if (apiPath.includes('/domains?')) result = [{ service: 'sullyos-amsg', hostname: 'custom.example.test', environment: 'production' }];
    else if (apiPath.includes('/scripts/') && apiPath.endsWith('/subdomain')) result = { enabled: false };
    else if (apiPath.endsWith('/subdomain')) result = { subdomain: 'fixture-owner' };
    else if (apiPath.endsWith('/d1/database') && method === 'POST') result = { uuid: 'new-fixture-db' };
    else if (apiPath.endsWith('/scripts/sullyos-amsg') && method === 'PUT') {
      const match = request.postData().match(/\r\n\r\n(\{"main_module":[^\r\n]+\})\r\n/);
      assert.ok(match, 'Worker upload contains metadata');
      deployedBindings = JSON.parse(match[1]).bindings;
      result = {};
    } else if (apiPath.endsWith('/schedules')) {
      if (method === 'PUT') schedules = request.postDataJSON();
      result = { schedules };
    } else if (apiPath.endsWith('/d1/database/new-fixture-db/query')) result = [{ success: true, results: request.postDataJSON().sql.startsWith('SELECT') ? [{ remaining: drainRemaining }] : [] }];
    else { await route.abort(); return; }
    await route.fulfill({ json: { success: true, result }, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto(`${base}?new&platform=apk`);
  await page.getByRole('button', { name: /^主动消息 2.0/ }).click();
  await config.getByRole('button', { name: /第一次使用/ }).click();
  await config.locator('.amsg-deploy-form input[type="password"]').fill('fixture-cf-token');
  await config.getByRole('button', { name: '开始部署', exact: true }).click();
  await config.getByText('找到 1 个已有后台', { exact: true }).waitFor();
  const discovery = config.locator('details').filter({ has: page.locator('summary', { hasText: '查找已有部署' }) });
  assert.equal(await discovery.evaluate(element => element.open), true);
  await page.waitForFunction(() => document.activeElement?.classList.contains('amsg-discovery-actions'));
  const lookupPosition = await discovery.locator('.amsg-discovery-actions').boundingBox();
  assert.ok(lookupPosition.y > 100 && lookupPosition.y < 500);
  assert.equal(await discovery.getByLabel('Cloudflare API Token', { exact: true }).count(), 0);
  for (const label of ['用连接码接回', '从备份恢复', '重新部署，不接续旧数据']) {
    assert.equal(await discovery.getByRole('button', { name: label, exact: true }).isEnabled(), true);
  }
  await discovery.getByText('https://custom.example.test', { exact: true }).waitFor();
  assert.ok(cfCalls.every(call => call.method === 'GET'));
  assert.equal(cfCalls.filter(call => call.path.endsWith('/settings')).length, 1);
  assert.ok(!cfCalls.some(call => /\/d1\/|\/secrets/.test(call.path)));
  await page.screenshot({ path: `${out}/automatic-discovery-390.png`, animations: 'disabled' });
  await sidebar.getByRole('tab', { name: '功能总览', exact: true }).click();
  await sidebar.getByRole('tab', { name: '功能设置', exact: true }).click();
  assert.equal(cfCalls.filter(call => call.path.endsWith('/settings')).length, 1);
  await config.getByText('找到 1 个已有后台', { exact: true }).waitFor();
  await config.getByRole('button', { name: '用连接码接回', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '粘贴连接码');
  await detail.getByRole('button', { name: '返回上一级', exact: true }).click();
  await config.getByRole('button', { name: '重新部署，不接续旧数据', exact: true }).click();
  await config.getByRole('button', { name: '确认重新部署', exact: true }).waitFor();
  assert.ok(cfCalls.every(call => call.method === 'GET'));
  await page.screenshot({ path: `${out}/redeploy-confirm-390.png`, animations: 'disabled' });
  await detail.getByRole('button', { name: '返回上一级', exact: true }).click();
  assert.ok(cfCalls.every(call => call.method === 'GET'));
  await config.getByRole('button', { name: '重新部署，不接续旧数据', exact: true }).click();
  allowReplacement = true;
  await config.getByRole('button', { name: '确认重新部署', exact: true }).click();
  await config.getByRole('button', { name: '检查并继续重新部署', exact: true }).waitFor();
  assert.equal(cfCalls.filter(call => call.path.endsWith('/scripts/sullyos-amsg') && call.method === 'PUT').length, 1);
  assert.equal(schedules.length, 0);
  assert.equal(await detail.getByRole('button', { name: '验证后继续', exact: true }).isEnabled(), false);
  await page.screenshot({ path: `${out}/redeploy-wait-390.png`, animations: 'disabled' });
  await page.reload();
  await page.getByRole('button', { name: /^主动消息 2.0/ }).click();
  await config.getByRole('button', { name: /继续重新配置/ }).click();
  const resumedToken = config.getByLabel('Cloudflare API Token', { exact: true });
  assert.equal(await resumedToken.inputValue(), '');
  await resumedToken.fill('fixture-cf-token');
  await config.getByRole('button', { name: '查找已有后台', exact: true }).click();
  await config.getByRole('button', { name: '继续重新部署', exact: true }).click();
  drainRemaining = 0;
  await config.getByRole('button', { name: '确认重新部署', exact: true }).click();
  await detail.getByRole('button', { name: '下一步', exact: true }).waitFor();
  assert.equal(cfCalls.filter(call => call.path.endsWith('/d1/database') && call.method === 'POST').length, 1);
  assert.equal(cfCalls.filter(call => call.path.endsWith('/scripts/sullyos-amsg') && call.method === 'PUT').length, 2);
  assert.ok(!cfCalls.some(call => (call.path.endsWith('/query') && !call.path.includes('/new-fixture-db/')) || call.method === 'DELETE'));
  assert.ok(schedules.length > 0);
  // The production Settings host routes the backup action to its existing restore UI.
  allowReplacement = false;
  await page.goto(`${base}?full&new`);
  await page.getByRole('button', { name: /^主动消息 2.0/ }).click();
  await config.getByRole('button', { name: /第一次使用/ }).click();
  await config.locator('.amsg-deploy-form input[type="password"]').fill('fixture-cf-token');
  await config.getByRole('button', { name: '开始部署', exact: true }).click();
  await config.getByRole('button', { name: '从备份恢复', exact: true }).click();
  await detail.waitFor({ state: 'detached' });
  await page.getByText('导入备份 (.zip / .json)', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-amsg-backup-restore'));
  const restorePosition = await page.locator('[data-amsg-backup-restore]').boundingBox();
  assert.ok(restorePosition.y > 0 && restorePosition.y + restorePosition.height < 844);
  // Actual MessageItem: the tiny receipt stays beside the timestamp through
  // preparation/upload and an app-internal navigation, and only acceptance hides it.
  await page.goto(`${base}?send`);
  const progress = page.getByRole('button', { name: '发送中，查看说明', exact: true });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: '模拟准备', exact: true }).click();
    await progress.waitFor();
    assert.ok((await progress.boundingBox()).height <= 16);
    assert.match(await progress.locator('..').innerText(), /发送中[\s\S]*\d{2}:\d{2}/);
    const before = await page.locator('.sully-chat-message-content').boundingBox();
    await page.getByRole('button', { name: '模拟接收', exact: true }).click();
    await progress.waitFor(); // Preparation alone cannot acknowledge a send.
    await page.screenshot({ path: `${out}/send-inline-${width}.png`, animations: 'disabled' });
    await progress.click();
    const help = page.getByRole('dialog', { name: '等「发送中」消失后再离开' });
    await help.waitFor();
    assert.match(await help.innerText(), /不开启即时聊天也一样/);
    assert.equal(await help.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: `${out}/send-help-${width}.png`, animations: 'disabled' });
    await help.getByRole('button', { name: '知道了' }).click();
    await page.getByRole('button', { name: '模拟上传', exact: true }).click();
    await page.getByRole('button', { name: '切出或返回聊天', exact: true }).click();
    assert.equal(await progress.count(), 0);
    await page.getByRole('button', { name: '切出或返回聊天', exact: true }).click();
    await progress.waitFor();
    for (const timestamp of ['never', 'hover', 'always']) {
      await page.getByRole('combobox', { name: '时间显示' }).selectOption(timestamp);
      assert.equal(await progress.isVisible(), true);
    }
    await page.getByRole('button', { name: '模拟接收', exact: true }).click();
    assert.equal(await progress.count(), 0);
    const after = await page.locator('.sully-chat-message-content').boundingBox();
    assert.equal(after.height, before.height);
    await page.getByRole('button', { name: '模拟准备', exact: true }).click();
    await page.getByRole('button', { name: '模拟失败', exact: true }).click();
    await page.getByRole('button', { name: '发送未确认，查看说明' }).waitFor();
    await page.getByRole('button', { name: '模拟准备', exact: true }).click();
    await page.getByRole('button', { name: '模拟本机生成', exact: true }).click();
    await page.getByRole('button', { name: '本机生成，查看说明' }).waitFor();
  }
  await page.getByRole('button', { name: '模拟准备', exact: true }).click();
  // The animation is CSS-only: no DOM updates while merely waiting for context/network.
  const mutationCount = await page.locator('.sully-chat-message-content').evaluate(element => new Promise(resolve => {
    let count = 0;
    const observer = new MutationObserver(records => { count += records.length; });
    observer.observe(element, { subtree: true, childList: true, attributes: true, characterData: true });
    setTimeout(() => { observer.disconnect(); resolve(count); }, 1500);
  }));
  assert.equal(mutationCount, 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await progress.locator('i').first().evaluate(element => getComputedStyle(element).animationName), 'none');
  await page.getByRole('button', { name: '模拟取消', exact: true }).click();
  assert.equal(await progress.count(), 0);
  assert.deepEqual(errors, []);
  console.log('Passed: automatic discovery after a deployment collision, connection-first navigation and disconnected gates, 302 characters with category/search/pagination, shared chat/settings role preferences, global pause/resume, five feature tabs, independent backend maintenance, hidden scrollbars with native wheel scrolling, APK state, responsive layout, keyboard/back, migration, guide progress, cloud/VAPID return, and actual Settings host.');
  }
} catch (error) {
  await page?.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); server.close();
}
