import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: process.env.FISHING_BROWSER_CHANNEL || 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 412, height: 820 }, hasTouch: true });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.goto(new URL('/test/fixtures/companion-camera.html?view=scene', process.env.BASE_URL || 'http://127.0.0.1:5220').href);
  const button = name => page.getByRole('button', { name, exact: true });
  await button('进入同行').click();
  await button('开启镜头').click();
  const cameraSettings = async () => { await button('同行设置').click(); await button('镜头与形象').click(); };
  await cameraSettings();
  await page.getByLabel('角色镜头形象', { exact: true }).selectOption('model');
  await page.getByLabel('沉浸式表演', { exact: true }).check();
  await button('回到通话').click();
  const canvas = page.locator('[data-live2d-ready="true"] canvas').first();
  await canvas.waitFor({ timeout: 120_000 });
  await canvas.evaluate(el => { window.walkTestCanvas = el; el.style.backgroundColor = '#ff00ff'; });
  const pixels = async () => {
    const png = (await canvas.screenshot()).toString('base64');
    return page.evaluate(async bytes => {
      const image = await createImageBitmap(await (await fetch('data:image/png;base64,' + bytes)).blob());
      const ctx = new OffscreenCanvas(image.width, image.height).getContext('2d');
      ctx.drawImage(image, 0, 0); image.close();
      const { data, width, height } = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
      let n = 0, sx = 0, sy = 0;
      for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
        const i = 4 * (y * width + x);
        if (data[i] > 230 && data[i + 1] < 30 && data[i + 2] > 230) continue;
        n++; sx += x; sy += y;
      }
      return { n, x: sx / n / width, y: sy / n / height };
    }, png);
  };
  const before = await pixels();
  assert.ok(before.n > 100, 'model rendered');
  const drag = async (x, y) => page.locator('.call-placement-host').evaluate((el, [offsetX, offsetY]) => {
    const box = el.getBoundingClientRect();
    const event = (type, dx, dy) => {
      const points = [.60, .75].map((x, i) => new Touch({ identifier: i + 1, target: el,
        clientX: box.x + (x + dx) * box.width, clientY: box.y + (.65 + dy) * box.height }));
      el.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: type === 'touchend' ? [] : points, changedTouches: points }));
    };
    event('touchstart', 0, 0); event('touchmove', offsetX, offsetY); event('touchend', offsetX, offsetY);
  }, [x, y]);
  await drag(.30, .15);
  await page.waitForTimeout(160);
  const clipped = await pixels();
  assert.ok(clipped.n < before.n * .85, 'character actually extends outside the frame');
  await drag(-.50, -.30);
  await page.waitForTimeout(200);
  const moved = await pixels();
  assert.ok(moved.x < before.x - .10 && moved.y < before.y - .06, 'visible model follows both axes: ' + JSON.stringify({ before, moved }));
  assert.ok(moved.n >= before.n * .9, 'previously clipped pixels return without resetting the model');
  for (const layout of ['rows', 'columns', 'pip', 'overlay']) {
    await cameraSettings(); await page.getByLabel('画面布局').selectOption(layout);
    if (layout === 'pip') await page.getByLabel('主画面').selectOption('camera');
    await button('回到通话').click();
    assert.equal(await canvas.evaluate(el => el === window.walkTestCanvas), true);
    const role = await canvas.boundingBox(), video = await page.locator('.companion-scene video').boundingBox();
    if (layout === 'rows') assert.ok(role.y + role.height <= video.y + 2);
    if (layout === 'columns') assert.ok(role.x + role.width <= video.x + 2);
    if (layout === 'pip') assert.ok(role.width < video.width * .4);
  }
  const stage = page.locator('.companion-stage'), controls = page.locator('.companion-actions');
  const originalStage = await stage.boundingBox(), originalControls = await controls.boundingBox();
  await page.getByLabel('对同行伙伴说').focus();
  await page.locator('#root').evaluate(el => { el.style.height = '480px'; });
  await page.waitForFunction(() => document.querySelector('[data-call-composer]').getBoundingClientRect().bottom <= 480);
  assert.deepEqual(await stage.boundingBox(), originalStage); assert.deepEqual(await controls.boundingBox(), originalControls);
  await page.locator('#root').evaluate(el => { el.style.height = ''; document.activeElement.blur(); });
  await page.waitForFunction(() => !document.querySelector('[data-composing]'));
  assert.deepEqual(await stage.boundingBox(), originalStage);
  await page.getByLabel('对同行伙伴说').fill('看那边');
  await button('发送').click();
  await page.waitForFunction(() => document.querySelector('[data-live2d-last-action]')?.getAttribute('data-live2d-last-action')?.includes('expression-4'));
  assert.equal(await page.locator('.companion-caption p').first().textContent(), '这是固定示例回复。');
  assert.deepEqual(errors, []);
  console.log('Live2D rendered and moved, four layouts reused the canvas, keyboard preserved the scene.', { before, moved });
} finally {
  await browser.close();
}
