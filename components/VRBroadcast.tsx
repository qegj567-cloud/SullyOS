import React, { useEffect, useRef, useState } from 'react';

/**
 * 「彼方」大世界喇叭 —— 当某角色正在登入彼方、调用 API 行动时，
 * 顶部滑出一条 MMO 风格的世界播报。监听 runSession 派发的
 * vr-session-start / vr-session-end 事件，全局挂载（App 根级）。
 */

interface ActiveSession { charId: string; charName: string; room: string; novelTitle?: string; }

const ROOM_LABEL: Record<string, { name: string }> = {
    library: { name: '图书馆' },
    music: { name: '听歌房' },
    guestbook: { name: '留言簿' },
    gym: { name: '活动场' },
};

const VRBroadcast: React.FC = () => {
    const [active, setActive] = useState<ActiveSession[]>([]);
    const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const onStart = (e: Event) => {
            const d = (e as CustomEvent).detail as ActiveSession;
            if (!d?.charId) return;
            setActive(prev => prev.some(s => s.charId === d.charId) ? prev : [...prev, d]);
        };
        const onEnd = (e: Event) => {
            const id = (e as CustomEvent).detail?.charId;
            // 结束时延迟一会再移除，让"刚逛完"的播报多留一下
            setTimeout(() => setActive(prev => prev.filter(s => s.charId !== id)), 1500);
        };
        window.addEventListener('vr-session-start', onStart);
        window.addEventListener('vr-session-end', onEnd);
        return () => {
            window.removeEventListener('vr-session-start', onStart);
            window.removeEventListener('vr-session-end', onEnd);
            if (hideTimer.current) clearTimeout(hideTimer.current);
        };
    }, []);

    if (active.length === 0) return null;
    const cur = active[active.length - 1];
    const room = ROOM_LABEL[cur.room] || { name: '彼方' };
    const extra = active.length > 1 ? ` 等 ${active.length} 人` : '';

    return (
        <div className="fixed left-1/2 -translate-x-1/2 z-[999] pointer-events-none"
            style={{ top: 'calc(var(--safe-top) + 6px)' }}>
            <style>{`@keyframes vrbcin{from{opacity:0;transform:translateY(-14px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
                     @keyframes vrbcshimmer{0%{background-position:-120% 0}100%{background-position:220% 0}}
                     @keyframes vrbctwinkle{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1.1)}}`}</style>
            <div className="relative flex items-center gap-2.5 pl-3 pr-3.5 py-1.5 rounded-full overflow-hidden backdrop-blur-xl"
                style={{
                    animation: 'vrbcin .45s cubic-bezier(.2,.9,.3,1.2)',
                    background: 'linear-gradient(100deg, rgba(22,28,46,.82), rgba(14,18,30,.82))',
                    border: '1px solid rgba(190,200,255,.28)',
                    boxShadow: '0 10px 30px rgba(0,0,0,.45), inset 0 1px 0 rgba(200,210,255,.18), 0 0 18px rgba(150,170,255,.18)',
                }}>
                {/* 月光流光 */}
                <div className="absolute inset-0 pointer-events-none" style={{
                    background: 'linear-gradient(105deg,transparent 32%,rgba(200,215,255,.16) 50%,transparent 68%)',
                    backgroundSize: '220% 100%',
                    animation: 'vrbcshimmer 3s linear infinite',
                }} />
                <span className="relative text-[12px] opacity-80" style={{ filter: 'drop-shadow(0 0 5px rgba(180,195,255,.6))' }}>✦</span>
                <span className="relative text-[11px] tracking-[0.04em] text-white/90 whitespace-nowrap font-light">
                    <span className="text-amber-200/90 font-normal">{cur.charName}</span>{extra} 正漫游于彼方 · {room.name}
                    {cur.novelTitle ? ` 读《${cur.novelTitle}》` : ''}
                </span>
                <span className="relative flex gap-1">
                    {[0, 1, 2].map(i => (
                        <span key={i} className="w-1 h-1 rounded-full bg-indigo-100/80"
                            style={{ animation: 'vrbctwinkle 1.4s infinite', animationDelay: `${i * 0.25}s` }} />
                    ))}
                </span>
            </div>
        </div>
    );
};

export default VRBroadcast;
