import BeautyPresetPreview from '../share/BeautyPresetPreview';
import React,{useEffect,useMemo,useState} from 'react';
import {PsycheDecor} from './MessageItem';
import {resolveThinkingChainStyle,type ThinkingChainStyleId,type PsycheAppearance} from '../../utils/psycheAppearance';
import {PSYCHE_STYLE_LIST as STYLE_LIST} from '../../utils/psycheStyleCatalog';
import {validateScopedCss} from '../../utils/scopedCss';
type ThinkingChainSettingsValue={customColors:{bg:string;accent:string;text:string}};
// 心象卡片自定义 CSS 的作用域白名单（.sully-psyche 及其 -card/-title/-preview/-body 子类）
const PSYCHE_SELECTOR_REGEX = /^\.sully-psyche\b/;
const PSYCHE_SCOPE_HINT = '.sully-psyche / .sully-psyche-card / -title / -preview / -body';

const PSYCHE_CSS_EXAMPLE = `.sully-psyche-card {
  background: linear-gradient(135deg, #1a1a2e, #16213e) !important;
  border: 1px solid rgba(233, 69, 96, 0.5) !important;
  border-radius: 16px !important;
}
.sully-psyche-title {
  color: #e94560 !important;
  letter-spacing: 0.6em !important;
}
.sully-psyche-body {
  color: #f0f0f0 !important;
}`;


const SAMPLE_CHAIN = '又叫乖乖猫咪……烦死了。算了也没那么烦，比起这个——午饭吃没吃？她又拿力学所当借口，呵，老一套。算了，先骂一句再问。';

const ColorField: React.FC<{ label: string; value: string; onChange: (v: string) => void }> = ({ label, value, onChange }) => (
    <label className="flex items-center gap-3 text-[12px]">
        <span className="w-12 text-slate-500 shrink-0">{label}</span>
        <input
            type="color"
            value={value.startsWith('#') ? value : '#1f2937'}
            onChange={e => onChange(e.target.value)}
            className="w-8 h-8 rounded cursor-pointer border border-slate-200"
        />
        <input
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            className="flex-1 px-2 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-300"
            placeholder="#rrggbb 或 css 渐变"
        />
    </label>
);

