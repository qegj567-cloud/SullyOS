// 自定义 PWA 应用图标：把用户选的图接到 apple-touch-icon / favicon / manifest 上。
//
// 三条踩过的坑，改这份文件前先读：
//
// 1. **只能有一个 apple-touch-icon**。index.html 里写死了一个 180x180 的，
//    如果再 append 一个同尺寸的，iOS 会挑排在前面那个（也就是原装图标），
//    新图标静默失效。所以这里的做法是**改原有 link 的 href**，而不是新增。
//
// 2. **必须是 PNG**。iOS 的 apple-touch-icon 只稳定支持 PNG；上传管线默认吐 JPEG、
//    图床还可能给 WebP，直接用会被 iOS 忽略。统一走 utils/iconRaster 转 PNG。
//
// 3. **尺寸要压到 180**。源图存的是 512，base64 后几百 KB，塞进 href 又慢又冒险。
//
// 另一条固有约束（不是 bug，改不了）：图标在「添加到主屏幕」那一刻固化。装完之后
// 再改这里的任何东西，主屏和通知图标都不变，只能删掉 App 重新添加。
//
// 详见 docs/superpowers/specs/2026-08-09-pwa-custom-icon-design.md

import { getBlobForRef, isBlobRef, blobToDataUrl } from './blobRef';
import { toSquarePngDataUrl } from './iconRaster';

export const PWA_ICON_APP_ID = '_pwa_';
export const PWA_CLASSIC_ICON_VALUE = 'builtin:classic';
export const PWA_DEFAULT_ICON_URL = import.meta.env.BASE_URL + 'icons/jellyfish-512.png?v=38b1adde1d';
export const PWA_CLASSIC_ICON_URL = import.meta.env.BASE_URL + 'icons/icon-512.png';
let iconRevision = 0;

/** apple-touch-icon 的标准边长。 */
const TOUCH_ICON_SIZE = 180;

const APPLE_ICON_SELECTOR = 'link[rel~="apple-touch-icon"], link[rel~="apple-touch-icon-precomposed"]';
const FAVICON_SELECTOR = 'link[rel~="icon"]:not([rel~="apple-touch-icon"])';
const MANIFEST_SELECTOR = 'link[rel="manifest"]';

// 原始 href 备份，clearPwaIcon 时逐个还原。
const originalHrefs = new WeakMap<HTMLLinkElement, string>();
let originalManifestHref: string | null = null;
let dynamicManifestUrl: string | null = null;

// ── 公开 API ──────────────────────────────────────────────────────

/**
 * 把图标值（blobRef 令牌 / data: URI / http(s) URL）接到页面上。
 * - 总是更新 apple-touch-icon + favicon（浏览器标签页当场就变）
 * - 同时更新 manifest，浏览器安装前选择的图标也能生效
 */
export async function injectPwaIcon(value: string): Promise<void> {
  const revision = ++iconRevision;
  if (value === PWA_CLASSIC_ICON_VALUE) {
    applyHref(APPLE_ICON_SELECTOR, import.meta.env.BASE_URL + 'icons/apple-touch-icon.png', () => createAppleTouchIcon());
    applyHref(FAVICON_SELECTOR, import.meta.env.BASE_URL + 'icons/icon-192.png');
    const manifestLink = document.querySelector(MANIFEST_SELECTOR) as HTMLLinkElement | null;
    if (manifestLink) {
      if (!originalManifestHref) originalManifestHref = manifestLink.href;
      manifestLink.href = new URL(import.meta.env.BASE_URL + 'manifest-classic.webmanifest', document.baseURI).href;
    }
    if (dynamicManifestUrl) { URL.revokeObjectURL(dynamicManifestUrl); dynamicManifestUrl = null; }
    return;
  }
  const source = await resolveIconSource(value);
  if (!source || revision !== iconRevision) return;

  const pngDataUrl = await rasterize(source, TOUCH_ICON_SIZE);
  if (!pngDataUrl || revision !== iconRevision) return;

  applyHref(APPLE_ICON_SELECTOR, pngDataUrl, () => createAppleTouchIcon());
  applyHref(FAVICON_SELECTOR, pngDataUrl);

  await replaceManifest(pngDataUrl, revision);
}

/** 恢复默认图标：所有被改过的 href 还原。 */
export function clearPwaIcon(): void {
  iconRevision++;
  restoreHrefs(APPLE_ICON_SELECTOR);
  restoreHrefs(FAVICON_SELECTOR);

  const manifestLink = document.querySelector(MANIFEST_SELECTOR) as HTMLLinkElement | null;
  if (manifestLink && originalManifestHref) {
    manifestLink.href = originalManifestHref;
  }
  if (dynamicManifestUrl) {
    URL.revokeObjectURL(dynamicManifestUrl);
    dynamicManifestUrl = null;
  }
}

