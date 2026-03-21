/**
 * DramaFeed - dynamic stream + main plot archive
 */

import React, { useEffect, useMemo, useState } from 'react';
import { LifeSimState, SimAction } from '../../types';
import {
    Alien, BookOpen, ChatCircleDots, Globe, Lightning, Sparkle,
} from '@phosphor-icons/react';
import StoryAttachments from './StoryAttachments';
import { formatLifeSimActionDescription } from '../../utils/lifeSimTone';

const EVENT_ACCENTS: Record<string, string> = {
    fight: '#b85050',
    romance: '#c06090',
    gossip: '#8b6bb8',
    alliance: '#5080b8',
    party: '#b89840',
    rivalry: '#c07040',
    mainPlot: '#b86c3d',
    system: '#7f8c9b',
};

const TONE_DOTS: Record<string, string> = {
    vengeful: '#b85050',
    romantic: '#c06090',
    scheming: '#8b6bb8',
    chaotic: '#c07040',
    peaceful: '#5b9b6b',
    amused: '#b89840',
    anxious: '#5070b0',
};

type DramaFilter = 'all' | 'character' | 'main_plot' | 'system';

const FILTERS: { value: DramaFilter; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'character', label: '角色' },
    { value: 'main_plot', label: '主线' },
    { value: 'system', label: '系统' },
];

function getEventAccent(action: SimAction): string {
    if (action.storyKind === 'main_plot') return EVENT_ACCENTS.mainPlot;
    if (action.storyKind === 'system') return EVENT_ACCENTS.system;

    const desc = action.description.toLowerCase();
    if (desc.includes('fight') || desc.includes('吵架') || desc.includes('打架')) return EVENT_ACCENTS.fight;
    if (desc.includes('romance') || desc.includes('暧昧') || desc.includes('恋')) return EVENT_ACCENTS.romance;
    if (desc.includes('gossip') || desc.includes('闲话') || desc.includes('八卦')) return EVENT_ACCENTS.gossip;
    if (desc.includes('alliance') || desc.includes('结盟')) return EVENT_ACCENTS.alliance;
    if (desc.includes('party') || desc.includes('派对')) return EVENT_ACCENTS.party;
    if (desc.includes('rivalry') || desc.includes('竞争')) return EVENT_ACCENTS.rivalry;
    if (action.actorId === 'system' || action.actorId === 'autonomous') return '#8b6bb8';
    if (action.actorId === 'user') return '#5b9b6b';
    return '#888';
}

function getStoryBadge(action: SimAction): string {
    if (action.storyKind === 'main_plot') return '主线';
    if (action.storyKind === 'character_drama') return '角色';
    if (action.storyKind === 'system') return '系统';
    return '';
}

function matchesDramaFilter(action: SimAction, filter: DramaFilter): boolean {
    if (filter === 'all') return true;
    if (filter === 'main_plot') return action.storyKind === 'main_plot';
    if (filter === 'system') return action.storyKind === 'system' || action.actorId === 'system' || action.actorId === 'autonomous';
    return action.storyKind === 'character_drama' || action.actorId === 'user' || (!!action.actorId && !['system', 'autonomous', 'story'].includes(action.actorId));
}

