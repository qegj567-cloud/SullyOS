import React, { useEffect, useRef, useState } from 'react';
import type { ScheduleSlot } from '../../types';
import './ScheduleTheaterButton.css';

export default function ScheduleTheaterButton({ slot, future, onPlay, onPress }: {
    slot: ScheduleSlot;
    future: boolean;
    onPlay: () => void;
    onPress?: () => void;
}) {
    const [hint, setHint] = useState(false);
    const timer = useRef<number>();
    useEffect(() => () => window.clearTimeout(timer.current), []);
    const cached = !!slot.theater?.lines.length;
    const label = future ? '还没到这个时间哦' : cached ? '重看小剧场' : '窥视这一刻';
    return <div className="sully-schedule-play">
        <button type="button" title={label} aria-label={`${slot.startTime} ${slot.activity} · ${label}`}
            aria-disabled={future} data-cached={cached && !future}
            onPointerDown={event => { event.stopPropagation(); onPress?.(); }}
            onClick={event => {
                event.stopPropagation();
                if (!future) { onPlay(); return; }
                setHint(true);
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => setHint(false), 1800);
            }}>{cached && !future ? '↻' : '▶'}</button>
        {future && hint && <span role="status">{label}</span>}
    </div>;
}
