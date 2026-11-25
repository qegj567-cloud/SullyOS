import type { Message } from '../types';
import type { DraftBubble } from './chatTurnRevision';

export function describeRevisionBubble(row: DraftBubble): string {
    if (row.type === 'emoji') return `[[SEND_EMOJI: ${row.metadata?.stickerName || '表情包'}]]`;
    if (row.type === 'html_card') return `[html]${row.metadata?.htmlSource ?? row.content}[/html]`;
    const parts = row.content.split(/\s*%%BILINGUAL%%\s*/);
    return parts.length === 2 ? `<翻译><原文>${parts[0]}</原文><译文>${parts[1]}</译文></翻译>` : row.content;
}

export function buildChatRerollPrompt(originals: Message[], guidance = '', targetIds?: number[]): string {
    const positions = originals.flatMap((row, index) => targetIds?.includes(row.id) ? [index + 1] : []);
    const draft = originals.map(row => ['text', 'emoji', 'html_card'].includes(row.type)
        ? describeRevisionBubble(row) : '[' + row.type + ']');
    return [
        '【本轮重新生成 · 临时说明】用户点击了重新生成。请回到原回复发出前的对话现场，沿用当前角色、聊天历史、关系和输出格式，回应当时的话题。',
        '下面的旧稿仅供对照，不是新发生的对话。不要把重写说明当成用户在聊天中说的话，也不要重复执行旧稿中的操作。',
        '本轮原回复（按气泡顺序）：' + JSON.stringify(draft),
        positions.length ? '只替换第 ' + positions.join('、') + ' 个气泡。按原顺序为每个所选位置各输出一个气泡，与保留的前后句衔接。' : '请重新生成整轮回复。',
        guidance.trim() ? '用户对新版的期望：' + JSON.stringify(guidance.trim()) :
            '用户没有填写期望。请对照旧稿与之前的聊天，自行判断哪里可能没接住对方的话，例如遗漏的问题、语气或重复的内容。有依据就调整；原因不明确时，给出另一种自然且符合角色的回应，不要断言用户为什么重写。',
        '直接输出新版角色回复，沿用本轮需要的格式。不要解释判断过程、道歉说要重写，或追问用户为什么点击重新生成。',
    ].join('\n');
}
