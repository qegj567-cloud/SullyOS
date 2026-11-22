/**
 * GameOverOverlay — 游戏结束 (retro error dialog style)
 * Inspired by classic OS error windows
 */

import React from 'react';
import { Buildings, ArrowCounterClockwise } from '@phosphor-icons/react';

const GameOverOverlay: React.FC<{ reason?: string; onRestart: () => void }> = ({ reason, onRestart }) => (
    <div className="absolute inset-0 flex items-center justify-center z-[45] px-4"
        style={{ background: 'rgba(0,0,0,0.4)' }}>
        <div className="retro-window w-full" style={{
            maxWidth: 280,
            borderColor: '#b85050',
            boxShadow: '4px 4px 0px rgba(0,0,0,0.25), inset 0 0 0 1px rgba(255,255,255,0.5)',
        }}>
            {/* Error-style titlebar */}
            <div className="retro-titlebar" style={{
                background: 'linear-gradient(180deg, #d06060, #b85050)',
            }}>
                <span className="flex items-center gap-1">
                    <span style={{ fontSize: 12 }}>⚠</span> Error
                </span>
                <span className="retro-dots">
                    <span className="retro-dot" style={{ background: '#f87171' }}>×</span>
                </span>
            </div>

            <div style={{ padding: 16, textAlign: 'center' }}>
                <Buildings size={48} weight="duotone" style={{ color: '#b85050', marginBottom: 8 }} className="mx-auto" />

                <p style={{ fontSize: 14, fontWeight: 700, color: '#444', marginBottom: 8 }}>
                    城市空了！
                </p>

                <div className="retro-inset" style={{ padding: '8px 12px', marginBottom: 12, textAlign: 'left' }}>
                    <p style={{ fontSize: 10, color: '#666', lineHeight: 1.5 }}>
                        {reason || '所有人都搬走了……这座城市空无一人。'}
                    </p>
                </div>

                <button onClick={onRestart}
                    className="retro-btn retro-btn-primary w-full flex items-center justify-center gap-1"
                    style={{ padding: '8px 16px', fontSize: 12 }}>
                    <ArrowCounterClockwise size={13} weight="bold" /> 重建城市
                </button>
            </div>
        </div>
    </div>
);

export default GameOverOverlay;
