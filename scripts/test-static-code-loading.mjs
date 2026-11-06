// Isolated real-browser SW regression. Never connects to a user's browser profile or storage.
// pnpm exec node scripts/test-static-code-loading.mjs [production build A] [same-code build B]
// PLAYWRIGHT_MODULE may point to a host-provided playwright/index.mjs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { workerBundleOptions } from './worker-bundle-options.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const prefix = '/SullyOS/';
const files = new Map([
  ['index.html', '<!doctype html><div id="root"></div><script type="module" src="./assets/build/main-abcdefgh.js"></script>'],
  ['assets/build/main-abcdefgh.js', 'document.getElementById("root").textContent="offline-ready";'],
  ['assets/build/body-abcdefgh.js', 'export const value="body-recovered";'],
  ['assets/build/headers-abcdefgh.js', 'export const value="headers-recovered";'],
  ['assets/build/style-abcdefgh.css', 'body { --recovered: yes; }'],
]);
const manifest = {
  buildId: 'browser-smoke-a', appVersion: 'smoke', shell: ['index.html', 'assets/build/main-abcdefgh.js'],
  entries: [...files].map(([url, body]) => ({ url, bytes: Buffer.byteLength(body), revision: createHash('sha256').update(body).digest('hex') })),
};
async function worker(buildId) {
  const result = await build({ ...workerBundleOptions, entryPoints: ['worker/sw-keep-alive.ts'], write: false,
    define: { __STATIC_CACHE_MANIFEST__: JSON.stringify({ ...manifest, buildId }) } });
  return result.outputFiles[0].text;
}
let sw = await worker(manifest.buildId);
const counts = new Map();
const mime = path => path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html';
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (!url.pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
  const path = url.pathname.slice(prefix.length) || 'index.html';
  if (path === 'sw-keep-alive.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }).end(sw); return; }
  const body = files.get(path);
  if (!body) { res.writeHead(404).end(); return; }
  counts.set(path, (counts.get(path) || 0) + 1);
  const failFirst = /\/(body|headers|style)-/.test(path) && counts.get(path) === 1;
  if (failFirst && path.includes('headers-')) return; // no response headers
  res.writeHead(200, { 'Content-Type': mime(path), 'Cache-Control': 'public, max-age=0' });
  if (failFirst) { res.write(path.endsWith('.css') ? 'body {' : 'export '); return; } // headers + incomplete body
  res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(90_000);
async function message(type, target = 'active') {
  return page.evaluate(async ({ type, target }) => {
    const registration = await navigator.serviceWorker.getRegistration();
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => reject(new Error('SW message timeout')), 60_000);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
      registration[target].postMessage({ type }, [channel.port2]);
    });
  }, { type, target });
}
let productionServer;
try {
  await page.goto(origin + prefix);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('./sw-keep-alive.js');
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  assert.equal((await message('SULLY_CACHE_PREPARE')).offlineReady, true);
  await context.setOffline(true);
  await page.reload();
  assert.equal(await page.locator('#root').textContent(), 'offline-ready');
  await context.setOffline(false);
  console.log('PASS: installed shell starts offline under /SullyOS/');

  const recovered = await page.evaluate(async () => {
    const css = new Promise((resolve, reject) => {
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = './assets/build/style-abcdefgh.css';
      link.onload = () => resolve(getComputedStyle(document.body).getPropertyValue('--recovered').trim());
      link.onerror = reject; document.head.append(link);
    });
    return Promise.all([import('./assets/build/body-abcdefgh.js').then(m => m.value),
      import('./assets/build/headers-abcdefgh.js').then(m => m.value), css]);
  });
  assert.deepEqual(recovered, ['body-recovered', 'headers-recovered', 'yes']);
  for (const file of ['body', 'headers', 'style']) assert.equal(counts.get(`assets/build/${file}-abcdefgh.${file === 'style' ? 'css' : 'js'}`), 2);
  console.log('PASS: real dynamic imports and CSS recover after stalled headers/body, exactly one retry each');

  await page.evaluate(() => { localStorage.setItem('smoke-preserve', 'keep'); });
  sw = await worker('browser-smoke-b');
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
  const prepared = await message('SULLY_CACHE_PREPARE', 'waiting');
  assert.equal(prepared.buildId, 'browser-smoke-b'); assert.equal(prepared.offlineReady, true);
  await page.evaluate(async () => {
    const next = (await navigator.serviceWorker.getRegistration()).waiting;
    const changed = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    next.postMessage({ type: 'SULLY_ACTIVATE_UPDATE' }); await changed;
  });
  assert.equal((await message('SULLY_CACHE_STATUS')).buildId, 'browser-smoke-b');
  await context.setOffline(true); await page.reload();
  assert.equal(await page.locator('#root').textContent(), 'offline-ready');
  assert.equal(await page.evaluate(() => localStorage.getItem('smoke-preserve')), 'keep');
  await context.setOffline(false);
  console.log('PASS: waiting worker prepares, activates, and starts offline with storage preserved');

  if (process.argv[2]) {
    let directory = resolve(process.argv[2]);
    const codeRequests = [];
    const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
    productionServer = createServer(async (req, res) => {
      try {
        const pathname = new URL(req.url, 'http://local').pathname;
        if (pathname === '/__cache-probe.html') { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end('<!doctype html><p>isolated update probe</p>'); return; }
        if (/\/assets\/build\/.*\.(js|css)$/.test(pathname)) codeRequests.push(pathname);
        const path = resolve(directory, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname), new URL(req.url, 'http://local').pathname.endsWith('/') ? 'index.html' : '');
        if (!path.startsWith(directory + sep)) { res.writeHead(403).end(); return; }
        const body = await readFile(path);
        res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=0' }).end(body);
      } catch { res.writeHead(404).end(); }
    });
    await new Promise(resolve => productionServer.listen(0, '127.0.0.1', resolve));
    const prodOrigin = `http://127.0.0.1:${productionServer.address().port}`;
    // Block external CDN/analytics/API traffic; local production startup must stand on its own.
    await context.route('**/*', route => route.request().url().startsWith(prodOrigin) ? route.continue() : route.abort());
    await page.goto(prodOrigin);
    await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount || 0) > 0);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const initial = await message('SULLY_CACHE_PREPARE');
    assert.equal(initial.offlineReady, true);
    const pageBuildA = await page.evaluate(() => globalThis.__APP_BUILD_ID__);
    if (process.argv[3]) assert.equal(pageBuildA, initial.buildId);
    await context.setOffline(true); await page.reload();
    await page.waitForFunction(() => (document.querySelector('#root')?.textContent?.length || 0) > 20);
    assert.equal((await message('SULLY_CACHE_STATUS')).offlineReady, true);
    console.log('PASS: production build mounts with external traffic blocked and reopens offline');
    if (process.argv[3]) {
      await context.setOffline(false);
      // Leave the app to stop idle preloads; only the update preparation should issue requests.
      await page.goto(prodOrigin + '/__cache-probe.html');
      directory = resolve(process.argv[3]);
      const expectedBuild = (await readFile(resolve(directory, 'index.html'), 'utf8')).match(/data-sully-build="([^"]+)"/)?.[1];
      assert.ok(expectedBuild, 'build B must contain page-scoped metadata');
      codeRequests.length = 0;
      await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update(); });
      // Keep the exact worker reference through status/prepare: registration.waiting can
      // change between browser round trips while queued app registration jobs finish.
      const next = await page.evaluate(async expected => {
        const registration = await navigator.serviceWorker.getRegistration();
        const request = (worker, type) => new Promise((resolve, reject) => {
          const channel = new MessageChannel();
          const timer = setTimeout(() => { channel.port1.close(); reject(new Error('worker replaced or unresponsive')); }, 2000);
          channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
          worker.postMessage({ type }, [channel.port2]);
        });
        return new Promise((resolve, reject) => {
          let busy = false;
          const timer = setTimeout(() => { clearInterval(poll); reject(new Error('intended release did not become ready')); }, 60_000);
          const poll = setInterval(async () => {
            if (busy) return;
            const worker = registration.waiting;
            if (!worker) return;
            busy = true;
            try {
              const status = await request(worker, 'SULLY_CACHE_STATUS');
              if (status.buildId !== expected) return;
              const prepared = await request(worker, 'SULLY_CACHE_PREPARE');
              clearTimeout(timer); clearInterval(poll); resolve(prepared);
            } catch { /* Another registration job may have replaced this candidate. */ }
            finally { busy = false; }
          }, 100);
        });
      }, expectedBuild);
      assert.equal(next.offlineReady, true); assert.equal(next.buildId, expectedBuild); assert.notEqual(next.buildId, pageBuildA);
      assert.deepEqual(codeRequests, [], 'same-code update must reuse installed JS/CSS without network transfers');
      await page.evaluate(async () => {
        const next = (await navigator.serviceWorker.getRegistration()).waiting;
        if (!next) return;
        const changed = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
        next.postMessage({ type: 'SULLY_ACTIVATE_UPDATE' }); await changed;
      });
      await context.setOffline(true); await page.goto(prodOrigin);
      await page.waitForFunction(() => (document.querySelector('#root')?.textContent?.length || 0) > 20);
      assert.equal(await page.evaluate(() => globalThis.__APP_BUILD_ID__), next.buildId);
      assert.equal((await message('SULLY_CACHE_STATUS')).buildId, next.buildId);
      console.log('PASS: real same-code release update requests zero JS/CSS files and boots offline with the new page identity');
    }
  }
} finally {
  await context.close(); await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (productionServer) { productionServer.closeAllConnections(); await new Promise(resolve => productionServer.close(resolve)); }
}
