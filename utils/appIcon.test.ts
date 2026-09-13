/// <reference types="vitest" />
/**
 * utils/appIcon.test.ts — PWA 图标注入的回归测试。
 *
 * 钉住的三条不变式（每条都对应一个真实踩过的坑，见 appIcon.ts 顶部注释）：
 *   1. 页面上只能有一个 apple-touch-icon —— 多了 iOS 会挑排在前面的原装图标，新图标静默失效。
 *   2. href 必须是 PNG data URI —— iOS 只稳定认 PNG，JPEG/WebP 会被忽略。
 *   3. manifest 里相对路径要折成绝对地址 —— 动态 manifest 的 base 是 blob: URL。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock ────────────────────────────────────────────────────────────

const mockGetBlobForRef = vi.fn();
const mockBlobToDataUrl = vi.fn();
const mockIsStandalone = vi.fn();
const mockToSquarePngDataUrl = vi.fn();

vi.mock('./blobRef', () => ({
  isBlobRef: (v: unknown) => typeof v === 'string' && v.startsWith('blobref:'),
  getBlobForRef: (...args: any[]) => mockGetBlobForRef(...args),
  blobToDataUrl: (...args: any[]) => mockBlobToDataUrl(...args),
}));

vi.mock('./iosStandalone', () => ({
  isStandaloneDisplayMode: () => mockIsStandalone(),
}));

// canvas 在 jsdom 里没法真的渲染，栅格化整层 mock 掉；
// 真实的裁切/编码逻辑由 iconRaster.test.ts 单独覆盖。
vi.mock('./iconRaster', () => ({
  toSquarePngDataUrl: (...args: any[]) => mockToSquarePngDataUrl(...args),
}));

// jsdom 没有 URL.createObjectURL / revokeObjectURL；垫一层并记下 Blob 内容，
// 测试可以直接读回生成的 manifest。
let lastBlobUrlId = 0;
const blobStore = new Map<string, Blob>();

const mockCreateObjectURL = (blob: Blob): string => {
  const id = `blob:mock-${++lastBlobUrlId}`;
  blobStore.set(id, blob);
  return id;
};
const mockRevokeObjectURL = (url: string): void => { blobStore.delete(url); };

// 转出来的 PNG（内容不重要，前缀重要）
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAA';
// 源图故意用 JPEG，用来验证「不管进来什么都得转成 PNG」
const SOURCE_JPEG_BLOB = () => new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' });

import { injectPwaIcon, clearPwaIcon, initPwaIcon, PWA_ICON_APP_ID, PWA_CLASSIC_ICON_VALUE } from './appIcon';

// ── helpers ─────────────────────────────────────────────────────────

const BASE = 'http://localhost:3000';
const ORIGINAL_MANIFEST_HREF = `${BASE}/manifest.webmanifest`;
const ORIGINAL_TOUCH_ICON_HREF = './icons/apple-touch-icon.png';
const ORIGINAL_FAVICON_HREF = './icons/icon-192.png';

/** 复刻 index.html 里真实的三行 link（含那个写死的 apple-touch-icon）。 */
function setupDOM() {
  document.head.innerHTML = `
    <link rel="icon" type="image/png" href="${ORIGINAL_FAVICON_HREF}">
    <link rel="apple-touch-icon" sizes="180x180" href="${ORIGINAL_TOUCH_ICON_HREF}">
    <link rel="manifest" href="${ORIGINAL_MANIFEST_HREF}">
  `;
}

const appleIconLinks = () =>
  Array.from(document.querySelectorAll('link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]'));
const faviconLinks = () =>
  Array.from(document.querySelectorAll('link[rel~="icon"]:not([rel~="apple-touch-icon"])'));

const appleIconHrefs = () => appleIconLinks().map(l => l.getAttribute('href'));
const faviconHrefs = () => faviconLinks().map(l => l.getAttribute('href'));
const manifestHref = () => document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null;

const SAMPLE_MANIFEST = {
  short_name: 'SullyOS',
  name: 'SullyOS',
  display: 'standalone' as const,
  theme_color: '#0f1115',
  background_color: '#0f1115',
  start_url: './',
  scope: './',
  icons: [
    { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
};

// ── setup / teardown ────────────────────────────────────────────────

let origCreate: any;
let origRevoke: any;

beforeEach(() => {
  origCreate = (URL as any).createObjectURL;
  origRevoke = (URL as any).revokeObjectURL;
  (URL as any).createObjectURL = mockCreateObjectURL;
  (URL as any).revokeObjectURL = mockRevokeObjectURL;
  blobStore.clear();
  lastBlobUrlId = 0;

  setupDOM();
  mockGetBlobForRef.mockReset();
  mockBlobToDataUrl.mockReset();
  mockIsStandalone.mockReset();
  mockToSquarePngDataUrl.mockReset();

  mockIsStandalone.mockReturnValue(false);
  // 默认：栅格化成功，返回 PNG
  mockToSquarePngDataUrl.mockResolvedValue(PNG_DATA_URL);

  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    if (url === ORIGINAL_MANIFEST_HREF) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...SAMPLE_MANIFEST }) } as Response);
    }
    return Promise.reject(new Error(`unexpected fetch url: ${url}`));
  });
});

