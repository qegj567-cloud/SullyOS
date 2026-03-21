/**
 * NarrativeReplayOverlay — 叙事回放 (retro window style)
 * Looks like a retro OS notification/dialog window
 */

import React from 'react';
import { SimAction } from '../../types';
import {
    Alien, BookOpen, Lightning, Globe, ChatCircleDots, WarningCircle,
} from '@phosphor-icons/react';
import StoryAttachments from './StoryAttachments';
import { formatLifeSimActionDescription } from '../../utils/lifeSimTone';

const TONE_STYLES: Record<string, { accent: string; label: string }> = {
    vengeful: { accent: '#b85050', label: '复仇' },
    romantic: { accent: '#c06090', label: '浪漫' },
    scheming: { accent: '#8b6bb8', label: '阴谋' },
    chaotic:  { accent: '#c07040', label: '混乱' },
    peaceful: { accent: '#5b9b6b', label: '平和' },
    amused:   { accent: '#b89840', label: '有趣' },
    anxious:  { accent: '#5070b0', label: '焦虑' },
};

const NarrativeReplayOverlay: React.FC<{
    actions: SimAction[];
    currentIndex: number;
    onNext: () => void;
}> = ({ actions, currentIndex, onNext }) => {
    const action = actions[currentIndex];
    if (!action) return null;
    const isLast = currentIndex >= actions.length - 1;
    const narrative = action.narrative;
    const displayDescription = formatLifeSimActionDescription(action.description);
    const tone = narrative?.emotionalTone;
    const toneStyle = tone ? TONE_STYLES[tone] : null;
    const storyLabel = action.storyKind === 'main_plot'
        ? '主线剧情'
        : action.storyKind === 'character_drama'
            ? '角色剧情'
            : action.storyKind === 'system'
                ? '系统播报'
                : null;
    const accent = action.storyKind === 'main_plot'
        ? '#b86c3d'
        : action.storyKind === 'system'
            ? '#7f8c9b'
            : toneStyle?.accent || '#8b7bb8';

    return (
        <div className="absolute inset-0 flex items-center justify-center z-50 px-4"
            style={{ background: 'rgba(0,0,0,0.35)' }}>
            <div className="retro-window w-full" style={{
                maxWidth: 320,
                maxHeight: 'calc(var(--app-height, 100lvh) - 32px)',
                boxShadow: '4px 4px 0px rgba(0,0,0,0.2), inset 0 0 0 1px rgba(255,255,255,0.5)',
                borderColor: accent,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
            }}>
                {/* Titlebar */}
                <div className="retro-titlebar" style={{
                    background: `linear-gradient(180deg, ${accent}cc, ${accent})`,
                    flexShrink: 0,
                }}>
                    <span>replay.exe - {currentIndex + 1}/{actions.length}</span>
                    <div className="flex items-center gap-1.5">
                        {storyLabel && (
                            <span style={{ fontSize: 8, opacity: 0.9 }}>[ {storyLabel} ]</span>
                        )}
                        {toneStyle && (
                            <span style={{ fontSize: 8, opacity: 0.8 }}>[ {toneStyle.label} ]</span>
                        )}
                    </div>
                </div>

                <div
                    className="no-scrollbar"
                    style={{
                        padding: 12,
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        minHeight: 0,
                        flex: 1,
                        overscrollBehavior: 'contain',
                    }}
                >
                    {/* Character info */}
                    <div className="flex items-start gap-2.5 mb-3">
                        <div style={{
                            width: 36, height: 36, borderRadius: 4,
                            background: 'rgba(0,0,0,0.05)',
                            border: '2px solid rgba(0,0,0,0.1)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            overflow: 'hidden', flexShrink: 0,
                        }}>
                            {action.actorAvatar?.startsWith('http') || action.actorAvatar?.startsWith('data:')
                                ? <img src={action.actorAvatar} style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 3 }} alt="" />
                                : action.actorAvatar ? <span style={{ fontSize: 18 }}>{action.actorAvatar}</span>
                                : <Alien size={18} weight="bold" style={{ color: '#aaa' }} />}
                        </div>
                        <div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                                <p style={{ fontSize: 12, fontWeight: 700, color: accent }}>{action.actor}</p>
                                {storyLabel && (
                                    <span style={{
                                        fontSize: 8,
                                        fontWeight: 700,
                                        color: accent,
                                        border: `1px solid ${accent}55`,
                                        borderRadius: 999,
                                        padding: '1px 5px',
                                        background: `${accent}12`,
                                    }}>
                                        {storyLabel}
                                    </span>
                                )}
                            </div>
                            <p style={{ fontSize: 9, color: '#aaa', fontFamily: 'monospace' }}>第 {action.turnNumber} 回合</p>
                        </div>
                    </div>

                    {action.headline && (
                        <div className="retro-inset" style={{ padding: '6px 8px', marginBottom: 8 }}>
                            <p style={{ fontSize: 9, fontWeight: 600, color: accent, marginBottom: 3 }}>
                                剧情标题
                            </p>
                            <p style={{ fontSize: 12, color: '#403847', lineHeight: 1.45, fontWeight: 700 }}>
                                {action.headline}
                            </p>
                        </div>
                    )}

                    {/* Inner thought */}
                    {(narrative?.innerThought || action.reasoning) && (
                        <div className="retro-inset" style={{ padding: '6px 8px', marginBottom: 8 }}>
                            <p style={{ fontSize: 9, fontWeight: 600, color: '#b89840', marginBottom: 3, display: 'flex', alignItems: 'center', gap: 3 }}>
                                <ChatCircleDots size={10} weight="bold" /> 内心独白
                            </p>
                            <p style={{ fontSize: 10, color: '#887750', lineHeight: 1.5, fontStyle: 'italic' }}>
                                "{narrative?.innerThought || action.reasoning}"
                            </p>
                        </div>
                    )}

                    {/* Dialogue */}
                    {narrative?.dialogue && (
                        <div className="retro-inset" style={{ padding: '6px 8px', marginBottom: 8 }}>
                            <p style={{ fontSize: 9, fontWeight: 600, color: '#888', marginBottom: 3, display: 'flex', alignItems: 'center', gap: 3 }}>
                                <BookOpen size={10} weight="bold" /> 场景
                            </p>
                            <p style={{ fontSize: 10, color: '#555', lineHeight: 1.5 }}>{narrative.dialogue}</p>
                        </div>
                    )}

                    {/* Action description */}
                    <p style={{ fontSize: 11, color: '#333', lineHeight: 1.5, marginBottom: 8, fontWeight: 500 }}>
                        {displayDescription}
                    </p>

                    {/* Result */}
                    <div className="retro-inset" style={{ padding: '6px 8px' }}>
                        <p style={{ fontSize: 9, fontWeight: 600, color: '#888', marginBottom: 3, display: 'flex', alignItems: 'center', gap: 3 }}>
                            <Lightning size={10} weight="bold" /> 结果
                        </p>
                        <p style={{ fontSize: 11, color: '#444', lineHeight: 1.4 }}>{action.immediateResult}</p>
                    </div>

                    <StoryAttachments attachments={action.attachments} />

                    {/* Comment on world */}
                    {narrative?.commentOnWorld && (
                        <p style={{ fontSize: 9, color: '#aaa', fontStyle: 'italic', marginTop: 8, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                            <Globe size={9} weight="bold" /> "{narrative.commentOnWorld}"
                        </p>
                    )}

                    {/* Reaction to user */}
                    {action.reactionToUser && (
                        <p style={{ fontSize: 9, color: '#9080a0', fontStyle: 'italic', marginTop: 4, textAlign: 'center', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                            <ChatCircleDots size={9} weight="bold" /> "{action.reactionToUser}"
                        </p>
                    )}
                </div>

                {/* Action button */}
                <div style={{ padding: '8px 12px', borderTop: '1px solid rgba(0,0,0,0.08)', flexShrink: 0 }}>
                    <button onClick={onNext}
                        className="retro-btn retro-btn-primary w-full flex items-center justify-center gap-1"
                        style={{ padding: '7px 12px', background: `linear-gradient(180deg, ${accent}cc, ${accent})`, borderColor: accent }}>
                        {isLast ? <><WarningCircle size={12} weight="bold" /> 回到游戏</> : '下一条 →'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default NarrativeReplayOverlay;
