import React, { useEffect, useMemo, useState } from 'react';
import { SlidersHorizontal } from '@phosphor-icons/react';
import {
    DEFAULT_PROMPT_CONTROL_CONFIG,
    PROMPT_CONTROL_MODULES,
    readPromptControlConfig,
    subscribePromptControlConfig,
    writePromptControlConfig,
    type PromptControlConfig,
    type PromptControlModuleKey,
} from '../../utils/promptControl';

interface PromptControlSettingsProps {
    onConfigChange?: (config: PromptControlConfig) => void;
}

const PromptControlSettings: React.FC<PromptControlSettingsProps> = ({ onConfigChange }) => {
    const [config, setConfig] = useState<PromptControlConfig>(() => readPromptControlConfig());
    const [open, setOpen] = useState(false);

    useEffect(() => subscribePromptControlConfig(setConfig), []);

    const disabledCount = useMemo(
        () => PROMPT_CONTROL_MODULES.filter(module => !config.modules[module.key]).length,
        [config],
    );

    const persistConfig = (nextConfig: PromptControlConfig) => {
        const next = writePromptControlConfig(nextConfig);
        setConfig(next);
        onConfigChange?.(next);
    };

    const updateModule = (key: PromptControlModuleKey, enabled: boolean) => {
        persistConfig({
            ...config,
            modules: { ...config.modules, [key]: enabled },
        });
    };

    const reset = () => {
        persistConfig(DEFAULT_PROMPT_CONTROL_CONFIG);
    };

    return (
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
            <div className={`flex items-center justify-between gap-2 ${open ? 'mb-4' : ''}`}>
                <button
                    type="button"
                    onClick={() => setOpen(value => !value)}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left"
                >
                    <div className="p-2 bg-indigo-100/70 rounded-xl text-indigo-600">
                        <SlidersHorizontal size={17} weight="bold" />
                    </div>
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">Prompt 注入控制</h2>
                    <span className={`text-[10px] font-semibold shrink-0 ${disabledCount ? 'text-amber-500' : 'text-emerald-500'}`}>
                        {disabledCount ? `已关闭 ${disabledCount} 项` : '全部开启'}
                    </span>
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={`w-3 h-3 text-slate-300 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                </button>
                {disabledCount > 0 && (
                    <button
                        type="button"
                        onClick={reset}
                        className="text-[10px] font-bold text-indigo-600 bg-indigo-50 px-2.5 py-1.5 rounded-full shrink-0"
                    >
                        恢复默认
                    </button>
                )}
            </div>

            {open && (
                <div className="space-y-2">
                    <p className="text-[10px] text-slate-400 leading-relaxed">
                        默认不改变原生行为。关闭某项后，主聊天和主动消息本轮不注入它；API 调用记录会保留本轮开关与实际注入状态。
                    </p>
                    {PROMPT_CONTROL_MODULES.map(module => {
                        const enabled = config.modules[module.key] !== false;
                        return (
                            <div key={module.key} className="flex items-center justify-between gap-3 bg-slate-50/80 border border-slate-100 rounded-xl px-3 py-2.5">
                                <div className="min-w-0">
                                    <div className="text-xs font-semibold text-slate-700">{module.label}</div>
                                    <div className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">{module.detail}</div>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                                    <input
                                        type="checkbox"
                                        checked={enabled}
                                        onChange={event => updateModule(module.key, event.target.checked)}
                                        className="sr-only peer"
                                    />
                                    <div className="w-10 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-500" />
                                </label>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
};

export default PromptControlSettings;
