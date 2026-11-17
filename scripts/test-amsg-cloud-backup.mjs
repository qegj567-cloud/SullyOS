import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import JSZip from 'jszip';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = 'output/amsg-cloud-backup-qa';
mkdirSync(out, { recursive: true });
if (!process.env.AMSG_QA_SKIP_BUILD) await build({ configFile: false, plugins: [react()], publicDir: false, logLevel: 'warn',
  define: { __BUILD_BADGE_VISIBLE__: 'false' }, build: { outDir: `${out}/site`, minify: false, rollupOptions: { input: 'test/fixtures/amsg-backup.html', external: ['katex'] } } });
const site = path.resolve(`${out}/site`);
const server = createServer((request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const vendor = pathname === '/vendor/tailwind-3.4.17.js';
    const file = vendor ? path.resolve('public/vendor/tailwind-3.4.17.js') : path.resolve(site, '.' + pathname);
    if (!vendor && !file.startsWith(site + path.sep)) return response.writeHead(403).end();
    response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/test/fixtures/amsg-backup.html`;
const browser = await chromium.launch({ headless: true, channel: process.env.AMSG_QA_BROWSER_CHANNEL || 'msedge' });
const uploads = [], errors = [], results = [];
let download;
const cloudConfig = { enabled: true, provider: 'webdav', webdavUrl: 'https://backup.example.invalid', username: 'fixture', password: 'fixture', remotePath: '/backup/', githubToken: 'fixture-only', githubOwner: 'fixture', githubRepo: 'fixture-backup' };
const locationConfig = { enabled: true, provider: 'geoapify', geoapifyKey: 'fixture-geoapify', amapKey: 'fixture-amap', characterIds: ['fixture-amsg-character'], regions: [{ id: 'fixture-home', name: '家', latitude: 31, longitude: 121, radiusKm: 2 }] };
const subtitleConfig = { fontSize: 21, color: '#ffddaa', outlineColor: '#222222', font: 'serif' };
const fontBase64 = readFileSync('assets/fonts/subtitle-rounded-bold.woff2').toString('base64');
let fontId;
const open = async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(config => {
    Object.assign(window, { __BUILD_BRANCH__: 'qa', __BUILD_COMMIT__: 'preview', __BUILD_TIME__: 'QA', __APP_BUILD_ID__: 'amsg-backup-qa' });
    // Explicitly off: file sharing preference must not strip a personal cloud backup.
    localStorage.setItem('os_backup_preferences_v1', JSON.stringify({ includeBackendConnection: false }));
    if (!localStorage.getItem('os_cloud_backup_config')) localStorage.setItem('os_cloud_backup_config', JSON.stringify(config));
  }, cloudConfig);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), headers = request.headers();
    if (url.hostname === '127.0.0.1') return route.continue();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname === '/webdav') {
      const method = headers['x-webdav-method'];
      if (method === 'PUT') { uploads.push(request.postDataBuffer()); return route.fulfill({ status: 201, headers: cors }); }
      if (method === 'GET' && download) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/zip' }, body: download });
      if (method === 'PROPFIND') return route.fulfill({ status: 207, headers: cors, body: '<d:multistatus xmlns:d="DAV:" />' });
      return route.fulfill({ status: 201, headers: cors });
    }
    if (url.hostname === 'uploads.github.com') {
      const body = request.postDataBuffer(), name = url.searchParams.get('name');
      if (name.endsWith('.zip')) uploads.push(body);
      return route.fulfill({ status: 201, headers: cors, json: { id: 10, name, size: body.length, state: 'uploaded' } });
    }
    if (url.hostname === 'api.github.com') return route.fulfill({ status: request.method() === 'POST' ? 201 : 200, headers: cors, json: request.method() === 'GET' ? [] : { id: 20 } });
    return route.abort(); // Never contact a real provider, Worker, model or analytics service.
  });
  const page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => window.amsgBackupQA?.os.characters.length > 0);
  return { context, page };
};
const parse = async bytes => {
  const zip = await JSZip.loadAsync(bytes);
  if (zip.file('user-spaces.json')) {
    const manifest = JSON.parse(await zip.file('user-spaces.json').async('string'));
    const characters = [];
    for (const space of manifest.spaces) for (const filename of space.stores.characters || []) characters.push(...JSON.parse(await zip.file(filename).async('string')));
    const assets = [];
    for (const filename of manifest.spaces.find(space => space.id === 'default').stores.assets || []) assets.push(...JSON.parse(await zip.file(filename).async('string')));
    return { backend: manifest.backend, characters, location: manifest.userLocation?.settings, audiences: manifest.userLocation?.audiences,
      subtitle: JSON.parse(manifest.spaces.find(space => space.id === 'default').local.chat_translate_subtitle_fixture || 'null'), font: JSON.parse(assets.find(asset => asset.id === fontId)?.data || 'null') };
  }
  const metadata = JSON.parse(await zip.file('metadata.json').async('string'));
  const characters = [];
  for (const file of Object.values(zip.files).filter(file => /^stores\/characters\.\d+\.json$/.test(file.name))) characters.push(...JSON.parse(await file.async('string')));
  const { characterIds, ...settings } = metadata.userLocationSettings || {};
  const assets = [];
  for (const file of Object.values(zip.files).filter(file => /^stores\/(assets|activityTextAssets)\.\d+\.json$/.test(file.name))) assets.push(...JSON.parse(await file.async('string')));
  return { backend: metadata.amsg2GlobalConfig, characters, location: settings, audiences: { default: characterIds ?? null }, subtitle: metadata.chatSubtitleByChar?.fixture, font: JSON.parse(assets.find(asset => asset.id === fontId)?.data || 'null') };
};
try {
  const source = await open();
  const font = await source.page.evaluate(data => window.amsgBackupQA.rememberFontDataUrl(data, '备份字体'), 'data:font/woff2;base64,' + fontBase64);
  fontId = font.id; Object.assign(subtitleConfig, { font: 'custom', fontId });
  await source.page.evaluate(config => window.amsgBackupQA.setLocation('default', config), locationConfig);
  await source.page.evaluate(config => localStorage.setItem('chat_translate_subtitle_fixture', JSON.stringify(config)), subtitleConfig);
  await source.page.evaluate(async () => {
    const qa = window.amsgBackupQA;
    await qa.ActiveMsgStore.saveGlobalConfig({ enabled: false, userId: 'fixture-original-owner', workerUrl: 'https://fixture-worker.example.invalid', serverToken: 'fixture-server-secret', masterKey: 'fixture-master-secret', instantChatEnabled: true, initializedAt: 1, pushMode: 'third-party', thirdPartyPush: { provider: 'bark', barkUrl: 'https://fixture-push.example.invalid/key' } });
    await qa.DB.saveCharacter({ id: 'fixture-amsg-character', name: '林', avatar: '', memories: [], activeMsg2Config: { enabled: true, instantChatEnabled: false, maxUnansweredSends: 3, allowSelfRecurring: true, tasks: [{ taskUuid: 'fixture-task', mode: 'auto', source: 'character', recurrenceType: 'daily', firstSendTime: '2099-01-01T00:00:00Z' }] } });
  });
  await source.page.getByRole('button', { name: '云端备份', exact: true }).click();
  await source.page.locator('[data-cloud-backup-amsg-note]').scrollIntoViewIfNeeded();
  await source.page.screenshot({ path: `${out}/cloud-backup-390.png` });
  // Verify both providers and both text-bearing formats, including multi-user cloud backups.
  for (const spaces of [1, 2]) {
    if (spaces === 2) await source.page.evaluate(async () => {
      const qa = window.amsgBackupQA;
      qa.saveUserSpaces([{ id: 'default', name: '甲' }, { id: 'u_fixture_backup', name: '乙' }]);
      await qa.commitSpaceRows(await qa.openSpaceDB('u_fixture_backup'), { characters: [{ id: 'fixture-amsg-other', name: '月', memories: [], activeMsg2Config: { enabled: false, instantChatEnabled: true, tasks: [] } }] }, true);
      qa.setLocation('u_fixture_backup', { ...qa.readLocation('default'), characterIds: [] });
    });
    for (const provider of ['webdav', 'github']) {
      await source.page.evaluate(provider => window.amsgBackupQA.os.updateCloudBackupConfig({ provider }), provider);
      await source.page.waitForFunction(provider => window.amsgBackupQA.os.cloudBackupConfig.provider === provider, provider);
      for (const mode of ['text_only', 'full']) {
        const count = uploads.length;
        await source.page.evaluate(mode => window.amsgBackupQA.os.cloudBackupToWebDAV(mode), mode);
        assert.equal(uploads.length, count + 1);
        const data = await parse(uploads.at(-1));
        assert.equal(data.backend.workerUrl, 'https://fixture-worker.example.invalid');
        assert.equal(data.backend.userId, 'fixture-original-owner');
        assert.equal(data.backend.masterKey, 'fixture-master-secret');
        assert.equal(data.backend.serverToken, 'fixture-server-secret');
        assert.equal(data.backend.enabled, false);
        assert.equal(data.backend.instantChatEnabled, true);
        assert.equal(data.backend.pushMode, 'third-party');
        const { characterIds, ...settings } = locationConfig;
        assert.deepEqual(data.location, settings);
        assert.deepEqual(data.subtitle, subtitleConfig);
        assert.equal(data.font?.base64, fontBase64);
        assert.deepEqual(data.audiences, spaces === 2 ? { default: characterIds, u_fixture_backup: [] } : { default: characterIds });
        const role = data.characters.find(character => character.id === 'fixture-amsg-character').activeMsg2Config;
        assert.equal(role.instantChatEnabled, false); assert.equal(role.maxUnansweredSends, 3);
        assert.equal(role.tasks[0].taskUuid, 'fixture-task');
        if (spaces === 2) assert.equal(data.characters.find(character => character.id === 'fixture-amsg-other').activeMsg2Config.instantChatEnabled, true);
        results.push({ provider, mode, spaces, connection: true, roleSettings: true, tasks: true, location: true });
      }
    }
    // Downloading a file for sharing retains the existing opt-in boundary.
    const file = await source.page.evaluate(async () => Array.from(new Uint8Array(await (await window.amsgBackupQA.os.exportSystem('text_only')).arrayBuffer())));
    const share = await parse(Buffer.from(file));
    assert.equal(share.backend?.workerUrl, undefined);
    assert.equal(share.backend?.masterKey, undefined);
  }
  download = uploads.at(-1);
  const target = await open();
  // Restore the uploaded multi-user archive onto a genuinely fresh browser context.
  await target.page.evaluate(() => { void window.amsgBackupQA.os.cloudRestoreFromWebDAV({ name: 'fixture.zip', href: '/backup/fixture.zip', size: 1, lastModified: '' }, { confirmBackendRestore: () => true }).catch(error => { window.restoreError = error.message; }); });
  let restored;
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await target.page.evaluate(async () => {
      const qa = window.amsgBackupQA;
      if (!qa) return null;
      return { config: await qa.ActiveMsgStore.getGlobalConfig(), characters: await qa.DB.getAllCharacters(), location: qa.readLocation('default'), otherLocation: qa.readLocation('u_fixture_backup'), error: window.restoreError };
    }).catch(error => { if (!/context was destroyed/i.test(error.message)) throw error; return null; });
    if (state?.error) throw new Error(state.error);
    if (state?.config.masterKey === 'fixture-master-secret' && state.location?.enabled && state.characters.some(character => character.id === 'fixture-amsg-character')) { restored = state; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(restored, 'The downloaded backup must restore its original connection on a fresh device');
  assert.equal(restored.config.masterKey, 'fixture-master-secret');
  assert.deepEqual(restored.location, locationConfig);
  assert.deepEqual(restored.otherLocation, { ...locationConfig, characterIds: [] });
  assert.deepEqual(await target.page.evaluate(() => JSON.parse(localStorage.getItem('chat_translate_subtitle_fixture'))), subtitleConfig);
  assert.equal(await target.page.evaluate(async id => (await window.amsgBackupQA.readSavedFont(id))?.base64, fontId), fontBase64);
  await target.context.close();
  const beforeFailure = uploads.length;
  const failure = await source.page.evaluate(async () => {
    const qa = window.amsgBackupQA, original = qa.ActiveMsgStore.getGlobalConfig;
    qa.ActiveMsgStore.getGlobalConfig = async () => { throw new Error('fixture storage unavailable'); };
    try { await qa.os.cloudBackupToWebDAV('text_only'); return 'unexpected success'; }
    catch (error) { return error.message; }
    finally { qa.ActiveMsgStore.getGlobalConfig = original; }
  });
  assert.match(failure, /本次备份已中止/); assert.equal(uploads.length, beforeFailure);
  // The same mounted real Chat must render DB writes whose notification event was missed.
  await source.page.goto(base + '?chat=1');
  await source.page.waitForFunction(() => window.amsgBackupQA?.os.characters.some(c => c.id === 'fixture-amsg-character'));
  await source.page.evaluate(() => window.amsgBackupQA.os.setActiveCharacterId('fixture-amsg-character'));
  await source.page.waitForSelector('.sully-chat-root');
  await source.page.getByText('林', { exact: true }).first().waitFor();
  await source.page.waitForTimeout(300); // Let the initial history read settle before the event-less DB write.
  await source.page.evaluate(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await window.amsgBackupQA.DB.saveMessage({ charId: 'fixture-amsg-character', role: 'assistant', type: 'text', content: 'FORE​​GROUND-FIXTURE-REPLY', timestamp: Date.now() });
  });
  assert.equal(await source.page.getByText('FORE​​GROUND-FIXTURE-REPLY', { exact: true }).count(), 0, 'a missed delivery event leaves the mounted chat stale before resume');
  await source.page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('resume'));
  });
  await source.page.getByText('FORE​​GROUND-FIXTURE-REPLY', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  writeFileSync(`${out}/results.json`, JSON.stringify({ results, freshRestore: true, sameChatResume: true, failureStopsUpload: true, errors }, null, 2));
  console.log(JSON.stringify({ passed: results.length, freshRestore: true, sameChatResume: true, fileSharingStillOptIn: true, failureStopsUpload: true, errors }));
} finally { await browser.close(); server.close(); }
