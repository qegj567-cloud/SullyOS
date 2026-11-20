import { trackEvent } from '../../utils/analytics';
import React, { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { CaretRight, LinkSimple, SlidersHorizontal, X } from '@phosphor-icons/react';
import type { CharacterProfile, DailySchedule } from '../../types';
import { characterRemark } from '../../utils/characterRemark';
import { isImageValue } from '../../utils/blobRef';
import { getLastInnerState } from '../../utils/emotionState';
import { isScheduleFeatureOn } from '../../utils/scheduleFeature';
import { getCurrentScheduleSlotIndex } from '../../utils/scheduleTime';
import { resolveCharTimeZone, tzShortLabel } from '../../utils/timezone';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { useTickingNow } from '../../hooks/useTickingNow';
import { handleLocalBack } from '../../utils/localBackHandlers';
import BlobRefStyle from './BlobRefStyle';
import TokenImg from '../os/TokenImg';
import ScheduleTheaterButton from '../schedule/ScheduleTheaterButton';
import './ChatCharacterProfile.css';

const CharacterEditor = lazy(() => import('../../apps/Character'));
const tabs = ['当前', '设定', '日程'] as const;
type ProfileTab = typeof tabs[number];

function ProfileBackHandler({back}: {back: () => void}) {
    useLocalBackHandler(() => { back(); return true; },30);
    return null;
}

function ProfileEmotion({ character, fallback, preview }: { character: CharacterProfile; fallback?: string; preview?: boolean }) {
    const [thought, setThought] = useState(() => preview ? '' : getLastInnerState(character.id));
    useEffect(() => {
        const receive = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (detail?.charId === character.id && typeof detail.innerState === 'string') setThought(detail.innerState);
        };
        window.addEventListener('emotion-innerstate-updated', receive);
        return () => window.removeEventListener('emotion-innerstate-updated', receive);
    }, [character.id]);
    return <>
        {(thought || fallback) && <section className="chat-profile-thought" aria-label="心声">
            <span className="chat-profile-caption">心声</span>
            <p>{thought || fallback}</p>
        </section>}
        {!!character.activeBuffs?.length && <ul className="chat-profile-emotions" aria-label="当前情绪">
            {character.activeBuffs.map(buff => {
                const label = <><i className="chat-profile-seal" aria-hidden="true">{buff.emoji || '✦'}</i>{buff.label || buff.name}</>;
                return <li key={buff.id}>{buff.description
                    ? <details><summary>{label}<CaretRight size={13} aria-hidden="true" /></summary><p>{buff.description}</p></details>
                    : <h3>{label}</h3>}</li>;
            })}
        </ul>}
    </>;
}

type Props = {
    character: CharacterProfile;
    schedule: DailySchedule | null;
    initialTab?: ProfileTab;
    preview?: boolean;
    customCss?: string;
    onClose: () => void;
    onSchedule: () => void;
    onPlayTheater: (index: number) => void;
    onMemory: () => void;
};