/** 启动时调用：customIcons 里有 `_pwa_` 就接上。 */
export async function initPwaIcon(customIcons: Record<string, string>): Promise<void> {
  const icon = customIcons[PWA_ICON_APP_ID];
  if (!icon) return;
  try {
    await injectPwaIcon(icon);
  } catch (e) {
    console.warn('[PWA Icon] 启动注入失败', e);
  }
}

// ── 图标源解析 ────────────────────────────────────────────────────

/** 把存储值解析成能喂给 canvas 的东西：Blob 优先（不会污染画布），否则原样的 URL 字符串。 */
async function resolveIconSource(value: string): Promise<Blob | string | null> {
  if (isBlobRef(value)) {
    const blob = await getBlobForRef(value);
    if (!blob) {
      console.warn('[PWA Icon] blobRef 令牌解析失败，图标可能已被清理');
      return null;
    }
    return blob;
  }
  if (value.startsWith('data:') || /^https?:\/\//i.test(value)) {
    return value;
  }
  console.warn('[PWA Icon] 不支持的图标值:', value.slice(0, 50));
  return null;
}

/**
 * 转成正方形 PNG data URL。转换失败时退回原图（能显示总比没有强），
 * 但会明确警告——iOS 大概率不认非 PNG，这时候图标就是不会变。
 */
async function rasterize(source: Blob | string, size: number): Promise<string | null> {
  try {
    return await toSquarePngDataUrl(source, size);
  } catch (e) {
    console.warn('[PWA Icon] 转 PNG 失败，退回原图（iOS 可能不认非 PNG 格式）', e);
    if (typeof source === 'string') return source;
    try {
      return await blobToDataUrl(source);
    } catch {
      return null;
    }
  }
}

// ── DOM 操作 ──────────────────────────────────────────────────────

/**
 * 改掉匹配到的所有 link 的 href（首次调用时备份原值）。
 * 一个都没匹配到且给了 fallback 时，创建一个。
 */
function applyHref(selector: string, href: string, createIfMissing?: () => HTMLLinkElement): void {
  const links = Array.from(document.querySelectorAll(selector)) as HTMLLinkElement[];

  if (links.length === 0 && createIfMissing) {
    links.push(createIfMissing());
  }

  for (const link of links) {
    if (!originalHrefs.has(link)) {
      originalHrefs.set(link, link.getAttribute('href') || '');
    }
    link.setAttribute('href', href);
  }
}

function restoreHrefs(selector: string): void {
  const links = Array.from(document.querySelectorAll(selector)) as HTMLLinkElement[];
  for (const link of links) {
    const original = originalHrefs.get(link);
    if (original === undefined) continue;
    if (original) link.setAttribute('href', original);
    else link.remove(); // 本来就是我们建的，直接删掉
    originalHrefs.delete(link);
  }
}

function createAppleTouchIcon(): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = 'apple-touch-icon';
  link.setAttribute('sizes', `${TOUCH_ICON_SIZE}x${TOUCH_ICON_SIZE}`);
  document.head.appendChild(link);
  return link;
}

// ── manifest ──────────────────────────────────────────────────────

async function replaceManifest(iconDataUrl: string, revision: number): Promise<void> {
  const link = document.querySelector(MANIFEST_SELECTOR) as HTMLLinkElement | null;
  if (!link) return;

  if (!originalManifestHref) originalManifestHref = link.href;

  try {
    const resp = await fetch(originalManifestHref);
    if (!resp.ok) throw new Error(`Fetch manifest failed: ${resp.status}`);
    const manifest = await resp.json();

    manifest.icons = [
      { src: iconDataUrl, sizes: '192x192', type: 'image/png' },
      { src: iconDataUrl, sizes: '512x512', type: 'image/png' },
      { src: iconDataUrl, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ];

    // 动态 manifest 挂的是 blob: 地址，里面的相对路径会相对 blob 解析导致 404。
    // 所有路径先折成绝对地址（base 取原始 manifest 的绝对 URL）。
    const toAbs = (p: string): string => {
      if (!p || p.startsWith('data:') || /^https?:\/\//i.test(p)) return p;
      return new URL(p, originalManifestHref!).href;
    };
    if (manifest.start_url) manifest.start_url = toAbs(manifest.start_url);
    if (manifest.scope) manifest.scope = toAbs(manifest.scope);

    if (revision !== iconRevision) return;
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
    if (dynamicManifestUrl) URL.revokeObjectURL(dynamicManifestUrl);
    dynamicManifestUrl = URL.createObjectURL(blob);
    link.href = dynamicManifestUrl;
  } catch (e) {
    console.warn('[PWA Icon] manifest 替换失败，apple-touch-icon 已注入', e);
  }
}
