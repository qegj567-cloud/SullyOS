import { Message } from '../../types';
import { isBlobRef } from '../blobRef';

/**
 * 群聊日志行里一条消息的文本表示——非文本类型用占位符。
 * image 的 content 是 base64（processImage 压的 JPEG）、emoji 是图床 URL，
 * 都不能内联进 prompt：base64 会把上下文撑爆，URL 是纯噪声。
 */
export function messageLogText(m: Message, stickerName?: (url: string) => string): string {
    const rawText = typeof m.content === 'string' ? m.content : '';
    if (m.type === 'image') return '[图片]';
    if (m.type === 'emoji') return `[表情包: ${m.metadata?.stickerName || (stickerName ? stickerName(rawText.trim()) : '表情')}]`;
    if (m.type === 'transfer') {
        if (m.metadata?.packetReceipt) return m.metadata.packetReceipt === 'claimed' ? '[领取红包]' : '[退回红包]';
        if (m.metadata?.packet) return `[发红包: ${m.metadata.totalAmount}]`;
        return `[发红包: ${m.metadata?.amount ?? ''}]`;
    }
    // 令牌（blobref:）也算媒体：图片二进制存在 blob_assets 里，正文位置只留一个短引用，
    // 内联进 prompt 同样是纯噪声。跟 groupChat/prompts.ts 的同款兜底保持一个口径。
    const trimmed = rawText.trim();
    if (/^(data:|https?:\/\/)/i.test(trimmed) || isBlobRef(trimmed)) return '[媒体]';
    return rawText;
}
