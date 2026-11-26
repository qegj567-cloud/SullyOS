import React, { useState } from 'react';
import { CaretRight, CheckCircle, Circle, MinusCircle, WarningCircle } from '@phosphor-icons/react';
import {
    WORLDBOOK_SCENE_APP_MANAGED_HINT,
    WORLDBOOK_SCENE_CATEGORIES,
    getWorldbookSceneCategoryState,
    getWorldbookSceneRows,
    isWorldbookSceneRowOn,
    setAllWorldbookScenes,
    setWorldbookScene,
    setWorldbookSceneCategory,
    summarizeWorldbookScenes,
    type WorldbookSceneCategoryId,
    type WorldbookScenes,
} from '../../utils/worldbookScenes';

interface WorldbookSceneEditorProps {
    value: WorldbookScenes;
    onChange: (next: string[] | undefined) => void;
    label?: string;
}

const pillClass = 'px-2 py-1 rounded-full text-[11px] font-bold border active:scale-95 transition-all';

const OnOffButtons: React.FC<{ onAll: () => void; onNone: () => void; scope: string }> = ({ onAll, onNone, scope }) => (
    <div className="flex shrink-0 gap-1">
        <button type="button" aria-label={`${scope}全选开`} onClick={onAll} className={`${pillClass} bg-indigo-50 text-indigo-600 border-indigo-100`}>全选开</button>
        <button type="button" aria-label={`${scope}全选关`} onClick={onNone} className={`${pillClass} bg-white text-slate-500 border-slate-200`}>全选关</button>
    </div>
);

const CategoryIndicator: React.FC<{ state: 'all' | 'some' | 'none' }> = ({ state }) => {
    if (state === 'all') return <CheckCircle size={16} weight="fill" className="shrink-0 text-indigo-500" aria-label="全部开启" />;
    if (state === 'some') return <MinusCircle size={16} weight="fill" className="shrink-0 text-indigo-300" aria-label="部分开启" />;
    return <Circle size={16} className="shrink-0 text-slate-300" aria-label="全部关闭" />;
};

/** 世界书条目的「启用场景」开关面板；单条编辑和「编辑整组」共用。 */
const WorldbookSceneEditor: React.FC<WorldbookSceneEditorProps> = ({ value, onChange, label = '启用场景' }) => {
    const [open, setOpen] = useState(false);
    const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());
    const summary = summarizeWorldbookScenes(value);
    const isOff = summary.kind === 'none';

    const toggleCategory = (id: string) => setOpenCategories(current => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                aria-expanded={open}
                className="w-full flex items-center justify-between gap-3 py-1 text-left"
            >
                <span className="text-xs font-bold text-slate-700 shrink-0">{label}</span>
                <span className={`min-w-0 flex items-center gap-1.5 text-[11px] font-bold ${isOff ? 'text-amber-600' : 'text-slate-400'}`}>
                    {isOff && <WarningCircle size={14} weight="fill" className="shrink-0" />}
                    <span className="truncate">{summary.text}</span>
                    <CaretRight size={12} weight="bold" className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
                </span>
            </button>

            {open && (
                <div className="mt-3 space-y-2 animate-fade-in">
                    <div className="flex justify-end">
                        <OnOffButtons scope="所有场景" onAll={() => onChange(setAllWorldbookScenes(true))} onNone={() => onChange(setAllWorldbookScenes(false))} />
                    </div>
                    {WORLDBOOK_SCENE_CATEGORIES.map(category => {
                        const categoryId = category.id as WorldbookSceneCategoryId;
                        const expanded = openCategories.has(category.id);
                        const rows = getWorldbookSceneRows(categoryId);
                        return (
                            <div key={category.id} className="rounded-xl border border-slate-200 bg-slate-50/60">
                                <div className="flex items-center gap-2 px-3 py-2">
                                    <button
                                        type="button"
                                        onClick={() => toggleCategory(category.id)}
                                        aria-expanded={expanded}
                                        className="min-w-0 flex-1 flex items-center gap-2 text-left"
                                    >
                                        <CaretRight size={12} weight="bold" className={`shrink-0 text-slate-400 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
                                        <CategoryIndicator state={getWorldbookSceneCategoryState(value, categoryId)} />
                                        <span className="truncate text-xs font-bold text-slate-600">{category.label}</span>
                                    </button>
                                    <OnOffButtons
                                        scope={category.label}
                                        onAll={() => onChange(setWorldbookSceneCategory(value, categoryId, true))}
                                        onNone={() => onChange(setWorldbookSceneCategory(value, categoryId, false))}
                                    />
                                </div>
                                {expanded && (
                                    <div className="border-t border-slate-200/70 px-3 py-1">
                                        {rows.map(row => {
                                            if (row.appManaged) {
                                                return (
                                                    <div key={row.key} className="flex items-center justify-between gap-3 py-2">
                                                        <span className="text-xs text-slate-600 shrink-0">{row.label}</span>
                                                        <span className="text-[10px] text-slate-400 text-right">{WORLDBOOK_SCENE_APP_MANAGED_HINT}</span>
                                                    </div>
                                                );
                                            }
                                            const on = isWorldbookSceneRowOn(value, row);
                                            return (
                                                <div key={row.key} className="flex items-center justify-between gap-3 py-1.5">
                                                    <span className="text-xs text-slate-600">{row.label}</span>
                                                    <button
                                                        type="button"
                                                        role="switch"
                                                        aria-checked={on}
                                                        aria-label={row.summaryLabel}
                                                        onClick={() => onChange(setWorldbookScene(value, row.sceneIds, !on))}
                                                        className={`relative inline-flex w-10 h-6 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 focus:outline-none focus:ring-4 focus:ring-indigo-100 ${on ? 'bg-indigo-500' : 'bg-slate-200'}`}
                                                    >
                                                        <span className={`block w-5 h-5 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-200 ${on ? 'translate-x-4' : 'translate-x-0'}`} />
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default WorldbookSceneEditor;
