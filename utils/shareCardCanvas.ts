import { SHARE_KINDS, type ShareCardMetadata } from './pngShare';

export type CardDesign = Pick<ShareCardMetadata, 'kind' | 'title' | 'author' | 'restrictions' | 'style'>;
const FONT = '"PingFang SC", "Microsoft YaHei", sans-serif';

/** Shared renderer: editor preview and exported pixels always use the same canvas. */
export function renderShareCard(design: CardDesign, image?: HTMLImageElement | null): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    const wide = design.style === 'business';
    const poster = design.style === 'poster';
    canvas.width = wide ? 1440 : 1080;
    canvas.height = wide ? 960 : 1440;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前设备无法生成图片');
    const w = canvas.width, h = canvas.height;
    const ink = poster ? '#fffdf9' : '#292b32';
    const muted = poster ? '#d4d0d9' : '#686670';
    ctx.fillStyle = poster ? '#282633' : '#f7f4ee';
    ctx.fillRect(0, 0, w, h);
    const imageBox = poster ? [0, 0, w, h] : wide ? [0, 0, 630, h] : [54, 130, 972, 730];
    const [ix, iy, iw, ih] = imageBox;
    if (image) {
        const scale = Math.max(iw / image.naturalWidth, ih / image.naturalHeight);
        ctx.save(); ctx.beginPath(); ctx.rect(ix, iy, iw, ih); ctx.clip();
        ctx.drawImage(image, ix + (iw - image.naturalWidth * scale) / 2, iy + (ih - image.naturalHeight * scale) / 2, image.naturalWidth * scale, image.naturalHeight * scale);
        ctx.restore();
    } else {
        ctx.fillStyle = '#dcd6e3'; ctx.fillRect(ix, iy, iw, ih);
        ctx.save(); ctx.beginPath(); ctx.rect(ix, iy, iw, ih); ctx.clip();
        ctx.fillStyle = '#b0a1c4'; ctx.beginPath(); ctx.arc(ix + iw * .78, iy + ih * .30, iw * .40, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#c5bdcf'; ctx.beginPath(); ctx.arc(ix + iw * .2, iy + ih, iw * .65, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#5f516f'; ctx.font = `500 ${wide ? 96 : 150}px ${FONT}`;
        ctx.fillText('S', ix + 60, iy + ih * .54);
        ctx.restore();
    }
    if (poster) {
        const shade = ctx.createLinearGradient(0, 0, 0, h);
        shade.addColorStop(0, 'rgba(20,17,28,.4)'); shade.addColorStop(.35, 'rgba(20,17,28,.05)');
        shade.addColorStop(.57, 'rgba(20,17,28,.82)'); shade.addColorStop(1, 'rgba(20,17,28,.97)');
        ctx.fillStyle = shade; ctx.fillRect(0, 0, w, h);
    }
    const x = wide ? 690 : 64, width = wide ? 686 : 952;
    const text = (value: string, y: number, size: number, color = ink, weight = 400) => {
        ctx.fillStyle = color; ctx.font = `${weight} ${size}px ${FONT}`; ctx.fillText(value, x, y);
    };
    const lines = (value: string, size: number): string[] => {
        ctx.font = `600 ${size}px ${FONT}`;
        const output: string[] = [];
        for (const paragraph of value.replace(/\s+/g, ' ').split('\n')) {
            let line = '';
            for (const char of paragraph) {
                if (line && ctx.measureText(line + char).width > width) { output.push(line); line = ''; }
                line += char;
            }
            output.push(line);
        }
        return output;
    };
    const wrapped = (value: string, y: number, initial: number, maxHeight: number, color: string, weight = 400) => {
        let size = initial, rows = lines(value, size);
        while (rows.length * size * 1.35 > maxHeight && size > 14) { size -= 1; rows = lines(value, size); }
        rows.forEach((row, i) => text(row, y + i * size * 1.35, size, color, weight));
    };
    text('SullyOS·糯米机  /  SHARE COLLECTION', wide ? 88 : 86, 22, muted, 500);
    const top = wide ? 256 : 930;
    text(SHARE_KINDS[design.kind], top, 25, poster ? '#d9c7fa' : '#77608e', 500);
    wrapped(design.title, top + 73, wide ? 56 : 64, 180, ink, 600);
    wrapped(`作者  ${design.author.trim() || '未署名'}`, top + 263, 26, 68, muted, 500);
    const ruleY = wide ? 640 : 1246;
    ctx.fillStyle = poster ? '#ffffff40' : '#292b3230'; ctx.fillRect(x, ruleY, width, 1);
    text('使用限制', ruleY + 43, 21, muted, 500);
    wrapped(design.restrictions.trim() || '未注明 · 使用前请联系作者', ruleY + 82, 25, wide ? 132 : 66, ink);
    text('PNG 原文件 · 在对应功能中导入', h - 36, 19, muted);
    return canvas;
}
export const canvasToPng = (canvas: HTMLCanvasElement): Promise<Blob> => new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片生成失败，请重试')), 'image/png');
});
export function loadCardImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => { clearTimeout(timer); resolve(image); };
        image.onerror = () => { clearTimeout(timer); reject(new Error('预览图无法读取，请换一张图片')); };
        const timer = setTimeout(() => { image.src = ''; reject(new Error('预览图读取超时，请重新上传')); }, 15000);
        image.src = url;
    });
}
