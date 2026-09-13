import React, { useEffect, useRef, useState } from 'react';
import { CaretDown, CaretUp, Cpu, DotsSix } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { endSARModuleRuntime } from '../../utils/vrWorld/sarModuleRuntime';
import { trackSARModuleEnd } from '../../utils/sarAnalytics';
import './sar-module-monitor.css';

/** 挂在手机外壳，切换聊天、见面或彼方都能看见同一份实时运行状态。 */
export function SARModuleMonitor() {
    const { characters, userProfile, updateCharacter, updateUserProfile, addToast } = useOS();
    const entries = [
        ...(userProfile.vrState?.sarModule ? [{ id: 'user', name: `${userProfile.name || '我'}（我）`, runtime: userProfile.vrState.sarModule }] : []),
        ...characters.flatMap(char => char.vrState?.sarModule ? [{ id: char.id, name: char.name, runtime: char.vrState.sarModule }] : []),
    ].filter(entry => entry.runtime.phase === 'active' && entry.runtime.remainingTurns > 0);
    const runs = entries.map(entry => entry.runtime.runId).sort().join('|');
    const previousRuns = useRef(new Set<string>());
    const [expanded, setExpanded] = useState(true);
    const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
    const layerRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLElement>(null);
    const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean; scale: number } | null>(null);
    const ignoreClick = useRef(false);

    useEffect(() => {
        const next = new Set(entries.map(entry => entry.runtime.runId));
        if ([...next].some(run => !previousRuns.current.has(run))) setExpanded(true);
        previousRuns.current = next;
    }, [runs]);

    const clamp = (x: number, y: number) => {
        const layer = layerRef.current, panel = panelRef.current;
        if (!layer || !panel) return { x, y };
        return {
            x: Math.max(8, Math.min(x, layer.clientWidth - panel.offsetWidth - 8)),
            y: Math.max(52, Math.min(y, layer.clientHeight - panel.offsetHeight - 12)),
        };
    };
    useEffect(() => {
        const layer = layerRef.current, panel = panelRef.current;
        if (!layer || !panel) return;
        const resize = new ResizeObserver(() => setPosition(old => {
            if (!old) return old;
            const next = clamp(old.x, old.y);
            return next.x === old.x && next.y === old.y ? old : next;
        }));
        resize.observe(layer); resize.observe(panel);
        return () => resize.disconnect();
    }, [entries.length > 0]);

    if (!entries.length) return null;

    const end = (entry: typeof entries[number]) => {
        const runtime = entry.runtime;
        if (runtime.phase !== 'active') return;
        if (runtime.target === 'user') {
            updateUserProfile(previous => ({
                vrState: { ...(previous.vrState || { enabled: false }), sarModule: previous.vrState?.sarModule?.runId === runtime.runId
                    ? endSARModuleRuntime(previous.vrState.sarModule) : previous.vrState?.sarModule },
            }));
        } else {
            updateCharacter(entry.id, previous => ({
                vrState: { ...(previous.vrState || { enabled: false, intervalMinutes: 120 }), sarModule: previous.vrState?.sarModule?.runId === runtime.runId
                    ? endSARModuleRuntime(previous.vrState.sarModule) : previous.vrState?.sarModule },
            }));
        }
        trackSARModuleEnd(runtime.target);
        addToast('模块已提前结束，下次回复会收到解除提示', 'success');
    };

    return <div ref={layerRef} className="sar-module-monitor-layer">
        <section ref={panelRef} className="sar-module-monitor" aria-label="当前模块" data-expanded={expanded}
            style={position ? { left: position.x, top: position.y, right: 'auto' } : undefined}>
            <button type="button" className="sar-module-monitor-handle" aria-expanded={expanded}
                aria-label={expanded ? '收起模块悬浮窗' : '展开模块悬浮窗'}
                onPointerDown={event => {
                    if (event.button !== 0 || !panelRef.current || !layerRef.current) return;
                    const panel = panelRef.current, layer = layerRef.current;
                    drag.current = { x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop, moved: false,
                        scale: layer.getBoundingClientRect().width / layer.clientWidth || 1 };
                    ignoreClick.current = false;
                    event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={event => {
                    const start = drag.current;
                    if (!start) return;
                    const dx = (event.clientX - start.x) / start.scale, dy = (event.clientY - start.y) / start.scale;
                    if (Math.abs(dx) + Math.abs(dy) > 5) start.moved = true;
                    if (start.moved) setPosition(clamp(start.left + dx, start.top + dy));
                }}
                onPointerUp={event => {
                    ignoreClick.current = !!drag.current?.moved;
                    drag.current = null;
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => { drag.current = null; ignoreClick.current = true; }}
                onClick={() => {
                    if (ignoreClick.current) { ignoreClick.current = false; return; }
                    setExpanded(value => !value);
                }}>
                <Cpu size={17} /><strong>模块</strong><span className="sar-module-monitor-count">{entries.length}</span>
                <span className="sar-module-monitor-owners" title={entries.map(entry => entry.name).join('、')}>
                    {entries.length === 1 ? entries[0].name : entries[0].name + '等 ' + entries.length + ' 人'}
                </span><DotsSix size={14} aria-hidden="true"/>
                {expanded ? <CaretUp size={13}/> : <CaretDown size={13}/>}
            </button>
            {expanded && <div className="sar-module-monitor-body">
                <ul>{entries.map(entry => <li key={entry.runtime.runId} data-sar-target={entry.runtime.target}>
                    <div className="sar-module-monitor-person"><strong>{entry.name}</strong>
                        <span>{entry.runtime.phase === 'active' ? `剩 ${entry.runtime.remainingTurns} 轮` : '已解除'}</span></div>
                    <div className="sar-module-monitor-source">装载者：{entry.runtime.source === 'user'
                        ? (userProfile.name || '我')
                        : (characters.find(char => char.id === entry.runtime.sourceCharacterId)?.name || entry.runtime.sourceCharacterName || '角色')}</div>
                    <div className="sar-module-monitor-detail"><span>{entry.runtime.moduleTitle}</span>
                        {entry.runtime.phase === 'active'
                            ? <button type="button" onClick={() => end(entry)} aria-label={`提前结束${entry.name}的模块`}>提前结束</button>
                            : <small>解除提醒剩 {entry.runtime.afterglowTurns} 轮</small>}</div>
                </li>)}</ul>
                <p>成功回复一次算一轮。提前结束后，下次回复就会收到解除提示；正在生成的这一条可能仍受影响。</p>
            </div>}
        </section>
    </div>;
}
