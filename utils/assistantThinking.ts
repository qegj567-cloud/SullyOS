/** Provider-labelled thinking only. Ordinary prose is never classified by its language or tone. */
const isThinkingPart = (part: any): boolean => part?.thought === true
    || ['thinking','thought','reasoning','reasoning.text','reasoning.summary'].includes(part?.type);
const isOpaquePart = (part: any): boolean => ['redacted_thinking','reasoning.encrypted','thought_signature'].includes(part?.type);

function plainText(value: any): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(plainText).join('');
    if (!value || typeof value !== 'object' || isOpaquePart(value)) return '';
    return plainText(value.text ?? value.thinking ?? value.summary ?? value.content ?? value.value);
}

function contentParts(value: any): {content: string; reasoning: string} {
    if (typeof value === 'string') return {content:value,reasoning:''};
    if (Array.isArray(value)) return value.map(contentParts).reduce((all,part) => ({
        content:all.content+part.content,reasoning:all.reasoning+part.reasoning,
    }),{content:'',reasoning:''});
    if (!value || typeof value !== 'object' || isOpaquePart(value)) return {content:'',reasoning:''};
    if (isThinkingPart(value)) return {content:'',reasoning:plainText(value)};
    return contentParts(value.text ?? value.content ?? value.value);
}

/** Aliases are mirrors, not extra copies. Empty placeholders must not mask a populated alias. */
export function readAssistantMessage(message: any): {content: string; reasoning: string} {
    const parts = contentParts(message?.content);
    const aliases = [message?.reasoning_content,message?.reasoning,message?.thinking].map(plainText);
    const native = aliases.find(text => text.trim().length > 0)
        || aliases.find(text => text.length > 0) || '';
    const details = Array.isArray(message?.reasoning_details)
        ? message.reasoning_details.filter(isThinkingPart).map(plainText).join('') : '';
    const reasoning = [native.trim() ? native : details || native,parts.reasoning].filter(Boolean);
    return {content:parts.content,reasoning:[...new Set(reasoning)].join('\n\n')};
}

/** Preserve separate signed fields (e.g. anthropic_content) while normalizing readable channels. */
export function normalizeAssistantCompletion(data: any): any {
    if (!Array.isArray(data?.choices)) return data;
    return {...data,choices:data.choices.map((choice: any) => {
        if (!choice?.message) return choice;
        const message = choice.message;
        const parts = readAssistantMessage(message);
        return {...choice,message:{...message,
            ...(message.content != null && typeof message.content !== 'string' ? {content:parts.content} : {}),
            ...(parts.reasoning ? {reasoning_content:parts.reasoning} : {}),
        }};
    })};
}

/** Scan every explicit block, including an unfinished block after earlier closed ones. */
export function splitInlineThinking(text: string): {content: string; reasoning: string} {
    const open = /<(think|thinking|thought)(?:\s[^>]*)?>/gi;
    let content = '', cursor = 0;
    const blocks: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = open.exec(text))) {
        content += text.slice(cursor,match.index);
        const close = new RegExp(`<\\/\\s*${match[1]}\\s*>`,'gi');
        close.lastIndex = open.lastIndex;
        const end = close.exec(text);
        const block = text.slice(open.lastIndex,end ? end.index : text.length).trim();
        if (block) blocks.push(block);
        cursor = end ? close.lastIndex : text.length;
        open.lastIndex = cursor;
        if (!end) break;
    }
    return {content:content+text.slice(cursor),reasoning:blocks.join('\n\n')};
}

export function readAssistantThinking(message: any, override?: string): string {
    const parts = readAssistantMessage(message);
    return [override?.trim() || parts.reasoning.trim(),splitInlineThinking(parts.content).reasoning]
        .filter(Boolean).join('\n\n');
}
