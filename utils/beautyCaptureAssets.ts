import {waitForBeautyCapture} from './beautyCaptureWait';

/** Embed paint resources before SVG/foreignObject capture: external images are not
 * loaded inside a serialized SVG. Fail explicitly instead of publishing blank art. */
export async function embedBeautyCaptureImages(root: HTMLElement, signal?: AbortSignal): Promise<void> {
  const cache = new Map<string, Promise<string>>();
  const imageData = (src: string): Promise<string> => {
    if (!src || src.startsWith('#')) return Promise.resolve(src);
    const url = new URL(src, document.baseURI);
    if (!['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) {
      return Promise.reject(new Error('封面包含不支持的图片地址'));
    }
    const existing = cache.get(url.href);
    if (existing) return existing;
    const pending = (async () => {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, {once: true});
      const timer = window.setTimeout(() => controller.abort(), 12000);
      let objectUrl = '';
      let loaded = false;
      let httpStatus: number | undefined;
      try {
        const request: RequestInit & { __sullyHandlesFailure: boolean } = {
          signal: controller.signal,
          credentials: 'omit',
          __sullyHandlesFailure: /^https?:$/.test(url.protocol) && url.origin !== location.origin,
        };
        const response = await waitForBeautyCapture(fetch(url.href, request), controller.signal);
        if (!response.ok) { httpStatus = response.status; throw Error('图片下载失败'); }
        const blob = await waitForBeautyCapture(response.blob(), controller.signal);
        loaded = true;
        objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        image.src = objectUrl;
        await waitForBeautyCapture(image.decode(), controller.signal);
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context || !canvas.width || !canvas.height) throw Error('图片无法解码');
        context.drawImage(image, 0, 0);
        return canvas.toDataURL('image/png');
      } catch {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Error('封面生成已取消，请重试');
        const reason = httpStatus === 404
          ? `封面图片地址不存在（${url.host}，HTTP 404），请检查图片路径后重试`
          : httpStatus
          ? `封面图片下载失败（${url.host}，HTTP ${httpStatus}），请稍后重试`
          : loaded
          ? '封面图片解码或绘制失败，请检查图片格式和尺寸后重试'
          : url.protocol === 'http:' || url.protocol === 'https:'
            ? `封面图片加载失败（${url.host}），可能是图床跨域限制或网络问题。请更换可跨域访问的图片，或稍后重试`
            : '封面本地图片读取失败，请重新打开预览后重试；若仍失败，请重新导入这张图片';
        throw Error(`${reason}；不会提交缺图封面。`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    })();
    cache.set(url.href, pending);
    return pending;
  };
  const inlineCss = async (value: string): Promise<string> => {
    const pattern = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)/gi;
    const matches = Array.from(value.matchAll(pattern));
    let result = value;
    for (const match of matches) {
      const src = (match[1] ?? match[2] ?? match[3]).trim().replace(/\\(["'()\\])/g, '$1');
      const data = await imageData(src);
      result = result.replace(match[0], `url(${JSON.stringify(data)})`);
    }
    return result;
  };
  // Work in small groups to avoid decoding every image in a large preset at once.
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement | SVGElement>('*'))];
  for (const element of elements) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : Error('封面生成已取消，请重试');
    if (element instanceof HTMLImageElement) {
      const src = element.currentSrc || element.src;
      element.removeAttribute('srcset'); element.removeAttribute('sizes');
      element.removeAttribute('crossorigin'); element.loading = 'eager';
      if (src) {
        element.src = await imageData(src);
        await (signal ? waitForBeautyCapture(element.decode(), signal) : element.decode());
      }
    }
    if (element instanceof SVGImageElement) {
      const src = element.href.baseVal;
      if (src) element.setAttribute('href', await imageData(src));
    }
    if (!('style' in element)) continue;
    for (const property of Array.from(element.style)) {
      // Computed paint properties already resolve CSS variables. Do not fetch
      // resources from unused custom properties.
      if (property.startsWith('--')) { element.style.removeProperty(property); continue; }
      const value = element.style.getPropertyValue(property);
      if (/url\(/i.test(value)) element.style.setProperty(property, await inlineCss(value), element.style.getPropertyPriority(property));
    }
  }
}
