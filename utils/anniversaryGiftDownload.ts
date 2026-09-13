import { ANNIVERSARY_ARTIST, ANNIVERSARY_FRAME_STYLE, ANNIVERSARY_FRAME_URL, ANNIVERSARY_WALLPAPERS } from './anniversaryGifts';

export const ANNIVERSARY_DOWNLOAD_NAME = `SullyOS-一周年赠礼-${ANNIVERSARY_ARTIST}.zip`;
export const ANNIVERSARY_DOWNLOAD_IMAGES = [
  ...ANNIVERSARY_WALLPAPERS.map(image => ({ url: image.url, fileName: `壁纸-${image.name}.jpg`, signature: [0xff, 0xd8, 0xff] })),
  { url: ANNIVERSARY_FRAME_URL, fileName: '头像框-尊贵猫猫.png', signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

/** Fetch every original before creating a ZIP, so a missing image never produces a partial gift. */
export async function createAnniversaryGiftArchive(): Promise<Blob> {
  const images = await Promise.all(ANNIVERSARY_DOWNLOAD_IMAGES.map(async image => {
    const response = await fetch(image.url);
    if (!response.ok) throw new Error(`无法读取${image.fileName}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Some static hosts return index.html with status 200 for a missing asset.
    if (bytes.length <= image.signature.length || !image.signature.every((byte, i) => bytes[i] === byte)) {
      throw new Error(`${image.fileName}不是有效的原图`);
    }
    return { ...image, bytes };
  }));
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const image of images) zip.file(image.fileName, image.bytes);
  zip.file('作者与使用说明.txt', [
    'SullyOS·糯米机 一周年赠礼',
    `壁纸与头像框作者：${ANNIVERSARY_ARTIST}`,
    '',
    '内含两张壁纸与一枚透明 PNG 头像框，均为未经裁切、重绘或重新压缩的原图。',
    '解压后，可在手机壁纸、聊天背景或气泡工坊的头像挂件设置中自行上传。',
    '',
    '头像框位置参考（先把聊天头像设为圆形）：',
    `缩放 ${ANNIVERSARY_FRAME_STYLE.avatarDecorationScale} 倍；X ${ANNIVERSARY_FRAME_STYLE.avatarDecorationX}%；Y ${ANNIVERSARY_FRAME_STYLE.avatarDecorationY}%；旋转 0°。`,
  ].join('\n'));
  return new Blob([await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })], { type: 'application/zip' });
}
