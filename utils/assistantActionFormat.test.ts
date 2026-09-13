import { describe, expect, it } from 'vitest';
import { normalizeAssistantActionFormatting as normalize } from './assistantActionFormat';

describe('normalizeAssistantActionFormatting', () => {
    it.each(['[[SEND_EMOJI：咬你]]', '[[send_emoji: 咬你]]', '[凯恩 发送了表情包：咬你]'])('统一表情变体 %s 且重复处理不变', raw => {
        expect(normalize(raw)).toBe('[[SEND_EMOJI: 咬你]]');
        expect(normalize(normalize(raw))).toBe('[[SEND_EMOJI: 咬你]]');
    });

    it('修复单括号与展示态表情，并保持规范标签幂等', () => {
        expect(normalize('[SEND_EMOJI: 开心]')).toBe('[[SEND_EMOJI: 开心]]');
        expect(normalize('[表情：小狗泪丧]')).toBe('[[SEND_EMOJI: 小狗泪丧]]');
        expect(normalize('[[SEND_EMOJI: 开心]]')).toBe('[[SEND_EMOJI: 开心]]');
    });

    it('修复转账 ACTION 的单括号，不碰普通转账叙述', () => {
        expect(normalize('[ACTION:TRANSFER|to=user|amount=520]'))
            .toBe('[[ACTION:TRANSFER|to=user|amount=520]]');
        expect(normalize('[ACTION:TRANSFER: 13]')).toBe('[[ACTION:TRANSFER:13]]');
        expect(normalize('[ACTION:TRANSFER_ACCEPT]')).toBe('[[ACTION:TRANSFER_ACCEPT]]');
        expect(normalize('我刚给你转了 520，记得收')).toBe('我刚给你转了 520，记得收');
    });

    it('修复 LIFE 单括号和生活记录展示摘要', () => {
        expect(normalize('[LIFE:MED|布洛芬]')).toBe('[[LIFE:MED|布洛芬]]');
        expect(normalize('[生活记录：支出 13（西瓜汁）]'))
            .toBe('[[LIFE:EXPENSE|13|西瓜汁]]');
        expect(normalize('[生活记录：吃药 · 布洛芬]')).toBe('[[LIFE:MED|布洛芬]]');
        expect(normalize('[生活记录：锻炼 · 跑步 30分钟]'))
            .toBe('[[LIFE:EXERCISE|跑步|30分钟]]');
        expect(normalize('[生活记录：生理期开始]')).toBe('[[LIFE:PERIOD_START]]');
    });

    it('不把带历史状态的卡片或普通方括号文字变成副作用', () => {
        expect(normalize('[生活记录：支出 13（西瓜汁）（已有记录，未重复添加）]'))
            .toBe('[生活记录：支出 13（西瓜汁）（已有记录，未重复添加）]');
        expect(normalize('她发了一个开心表情')).toBe('她发了一个开心表情');
        expect(normalize('我看了[那本书]')).toBe('我看了[那本书]');
    });
});

describe('sticker history syntax recovery', () => {
    it.each(['[[你 发送了表情包: 咬你]]', '[[你发送了表情包：咬你]]', '[[发送了表情包: 咬你]]', '【你发送了表情包：咬你】', '［［SEND_EMOJI：咬你］］', '[[表情包：咬你]]', '[Noir 发送了表情包: 咬你]'])('repairs %s without nesting brackets', raw => {
        expect(normalize(raw)).toBe('[[SEND_EMOJI: 咬你]]');
        expect(normalize(normalize(raw))).toBe('[[SEND_EMOJI: 咬你]]');
    });
    it.each(['`[[你发送了表情包: 咬你]]`', '```text\n[[你发送了表情包: 咬你]]\n```', '[[你_发_送_了_表_情_包: 咬你]]', '[[S_E_N_D _ E_M_O_J_I: 咬你]]', '我刚才发送了表情包：咬你', '[你发送了表情包: 咬你]]'])('does not turn an explanation or incomplete token into a sticker: %s', raw => {
        expect(normalize(raw)).toBe(raw);
    });
    it('preserves multiple stickers, names with punctuation and neighboring text', () => {
        expect(normalize('先说一句[[你发送了表情包: 猫: 抱 抱!]]\n[[发送了表情包: 猫: 抱 抱!]]再说一句'))
            .toBe('先说一句[[SEND_EMOJI: 猫: 抱 抱!]]\n[[SEND_EMOJI: 猫: 抱 抱!]]再说一句');
    });
});

it('repairs adjacent stickers without skipping the second token', () => {
 expect(normalize('[[你发送了表情包: 甲]][[你发送了表情包: 乙]]')).toBe('[[SEND_EMOJI: 甲]][[SEND_EMOJI: 乙]]');
});
