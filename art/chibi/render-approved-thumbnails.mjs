const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
import fs from 'node:fs/promises';

const requested=new Set(process.argv.slice(2));
const catalog = JSON.parse(await fs.readFile('apps/room3d/chibi/approvedWardrobe.json', 'utf8')).filter(def=>!requested.size||requested.has(def.id));
const origin = process.env.WARDROBE_PREVIEW_URL ?? 'http://127.0.0.1:5198';
const directory = 'public/room3d/wardrobe/thumbnails';
const browser = await chromium.launch({channel:'msedge', headless:true});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);});
  await page.goto(new URL('/art/chibi/wardrobe-thumbnails.html', origin).href);
  await page.waitForFunction(() => window.renderGarment);
  await fs.mkdir(directory, {recursive:true});
  for (const def of catalog) {
    const result = await page.evaluate(async def => {
      const data = await window.renderGarment(def);
      // Check the actual pixels, catching empty captures and clipped sleeves.
      const source = document.querySelector('canvas'), canvas = document.createElement('canvas');
      canvas.width = canvas.height = 320;
      const context = canvas.getContext('2d');
      context.drawImage(source, 0, 0);
      const pixels = context.getImageData(0, 0, 320, 320).data;
      let minX = 320, minY = 320, maxX = -1, maxY = -1, count = 0;
      for (let y = 0; y < 320; y++) for (let x = 0; x < 320; x++) {
        if (pixels[(y * 320 + x) * 4 + 3] <= 16) continue;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); count++;
      }
      return {data, ...window.thumbnailReport, pixels:{minX, minY, maxX, maxY, count}};
    }, def);
    const p = result.pixels;
    if (p.count < 100 || Math.min(p.minX, p.minY, 319 - p.maxX, 319 - p.maxY) < 10) {
      throw Error(`${def.id}: empty or clipped thumbnail ${JSON.stringify(p)}`);
    }
    await fs.writeFile(`${directory}/${def.id}.png`, Buffer.from(result.data.split(',')[1], 'base64'));
    console.log(`${def.id}: ${result.pieces} piece(s), ${p.maxX - p.minX + 1} × ${p.maxY - p.minY + 1} px`);
  }
  if (errors.length) throw Error(errors.join('\n'));
  console.log(`Rendered and checked ${catalog.length} garment thumbnails.`);
} finally {
  await browser.close();
}