const DramaEntry: React.FC<{ action: SimAction }> = ({ action }) => {
    const [expanded, setExpanded] = useState(false);
    const accent = getEventAccent(action);
    const narrative = action.narrative;
    const displayDescription = formatLifeSimActionDescription(action.description);
    const hasDetails = !!(narrative?.innerThought || narrative?.dialogue || narrative?.commentOnWorld || action.reasoning || action.reactionToUser);
    const toneColor = narrative?.emotionalTone ? TONE_DOTS[narrative.emotionalTone] : undefined;
    const storyBadge = getStoryBadge(action);

    return (
        <div
            style={{
                background: action.storyKind === 'main_plot' ? 'rgba(255,247,234,0.7)' : 'rgba(255,255,255,0.5)',
                border: '1px solid rgba(0,0,0,0.08)',
                borderLeft: `3px solid ${accent}`,
                borderRadius: 4,
                padding: '5px 8px',
                cursor: hasDetails ? 'pointer' : 'default',
                minWidth: 0,
            }}
            onClick={() => hasDetails && setExpanded(!expanded)}
        >
            <div className="flex items-center gap-1.5" style={{ minWidth: 0 }}>
                <div
                    className="flex-shrink-0"
                    style={{
                        width: 18,
                        height: 18,
                        borderRadius: 3,
                        overflow: 'hidden',
                        background: 'rgba(0,0,0,0.05)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    {action.actorAvatar?.startsWith('http') || action.actorAvatar?.startsWith('data:')
                        ? <img src={action.actorAvatar} style={{ width: 18, height: 18, objectFit: 'cover', borderRadius: 3 }} alt="" />
                        : action.actorAvatar
                            ? <span style={{ fontSize: 11 }}>{action.actorAvatar}</span>
                            : <Alien size={10} weight="bold" style={{ color: '#aaa' }} />}
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, color: accent }}>{action.actor}</span>
                {storyBadge && (
                    <span
                        style={{
                            fontSize: 8,
                            fontWeight: 700,
                            color: accent,
                            border: `1px solid ${accent}55`,
                            background: `${accent}12`,
                            borderRadius: 999,
                            padding: '1px 5px',
                            letterSpacing: '0.04em',
                            flexShrink: 0,
                        }}
                    >
                        {storyBadge}
                    </span>
                )}
                {toneColor && (
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: toneColor, flexShrink: 0 }} />
                )}
                <span style={{ fontSize: 8, color: '#bbb', marginLeft: 'auto', fontFamily: 'monospace', flexShrink: 0 }}>R{action.turnNumber}</span>
                {hasDetails && (
                    <span style={{ fontSize: 8, color: '#ccc', flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
                )}
            </div>

            {action.headline && (
                <p style={{ fontSize: 11, fontWeight: 700, color: '#3f3846', lineHeight: 1.35, marginTop: 4, overflowWrap: 'anywhere' }}>
                    {action.headline}
                </p>
            )}

            <p style={{ fontSize: 10, color: '#555', lineHeight: 1.4, marginTop: 3, overflowWrap: 'anywhere' }}>{displayDescription}</p>

            {action.immediateResult && action.immediateResult !== action.description && (
                <p style={{ fontSize: 9, color: '#888', marginTop: 2, overflowWrap: 'anywhere' }}>→ {action.immediateResult}</p>
            )}

            <StoryAttachments attachments={action.attachments} compact />

            {expanded && hasDetails && (
                <div style={{ marginTop: 5, paddingTop: 5, borderTop: '1px dashed rgba(0,0,0,0.08)' }}>
                    {(narrative?.innerThought || action.reasoning) && (
                        <div className="retro-inset" style={{ padding: '3px 6px', marginBottom: 4 }}>
                            <p style={{ fontSize: 9, color: '#998', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 3, overflowWrap: 'anywhere' }}>
                                <ChatCircleDots size={9} weight="bold" /> {narrative?.innerThought || action.reasoning}
                            </p>
                        </div>
                    )}
                    {narrative?.dialogue && (
                        <p style={{ fontSize: 9, color: '#666', display: 'flex', alignItems: 'center', gap: 3, marginBottom: 3, overflowWrap: 'anywhere' }}>
                            <BookOpen size={9} weight="bold" style={{ flexShrink: 0 }} /> {narrative.dialogue}
                        </p>
                    )}
                    {narrative?.commentOnWorld && (
                        <p style={{ fontSize: 8, color: '#aaa', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 3, overflowWrap: 'anywhere' }}>
                            <Globe size={8} weight="bold" style={{ flexShrink: 0 }} /> {narrative.commentOnWorld}
                        </p>
                    )}
                    {action.reactionToUser && (
                        <p style={{ fontSize: 9, color: '#9080a0', fontStyle: 'italic', marginTop: 3, display: 'flex', alignItems: 'center', gap: 3, overflowWrap: 'anywhere' }}>
                            <ChatCircleDots size={9} weight="bold" style={{ flexShrink: 0 }} /> "{action.reactionToUser}"
                        </p>
                    )}
                </div>
            )}

            {action.chainFromId && (
                <p style={{ fontSize: 8, color: '#b89840', marginTop: 3, display: 'flex', alignItems: 'center', gap: 3 }}>
                    <Lightning size={8} weight="bold" style={{ flexShrink: 0 }} /> 连锁事件
                </p>
            )}
        </div>
    );
};

