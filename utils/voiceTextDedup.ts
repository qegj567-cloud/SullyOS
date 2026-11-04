/** Remove only verbatim prose repeated outside voice/subtitle blocks in one reply. */
export function deduplicateVoiceText(text: string): string {
    // Structured cards/translations may contain prose that must remain intact.
    if (/\[html\]|<翻[译譯]>|```/i.test(text)) return text;
    const normalize = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
    const blocks: string[] = [];
    const spoken: string[] = [];
    const protectedText = text.replace(/(?:<字幕>([\s\S]*?)<\/字幕>\s*)?<[语語]音[^>]*>([\s\S]*?)<\/[语語]音>(?:\s*<字幕>([\s\S]*?)<\/字幕>)?/g, (block, leadingSubtitle, voice, subtitle) => {
        spoken.push(normalize(voice), ...[leadingSubtitle, subtitle].filter(Boolean).map(normalize));
        return '\n\u0002VOICE' + (blocks.push(block) - 1) + '\u0002\n';
    });
    if (!blocks.length) return text;
    return protectedText.split(/\r?\n/).filter(line => {
        // Never remove protocol/HTML/translation blocks or tiny acknowledgements.
        if (/[<>\[\]\u0002]/.test(line)) return true;
        const plain = normalize(line);
        return plain.length < 12 || !spoken.some(voice => voice.includes(plain));
    }).join('\n').replace(/\u0002VOICE(\d+)\u0002/g, (_, i) => blocks[Number(i)]).trim();
}
