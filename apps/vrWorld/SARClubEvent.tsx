import React, { useMemo, useState } from 'react';
import { CaretRight, X } from '@phosphor-icons/react';
import {
    getSARDialogueNode,
    type SARDialogueChoice,
    type SARDialogueSpeaker,
    type SARIntroReaction,
    type SARNpcPreference,
} from '../../utils/vrWorld/sarClub';

const SAFE_TOP = 'var(--chrome-top)';
const SAFE_BOTTOM = 'var(--safe-bottom)';

export const SARUpdateModal: React.FC<{
    step: 'update' | 'preference';
    onContinue: () => void;
    onChoose: (preference: SARNpcPreference) => void;
}> = ({ step, onContinue, onChoose }) => (
    <div className="fixed inset-0 z-[360] flex items-center justify-center px-6 bg-black/70 backdrop-blur-md" role="dialog" aria-modal="true" aria-labelledby="sar-update-title">
        <div className="relative w-full max-w-[340px] overflow-hidden rounded-[26px]" style={{ background: 'linear-gradient(165deg,#211d38 0%,#11101f 58%,#0a0a13 100%)', border: '1px solid rgba(203,198,255,.22)', boxShadow: '0 24px 80px rgba(0,0,0,.72), inset 0 1px 0 rgba(255,255,255,.07)' }}>
            <div className="pointer-events-none absolute inset-x-0 top-0 h-28" style={{ background: 'radial-gradient(ellipse at 50% 0%,rgba(144,127,235,.3),transparent 72%)' }} />
            <div className="relative px-6 pt-6 pb-5">
                {step === 'update' ? (
                    <>
                        <div className="text-[9px] tracking-[0.36em] text-indigo-200/55">UPDATE</div>
                        <h2 id="sar-update-title" className="mt-2 text-[24px] tracking-[0.16em] text-white" style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 500 }}>彼方活动室</h2>
                        <div className="mt-5 h-px" style={{ background: 'linear-gradient(90deg,rgba(196,190,255,.45),transparent)' }} />
                        <p className="mt-4 text-[12.5px] leading-7 text-white/68">彼方的第二页已更新为 SAR 活动空间。<br />里面似乎已经有人先到了。</p>
                        <button type="button" onClick={onContinue} className="mt-6 flex w-full items-center justify-center gap-1.5 rounded-full py-3 text-[13px] font-semibold text-[#171326] active:scale-[0.985] transition-transform" style={{ background: 'linear-gradient(120deg,#e8e4ff,#beb7ee)' }}>
                            查看更新 <CaretRight size={14} weight="bold" />
                        </button>
                    </>
                ) : (
                    <>
                        <div className="text-[9px] tracking-[0.32em] text-indigo-200/55">SAR CLUB ROOM</div>
                        <h2 id="sar-update-title" className="mt-2 text-[20px] tracking-[0.08em] text-white" style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 500 }}>彼方迎来两名 NPC</h2>
                        <p className="mt-3 text-[12px] leading-6 text-white/58">凯恩与艾文会出现在活动室中，并提供固定剧情与功能引导。</p>
                        <div className="mt-5 space-y-2.5">
                            <button type="button" onClick={() => onChoose('show')} className="w-full rounded-full py-3 text-[13px] font-semibold text-[#171326] active:scale-[0.985] transition-transform" style={{ background: 'linear-gradient(120deg,#eeeaff,#c9c2f6)' }}>我很欢迎</button>
                            <button type="button" onClick={() => onChoose('hide')} className="w-full rounded-full py-3 text-[13px] text-white/72 active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.16)', background: 'rgba(255,255,255,.035)' }}>我不想要 NPC</button>
                        </div>
                        <p className="mt-4 text-[10px] leading-5 text-white/38">不会影响活动室及其功能，只决定两名 NPC 和相关对白是否出现。之后可在「接入」中更改。</p>
                    </>
                )}
            </div>
        </div>
    </div>
);

