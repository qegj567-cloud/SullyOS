// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useChatAI } from '../hooks/useChatAI';
import { KeepAlive } from './keepAlive';
import { getChatSendProgress } from './chatSendProgress';

vi.mock('../context/MusicContext', () => ({ useMusic: () => ({}), loadMusicHooks: () => null }));
vi.mock('./keepAlive', () => ({ KeepAlive: { start: vi.fn(), stop: vi.fn() } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let current: ReturnType<typeof useChatAI>;
const container = document.createElement('div');
let root = createRoot(container);
function Probe({ charId = 'reply-test' }: { charId?: string }) {
    current = useChatAI({
        worldbookScene: 'chat.private',
        char: { id: charId, name: '甲' } as any, userProfile: { name: '用户' } as any,
        apiConfig: { baseUrl: 'https://example.test/v1' }, groups: [], emojis: [], categories: [],
        realtimeConfig: {} as any, addToast: vi.fn(), setMessages: vi.fn(), updateCharacter: vi.fn(), updateUserProfile: vi.fn(),
    });
    return null;
}
afterEach(() => { act(() => root.unmount()); vi.restoreAllMocks(); });

describe('useChatAI 请求生命周期', () => {
    it('连点/卸载再进入只保留一轮，初始化失败后释放占位可重试', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        let rejectStart!: (error: Error) => void;
        vi.mocked(KeepAlive.start).mockImplementation(() => new Promise((_, reject) => { rejectStart = reject; }));
        await act(async () => { root.render(createElement(Probe)); });
        const sameRenderTrigger = current!.triggerAI;
        let first!: Promise<void>;
        await act(async () => {
            first = sameRenderTrigger([]);
            await sameRenderTrigger([]);
        });
        expect(KeepAlive.start).toHaveBeenCalledTimes(1);
        expect(current!.isTyping).toBe(true);
        expect(getChatSendProgress('reply-test')?.phase).toBe('preparing');
        await act(async () => { root.render(createElement(Probe, { charId: 'other' })); });
        expect(current!.isTyping).toBe(true); // 同一实例的流式状态不能同时被两个角色写
        await act(async () => { await current!.triggerAI([]); });
        expect(KeepAlive.start).toHaveBeenCalledTimes(1);
        act(() => root.unmount());
        root = createRoot(container);
        await act(async () => { root.render(createElement(Probe)); });
        expect(current!.isTyping).toBe(true);
        expect(getChatSendProgress('reply-test')?.phase).toBe('preparing');
        await act(async () => { await current!.triggerAI([]); });
        expect(KeepAlive.start).toHaveBeenCalledTimes(1);
        await act(async () => { rejectStart(new Error('初始化失败')); await first; });
        expect(current!.isTyping).toBe(false);
        expect(getChatSendProgress('reply-test')?.phase).toBe('failed');
        vi.mocked(KeepAlive.start).mockRejectedValue(new Error('再次失败'));
        await act(async () => { await current!.triggerAI([]); });
        expect(KeepAlive.start).toHaveBeenCalledTimes(2);
        expect(current!.isTyping).toBe(false);
    });
});

it('停止正在等待的初始化会立即解除占位，不留下错误消息', async () => {
    const { stopReplyRuns } = await import('./chatReplyCancellation');
    const { DB } = await import('./db');
    root = createRoot(container);
    vi.mocked(KeepAlive.start).mockImplementation(() => new Promise(() => {}));
    await act(async () => { root.render(createElement(Probe, { charId: 'stop-lifecycle' })); });
    let pending!: Promise<void>;
    await act(async () => { pending = current.triggerAI([]); });
    expect(current.isTyping).toBe(true);
    await act(async () => { stopReplyRuns('stop-lifecycle'); await pending; });
    expect(current.isTyping).toBe(false);
    expect(getChatSendProgress('stop-lifecycle')?.phase).toBe('cancelled');
    expect(await DB.getRecentMessagesByCharId('stop-lifecycle', 20)).toEqual([]);
});

it.each([true, false])('上下文组装完成不等于云端接收（回执成功：%s）', async accepted => {
    const { DB } = await import('./db');
    const instant = await import('./amsgInstantChat');
    const runtime = await import('./activeMsgRuntime');
    const payload = await import('./chatRequestPayload');
    const charId = accepted ? 'handoff-accepted' : 'handoff-failed';
    const userMessage = { charId, role: 'user' as const, type: 'text' as const, content: '等会儿见。', timestamp: Date.now() };
    const id = await DB.saveMessage(userMessage);
    const messages = [{ ...userMessage, id }];
    vi.mocked(KeepAlive.start).mockResolvedValue(undefined);
    vi.spyOn(runtime, 'prepareInboxBeforeChat').mockResolvedValue('ready' as any);
    vi.spyOn(instant, 'resolveInstantChatReadiness').mockResolvedValue({ ready: true });
    let finishPreparation!: (value: any) => void;
    const build = vi.spyOn(payload, 'buildChatRequestPayload').mockImplementation(() => new Promise(resolve => { finishPreparation = resolve; }));
    let acknowledge!: (value: any) => void;
    const send = vi.spyOn(instant, 'sendInstantChatTurn').mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    root = createRoot(container);
    await act(async () => { root.render(createElement(Probe, { charId })); });
    let request!: Promise<void>;
    await act(async () => { request = current.triggerAI(messages); });
    await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
    expect(getChatSendProgress(charId)).toMatchObject({ messageId: id, phase: 'preparing' });
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
        finishPreparation({ systemPrompt: '', cleanedApiMessages: [], fullMessages: [{ role: 'user', content: userMessage.content }], flags: { promptBuildSkipped: true }, volatileTailIndex: 0 });
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(getChatSendProgress(charId)?.phase).toBe('sending');
    await act(async () => {
        acknowledge(accepted ? { ok: true, uuid: 'confirmed-task' } : { ok: false, error: '模拟上传失败' });
        await request;
    });
    expect(getChatSendProgress(charId)?.phase).toBe(accepted ? 'accepted' : 'failed');
    expect(current.isTyping).toBe(false);
});
