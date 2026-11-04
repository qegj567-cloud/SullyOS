import {validateCatalogCover} from './beautyCatalogContract';
import {waitForBeautyCapture} from './beautyCaptureWait';

export function encodeBeautyCatalogCover(source: CanvasImageSource, width: number, height: number): string {
  if (!width || !height) throw Error('封面图片尺寸无效');
  const scale = Math.min(1, 360 / width, 600 / height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw Error('当前设备无法生成封面');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return validateCatalogCover(canvas.toDataURL('image/webp', .75));
}

/** User-selected sample screenshots avoid third-party image-host CORS entirely. */
export async function readBeautyCatalogCover(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw Error('请选择 PNG、JPG 或 WebP 预览截图');
  if (file.size > 10 * 1024 * 1024) throw Error('预览截图最多 10 MB，请先裁剪或缩小');
  const url = URL.createObjectURL(file);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error('封面图片读取超时，请换一张截图')), 15000);
  try {
    const image = new Image(); image.src = url;
    await waitForBeautyCapture(image.decode(), controller.signal);
    if (image.naturalWidth * image.naturalHeight > 40_000_000) throw Error('预览截图尺寸过大，请先裁剪或缩小');
    return encodeBeautyCatalogCover(image, image.naturalWidth, image.naturalHeight);
  } finally { clearTimeout(timer); URL.revokeObjectURL(url); }
}