const NpcStandIn: React.FC<{
    who: SARDialogueSpeaker;
    active?: boolean;
    compact?: boolean;
    onClick?: () => void;
    showQuest?: boolean;
}> = ({ who, active = true, compact = false, onClick, showQuest = false }) => {
    const caian = who === 'caian';
    const name = caian ? '凯恩' : '艾文';
    const size = compact ? 66 : 114;
    const Wrapper = onClick ? 'button' : 'div';
    return (
        <Wrapper type={onClick ? 'button' : undefined} onClick={onClick} aria-label={onClick ? `与${name}交谈` : undefined}
            className={`relative flex flex-col items-center transition-all duration-300 ${active ? 'opacity-100 scale-100' : 'opacity-45 scale-[0.96]'}`}>
            {showQuest && (
                <span className="absolute -top-7 left-1/2 z-10 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full text-[19px] font-black text-[#251b08]"
                    style={{ background: 'linear-gradient(180deg,#fff0a8,#f5bd4f)', boxShadow: '0 0 18px rgba(255,210,92,.8)', animation: 'sarquest 1.25s ease-in-out infinite' }}>!</span>
            )}
            <div className="relative" style={{ width: size, height: size * 1.38, filter: active ? 'drop-shadow(0 9px 12px rgba(0,0,0,.48))' : undefined }}>
                <div className="absolute left-1/2 top-[4%] -translate-x-1/2 rounded-full" style={{ width: size * .58, height: size * .58, background: caian ? 'linear-gradient(145deg,#5c427f,#251d43)' : 'linear-gradient(145deg,#f1f2f8,#aeb9c8)' }} />
                <div className="absolute left-1/2 top-[27%] -translate-x-1/2 rounded-t-[45%] rounded-b-[24%]" style={{ width: size * .72, height: size * .93, background: caian ? 'linear-gradient(160deg,#596797,#252943)' : 'linear-gradient(160deg,#6c7483,#303640)', border: '1px solid rgba(255,255,255,.12)' }} />
                <div className="absolute left-1/2 top-[44%] -translate-x-1/2 text-center font-bold text-white/80" style={{ fontSize: compact ? 17 : 28 }}>{caian ? 'C' : 'A'}</div>
            </div>
            <span className={`${compact ? 'text-[9px]' : 'text-[11px]'} -mt-1 rounded-full bg-black/35 px-2 py-0.5 font-semibold text-white/85 backdrop-blur-sm`}>{name}</span>
        </Wrapper>
    );
};

export const SARClubStage: React.FC<{
    npcEnabled: boolean;
    caianMet: boolean;
    onTalkToCaian: () => void;
    onOpenGacha: () => void;
    onOpenCabinet: () => void;
    fullPage?: boolean;
}> = ({ npcEnabled, caianMet, onTalkToCaian, onOpenGacha, onOpenCabinet, fullPage = false }) => (
    <div className="absolute inset-0 overflow-hidden">
        <div className="absolute bottom-[8%] left-[8%] right-[8%] grid grid-cols-2 gap-2">
            {[
                { label: '扭蛋机', en: 'DIVERGENCE', enabled: true, action: onOpenGacha },
                { label: '异格陈列柜', en: 'ASSEMBLY', enabled: true, action: onOpenCabinet },
                { label: '模块购买', en: 'MODULES', enabled: false, action: undefined },
                { label: '钓鱼区', en: 'FISHING', enabled: false, action: undefined },
            ].map(facility => (
                <button type="button" key={facility.label} disabled={!facility.enabled} onClick={facility.action}
                    aria-label={facility.enabled ? `进入${facility.label}` : `${facility.label}准备中`}
                    className="rounded-xl px-2 py-2.5 text-center backdrop-blur-sm transition-transform enabled:active:scale-[0.96] disabled:opacity-55"
                    style={{ background: facility.enabled ? 'linear-gradient(145deg,rgba(29,50,67,.72),rgba(8,9,18,.55))' : 'rgba(8,9,18,.42)', border: facility.enabled ? '1px solid rgba(133,192,220,.28)' : '1px solid rgba(255,255,255,.08)', boxShadow: facility.enabled ? 'inset 0 0 15px rgba(103,181,216,.07)' : undefined }}>
                    <div className="text-[10px] text-white/58">{facility.label}</div>
                    <div className="mt-0.5 text-[6.5px] tracking-[0.16em] text-indigo-200/25">{facility.en}</div>
                    <div className="mt-1 text-[6px] tracking-[0.08em]" style={{ color: facility.enabled ? 'rgba(168,220,240,.62)' : 'rgba(255,255,255,.22)' }}>{facility.enabled ? '已接入' : '准备中'}</div>
                </button>
            ))}
        </div>
        {npcEnabled && (
            <>
                <div className="absolute bottom-[35%] left-[27%]" style={{ animation: 'vrfloat 3.2s ease-in-out infinite' }}>
                    <NpcStandIn who="caian" compact={!fullPage} onClick={caianMet ? undefined : onTalkToCaian} showQuest={!caianMet} />
                </div>
                <div className="absolute bottom-[34%] right-[15%]" style={{ animation: 'vrfloat 3.5s .4s ease-in-out infinite' }}>
                    <NpcStandIn who="aiven" compact={!fullPage} active={caianMet} />
                </div>
            </>
        )}
    </div>
);

