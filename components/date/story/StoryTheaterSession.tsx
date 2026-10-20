import {meetingAppearance} from '../../../utils/meetingAppearance';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadStoryActorContext, replaceStoryTheaterReply, STORY_REROLL_INSTRUCTION } from '../../../utils/storyTheaterReply';
import { generateStoryArchiveSummary } from '../../../utils/storyTheaterArchive';
import { Archive, ArrowBendDownRight, ArrowClockwise, ArrowLeft, Broadcast, CaretDown, CaretLeft, CaretRight, ChatCircleDots, Clock, Database, DownloadSimple, Eye, EyeSlash, FilmSlate, GearSix, HeartStraight, Key, MapPin, PaperPlaneTilt, PencilSimple, SlidersHorizontal, SpinnerGap, Trash, X } from '@phosphor-icons/react';
import { useOS } from '../../../context/OSContext';
import TokenImg from '../../os/TokenImg';
import type { CharacterProfile, Message, StoryTheaterEntry, StoryTheaterMask, StoryTheaterPreset } from '../../../types';
import { DB } from '../../../utils/db';
import { ContextBuilder } from '../../../utils/context';
import { safeResponseJson, extractContent } from '../../../utils/safeApi';
import {
    appendStoryAffinityInputs,
    appendStoryUserTurn,
    buildBareTheaterActorContext,
    buildStoryAffinityAwarenessReminder,
    buildStoryBackstageAftermathReminder,
    buildStoryActorMemoryEnvelope,
    buildStoryArchiveMemoryEnvelope,
    buildStoryMultiAffinityGuide,
    buildStoryHistory,
    buildStoryIdentityGuard,
    buildStoryMiniTheaterReminder,
    buildTheaterPersona,
    compileStoryPreset,
    prepareStoryGenerationSettings,
    reconcileStoryAffinityScores,
    dedupeTheaterWorldbooks,
    describeEmptyStoryCompletion,
    describeStoryApiError,
    estimateStoryTokens,
    formatActorRecentMessages,
    formatStoryTheaterExport,
    getActiveStoryMiniTheaterPrompt,
    getPendingStoryRetryInput,
    isStoryUserLastCompatibilityError,
    makeStoryTheaterId,
    makeStoryTheaterFileName,
    createStoryTheaterMirrorMessage,
    parseStoryDisplayBlocks,
    REAL_COMPANION_MEMORY_GUARD,
    RELATIONSHIP_TEXTURE_GUIDE,
    resolveStoryTheaterMask,
    resolveStoryPresetDocument,
    selectStoryArchiveBatch,
    storyTheaterMemoryRecipientIds,
    storyTheaterThreadId,
    type StoryAffinityInput,
    type StoryApiMessage,
    type StoryGenerationSettings,
} from '../../../utils/storyTheater';
import {
    getMemoryPalaceHighWaterMark,
    processMessageRange,
    retrieveMemories,
} from '../../../utils/memoryPalace/pipeline';
import { processNewMessagesWithAutoArchive } from '../../../utils/memoryPalace/autoArchive';
import { incrementDigestRound, runCognitiveDigestion } from '../../../utils/memoryPalace';
import StoryQuickPresetPanel from './StoryQuickPresetPanel';
import { StoryAppearanceButton } from './StoryTheaterTheme';
import { shareOrDownloadFile } from '../../../utils/shareExport';
import {
    buildStoryContinueInstruction,
    MEETING_CONTINUE_DISPLAY_TEXT,
} from '../../../utils/meetingContinue';

interface Props {
    entry: StoryTheaterEntry;
    preset: StoryTheaterPreset;
    masks: StoryTheaterMask[];
    onBack: () => void;
    onEdit: () => void;
    onOpenVectorMemory?: () => void;
    onOpenArchives?: () => void;
    onEntryChange: (entry: StoryTheaterEntry) => Promise<void> | void;
}

const STORY_PAGE_SIZE = 10;

const StoryPagination: React.FC<{ page: number; pageCount: number; onChange: (page: number) => void; className?: string }> = ({ page, pageCount, onChange, className = '' }) => (
    <nav className={`${className} py-2 border-y border-slate-200 flex items-center justify-between`}>
        <button disabled={page === 0} onClick={() => onChange(Math.max(0, page - 1))} className='w-9 h-9 rounded-full grid place-items-center disabled:opacity-20' aria-label='更早一页'><CaretLeft size={17} /></button>
        <div className='text-center'><div className='text-[10px] font-bold text-slate-600'>第 {page + 1} / {pageCount} 页</div><div className='mt-0.5 text-[9px] text-slate-400'>每页最多 {STORY_PAGE_SIZE} 条内容</div></div>
        <button disabled={page >= pageCount - 1} onClick={() => onChange(Math.min(pageCount - 1, page + 1))} className='w-9 h-9 rounded-full grid place-items-center disabled:opacity-20' aria-label='更新一页'><CaretRight size={17} /></button>
    </nav>
);

const normalizeAffinityInput = (value: any, actor?: CharacterProfile): StoryAffinityInput | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const delta = Math.max(-100, Math.min(100, Math.round(Number(value.delta) || 0)));
    const reason = String(value.reason || '').trim().slice(0, 200);
    const awareness = value.awareness === 'noticed' ? 'noticed' : 'unnoticed';
    return delta !== 0 || reason ? {
        characterId: String(value.characterId || actor?.id || ''),
        characterName: String(value.characterName || actor?.name || '当前角色'),
        delta,
        reason,
        awareness,
    } : undefined;
};

const affinityInputsFromMessage = (message: Message | undefined, actors: CharacterProfile[]): StoryAffinityInput[] => {
    const values = message?.metadata?.theaterAffinityInputs;
    if (Array.isArray(values)) return values
        .map(value => normalizeAffinityInput(value, actors.find(actor => actor.id === value?.characterId)))
        .filter((value): value is StoryAffinityInput => Boolean(value));
    const legacy = normalizeAffinityInput(message?.metadata?.theaterAffinityInput, actors[0]);
    return legacy ? [legacy] : [];
};

interface AffinityDraft { delta: number; reason: string; awareness: 'noticed' | 'unnoticed'; }
const EMPTY_AFFINITY_DRAFT: AffinityDraft = { delta: 0, reason: '', awareness: 'unnoticed' };

const mirrorArchived = (message: Message, entry: StoryTheaterEntry): boolean => {
    if (!entry.writesToCharacterMemory) return message.metadata?.theaterArchived === true;
    const mirrorIds = message.metadata?.theaterMirrorIds as Record<string, number> | undefined;
    const recipientIds = Object.keys(mirrorIds || {});
    if (!mirrorIds || recipientIds.length === 0) return false;
    return recipientIds.every(charId => {
        const mirrorId = Number(mirrorIds[charId] || 0);
        return mirrorId > 0 && mirrorId <= getMemoryPalaceHighWaterMark(charId);
    });
};

interface DisplayLine { label?: string; value: string; }

const splitDisplayLines = (text: string): DisplayLine[] => text.split(/\n+/).map(row => row.trim()).filter(Boolean).map(row => {
    const match = row.match(/^([^：]{1,14})：(.*)$/);
    return match ? { label: match[1].trim(), value: match[2].trim() } : { value: row };
});

const LabeledRows: React.FC<{ lines: DisplayLine[] }> = ({ lines }) => <div className='divide-y divide-current/10'>
    {lines.map((line, index) => <div key={index} className='py-2.5 grid grid-cols-[76px_1fr] gap-3 items-start'>
        <span className='text-[9px] tracking-wide font-bold text-slate-400'>{line.label || '记录'}</span>
        <span className='text-[12px] leading-6 whitespace-pre-wrap text-slate-700'>{line.value || '—'}</span>
    </div>)}
</div>;

const AFFINITY_DIMENSIONS = ['信任', '安全感', '占有拉力', '情绪压强', '修复意愿'] as const;

const affinityNumber = (lines: DisplayLine[], labels: string[]): number | undefined => {
    const raw = lines.find(line => line.label && labels.includes(line.label))?.value;
    const value = Number(String(raw || '').match(/-?\d+/)?.[0]);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
};

const StoryAffinityGroup: React.FC<{ group: DisplayGroup }> = ({ group }) => {
    const cToU = affinityNumber(group.lines, ['角色对你的温度', '关系温度']);
    const uToC = affinityNumber(group.lines, ['你对角色的温度', '你的关系温度']);
    const dimensions = AFFINITY_DIMENSIONS.map(label => ({ label, value: affinityNumber(group.lines, [label]) })).filter(item => item.value !== undefined);
    const compactLabels = new Set<string>(['角色对你的温度', '关系温度', '你对角色的温度', '你的关系温度', ...AFFINITY_DIMENSIONS]);
    const notes = group.lines.filter(line => !compactLabels.has(line.label || ''));
    return <section className='py-4 first:pt-0'>
        <div className='text-[11px] font-bold text-rose-700'>{group.title || '主要角色'}</div>
        {(cToU !== undefined || uToC !== undefined) && <div className='mt-2 grid grid-cols-2 gap-2'>
            <div className='rounded-xl bg-rose-50 px-3 py-2'><div className='text-[8px] font-bold text-rose-400'>{group.title || '角色'} → 你</div><div className='mt-0.5 text-lg font-serif font-semibold text-rose-700'>{cToU ?? '—'}<span className='ml-1 text-[8px] font-sans text-rose-300'>/ 100</span></div></div>
            <div className='rounded-xl bg-violet-50 px-3 py-2'><div className='text-[8px] font-bold text-violet-400'>你 → {group.title || '角色'}</div><div className='mt-0.5 text-lg font-serif font-semibold text-violet-700'>{uToC ?? '—'}<span className='ml-1 text-[8px] font-sans text-violet-300'>/ 100</span></div></div>
        </div>}
        {dimensions.length > 0 && <div className='mt-3 grid gap-2'>{dimensions.map(item => <div key={item.label} className='grid grid-cols-[56px_1fr_24px] items-center gap-2'><span className='text-[8px] font-bold text-slate-400'>{item.label}</span><span className='h-1.5 rounded-full bg-slate-200 overflow-hidden'><i className='block h-full rounded-full bg-gradient-to-r from-violet-300 to-rose-400' style={{ width: `${item.value}%` }} /></span><span className='text-[8px] text-right tabular-nums text-slate-400'>{item.value}</span></div>)}</div>}
        {notes.length > 0 && <div className='mt-3'><LabeledRows lines={notes} /></div>}
    </section>;
};

