import { useLayoutEffect, type RefObject } from 'react';

/** 键盘、输入框和工具栏改变列表高度时，原本在末尾的会话继续露出最新消息。 */
export function useChatViewportAnchor(
    scrollRef: RefObject<HTMLElement>,
    conversationId: string | undefined,
    enabled: boolean,
) {
    useLayoutEffect(() => {
        const element = scrollRef.current;
        if (!enabled || !element) return;
        let height = element.clientHeight;
        const atBottom = () => element.scrollHeight - element.scrollTop - element.clientHeight <= 96;
        let followBottom = atBottom();
        const onScroll = () => {
            // WebKit 可先派发尺寸变化引起的 scroll，再通知 ResizeObserver。
            // 此时不能把原本贴底的用户误判为正在上翻历史。
            if (element.clientHeight === height) followBottom = atBottom();
        };
        const onResize = () => {
            const nextHeight = element.clientHeight;
            if (!nextHeight || nextHeight === height) return;
            height = nextHeight;
            if (followBottom) element.scrollTop = element.scrollHeight;
        };
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
        observer?.observe(element);
        // 老 WebView 没有 ResizeObserver 时，等视口事件后的布局完成再取尺寸。
        let frame = 0;
        const onViewportResize = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(onResize);
        };
        if (!observer) {
            window.addEventListener('resize', onViewportResize);
            window.visualViewport?.addEventListener('resize', onViewportResize);
        }
        element.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            observer?.disconnect();
            element.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onViewportResize);
            window.visualViewport?.removeEventListener('resize', onViewportResize);
            cancelAnimationFrame(frame);
        };
    }, [scrollRef, conversationId, enabled]);
}
