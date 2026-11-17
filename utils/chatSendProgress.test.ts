import { describe, expect, it, vi } from 'vitest';
import { beginChatSendProgress, cancelChatSendProgress, getChatSendProgress, subscribeChatSendProgress } from './chatSendProgress';

describe('chat send handoff progress', () => {
    it('does not turn prompt preparation into a cloud receipt, and retains the receipt through cleanup', () => {
        const send = beginChatSendProgress('handoff', 12);
        send.accepted();
        expect(getChatSendProgress('handoff')).toMatchObject({ messageId: 12, phase: 'preparing' });
        send.sending();
        expect(getChatSendProgress('handoff')?.phase).toBe('sending');
        send.accepted(); send.finish(false);
        expect(getChatSendProgress('handoff')?.phase).toBe('accepted');
    });
    it('notifies only on state changes, without polling; unsubscribing does not lose in-flight progress', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeChatSendProgress(listener);
        const send = beginChatSendProgress('navigation', 13);
        const snapshot = getChatSendProgress('navigation');
        expect(getChatSendProgress('navigation')).toBe(snapshot);
        unsubscribe(); send.sending();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(getChatSendProgress('navigation')?.phase).toBe('sending');
        send.failed();
    });
    it('a late success or cleanup from an older attempt cannot hide a newer send', () => {
        const old = beginChatSendProgress('retry', 14); old.sending();
        const next = beginChatSendProgress('retry', 15);
        old.accepted(); old.local(); old.finish(false);
        expect(getChatSendProgress('retry')).toMatchObject({ messageId: 15, phase: 'preparing' });
        next.failed(); next.accepted();
        expect(getChatSendProgress('retry')?.phase).toBe('failed');
    });
    it('stopping before or after acceptance never resurrects a sending animation', () => {
        const send = beginChatSendProgress('stop', 16); send.sending();
        cancelChatSendProgress('stop'); send.accepted(); send.finish(false);
        expect(getChatSendProgress('stop')?.phase).toBe('cancelled');
        const next = beginChatSendProgress('stop', 17); next.sending(); next.accepted();
        cancelChatSendProgress('stop');
        expect(getChatSendProgress('stop')?.phase).toBe('cancelled');
    });
    it('distinguishes intentional local replies from a failed cloud handoff', () => {
        const local = beginChatSendProgress('local', 18); local.local(); local.finish(false);
        expect(getChatSendProgress('local')).toBeNull();
        const veto = beginChatSendProgress('veto', 19); veto.local(true);
        expect(getChatSendProgress('veto')?.phase).toBe('local');
        veto.finish(false);
        expect(getChatSendProgress('veto')).toBeNull();
        const failed = beginChatSendProgress('error', 20); failed.finish(false);
        expect(getChatSendProgress('error')?.phase).toBe('failed');
    });
});
