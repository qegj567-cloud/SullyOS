// 聊天页「画面不变、少干活」的回归守卫。
// 纯函数直接测行为；埋在 Chat / useChatAI 里的接线沿用读源码的做法钉住。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Message } from '../types';
import {
    CHAT_REFRESH_FULL_LIMIT,
    createCoalescedRunner,
    pickVoiceHydrationTargets,
    readChatRefreshTail,
} from './chatPerfHelpers';

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const message = (id: number, extra: Partial<Message> = {}): Message =>
    ({ id, charId: 'c', role: 'assistant', type: 'text', content: `m${id}`, timestamp: id, ...extra }) as Message;
const isVisible = (m: Message) => m.metadata?.source !== 'date';
/** 模拟按 id 倒序取最近 limit 条的读库。 */
const readerOver = (history: Message[]) => vi.fn(async (limit: number) => history.slice(-limit));

describe('生成途中刷新界面读哪一截', () => {
    it('可见消息够画一屏时只读一次短的', async () => {
        const read = readerOver(Array.from({ length: 300 }, (_, i) => message(i + 1)));
        const tail = await readChatRefreshTail(read, 30, isVisible);
        expect(read.mock.calls).toEqual([[46]]);
        expect(tail).toHaveLength(46);
    });

    it('历史不足一截时读到头就算数', async () => {
        const read = readerOver(Array.from({ length: 10 }, (_, i) => message(i + 1)));
        expect(await readChatRefreshTail(read, 30, isVisible)).toHaveLength(10);
        expect(read).toHaveBeenCalledOnce();
    });

    it('末尾夹着大量见面记录、短读画不满时整读', async () => {
        const history = Array.from({ length: 300 }, (_, i) =>
            message(i + 1, i >= 250 && i < 295 ? { metadata: { source: 'date' } } : {}));
        const read = readerOver(history);
        const tail = await readChatRefreshTail(read, 30, isVisible);
        expect(read.mock.calls).toEqual([[46], [CHAT_REFRESH_FULL_LIMIT]]);
        expect(tail).toHaveLength(CHAT_REFRESH_FULL_LIMIT);
    });

    it('上翻加载过更多历史时照已加载的条数读，不截短', async () => {
        const read = readerOver(Array.from({ length: 500 }, (_, i) => message(i + 1)));
        expect(await readChatRefreshTail(read, 240, isVisible)).toHaveLength(256);
        expect(read).toHaveBeenCalledOnce();
    });

    it('旧消息定位模式维持整读，不去读全部历史', async () => {
        const read = readerOver([]);
        await readChatRefreshTail(read, 999999, isVisible);
        expect(read.mock.calls).toEqual([[CHAT_REFRESH_FULL_LIMIT]]);
    });

    it('画出来的那一屏与整读 200 条相同', async () => {
        // 固定花样混入不可见记录：稀疏段、密集段都覆盖到。
        const history = Array.from({ length: 400 }, (_, i) =>
            message(i + 1, (i % 7 === 0 || (i > 330 && i < 372)) ? { metadata: { source: 'date' } } : {}));
        for (const wanted of [1, 30, 60, 120, 183]) {
            const tail = await readChatRefreshTail(readerOver(history), wanted, isVisible);
            const full = history.slice(-CHAT_REFRESH_FULL_LIMIT);
            expect(tail.filter(isVisible).slice(-wanted)).toEqual(full.filter(isVisible).slice(-wanted));
        }
    });
});

