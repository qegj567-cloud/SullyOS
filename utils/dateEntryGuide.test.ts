import { beforeEach, expect, it, vi } from 'vitest';
import { hasSeenDateEntryGuide, hasSeenDateInputGuide, markDateEntryGuideSeen, markDateInputGuideSeen } from './dateEntryGuide';

beforeEach(() => { localStorage.removeItem('sully-date-entry-guide-v1'); });
it('旧版已读状态仍有效，完成输入提示后不会被入口确认重置', () => {
    markDateEntryGuideSeen();
    expect(hasSeenDateEntryGuide()).toBe(true);
    expect(hasSeenDateInputGuide()).toBe(false);
    markDateInputGuideSeen();
    markDateEntryGuideSeen();
    expect(hasSeenDateEntryGuide()).toBe(true);
    expect(hasSeenDateInputGuide()).toBe(true);
});
it('存储不可用时不会阻断进入和展开输入框', () => {
    const read = vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('Unavailable'); });
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Unavailable'); });
    try {
        expect(hasSeenDateEntryGuide()).toBe(false);
        expect(hasSeenDateInputGuide()).toBe(false);
        expect(() => { markDateEntryGuideSeen(); markDateInputGuideSeen(); }).not.toThrow();
    } finally { read.mockRestore(); write.mockRestore(); }
});