export const SARCaianDialogue: React.FC<{
    onClose: () => void;
    onComplete: (reaction?: SARIntroReaction) => void;
}> = ({ onClose, onComplete }) => {
    const [nodeId, setNodeId] = useState('start');
    const [lineIndex, setLineIndex] = useState(0);
    const [mentionedCharacterCard, setMentionedCharacterCard] = useState(false);
    const [reaction, setReaction] = useState<SARIntroReaction | undefined>();
    const node = useMemo(() => getSARDialogueNode(nodeId, { mentionedCharacterCard }), [nodeId, mentionedCharacterCard]);
    const line = node.lines[Math.min(lineIndex, Math.max(0, node.lines.length - 1))];
    const isLastLine = lineIndex >= node.lines.length - 1;
    const choices = isLastLine ? node.choices || [] : [];

    const goTo = (next: string) => {
        setNodeId(next);
        setLineIndex(0);
    };

    const choose = (choice: SARDialogueChoice) => {
        if (choice.reaction) setReaction(choice.reaction);
        if (choice.mentionsCharacterCard) setMentionedCharacterCard(true);
        goTo(choice.next);
    };

    const advance = () => {
        if (!isLastLine) { setLineIndex(index => index + 1); return; }
        if (choices.length > 0) return;
        if (node.next) { goTo(node.next); return; }
        if (node.completes) onComplete(reaction);
    };

    if (!line) return null;
    const speakerName = line.speaker === 'caian' ? '凯恩' : '艾文';
    return (
        <div className="fixed inset-0 z-[370] overflow-hidden bg-[#090a12]/78 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="凯恩初次见面对话">
            <button type="button" onClick={onClose} aria-label="暂时离开对话" className="absolute right-4 z-20 grid h-9 w-9 place-items-center rounded-full bg-black/35 text-white/65 backdrop-blur-md active:bg-white/15" style={{ top: `calc(${SAFE_TOP} + .5rem)` }}><X size={17} /></button>

            <div className="absolute inset-x-0 top-[7%] bottom-[32%] overflow-hidden">
                <div className="absolute left-[14%] bottom-0"><NpcStandIn who="caian" active={line.speaker === 'caian'} /></div>
                <div className="absolute right-[13%] bottom-0"><NpcStandIn who="aiven" active={line.speaker === 'aiven'} /></div>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2" style={{ background: 'linear-gradient(180deg,transparent,rgba(8,8,16,.6))' }} />
            </div>

            <div className="absolute inset-x-3 bottom-0 z-10" style={{ paddingBottom: `calc(${SAFE_BOTTOM} + .8rem)` }}>
                <div className="overflow-hidden rounded-[22px]" style={{ background: 'linear-gradient(165deg,rgba(29,27,48,.97),rgba(13,13,24,.98))', border: '1px solid rgba(210,205,255,.18)', boxShadow: '0 -10px 42px rgba(0,0,0,.42)' }}>
                    <button type="button" onClick={advance} className="block min-h-[132px] w-full px-5 pb-4 pt-4 text-left active:bg-white/[0.025]"
                        aria-label={choices.length ? undefined : node.completes && isLastLine ? '结束对话' : '继续对话'}>
                        <div className="mb-2 flex items-center gap-2">
                            <span className="text-[12px] font-bold tracking-[0.18em] text-indigo-100" style={{ fontFamily: `'Noto Serif SC',serif` }}>{speakerName}</span>
                            <span className="h-px flex-1" style={{ background: 'linear-gradient(90deg,rgba(190,185,255,.26),transparent)' }} />
                        </div>
                        <p className="text-[15px] leading-7 text-white/92">{line.text}</p>
                        {!choices.length && <div className="mt-2 flex items-center justify-end gap-1 text-[9px] tracking-[0.16em] text-white/28">{node.completes && isLastLine ? '结束对话' : '点击继续'} <CaretRight size={10} /></div>}
                    </button>
                    {choices.length > 0 && (
                        <div className="space-y-1.5 border-t border-white/[0.08] px-3 pb-3 pt-2.5">
                            {choices.map(choice => (
                                <button key={choice.label} type="button" onClick={() => choose(choice)} className="flex w-full items-center gap-2 rounded-xl px-3.5 py-2.5 text-left text-[12.5px] text-white/82 active:bg-white/10" style={{ background: 'rgba(255,255,255,.045)', border: '1px solid rgba(255,255,255,.065)' }}>
                                    <span className="flex-1">{choice.label}</span><CaretRight size={12} className="text-indigo-200/45" />
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
