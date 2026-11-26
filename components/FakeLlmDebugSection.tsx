import React, { useState } from 'react';
import { ArrowCounterClockwise, ArrowsClockwise, Robot } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { fetchFakeLlmScenarios, isOnFakeLlm, readFakeLlmState, restoreFromFakeLlm, switchToFakeLlm } from '../utils/fakeLlmSwitch';

const buttonClass = (disabled: boolean) => `flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[11px] font-bold transition-colors ${
    disabled ? 'bg-white/5 text-white/25' : 'bg-white/10 text-white/75 active:scale-95'
}`;

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** 调试面板里的「假模型」区。换 API 全部经 utils/fakeLlmSwitch.ts，见 docs/fake-llm.md。 */
const FakeLlmDebugSection: React.FC = () => {
    const { apiConfig, updateApiConfig, characters } = useOS();
    const [state, setState] = useState(() => readFakeLlmState());
    const [url, setUrl] = useState(state.url);
    const [scenarios, setScenarios] = useState<string[]>([]);
    const [scenario, setScenario] = useState(isOnFakeLlm(apiConfig) ? apiConfig.model : '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const onFake = isOnFakeLlm(apiConfig);
    const backup = state.backup?.fields;
    // 角色独立 API 优先于全局（utils/characterApi.ts resolveDialogueApi），这些角色的私聊不会打到假模型。
    const ownApi = characters.filter(c => c.dialogueApi);

    const run = (action: () => void) => {
        setError('');
        try { action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        setState(readFakeLlmState());
    };

    const loadScenarios = async () => {
        setBusy(true);
        setError('');
        try {
            const ids = await fetchFakeLlmScenarios(url);
            setScenarios(ids);
            if (!ids.includes(scenario)) setScenario(ids[0] ?? '');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="py-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-bold text-white/80">
                <Robot size={14} weight="bold" />
                假模型
                <span className="ml-auto truncate font-mono text-[10px] font-normal text-white/40">
                    {onFake ? apiConfig.model : `${hostOf(apiConfig.baseUrl)} · ${apiConfig.model}`}
                </span>
            </div>
            <input
                type="url"
                value={url}
                onChange={event => setUrl(event.target.value)}
                placeholder="http://127.0.0.1:8791/v1"
                className="mb-2 h-8 w-full rounded-full border border-white/15 bg-white/5 px-3 text-[11px] text-white placeholder:text-white/30 select-text"
            />
            <div className="mb-2 flex gap-2">
                <button type="button" className={buttonClass(busy || !url)} disabled={busy || !url} onClick={() => { void loadScenarios(); }}>
                    <ArrowsClockwise size={13} weight="bold" />
                    {busy ? '拉取中…' : '拉场景'}
                </button>
                {scenarios.length > 0 && (
                    <select
                        value={scenario}
                        onChange={event => setScenario(event.target.value)}
                        className="h-8 min-w-0 flex-[2] rounded-full border border-white/15 bg-zinc-900 px-2 text-[11px] text-white [color-scheme:dark]"
                    >
                        {scenarios.map(id => <option key={id} value={id}>{id}</option>)}
                    </select>
                )}
            </div>
            <div className="flex gap-2">
                <button
                    type="button"
                    className={buttonClass(!scenario || !url)}
                    disabled={!scenario || !url}
                    onClick={() => run(() => switchToFakeLlm(apiConfig, url, scenario, updateApiConfig))}
                >
                    换成 {scenario || '假模型'}
                </button>
                {backup && (
                    <button type="button" className={buttonClass(false)} onClick={() => run(() => { restoreFromFakeLlm(updateApiConfig); })}>
                        <ArrowCounterClockwise size={13} weight="bold" />
                        换回 {hostOf(backup.baseUrl)}
                    </button>
                )}
            </div>
            {ownApi.length > 0 && (
                <div className="mt-2 text-[11px] leading-relaxed text-amber-200/70">
                    这些角色用独立 API，不走假模型：{ownApi.slice(0, 3).map(c => c.name).join('、')}{ownApi.length > 3 ? ` 等 ${ownApi.length} 个` : ''}
                </div>
            )}
            {error && <div className="mt-2 text-[11px] leading-relaxed text-red-300/80">{error}</div>}
        </div>
    );
};

export default FakeLlmDebugSection;
