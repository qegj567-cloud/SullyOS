import { describe, expect, it } from 'vitest';
import { buildDateActionChoicesPrompt, extractDateActionChoices, getDateActionChoices } from './dateActionChoices';

const raw = '[happy] "茶好了。" [v:calm] <date-voice lang="en">Tea is ready.</date-voice>\n⟦ACTIONS⟧\ndaily｜接过茶杯，问还有没有点心。\nplot｜请让窗外出现一件值得留意的小事。\njoke｜“茶艺师，今天有会员折扣吗？”\noppose｜“我现在不想喝茶，先放一放。”\n⟦/ACTIONS⟧';
describe('行动建议与正文分离', () => {
    it('保留情绪、语音和译文原样，建议仅进入独立结果', () => {
        const result = extractDateActionChoices(raw);
        expect(result.body).toBe(raw.split('\n⟦ACTIONS⟧')[0]);
        expect(result.choices.map(x => x.kind)).toEqual(['daily', 'plot', 'joke', 'oppose']);
        expect(result.choices[1].text).toBe('（请让窗外出现一件值得留意的小事。）');
    });
    it('没有标记的普通正文不按关键词误吞', () => {
        expect(extractDateActionChoices('daily｜今天过得如何？')).toEqual({ body: 'daily｜今天过得如何？', choices: [] });
    });
    it('容忍方括号、大小写和缺失闭合；不让坏块进入正文', () => {
        expect(extractDateActionChoices('正文\n[actions]\ndaily: 接着聊聊\nunknown: private\ndaily: 重复')).toEqual({ body: '正文', choices: [{ kind: 'daily', text: '接着聊聊' }] });
        expect(extractDateActionChoices('正文\n⟦ACTIONS⟧\n坏格式\n⟦/ACTIONS⟧')).toEqual({ body: '正文', choices: [] });
    });
    it('去掉建议里的立绘与语音标签，拒绝过长和非文本内容', () => {
        const result = extractDateActionChoices(`正文\n⟦ACTIONS⟧\ndaily｜[happy] 好呀 [v:calm]<date-voice lang="en">Yes</date-voice>\nplot｜<script>bad</script>\njoke｜${'a'.repeat(501)}\n⟦/ACTIONS⟧`);
        expect(result.choices).toEqual([{ kind: 'daily', text: '好呀' }]);
    });
    it('默认关闭；开启才要求四种可编辑草稿', () => {
        expect(buildDateActionChoicesPrompt()).toBe('');
        expect(buildDateActionChoicesPrompt(false)).toBe('');
        expect(buildDateActionChoicesPrompt(true)).toContain('用户尚未选择的可能回应');
    });
    it('用户已发送或最新回复缺失时，不翻出旧轮建议', () => {
        const assistant = { id: 1, role: 'assistant', metadata: { dateActionChoices: extractDateActionChoices(raw).choices } } as any;
        expect(getDateActionChoices([assistant])).toHaveLength(4);
        expect(getDateActionChoices([assistant, { role: 'user' } as any])).toEqual([]);
        expect(getDateActionChoices([assistant, { role: 'assistant' } as any])).toEqual([]);
    });
});
