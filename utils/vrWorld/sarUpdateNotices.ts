import type { CaianExpression } from './sarArt';

export type SARUpdateNotice = 'cabinet' | 'board';
type Line = { expression: CaianExpression; text: string | readonly string[]; emphasis?: string; quoted?: boolean };

/** Authored release messages; kept outside familiarity scenes and their daily/reward state. */
export const SAR_UPDATE_NOTICES: Record<SARUpdateNotice, readonly Line[]> = {
    cabinet: [
        { expression: 'happy', text: '对了！刚刚收到了优化通知。' },
        { expression: 'normal', text: ['异格回复：点「…」可复制、修改、重新生成、删除。', '删除后点生成会重试原来那一幕，不重复扣轮数；生成失败保留旧回复'], emphasis: '异格回复', quoted: true },
        { expression: 'happy', text: '——彼方的作者是这样留言的。' },
        { expression: 'normal', text: '那么，我转达到位了！' },
        { expression: 'normal2', text: '玩得开心哦。' },
    ],
    board: [
        { expression: 'happy', text: '打扰一下！我来转达优化通知了！' },
        { expression: 'normal', text: ['之前路人用的是固定句库，现在一次 LLM 生成两三位路人，', '共同完成发帖、回帖、互相吐槽和隔空喊话。'], emphasis: '一次 LLM 生成两三位路人', quoted: true },
        { expression: 'happy', text: '——彼方的作者是这样留言的。' },
        { expression: 'warm', text: '那么，请继续享受彼方吧！' },
    ],
};

const acknowledged = new Set<SARUpdateNotice>();
export const sarUpdateNoticeKey = (notice: SARUpdateNotice) => `sar-feature-update-september-v1:${notice}`;

export function hasReadSARUpdateNotice(notice: SARUpdateNotice): boolean {
    if (acknowledged.has(notice)) return true;
    try { return localStorage.getItem(sarUpdateNoticeKey(notice)) === 'done'; }
    catch { return false; }
}

/** Called only after the final line. Interrupted visits leave the notice unread. */
export function acknowledgeSARUpdateNotice(notice: SARUpdateNotice): void {
    acknowledged.add(notice);
    try { localStorage.setItem(sarUpdateNoticeKey(notice), 'done'); }
    catch { /* Storage unavailable: remember completion for this session. */ }
}
