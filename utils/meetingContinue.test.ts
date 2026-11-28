import { describe, expect, it } from 'vitest';
import {
    buildInPersonContinueInstruction,
    buildStoryContinueInstruction,
    MEETING_CONTINUE_DISPLAY_TEXT,
} from './meetingContinue';

describe('meeting continue instructions', () => {
    it('keeps the saved turn compact and continues the scene without forcing an event or user belief', () => {
        const prompt = buildInPersonContinueInstruction('阿明', '小白');

        expect(MEETING_CONTINUE_DISPLAY_TEXT).toBe('（继续）');
        expect(prompt).toContain('阿明没有主动说话');
        expect(prompt).not.toContain('真实地待在同一物理空间');
        expect(prompt).toContain('面对面共处');
        expect(prompt).toContain('允许共享沉默');
        expect(prompt).toContain('不要求制造新事件或推进关系');
        expect(prompt).toContain('不替用户规定对这段关系的理解');
        expect(prompt).toContain('不要擅自替阿明补写新的主动行为');
        expect(prompt).toContain('不是一句需要回应的空白台词');
        expect(prompt).toContain('也不表示同意、拒绝或授权任何尚未选择的行动建议');
        expect(prompt).toContain('接续已有动作、话题或因果，不重述上一轮');
    });

    it('hands plot initiative back without bypassing the active native preset', () => {
        const prompt = buildStoryContinueInstruction('林夏');

        expect(prompt).toContain('林夏没有新增主动行为');
        expect(prompt).toContain('当前剧情已经启用的原生预设');
        expect(prompt).toContain('文风、叙事视角、格式规则、转述档位');
        expect(prompt).toContain('“用户执笔权”边界');
        expect(prompt).toContain('其他角色的自身目标');
        expect(prompt).toContain('不要切换成普通聊天');
    });
});