describe('语音回填只查没查过的消息', () => {
    const messages = [
        message(1),
        message(2, { role: 'user' }),
        message(3, { type: 'image' }),
        message(4),
        message(5),
    ];
    const hasVoice = (id: number) => id === 4;

    it('查空过的消息不再进待查名单，新来的照查', () => {
        const checkedEmpty = new Set<number>();
        expect(pickVoiceHydrationTargets(messages, hasVoice, checkedEmpty).map(m => m.id)).toEqual([1, 5]);
        checkedEmpty.add(1);
        checkedEmpty.add(5);
        expect(pickVoiceHydrationTargets([...messages, message(6)], hasVoice, checkedEmpty).map(m => m.id)).toEqual([6]);
    });

    it('记录拿掉后这条消息重新可查', () => {
        const checkedEmpty = new Set([1, 5]);
        checkedEmpty.delete(5);
        expect(pickVoiceHydrationTargets(messages, hasVoice, checkedEmpty).map(m => m.id)).toEqual([5]);
    });

    it('聊天页：语音写入后拿掉记录，换角色时清空，循环里看 cancelled', () => {
        const chat = source('../apps/Chat.tsx');
        expect(chat).toMatch(/await persistVoice\([^\n]+\n[^\n]*\n\s*voiceCheckedEmptyRef\.current\.delete\(msg\.id\);/);
        expect(chat).toMatch(/setVoiceDataMap\(\{\}\);\n\s*voiceCheckedEmptyRef\.current\.clear\(\);/);
        expect(chat).toMatch(/for \(const m of toFetch\) \{\n[^\n]*\n\s*if \(cancelled\) return;/);
        // 写语音的入口只有这一个；新增别的入口时要同样让查空记录失效。
        expect(chat.match(/DB\.saveMessageVoiceIfCurrent\(/g)).toHaveLength(1);
    });
});

describe('流式预览合并更新', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('一个间隔内来多少次都只跑一次，之后的新内容再跑一次', () => {
        vi.useFakeTimers();
        const run = vi.fn();
        const pump = createCoalescedRunner(run, 60);
        for (let i = 0; i < 10; i++) pump.schedule();
        expect(run).not.toHaveBeenCalled();
        vi.advanceTimersByTime(60);
        expect(run).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(600);
        expect(run).toHaveBeenCalledTimes(1);
        pump.schedule();
        vi.advanceTimersByTime(60);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('收尾时同步补上最后一次，定时器不再重复跑', () => {
        vi.useFakeTimers();
        const run = vi.fn();
        const pump = createCoalescedRunner(run, 60);
        pump.schedule();
        pump.flush();
        expect(run).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(600);
        expect(run).toHaveBeenCalledTimes(1);
        pump.flush();
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('停掉后不再定时，挂起的内容仍能靠收尾补上', () => {
        vi.useFakeTimers();
        const run = vi.fn();
        const pump = createCoalescedRunner(run, 60);
        pump.schedule();
        pump.stop();
        pump.schedule();
        vi.advanceTimersByTime(600);
        expect(run).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        pump.flush();
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('useChatAI：落库前先补算，清预览前先撤定时器', () => {
        const hook = source('../hooks/useChatAI.ts');
        const flushAt = hook.indexOf('previewPump.flush();');
        expect(flushAt).toBeGreaterThan(-1);
        expect(flushAt).toBeLessThan(hook.indexOf('const previewHandoverIds = new Set<number>();'));
        expect(hook).toMatch(/streamPreviewPump\?\.stop\(\);\n\s*setStreamingBubbles\(\[\]\);/);
        // 回调里只登记，不直接改预览状态。
        const hooksBlock = hook.slice(hook.indexOf('const streamHooks ='), hook.indexOf('fireLocalEmotionEval?.();'));
        expect(hooksBlock).not.toMatch(/setStreaming|computeStreamPreviewBubbles/);
    });
});

describe('生成路径的接线', () => {
    it('useChatAI 不订阅音乐上下文，发送时读播放快照', () => {
        const hook = source('../hooks/useChatAI.ts');
        expect(hook).not.toMatch(/useMusic\b/);
        expect(hook).toMatch(/const musicSnapshot = loadMusicPlaybackSnapshot\(\);/);
    });

    it('刷新界面的重读都走可注入的读法', () => {
        expect(source('../hooks/useChatAI.ts')).not.toMatch(/getRecentMessagesByCharId\(char\.id, 200\)/);
        // 只剩没给读法时的那一处兜底。
        expect(source('./applyAssistantPostProcessing.ts').match(/getRecentMessagesByCharId\(char\.id, 200\)/g)).toHaveLength(1);
    });
});
