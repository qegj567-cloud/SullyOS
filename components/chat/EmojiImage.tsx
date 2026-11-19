import React, { useEffect, useRef, useState } from 'react';
import { hasEmojiCacheStorage, isRemoteEmoji, loadEmojiOriginal } from '../../utils/emojiOriginals';
import TokenImg from '../os/TokenImg';

type Props = React.ImgHTMLAttributes<HTMLImageElement> & { value: string };

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
    if (isRemoteEmoji(props.value) && hasEmojiCacheStorage()) {
        return <RemoteImage key={props.value} {...props} />;
    }
    return <TokenImg {...props} />;
}
