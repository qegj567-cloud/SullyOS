export const SULLY_HELP_PREVIEW = '[糯米机答疑 · Sully-11]';

// 只在指令内部放宽空白和全角拼写，不改写用户看到的正文。
const open = /[\[［【]/.source;
const close = /[\]］】]/.source;
const find = /[fｆ]\s*[iｉ]\s*[nｎ]\s*[dｄ]/.source;
const find11 = find + /\s*[:：_-]?\s*[1１]\s*[1１]/.source;
const opening = `${open}(?:\\s*${open}){0,2}`;
const closing = `${close}(?:\\s*${close}){0,2}`;
const gap = /[^\S\r\n]*/.source;
const bareFind11 = /[fｆ][iｉ][nｎ][dｄ][^\S\r\n]*[1１][1１]/.source;

export const SULLY_HELP_COMMAND = new RegExp([
    // 有开括号时，接受单层、双层、混用括号；行末截断也能恢复。
    `${opening}\\s*${find11}(?:\\s*${closing}|${gap}$)`,
    // 两侧括号都漏掉时，只认独占一行的指令，不从一句话中猜动作。
    `^${gap}${bareFind11}(?:${gap}${closing})?${gap}$`,
    // 旧版 find 没有工号，只兼容明确的双括号形式。
    `${open}\\s*${open}\\s*${find}\\s*${close}\\s*${close}`,
].join('|'), 'gim');
