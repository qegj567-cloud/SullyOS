import React, { useEffect, useState } from 'react';
import { CANARY_DOT_CHANGED_EVENT, RELEASE_CHANNEL, readCanaryDotHidden } from '../utils/releaseChannel';

/**
 * canary 构建右下角的小黄点：一眼认出自己在 canary 里，又不挡内容。
 * 设置底部可以把它藏起来（docs/canary-channel.md）。正式版不渲染。
 */
const CanaryDot: React.FC = () => {
    const [hidden, setHidden] = useState(readCanaryDotHidden);

    useEffect(() => {
        const sync = () => setHidden(readCanaryDotHidden());
        window.addEventListener(CANARY_DOT_CHANGED_EVENT, sync);
        window.addEventListener('storage', sync);
        return () => {
            window.removeEventListener(CANARY_DOT_CHANGED_EVENT, sync);
            window.removeEventListener('storage', sync);
        };
    }, []);

    if (RELEASE_CHANNEL !== 'canary' || hidden) return null;
    return (
        <div
            aria-hidden
            className="fixed pointer-events-none select-none rounded-full"
            style={{
                bottom: 'calc(var(--safe-bottom) + 8px)',
                right: 'calc(env(safe-area-inset-right, 0px) + 8px)',
                width: 7,
                height: 7,
                background: '#FACC15',
                boxShadow: '0 0 0 1.5px rgba(255,255,255,0.85), 0 0 6px 1px rgba(250,204,21,0.75)',
                zIndex: 2147483647,
            }}
        />
    );
};

export default CanaryDot;
