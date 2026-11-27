/**
 * 聊天页三处「画面不变、少干活」用的纯函数：
 * 生成途中刷新界面读多少条、语音回填查哪些消息、流式预览按什么节奏更新。
 */
import type { Message } from '../types';

/** 界面没给读法、或短读画不满一屏时，刷新界面整读的条数。 */
export const CHAT_REFRESH_FULL_LIMIT = 200;

/** 流式预览两次更新之间的最短间隔。 */
export const STREAM_PREVIEW_INTERVAL_MS = 60;

/**
 * 生成途中刷新界面要读的那一截。界面只画最近 wanted 条可见消息，短读够画就不整读，
 * 画出来的结果与整读 CHAT_REFRESH_FULL_LIMIT 条相同。
 */
export async function readChatRefreshTail(
    read: (limit: number) => Promise<Message[]>,
    wanted: number,
    isVisible: (message: Message) => boolean,
): Promise<Message[]> {
    // 旧消息定位模式把 wanted 调到极大，照它读等于每条气泡读一遍全部历史。
    if (wanted >= 100000) return read(CHAT_REFRESH_FULL_LIMIT);
    const limit = wanted + 16;
    const tail = await read(limit);
    if (limit >= CHAT_REFRESH_FULL_LIMIT || tail.length < limit) return tail;
    // 末尾夹着大量不在私聊里显示的记录（见面、通话等）时短读画不满，整读。
    return tail.filter(isVisible).length >= wanted ? tail : read(CHAT_REFRESH_FULL_LIMIT);
}

/** 语音回填要查库的消息：角色发的文字，还没有语音，这次停留期间也没查空过。 */
export function pickVoiceHydrationTargets(
    messages: Message[],
    hasVoice: (id: number) => boolean,
    checkedEmpty: ReadonlySet<number>,
): Message[] {
    return messages.filter(m => m.id && m.type === 'text' && m.role !== 'user' && !hasVoice(m.id) && !checkedEmpty.has(m.id));
}

/**
 * 把高频触发合并成固定节奏：schedule 只登记「有新内容」，每 intervalMs 至多跑一次 run。
 * 用 setTimeout 而不是 requestAnimationFrame：页面在后台时后者不触发。
 */
export function createCoalescedRunner(run: () => void, intervalMs: number) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dirty = false;
    let stopped = false;
    const clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
    /** 立刻同步补跑挂起的那一次。 */
    const flush = () => {
        clear();
        if (!dirty) return;
        dirty = false;
        run();
    };
    return {
        schedule: () => {
            dirty = true;
            if (!stopped && timer === null) timer = setTimeout(flush, intervalMs);
        },
        flush,
        /** 撤掉定时器且不再定时；挂起的内容留着，之后 flush 仍能补上。 */
        stop: () => { stopped = true; clear(); },
    };
}