afterEach(() => {
  clearPwaIcon();
  if (origCreate !== undefined) (URL as any).createObjectURL = origCreate;
  else delete (URL as any).createObjectURL;
  if (origRevoke !== undefined) (URL as any).revokeObjectURL = origRevoke;
  else delete (URL as any).revokeObjectURL;
  vi.restoreAllMocks();
});

// ── 不变式 1：只能有一个 apple-touch-icon ───────────────────────────

describe('只能有一个 apple-touch-icon（iOS 会挑排在前面那个）', () => {
  beforeEach(() => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());
  });

  it('注入后 apple-touch-icon 仍然只有一个', async () => {
    expect(appleIconLinks()).toHaveLength(1); // index.html 自带那一个

    await injectPwaIcon('blobref:test');

    expect(appleIconLinks()).toHaveLength(1);
  });

  it('改的是原有 link 的 href，不是 append 新的', async () => {
    await injectPwaIcon('blobref:test');

    // 唯一那个 link 的 href 已经是新图标——旧的 ./icons/apple-touch-icon.png 不存在了
    expect(appleIconHrefs()).toEqual([PNG_DATA_URL]);
    expect(appleIconHrefs()).not.toContain(ORIGINAL_TOUCH_ICON_HREF);
  });

  it('反复注入也不会堆出第二个 link', async () => {
    await injectPwaIcon('blobref:a');
    await injectPwaIcon('blobref:b');
    await injectPwaIcon('blobref:c');

    expect(appleIconLinks()).toHaveLength(1);
  });

  it('页面上有 precomposed 变体时也一起改掉（否则它会抢赢）', async () => {
    const extra = document.createElement('link');
    extra.rel = 'apple-touch-icon-precomposed';
    extra.setAttribute('href', './icons/old-precomposed.png');
    document.head.appendChild(extra);

    await injectPwaIcon('blobref:test');

    // 两个都指向新图标，没有任何一个还留着旧地址
    expect(appleIconHrefs()).toEqual([PNG_DATA_URL, PNG_DATA_URL]);
  });

  it('页面上没有 apple-touch-icon 时会建一个', async () => {
    document.head.innerHTML = `<link rel="manifest" href="${ORIGINAL_MANIFEST_HREF}">`;

    await injectPwaIcon('blobref:test');

    expect(appleIconLinks()).toHaveLength(1);
    expect(appleIconHrefs()).toEqual([PNG_DATA_URL]);
  });
});

// ── 不变式 2：href 必须是 PNG ───────────────────────────────────────

describe('href 必须是 PNG（iOS 只认 PNG）', () => {
  it('源图是 JPEG 也要转成 PNG data URI', async () => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());

    await injectPwaIcon('blobref:jpeg-source');

    const href = appleIconHrefs()[0]!;
    expect(href).toMatch(/^data:image\/png;base64,/);
    // 不能是 blob:（iOS/Chrome 不认作图标）
    expect(href).not.toMatch(/^blob:/);
  });

  it('栅格化尺寸固定 180（apple-touch-icon 标准边长）', async () => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());

    await injectPwaIcon('blobref:test');

    expect(mockToSquarePngDataUrl).toHaveBeenCalledWith(expect.anything(), 180);
  });

  it('data: 源图也过一遍栅格化——原图可能是 JPEG/WebP', async () => {
    await injectPwaIcon('data:image/webp;base64,UklGRg==');

    expect(mockToSquarePngDataUrl).toHaveBeenCalled();
    expect(appleIconHrefs()[0]).toBe(PNG_DATA_URL);
  });

  it('栅格化失败 → 退回原图，不让页面没图标', async () => {
    mockToSquarePngDataUrl.mockRejectedValue(new Error('canvas 挂了'));
    const rawDataUrl = 'data:image/jpeg;base64,/9j/4AA';

    await injectPwaIcon(rawDataUrl);

    expect(appleIconHrefs()[0]).toBe(rawDataUrl);
  });

  it('栅格化失败且源是 Blob → 走 blobToDataUrl 兜底', async () => {
    mockToSquarePngDataUrl.mockRejectedValue(new Error('canvas 挂了'));
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());
    mockBlobToDataUrl.mockResolvedValue('data:image/jpeg;base64,fallback');

    await injectPwaIcon('blobref:test');

    expect(appleIconHrefs()[0]).toBe('data:image/jpeg;base64,fallback');
  });
});

