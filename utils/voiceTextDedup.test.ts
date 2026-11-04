import { describe, expect, it } from 'vitest';
import { deduplicateVoiceText } from './voiceTextDedup';
import { sanitizeForBubble } from './sanitize';
describe('voice text duplication', () => {
    const line = '刚进屋窗帘拉开正好有一大片阳光铺在地毯上';
    it('keeps voice and removes verbatim prose on either side', () => {
        expect(deduplicateVoiceText(line + '\n<语音>' + line + '</语音>\n' + line)).toBe('<语音>' + line + '</语音>');
    });
    it('preserves new information, paraphrases and short acknowledgements', () => {
        const text = '好呀\n刚刚回家啦\n<语音>好呀，我刚进屋，太阳照进来了</语音>\n你今天过得怎么样？';
        const cleaned = deduplicateVoiceText(text);
        expect(cleaned).toContain('刚刚回家啦'); expect(cleaned).toContain('你今天过得怎么样？'); expect(cleaned.startsWith('好呀')).toBe(true);
    });
    it('preserves paired foreign subtitles and protocol blocks', () => {
        const block = '<语音>Hello there</语音><字幕>' + line + '</字幕>';
        const cleaned = deduplicateVoiceText(line + '\n' + block + '\n[[SEND_EMOJI: hi]]');
        expect(cleaned).toContain(block); expect(cleaned).toContain('[[SEND_EMOJI: hi]]');
        expect(cleaned.startsWith(line)).toBe(false);
    });
    it('normalizes broken tags before deduplication in the real parser', () => {
        const result = sanitizeForBubble(line + '\n<語音>' + line + '</語音>');
        expect(result).toBe('<語音>' + line + '</語音>');
    });
    it('leaves plain text replies unchanged', () => expect(deduplicateVoiceText(line)).toBe(line));
    it('preserves multiline subtitles before the voice while removing their prose copy', () => {
        const block = '<字幕>\n' + line + '\n</字幕>\n<语音>Hello there, I just got home.</语音>';
        expect(deduplicateVoiceText(block + '\n' + line)).toBe(block);
    });
});
