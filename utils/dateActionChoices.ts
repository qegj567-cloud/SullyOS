import type { Message } from '../types';

export const DATE_ACTION_KINDS = [
    { id: 'daily', label: '日常推进' },
    { id: 'plot', label: '申请变数' },
    { id: 'joke', label: '插科打诨' },
    { id: 'oppose', label: '排斥反对' },
] as const;
export type DateActionKind = typeof DATE_ACTION_KINDS[number]['id'];
export interface DateActionChoice { kind: DateActionKind; text: string }

export function buildDateActionChoicesPrompt(enabled?: boolean): string {
    if (enabled !== true) return '';
    return `\n### 可选行动建议（独立于角色正文）
写完本轮角色正文后，在回复最末尾追加以下独立块，每类恰好一条、各占一行。结合刚写出的场景，给用户可选择、修改和补充的具体回应草稿，每条约 10～60 字。
⟦ACTIONS⟧
daily｜平实地接话或做一件生活小事，不硬推剧情。
plot｜（请求一个贴合当前场景的小变数，为接下来的互动带来新变化。）
joke｜贴合人物关系的打趣、接梗或轻松岔话。
oppose｜针对当前情境表达不同意见、拒绝、质疑或保持距离，不强行辱骂。
⟦/ACTIONS⟧
以上四行描述的是方向，实际输出须替换成当前场景下可直接编辑的草稿，不能照抄方向说明。plot 必须用整句中文括号写成用户对叙事的申请，不把变数写成已经发生的事实。
建议是用户尚未选择的可能回应，不是角色台词、用户已做的行动或双方共同经历。不要在角色正文中响应这些建议。普通建议只写用户一方可说的话或可做的事，不代写角色接下来会怎样；排斥反对也不能反过来写成默许。不要给建议加情绪、语音或译文标签。正文仍遵守原有立绘与语音格式。\n`;
}

/** Only explicit blocks are consumed; ordinary prose is never guessed to be a choice. */
export function extractDateActionChoices(raw: string): { body: string; choices: DateActionChoice[] } {
    const choices = new Map<DateActionKind, string>();
    const body = raw.replace(/(?:⟦|\[|【)\s*ACTIONS\s*(?:⟧|\]|】)([\s\S]*?)(?:(?:⟦|\[|【)\s*\/ACTIONS\s*(?:⟧|\]|】)|$)/gi, (_, block: string) => {
        for (const line of block.split(/\r?\n/)) {
            const match = line.trim().match(/^(?:[-*]\s*)?(daily|plot|joke|oppose)\s*[｜|:：]\s*(.+)$/i);
            if (!match) continue;
            const kind = match[1].toLowerCase() as DateActionKind;
            let text = match[2].replace(/<date-voice\b[^>]*>[\s\S]*?<\/date-voice>/gi, '').replace(/\[(?:v:)?[\w-]+\]/g, '').trim();
            if (!text || text.length > 500 || /[<>⟦⟧]/.test(text) || choices.has(kind)) continue;
            if (kind === 'plot') text = `（${text.replace(/^[（(]|[）)]$/g, '')}）`;
            choices.set(kind, text);
        }
        return '';
    }).trim();
    return { body, choices: DATE_ACTION_KINDS.flatMap(({ id }) => choices.has(id) ? [{ kind: id, text: choices.get(id)! }] : []) };
}

/** Latest turn only: a pending user turn, older encounter or malformed metadata cannot revive stale choices. */
export function getDateActionChoices(messages: Message[]): DateActionChoice[] {
    const last = messages[messages.length - 1];
    if (last?.role !== 'assistant' || !Array.isArray(last.metadata?.dateActionChoices)) return [];
    return DATE_ACTION_KINDS.flatMap(({ id }) => {
        const item = last.metadata!.dateActionChoices.find((value: unknown) => !!value && typeof value === 'object' && (value as DateActionChoice).kind === id);
        return item && typeof item.text === 'string' && item.text.trim() && item.text.length <= 500 ? [{ kind: id, text: item.text }] : [];
    });
}