// ── favicon 一起换（UI 提示说了「标签页图标已更新」，得真的更新） ────

describe('favicon 同步更新', () => {
  it('rel="icon" 的 href 也换成新图标', async () => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());

    expect(faviconHrefs()).toEqual([ORIGINAL_FAVICON_HREF]);

    await injectPwaIcon('blobref:test');

    expect(faviconHrefs()).toEqual([PNG_DATA_URL]);
  });

  it('favicon 选择器不会误伤 apple-touch-icon', async () => {
    // rel~="icon" 若不排除 apple-touch-icon，两者会互相干扰
    expect(faviconLinks()).toHaveLength(1);
    expect(faviconLinks()[0].getAttribute('rel')).toBe('icon');
  });
});

// ── 输入合法性 ─────────────────────────────────────────────────────

describe('输入合法性', () => {
  it('http URL → 直接交给栅格化（会带 crossOrigin）', async () => {
    const remote = 'https://cdn.example.com/icon.png';
    await injectPwaIcon(remote);

    expect(mockToSquarePngDataUrl).toHaveBeenCalledWith(remote, 180);
    expect(appleIconHrefs()[0]).toBe(PNG_DATA_URL);
  });

  it('blobRef 解析失败 → 什么都不改，不抛异常', async () => {
    mockGetBlobForRef.mockResolvedValue(null);

    await expect(injectPwaIcon('blobref:dead')).resolves.toBeUndefined();
    expect(appleIconHrefs()).toEqual([ORIGINAL_TOUCH_ICON_HREF]);
    expect(faviconHrefs()).toEqual([ORIGINAL_FAVICON_HREF]);
  });

  it('乱七八糟的值 → 什么都不改，不抛异常', async () => {
    await expect(injectPwaIcon('/relative/path.png')).resolves.toBeUndefined();
    expect(appleIconHrefs()).toEqual([ORIGINAL_TOUCH_ICON_HREF]);
  });
});

// ── 不变式 3：manifest（standalone） ────────────────────────────────

describe('manifest 替换（standalone）', () => {
  beforeEach(() => {
    mockIsStandalone.mockReturnValue(true);
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());
  });

  const readManifest = async () => {
    const blob = blobStore.get(manifestHref()!);
    expect(blob).toBeTruthy();
    return JSON.parse(await blob!.text());
  };

  it('manifest href 换成 blob: URL', async () => {
    await injectPwaIcon('blobref:test');
    expect(manifestHref()).toMatch(/^blob:mock-/);
  });

  it('图标槽全部换成 PNG data URI', async () => {
    await injectPwaIcon('blobref:test');
    const manifest = await readManifest();

    expect(manifest.icons).toHaveLength(3); // 192 / 512 / 512 maskable
    for (const icon of manifest.icons) {
      expect(icon.src).toBe(PNG_DATA_URL);
      expect(icon.type).toBe('image/png');
    }
  });

  it('相对路径折成绝对地址（blob: base 会让相对路径 404）', async () => {
    await injectPwaIcon('blobref:test');
    const manifest = await readManifest();

    expect(manifest.start_url).toBe(`${BASE}/`);
    expect(manifest.scope).toBe(`${BASE}/`);
    // Even a cached manifest with the old name keeps the updated display name.
    expect(manifest.name).toBe('SullyOS·糯米机');
    expect(manifest.short_name).toBe('SullyOS·糯米机');
  });

  it('浏览器安装前也更新 manifest', async () => {
    mockIsStandalone.mockReturnValue(false);

    await injectPwaIcon('blobref:test');

    expect(manifestHref()).toMatch(/^blob:mock-/);
  });

  it('fetch manifest 失败 → apple-touch-icon 照常更新，不抛异常', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'));

    await expect(injectPwaIcon('blobref:test')).resolves.toBeUndefined();
    expect(manifestHref()).toBe(ORIGINAL_MANIFEST_HREF);
    expect(appleIconHrefs()[0]).toBe(PNG_DATA_URL);
  });
});

// ── clearPwaIcon ────────────────────────────────────────────────────

