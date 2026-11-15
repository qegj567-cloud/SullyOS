import React, { forwardRef } from 'react';
import peeking from '../../assets/sully-support/sully-peeking.webp';
import './SullySupport.css';

export function SupportIcon({ name }: { name: 'back' | 'arrow' | 'heart' | 'download' }) {
    const paths = {
        back: 'm14 6-6 6 6 6',
        arrow: 'M5 12h14m-6-6 6 6-6 6',
        download: 'M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5',
        heart: 'M20.5 4.7a5.2 5.2 0 0 0-7.4 0L12 5.8l-1.1-1.1a5.2 5.2 0 0 0-7.4 7.4L12 21l8.5-8.9a5.2 5.2 0 0 0 0-7.4Z',
    };
    return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

const SullySupportEntry = forwardRef<HTMLButtonElement, { onOpen: () => void }>(function SullySupportEntry({ onOpen }, ref) {
    return <div className="sully-support support-entry-wrap">
        <button ref={ref} className="support-entry" type="button" onClick={onOpen} aria-label="打开打赏 Sully 页面">
            <span className="gingham entry-gingham" aria-hidden="true" /><span className="paper-tape" aria-hidden="true" />
            <span className="entry-copy">
                <span className="entry-kicker">SULLY-08 · SNACK STATION</span>
                <strong>打赏 Sully<span className="star small-star" aria-hidden="true" /></strong>
                <span className="entry-subtitle">给像素猫买点小鱼干</span>
                <span className="entry-action">去投喂 <SupportIcon name="arrow" /></span>
            </span>
            <img className="entry-character" src={peeking} alt="从角落探出头的 Sully" width="360" height="376" loading="lazy" />
            <span className="star entry-star" aria-hidden="true" />
        </button>
        <p className="settings-thanks"><span />谢谢你，让这个小世界继续发光。<span /></p>
    </div>;
});

export default SullySupportEntry;