interface DisplayGroup { title: string; lines: DisplayLine[]; }

const groupDisplayLines = (lines: DisplayLine[], anchorLabel: string, ignoredLabels: string[] = [], ignoredValues: string[] = []): DisplayGroup[] => {
    const ignoredLabelSet = new Set(ignoredLabels);
    const ignoredValueSet = new Set(ignoredValues);
    const groups: DisplayGroup[] = [];
    let current: DisplayGroup | null = null;
    for (const line of lines) {
        if (line.label === anchorLabel) {
            if (current && (current.title || current.lines.length > 0)) groups.push(current);
            current = { title: line.value, lines: [] };
            continue;
        }
        if (ignoredLabelSet.has(line.label || '') || ignoredValueSet.has(line.value)) continue;
        if (!current) current = { title: '', lines: [] };
        current.lines.push(line);
    }
    if (current && (current.title || current.lines.length > 0)) groups.push(current);
    return groups;
};

const mergeDisplayGroupsByTitle = (groups: DisplayGroup[]): DisplayGroup[] => groups.reduce<DisplayGroup[]>((result, group) => {
    const existing = group.title && result.find(item => item.title === group.title);
    if (existing) existing.lines.push(...group.lines);
    else result.push({ title: group.title, lines: [...group.lines] });
    return result;
}, []);

const StorySceneRelationships: React.FC<{ inputs: StoryAffinityInput[] }> = ({ inputs }) => <div className='mt-4 pt-4 border-t border-violet-100'>
    <div className='flex items-center gap-2 text-[9px] font-bold text-slate-400'><HeartStraight size={13} weight='fill' className='text-rose-400' />本轮 U→C 关系变化</div>
    <div className='mt-2 divide-y divide-rose-100'>{inputs.map((input, index) => {
        const characterName = input.characterName || '当前角色';
        const movement = input.delta > 0 ? '更靠近了一点' : input.delta < 0 ? '退远了一点' : '有了新的变化';
        const noticed = input.awareness === 'noticed';
        return <div key={input.characterId || `${characterName}-${index}`} className='py-2.5 flex items-start gap-3'><div className='min-w-0 flex-1'><div className='text-[10px] font-bold text-slate-600'>你 → {characterName}</div><p className='mt-1 text-[11px] leading-5 text-slate-600'>你{movement}{input.reason ? `：${input.reason}` : '。'}</p></div><div className={`shrink-0 mt-0.5 inline-flex items-center gap-1 text-[8px] font-bold ${noticed ? 'text-violet-600' : 'text-slate-400'}`}>{noticed ? <Eye size={11} weight='fill' /> : <EyeSlash size={11} />}{characterName}【{noticed ? '已察觉！' : '未察觉'}】</div></div>;
    })}</div>
</div>;

export const StoryOutput: React.FC<{ content: string; onChoose?: (text: string) => void; affinityInputs: StoryAffinityInput[] }> = ({ content, onChoose, affinityInputs }) => {
    const {theme} = useOS();
    const reading = meetingAppearance(theme.storyAppearance).id !== 'none';
    const blocks = parseStoryDisplayBlocks(content);
    const relationshipSceneIndex = blocks.findIndex(block => block.kind === 'scene');
    const hasScene = relationshipSceneIndex >= 0;
    const relationship = affinityInputs.length > 0 ? <StorySceneRelationships inputs={affinityInputs} /> : null;
    const backstageIndex = blocks.findIndex(block => block.kind === 'backstage');
    const debtIndex = blocks.findIndex(block => block.kind === 'debts');
    const aftermathIndex = backstageIndex < 0 ? debtIndex : debtIndex < 0 ? backstageIndex : Math.min(backstageIndex, debtIndex);
    const backstageLines = backstageIndex >= 0 ? splitDisplayLines(blocks[backstageIndex].text) : [];
    const debtLines = debtIndex >= 0 ? splitDisplayLines(blocks[debtIndex].text) : [];
    const backstageGroups = mergeDisplayGroupsByTitle(groupDisplayLines(backstageLines, '主体', [], ['幕后暗格']));
    const debtGroups = groupDisplayLines(debtLines, '起因', ['镜头债'], ['镜头债', '镜头债 · 后果尚未到账']);
    const hasTrueMonologue = backstageLines.some(line => line.label === '心声' || line.label === '真正的独白');
    const rendered = <div className='space-y-6'>
        {!hasScene && relationship}
        {blocks.map((block, index) => {
            const lines = splitDisplayLines(block.text);
            if (block.kind === 'story' && reading) return null;
            if (block.kind === 'story') return <p key={index} className='font-serif text-[15px] leading-8 text-slate-800 whitespace-pre-wrap'>{block.text}</p>;
            if (block.kind === 'scene') return <section key={index} className='py-4 border-y border-slate-300'>
                <div className='flex items-center gap-2 text-[9px] tracking-[.22em] uppercase font-bold text-violet-600'><FilmSlate size={14} weight='fill' />{block.title}</div>
                <div className='mt-3 grid grid-cols-2 gap-x-5 gap-y-3'>{lines.map((line, lineIndex) => <div key={lineIndex} className={line.label === '场面' ? 'col-span-2' : ''}><div className='flex items-center gap-1 text-[9px] font-bold text-slate-400'>{line.label === '时间' ? <Clock size={11} /> : line.label === '地点' ? <MapPin size={11} /> : null}{line.label || '场景'}</div><div className='mt-1 text-[12px] leading-5 text-slate-700'>{line.value}</div></div>)}</div>
                {index === relationshipSceneIndex && relationship}
            </section>;
            if (block.kind === 'backstage' || block.kind === 'debts') {
                if (index !== aftermathIndex) return null;
                const countText = [backstageGroups.length > 0 ? `${backstageGroups.length} 位人物` : '', debtGroups.length > 0 ? `${debtGroups.length} 笔余波` : ''].filter(Boolean).join(' · ');
                return <details key={index} className='group border-y border-violet-200'>
                    <summary className='list-none cursor-pointer py-3.5 flex items-center gap-3'><span className='w-8 h-8 rounded-full bg-violet-100 grid place-items-center text-violet-600'><Key size={15} weight='fill' /></span><span className='min-w-0 flex-1'><strong className='block text-xs text-slate-700'>幕后与余波</strong><span className={`block mt-0.5 text-[9px] ${hasTrueMonologue ? 'text-violet-600 font-bold' : 'text-slate-400'}`}>{countText || '本轮没有额外记录'}{hasTrueMonologue ? ' · 真话掉落' : ''}</span></span><CaretDown size={13} className='text-violet-500 transition-transform group-open:rotate-180' /></summary>
                    <div className='pb-4 pl-11'>
                        {backstageGroups.length > 0 && <section><div className='pb-2 text-[9px] tracking-[.16em] font-bold text-violet-500'>幕后暗格</div><div className='divide-y divide-violet-100'>{backstageGroups.map((group, groupIndex) => <div key={`${group.title}-${groupIndex}`} className='py-3 first:pt-1'><div className='text-[10px] font-bold text-slate-700'>{group.title || `人物 ${groupIndex + 1}`}</div><LabeledRows lines={group.lines} /></div>)}</div></section>}
                        {debtGroups.length > 0 && <section className={backstageGroups.length > 0 ? 'mt-3 pt-4 border-t border-amber-200' : ''}><div className='pb-2 text-[9px] tracking-[.16em] font-bold text-amber-600'>尚未到账</div><div className='divide-y divide-amber-100'>{debtGroups.map((group, groupIndex) => <div key={`${group.title}-${groupIndex}`} className='py-3 first:pt-1'><div className='flex items-start gap-2'><span className='mt-0.5 w-4 h-4 shrink-0 rounded-full bg-amber-100 text-amber-700 grid place-items-center text-[8px] font-bold'>{groupIndex + 1}</span><p className='text-[11px] leading-5 font-semibold text-slate-700'>{group.title || '未命名余波'}</p></div><div className='ml-6'><LabeledRows lines={group.lines} /></div></div>)}</div></section>}
                    </div>
                </details>;
            }
            if (block.kind === 'worldline') return <section key={index} className='py-4 border-y border-violet-200'>
                <div className='flex items-center gap-2 text-[10px] font-bold text-violet-700'><Broadcast size={15} weight='fill' />世界线仍在镜头外前进</div>
                <div className='mt-4 ml-1 border-l border-violet-300'>{lines.map((line, lineIndex) => <div key={lineIndex} className='relative pl-5 pb-4 last:pb-0'><span className='absolute -left-1 top-1.5 w-2 h-2 rounded-full bg-violet-500 ring-4 ring-stone-100' /><div className='text-[9px] font-bold text-violet-500'>{line.label || `节点 ${lineIndex + 1}`}</div><div className='mt-1 text-[12px] leading-6 text-slate-700'>{line.value}</div></div>)}</div>
            </section>;
            if (block.kind === 'theater') {
                const theater = block.theater;
                return <details key={index} className='group border-y border-violet-200'>
                    <summary className='list-none cursor-pointer py-4 flex items-center gap-3'><span className='w-8 h-8 rounded-full bg-violet-100 text-violet-600 grid place-items-center'><ChatCircleDots size={16} weight='fill' /></span><span className='min-w-0 flex-1'><span className='block text-[9px] tracking-[.16em] font-bold text-violet-500'>幕间频道</span><strong className='block mt-0.5 truncate text-sm font-semibold text-slate-700'>{theater?.title || block.title || '小剧场'}</strong></span><span className='shrink-0 text-[9px] text-slate-400'>{theater?.messages.length || 0} 条</span><CaretDown size={13} className='text-violet-500 transition-transform group-open:rotate-180' /></summary>
                    <div className='pb-5'>{theater?.system && <div className='ml-11 pl-3 border-l-2 border-violet-200 text-[10px] leading-5 text-slate-500'>{theater.system}</div>}
                    <div className='mt-4 space-y-3'>{(theater?.messages || []).map((message, messageIndex) => <div key={messageIndex} className={`flex ${message.side === 'right' ? 'justify-end' : 'justify-start'}`}><div className='max-w-[86%]'><div className={`mb-1 text-[8px] font-bold text-slate-400 ${message.side === 'right' ? 'text-right' : ''}`}>{message.name}</div><div className={`px-3 py-2 rounded-2xl text-[11px] leading-5 ${message.side === 'right' ? 'bg-violet-100 text-violet-900 rounded-br-sm' : 'bg-white border border-slate-200 text-slate-700 rounded-bl-sm'}`}>{message.text}</div></div></div>)}</div></div>
                </details>;
            }
            if (block.kind === 'choices') {
                const replies = lines.filter(line => line.label === '推进' && line.value).map(line => line.value);
                const options = replies.length > 0 ? replies : lines.filter(line => line.value).map(line => line.value);
                return <section key={index} className='py-4 border-y border-slate-300'><div className='flex items-center gap-2 text-[10px] font-bold text-slate-600'><ArrowBendDownRight size={15} />下一步可以这样写</div><div className='mt-3 divide-y divide-slate-200'>{options.map((option, optionIndex) => <button key={optionIndex} onClick={() => onChoose?.(option)} className='w-full py-3 flex items-start gap-3 text-left'><span className='w-5 h-5 shrink-0 rounded-full bg-violet-100 text-violet-700 grid place-items-center text-[9px] font-bold'>{optionIndex + 1}</span><span className='text-[12px] leading-5 text-slate-700'>{option}</span></button>)}</div></section>;
            }
            if (block.kind === 'affinity') {
                const personGroups = groupDisplayLines(lines, '人物', ['角色 ID']);
                const groups = personGroups.length > 0 ? personGroups : [{ title: '主要角色', lines: lines.filter(line => line.label !== '角色 ID') }];
                const preview = groups.slice(0, 3).map(group => {
                    const cToU = affinityNumber(group.lines, ['角色对你的温度', '关系温度']);
                    const uToC = affinityNumber(group.lines, ['你对角色的温度', '你的关系温度']);
                    return `${group.title}${cToU !== undefined ? `→你 ${cToU}` : ''}${uToC !== undefined ? ` · 你→${group.title} ${uToC}` : ''}`;
                }).join(' · ');
                return <details key={index} className='group border-y border-rose-200'>
                    <summary className='list-none cursor-pointer py-3.5 flex items-center gap-3'><span className='w-8 h-8 rounded-full bg-rose-50 text-rose-500 grid place-items-center'><HeartStraight size={15} weight='fill' /></span><span className='min-w-0 flex-1'><strong className='block text-xs text-rose-700'>双向关系 · {groups.length} 位角色</strong><span className='block mt-0.5 truncate text-[9px] text-slate-400'>{preview || '展开查看逐角色温度与关系维度'}</span></span><CaretDown size={13} className='text-rose-400 transition-transform group-open:rotate-180' /></summary>
                    <div className='pb-3 pl-11 divide-y divide-rose-100'>{groups.map((group, groupIndex) => <StoryAffinityGroup key={`${group.title}-${groupIndex}`} group={group} />)}</div>
                </details>;
            }
            return <section key={index} className='pl-4 border-l-2 border-slate-300'><div className='text-[10px] font-bold text-slate-500'>{block.title || '附加信息'}</div><div className='mt-2'><LabeledRows lines={lines} /></div></section>;
        })}
    </div>;
    return reading ? <div><div className='meeting-prose'>{blocks.filter(block=>block.kind==='story').map((block,index)=><p key={index}>{block.text}</p>)}</div>{(blocks.some(block=>block.kind!=='story')||relationship)&&<details className='mt-5 text-slate-500'><summary className='cursor-pointer text-xs py-2'>场景与补充</summary>{rendered}</details>}</div> : rendered;
};

