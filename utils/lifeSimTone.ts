const LIFE_SIM_TONE_EMOJIS: Record<string, string> = {
    vengeful: '😠',
    romantic: '💘',
    scheming: '😼',
    chaotic: '🌀',
    peaceful: '😌',
    amused: '😏',
    anxious: '😰',
};

export function getLifeSimToneEmoji(tone?: string | null): string {
    if (!tone) return '';
    return LIFE_SIM_TONE_EMOJIS[tone.toLowerCase()] || '';
}

export function formatLifeSimActionDescription(description?: string | null): string {
    if (!description) return '';

    return description
        .replace(/\[(vengeful|romantic|scheming|chaotic|peaceful|amused|anxious)\]/gi, (_, tone: string) => {
            const emoji = getLifeSimToneEmoji(tone);
            return emoji ? ` ${emoji} ` : ' ';
        })
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}
