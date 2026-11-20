import React, {useEffect, useMemo, useRef} from 'react';
import {applyCssImageUrls, resolveCssImageUrls} from '../../utils/cssImageAssets';
import {resolveLavenderCardPalette} from '../../utils/lavenderCardPalette';

/** Keep saved CSS and font rules stable while local images finish loading. */
export default function BlobRefStyle({css}: {css: string}) {
    const styleRef = useRef<HTMLStyleElement>(null);
    const displayCss = useMemo(() => resolveLavenderCardPalette(css), [css]);
    useEffect(() => {
        if (!css.includes('blobref:')) return;
        let alive = true; let dispose: (() => void) | undefined;
        void resolveCssImageUrls(css, true).then(result => {
            if (!alive) {result.dispose(); return;}
            dispose = result.dispose;
            try {
                if (styleRef.current?.sheet) applyCssImageUrls(styleRef.current.sheet, result.replacements);
            } catch { /* A stylesheet may have been detached during navigation. */ }
        }).catch(() => { /* Ordinary layout CSS remains usable if the asset store is unavailable. */ });
        return () => {alive = false; dispose?.();};
    }, [css]);
    return <style ref={styleRef}>{displayCss}</style>;
}