export default function ChatCharacterProfile({ character, schedule, initialTab = '当前', preview = false, customCss = character.chatProfileAppearance?.customCss, onClose, onSchedule, onPlayTheater, onMemory }: Props) {
    const dialog = useRef<HTMLDialogElement>(null);
    const scroll = useRef<HTMLDivElement>(null);
    const tablist = useRef<HTMLDivElement>(null);
    const id = useId();
    const [tab, setTab] = useState<ProfileTab>(initialTab);
    const scheduleOn = isScheduleFeatureOn(character);
    const slots = scheduleOn && schedule?.charId === character.id ? schedule.slots : [];
    const now = useTickingNow();
    const current = preview ? 0 : getCurrentScheduleSlotIndex(slots, character, now);
    const timeZone = resolveCharTimeZone(character);

    const selectTab = (next: ProfileTab) => {
        if (next !== tab && next === '设定') trackEvent('查看角色名片栏目', { 栏目: '设定' });
        if (next !== tab && next === '日程') trackEvent('查看角色名片栏目', { 栏目: '日程' });
        setTab(next);
        tablist.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus({ preventScroll: true });
    };
    useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, []);
    useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [tab]);

    return <dialog ref={dialog} open={preview || undefined} data-section={tab} className="chat-profile-dialog" aria-label={`${character.name}的角色名片`}
        onCancel={event => { event.preventDefault(); handleLocalBack(); }}
        onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
        {!preview && <ProfileBackHandler back={() => tab === '当前' ? onClose() : selectTab('当前')}/>}
        {customCss && !preview && <BlobRefStyle css={customCss}/>}
        <div className="chat-profile-sheet">
            <div className="chat-profile-sky" aria-hidden="true"><i /><i /><i /><i /></div>
            <div ref={tablist} className="chat-profile-tabs" role="tablist" aria-label="角色名片栏目" aria-orientation="vertical">
                {tabs.map((label, index) => <button type="button" role="tab" key={label} data-tab={label} data-preview-scene={preview ? ['profile-current','profile-settings','profile-schedule'][index] : undefined}
                    id={`${id}-tab-${label}`} aria-controls={`${id}-panel`} aria-label={label} aria-selected={label === tab}
                    tabIndex={label === tab ? 0 : -1} onClick={() => selectTab(label)}
                    onKeyDown={event => {
                        const destinations: Record<string, number | undefined> = {
                            ArrowDown: (index + 1) % tabs.length, ArrowUp: (index + tabs.length - 1) % tabs.length,
                            Home: 0, End: tabs.length - 1,
                        };
                        const next = destinations[event.key];
                        if (next === undefined) return;
                        event.preventDefault();
                        selectTab(tabs[next]);
                    }}>
                    <span>{label}</span>
                </button>)}
            </div>
            <button type="button" className="chat-profile-close" aria-label="关闭角色名片" onClick={onClose}><X size={18} /></button>
            <div ref={scroll} id={`${id}-panel`} role="tabpanel" tabIndex={0} aria-labelledby={`${id}-tab-${tab}`} className="chat-profile-scroll">
                {tab === '当前' ? <div className="chat-profile-current">
                    <header className="chat-profile-identity">
                        <div className="chat-profile-portrait">
                            {isImageValue(character.avatar) || /\//.test(character.avatar || '')
                                ? <TokenImg value={character.avatar} alt={character.name} />
                                : <span aria-hidden="true">{character.avatar || character.name.slice(0, 1)}</span>}
                        </div>
                        <h2>{character.name}</h2>
                        <p className="chat-profile-remark"><span>备注</span>{characterRemark(character.description) || '未填写'}</p>
                        <span className="chat-profile-divider" aria-hidden="true">✦</span>
                    </header>
                    {scheduleOn && character.emotionConfig?.enabled && <ProfileEmotion preview={preview} key={character.id} character={character} fallback={slots[current]?.innerThought} />}
                </div> : <>
                    <header className="chat-profile-page-heading"><p>{character.name}</p><h2>{tab === '设定' ? '角色设定' : '今日日程'}</h2></header>
                    {tab === '设定' ? <div className="chat-profile-editor">
                        {preview ? <details open><summary>核心指令</summary><textarea aria-label="核心指令" readOnly value="喜欢安静的书店，习惯在页边写下今天的见闻。" /></details> : <Suspense fallback={<p>正在打开角色设定…</p>}><CharacterEditor key={character.id} profileCharacterId={character.id} /></Suspense>}
                    </div> : <section className="chat-profile-schedule">
                        <div className="chat-profile-schedule-tools">
                            {timeZone && <span>{tzShortLabel(timeZone)}时间</span>}
                            <button type="button" onClick={onSchedule}><SlidersHorizontal size={15} />日程与情绪设置</button>
                        </div>
                        {slots.length ? <ol>{slots.map((slot, i) => <li key={slot.startTime + '-' + i} aria-current={i === current ? 'time' : undefined}>
                            <time>{slot.startTime}</time><div><h3>{slot.emoji && <span aria-hidden="true">{slot.emoji} </span>}{slot.activity}{i === current && <small>当前</small>}</h3>
                                {slot.location && <p>{slot.location}</p>}{slot.description && <p>{slot.description}</p>}
                            </div>
                            <ScheduleTheaterButton slot={slot} future={i > current} onPlay={() => onPlayTheater(i)} />
                        </li>)}</ol> : <p className="chat-profile-empty">{scheduleOn ? '今天还没有日程。' : '日程未开启。'}</p>}
                    </section>}
                </>}
            </div>
            {tab === '设定' && <button type="button" className="chat-profile-memory" onClick={onMemory}><LinkSimple size={15} />记忆链接<CaretRight size={12} /></button>}
        </div>
    </dialog>;
}
