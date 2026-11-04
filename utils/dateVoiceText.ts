/** 提取引号中的台词；v4 的声音指令留在脚本里，立绘和 [v:xxx] 不进入朗读。 */
export const extractDateDialogueText = (text: string, preserveAudioTags = false): string => {
    const clean = (preserveAudioTags ? text.replace(/\[v:\s*[a-zA-Z]+\s*\]/gi, '') : text.replace(/\[.*?\]/g, '')).trim();
    const matches = clean.match(/["\u201C]([^"\u201D]*)["\u201D]/g)
        || clean.match(/[\u300C]([^\u300D]*)[\u300D]/g);
    if (matches) {
        return matches.map(match => match.replace(/["\u201C\u201D\u300C\u300D]/g, '').trim()).join(' ');
    }
    return clean;
};
