import React, { useEffect, useState } from 'react';
import type {ThinkingChainStyleId} from '../../utils/psycheAppearance';

interface ThinkingChainSettingsValue {
    enabled: boolean;
    styleId: ThinkingChainStyleId;
    customColors: { bg: string; accent: string; text: string };
    customPrompt: string;
    /** 叠加在任意风格之上的自定义 CSS，选择器限定 .sully-psyche 开头 */
    customCss: string;
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    value: ThinkingChainSettingsValue;
    onChange: (next: Partial<ThinkingChainSettingsValue>) => void;
}

const ThinkingChainSettingsModal: React.FC<Props> = ({ isOpen, onClose, value, onChange }) => {
    const [draftPrompt, setDraftPrompt] = useState(value.customPrompt || '');
    useEffect(() => { if (isOpen) setDraftPrompt(value.customPrompt || ''); }, [isOpen, value.customPrompt]);
    if (!isOpen) return null;

    const commitPrompt = () => onChange({ customPrompt: draftPrompt });

    return (
        <div
            className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-[1px]"
            style={{ paddingBottom: 'var(--safe-bottom)' }}
            onClick={onClose}
        >
            <div
                className="w-full sm:max-w-md bg-white text-slate-800 rounded-t-3xl sm:rounded-3xl max-h-[85vh] overflow-y-auto no-scrollbar shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                <div className="sticky top-0 z-10 bg-white px-5 pt-5 pb-3 border-b border-slate-100">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-base font-bold text-slate-800">心象 · 设置</h2>
                            <p className="text-[11px] text-slate-400 mt-0.5">显示与追加提示词；卡片风格在「个性装扮 → 心象」调整</p>
                        </div>
                        <button
                            onClick={() => { commitPrompt(); onClose(); }}
                            className="text-[12px] font-bold text-indigo-500 active:scale-95 transition"
                        >
                            完成
                        </button>
                    </div>
                </div>

                <div className="p-5 space-y-6">
                    {/* 0. 这是什么 / 看不见怎么办 */}
                    <section className="rounded-2xl bg-amber-50/70 border border-amber-200/70 px-3.5 py-3 text-[11px] leading-[1.7] text-slate-600">
                        <div className="font-bold text-amber-700 mb-1 text-[11.5px]">⚠ 先看这里：「心象」到底是什么</div>
                        <p>
                            「心象」展示模型或渠道返回的思考文字。有些模型只提供摘要，不代表完整的内部思考，也不保证每轮都有。
                        </p>
                        <p className="mt-2">
                            这些文字可能是分析、规划或自言自语，语气不一定像角色台词。如果觉得影响沉浸感，可以关闭显示。
                        </p>
                        <p className="mt-2">
                            被识别为心象的文字会与聊天正文分开保存，不作为普通聊天记录传给下一轮。角色实际说出口的内容仍以聊天气泡为准。
                        </p>
                        <p className="mt-2">
                            关闭「心象」会停止显示新回复的心象卡片，但不等于关闭模型本身的推理，也不保证减少思考用量。Gemini 等模型可能仍会思考。
                        </p>
                        <div className="mt-2.5 pt-2.5 border-t border-amber-200/60">
                            <div className="font-bold text-amber-700 mb-1 text-[11.5px]">开了但没看到「心象」卡片？</div>
                            <ul className="list-disc pl-4 space-y-0.5">
                                <li>模型或渠道没有提供可显示的思考文字，或这一轮没有返回摘要。</li>
                                <li>摘要可能比实际推理短；没有卡片也不代表模型没有思考。</li>
                                <li>同一模型在别的平台有、这里没有时，可向渠道确认是否分别返回了思考和正文。</li>
                            </ul>
                        </div>
                        <div className="mt-2.5 pt-2.5 border-t border-amber-200/60">
                            <div className="font-bold text-amber-700 mb-1 text-[11.5px]">思考链一直是英文怎么办？</div>
                            <p>
                                思考摘要的语言由模型和渠道决定，仅凭英文无法判断是哪一方出了问题。可以在下面的追加提示词里写「请用中文概括思考」，但不保证模型会遵循。
                            </p>
                        </div>
                        <div className="mt-2.5 pt-2.5 border-t border-amber-200/60">
                            <div className="font-bold text-amber-700 mb-1 text-[11.5px]">思考文字出现在聊天气泡里？</div>
                            <p>先更新页面，再试一次新回复。如果仍然出现，请反馈完整模型名、是否流式，以及渠道是否把思考混在正文里。无需清空聊天记录；关闭心象也无法可靠隐藏没有标记的正文。</p>
                        </div>
                    </section>

                    {/* 1. 总开关 */}
                    <section>
                        <div className="flex items-center justify-between cursor-pointer" onClick={() => onChange({ enabled: !value.enabled })}>
                            <div>
                                <div className="text-[13px] font-bold text-slate-700">显示思考过程</div>
                                <div className="text-[10.5px] text-slate-400 mt-0.5">关闭后角色回复不再带「心象」卡片，已存的旧消息保留。</div>
                            </div>
                            <div className={`shrink-0 ml-3 w-10 h-6 rounded-full p-1 transition-colors flex items-center ${value.enabled ? 'bg-indigo-500' : 'bg-slate-200'}`}>
                                <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${value.enabled ? 'translate-x-4' : ''}`} />
                            </div>
                        </div>
                    </section>

                    {/* 3. 追加提示词 */}
                    <section>
                        <h3 className="text-[10.5px] font-bold text-slate-400 uppercase tracking-wider mb-2">追加提示词</h3>
                        <p className="text-[10.5px] text-slate-400 mb-2 leading-relaxed">
                            原生提示词（让模型用角色第一人称、中文意识流思考）保持不变；这里写的内容**追加在最后**作为「用户对内心独白的额外要求」。
                        </p>
                        <textarea
                            value={draftPrompt}
                            onChange={e => setDraftPrompt(e.target.value)}
                            onBlur={commitPrompt}
                            placeholder="比如：思考时偶尔切到日语 / 多写一些感官细节 / 想到用户时用昵称…"
                            className="w-full h-28 bg-slate-50 text-slate-800 placeholder:text-slate-400 rounded-xl p-3 text-[12px] resize-none border border-slate-200 focus:outline-none focus:border-indigo-300"
                        />
                        <div className="text-[9.5px] text-slate-400 mt-1">留空 = 仅使用原生提示词。</div>
                    </section>
                </div>
            </div>
        </div>
    );
};

export default ThinkingChainSettingsModal;
export type { ThinkingChainSettingsValue };