const StoryTheaterSession: React.FC<Props> = ({ entry, preset, masks, onBack, onEdit, onOpenVectorMemory, onOpenArchives, onEntryChange }) => {
    const { characters, userProfile, apiConfig, memoryPalaceConfig, remoteVectorConfig, updateCharacter, addToast } = useOS();
    const threadId = storyTheaterThreadId(entry.id);
    const actors = useMemo(() => characters.filter(char => entry.characterIds.includes(char.id)), [characters, entry.characterIds]);
    const memoryActors = useMemo(() => {
        const recipientIds = new Set(storyTheaterMemoryRecipientIds(entry));
        return characters.filter(char => recipientIds.has(char.id));
    }, [characters, entry]);
    const mask = useMemo(() => resolveStoryTheaterMask(entry.mask, userProfile, characters, masks), [characters, entry.mask, masks, userProfile]);
    const youLabel = mask.selection.type === 'user' ? '你' : `你（${mask.name}）`;
    const promptIdentityName = mask.name.trim() && mask.name.trim() !== '你' ? mask.name.trim() : '当前用户侧角色';
    const effectivePreset = useMemo<StoryTheaterPreset>(() => ({
        ...preset,
        document: resolveStoryPresetDocument(preset, entry.presetOverride),
    }), [entry.presetOverride, preset]);
    const activeMiniTheater = useMemo(() => getActiveStoryMiniTheaterPrompt(effectivePreset.document), [effectivePreset.document]);
    const affinityEnabled = useMemo(() => effectivePreset.document.prompts.some(prompt => prompt.id === 'nmj-v65-affinity-control' && prompt.enabled), [effectivePreset.document]);
    const selectedBooks = useMemo(() => dedupeTheaterWorldbooks(actors).filter(book => entry.selectedWorldbookIds.includes(book.id)), [actors, entry.selectedWorldbookIds]);
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const [memoryStatus, setMemoryStatus] = useState('');
    const [contextTokens, setContextTokens] = useState(0);
    const [contextTokensExact, setContextTokensExact] = useState(false);
    const [showAffinityInput, setShowAffinityInput] = useState(false);
    const [affinityDrafts, setAffinityDrafts] = useState<Record<string, AffinityDraft>>({});
    const [selectedAffinityActorId, setSelectedAffinityActorId] = useState('');
    const [messagePage, setMessagePage] = useState(0);
    const [expandedArchivedIds, setExpandedArchivedIds] = useState<Set<number>>(() => new Set());
    const [exporting, setExporting] = useState(false);
    const [showQuickPreset, setShowQuickPreset] = useState(false);
    const [rerollingId, setRerollingId] = useState<number | null>(null);
    const [messageMenu, setMessageMenu] = useState<Message | null>(null);
    const [editingMessage, setEditingMessage] = useState<Message | null>(null);
    const [deletingMessage, setDeletingMessage] = useState<Message | null>(null);
    const [editDraft, setEditDraft] = useState('');
    const [mutatingMessage, setMutatingMessage] = useState(false);
    // React state does not update synchronously. A rapid double tap can enter send()
    // twice before `sending` re-renders the disabled button, creating two billable
    // completions. Keep the state for UI only and use this ref as the real mutex.
    const sendLock = useRef(false);
    const archiveLock = useRef(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressOrigin = useRef<{ x: number; y: number } | null>(null);

    const loadMessages = useCallback(async () => {
        const rows = await DB.getMessagesByCharId(threadId, true);
        setMessages(rows.filter(message => message.metadata?.source === 'story_theater').sort((a, b) => a.id - b.id));
    }, [threadId]);

    useEffect(() => { void loadMessages(); }, [loadMessages]);
    useEffect(() => {
        setContextTokens(0);
        setContextTokensExact(false);
        setShowAffinityInput(false);
        setAffinityDrafts({});
        setSelectedAffinityActorId('');
        setExpandedArchivedIds(new Set());
        setMessageMenu(null);
        setEditingMessage(null);
        setDeletingMessage(null);
    }, [entry.id]);
    const patchAffinityDraft = useCallback((characterId: string, patch: Partial<AffinityDraft>) => {
        setAffinityDrafts(current => ({
            ...current,
            [characterId]: { ...(current[characterId] || EMPTY_AFFINITY_DRAFT), ...patch },
        }));
    }, []);
    const cancelLongPress = useCallback(() => {
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
        longPressOrigin.current = null;
    }, []);
    useEffect(() => () => cancelLongPress(), [cancelLongPress]);
    const beginLongPress = useCallback((message: Message, event: React.PointerEvent<HTMLElement>) => {
        if ((event.target as HTMLElement).closest('button, a, input, textarea, select, summary')) return;
        cancelLongPress();
        longPressOrigin.current = { x: event.clientX, y: event.clientY };
        longPressTimer.current = setTimeout(() => {
            setMessageMenu(message);
            longPressTimer.current = null;
            longPressOrigin.current = null;
        }, 520);
    }, [cancelLongPress]);
    const moveLongPress = useCallback((event: React.PointerEvent<HTMLElement>) => {
        const origin = longPressOrigin.current;
        if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) cancelLongPress();
    }, [cancelLongPress]);
    const openMessageMenu = useCallback((message: Message, event?: React.MouseEvent<HTMLElement>) => {
        event?.preventDefault();
        if (event && (event.target as HTMLElement).closest('button, a, input, textarea, select, summary')) return;
        cancelLongPress();
        setMessageMenu(message);
    }, [cancelLongPress]);
    const pressHandlersFor = (message: Message) => ({
        onPointerDown: (event: React.PointerEvent<HTMLElement>) => beginLongPress(message, event),
        onPointerMove: moveLongPress,
        onPointerUp: cancelLongPress,
        onPointerCancel: cancelLongPress,
        onPointerLeave: cancelLongPress,
        onContextMenu: (event: React.MouseEvent<HTMLElement>) => openMessageMenu(message, event),
    });

    const relatedMessageIds = useCallback((message: Message): number[] => {
        const mirrorIds = Object.values((message.metadata?.theaterMirrorIds || {}) as Record<string, number>).map(Number).filter(id => Number.isFinite(id) && id > 0);
        return [...new Set([message.id, ...mirrorIds])];
    }, []);
    const saveMessageEdit = useCallback(async () => {
        if (!editingMessage || !editDraft.trim() || mutatingMessage) return;
        setMutatingMessage(true);
        try {
            await Promise.all(relatedMessageIds(editingMessage).map(id => DB.updateMessage(id, editDraft.trim())));
            await loadMessages();
            setEditingMessage(null);
            setEditDraft('');
            addToast(entry.writesToCharacterMemory ? '这一层和角色侧镜像记忆已同步修改' : '这一层已修改', 'success');
        } catch (error: any) {
            addToast(`修改失败：${error?.message || error}`, 'error');
        } finally {
            setMutatingMessage(false);
        }
    }, [addToast, editDraft, editingMessage, entry.writesToCharacterMemory, loadMessages, mutatingMessage, relatedMessageIds]);
    const deleteStoryMessage = useCallback(async () => {
        if (!deletingMessage || mutatingMessage) return;
        setMutatingMessage(true);
        try {
            await DB.deleteMessages(relatedMessageIds(deletingMessage));
            await loadMessages();
            setDeletingMessage(null);
            addToast(entry.writesToCharacterMemory ? '这一层和角色侧镜像记忆已同步删除' : '这一层已删除', 'success');
        } catch (error: any) {
            addToast(`删除失败：${error?.message || error}`, 'error');
        } finally {
            setMutatingMessage(false);
        }
    }, [addToast, deletingMessage, entry.writesToCharacterMemory, loadMessages, mutatingMessage, relatedMessageIds]);
    useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, sending]);
    const pageCount = Math.max(1, Math.ceil(messages.length / STORY_PAGE_SIZE));
    useEffect(() => { setMessagePage(Math.max(0, pageCount - 1)); }, [messages.length, pageCount]);
    const pageMessages = useMemo(() => messages.slice(messagePage * STORY_PAGE_SIZE, (messagePage + 1) * STORY_PAGE_SIZE), [messagePage, messages]);
    const pageArchivedIds = useMemo(() => pageMessages.filter(message => mirrorArchived(message, entry)).map(message => message.id), [entry, pageMessages]);
    const allPageArchivesExpanded = pageArchivedIds.length > 0 && pageArchivedIds.every(id => expandedArchivedIds.has(id));
    const togglePageArchives = useCallback(() => {
        setExpandedArchivedIds(current => {
            const next = new Set(current);
            if (pageArchivedIds.every(id => next.has(id))) pageArchivedIds.forEach(id => next.delete(id));
            else pageArchivedIds.forEach(id => next.add(id));
            return next;
        });
    }, [pageArchivedIds]);
    const setArchiveExpanded = useCallback((messageId: number, open: boolean) => {
        setExpandedArchivedIds(current => {
            if (current.has(messageId) === open) return current;
            const next = new Set(current);
            if (open) next.add(messageId);
            else next.delete(messageId);
            return next;
        });
    }, []);
    const storedTokenInfo = useMemo(() => {
        const source = [...messages].reverse().find(message => Number(message.metadata?.theaterPromptTokens) > 0);
        return source ? {
            count: Number(source.metadata.theaterPromptTokens),
            exact: source.metadata.theaterPromptTokensExact === true,
        } : { count: 0, exact: false };
    }, [messages]);
    const displayedTokenInfo = contextTokens > 0 ? { count: contextTokens, exact: contextTokensExact } : storedTokenInfo;

    const exportStory = useCallback(async () => {
        if (messages.length === 0 || exporting) {
            if (messages.length === 0) addToast('暂无可导出的剧情原文', 'info');
            return;
        }
        setExporting(true);
        try {
            const result = await shareOrDownloadFile({
                content: formatStoryTheaterExport(entry, mask.name, actors.map(actor => actor.name), messages),
                fileName: makeStoryTheaterFileName(entry.title),
                mimeType: 'text/plain;charset=utf-8',
                shareTitle: `${entry.title || '未命名剧情'}的完整原文`,
            });
            addToast(result === 'shared' ? '已打开分享面板' : '剧情原文已导出', 'success');
        } catch (error: any) {
            console.error('[StoryTheater] export failed', error);
            addToast(`剧情原文导出失败：${error?.message || error}`, 'error');
        } finally {
            setExporting(false);
        }
    }, [actors, addToast, entry, exporting, mask.name, messages]);

    const callCompletion = useCallback(async (payload: Array<{ role: string; content: string }>, settings?: Partial<StoryGenerationSettings>, onPromptTokens?: (tokens: number) => void): Promise<string> => {
        const generationSettings = prepareStoryGenerationSettings(settings, entry.omitSamplingParams === true);
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({ model: apiConfig.model, messages: payload, stream: false, ...generationSettings }),
            __sullyMeta: { appId: 'date', appName: '见面', purpose: '剧情见面生成' },
        } as RequestInit & { __sullyMeta: { appId: string; appName: string; purpose: string } });
        const data = await safeResponseJson(response);
        if (!response.ok) throw new Error(describeStoryApiError(response.status, data));
        const reportedPromptTokens = Number(data?.usage?.prompt_tokens);
        if (Number.isFinite(reportedPromptTokens) && reportedPromptTokens > 0) onPromptTokens?.(reportedPromptTokens);
        const content = extractContent(data).trim();
        if (!content) throw new Error(describeEmptyStoryCompletion(data));
        return content;
    }, [apiConfig, entry.omitSamplingParams]);

    const saveCentralAndMirrors = useCallback(async (role: 'user' | 'assistant', content: string, centralMetadata: Record<string, unknown> = {}): Promise<number> => {
        const now = Date.now();
        const centralId = await DB.saveMessage({ charId: threadId, role, type: 'text', content, timestamp: now, metadata: { source: 'story_theater', theaterId: entry.id, ...centralMetadata } });
        if (!entry.writesToCharacterMemory) return centralId;
        const theaterMirrorIds: Record<string, number> = {};
        for (const actor of memoryActors) {
            theaterMirrorIds[actor.id] = await DB.saveMessage(createStoryTheaterMirrorMessage(
                entry, actor.id, { id: centralId, role, content, timestamp: now },
            ));
        }
        await DB.updateMessageMetadata(centralId, previous => ({ ...previous, theaterMirrorIds }));
        return centralId;
    }, [entry, memoryActors, threadId]);

    const buildActorContexts = useCallback(async (query: string): Promise<string> => {
        const allBookIds = new Set(actors.flatMap(actor => (actor.mountedWorldbooks || []).map(book => book.id)));
        const blocks: string[] = [];
        for (const actor of actors) {
            if (!entry.carryCharacterMemory) {
                blocks.push(buildBareTheaterActorContext(actor));
                continue;
            }
            const limit = Math.max(0, Math.min(500, entry.characterContextLimits[actor.id] ?? 100));
            const recent = await loadStoryActorContext(actor, entry.id, limit);
            let recalled = '';
            const embedding = memoryPalaceConfig.embedding;
            if (actor.memoryPalaceEnabled && embedding?.baseUrl && embedding?.apiKey) {
                const rawRecall = await retrieveMemories(recent, actor.id, embedding, actor.activeBuffs?.[0]?.name, actor.personalityStyle || 'emotional', actor.ruminationTendency ?? 0.3, query, userProfile.name, remoteVectorConfig, actor.name);
                recalled = buildStoryActorMemoryEnvelope(actor.name, rawRecall, userProfile.name, mask.name);
            }
            const theaterActor = { ...actor, memoryPalaceInjection: recalled };
            const core = (await ContextBuilder.buildCoreContext(theaterActor, userProfile, true, recalled, {
                skipUserProfile: true,
                skipWorldbookIds: allBookIds,
                headerOverride: `[剧情角色：${actor.name}]`,
            }, { skipTimeAwareness: true }));
            blocks.push(`${core}\n${formatActorRecentMessages(actor, recent, userProfile.name, mask.name)}`.trim());
        }
        return blocks.join('\n\n---\n\n');
    }, [actors, entry.id, entry.carryCharacterMemory, entry.characterContextLimits, mask.name, memoryPalaceConfig.embedding, remoteVectorConfig, userProfile]);

    const buildMaskMemoryContext = useCallback(async (query: string): Promise<string> => {
        if (!entry.carryCharacterMemory || !mask.characterId) return '';
        const maskCharacter = characters.find(char => char.id === mask.characterId);
        if (!maskCharacter) return '';
        const limit = Math.max(0, Math.min(500, entry.characterContextLimits[maskCharacter.id] ?? 100));
        const recent = await loadStoryActorContext(maskCharacter, entry.id, limit);
        let recalled = '';
        const embedding = memoryPalaceConfig.embedding;
        if (maskCharacter.memoryPalaceEnabled && embedding?.baseUrl && embedding?.apiKey) {
            const rawRecall = await retrieveMemories(recent, maskCharacter.id, embedding, maskCharacter.activeBuffs?.[0]?.name, maskCharacter.personalityStyle || 'emotional', maskCharacter.ruminationTendency ?? 0.3, query, userProfile.name, remoteVectorConfig, maskCharacter.name);
            recalled = buildStoryActorMemoryEnvelope(maskCharacter.name, rawRecall, userProfile.name, mask.name);
        }
        const skipWorldbookIds = new Set([
            ...(maskCharacter.mountedWorldbooks || []).map(book => book.id),
            ...actors.flatMap(actor => (actor.mountedWorldbooks || []).map(book => book.id)),
        ]);
        const core = (await ContextBuilder.buildCoreContext({ ...maskCharacter, memoryPalaceInjection: recalled }, userProfile, true, recalled, {
            skipUserProfile: true,
            skipWorldbookIds,
            headerOverride: `[你当前身份的既有记忆：${maskCharacter.name}]`,
        }, { skipTimeAwareness: true }));
        return `${core}\n${formatActorRecentMessages(maskCharacter, recent, userProfile.name, mask.name)}`.trim();
    }, [actors, characters, entry.id, entry.carryCharacterMemory, entry.characterContextLimits, mask.characterId, mask.name, memoryPalaceConfig.embedding, remoteVectorConfig, userProfile]);

    const independentRecall = useCallback(async (query: string, recent: Message[], activeEntry: StoryTheaterEntry = entry): Promise<string> => {
        if (activeEntry.writesToCharacterMemory || !activeEntry.archives.some(archive => archive.strategy === 'vector')) return '';
        const embedding = memoryPalaceConfig.embedding;
        if (!embedding?.baseUrl || !embedding?.apiKey) return '（本剧情存在向量归档，但当前没有可用的向量记忆配置。）';
        return retrieveMemories(recent, threadId, embedding, undefined, 'emotional', 0.3, query, mask.name, remoteVectorConfig, activeEntry.title);
    }, [entry, mask.name, memoryPalaceConfig.embedding, remoteVectorConfig, threadId]);

    const applyActorMemoryPipeline = useCallback(async () => {
        if (!entry.writesToCharacterMemory) return;
        const embedding = memoryPalaceConfig.embedding;
        const light = memoryPalaceConfig.lightLLM?.baseUrl ? memoryPalaceConfig.lightLLM : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
        if (!embedding?.baseUrl || !embedding?.apiKey || !light.baseUrl) return;
        for (const actor of memoryActors) {
            if (!actor.memoryPalaceEnabled) continue;
            try {
                setMemoryStatus(`${actor.name}正在整理这段相处……`);
                const recent = await DB.getRecentMessagesByCharId(actor.id, 50);
                await processNewMessagesWithAutoArchive(recent, actor.id, actor.name, embedding, light, mask.name, false, setMemoryStatus);
                if (incrementDigestRound(actor.id)) {
                    await runCognitiveDigestion(actor.id, actor.name, [actor.systemPrompt, actor.worldview].filter(Boolean).join('\n'), light, false, mask.name, embedding);
                }
            } catch (error: any) {
                console.warn('[StoryTheater] actor memory pipeline failed', actor.id, error?.message || error);
            }
        }
        setMemoryStatus('');
        await loadMessages();
    }, [apiConfig, characters, entry.writesToCharacterMemory, loadMessages, mask.name, memoryActors, memoryPalaceConfig, updateCharacter]);

    const archiveIfNeeded = useCallback(async (): Promise<StoryTheaterEntry | null> => {
        if (entry.writesToCharacterMemory || archiveLock.current) return null;
        archiveLock.current = true;
        try {
            const rows = (await DB.getMessagesByCharId(threadId, true))
                .filter(message => message.metadata?.source === 'story_theater' && !message.metadata?.theaterArchived)
                .sort((a, b) => a.id - b.id);
            const batch = selectStoryArchiveBatch(rows, entry.archiveAfter, entry.archiveKeepRecent ?? 5);
            if (batch.length === 0) return null;
            const first = batch[0];
            const last = batch[batch.length - 1];
            let summary: string | undefined;

            if (entry.archiveStrategy === 'summary') {
                setMemoryStatus(`正在把 ${batch.length} 条正文压成事件盒……`);
                summary = await generateStoryArchiveSummary(entry.title, batch, apiConfig);
            } else {
                const embedding = memoryPalaceConfig.embedding;
                const light = memoryPalaceConfig.lightLLM?.baseUrl ? memoryPalaceConfig.lightLLM : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
                if (!embedding?.baseUrl || !embedding?.apiKey || !light.baseUrl) {
                    addToast('独立向量归档需要先完成向量记忆配置', 'error');
                    return null;
                }
                setMemoryStatus(`正在整理并存入「${entry.title}」的专属剧情记忆……`);
                const result = await processMessageRange(threadId, entry.title, embedding, light, first.id, last.id, mask.name, setMemoryStatus);
                if (result.error && result.stored === 0 && result.skipped === 0) throw new Error('这批正文没有生成可用的向量记忆');
            }

            await Promise.all(batch.map(message => DB.updateMessageMetadata(message.id, previous => ({ ...previous, theaterArchived: true, theaterArchiveStrategy: entry.archiveStrategy }))));
            const next: StoryTheaterEntry = {
                ...entry,
                archives: [...entry.archives, {
                    id: makeStoryTheaterId(),
                    strategy: entry.archiveStrategy,
                    fromMessageId: first.id,
                    toMessageId: last.id,
                    messageCount: batch.length,
                    ...(summary ? { summary } : {}),
                    createdAt: Date.now(),
                }],
                updatedAt: Date.now(),
            };
            await onEntryChange(next);
            await loadMessages();
            addToast(entry.archiveStrategy === 'summary' ? '旧正文已收进事件盒' : '旧正文已存入本剧情专属记忆', 'success');
            return next;
        } catch (error: any) {
            console.error('[StoryTheater] archive failed', error);
            addToast(`剧情归档失败：${error?.message || error}`, 'error');
            return null;
        } finally {
            archiveLock.current = false;
            setMemoryStatus('');
        }
    }, [addToast, apiConfig, entry, loadMessages, mask.name, memoryPalaceConfig, onEntryChange, threadId]);

    const send = useCallback(async (rerollTarget?: Message, continueRequested = false) => {
        if (sendLock.current || actors.length === 0) return;
        sendLock.current = true;
        setSending(true);
        setRerollingId(rerollTarget?.id || null);
        try {
            const before = (await DB.getMessagesByCharId(threadId, true))
                .filter(message => message.metadata?.source === 'story_theater')
                .sort((a, b) => a.id - b.id);
            const latest = before[before.length - 1];
            const isReroll = Boolean(rerollTarget && latest?.id === rerollTarget.id && latest.role === 'assistant' && !mirrorArchived(latest, entry));
            if (rerollTarget && !isReroll) return;
            const openingPrompt = `请直接写出「${entry.title}」的第一幕。${entry.premise ? `剧情介绍：${entry.premise}` : '没有额外剧情介绍，请根据角色、世界与预设自然建立场景。'}直接开始，不要求补充信息，也不要替当前由你执笔的身份做重大决定。`;
            const typedText = input.trim();
            const rerollIndex = isReroll ? before.findIndex(message => message.id === rerollTarget?.id) : -1;
            const previousUser = rerollIndex > 0 ? [...before.slice(0, rerollIndex)].reverse().find(message => message.role === 'user') : undefined;
            const assistantOpening = !isReroll && !continueRequested && before.length === 0 && entry.openingMode === 'assistant' && !typedText;
            const text = isReroll
                ? (previousUser?.content.trim() || openingPrompt)
                : (continueRequested ? MEETING_CONTINUE_DISPLAY_TEXT : (typedText || getPendingStoryRetryInput(before) || (assistantOpening ? openingPrompt : '')));
            if (!text) return;
            const retry = !isReroll && latest?.role === 'user' && latest.content === text;
            // 重新生成与失败重试都从消息标记恢复“继续”，模型始终收到模式专属调度词；
            // 数据库、阅读页与角色镜像只留下简洁的“（继续）”。
            const isContinueTurn = isReroll
                ? previousUser?.metadata?.theaterContinue === true
                : continueRequested || (retry && latest?.metadata?.theaterContinue === true);
            const modelText = isContinueTurn ? buildStoryContinueInstruction(promptIdentityName) : text;
            const draftAffinityInputs = affinityEnabled ? actors.map(actor => {
                const draft = affinityDrafts[actor.id] || EMPTY_AFFINITY_DRAFT;
                return normalizeAffinityInput({ ...draft, characterId: actor.id, characterName: actor.name }, actor);
            }).filter((value): value is StoryAffinityInput => Boolean(value)) : [];
            const savedAffinityInputs = affinityInputsFromMessage(isReroll ? previousUser : retry ? latest : undefined, actors);
            const rerollAffinityInputs = isReroll ? affinityInputsFromMessage(rerollTarget, actors) : [];
            const affinityInputs = savedAffinityInputs.length > 0 ? savedAffinityInputs : rerollAffinityInputs.length > 0 ? rerollAffinityInputs : draftAffinityInputs;
            const userMessageId = isReroll
                ? (previousUser?.id || 0)
                : assistantOpening
                    ? 0
                    : retry
                        ? latest.id
                        : await saveCentralAndMirrors('user', text, {
                            ...(affinityInputs.length > 0 ? { theaterAffinityInputs: affinityInputs } : {}),
                            ...(isContinueTurn ? { theaterContinue: true } : {}),
                        });
            if (!isReroll && !assistantOpening) await loadMessages();

            // 归档不能只放在成功生成之后：一旦会话已经碰到上游上下文上限，正文永远生成
            // 不出来，后置归档也就永远没有机会执行。重试已有 user 楼层时先归档，窗口可自愈。
            const promptEntry = await archiveIfNeeded() || entry;

            const current = (await DB.getMessagesByCharId(threadId, true))
                .filter(message => message.metadata?.source === 'story_theater')
                .sort((a, b) => a.id - b.id);
            const history = current.filter(message => message.id !== userMessageId && message.id !== rerollTarget?.id);
            const visibleHistory = history.filter(message => !mirrorArchived(message, promptEntry));

            const [actorContext, maskMemoryContext, vectorRecall] = await Promise.all([
                buildActorContexts(modelText),
                buildMaskMemoryContext(modelText),
                independentRecall(modelText, visibleHistory.slice(-8), promptEntry),
            ]);
            const summaries = promptEntry.archives.filter(archive => archive.summary).map((archive, index) => `事件盒 ${index + 1}：${archive.summary}`).join('\n\n');
            const scenario = [
                `### 当前剧情\n标题：${entry.title}\n前提：${entry.premise || '沿用已经发生的正文自然继续。'}`,
                summaries ? `### 常驻事件盒\n${summaries}` : '',
                vectorRecall ? buildStoryArchiveMemoryEnvelope(vectorRecall) : '',
            ].filter(Boolean).join('\n\n');
            const miniTheaterReminder = buildStoryMiniTheaterReminder(effectivePreset.document, promptIdentityName, actors.map(actor => actor.name));
            const backstageAftermathReminder = buildStoryBackstageAftermathReminder(effectivePreset.document);
            const multiAffinityGuide = affinityEnabled ? buildStoryMultiAffinityGuide(actors.map(actor => ({ id: actor.id, name: actor.name }))) : '';
            const affinityAwarenessReminder = affinityInputs.map(item => buildStoryAffinityAwarenessReminder(item, item.characterName || '当前角色')).filter(Boolean).join('\n\n');
            const identityGuard = buildStoryIdentityGuard(effectivePreset.document, promptIdentityName, actors.map(actor => actor.name));
            const modelInput = appendStoryAffinityInputs(modelText, affinityInputs);
            const historyMessages = buildStoryHistory(visibleHistory).map(message => ({
                ...message,
                content: '[' + (message.role === 'user' ? promptIdentityName + '给出的推进（用户侧）' : '上一层剧场正文') + ']\n' + message.content,
            }));
            const pendingTurn = { role: 'user' as const, content: modelInput };
            let compiled!: ReturnType<typeof compileStoryPreset>;
            const payload = ContextBuilder.buildWorldbookRequest<StoryApiMessage>({
                books: selectedBooks, userName: promptIdentityName, charName: actors.map(actor => actor.name).join('、'),
                history: [...(effectivePreset.document.prompts.some(prompt => prompt.enabled && prompt.marker === 'history') ? historyMessages : []), pendingTurn],
                render: slots => {
                    compiled = compileStoryPreset({
                        preset: effectivePreset, userName: promptIdentityName, characterNames: actors.map(actor => actor.name),
                        historyMessages,
                        slots: {
                            actors: actorContext,
                            persona: [buildTheaterPersona(mask), maskMemoryContext].filter(Boolean).join('\n\n'),
                            scenario, worldBefore: slots.before, worldAfter: slots.after, history: '',
                        },
                    });
                    const payloadBeforeTurn = [
                    ...compiled.messages,
                    ...(promptEntry.writesToCharacterMemory ? [{ role: 'system' as const, content: REAL_COMPANION_MEMORY_GUARD }] : []),
                    ...(backstageAftermathReminder ? [{ role: 'system' as const, content: backstageAftermathReminder }] : []),
                    ...(miniTheaterReminder ? [{ role: 'system' as const, content: miniTheaterReminder }] : []),
                    ...(multiAffinityGuide ? [{ role: 'system' as const, content: multiAffinityGuide }] : []),
                    ...(affinityEnabled ? [{ role: 'system' as const, content: RELATIONSHIP_TEXTURE_GUIDE }] : []),
                    ...(affinityAwarenessReminder ? [{ role: 'system' as const, content: affinityAwarenessReminder }] : []),
                    { role: 'system' as const, content: identityGuard },
                    ...(isReroll ? [{ role: 'system' as const, content: STORY_REROLL_INSTRUCTION }] : []),
                ];
                    // appendStoryUserTurn 保留预填充/兼容规则，再替换本轮消息为公共管线认识的引用。
                    const assembled = appendStoryUserTurn(payloadBeforeTurn, modelInput, compiled.assistantPrefill, promptEntry.forceUserLastMessage === true);
                    const pendingIndex = compiled.assistantPrefill && !promptEntry.forceUserLastMessage ? assembled.length - 2 : assembled.length - 1;
                    assembled[pendingIndex] = pendingTurn;
                    return assembled;

                    },
            });
            if (promptEntry.forceUserLastMessage && payload[payload.length - 1]?.role !== 'user') {
                payload.push({ role: 'user', content: '请按以上要求继续本轮剧情。' });
            }
            let promptTokenCount = estimateStoryTokens(payload.map(message => `${message.role}\n${message.content}`).join('\n'));
            let promptTokenCountExact = false;
            setContextTokens(promptTokenCount);
            setContextTokensExact(false);
            const generated = await callCompletion(payload, compiled.settings, reported => {
                promptTokenCount = reported;
                promptTokenCountExact = true;
                setContextTokens(reported);
                setContextTokensExact(true);
            });
            const prefill = compiled.assistantPrefill?.content || '';
            const rawContent = prefill && !generated.startsWith(prefill) ? `${prefill}${generated}` : generated;
            // 关系绝对值要承接最近一轮，即使那轮刚被折叠进事件盒，也不能回退到 50。
            const previousAssistantContent = [...history].reverse().find(message => message.role === 'assistant')?.content || '';
            const content = affinityEnabled
                ? reconcileStoryAffinityScores(
                    rawContent,
                    previousAssistantContent,
                    affinityInputs,
                    actors.map(actor => ({ id: actor.id, name: actor.name })),
                )
                : rawContent;
            const replyMetadata = {
                theaterPromptTokens: promptTokenCount,
                theaterPromptTokensExact: promptTokenCountExact,
                ...(affinityInputs.length > 0 ? { theaterAffinityInputs: affinityInputs } : {}),
            };
            if (isReroll && rerollTarget) {
                if (mirrorArchived(rerollTarget, promptEntry)) throw new Error('这条回复已进入记忆归档，请刷新后查看');
                await replaceStoryTheaterReply(rerollTarget, content, replyMetadata);
            } else {
                await saveCentralAndMirrors('assistant', content, replyMetadata);
            }
            if (!isContinueTurn) setInput('');
            setAffinityDrafts({});
            setShowAffinityInput(false);
            await loadMessages();
            if (entry.writesToCharacterMemory) void applyActorMemoryPipeline();
            else void archiveIfNeeded();
        } catch (error: any) {
            console.error('[StoryTheater] send failed', error);
            const message = String(error?.message || error);
            const isOpaqueBrowserFailure = /load failed|failed to fetch|networkerror|network request failed/i.test(message);
            addToast(
                isOpaqueBrowserFailure
                    ? '剧情请求被上游/网关断开，浏览器读不到真实错误。若陪伴原版同 API 正常，可在剧情设置尝试“不发送高级采样参数”或“400 兼容模式”；请求差异已写入 Network 日志，请勿连续重发。'
                    : message.includes('API Error 400') && isStoryUserLastCompatibilityError(message) && !entry.forceUserLastMessage
                    ? '剧情续写失败：API 400。若日志提示最后一条必须是 user，可在右上角设置开启“400 兼容模式”；更建议更换模型。'
                    : `剧情续写失败：${message}`,
                'error',
            );
        } finally {
            sendLock.current = false;
            setSending(false);
            setRerollingId(null);
        }
    }, [actors, addToast, affinityDrafts, affinityEnabled, applyActorMemoryPipeline, archiveIfNeeded, buildActorContexts, buildMaskMemoryContext, callCompletion, effectivePreset, entry, independentRecall, input, loadMessages, mask, promptIdentityName, saveCentralAndMirrors, selectedBooks, threadId]);

    const archivedCount = messages.filter(message => mirrorArchived(message, entry)).length;
    const pendingRetryInput = getPendingStoryRetryInput(messages);
    const canWriteOpening = messages.length === 0 && entry.openingMode === 'assistant';
    const filledAffinityActorIds = actors.filter(actor => {
        const draft = affinityDrafts[actor.id];
        return Boolean(draft && (draft.delta !== 0 || draft.reason.trim()));
    }).map(actor => actor.id);
    const selectedAffinityActor = actors.find(actor => actor.id === selectedAffinityActorId) || actors[0];
    const selectedAffinityDraft = selectedAffinityActor ? (affinityDrafts[selectedAffinityActor.id] || EMPTY_AFFINITY_DRAFT) : EMPTY_AFFINITY_DRAFT;

    return <div className='relative h-full w-full flex flex-col bg-stone-100 text-slate-800'>
        <header className='story-safe-header shrink-0 bg-stone-100/95 backdrop-blur border-b border-slate-200 z-10'>
            <div className='h-16 px-4 flex items-center gap-3'>
                <button onClick={onBack} className='w-9 h-9 rounded-full grid place-items-center'><ArrowLeft size={20} /></button>
                <div className='min-w-0 flex-1'><div className='text-[9px] tracking-[.24em] uppercase font-bold text-violet-500'>Story theater</div><h1 className='font-serif font-semibold truncate'>{entry.title}</h1></div>
                {onOpenArchives && <button disabled={sending||!!memoryStatus} onClick={onOpenArchives} className='w-9 h-9 rounded-full grid place-items-center text-violet-600 disabled:opacity-30' title='查看事件盒与转化记忆' aria-label='查看事件盒与转化记忆'><Archive size={18} /></button>}
                {onOpenVectorMemory && <button onClick={onOpenVectorMemory} className='w-9 h-9 rounded-full grid place-items-center text-violet-600' title='本剧情向量记忆' aria-label='本剧情向量记忆'><Database size={18} /></button>}
                <button disabled={exporting || messages.length === 0} onClick={() => void exportStory()} className='w-9 h-9 rounded-full grid place-items-center text-violet-600 disabled:opacity-30' title='导出全部剧情原文' aria-label='导出全部剧情原文'>{exporting ? <SpinnerGap size={18} className='animate-spin' /> : <DownloadSimple size={18} />}</button>
                <StoryAppearanceButton />
                <button onClick={onEdit} className='w-9 h-9 rounded-full grid place-items-center'><GearSix size={19} /></button>
            </div>
            <details className='group'>
                <summary className='list-none cursor-pointer px-5 pb-3 flex items-center gap-3'>
                    <span className='flex -space-x-1.5 shrink-0'>{mask.avatar ? <TokenImg value={mask.avatar} alt='' className='w-7 h-7 rounded-full object-cover border-2 border-stone-100 relative z-10' /> : <span className='w-7 h-7 rounded-full bg-violet-100 text-violet-700 border-2 border-stone-100 grid place-items-center text-[9px] font-bold relative z-10'>{mask.name.slice(0, 1)}</span>}{actors.slice(0, 2).map(actor => <TokenImg key={actor.id} value={actor.avatar} alt='' className='w-7 h-7 rounded-full object-cover border-2 border-stone-100' />)}</span>
                    <span className='min-w-0 flex-1'><strong className='block truncate text-[11px] text-slate-700'>{youLabel} · 角色：{actors.map(actor => actor.name).join('、')}</strong><span className='block mt-0.5 truncate text-[9px] text-slate-400'>{entry.writesToCharacterMemory ? '真实时间陪伴' : '虚构剧场'}{activeMiniTheater ? ` · ${activeMiniTheater.name.replace(/^\S+小剧场[｜·]?\s*/, '')}` : ''}</span></span>
                    <span className='shrink-0 text-[9px] font-bold text-slate-400' title={displayedTokenInfo.exact ? '本轮实际使用的完整上下文' : '按本轮完整上下文估算'}>{displayedTokenInfo.count > 0 ? `${(displayedTokenInfo.count / 1000).toFixed(displayedTokenInfo.count >= 10000 ? 0 : 1)}k` : '—'}</span>
                    <CaretDown size={13} className='shrink-0 text-slate-400 transition-transform group-open:rotate-180' />
                </summary>
                <div className='mx-5 mb-3 pt-3 border-t border-slate-200 grid grid-cols-2 gap-x-6 gap-y-3 text-[10px]'>
                    <div><span className='block text-[8px] font-bold text-slate-400'>你</span><span className='block mt-1 truncate text-slate-600'>{mask.selection.type === 'user' ? '本人' : mask.name}</span></div>
                    <div><span className='block text-[8px] font-bold text-slate-400'>记忆方式</span><span className='block mt-1 truncate text-slate-600'>{entry.writesToCharacterMemory ? '写入角色记忆' : entry.archiveStrategy === 'summary' ? '独立事件盒' : '独立向量分区'}</span></div>
                    <div><span className='block text-[8px] font-bold text-slate-400'>结尾模块</span><span className='block mt-1 truncate text-slate-600'>{activeMiniTheater?.name || '未启用小剧场'}</span></div>
                    <div><span className='block text-[8px] font-bold text-slate-400'>完整上下文</span><span className='block mt-1 truncate text-slate-600'>{displayedTokenInfo.count > 0 ? `${sending ? '本轮' : '上轮'}${displayedTokenInfo.exact ? '使用' : '估算'} ${displayedTokenInfo.count.toLocaleString()} tokens` : '推进时统计全部内容'}</span></div>
                    <div><span className='block text-[8px] font-bold text-slate-400'>API 兼容</span><span className={`block mt-1 truncate ${entry.forceUserLastMessage ? 'font-semibold text-amber-700' : 'text-slate-600'}`}>{entry.forceUserLastMessage ? '400 兼容模式' : '原生预填（推荐）'}</span></div>
                    <div><span className='block text-[8px] font-bold text-slate-400'>采样参数</span><span className={`block mt-1 truncate ${entry.omitSamplingParams ? 'font-semibold text-amber-700' : 'text-slate-600'}`}>{entry.omitSamplingParams ? '不发送高级参数' : '完整发送预设参数'}</span></div>
                </div>
            </details>
        </header>

        <main className='meeting-reading-page story-page-scroll flex-1 overflow-y-auto px-5 py-7'>
            <div className='max-w-2xl mx-auto'>
                {messages.length === 0 ? <section className='py-10 border-y border-slate-200'>
                    <div className='text-[9px] tracking-[.25em] uppercase font-bold text-violet-500'>Opening note</div>
                    <h2 className='mt-3 text-3xl font-serif font-semibold leading-tight'>{entry.title}</h2>
                    <p className='mt-5 text-sm leading-7 text-slate-600 whitespace-pre-wrap'>{entry.premise || (canWriteOpening ? '人物与世界已经就位，可以让故事先写下第一幕。' : '写下第一句话，让人物走进这座只属于本条剧情的剧场。')}</p>
                    <p className='mt-6 text-[10px] text-slate-400'>{canWriteOpening ? '输入框留空，点击推进即可开场' : '这一幕由你先落笔'}</p>
                </section> : entry.writesToCharacterMemory && <div className='mb-8 py-3 border-y border-amber-200 text-center text-[11px] text-amber-700'>和朋友们已经分别相处了一段时间……</div>}

                {pageCount > 1 && <StoryPagination className='mb-4' page={messagePage} pageCount={pageCount} onChange={setMessagePage} />}
                {pageArchivedIds.length > 0 && <div className='mb-7 px-1 flex items-center justify-between gap-3 text-[9px] text-slate-400'><span>本页共 {pageArchivedIds.length} 条已归档原文 · 点击可展开查看</span><button onClick={togglePageArchives} className='shrink-0 px-3 py-1.5 rounded-full bg-white border border-slate-200 font-bold text-violet-600'>{allPageArchivesExpanded ? '全部收起' : '全部展开'}</button></div>}

                <div className='space-y-8'>
                    {pageMessages.map(message => {
                        const archived = mirrorArchived(message, entry);
                        if (archived) {
                            const archiveLabel = entry.writesToCharacterMemory
                                ? '已作为正常记忆归档'
                                : message.metadata?.theaterArchiveStrategy === 'vector'
                                    ? '已存入本剧情专属记忆'
                                    : '已收进剧场事件盒';
                            const isExpanded = expandedArchivedIds.has(message.id);
                            return <details key={message.id} open={isExpanded} onToggle={event => setArchiveExpanded(message.id, event.currentTarget.open)} className='group border-y border-slate-200'>
                                <summary className='list-none cursor-pointer py-3 flex items-center gap-3 text-slate-400 [&::-webkit-details-marker]:hidden'>
                                    <Archive size={13} className='shrink-0' />
                                    <span className='min-w-0 flex-1'>
                                        <strong className='block text-[10px] font-semibold tracking-wide'>{archiveLabel}</strong>
                                        <span className='block mt-0.5 text-[9px]'>{message.role === 'user' ? '你的推进' : '剧场正文'} · 展开查看原文</span>
                                    </span>
                                    <CaretDown size={14} className='shrink-0 transition-transform group-open:rotate-180' />
                                </summary>
                                {isExpanded && <div className='pb-5 pl-7'>
                                    {message.role === 'user'
                                        ? <p className='text-sm leading-7 text-slate-600 whitespace-pre-wrap'>{message.content}</p>
                                        : <StoryOutput content={message.content} affinityInputs={affinityInputsFromMessage(message, actors)} />}
                                </div>}
                            </details>;
                        }
                        if (message.role === 'user') return <section key={message.id} {...pressHandlersFor(message)} className='meeting-user-turn pl-4 border-l-2 border-violet-300'><div className='meeting-user-label text-[9px] tracking-[.16em] font-bold text-violet-500'>你写下</div><p className='meeting-prose mt-2 text-sm leading-7 text-slate-600 whitespace-pre-wrap'>{message.content}</p></section>;
                        const isLatest = message.id === messages[messages.length - 1]?.id;
                        return <article key={message.id} {...pressHandlersFor(message)}><StoryOutput content={message.content} onChoose={choice => setInput(choice)} affinityInputs={affinityInputsFromMessage(message, actors)} />{isLatest && <div className='mt-4 flex items-center justify-end gap-2'><span className='w-1.5 h-1.5 rounded-full bg-violet-400' /><button disabled={sending} onClick={() => void send(message)} className='inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-200 bg-white text-[10px] font-bold text-slate-500 disabled:opacity-40'>{rerollingId === message.id ? <SpinnerGap size={12} className='animate-spin' /> : <ArrowClockwise size={12} />}换一种写法</button></div>}</article>;
                    })}
                </div>
                {pageCount > 1 && <StoryPagination className='mt-8' page={messagePage} pageCount={pageCount} onChange={setMessagePage} />}
                {archivedCount > 0 && <div className='mt-10 flex items-center justify-center gap-2 text-[9px] text-slate-400'><Archive size={13} />{archivedCount} 条旧内容已归档，仍会通过所选记忆方式参与续写</div>}
                <div ref={bottomRef} className='h-6' />
            </div>
        </main>

        <div className='story-quick-preset pointer-events-none absolute inset-x-0 z-20 px-4'>
            <div className='max-w-2xl mx-auto flex justify-end pr-2'>
                <button onClick={() => setShowQuickPreset(true)} className='pointer-events-auto w-11 h-11 rounded-xl bg-violet-600 text-white shadow-lg grid place-items-center active:scale-95 transition-transform' title='本剧情快速预设' aria-label='本剧情快速预设'><SlidersHorizontal size={19} weight='bold' /></button>
            </div>
        </div>

        <footer className='story-safe-footer shrink-0 px-4 pt-3 bg-stone-100/95 backdrop-blur border-t border-slate-200'>
            <div className='max-w-2xl mx-auto'>
                {memoryStatus && <div className='mb-2 flex items-center gap-2 text-[10px] text-violet-600'><SpinnerGap size={13} className='animate-spin' />{memoryStatus}</div>}
                {!sending && !memoryStatus && !input.trim() && pendingRetryInput && <div className='mb-2 text-[10px] text-violet-600'>上次续写可能中断了，点击推进即可继续</div>}
                {!sending && !memoryStatus && canWriteOpening && <div className='mb-2 text-[10px] text-violet-600'>准备好了，点击推进让故事写下第一幕</div>}
                {affinityEnabled && <div className='mb-2 overflow-hidden rounded-2xl border border-rose-200 bg-rose-50/70'>
                    <button type='button' aria-expanded={showAffinityInput} onClick={() => setShowAffinityInput(value => !value)} className='w-full px-3 py-2.5 flex items-center gap-2 text-left'>
                        <HeartStraight size={15} weight={filledAffinityActorIds.length > 0 ? 'fill' : 'regular'} className='text-rose-500' />
                        <span className='min-w-0 flex-1'><strong className='block text-[10px] text-rose-800'>这轮关系备注 · 可选</strong><span className='block mt-0.5 truncate text-[9px] text-rose-500'>{filledAffinityActorIds.length > 0 ? `已填写 ${filledAffinityActorIds.length} 位：${actors.filter(actor => filledAffinityActorIds.includes(actor.id)).map(actor => actor.name).join('、')}` : '先选择角色，再分别填写你对 TA 的变化'}</span></span>
                        <span className='text-[9px] font-bold text-rose-500'>{showAffinityInput ? '收起' : '填写'}</span>
                    </button>
                    {showAffinityInput && <div className='px-3 pb-3 border-t border-rose-200/70'>
                        <div className='pt-3 flex gap-2 overflow-x-auto'>{actors.map(actor => { const filled = filledAffinityActorIds.includes(actor.id); const selected = selectedAffinityActor?.id === actor.id; return <button key={actor.id} type='button' onClick={() => setSelectedAffinityActorId(actor.id)} className={`shrink-0 px-2.5 py-2 rounded-xl flex items-center gap-2 border text-[10px] font-bold ${selected ? 'bg-white border-rose-300 text-rose-700' : 'border-transparent text-slate-500'}`}><TokenImg value={actor.avatar} alt='' className='w-6 h-6 rounded-full object-cover' /><span>{actor.name}</span><span className={`w-1.5 h-1.5 rounded-full ${filled ? 'bg-rose-500' : 'bg-slate-200'}`} /></button>; })}</div>
                        {selectedAffinityActor && <div className='mt-3 pt-3 border-t border-rose-200/70'>
                            <div className='flex items-center justify-between gap-3'><div><span className='block text-[9px] font-bold text-rose-700'>你 → {selectedAffinityActor.name}</span><span className='block mt-0.5 text-[8px] text-slate-400'>这一栏只改变你和这位角色的关系</span></div><button type='button' onClick={() => setAffinityDrafts(current => { const next = { ...current }; delete next[selectedAffinityActor.id]; return next; })} className='text-[9px] font-bold text-slate-400'>清空这位</button></div>
                            <div className='mt-3 flex items-center gap-3'><span className='text-[9px] font-bold text-rose-600'>变化</span><input disabled={sending} type='range' min={-10} max={10} step={1} value={selectedAffinityDraft.delta} onChange={event => patchAffinityDraft(selectedAffinityActor.id, { delta: Number(event.target.value) })} className='min-w-0 flex-1 accent-rose-500' /><strong className={`w-8 text-right text-xs ${selectedAffinityDraft.delta > 0 ? 'text-rose-600' : selectedAffinityDraft.delta < 0 ? 'text-slate-600' : 'text-slate-400'}`}>{selectedAffinityDraft.delta >= 0 ? '+' : ''}{selectedAffinityDraft.delta}</strong></div>
                            <input disabled={sending} maxLength={200} value={selectedAffinityDraft.reason} onChange={event => patchAffinityDraft(selectedAffinityActor.id, { reason: event.target.value })} placeholder={`为什么你对 ${selectedAffinityActor.name} 有这点变化？`} className='mt-2 w-full px-3 py-2.5 rounded-xl bg-white border border-rose-200 text-xs outline-none placeholder:text-slate-300' />
                            <div className='mt-2 grid grid-cols-2 p-1 rounded-xl bg-white border border-rose-200'><button type='button' disabled={sending} onClick={() => patchAffinityDraft(selectedAffinityActor.id, { awareness: 'unnoticed' })} className={`py-2 rounded-lg text-[9px] font-bold ${selectedAffinityDraft.awareness === 'unnoticed' ? 'bg-slate-100 text-slate-700' : 'text-slate-400'}`}><span className='inline-flex items-center gap-1'><EyeSlash size={12} />未察觉 · 只变氛围</span></button><button type='button' disabled={sending} onClick={() => patchAffinityDraft(selectedAffinityActor.id, { awareness: 'noticed' })} className={`py-2 rounded-lg text-[9px] font-bold ${selectedAffinityDraft.awareness === 'noticed' ? 'bg-violet-100 text-violet-700' : 'text-slate-400'}`}><span className='inline-flex items-center gap-1'><Eye size={12} />已察觉 · 完全透视</span></button></div>
                            <div className='mt-2 text-[9px] leading-4 text-rose-500'>可以继续点另一位角色填写；没有填写的角色本轮保持原关系。</div>
                        </div>}
                    </div>}
                </div>}
                <div className='flex items-end gap-2 p-2 rounded-2xl bg-white border border-slate-200 shadow-sm'>
                    <button type='button' onClick={() => void send(undefined, true)} disabled={sending || actors.length === 0} className='self-end h-11 shrink-0 px-3 rounded-xl border border-violet-200 bg-violet-50 text-violet-700 text-xs font-bold active:scale-95 transition-transform disabled:opacity-30' title='本轮不主动行动，让剧情按当前预设继续' aria-label='继续当前剧情'>继续</button>
                    <textarea value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }} disabled={sending} rows={2} placeholder={pendingRetryInput ? '留空并点击推进，可继续上次中断' : canWriteOpening ? '也可以先写一句；留空推进则由故事开场' : '写下动作、对白、时间跳转，或你希望故事发生的事……'} className='min-w-0 min-h-12 max-h-36 flex-1 px-2 py-2 bg-transparent text-sm leading-6 resize-none outline-none disabled:opacity-50' />
                    <button onClick={() => void send()} disabled={sending || (!input.trim() && !pendingRetryInput && !canWriteOpening)} title={!input.trim() && pendingRetryInput ? '继续上次中断' : canWriteOpening && !input.trim() ? '让故事先开场' : '推进'} className='story-send-button self-end w-11 h-11 shrink-0 rounded-xl bg-slate-900 text-white grid place-items-center disabled:opacity-30'>{sending ? <SpinnerGap size={18} className='animate-spin' /> : <PaperPlaneTilt size={18} weight='fill' />}</button>
                </div>
                <div className='mt-2 text-center text-[9px] text-slate-400'>Ctrl / ⌘ + Enter 推进 · 长按楼层可编辑或删除</div>
            </div>
        </footer>
        {showQuickPreset && <StoryQuickPresetPanel
            document={effectivePreset.document}
            hasOverride={Boolean(entry.presetOverride)}
            onApply={async document => { await onEntryChange({ ...entry, presetOverride: document, updatedAt: Date.now() }); addToast('快捷预设已应用到本剧情', 'success'); }}
            onReset={async () => { await onEntryChange({ ...entry, presetOverride: undefined, updatedAt: Date.now() }); addToast('已恢复本剧情的原预设', 'info'); }}
            onClose={() => setShowQuickPreset(false)}
        />}
        {messageMenu && <div className='fixed inset-0 z-[70] flex items-end bg-slate-900/25' onClick={() => setMessageMenu(null)}>
            <div className='story-safe-sheet w-full rounded-t-3xl bg-stone-100 px-5 pt-4 shadow-2xl' onClick={event => event.stopPropagation()}>
                <div className='mx-auto mb-4 h-1 w-9 rounded-full bg-slate-300' />
                <div className='flex items-start justify-between gap-4'><div><div className='text-[9px] tracking-[.18em] font-bold text-violet-500'>{messageMenu.role === 'user' ? '你的推进' : '剧场正文'}</div><p className='mt-1 max-w-[75vw] truncate text-xs text-slate-500'>{messageMenu.content.replace(/<[^>]+>/g, ' ').trim()}</p></div><button onClick={() => setMessageMenu(null)} className='w-8 h-8 rounded-full grid place-items-center text-slate-400'><X size={16} /></button></div>
                <div className='mt-5 divide-y divide-slate-200 border-y border-slate-200'><button onClick={() => { setEditingMessage(messageMenu); setEditDraft(messageMenu.content); setMessageMenu(null); }} className='w-full py-4 flex items-center gap-3 text-left'><PencilSimple size={17} className='text-violet-600' /><span><strong className='block text-xs text-slate-700'>编辑这一层</strong><span className='block mt-0.5 text-[9px] text-slate-400'>{entry.writesToCharacterMemory ? '同步修改每位角色的陪伴记录' : '仅修改当前剧情内容'}</span></span></button><button onClick={() => { setDeletingMessage(messageMenu); setMessageMenu(null); }} className='w-full py-4 flex items-center gap-3 text-left'><Trash size={17} className='text-rose-500' /><span><strong className='block text-xs text-rose-600'>删除这一层</strong><span className='block mt-0.5 text-[9px] text-slate-400'>不会自动删除相邻的推进或正文</span></span></button></div>
            </div>
        </div>}
        {editingMessage && <div className='fixed inset-0 z-[75] flex items-end overflow-y-auto overscroll-contain bg-slate-900/30' onClick={() => !mutatingMessage && setEditingMessage(null)}>
            <div className='story-safe-sheet story-keyboard-sheet flex max-h-full w-full flex-col overflow-y-auto overscroll-contain rounded-t-3xl bg-stone-100 px-5 pt-5 shadow-2xl' onClick={event => event.stopPropagation()}>
                <div className='flex items-center justify-between'><div><div className='text-[9px] tracking-[.18em] font-bold text-violet-500'>编辑楼层</div><h2 className='mt-1 text-base font-semibold'>{editingMessage.role === 'user' ? '修改这次推进' : '修改这段正文'}</h2></div><button disabled={mutatingMessage} onClick={() => setEditingMessage(null)} className='w-9 h-9 rounded-full grid place-items-center text-slate-400 disabled:opacity-30'><X size={17} /></button></div>
                {editingMessage.role === 'assistant' && <p className='mt-3 text-[9px] leading-4 text-amber-700'>正文中的成对标签用于显示折叠卡片；修改文字时请保留标签完整，删改标签可能导致折叠区变为普通文字。</p>}
                <textarea autoFocus value={editDraft} onChange={event => setEditDraft(event.target.value)} className='mt-4 w-full min-h-48 max-h-[48vh] overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white p-4 text-xs leading-6 outline-none resize-y' />
                <button disabled={mutatingMessage || !editDraft.trim()} onClick={() => void saveMessageEdit()} className='mt-3 w-full h-12 rounded-2xl bg-slate-900 text-white text-xs font-bold disabled:opacity-30'>{mutatingMessage ? '正在同步…' : '保存这一层'}</button>
            </div>
        </div>}
        {deletingMessage && <div className='fixed inset-0 z-[75] flex items-end bg-slate-900/30' onClick={() => !mutatingMessage && setDeletingMessage(null)}>
            <div className='story-safe-sheet w-full rounded-t-3xl bg-stone-100 px-5 pt-5 shadow-2xl' onClick={event => event.stopPropagation()}>
                <div className='text-[9px] tracking-[.18em] font-bold text-rose-500'>删除楼层</div><h2 className='mt-1 text-lg font-semibold'>只删除选中的这一层？</h2><p className='mt-3 text-[10px] leading-5 text-slate-500'>相邻楼层会保留。{entry.writesToCharacterMemory ? '尚未归档的角色陪伴记录会一并删除；已经整理进长期记忆的旧内容不受影响。' : '本剧情已生成的事件盒或归档记忆不受影响。'}</p>
                <div className='mt-5 grid grid-cols-2 gap-3'><button disabled={mutatingMessage} onClick={() => setDeletingMessage(null)} className='h-12 rounded-2xl border border-slate-200 bg-white text-xs font-bold text-slate-600 disabled:opacity-30'>取消</button><button disabled={mutatingMessage} onClick={() => void deleteStoryMessage()} className='h-12 rounded-2xl bg-rose-600 text-white text-xs font-bold disabled:opacity-30'>{mutatingMessage ? '正在删除…' : '确认删除'}</button></div>
            </div>
        </div>}
    </div>;
};

export default StoryTheaterSession;
