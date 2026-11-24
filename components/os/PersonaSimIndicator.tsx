import React, { useEffect } from 'react';
import { useOS } from '../../context/OSContext';
import { AppID } from '../../types';
import { usePersonaSim, usePersonaSimDeepLink, personaSimStore } from '../../utils/personaSimStore';
import { PERSONA_SIM_CLOUD_FAILED, PERSONA_SIM_LOG_LANDED } from '../../utils/personaSimLog';
import { Sparkle, CaretRight } from '@phosphor-icons/react';

// 全局「人格模拟」生成指示条 —— 挂在 PhoneShell，随处可见，点击深链回到演出。
const PersonaSimIndicator: React.FC = () => {
    const sim = usePersonaSim();
    const deepLink = usePersonaSimDeepLink();
    const { openApp, addToast } = useOS();

    // 深链可能来自 React 之外（云端结果的「进入」），这里统一把查手机打开，CheckPhone 再接着进演出。
    useEffect(() => { if (deepLink) openApp(AppID.CheckPhone); }, [deepLink]);

    // 云端代跑在 React 外落地，提示与本机生成完、生成失败时一样。
    useEffect(() => {
        const onLanded = () => addToast('演出已就绪', 'success');
        const onFailed = () => addToast('演出生成失败，请重试', 'error');
        window.addEventListener(PERSONA_SIM_LOG_LANDED, onLanded);
        window.addEventListener(PERSONA_SIM_CLOUD_FAILED, onFailed);
        return () => {
            window.removeEventListener(PERSONA_SIM_LOG_LANDED, onLanded);
            window.removeEventListener(PERSONA_SIM_CLOUD_FAILED, onFailed);
        };
    }, [addToast]);

    if (sim.status !== 'loading' && sim.status !== 'ready') return null;

    const ready = sim.status === 'ready';
    // 云端在跑（Worker 已收下、没选「不再提醒」）时，提示交给 CloudGenIndicator：弹 3 秒就收起，这里不再挂一颗。
    if (!ready && sim.cloud?.hint) return null;
    const onTap = () => {
        if (!sim.charId) return;
        personaSimStore.requestOpen(sim.charId);
        openApp(AppID.CheckPhone);
    };

    return (
        <div className="absolute top-12 left-0 w-full flex justify-center px-4 z-[65] pointer-events-none">
            <button onClick={onTap}
                className={`pointer-events-auto flex items-center gap-2.5 rounded-full active:scale-95 transition shadow-[0_8px_30px_rgba(0,0,0,0.5)] border ${ready ? 'animate-notif-pop px-5 py-3' : 'animate-fade-in px-4 py-2.5'}`}
                style={ready
                    ? { background: 'linear-gradient(120deg, rgba(184,155,255,0.97), rgba(140,110,224,0.94))', borderColor: 'rgba(184,155,255,0.5)' }
                    : { background: 'rgba(28,24,48,0.94)', borderColor: 'rgba(184,155,255,0.3)' }}>
                {ready
                    ? <Sparkle size={16} weight="fill" className="text-white" />
                    : <span className="w-3.5 h-3.5 border-2 border-[#b89bff]/40 border-t-[#b89bff] rounded-full animate-spin" />}
                <span className={`text-[12px] font-semibold ${ready ? 'text-white' : 'text-white/85'}`}>
                    {ready ? '演出已就绪 · 进入' : `演出生成中${sim.charName ? ' · ' + sim.charName : ''}`}
                </span>
                {ready && <CaretRight size={13} weight="bold" className="text-white/90" />}
            </button>
        </div>
    );
};

export default PersonaSimIndicator;