describe('clearPwaIcon', () => {
  it('所有 href 还原成原始值', async () => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());
    mockIsStandalone.mockReturnValue(true);

    await injectPwaIcon('blobref:test');
    expect(appleIconHrefs()[0]).toBe(PNG_DATA_URL);

    clearPwaIcon();

    expect(appleIconHrefs()).toEqual([ORIGINAL_TOUCH_ICON_HREF]);
    expect(faviconHrefs()).toEqual([ORIGINAL_FAVICON_HREF]);
    expect(manifestHref()).toBe(ORIGINAL_MANIFEST_HREF);
  });

  it('还原后 apple-touch-icon 数量不变（不留残骸也不删原装）', async () => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());

    await injectPwaIcon('blobref:test');
    clearPwaIcon();

    expect(appleIconLinks()).toHaveLength(1);
  });

  it('原本没有 apple-touch-icon 时，还原会把建的那个删掉', async () => {
    document.head.innerHTML = `<link rel="manifest" href="${ORIGINAL_MANIFEST_HREF}">`;
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());

    await injectPwaIcon('blobref:test');
    expect(appleIconLinks()).toHaveLength(1);

    clearPwaIcon();
    expect(appleIconLinks()).toHaveLength(0);
  });

  it('没注入过时调用也不抛异常', () => {
    expect(() => clearPwaIcon()).not.toThrow();
  });
});

// ── initPwaIcon ─────────────────────────────────────────────────────

describe('initPwaIcon', () => {
  it('customIcons 里有 _pwa_ → 接上', async () => {
    mockGetBlobForRef.mockResolvedValue(SOURCE_JPEG_BLOB());

    await initPwaIcon({ [PWA_ICON_APP_ID]: 'blobref:saved', some_app: 'blobref:other' });

    expect(appleIconHrefs()[0]).toBe(PNG_DATA_URL);
  });

  it('没有 _pwa_ → 一动不动', async () => {
    await initPwaIcon({ some_app: 'blobref:other' });

    expect(appleIconHrefs()).toEqual([ORIGINAL_TOUCH_ICON_HREF]);
    expect(mockGetBlobForRef).not.toHaveBeenCalled();
  });

  it('空对象 → 不炸', async () => {
    await expect(initPwaIcon({})).resolves.toBeUndefined();
  });

  it('注入过程抛异常也不会把启动流程带崩', async () => {
    mockGetBlobForRef.mockRejectedValue(new Error('IndexedDB 挂了'));

    await expect(initPwaIcon({ [PWA_ICON_APP_ID]: 'blobref:x' })).resolves.toBeUndefined();
  });
});

// ── 常量 ───────────────────────────────────────────────────────────

describe('PWA_ICON_APP_ID', () => {
  it('是 _pwa_，下划线前缀保证不跟 App id 撞名', () => {
    expect(PWA_ICON_APP_ID).toBe('_pwa_');
    expect(PWA_ICON_APP_ID.startsWith('_')).toBe(true);
  });
});

describe('built-in icon choices', () => {
  it.each([false, true])('classic uses bundled PNGs and a stable manifest (standalone=%s)', async standalone => {
    mockIsStandalone.mockReturnValue(standalone);
    await injectPwaIcon(PWA_CLASSIC_ICON_VALUE);
    expect(appleIconHrefs()[0]).toMatch(/icons\/apple-touch-icon\.png$/);
    expect(manifestHref()).toMatch(/manifest-classic\.webmanifest$/);
    expect(mockGetBlobForRef).not.toHaveBeenCalled();
    expect(mockToSquarePngDataUrl).not.toHaveBeenCalled();
    clearPwaIcon();
    expect(manifestHref()).toBe(ORIGINAL_MANIFEST_HREF);
    expect(appleIconHrefs()).toEqual([ORIGINAL_TOUCH_ICON_HREF]);
  });
  it('restores classic from the existing saved icon field', async () => {
    await initPwaIcon({ [PWA_ICON_APP_ID]: PWA_CLASSIC_ICON_VALUE });
    expect(manifestHref()).toMatch(/manifest-classic\.webmanifest$/);
  });
  it('a slow upload cannot overwrite a later default selection', async () => {
    let release!: (blob: Blob) => void;
    mockGetBlobForRef.mockReturnValue(new Promise<Blob>(resolve => { release = resolve; }));
    const pending = injectPwaIcon('blobref:slow');
    clearPwaIcon();
    release(SOURCE_JPEG_BLOB());
    await pending;
    expect(appleIconHrefs()).toEqual([ORIGINAL_TOUCH_ICON_HREF]);
  });
});
