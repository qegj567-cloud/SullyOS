/** Shared by browser chat and Worker; missing settings retain the existing capability. */
export const isMonthlyRecallEnabled = (char: { monthlyRecallEnabled?: boolean }): boolean =>
    char.monthlyRecallEnabled !== false;

/** Remove disabled control tags before they can start another model request. */
export const stripDisabledMonthlyRecall = (text: string, char: { monthlyRecallEnabled?: boolean }): string =>
    isMonthlyRecallEnabled(char) ? text : text.replace(/\[\[RECALL:[^\]]*\]\]/gi, '').trim();
