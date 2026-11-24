import React from 'react';
import { useOS } from '../../context/OSContext';
import { AppID } from '../../types';
import { useDreamSim, dreamSimStore } from '../../utils/dreamSimStore';
import { MoonStars, CaretRight } from '@phosphor-icons/react';

// 全局「梦境」生成指示条 —— 挂在 PhoneShell，随处可见，点击深链回到那场梦。
// 在云端生成（Worker 已收下、没选「不再提醒」）时提示交给 CloudGenIndicator（弹 3 秒就收起），这里不挂。
const DreamSimIndicator: React.FC = () => {
    const sim = useDreamSim();
    const { openApp } = useOS();

    if (sim.status !== 'loading' && sim.status !== 'ready') return null;

    if (sim.status === 'loading' && sim.cloudSheet) return null;
    const onTap = () => {
        dreamSimStore.requestOpen();
        openApp(AppID.Room);
    };

    const ready = sim.status === 'ready';
    return (
        // 放在 PersonaSim 指示条下方一点，避免叠在一起（top-12 vs top-24）
        <div className="absolute top-24 left-0 w-full flex justify-center px-4 z-[65] pointer-events-none">
            <button onClick={onTap}
                className={`pointer-events-auto flex items-center gap-2.5 rounded-full active:scale-95 transition shadow-[0_8px_30px_rgba(0,0,0,0.5)] border ${ready ? 'animate-notif-pop px-5 py-3' : 'animate-fade-in px-4 py-2.5'}`}
                style={ready
                    ? { background: 'linear-gradient(120deg, rgba(205,214,255,0.97), rgba(150,160,235,0.94))', borderColor: 'rgba(205,214,255,0.5)' }
                    : { background: 'rgba(22,24,46,0.94)', borderColor: 'rgba(205,214,255,0.3)' }}>
                {ready
                    ? <MoonStars size={16} weight="fill" className="text-[#15121c]" />
                    : <span className="w-3.5 h-3.5 border-2 border-[#cdd6ff]/40 border-t-[#cdd6ff] rounded-full animate-spin" />}
                <span className={`text-[12px] font-semibold ${ready ? 'text-[#15121c]' : 'text-white/85'}`}>
                    {ready ? '梦已成形 · 进入' : `梦正在成形${sim.charName ? ' · ' + sim.charName : ''}`}
                </span>
                {ready && <CaretRight size={13} weight="bold" className="text-[#15121c]/80" />}
            </button>
        </div>
    );
};

export default DreamSimIndicator;
