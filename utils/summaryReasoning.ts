/** Require multiple signals to avoid mistaking quoted story dialogue for reasoning. */
export function hasSummaryReasoningLeak(content: string): boolean {
    const text = content.trim();
    if (!text) return false;
    if (/<(?:think|thinking|thought)>/i.test(text)) return true;
    const signals = [
        /\bparagraph\s*\d+\s*:\s*\d+\s*(?:chars?|characters?)\b/i,
        /\btotal\s*:\s*[\d\s+]+\s*(?:chars?|characters?)\b/i,
        /\bstill\s+too\s+long\b/i,
        /\bneed\s+to\s+get\s+under\s+\d+\b/i,
        /\blet(?:'|’)s\s+(?:count|condense|compress|shorten)\b/i,
        /(?:^|\n)\s*(?:analysis|reasoning)\s*:/i,
    ];
    return signals.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0) >= 2;
}