const MainPlotArchive: React.FC<{ gameState: LifeSimState }> = ({ gameState }) => {
    const mainPlots = useMemo(
        () => [...gameState.actionLog].filter(action => action.storyKind === 'main_plot').reverse(),
        [gameState.actionLog]
    );
    const [selectedId, setSelectedId] = useState<string | null>(mainPlots[0]?.id || null);

    useEffect(() => {
        if (!mainPlots.length) {
            setSelectedId(null);
            return;
        }
        if (!selectedId || !mainPlots.some(action => action.id === selectedId)) {
            setSelectedId(mainPlots[0].id);
        }
    }, [mainPlots, selectedId]);

    const selectedPlot = mainPlots.find(action => action.id === selectedId) || mainPlots[0] || null;
    const npcNameMap = new Map(gameState.npcs.map(npc => [npc.id, `${npc.emoji || ''}${npc.name}`.trim()]));
    const involvedNames = selectedPlot?.involvedNpcIds?.map(id => npcNameMap.get(id)).filter(Boolean) || [];

    return (
        <div className="retro-window" style={{ minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div className="retro-titlebar">
                <span>mainplot.arc</span>
                <span className="flex items-center gap-1">
                    <Sparkle size={10} weight="fill" />
                    {mainPlots.length}
                </span>
            </div>

            {!selectedPlot ? (
                <div className="flex-1 flex items-center justify-center text-center" style={{ padding: 14 }}>
                    <div>
                        <p style={{ fontSize: 11, fontWeight: 700, color: '#7f6c5d' }}>主线档案室还是空的</p>
                        <p style={{ fontSize: 10, color: '#9a8f84', marginTop: 6, lineHeight: 1.5 }}>
                            多点几次“吃瓜”，世界线就会在这里留下记录。
                        </p>
                    </div>
                </div>
            ) : (
                <>
                    <div style={{ padding: 8, borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: '#8b7b72', marginBottom: 6 }}>主线历史</div>
                        <div className="space-y-1.5 no-scrollbar" style={{ maxHeight: 168, overflowY: 'auto', overflowX: 'hidden', paddingRight: 2 }}>
                            {mainPlots.map(action => {
                                const active = action.id === selectedPlot.id;
                                return (
                                    <button
                                        key={action.id}
                                        onClick={() => setSelectedId(action.id)}
                                        style={{
                                            width: '100%',
                                            textAlign: 'left',
                                            border: active ? `1px solid ${EVENT_ACCENTS.mainPlot}55` : '1px solid rgba(0,0,0,0.08)',
                                            borderLeft: `3px solid ${active ? EVENT_ACCENTS.mainPlot : '#d0c1b7'}`,
                                            borderRadius: 4,
                                            padding: '6px 7px',
                                            background: active ? 'rgba(255,247,234,0.8)' : 'rgba(255,255,255,0.55)',
                                            minWidth: 0,
                                        }}
                                    >
                                        <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                                            <span style={{ fontSize: 9, fontWeight: 700, color: active ? EVENT_ACCENTS.mainPlot : '#7f756e', flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                                                {action.headline || action.description}
                                            </span>
                                            <span style={{ fontSize: 8, color: '#aaa', fontFamily: 'monospace', flexShrink: 0 }}>R{action.turnNumber}</span>
                                        </div>
                                        {action.attachments && action.attachments.length > 0 && (
                                            <div style={{ fontSize: 8, color: '#9f8b7d', marginTop: 3 }}>
                                                附件 {action.attachments.length}
                                            </div>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div style={{ padding: 8, borderBottom: '1px solid rgba(0,0,0,0.08)', background: 'rgba(184,108,61,0.05)' }}>
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <span
                                style={{
                                    fontSize: 8,
                                    fontWeight: 700,
                                    color: EVENT_ACCENTS.mainPlot,
                                    border: `1px solid ${EVENT_ACCENTS.mainPlot}55`,
                                    background: `${EVENT_ACCENTS.mainPlot}12`,
                                    borderRadius: 999,
                                    padding: '1px 6px',
                                    letterSpacing: '0.04em',
                                }}
                            >
                                当前主线
                            </span>
                            <span style={{ fontSize: 8, color: '#a1968c', fontFamily: 'monospace' }}>R{selectedPlot.turnNumber}</span>
                        </div>
                        <p style={{ fontSize: 12, fontWeight: 700, color: '#4b3c31', marginTop: 5, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
                            {selectedPlot.headline || selectedPlot.description}
                        </p>
                        <p style={{ fontSize: 10, color: '#6a615a', lineHeight: 1.55, marginTop: 5, overflowWrap: 'anywhere' }}>
                            {selectedPlot.description}
                        </p>
                        {selectedPlot.immediateResult && (
                            <div className="retro-inset" style={{ padding: '6px 8px', marginTop: 7 }}>
                                <div style={{ fontSize: 8, fontWeight: 700, color: '#9b765e', marginBottom: 3 }}>阶段结果</div>
                                <div style={{ fontSize: 10, color: '#59504a', lineHeight: 1.5, overflowWrap: 'anywhere' }}>{selectedPlot.immediateResult}</div>
                            </div>
                        )}
                        {involvedNames.length > 0 && (
                            <div className="flex gap-1 flex-wrap" style={{ marginTop: 7 }}>
                                {involvedNames.map(name => (
                                    <span
                                        key={name}
                                        style={{
                                            fontSize: 8,
                                            fontWeight: 700,
                                            color: '#7c6555',
                                            background: 'rgba(255,255,255,0.6)',
                                            border: '1px solid rgba(184,108,61,0.18)',
                                            borderRadius: 999,
                                            padding: '2px 6px',
                                        }}
                                    >
                                        {name}
                                    </span>
                                ))}
                            </div>
                        )}
                        <StoryAttachments attachments={selectedPlot.attachments} />
                    </div>

                    {(selectedPlot.narrative?.innerThought || selectedPlot.narrative?.commentOnWorld) && (
                        <div style={{ padding: 8 }}>
                            <div style={{ fontSize: 9, fontWeight: 700, color: '#8b7b72', marginBottom: 6 }}>编剧室批注</div>
                            {selectedPlot.narrative?.innerThought && (
                                <div className="retro-inset" style={{ padding: '6px 8px', marginBottom: selectedPlot.narrative?.commentOnWorld ? 6 : 0 }}>
                                    <p style={{ fontSize: 9, color: '#7d705e', lineHeight: 1.55, fontStyle: 'italic', overflowWrap: 'anywhere' }}>
                                        {selectedPlot.narrative.innerThought}
                                    </p>
                                </div>
                            )}
                            {selectedPlot.narrative?.commentOnWorld && (
                                <p style={{ fontSize: 9, color: '#8e847d', lineHeight: 1.55, overflowWrap: 'anywhere' }}>
                                    {selectedPlot.narrative.commentOnWorld}
                                </p>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

const DramaFeed: React.FC<{ gameState: LifeSimState }> = ({ gameState }) => {
    const [filter, setFilter] = useState<DramaFilter>('all');
    const logs = [...gameState.actionLog]
        .filter(action => matchesDramaFilter(action, filter))
        .reverse();

    return (
        <div style={{ padding: 6, minHeight: '100%', minWidth: 0, overflowX: 'hidden' }}>
            <div className="retro-window" style={{ padding: 6, marginBottom: 8 }}>
                <div className="flex items-center gap-1.5 flex-wrap">
                    {FILTERS.map(item => {
                        const active = filter === item.value;
                        return (
                            <button
                                key={item.value}
                                onClick={() => setFilter(item.value)}
                                className="retro-btn"
                                style={{
                                    padding: '3px 10px',
                                    fontSize: 9,
                                    ...(active ? {
                                        background: 'linear-gradient(180deg, #a594d0, #8b7bb8)',
                                        color: 'white',
                                        borderColor: '#8b7bb8',
                                    } : {}),
                                }}
                            >
                                {item.label}
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="grid gap-2 lg:grid-cols-2" style={{ minHeight: 'calc(100% - 48px)', minWidth: 0 }}>
                <div className="retro-window order-2 lg:order-1" style={{ minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                    <div className="retro-titlebar">
                        <span>drama.log</span>
                        <span>{logs.length}</span>
                    </div>
                    <div style={{ padding: 6, minWidth: 0 }} className="space-y-1 flex-1 overflow-y-auto overflow-x-hidden no-scrollbar">
                        {logs.length === 0 ? (
                            <div className="text-center py-8" style={{ color: '#999', fontSize: 11 }}>还没有新的动态记录…</div>
                        ) : logs.map(action => (
                            <DramaEntry key={action.id} action={action} />
                        ))}
                    </div>
                </div>

                <div className="order-1 lg:order-2" style={{ minWidth: 0 }}>
                    <MainPlotArchive gameState={gameState} />
                </div>
            </div>
        </div>
    );
};

export default DramaFeed;