// 折叠态 + 展开态的迷你预览，用 resolveThinkingChainStyle 渲染，避免重复样式逻辑
const StylePreview: React.FC<{ styleId: ThinkingChainStyleId; customColors: ThinkingChainSettingsValue['customColors']; compact?: boolean }> = ({ styleId, customColors, compact }) => {
    const spec = resolveThinkingChainStyle(styleId, customColors);
    return (
        <div className="sully-psyche relative">
        <div
            className="sully-psyche-card relative overflow-hidden"
            style={{
                background: spec.bg,
                border: `${spec.borderWidth || '1px'} solid ${spec.border}`,
                borderRadius: spec.radius,
                boxShadow: spec.cardShadow,
                padding: compact ? '6px 8px' : '10px 12px',
            }}
        >
            {spec.showCorners && (
                <>
                    <span aria-hidden className="absolute top-1 left-1 w-1.5 h-1.5 border-t border-l" style={{ borderColor: spec.accent }} />
                    <span aria-hidden className="absolute top-1 right-1 w-1.5 h-1.5 border-t border-r" style={{ borderColor: spec.accent }} />
                    <span aria-hidden className="absolute bottom-1 left-1 w-1.5 h-1.5 border-b border-l" style={{ borderColor: spec.accent }} />
                    <span aria-hidden className="absolute bottom-1 right-1 w-1.5 h-1.5 border-b border-r" style={{ borderColor: spec.accent }} />
                </>
            )}
            <div className="relative flex items-center gap-1.5">
                <span className="sully-psyche-title" style={{ color: spec.accent, fontSize: compact ? 9 : 11, letterSpacing: '0.3em', fontFamily: spec.fontFamily, fontWeight: 600 }}>
                    {spec.titleZh}
                </span>
                <span style={{ color: spec.text, opacity: 0.6, fontSize: compact ? 6 : 7, letterSpacing: '0.25em' }}>
                    {spec.titleEn}
                </span>
            </div>
            {!compact && (
                <div
                    className={`sully-psyche-preview mt-1 truncate ${spec.italic ? 'italic' : ''}`}
                    style={{ color: spec.text, fontFamily: spec.fontFamily, fontSize: 10.5 }}
                >
                    <span style={{ color: spec.accent }}>{spec.quoteLeft}</span>
                    {SAMPLE_CHAIN.slice(0, 24)}…
                    <span style={{ color: spec.accent }}>{spec.quoteRight}</span>
                    {spec.decoKind === 'termHud' && <span className="animate-pulse" style={{ color: spec.accent, marginLeft: 2 }}>▊</span>}
                </div>
            )}
            {spec.overlay === 'scanlines' && (
                <div
                    aria-hidden
                    className="absolute inset-0 pointer-events-none opacity-[0.13]"
                    style={{ background: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(94, 234, 212, 0.6) 3px, transparent 4px)' }}
                />
            )}
            {spec.overlay === 'dotMatrix' && (
                <div
                    aria-hidden
                    className="absolute inset-0 pointer-events-none opacity-[0.18]"
                    style={{ background: 'radial-gradient(rgba(60, 80, 40, 0.55) 0.5px, transparent 0.6px)', backgroundSize: '3px 3px' }}
                />
            )}
        </div>
        {/* 破格装饰：渲染在卡片外层，跟聊天里的真实结构一致 */}
        <PsycheDecor spec={spec} compact={compact} />
        </div>
    );
};


export default function PsycheAppearanceEditor({appearance,onChange}:{appearance:PsycheAppearance;onChange:(patch:Partial<PsycheAppearance>)=>void}){
const value={...appearance,customColors:{bg:'#1f2937',accent:'#fbbf24',text:'#f1f5f9',...appearance.customColors}};
const [draftCss,setDraftCss]=useState(value.customCss||'');
useEffect(()=>setDraftCss(value.customCss||''),[value.customCss]);
const cssValidation=useMemo(()=>validateScopedCss(draftCss,PSYCHE_SELECTOR_REGEX,PSYCHE_SCOPE_HINT),[draftCss]);
const commitCss=()=>{if(cssValidation.isValid)onChange({customCss:draftCss});};
const previewPreset=useMemo(()=>({format:'sullyos-chat-decoration',version:1,name:'心象预览',parts:{psyche:{...appearance,customCss:cssValidation.isValid?draftCss:appearance.customCss}}}),[appearance.styleId,appearance.customColors,appearance.customCss,draftCss,cssValidation.isValid]);
return <div className="space-y-5">                    {/* 2. 卡片风格 */}
                    <section>
                        <h3 className="text-[10.5px] font-bold text-slate-400 uppercase tracking-wider mb-2.5">卡片风格</h3>
                        <div className="grid grid-cols-2 gap-2.5">
                            {STYLE_LIST.map(item => {
                                const active = value.styleId === item.id;
                                return (
                                    <button
                                        key={item.id}
                                        onClick={() => onChange({ styleId: item.id })}
                                        className={`text-left rounded-xl p-2 border transition-all ${active ? 'border-indigo-400 ring-2 ring-indigo-100' : 'border-slate-200 hover:border-slate-300'}`}
                                    >
                                        <StylePreview styleId={item.id} customColors={value.customColors} compact />
                                        <div className="mt-1.5 flex items-baseline gap-1.5">
                                            <span className="text-[12px] font-bold text-slate-700">{item.name}</span>
                                            <span className="text-[9.5px] text-slate-400">{item.sub}</span>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        {value.styleId === 'custom' && (
                            <div className="mt-3 p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                                <div className="text-[10.5px] font-bold text-slate-500 mb-1">三色调教</div>
                                <ColorField
                                    label="背景"
                                    value={value.customColors.bg}
                                    onChange={bg => onChange({ customColors: { ...value.customColors, bg } })}
                                />
                                <ColorField
                                    label="点缀"
                                    value={value.customColors.accent}
                                    onChange={accent => onChange({ customColors: { ...value.customColors, accent } })}
                                />
                                <ColorField
                                    label="正文"
                                    value={value.customColors.text}
                                    onChange={text => onChange({ customColors: { ...value.customColors, text } })}
                                />
                                <div className="text-[9.5px] text-slate-400 leading-relaxed mt-1.5">
                                    背景支持 CSS 渐变（例：linear-gradient(135deg, #1a1a2e, #16213e)）。
                                </div>
                            </div>
                        )}

                        {/* 实时大预览（自定义 CSS 合法时同步作用到预览上） */}

                        <div className="mt-3 px-1">
                            <div className="text-[9.5px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">实时预览</div>
                            <BeautyPresetPreview data={previewPreset}/>
                        </div>
                    </section>

                    {/* 2.5 CSS 美化 —— 叠加在任意风格之上，机制同气泡工坊 */}
                    <section>
                        <h3 className="text-[10.5px] font-bold text-slate-400 uppercase tracking-wider mb-2">CSS 美化（进阶）</h3>
                        <p className="text-[10.5px] text-slate-400 mb-2 leading-relaxed">
                            在上面选好的风格基础上，再用 CSS 精修心象卡片。可用类名：
                            <code className="text-indigo-400">.sully-psyche-card</code>（卡片）、
                            <code className="text-indigo-400">.sully-psyche-title</code>（标题）、
                            <code className="text-indigo-400">.sully-psyche-preview</code>（折叠首句）、
                            <code className="text-indigo-400">.sully-psyche-body</code>（展开正文）。
                            想覆盖风格自带的颜色时记得加 <code className="text-indigo-400">!important</code>。
                        </p>
                        <textarea
                            value={draftCss}
                            onChange={e => setDraftCss(e.target.value)}
                            onBlur={commitCss}
                            spellCheck={false}
                            placeholder={'.sully-psyche-card {\n  border-radius: 16px !important;\n}'}
                            className={`w-full h-32 bg-slate-50 rounded-xl p-3 text-[11px] font-mono text-slate-800 placeholder:text-slate-400 resize-none border focus:outline-none ${cssValidation.isValid ? 'border-slate-200 focus:border-indigo-300' : 'border-red-300 focus:border-red-400'}`}
                        />
                        {!cssValidation.isValid && (
                            <div className="mt-1 space-y-0.5">
                                {cssValidation.errors.slice(0, 3).map((err, i) => (
                                    <div key={i} className="text-[9.5px] text-red-400 leading-relaxed">{err}</div>
                                ))}
                                <div className="text-[9px] text-slate-400">有错误时不会保存，修好后自动生效。</div>
                            </div>
                        )}
                        <div className="mt-1.5 flex items-center gap-2">
                            <button
                                onClick={() => setDraftCss(PSYCHE_CSS_EXAMPLE)}
                                className="text-[10px] px-2 py-1 rounded-lg bg-slate-100 text-slate-500 active:scale-95 transition"
                            >
                                填入示例
                            </button>
                            {value.customCss && (
                                <button
                                    onClick={() => { setDraftCss(''); onChange({ customCss: '' }); }}
                                    className="text-[10px] px-2 py-1 rounded-lg bg-slate-100 text-slate-500 active:scale-95 transition"
                                >
                                    清空还原
                                </button>
                            )}
                            <span className="text-[9px] text-slate-300 ml-auto">留空 = 不做额外美化</span>
                        </div>
                    </section>


</div>;
}
