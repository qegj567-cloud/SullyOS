import React, { useEffect, useMemo, useRef, useState } from 'react';
import SARClubRoom from './SARClubRoom';
import {SARDialogueCast} from './SARNpcArt';
import {SARDialogueChoices} from './SARDialogueChoices';
import {SARDialogueMeta} from './SARDialogueMeta';
import {SARDialogueBackdrop} from './SARDialogueBackdrop';
import {keepDialogueGuest} from '../../utils/vrWorld/sarDialogueStaging';
import type {CharacterProfile} from '../../types';
import { ArrowRight, CaretRight } from '@phosphor-icons/react';
import {
    getSARDialogueNode,
    SAR_CAIAN_INTRO_DIALOGUE,
    type SARDialogueChoice,
    type SARIntroReaction,
    type SARNpcPreference,
    type SARRoomView,
} from '../../utils/vrWorld/sarClub';

import './sar-familiarity-dialog.css';

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
                        <div className="text-[9px] tracking-[0.36em] text-white">UPDATE</div>
                        <h2 id="sar-update-title" className="mt-2 text-[24px] tracking-[0.16em] text-white" style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 500 }}>彼方活动室</h2>
                        <div className="mt-5 h-px" style={{ background: 'linear-gradient(90deg,rgba(196,190,255,.45),transparent)' }} />
                        <p className="mt-4 text-[12.5px] leading-7 text-white">彼方新增了独立的 SAR 活动空间。<br />里面似乎已经有人先到了。</p>
                        <button type="button" onClick={onContinue} className="mt-6 flex w-full items-center justify-center gap-1.5 rounded-full py-3 text-[13px] font-semibold text-[#171326] active:scale-[0.985] transition-transform" style={{ background: 'linear-gradient(120deg,#e8e4ff,#beb7ee)' }}>
                            查看更新 <CaretRight size={14} weight="bold" />
                        </button>
                    </>
                ) : (
                    <>
                        <div className="text-[9px] tracking-[0.32em] text-white">SAR CLUB ROOM</div>
                        <h2 id="sar-update-title" className="mt-2 text-[20px] tracking-[0.08em] text-white" style={{ fontFamily: `'Noto Serif SC',serif`, fontWeight: 500 }}>彼方迎来两名 NPC</h2>
                        <p className="mt-3 text-[12px] leading-6 text-white">凯恩与艾文会出现在活动室中，并提供固定剧情与功能引导。</p>
                        <div className="mt-5 space-y-2.5">
                            <button type="button" onClick={() => onChoose('show')} className="w-full rounded-full py-3 text-[13px] font-semibold text-[#171326] active:scale-[0.985] transition-transform" style={{ background: 'linear-gradient(120deg,#eeeaff,#c9c2f6)' }}>我很欢迎</button>
                            <button type="button" onClick={() => onChoose('hide')} className="w-full rounded-full py-3 text-[13px] text-white active:bg-white/10" style={{ border: '1px solid rgba(255,255,255,.16)', background: 'rgba(255,255,255,.035)' }}>我不想要 NPC</button>
                        </div>
                        <p className="mt-4 text-[10px] leading-5 text-white">不会影响活动室及其功能，只决定两名 NPC 和相关对白是否出现。之后可在「角色接入」中更改。</p>
                    </>
                )}
            </div>
        </div>
    </div>
);

export const SARClubStage: React.FC<{
    npcEnabled: boolean;
    caianMet: boolean;
    onTalkToCaian: () => void;
    onTalkToAiven?: () => void;
    occupants?: CharacterProfile[];
    onSelectCharacter?: (char:CharacterProfile) => void;
    onOpenGacha: () => void;
    onOpenCabinet: () => void;
    onOpenModuleShop: () => void;
    onOpenFishingMarket: (entry: 'water' | 'board' | 'garden') => void;
    fullPage?: boolean;
    labelsHidden?: boolean;
    roomView?: SARRoomView;
}> = ({fullPage:_,...props}) => <SARClubRoom {...props}/>;

export const SARCaianDialogue: React.FC<{
    onClose: () => void;
    onComplete: (reaction?: SARIntroReaction) => void;
}> = ({ onClose, onComplete }) => {
    const [nodeId, setNodeId] = useState('start');
    const [lineIndex, setLineIndex] = useState(0);
    const [mentionedCharacterCard, setMentionedCharacterCard] = useState(false);
    const [reaction, setReaction] = useState<SARIntroReaction | undefined>();
    const [guestCarried,setGuestCarried]=useState(false);
    const node = useMemo(() => getSARDialogueNode(nodeId, { mentionedCharacterCard }), [nodeId, mentionedCharacterCard]);
    const line = node.lines[Math.min(lineIndex, Math.max(0, node.lines.length - 1))];
    const keepGuest=keepDialogueGuest({...SAR_CAIAN_INTRO_DIALOGUE,[nodeId]:node},nodeId,lineIndex,'caian',guestCarried);
    const isLastLine = lineIndex >= node.lines.length - 1;
    const choices = isLastLine ? node.choices || [] : [];
    const panel=useRef<HTMLButtonElement>(null);
    useEffect(()=>{panel.current?.scrollTo(0,0);},[nodeId,lineIndex]);
    useEffect(()=>{
        const target=window as Window&{render_game_to_text?:()=>string};
        const render=()=>JSON.stringify({mode:'sar-intro',node:nodeId,line:lineIndex,text:line?.text,speaker:line?.speaker,choices:choices.map(choice=>choice.label),keepGuest});
        target.render_game_to_text=render;
        return()=>{if(target.render_game_to_text===render)delete target.render_game_to_text;};
    },[nodeId,lineIndex,line,choices,keepGuest]);

    const goTo = (next: string) => {
        setGuestCarried(keepGuest);
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
        <div className="sar-npc-dialogue srf-dialog srf-caian" role="dialog" aria-modal="true" aria-label="凯恩初次见面对话" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose();}}}>
            <SARDialogueBackdrop/>
            <div className="srf-body">
                <div className="sar-dialogue-portraits srf-stage">
                    <SARDialogueCast lead="caian" speaker={line.speaker} expression={line.expression} keepGuest={keepGuest}/>
                </div>
                <div className="sar-dialogue-panel srf-script">
                    <SARDialogueMeta npc="caian" speaker={speakerName}/>
                    <button ref={panel} type="button" onClick={advance} className="srf-bubble" disabled={choices.length>0}
                        aria-label={node.completes && isLastLine ? '结束对话' : '继续对话'}>
                        <p className="srf-line">{line.text}</p>
                        <span className="srf-next">{choices.length?'请选择回应':node.completes && isLastLine?'结束对话':'点击继续'}<ArrowRight size={16}/></span>
                    </button>
                </div>
            </div>
            {choices.length > 0 && <SARDialogueChoices key={nodeId}>
                {choices.map(choice=><button key={choice.label} type="button" onClick={()=>choose(choice)}>{choice.label}</button>)}
            </SARDialogueChoices>}
        </div>
    );
};
