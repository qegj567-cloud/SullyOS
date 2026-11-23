import React, { useEffect, useState } from 'react';
import './CanaryBird.css';

/**
 * canary 通道的小金丝雀（docs/canary-channel.md「小金丝雀」）。
 * fly 一直扑腾、idle 站着偶尔扇翅膀、still 不动；系统减弱动态效果时都不动。
 */
export const CanaryBird: React.FC<{
    size?: number;
    mode?: 'fly' | 'idle' | 'still';
    className?: string;
    style?: React.CSSProperties;
}> = ({ size = 24, mode = 'still', className = '', style }) => (
    <svg
        aria-hidden
        viewBox="0 0 40 34"
        width={size}
        height={size * 34 / 40}
        data-mode={mode}
        className={`canary-bird ${className}`}
        style={style}
    >
        <g className="canary-bird-legs" stroke="#EA580C" strokeWidth="1.4" strokeLinecap="round">
            <path d="M17 27.5v4.5m-1.5 0h3M22 27.5v4.5m-1.5 0h3" />
        </g>
        <g className="canary-bird-body">
            <path d="M9 19 1.5 15.5 3 22.5Z" fill="#EAB308" stroke="#CA8A04" strokeWidth="0.8" strokeLinejoin="round" />
            <ellipse cx="19" cy="19.5" rx="11.5" ry="9" fill="#FACC15" stroke="#CA8A04" strokeWidth="0.8" />
            <circle cx="27" cy="11" r="7" fill="#FACC15" stroke="#CA8A04" strokeWidth="0.8" />
            {/* 把头和身体的接缝盖掉 */}
            <ellipse cx="24" cy="16.5" rx="5" ry="3.5" fill="#FACC15" />
            <path d="M33.6 9.2 38.6 11.2 33.6 13.2Z" fill="#F97316" strokeLinejoin="round" />
            <circle cx="29.6" cy="9.8" r="1.4" fill="#1F2937" />
            <circle cx="30.1" cy="9.3" r="0.45" fill="#fff" />
            <ellipse cx="29" cy="13.6" rx="1.7" ry="1" fill="#FB923C" opacity="0.45" />
            <path className="canary-bird-wing" d="M17 16c-6 -1 -10 2 -10.5 6 3.5 1.5 9 1 12-2.5 .8-1 .2-3.2-1.5-3.5Z" fill="#EAB308" stroke="#CA8A04" strokeWidth="0.8" strokeLinejoin="round" />
        </g>
    </svg>
);

/**
 * 「canary」在各国语言里的叫法：canary 是很多人一起试出来的。
 * 加入时这些名字跟着小鸟往上飘，落地时它挨个报一遍。
 */
export const CANARY_NAMES = [
    // 前 8 个会飘在加入动画里，挑了不同文字系统的排前面
    '金丝雀', 'Canary', 'カナリア', 'Канарейка', '카나리아', 'Canari', 'كناري', 'Καναρίνι',
    'Canario', 'Canarino', 'Kanarienvogel', 'Canário', 'Kanarya', 'Kanarek', 'Hoàng yến', 'นกคีรีบูน',
];
/** 落地时挨个报的几个名字，最后停在中文欢迎上。 */
const ARRIVAL_LINES = ['Canary!', 'カナリア！', 'Canari!', 'Канарейка!', '啾！欢迎来到 canary'];
const LINE_MS = 380;

const FLY_IN_MS = 1500;
/** 落地后站多久再缩成黄点：说完前几句，最后一句多留一会儿。 */
const PERCH_MS = LINE_MS * (ARRIVAL_LINES.length - 1) + 1500;
const SHRINK_MS = 500;

/**
 * 刚加入 canary 时右下角的落地动画：从左上飞进来，落到黄点的位置叫一声，再缩成黄点。
 * 放完调用 onDone。
 */
export const CanaryArrival: React.FC<{ onDone?: () => void }> = ({ onDone }) => {
    const [phase, setPhase] = useState<'fly' | 'perch' | 'shrink'>('fly');
    const [line, setLine] = useState(0);

    useEffect(() => {
        const timers = [
            setTimeout(() => setPhase('perch'), FLY_IN_MS),
            setTimeout(() => setPhase('shrink'), FLY_IN_MS + PERCH_MS),
            setTimeout(() => onDone?.(), FLY_IN_MS + PERCH_MS + SHRINK_MS),
        ];
        return () => timers.forEach(clearTimeout);
    }, [onDone]);

    useEffect(() => {
        if (phase !== 'perch') return;
        const timer = setInterval(() => setLine((index) => Math.min(index + 1, ARRIVAL_LINES.length - 1)), LINE_MS);
        return () => clearInterval(timer);
    }, [phase]);

    return (
        <div aria-hidden className="canary-arrival" data-phase={phase}>
            {phase === 'perch' && <span key={line} className="canary-arrival-bubble">{ARRIVAL_LINES[line]}</span>}
            <CanaryBird size={36} mode={phase === 'fly' ? 'fly' : 'idle'} />
        </div>
    );
};
