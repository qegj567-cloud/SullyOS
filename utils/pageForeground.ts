/** A resumed WebView may only send focus/pageshow/resume. Coalesce bursts, never poll. */
export function subscribePageForeground(onForeground: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
        if (document.visibilityState !== 'visible' || timer !== undefined) return;
        timer = setTimeout(() => {
            timer = undefined;
            if (document.visibilityState === 'visible') onForeground();
        }, 0);
    };
    document.addEventListener('visibilitychange', wake);
    document.addEventListener('resume', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('focus', wake);
    return () => {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', wake);
        document.removeEventListener('resume', wake);
        window.removeEventListener('pageshow', wake);
        window.removeEventListener('focus', wake);
    };
}
