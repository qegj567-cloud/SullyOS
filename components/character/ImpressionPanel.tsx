import React from 'react';
import { UserImpression } from '../../types';
import { normalizeUserImpression } from '../../utils/impression';

const TagGroup: React.FC<{ title: string; tags: string[]; color: string; onRemove?: (t: string) => void }> = ({ title, tags, color, onRemove }) => (
    <div className="mb-4">
        <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${color}`}></span> {title}
        </h4>
        <div className="flex flex-wrap gap-2">
            {tags.length > 0 ? tags.map((tag, index) => (
                <span key={`${tag}-${index}`} className="inline-flex items-center px-2.5 py-1 rounded-lg bg-white border border-slate-100 text-xs text-slate-600 shadow-sm">
                    {tag}
                    {onRemove && <button onClick={() => onRemove(tag)} className="ml-1.5 text-slate-300 hover:text-red-400">x</button>}
                </span>
            )) : <span className="text-xs text-slate-300 italic">暂无数据</span>}
        </div>
    </div>
);

const AnalysisBlock: React.FC<{ title: string; content: string; icon: React.ReactNode }> = ({ title, content, icon }) => (
    <div className="bg-white/60 p-4 rounded-2xl border border-white/60 shadow-sm relative overflow-hidden group">
        <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:opacity-20 transition-opacity transform group-hover:scale-110 duration-500 text-slate-800">
            {icon}
        </div>
        <h4 className="text-xs font-bold text-slate-500 mb-2 flex items-center gap-2 relative z-10">
            {title}
        </h4>
        <p className="text-sm text-slate-700 leading-relaxed text-justify relative z-10 whitespace-pre-wrap">
            {content || '需要更多数据进行分析。'}
        </p>
    </div>
);

const MBTIBar: React.FC<{ labelLeft: string; labelRight: string; value: number; color: string }> = ({ labelLeft, labelRight, value, color }) => (
    <div className="flex items-center gap-2 text-[10px] font-bold text-slate-500 w-full">
        <span className={`w-4 text-center ${value < 50 ? color : 'opacity-50'}`}>{labelLeft}</span>
        <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden relative">
            <div className={`absolute top-0 bottom-0 w-1.5 rounded-full ${color} transition-all duration-1000`} style={{ left: `${value}%`, transform: 'translateX(-50%)' }}></div>
        </div>
        <span className={`w-4 text-center ${value > 50 ? color : 'opacity-50'}`}>{labelRight}</span>
    </div>
);

interface ImpressionPanelProps {
    impression: UserImpression | undefined;
    isGenerating: boolean;
    onGenerate: (type: 'initial' | 'update') => void;
    onUpdateImpression: (newImp: UserImpression) => void;
    onDelete?: () => void;
}

const ImpressionPanel: React.FC<ImpressionPanelProps> = ({ impression, isGenerating, onGenerate, onUpdateImpression, onDelete }) => {
    const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
    const safeImpression = React.useMemo(() => normalizeUserImpression(impression), [impression]);

    const removeTag = (path: string[], tag: string) => {
        if (!safeImpression) return;
        const nextImpression = JSON.parse(JSON.stringify(safeImpression)) as UserImpression & Record<string, any>;
        let target: Record<string, any> = nextImpression;
        for (let index = 0; index < path.length - 1; index += 1) {
            target = target[path[index]];
        }
        const lastKey = path[path.length - 1];
        if (Array.isArray(target[lastKey])) {
            target[lastKey] = target[lastKey].filter((item: string) => item !== tag);
            onUpdateImpression(nextImpression);
        }
    };

    if (!safeImpression && !isGenerating) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-center p-8 space-y-6">
                <div className="w-24 h-24 bg-indigo-50 rounded-full flex items-center justify-center text-indigo-200">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor" className="w-12 h-12">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917-3.286-.672ZM12 2.25V4.5m5.834.166-1.591 1.591M20.25 10.5H18M7.757 14.743l-1.59 1.59M6 10.5H3.75m4.007-4.243-1.59-1.59" />
                    </svg>
                </div>
                <div>
                    <h3 className="text-lg font-bold text-slate-700">尚未生成印象档案</h3>
                    <p className="text-sm text-slate-400 mt-2 max-w-xs mx-auto">让 AI 回顾你们的长期记忆和近期互动，生成一份角色视角下的私密印象档案。</p>
                </div>
                <button
                    onClick={() => onGenerate('initial')}
                    className="px-8 py-3 bg-indigo-600 text-white rounded-full font-bold shadow-lg shadow-indigo-200 hover:bg-indigo-700 active:scale-95 transition-all"
                >
                    开始深度分析
                </button>
            </div>
        );
    }

    if (isGenerating) {
        return (
            <div className="flex flex-col items-center justify-center h-full space-y-4">
                <div className="relative w-20 h-20">
                    <div className="absolute inset-0 border-4 border-slate-100 rounded-full"></div>
                    <div className="absolute inset-0 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                </div>
                <p className="text-sm text-slate-500 font-medium animate-pulse">正在整理你们的长期互动印象...</p>
                <p className="text-xs text-slate-400">构建思维侧写 / 梳理情绪轨迹</p>
            </div>
        );
    }

    if (!safeImpression) return null;

    return (
        <div className="space-y-6 animate-fade-in pb-10">
            <div className="flex justify-between items-center bg-white p-4 rounded-2xl border border-slate-100 shadow-sm">
                <div>
                    <div className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">版本 {safeImpression.version.toFixed(1)}</div>
                    <div className="text-xs text-slate-600">上次更新: {new Date(safeImpression.lastUpdated || Date.now()).toLocaleDateString()}</div>
                </div>
                <div className="flex gap-2">
                    {onDelete && <button onClick={() => setShowDeleteConfirm(true)} className="px-3 py-1.5 text-xs font-bold text-red-400 bg-red-50 rounded-lg hover:bg-red-100">删除</button>}
                    <button onClick={() => onGenerate('initial')} className="px-3 py-1.5 text-xs font-bold text-slate-400 bg-slate-50 rounded-lg hover:bg-slate-100">重置</button>
                    <button onClick={() => onGenerate('update')} className="px-4 py-1.5 text-xs font-bold text-white bg-indigo-500 rounded-lg shadow-md shadow-indigo-200 hover:bg-indigo-600 active:scale-95 transition-all">追加/更新</button>
                </div>
            </div>

            <div className="relative bg-gradient-to-br from-indigo-500 to-purple-600 rounded-3xl p-6 text-white shadow-lg overflow-hidden">
                <div className="absolute top-0 right-0 -mt-4 -mr-4 w-24 h-24 bg-white/10 rounded-full blur-2xl"></div>
                <h3 className="text-xs font-bold text-white/60 uppercase tracking-widest mb-3">核心印象</h3>
                <p className="text-lg font-light leading-relaxed italic opacity-95">"{safeImpression.personality_core.summary}"</p>

                <div className="mt-6 pt-4 border-t border-white/20 grid grid-cols-2 gap-4">
                    <div>
                        <div className="text-[10px] text-white/60 uppercase mb-1">互动模式</div>
                        <div className="text-sm font-medium">{safeImpression.personality_core.interaction_style}</div>
                    </div>
                    <div>
                        <div className="text-[10px] text-white/60 uppercase mb-1">语气感知</div>
                        <div className="text-sm font-medium">{safeImpression.behavior_profile.tone_style}</div>
                    </div>
                </div>
            </div>

            {safeImpression.mbti_analysis && (
                <div className="bg-white rounded-3xl p-6 border border-slate-100 shadow-sm relative overflow-hidden">
                    <div className="absolute -right-6 -top-6 w-24 h-24 bg-teal-50 rounded-full blur-xl pointer-events-none"></div>
                    <div className="flex justify-between items-start mb-4 relative z-10">
                        <h3 className="text-sm font-bold text-slate-700 flex items-center gap-2">
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f9e9.png" alt="" className="w-5 h-5" /> MBTI 侧写
                        </h3>
                        <span className="text-2xl font-black text-slate-800 tracking-tighter bg-teal-100/50 px-2 rounded-lg text-teal-700">
                            {safeImpression.mbti_analysis.type}
                        </span>
                    </div>

                    <div className="space-y-3 mb-5">
                        <MBTIBar labelLeft="E" labelRight="I" value={safeImpression.mbti_analysis.dimensions.e_i} color="text-teal-500 bg-teal-500" />
                        <MBTIBar labelLeft="S" labelRight="N" value={safeImpression.mbti_analysis.dimensions.s_n} color="text-teal-500 bg-teal-500" />
                        <MBTIBar labelLeft="T" labelRight="F" value={safeImpression.mbti_analysis.dimensions.t_f} color="text-teal-500 bg-teal-500" />
                        <MBTIBar labelLeft="J" labelRight="P" value={safeImpression.mbti_analysis.dimensions.j_p} color="text-teal-500 bg-teal-500" />
                    </div>

                    <div className="bg-slate-50 p-3 rounded-xl">
                        <p className="text-xs text-slate-600 leading-relaxed italic">"{safeImpression.mbti_analysis.reasoning}"</p>
                    </div>
                </div>
            )}

            <div className="bg-white rounded-3xl p-6 border border-slate-100 shadow-sm">
                <h3 className="text-sm font-bold text-slate-700 mb-6 flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-indigo-500" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4a1 1 0 001.414 0l4-4a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    价值地图
                </h3>

                <TagGroup title="观察到的特质" tags={safeImpression.personality_core.observed_traits} color="bg-blue-400" onRemove={(tag) => removeTag(['personality_core', 'observed_traits'], tag)} />
                <TagGroup title="TA 喜欢的" tags={safeImpression.value_map.likes} color="bg-pink-400" onRemove={(tag) => removeTag(['value_map', 'likes'], tag)} />
                <TagGroup title="TA 讨厌的" tags={safeImpression.value_map.dislikes} color="bg-slate-400" onRemove={(tag) => removeTag(['value_map', 'dislikes'], tag)} />

                <div className="mt-4 p-4 bg-slate-50 rounded-xl">
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">核心价值观推测</div>
                    <p className="text-sm text-slate-600">{safeImpression.value_map.core_values}</p>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-4">
                <AnalysisBlock
                    title="情绪状态总结"
                    content={safeImpression.behavior_profile.emotion_summary}
                    icon={<svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
                />
                <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
                    <div className="grid grid-cols-2 gap-6">
                        <div>
                            <div className="text-[10px] font-bold text-green-500 uppercase tracking-widest mb-2">正向触发器</div>
                            <ul className="list-disc list-inside text-xs text-slate-600 space-y-1">
                                {safeImpression.emotion_schema.triggers.positive.map((tag, index) => <li key={`${tag}-${index}`}>{tag}</li>)}
                            </ul>
                        </div>
                        <div>
                            <div className="text-[10px] font-bold text-red-400 uppercase tracking-widest mb-2">压力/雷区</div>
                            <ul className="list-disc list-inside text-xs text-slate-600 space-y-1">
                                {safeImpression.emotion_schema.triggers.negative.map((tag, index) => <li key={`${tag}-${index}`}>{tag}</li>)}
                            </ul>
                        </div>
                    </div>
                </div>
                <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
                    <div className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest mb-2">舒适区</div>
                    <p className="text-sm text-slate-600">{safeImpression.emotion_schema.comfort_zone}</p>
                </div>
            </div>

            {safeImpression.observed_changes && safeImpression.observed_changes.length > 0 && (
                <div className="bg-amber-50 p-4 rounded-2xl border border-amber-100">
                    <h4 className="text-[10px] font-bold text-amber-500 uppercase tracking-widest mb-2">最近观察到的变化</h4>
                    <ul className="space-y-2">
                        {safeImpression.observed_changes.map((change, index) => (
                            <li key={`${change}-${index}`} className="text-xs text-amber-900 flex items-start gap-2">
                                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"></span>
                                <span className="opacity-90">{change}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {showDeleteConfirm && (
                <div className="fixed inset-0 z-[999] bg-black/40 backdrop-blur-sm flex items-center justify-center px-6">
                    <div className="w-full max-w-sm bg-white rounded-3xl p-5 shadow-2xl">
                        <div className="text-base font-bold text-slate-700">删除印象档案？</div>
                        <p className="mt-2 text-sm text-slate-500 leading-relaxed">这份深度分析报告将被彻底删除，删除后可以重新生成。</p>
                        <div className="mt-5 flex gap-3">
                            <button onClick={() => setShowDeleteConfirm(false)} className="flex-1 py-2.5 rounded-2xl bg-slate-100 text-slate-600 font-bold text-sm">取消</button>
                            <button onClick={() => { setShowDeleteConfirm(false); onDelete?.(); }} className="flex-1 py-2.5 rounded-2xl bg-red-500 text-white font-bold text-sm shadow-lg shadow-red-200">删除</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ImpressionPanel;
