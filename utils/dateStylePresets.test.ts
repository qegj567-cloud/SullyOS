import { describe, expect, it } from 'vitest';
import { DATE_STYLE_PRESETS } from './dateStylePresets';
import { REQUIRED_DATE_EMOTIONS } from './datePrompts';
import { extractDateDialogueText } from './dateVoiceText';

describe('见面十套文学文风', () => {
    it('只有最新版十套，旧保存标识仍对应原来的五种文风', () => {
        expect(DATE_STYLE_PRESETS).toHaveLength(10);
        expect(new Set(DATE_STYLE_PRESETS.map(p => p.id)).size).toBe(10);
        expect(DATE_STYLE_PRESETS.slice(0, 5).map(p => [p.id, p.label])).toEqual([
            ['cinematic', '电影感'], ['plain', '简洁白描'], ['lyrical', '细腻文艺'],
            ['playful', '轻快幽默'], ['intense', '浓烈炽热'],
        ]);
    });

    it.each(DATE_STYLE_PRESETS)('$label 的全部示例能按现有表情与对白协议逐行读取', preset => {
        expect(preset.block).not.toMatch(/\[tag\]|参考出处|Wikisource|青空文库|公有领域|__EXAMPLES_/);
        expect(preset.block).toContain(`风格：${preset.title}`);
        const examples = preset.block.split(/示例[一二三]：[^\n]+\n/).slice(1);
        expect(examples.length).toBe(preset.id === 'playful' || preset.id === 'suspense' ? 3 : 2);
        let dialogueCount = 0;
        let narrationCount = 0;
        for (const example of examples) {
            for (const line of example.split('\n').filter(line => line.trim())) {
                const parsed = line.match(/^\[([a-z_]+)\] (.+)$/);
                expect(parsed, line).not.toBeNull();
                expect(REQUIRED_DATE_EMOTIONS).toContain(parsed![1]);
                const text = parsed![2];
                if (text.startsWith('"')) {
                    expect(text).toMatch(/^"[^"\n]+"$/);
                    expect(extractDateDialogueText(line)).toBe(text.slice(1, -1));
                    dialogueCount++;
                } else {
                    expect(text).not.toMatch(/["“”「」]/);
                    narrationCount++;
                }
            }
        }
        expect(dialogueCount).toBeGreaterThan(0);
        expect(narrationCount).toBeGreaterThan(0);
        expect(preset.peekRule).not.toMatch(/\[(normal|happy|angry|sad|shy)\]/);
    });
});
