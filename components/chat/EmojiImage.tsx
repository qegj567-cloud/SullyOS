import React, { useEffect, useRef, useState } from 'react';
import { hasEmojiCacheStorage, isRemoteEmoji, loadEmojiOriginal } from '../../utils/emojiOriginals';
import TokenImg from '../os/TokenImg';

type Props = React.ImgHTMLAttributes<HTMLImageElement> & { value: string };
const missingSticker = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><g fill="none" stroke="#969aa2" stroke-width="1.5" stroke-linejoin="round"><rect x="9" y="10" width="30" height="28" rx="6"/><circle cx="18" cy="19" r="2"/><path d="m11 32 8-8 5 5 5-7 9 11"/></g></svg>');

function RemoteImage({ value, loading, ...props }: Props) {
    const element = useRef<HTMLImageElement>(null);
    const [source, setSource] = useState<string>();
    useEffect(() => {
        let active = true;
        let objectUrl: string | undefined;
        let observer: IntersectionObserver | undefined;
        const load = async () => {
            observer?.disconnect();
            const { blob } = await loadEmojiOriginal(value);
            if (!active) return;
            try { if (blob) objectUrl = URL.createObjectURL(blob); } catch { /* use the original URL */ }
            setSource(objectUrl ? objectUrl + new URL(value).hash : value);
        };
        if (loading === 'lazy' && element.current && typeof IntersectionObserver !== 'undefined') {
            observer = new IntersectionObserver(entries => {
                if (entries.some(entry => entry.isIntersecting)) void load();
            }, { rootMargin: '160px' });
            observer.observe(element.current);
        } else { void load(); }
        return () => {
            active = false;
            observer?.disconnect();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [value, loading]);
    return <img ref={element} src={source} loading={loading} {...props} />;
}

export default function EmojiImage(props: Props) {
    if (!isRemoteEmoji(props.value)) return <TokenImg {...props} />;
    const Image = hasEmojiCacheStorage() ? RemoteImage : TokenImg;
    return <Image key={props.value} {...props} onError={event => {
        const img = event.currentTarget;
        if (img.getAttribute('src') !== missingSticker) {
            img.src = missingSticker;
            if (!img.alt) img.alt = '表情暂不可用';
        }
        props.onError?.(event);
    }} />;
}
