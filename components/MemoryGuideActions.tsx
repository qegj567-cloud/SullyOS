import React from 'react';
import { useOS } from '../context/OSContext';
import {
    hasGuideApi,
    hasGuideSecondaryApi,
    setGuideStep,
    setGuideUseMainApi,
    setVectorGuideSkipped,
    useFirstUseGuideStep,
    useGuideUseMainApi,
} from '../utils/firstUseGuide';

export function MainApiMemoryChoice() {
    const step = useFirstUseGuideStep();
    const useMainApi = useGuideUseMainApi();
    const { apiConfig, memoryPalaceConfig, updateMemoryPalaceConfig } = useOS();
    if (step !== 1) return null;
    const followingMain = useMainApi && !hasGuideApi(memoryPalaceConfig.lightLLM) && hasGuideApi(apiConfig);
    return <div className="mb-3 rounded-xl bg-white/80 p-3 text-xs leading-relaxed text-emerald-800">
        <button data-guide="use-main-api" type="button" disabled={!hasGuideApi(apiConfig)} className="font-bold underline disabled:opacity-40" onClick={() => {
            updateMemoryPalaceConfig({
                lightLLM: { baseUrl: '', apiKey: '', model: '' },
            });
            setGuideUseMainApi(true);
        }}>我想暂时只用主 API</button>
        {followingMain && <span className="ml-2 text-[11px] font-semibold text-emerald-700">已确认跟随主 API</span>}
        <p className="mt-1">保持副 API 留空，自动跟随设置中的主 API 整理记忆（后续主 API 换 Key 或换模型也会自动同步，消耗主 API 额度；之后也可随时换成便宜模型）。</p>
    </div>;
}

export function SkipVectorMemoryChoice() {
    const step = useFirstUseGuideStep();
    const useMainApi = useGuideUseMainApi();
    const { apiConfig, memoryPalaceConfig } = useOS();
    if (step !== 1) return null;
    const canSkip = hasGuideSecondaryApi(memoryPalaceConfig.lightLLM, apiConfig, useMainApi);
    return <div className="mt-3 border-t border-violet-200 pt-3 text-xs leading-relaxed text-slate-600">
        <button type="button" disabled={!canSkip} className="font-bold text-violet-700 underline disabled:opacity-40" onClick={() => {
            setVectorGuideSkipped(true);
            setGuideStep(3);
        }}>暂时跳过向量记忆</button>
        <p className="mt-1">先完成上方副 API 的选择即可跳过。跳过后继续学习聊天，不开启向量记忆和全自动记忆；之后可在「记忆宫殿」补配。</p>
    </div>;
}
