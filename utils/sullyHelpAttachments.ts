import { processImage } from './file';
import { resolveRefToDataUrl } from './blobRef';
import { describeImageWithVisionApi, isVisionApiReady } from './visionApi';
import { AppID, type APIConfig } from '../types';
import { SULLY_HELP_DESK_ID } from './sullyIdentity';
import type { HelpDeskMessage } from './sullyHelpDesk';

export type HelpAttachment =
    | { kind: 'image' | 'sticker'; name: string; url: string }
    | { kind: 'file'; name: string; text: string; clipped: boolean };

export const helpFileAccept = 'image/png,image/jpeg,image/webp,image/gif,.txt,.md,.log,.json,.csv,.pdf';
const textLimit = 3000;

export async function readHelpFile(file: File): Promise<HelpAttachment> {
    const name = file.name;
    if (file.size > 10 * 1024 * 1024) throw new Error('附件超过 10 MB，可以截取相关页面或报错片段再发。');
    if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
        return { kind: 'image', name, url: await processImage(file, { maxWidth: 1600, quality: 0.9 }) };
    }
    let text: string;
    let clipped = false;
    if (/\.pdf$/i.test(name) || file.type === 'application/pdf') {
        const { extractPdfText } = await import('./pdfText');
        const pdf = await extractPdfText(await file.arrayBuffer(), { maxPages: 8 });
        if (!pdf.text.trim()) throw new Error('这份 PDF 前 8 页没有可读文字。可以把出问题的那一页截图，作为图片发送。');
        text = pdf.text;
        clipped = pdf.pageCount > 8;
    } else if (/\.(txt|md|log|json|csv)$/i.test(name) || file.type === 'text/plain') {
        // Four UTF-8 bytes per character suffice to fill the excerpt without loading a whole log.
        const prefix = file.slice(0, textLimit * 4 + 4);
        text = await prefix.text();
        clipped = prefix.size < file.size;
        if (text.includes('\u0000')) throw new Error('文件里有无法读取的二进制内容，请另存为 UTF-8 文本或发送截图。');
    } else {
        throw new Error('支持 PNG、JPG、WebP、GIF、文字 PDF 和 TXT、MD、LOG、JSON、CSV 文件。');
    }
    if (!text.trim()) throw new Error('文件里没有可读文字，可以换一份或直接输入问题。');
    return { kind: 'file', name, text: text.slice(0, textLimit), clipped: clipped || text.length > textLimit };
}

export function helpMessageText(message: HelpDeskMessage, limit: number): string {
    const item = message.role === 'user' ? message.attachment : undefined;
    if (!item) return message.content;
    const label = item.kind === 'file' ? '文件' : item.kind === 'image' ? '图片' : '表情包';
    const tag = `[${label}：${item.name}]`;
    const spaceForAttachment = tag.length + 2 + (item.kind === 'file' ? Math.min(Math.floor(limit / 2), item.text.length) : 0);
    const captionLimit = Math.max(0, limit - spaceForAttachment);
    const caption = message.content.length <= captionLimit ? message.content : message.content.slice(0, Math.max(0, captionLimit - 1)) + '…';
    return [caption, tag, item.kind === 'file' ? item.text : ''].filter(Boolean).join('\n');
}

export class HelpImageError extends Error {}
export const helpVisionSettings = '设置 → API 配置 → 识图 → 测试识图';

/** Resolve just this batch of unsolved images once, including when the desk reads a second manual page. */
export async function prepareHelpImages(turns: HelpDeskMessage[], api: APIConfig, signal: AbortSignal, textOnly: boolean) {
    const messages: { role: HelpDeskMessage['role']; content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] }[] = [];
    const reading: HelpDeskMessage[] = [];
    let directImages = false;
    for (const turn of turns) {
        let content = turn.content;
        const image = turn.attachment;
        if (image?.kind === 'image' && !textOnly) {
            if (signal.aborted) throw new DOMException('已取消', 'AbortError');
            const url = await resolveRefToDataUrl(image.url).catch(() => '');
            if (!url?.startsWith('data:image/')) throw new HelpImageError('这张图片的本机数据已不可读。请重新上传，或只用文字说明。');
            if (api.visionApi?.enabled) {
                if (!isVisionApiReady(api.visionApi)) throw new HelpImageError(`独立识图 API 配置不完整。请到${helpVisionSettings}，填好 URL、Key 和模型后保存。`);
                try {
                    const description = await describeImageWithVisionApi(url, api.visionApi,
                        { appId: AppID.FAQ, appName: '使用帮助', charId: SULLY_HELP_DESK_ID, charName: 'Sully-11', purpose: '答疑附件识图' });
                    content += '\n[截图可见内容] ' + description;
                } catch (error) {
                    throw new HelpImageError(`独立识图 API 没能读到图片。请到${helpVisionSettings}。\n${error instanceof Error ? error.message : '请检查连接后重试。'}`);
                }
            } else {
                directImages = true;
                messages.push({ role: turn.role, content: [{ type: 'text', text: content }, { type: 'image_url', image_url: { url } }] });
                reading.push({ role: turn.role, content });
                continue;
            }
        } else if (image?.kind === 'image') {
            content += '\n[本轮仅用文字，图片未提供]';
        }
        messages.push({ role: turn.role, content });
        reading.push({ role: turn.role, content });
    }
    return { messages, reading, directImages };
}
