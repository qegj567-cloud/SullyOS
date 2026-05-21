/**
 * Like520Event.tsx
 * 520 特别活动 (2026.5.20) — "如果 char 变得小小的"
 *
 * Phase 状态机：
 *   intro → char_creator → loading_a → opening → tucao_select → tucao_reply
 *   → anchors → reveal_transition → user_creator → uncovered_line → ending_screen
 *   → loading_b → wake_up → letter → puzzle → done
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, SpecialMomentRecord } from '../types';
import { safeResponseJson } from '../utils/safeApi';
import {
    runLike520CallA,
    runLike520CallB,
    Like520CallAResult,
    Like520CallBResult,
    Like520TucaoKey,
} from '../utils/like520/prompts';

// ============================================================
// 日期判定 / 持久化 key
// ============================================================

export const LIKE520_RECORD_KEY = 'like520_2026';
const LIKE520_DISMISSED_KEY = 'sullyos_like520_2026_dismissed';
const LIKE520_COMPLETED_KEY = 'sullyos_like520_2026_completed';

const isLike520Day = (): boolean => {
    const now = new Date();
    return now.getFullYear() === 2026 && now.getMonth() === 4 && now.getDate() === 20;
};

export const shouldShowLike520Popup = (): boolean => {
    if (!isLike520Day()) return false;
    try {
        if (localStorage.getItem(LIKE520_DISMISSED_KEY)) return false;
        if (localStorage.getItem(LIKE520_COMPLETED_KEY)) return false;
    } catch { /* ignore */ }
    return true;
};

export const isLike520EventAvailable = (): boolean => {
    const now = new Date();
    return now.getFullYear() === 2026 && now.getMonth() === 4;
};

/**
 * 520 弹窗默认进入的角色：
 *   1) 优先选 Sully（如果还在）
 *   2) 否则选**和 user 聊得最频繁的角色**（消息数最多）
 *   3) 都没有时退回第一个角色（或空）
 */
export async function pickDefaultLike520Char(characters: CharacterProfile[]): Promise<string> {
    if (!characters || characters.length === 0) return '';
    const sully = characters.find(c => (c.name || '').toLowerCase().includes('sully'));
    if (sully) return sully.id;
    // 没有 Sully —— 数每个角色的消息条数，挑最多的那个
    try {
        const counts = await Promise.all(characters.map(async c => {
            try {
                const msgs = await DB.getMessagesByCharId(c.id);
                return { id: c.id, n: msgs?.length || 0 };
            } catch { return { id: c.id, n: 0 }; }
        }));
        counts.sort((a, b) => b.n - a.n);
        if (counts[0] && counts[0].n > 0) return counts[0].id;
    } catch (e) {
        console.warn('[520] pickDefaultLike520Char fallback:', e);
    }
    return characters[0]?.id || '';
}

export const isLike520Past = (): boolean => {
    const now = new Date();
    return now.getFullYear() > 2026 || (now.getFullYear() === 2026 && now.getMonth() > 4);
};

// ============================================================
// 类型
// ============================================================

type Phase =
    | 'intro' | 'char_creator' | 'loading_a'
    | 'yangcheng'           // 持久化养成容器：opening → tucao → 锚点 → reveal_transition → 自我意识
    | 'user_creator' | 'uncovered_line' | 'ending_screen'
    | 'loading_b' | 'wake_up' | 'letter' | 'puzzle' | 'done' | 'error';

interface ChibiResult {
    dataUrl: string;
    frameDataUrl: string;
    transparentDataUrl: string;
    state?: any;
}

const TUCAO_OPTIONS: { key: Like520TucaoKey; label: string }[] = [
    { key: 'becamesmall', label: '你怎么变小了！' },
    { key: 'cute', label: '你今天好可爱！' },
    { key: 'yangcheng_meta', label: '这什么天杀的养成游戏' },
];

// ============================================================
// Sully 识别（专属预设）
// ============================================================

const isSullyChar = (char: CharacterProfile): boolean => {
    return (char.name || '').toLowerCase().includes('sully');
};

const sullyPresets = (): Record<string, string> => ({
    skin: 'skin_1',
    fronthair: 'fronthair_99',
    eyes: 'eyes_99',
});

// ============================================================
// iframe 捏脸 wrapper
// ============================================================

interface CreatorIframeProps {
    mode: 'char' | 'user';
    charName?: string;
    presets?: Record<string, string>;
    isSully?: boolean;
    onConfirm: (result: ChibiResult) => void;
}

const CHAR_CREATOR_URL = (((import.meta as any).env?.BASE_URL ?? '/') + 'like520/character_creator.html').replace(/\/+/g, '/');

const CreatorIframe: React.FC<CreatorIframeProps> = ({ mode, charName, presets, isSully, onConfirm }) => {
    const iframeRef = useRef<HTMLIFrameElement>(null);

    useEffect(() => {
        const handleMessage = (e: MessageEvent) => {
            if (!e.data || typeof e.data !== 'object') return;
            const iframeWin = iframeRef.current?.contentWindow;
            if (e.source !== iframeWin) return;

            if (e.data.type === 'like520_ready') {
                console.log(`[520][creator:${mode}] iframe ready, sending init (isSully=${!!isSully})`);
                iframeWin?.postMessage({
                    type: 'like520_init',
                    payload: { mode, charName, presets, isSully: !!isSully },
                }, '*');
            } else if (e.data.type === 'like520_result' && e.data.payload) {
                console.log(`[520][creator:${mode}] result received`);
                onConfirm({
                    dataUrl: e.data.payload.dataUrl,
                    frameDataUrl: e.data.payload.frameDataUrl,
                    transparentDataUrl: e.data.payload.transparentDataUrl,
                    state: e.data.payload.state,
                });
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [mode, charName, presets, isSully, onConfirm]);

    return (
        <iframe
            ref={iframeRef}
            src={CHAR_CREATOR_URL}
            title={mode === 'char' ? '捏 char chibi' : '捏 user chibi'}
            className="w-full h-full border-0"
            style={{ background: 'linear-gradient(180deg, #FFF1E6 0%, #FFE4EC 100%)' }}
        />
    );
};

// ============================================================
// 「珍重」 视觉系统 — 全局 CSS（cream/gold/burgundy + 飘瓣金粉 + ornate）
// ============================================================

const LIKE520_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Noto+Serif+SC:wght@300;400;500;600;700&family=Cinzel:wght@400;500;600&display=swap');

.l520-root {
  --ivory: #faf3e7;
  --cream: #f5ead4;
  --champagne: #e8d5a8;
  --gold-light: #d4b16a;
  --gold: #b8923f;
  --gold-deep: #8b6914;
  --rose-pale: #f3dcd8;
  --rose: #d4a59a;
  --rose-deep: #b27566;
  --burgundy: #7a2e3a;
  --burgundy-deep: #5a1d28;
  --pearl: #fff8ec;
  --ink: #3a2418;
  --ink-soft: #6b4a3a;
  --gold-grad: linear-gradient(135deg, #f4e0a8 0%, #d4b16a 35%, #b8923f 65%, #8b6914 100%);
  --rose-grad: linear-gradient(135deg, #f3dcd8 0%, #d4a59a 50%, #b27566 100%);
  --burgundy-grad: linear-gradient(135deg, #a04050 0%, #7a2e3a 50%, #5a1d28 100%);

  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: 'Noto Serif SC', 'Cormorant Garamond', serif;
  color: var(--ink);
  background:
    radial-gradient(circle at 50% -10%, #fff5e0 0%, transparent 50%),
    radial-gradient(circle at 50% 110%, #efc9b8 0%, transparent 50%),
    linear-gradient(180deg, #faf3e7 0%, #f5ead4 40%, #f3dcd8 100%);
  display: flex;
  flex-direction: column;
  isolation: isolate;
}
.l520-root::before {
  content: '';
  position: absolute; inset: 0;
  background-image: radial-gradient(circle at 1px 1px, rgba(139,105,20,0.04) 1px, transparent 0);
  background-size: 4px 4px;
  pointer-events: none;
  z-index: 1;
}

.l520-corner { position: absolute; width: 48px; height: 48px; z-index: 3; pointer-events: none; }
.l520-corner.tl { top: 4px; left: 4px; }
.l520-corner.tr { top: 4px; right: 4px; transform: scaleX(-1); }
.l520-corner.bl { bottom: 4px; left: 4px; transform: scaleY(-1); }
.l520-corner.br { bottom: 4px; right: 4px; transform: scale(-1,-1); }
.l520-corner svg { width: 100%; height: 100%; }

.l520-ornaments { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 1; }
.l520-sparkle {
  position: absolute;
  width: 5px; height: 5px;
  background: radial-gradient(circle, #fff5d0 0%, #d4b16a 50%, transparent 80%);
  border-radius: 50%;
  box-shadow: 0 0 8px rgba(212,177,106,0.8);
  animation: l520-twinkle 4s ease-in-out infinite;
}
@keyframes l520-twinkle {
  0%,100% { opacity: 0.2; transform: scale(0.6); }
  50%     { opacity: 1;   transform: scale(1.2); }
}
.l520-flourish {
  position: absolute;
  color: rgba(184,146,63,0.18);
  font-family: 'Cormorant Garamond', serif;
  font-size: 64px;
  font-style: italic;
  font-weight: 300;
  pointer-events: none;
}

.l520-topbar {
  position: relative; z-index: 5;
  padding: 14px 18px 6px;
  display: flex; flex-direction: column; gap: 8px;
  flex-shrink: 0;
}
.l520-header-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.l520-occasion {
  display: flex; align-items: center; gap: 8px;
  background: var(--gold-grad);
  padding: 3px 12px 3px 5px;
  border-radius: 999px;
  color: #fff;
  font-family: 'Cormorant Garamond', serif;
  font-weight: 500;
  font-size: 12px;
  letter-spacing: 0.5px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -2px 0 rgba(0,0,0,0.15), 0 3px 8px rgba(139,105,20,0.3);
  text-shadow: 0 1px 1px rgba(139,105,20,0.3);
}
.l520-occasion .num {
  background: rgba(255,255,255,0.95);
  color: var(--burgundy);
  width: 20px; height: 20px;
  border-radius: 50%;
  display: grid; place-items: center;
  font-family: 'Cinzel', serif;
  font-weight: 600;
  font-size: 9px;
  letter-spacing: -0.5px;
}
.l520-charpill {
  display: flex; align-items: center; gap: 6px;
  background: linear-gradient(180deg, #fff8ec, #f5ead4);
  border: 1px solid var(--gold-light);
  padding: 3px 10px 3px 4px;
  border-radius: 999px;
  color: var(--gold-deep);
  font-family: 'Noto Serif SC', serif;
  font-weight: 500;
  font-size: 11px;
  letter-spacing: 2px;
}
.l520-charpill img { width: 20px; height: 20px; border-radius: 50%; object-fit: cover; }
.l520-charpill-emoji { width: 20px; height: 20px; border-radius: 50%; background: var(--cream); display: grid; place-items: center; font-size: 12px; }

.l520-title-strip {
  display: flex; align-items: center; justify-content: center;
  gap: 10px;
  color: var(--burgundy);
}
.l520-title-strip .line {
  flex: 1; height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
  max-width: 70px;
}
.l520-title-strip .title {
  font-family: 'Cormorant Garamond', serif;
  font-style: italic;
  font-size: 13px;
  letter-spacing: 3px;
}

.l520-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 14px; margin-top: 2px; }
.l520-stat { display: flex; align-items: center; gap: 6px; }
.l520-stat-label {
  font-family: 'Noto Serif SC', serif;
  font-size: 10px;
  color: var(--burgundy);
  font-weight: 500;
  letter-spacing: 1px;
  width: 12px;
  flex-shrink: 0;
}
.l520-bar-wrap { flex: 1; position: relative; padding-right: 22px; }
.l520-bar {
  height: 7px;
  background: linear-gradient(180deg, #e8dcc0, #f0e3c4);
  border-radius: 999px;
  overflow: hidden;
  position: relative;
  box-shadow: inset 0 1px 2px rgba(139,105,20,0.2);
  border: 0.5px solid rgba(184,146,63,0.4);
}
.l520-bar > i {
  display: block; height: 100%;
  border-radius: 999px;
  transition: width .8s cubic-bezier(.5,1.5,.5,1);
}
.l520-bar.mood > i { background: linear-gradient(90deg, #e8b5a8, #b27566 60%, #7a2e3a); }
.l520-bar.love > i { background: linear-gradient(90deg, #d4a59a, #a04050 60%, #5a1d28); }
.l520-bar.food > i { background: linear-gradient(90deg, #f0d9a0, #d4b16a 60%, #b8923f); }
.l520-bar.energy > i { background: linear-gradient(90deg, #d4c5a0, #b8923f 60%, #8b6914); }
.l520-bar-num {
  position: absolute; right: 0; top: 50%;
  transform: translateY(-50%);
  font-family: 'Cinzel', serif;
  font-weight: 500;
  font-size: 9px;
  color: var(--gold-deep);
  letter-spacing: 0.5px;
  min-width: 18px;
  text-align: right;
}

.l520-stage {
  position: relative;
  flex: 1; min-height: 0;
  margin: 4px 22px 0;
  display: flex; align-items: flex-end; justify-content: center;
  padding: 0 0 8px;
  z-index: 3;
}
.l520-char-wrap {
  position: relative;
  width: 70%;
  max-width: 230px;
  cursor: pointer;
  transform-origin: bottom center;
  animation: l520-idle 4s ease-in-out infinite;
  z-index: 2;
}
@keyframes l520-idle {
  0%,100% { transform: translateY(0); }
  50%     { transform: translateY(-5px); }
}
.l520-char-wrap.petting { animation: l520-petbounce .7s ease; }
@keyframes l520-petbounce {
  0%   { transform: translateY(0) scale(1); }
  30%  { transform: translateY(-8px) scale(1.04); }
  60%  { transform: translateY(2px) scale(.98); }
  100% { transform: translateY(0) scale(1); }
}
.l520-char-img {
  width: 100%;
  display: block;
  filter: drop-shadow(0 16px 18px rgba(122,46,58,0.3)) drop-shadow(0 4px 8px rgba(139,105,20,0.2));
  pointer-events: none;
}
.l520-halo {
  position: absolute;
  bottom: 5%; left: 50%;
  transform: translateX(-50%);
  width: 110%; height: 80%;
  background: radial-gradient(ellipse at 50% 60%, rgba(255,235,180,0.6) 0%, rgba(212,177,106,0.3) 30%, transparent 60%);
  z-index: -1;
  filter: blur(8px);
  animation: l520-halo 3s ease-in-out infinite;
}
@keyframes l520-halo {
  0%,100% { opacity: 0.5; transform: translateX(-50%) scale(1); }
  50%     { opacity: 0.8; transform: translateX(-50%) scale(1.05); }
}
.l520-ring {
  position: absolute;
  bottom: -2px; left: 50%;
  transform: translateX(-50%);
  width: 80%;
  aspect-ratio: 1;
  border-radius: 50%;
  border: 1px solid rgba(184,146,63,0.3);
  z-index: -2;
}
.l520-ring::before {
  content: '';
  position: absolute; inset: -8px;
  border-radius: 50%;
  border: 0.5px dashed rgba(184,146,63,0.4);
}
.l520-nameplate {
  position: absolute;
  top: -28px; left: 50%;
  transform: translateX(-50%);
  background: var(--burgundy-grad);
  padding: 3px 22px;
  color: #fff8ec;
  font-family: 'Noto Serif SC', serif;
  font-weight: 500;
  font-size: 12px;
  letter-spacing: 4px;
  text-indent: 4px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.2), inset 0 -2px 0 rgba(0,0,0,0.25), 0 4px 8px rgba(122,46,58,0.4);
  white-space: nowrap;
  z-index: 4;
  border: 0.5px solid rgba(212,177,106,0.6);
}
.l520-nameplate::before, .l520-nameplate::after {
  content: '';
  position: absolute; top: 50%;
  transform: translateY(-50%);
  width: 0; height: 0;
  border: 6px solid transparent;
}
.l520-nameplate::before { left: -10px; border-right-color: var(--burgundy-deep); border-left-width: 4px; }
.l520-nameplate::after { right: -10px; border-left-color: var(--burgundy-deep); border-right-width: 4px; }
.l520-nameplate .deco { color: var(--gold-light); margin: 0 4px; font-size: 10px; }

.l520-tap-hint {
  position: absolute;
  bottom: 62%; right: 6%;
  background: rgba(255, 248, 236, 0.95);
  color: var(--burgundy);
  padding: 5px 12px;
  border-radius: 16px 16px 4px 16px;
  border: 1px solid var(--gold-light);
  font-family: 'Cormorant Garamond', serif;
  font-style: italic;
  font-size: 11px;
  letter-spacing: 1px;
  box-shadow: 0 4px 12px rgba(122,46,58,0.2);
  animation: l520-hint 3s ease-in-out infinite;
  z-index: 4;
  pointer-events: none;
}
@keyframes l520-hint {
  0%,100% { transform: translateY(0); }
  50%     { transform: translateY(-4px); }
}
.l520-scene-narration {
  position: absolute;
  top: 8px; left: 0; right: 0;
  text-align: center;
  z-index: 4;
  pointer-events: none;
}
.l520-scene-narration > span {
  display: inline-block;
  background: rgba(255,248,236,0.95);
  color: var(--burgundy);
  padding: 4px 14px;
  border-radius: 999px;
  border: 1px solid var(--gold-light);
  font-family: 'Cormorant Garamond', 'Noto Serif SC', serif;
  font-size: 11px;
  font-style: italic;
  letter-spacing: 1px;
  box-shadow: 0 4px 12px rgba(122,46,58,0.18);
}

.l520-particle {
  position: absolute;
  pointer-events: none;
  font-size: 14px;
  animation: l520-pop 1.6s ease-out forwards;
  z-index: 6;
  color: var(--gold);
  text-shadow: 0 0 8px rgba(212,177,106,0.8);
}
@keyframes l520-pop {
  0%   { transform: translate(0,0) scale(0.4); opacity: 0; }
  20%  { opacity: 1; transform: translate(var(--tx, 0), -15px) scale(1.2) rotate(var(--rot,10deg)); }
  100% { opacity: 0; transform: translate(var(--tx, 0), -90px) scale(0.6) rotate(var(--rot,30deg)); }
}
.l520-floatscore {
  position: absolute;
  pointer-events: none;
  font-family: 'Cormorant Garamond', serif;
  font-style: italic;
  font-weight: 600;
  color: var(--burgundy);
  font-size: 15px;
  letter-spacing: 1px;
  text-shadow: 0 1px 0 rgba(255,255,255,0.8), 0 2px 4px rgba(122,46,58,0.3);
  animation: l520-scoreup 1.6s ease-out forwards;
  z-index: 7;
  white-space: nowrap;
}
@keyframes l520-scoreup {
  0%   { opacity: 0; transform: translateY(0) scale(0.7); }
  20%  { opacity: 1; transform: translateY(-10px) scale(1.05); }
  100% { opacity: 0; transform: translateY(-55px) scale(1); }
}
.l520-react {
  position: absolute;
  background: rgba(255,248,236,0.98);
  border: 1px solid var(--gold);
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--burgundy);
  font-family: 'Cormorant Garamond', 'Noto Serif SC', serif;
  font-style: italic;
  letter-spacing: 1px;
  box-shadow: 0 4px 12px rgba(122,46,58,0.2);
  pointer-events: none;
  animation: l520-react 1.8s ease-out forwards;
  z-index: 7;
  white-space: nowrap;
}
@keyframes l520-react {
  0%   { opacity: 0; transform: scale(0.6) translateY(10px); }
  20%  { opacity: 1; transform: scale(1.02) translateY(0); }
  80%  { opacity: 1; transform: scale(1) translateY(-15px); }
  100% { opacity: 0; transform: scale(0.95) translateY(-35px); }
}

.l520-dialog {
  position: relative;
  margin: 0 18px;
  background: linear-gradient(180deg, rgba(255,248,236,0.96), rgba(245,234,212,0.96));
  border: 1px solid var(--gold-light);
  border-radius: 4px;
  padding: 18px 16px 14px;
  min-height: 70px;
  color: var(--ink);
  box-shadow: 0 6px 18px rgba(122,46,58,0.18), inset 0 1px 0 rgba(255,255,255,0.8);
  font-size: 13px;
  line-height: 1.7;
  font-family: 'Noto Serif SC', serif;
  font-weight: 400;
  letter-spacing: 0.5px;
  z-index: 3;
}
.l520-dialog.tall { padding: 22px 16px 18px; min-height: 110px; }
.l520-dialog.clickable { cursor: pointer; }
.l520-dialog.clickable:active { opacity: 0.9; }
.l520-dialog::before, .l520-dialog::after,
.l520-dialog .corner-tl, .l520-dialog .corner-tr {
  content: '';
  position: absolute;
  width: 11px; height: 11px;
  border: 1px solid var(--gold);
}
.l520-dialog::before { top: 4px; left: 4px; border-right: none; border-bottom: none; }
.l520-dialog::after  { bottom: 4px; right: 4px; border-left: none; border-top: none; }
.l520-dialog .corner-tl { top: 4px; right: 4px; border-left: none; border-bottom: none; }
.l520-dialog .corner-tr { bottom: 4px; left: 4px; border-right: none; border-top: none; }
.l520-dialog .speaker {
  position: absolute;
  top: -9px; left: 14px;
  background: var(--burgundy-grad);
  color: #fff8ec;
  padding: 2px 14px;
  font-size: 10.5px;
  font-family: 'Noto Serif SC', serif;
  font-weight: 500;
  letter-spacing: 3px;
  text-indent: 3px;
  border-radius: 2px;
  box-shadow: 0 2px 4px rgba(122,46,58,0.3);
  border: 0.5px solid var(--gold);
}
.l520-dialog .pageinfo {
  position: absolute;
  top: -9px; right: 14px;
  background: #fff8ec;
  border: 1px solid var(--gold-light);
  color: var(--gold-deep);
  font-family: 'Cinzel', serif;
  font-size: 9px;
  font-weight: 500;
  padding: 1px 8px;
  border-radius: 2px;
  letter-spacing: 1px;
}
.l520-dialog .next-arrow {
  position: absolute; right: 14px; bottom: 10px;
  color: var(--gold);
  font-size: 11px;
  font-style: italic;
  font-family: 'Cormorant Garamond', serif;
  letter-spacing: 1px;
  animation: l520-blink 1.4s infinite;
}
@keyframes l520-blink { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
.l520-dialog .body-text {
  white-space: pre-wrap;
  word-break: break-word;
}
.l520-dialog .hint-text {
  font-family: 'Cormorant Garamond', 'Noto Serif SC', serif;
  font-style: italic;
  color: var(--ink-soft);
  opacity: 0.75;
}

.l520-actions {
  position: relative; z-index: 3;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding: 10px 18px 16px;
  flex-shrink: 0;
}
.l520-act {
  background: linear-gradient(180deg, rgba(255,248,236,0.95) 0%, rgba(245,234,212,0.9) 100%);
  border: 1px solid var(--gold-light);
  border-radius: 2px;
  padding: 10px 4px 8px;
  color: var(--burgundy);
  font-family: 'Noto Serif SC', serif;
  font-weight: 500;
  font-size: 10.5px;
  cursor: pointer;
  box-shadow: 0 3px 8px rgba(122,46,58,0.12), inset 0 1px 0 rgba(255,255,255,0.8);
  transition: transform .2s ease, opacity .2s ease;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  position: relative;
  letter-spacing: 2px;
  text-indent: 2px;
}
.l520-act::before, .l520-act::after {
  content: '';
  position: absolute;
  width: 5px; height: 5px;
}
.l520-act::before { top: 3px; left: 3px; border-top: 1px solid var(--gold); border-left: 1px solid var(--gold); }
.l520-act::after  { bottom: 3px; right: 3px; border-bottom: 1px solid var(--gold); border-right: 1px solid var(--gold); }
.l520-act:active:not(:disabled) { transform: translateY(2px); }
.l520-act:disabled { opacity: 0.35; cursor: not-allowed; }
.l520-act svg { width: 22px; height: 22px; stroke-width: 1.3; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; }
.l520-act.primary {
  background: var(--burgundy-grad);
  color: #fff8ec;
  border-color: var(--gold);
  box-shadow: 0 4px 12px rgba(74,36,24,0.4), inset 0 1px 0 rgba(255,255,255,0.15);
}
.l520-act.primary::before, .l520-act.primary::after { border-color: var(--gold-light); }
.l520-act .badge {
  position: absolute;
  top: -5px; right: -3px;
  background: var(--gold-grad);
  color: var(--burgundy-deep);
  border: 1px solid var(--ivory);
  border-radius: 999px;
  font-family: 'Cinzel', serif;
  font-size: 8.5px;
  font-weight: 600;
  padding: 1px 5px;
  min-width: 16px;
  height: 16px;
  display: grid; place-items: center;
  box-shadow: 0 2px 4px rgba(139,105,20,0.4);
}
.l520-act.pulse { animation: l520-actpulse 1.6s ease-in-out infinite; }
@keyframes l520-actpulse {
  0%,100% { box-shadow: 0 4px 12px rgba(74,36,24,0.4), inset 0 1px 0 rgba(255,255,255,0.15); }
  50%     { box-shadow: 0 4px 18px rgba(212,177,106,0.7), inset 0 1px 0 rgba(255,255,255,0.15); }
}

.l520-mask {
  position: absolute; inset: 0;
  background: rgba(74,36,24,0.4);
  backdrop-filter: blur(8px);
  z-index: 20;
  display: flex; align-items: center; justify-content: center;
  padding: 0 24px;
  animation: l520-maskin .25s ease;
}
@keyframes l520-maskin { from { opacity: 0; } to { opacity: 1; } }

.l520-choice-card {
  width: 100%;
  background: linear-gradient(180deg, #fffaef 0%, #f8edd2 100%);
  border-radius: 2px;
  padding: 24px 18px 18px;
  box-shadow: 0 20px 60px rgba(74,36,24,0.4), 0 0 0 1px var(--gold), 0 0 0 4px var(--ivory), 0 0 0 5px var(--gold-light);
  position: relative;
  animation: l520-cardin .45s cubic-bezier(.4,1.4,.5,1);
}
@keyframes l520-cardin { from { opacity: 0; transform: scale(0.85) translateY(15px); } to { opacity: 1; transform: scale(1) translateY(0); } }
.l520-choice-card::before, .l520-choice-card::after,
.l520-choice-card .cc-tl, .l520-choice-card .cc-tr {
  content: '';
  position: absolute;
  width: 14px; height: 14px;
  border: 1px solid var(--burgundy);
}
.l520-choice-card::before { top: 6px; left: 6px; border-right: none; border-bottom: none; }
.l520-choice-card::after  { top: 6px; right: 6px; border-left: none; border-bottom: none; }
.l520-choice-card .cc-tl  { bottom: 6px; left: 6px; border-right: none; border-top: none; }
.l520-choice-card .cc-tr  { bottom: 6px; right: 6px; border-left: none; border-top: none; }

.l520-choice-head { text-align: center; margin-bottom: 14px; }
.l520-choice-head .ornament { color: var(--gold); font-size: 12px; letter-spacing: 6px; margin-bottom: 5px; }
.l520-choice-head h3 {
  margin: 0;
  color: var(--burgundy);
  font-family: 'Noto Serif SC', serif;
  font-weight: 500;
  font-size: 14.5px;
  letter-spacing: 3px;
  text-indent: 3px;
}
.l520-choice-head .sub {
  font-family: 'Cormorant Garamond', serif;
  font-style: italic;
  color: var(--gold-deep);
  font-size: 10.5px;
  letter-spacing: 2px;
  margin-top: 4px;
}
.l520-choice-row {
  display: flex; align-items: center; gap: 12px;
  width: 100%;
  padding: 10px 12px;
  background: linear-gradient(180deg, rgba(255,255,255,0.6), rgba(245,234,212,0.4));
  border: 1px solid rgba(184,146,63,0.4);
  border-radius: 2px;
  margin-bottom: 8px;
  font-family: 'Noto Serif SC', serif;
  font-size: 12.5px;
  font-weight: 400;
  color: var(--ink);
  cursor: pointer;
  transition: all .25s ease;
  text-align: left;
  letter-spacing: 1px;
}
.l520-choice-row:hover { background: linear-gradient(180deg, #fff8ec, #f5ead4); border-color: var(--gold); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(122,46,58,0.15); }
.l520-choice-row:active { transform: translateY(1px); }
.l520-choice-row .num {
  width: 26px; height: 26px;
  border-radius: 50%;
  background: var(--burgundy-grad);
  color: #fff8ec;
  display: grid; place-items: center;
  font-family: 'Cinzel', serif;
  font-weight: 500;
  font-size: 11px;
  flex-shrink: 0;
  box-shadow: 0 2px 4px rgba(122,46,58,0.3);
  border: 1px solid var(--gold);
}
.l520-choice-row .text { flex: 1; }

.l520-drawer-mask {
  position: absolute; inset: 0;
  background: rgba(74,36,24,0.45);
  backdrop-filter: blur(8px);
  z-index: 25;
  animation: l520-maskin .25s ease;
}
.l520-drawer {
  position: absolute;
  left: 8px; right: 8px; bottom: 8px;
  background: linear-gradient(180deg, #fffaef 0%, #f5ead4 100%);
  border-radius: 4px;
  padding: 14px 14px 18px;
  z-index: 26;
  box-shadow: 0 -10px 40px rgba(74,36,24,0.3), 0 0 0 1px var(--gold), 0 0 0 4px var(--ivory), 0 0 0 5px var(--gold-light);
  animation: l520-drawerin .4s cubic-bezier(.4,1.3,.5,1);
  max-height: 70vh;
  overflow-y: auto;
}
@keyframes l520-drawerin { from { transform: translateY(110%); } to { transform: translateY(0); } }
.l520-drawer-handle {
  width: 38px; height: 3px;
  background: var(--gold);
  border-radius: 999px;
  margin: 0 auto 10px;
  opacity: 0.6;
}
.l520-drawer-head { text-align: center; margin-bottom: 12px; }
.l520-drawer-head h4 {
  margin: 0;
  color: var(--burgundy);
  font-family: 'Noto Serif SC', serif;
  font-weight: 500;
  font-size: 13px;
  letter-spacing: 6px;
  text-indent: 6px;
}
.l520-drawer-head .sub {
  font-family: 'Cormorant Garamond', serif;
  font-style: italic;
  color: var(--gold-deep);
  font-size: 9.5px;
  letter-spacing: 3px;
  margin-top: 2px;
}
.l520-drawer-head .line {
  display: flex; align-items: center; justify-content: center;
  gap: 6px;
  color: var(--gold);
  font-size: 10px;
  margin-top: 5px;
}
.l520-drawer-head .line::before, .l520-drawer-head .line::after {
  content: '';
  width: 45px; height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
}

.l520-items {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.l520-item {
  aspect-ratio: 1;
  background: linear-gradient(180deg, rgba(255,248,236,0.9), rgba(245,234,212,0.7));
  border: 1px solid var(--gold-light);
  border-radius: 2px;
  cursor: pointer;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 4px;
  position: relative;
  transition: all .2s ease;
  overflow: hidden;
  padding: 6px;
}
.l520-item::before, .l520-item::after {
  content: '';
  position: absolute;
  width: 7px; height: 7px;
}
.l520-item::before { top: 4px; left: 4px; border-top: 1px solid var(--gold); border-left: 1px solid var(--gold); }
.l520-item::after  { bottom: 4px; right: 4px; border-bottom: 1px solid var(--gold); border-right: 1px solid var(--gold); }
.l520-item:hover:not(:disabled) { background: linear-gradient(180deg, #fff8ec, #f5ead4); border-color: var(--gold); transform: translateY(-2px); }
.l520-item:active:not(:disabled) { transform: translateY(1px); }
.l520-item:disabled { opacity: 0.3; cursor: not-allowed; }
.l520-item .emoji {
  font-size: 24px;
  line-height: 1;
  filter: drop-shadow(0 2px 3px rgba(139,105,20,0.3));
}
.l520-item .label {
  font-size: 10px;
  color: var(--burgundy);
  font-family: 'Noto Serif SC', serif;
  font-weight: 500;
  letter-spacing: 1px;
}
.l520-item.rare { background: linear-gradient(180deg, #fff5d8, #e8d5a8); border-color: var(--gold); }
.l520-item.rare::before, .l520-item.rare::after { border-color: var(--burgundy); }
.l520-item.rare .ribbon {
  position: absolute;
  top: 3px; left: 3px;
  background: var(--burgundy-grad);
  color: var(--gold-light);
  font-family: 'Cinzel', serif;
  font-size: 7.5px;
  letter-spacing: 1px;
  padding: 1px 4px;
  border-radius: 1px;
  border: 0.5px solid var(--gold);
}
.l520-item.used::after { content: '✓'; position: absolute; inset: 0; background: rgba(255,248,236,0.85); display: grid; place-items: center; color: var(--gold-deep); font-size: 18px; font-family: 'Cinzel', serif; border: none; width: auto; height: auto; }

/* ===== Letter ===== */
.l520-letter-stage {
  flex: 1; overflow-y: auto;
  padding: 14px 18px 18px;
  position: relative; z-index: 5;
}
.l520-letter-paper {
  position: relative;
  background: linear-gradient(180deg, #fffefb 0%, #fbf6ec 100%);
  border-radius: 4px;
  padding: 32px 26px 28px;
  box-shadow:
    0 12px 32px rgba(160,120,90,0.12),
    0 0 0 1px rgba(212,177,106,0.45),
    0 0 0 4px #fffaf0,
    0 0 0 5px rgba(212,177,106,0.35);
  background-image: repeating-linear-gradient(transparent, transparent 28px, rgba(184,146,63,0.035) 28px, rgba(184,146,63,0.035) 29px);
}
.l520-letter-paper::before, .l520-letter-paper::after,
.l520-letter-paper .lp-tl, .l520-letter-paper .lp-tr {
  content: '';
  position: absolute;
  width: 16px; height: 16px;
  border: 1px solid rgba(157,107,120,0.55);
}
.l520-letter-paper::before { top: 8px; left: 8px; border-right: none; border-bottom: none; }
.l520-letter-paper::after  { top: 8px; right: 8px; border-left: none; border-bottom: none; }
.l520-letter-paper .lp-tl  { bottom: 8px; left: 8px; border-right: none; border-top: none; }
.l520-letter-paper .lp-tr  { bottom: 8px; right: 8px; border-left: none; border-top: none; }
.l520-letter-header {
  text-align: center;
  margin-bottom: 20px;
}
.l520-letter-eyebrow {
  font-family: 'Cormorant Garamond', serif;
  font-style: italic;
  font-size: 12px;
  color: #b89460;
  letter-spacing: 4px;
  margin-bottom: 6px;
}
.l520-letter-title {
  font-family: 'Noto Serif SC', serif;
  font-weight: 500;
  font-size: 22px;
  color: #9d6b78;
  letter-spacing: 8px;
  text-indent: 8px;
  margin: 4px 0 10px;
}
.l520-letter-divider {
  color: rgba(184,146,63,0.7);
  font-size: 12px;
  letter-spacing: 10px;
}
.l520-letter-body {
  font-family: 'Noto Serif SC', serif;
  font-size: 14.5px;
  line-height: 2.1;
  color: #5a4a40;
  letter-spacing: 0.6px;
  text-indent: 2em;
  white-space: pre-wrap;
  margin-bottom: 24px;
}
.l520-letter-foot {
  text-align: right;
  padding-top: 8px;
  border-top: 0.5px dashed rgba(184,146,63,0.25);
}
.l520-letter-flourish {
  color: rgba(184,146,63,0.7);
  font-size: 12px;
  letter-spacing: 6px;
  margin: 6px 0 8px;
}
.l520-letter-signature {
  font-family: 'Noto Serif SC', serif;
  font-size: 14px;
  color: #9d6b78;
  letter-spacing: 4px;
  text-indent: 4px;
  margin-bottom: 8px;
}
.l520-letter-seal {
  display: inline-block;
  width: 36px; height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, #c89aa5 0%, #9d6b78 70%, #7d5460 100%);
  color: #fff5e8;
  line-height: 36px;
  text-align: center;
  font-size: 16px;
  box-shadow: 0 3px 6px rgba(125,84,96,0.25), inset 0 1px 0 rgba(255,255,255,0.22);
  transform: rotate(-8deg);
  border: 1px solid rgba(212,177,106,0.6);
}
.l520-letter-accept {
  display: block;
  margin: 16px auto 8px;
  padding: 11px 30px;
  background: linear-gradient(135deg, #c89aa5 0%, #9d6b78 70%, #7d5460 100%);
  color: #fffaf0;
  font-family: 'Noto Serif SC', serif;
  font-size: 13.5px;
  letter-spacing: 4px;
  text-indent: 4px;
  border: 1px solid rgba(212,177,106,0.6);
  border-radius: 2px;
  cursor: pointer;
  box-shadow: 0 5px 12px rgba(125,84,96,0.22), inset 0 1px 0 rgba(255,255,255,0.18);
  transition: transform .15s ease;
  position: relative;
}
.l520-letter-accept:active { transform: translateY(2px); }
.l520-letter-accept::before, .l520-letter-accept::after {
  content: '';
  position: absolute;
  width: 6px; height: 6px;
}
.l520-letter-accept::before { top: 3px; left: 3px; border-top: 1px solid var(--gold-light); border-left: 1px solid var(--gold-light); }
.l520-letter-accept::after  { bottom: 3px; right: 3px; border-bottom: 1px solid var(--gold-light); border-right: 1px solid var(--gold-light); }
`;

const CornerOrnamentSVG: React.FC = () => (
    <svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <g stroke="#b8923f" strokeWidth="0.8" fill="none">
            <path d="M4 4 L4 22 M4 4 L22 4" strokeWidth="1.2" />
            <path d="M4 4 C 14 4, 22 12, 22 22" />
            <path d="M8 8 C 14 8, 18 12, 18 18" opacity="0.5" />
            <circle cx="22" cy="22" r="2.2" fill="#d4b16a" stroke="none" />
            <circle cx="22" cy="22" r="1" fill="#fff8ec" stroke="none" />
            <path d="M16 4 L20 4 M4 16 L4 20" stroke="#d4b16a" strokeWidth="0.5" />
        </g>
    </svg>
);

const Like520StyleTag: React.FC = () => (
    <style dangerouslySetInnerHTML={{ __html: LIKE520_CSS }} />
);

const AmbientLayer: React.FC = () => (
    <div className="l520-ornaments">
        {[...Array(10)].map((_, i) => (
            <span
                key={`s${i}`}
                className="l520-sparkle"
                style={{
                    left: `${Math.random() * 95}%`,
                    top: `${Math.random() * 75}%`,
                    animationDelay: `${Math.random() * 4}s`,
                    width: `${3 + Math.random() * 5}px`,
                    height: `${3 + Math.random() * 5}px`,
                }}
            />
        ))}
        <span className="l520-flourish" style={{ left: '8%', top: '15%', fontSize: 60 }}>❦</span>
        <span className="l520-flourish" style={{ left: '88%', top: '45%', fontSize: 40 }}>❀</span>
    </div>
);

const CornerOrnaments: React.FC = () => (
    <>
        <span className="l520-corner tl"><CornerOrnamentSVG /></span>
        <span className="l520-corner tr"><CornerOrnamentSVG /></span>
        <span className="l520-corner bl"><CornerOrnamentSVG /></span>
        <span className="l520-corner br"><CornerOrnamentSVG /></span>
    </>
);

// ============================================================
// OrnateDialog — galgame 风格对白盒（带角描金 + 名牌 + mini 头像）
// ============================================================

const OrnateDialog: React.FC<{
    charName: string;
    text?: string;
    children?: React.ReactNode;
    onAdvance?: () => void;
    showArrow?: boolean;
    arrowText?: string;
    pageInfo?: string;
    tall?: boolean;
}> = ({ charName, text, children, onAdvance, showArrow, arrowText = '— next —', pageInfo, tall }) => (
    <div
        className={`l520-dialog ${tall ? 'tall' : ''} ${onAdvance ? 'clickable' : ''}`}
        onClick={(e) => { if (onAdvance) { e.stopPropagation(); onAdvance(); } }}
    >
        <span className="corner-tl" />
        <span className="corner-tr" />
        <div className="speaker">{charName}</div>
        {pageInfo && <div className="pageinfo">{pageInfo}</div>}
        {children}
        {text !== undefined && <div className="body-text">{text}</div>}
        {showArrow && <span className="next-arrow">{arrowText}</span>}
    </div>
);

// ============================================================
// OrnateChoice — 居中浮层（ornate card 风格，Roman numeral）
// ============================================================

interface OrnateChoiceProps {
    title: string;
    sub?: string;
    options: { key: string; label: string }[];
    onPick: (key: string) => void;
}

const ROMANS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

const OrnateChoice: React.FC<OrnateChoiceProps> = ({ title, sub, options, onPick }) => (
    <div className="l520-mask">
        <div className="l520-choice-card">
            <span className="cc-tl" />
            <span className="cc-tr" />
            <div className="l520-choice-head">
                <div className="ornament">❦ ⸙ ❦</div>
                <h3>{title}</h3>
                {sub && <div className="sub">{sub}</div>}
            </div>
            {options.map((opt, i) => (
                <button
                    key={opt.key}
                    className="l520-choice-row"
                    onClick={() => onPick(opt.key)}
                >
                    <span className="num">{ROMANS[i] || String(i + 1)}</span>
                    <span className="text">{opt.label}</span>
                </button>
            ))}
        </div>
    </div>
);

// ============================================================
// 心愿小纸条 —— 展开来给 user 看 char 偷偷写下的那行字
// ============================================================

const WishPaperOverlay: React.FC<{
    sceneText: string;
    userAction: string;
    onDismiss: () => void;
}> = ({ sceneText, userAction, onDismiss }) => {
    const [phase, setPhase] = useState<0 | 1 | 2>(0); // 0:进入 1:展开 2:可读
    useEffect(() => {
        const t1 = setTimeout(() => setPhase(1), 250);
        const t2 = setTimeout(() => setPhase(2), 1200);
        return () => { clearTimeout(t1); clearTimeout(t2); };
    }, []);

    // 把 scene 文本切成"动作旁白 + 那行字"两段——找冒号或破折号后的内容
    // LLM 输出格式：「user 翻到那张纸——上面写着……，那行字是：（XXX）」
    const { caption, wishLine } = useMemo(() => {
        const m = sceneText.match(/[:：][\s]*[「『"""]?([^」』"""]+?)[」』"""]?\s*$/);
        if (m && m[1] && m[1].length > 4) {
            const cap = sceneText.slice(0, sceneText.lastIndexOf(m[0])).trim();
            return { caption: cap, wishLine: m[1].trim() };
        }
        const dashM = sceneText.match(/[—\-]{1,2}\s*([^—\-]{6,})$/);
        if (dashM && dashM[1]) {
            const cap = sceneText.slice(0, sceneText.lastIndexOf(dashM[0])).trim();
            return { caption: cap, wishLine: dashM[1].trim() };
        }
        return { caption: '', wishLine: sceneText };
    }, [sceneText]);

    return (
        <div
            onClick={onDismiss}
            style={{
                position: 'absolute',
                inset: 0,
                zIndex: 9998,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'radial-gradient(ellipse at center, rgba(40,20,30,0.72) 0%, rgba(20,10,15,0.86) 100%)',
                backdropFilter: 'blur(2px)',
                cursor: 'pointer',
                padding: 20,
                opacity: phase >= 1 ? 1 : 0,
                transition: 'opacity 0.4s ease-out',
            }}
        >
            <style>{`
                @keyframes l520-wish-unfold {
                    0%   { transform: scale(0.18) rotate(-14deg) translateY(40px); opacity: 0; }
                    35%  { transform: scale(0.62) rotate(-6deg) translateY(20px); opacity: 1; }
                    65%  { transform: scale(1.04) rotate(-1deg) translateY(0); }
                    100% { transform: scale(1) rotate(-1.6deg) translateY(0); opacity: 1; }
                }
                @keyframes l520-wish-text-in {
                    from { opacity: 0; letter-spacing: 8px; filter: blur(4px); }
                    to   { opacity: 1; letter-spacing: 2.5px; filter: blur(0); }
                }
                @keyframes l520-wish-caption-in {
                    from { opacity: 0; transform: translateY(-6px); }
                    to   { opacity: 0.85; transform: translateY(0); }
                }
                .l520-wish-paper {
                    position: relative;
                    width: min(86vw, 380px);
                    max-height: min(78vh, 540px);
                    padding: 38px 32px 44px;
                    background:
                        linear-gradient(176deg, #fffdf4 0%, #fdf5e0 55%, #f6e9c8 100%);
                    box-shadow:
                        0 18px 50px rgba(0,0,0,0.45),
                        0 4px 12px rgba(122,46,58,0.18),
                        inset 0 0 0 1px rgba(184,146,63,0.25);
                    border-radius: 4px;
                    transform: rotate(-1.6deg);
                    animation: l520-wish-unfold 0.95s cubic-bezier(0.22, 1.1, 0.36, 1) both;
                    display: flex;
                    flex-direction: column;
                }
                .l520-wish-scroll {
                    overflow-y: auto;
                    overflow-x: hidden;
                    flex: 1;
                    min-height: 0;
                    /* 隐藏 webkit 滚动条 */
                    scrollbar-width: thin;
                    scrollbar-color: rgba(184,146,63,0.4) transparent;
                }
                .l520-wish-scroll::-webkit-scrollbar { width: 4px; }
                .l520-wish-scroll::-webkit-scrollbar-thumb { background: rgba(184,146,63,0.35); border-radius: 2px; }
                /* 四角小金线装饰 */
                .l520-wish-paper .corner {
                    position: absolute;
                    width: 14px; height: 14px;
                    border: 0.5px solid rgba(184,146,63,0.6);
                }
                .l520-wish-paper .corner.tl { top: 8px; left: 8px; border-right: none; border-bottom: none; }
                .l520-wish-paper .corner.tr { top: 8px; right: 8px; border-left: none; border-bottom: none; }
                .l520-wish-paper .corner.bl { bottom: 8px; left: 8px; border-right: none; border-top: none; }
                .l520-wish-paper .corner.br { bottom: 8px; right: 8px; border-left: none; border-top: none; }
                .l520-wish-eyebrow {
                    text-align: center;
                    font-family: 'Cormorant Garamond', serif;
                    font-style: italic;
                    font-size: 10px;
                    letter-spacing: 8px;
                    color: rgba(122,46,58,0.65);
                    margin-bottom: 14px;
                    text-transform: uppercase;
                }
                .l520-wish-caption {
                    font-family: 'Noto Serif SC', serif;
                    font-size: 11.5px;
                    color: rgba(92,58,74,0.78);
                    line-height: 1.9;
                    text-align: center;
                    margin-bottom: 18px;
                    letter-spacing: 0.5px;
                    opacity: 0;
                    animation: l520-wish-caption-in 0.5s ease-out 0.7s forwards;
                }
                .l520-wish-divider {
                    text-align: center;
                    color: rgba(184,146,63,0.6);
                    font-size: 10px;
                    letter-spacing: 10px;
                    margin: 14px 0 18px;
                }
                .l520-wish-line {
                    font-family: 'Noto Serif SC', serif;
                    font-weight: 500;
                    font-size: clamp(13px, 4.2vw, 17px);
                    line-height: 2;
                    color: #5a2230;
                    text-align: center;
                    letter-spacing: 1.6px;
                    text-indent: 1.6px;
                    opacity: 0;
                    animation: l520-wish-text-in 1.4s cubic-bezier(0.16, 1, 0.3, 1) 1s forwards;
                    white-space: pre-wrap;
                    word-break: break-word;
                    overflow-wrap: break-word;
                    padding: 0 2px;
                }
                .l520-wish-line.long {
                    font-size: clamp(12px, 3.6vw, 15px);
                    line-height: 1.85;
                    letter-spacing: 1.2px;
                    text-align: left;
                    text-indent: 2em;
                }
                .l520-wish-action {
                    position: absolute;
                    top: -32px;
                    left: 0; right: 0;
                    text-align: center;
                    font-family: 'Cormorant Garamond', serif;
                    font-style: italic;
                    font-size: 11px;
                    letter-spacing: 3px;
                    color: rgba(255,236,212,0.7);
                    opacity: 0;
                    animation: l520-wish-caption-in 0.6s ease-out 0.4s forwards;
                }
                .l520-wish-hint {
                    text-align: center;
                    margin-top: 22px;
                    font-family: 'Cormorant Garamond', serif;
                    font-style: italic;
                    font-size: 10px;
                    letter-spacing: 4px;
                    color: rgba(122,46,58,0.5);
                    opacity: 0;
                    animation: l520-wish-caption-in 0.5s ease-out 2.3s forwards;
                }
            `}</style>
            <div className="l520-wish-paper" onClick={(e) => e.stopPropagation()}>
                <span className="corner tl" />
                <span className="corner tr" />
                <span className="corner bl" />
                <span className="corner br" />
                <div className="l520-wish-action">— {userAction} —</div>
                <div className="l520-wish-eyebrow">a small wish</div>
                <div className="l520-wish-scroll">
                    {caption && <div className="l520-wish-caption">{caption}</div>}
                    <div className="l520-wish-divider">❦ ⸙ ❦</div>
                    <div className={`l520-wish-line ${wishLine.length > 36 ? 'long' : ''}`}>{wishLine}</div>
                </div>
                <div className="l520-wish-hint" onClick={onDismiss} style={{ cursor: 'pointer' }}>
                    — 轻 触 任 意 处 继 续 —
                </div>
            </div>
        </div>
    );
};

// ============================================================
// 慢慢睁开眼 —— 进入梦境
// ============================================================

const EyesOpeningOverlay: React.FC<{ onDone: () => void }> = ({ onDone }) => {
    const [phase, setPhase] = useState<0 | 1 | 2 | 3>(0); // 0:全黑 1:微微一缝 2:渐开 3:淡出
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;
    useEffect(() => {
        const t1 = setTimeout(() => setPhase(1), 500);
        const t2 = setTimeout(() => setPhase(2), 1600);
        const t3 = setTimeout(() => setPhase(3), 3000);
        const t4 = setTimeout(() => onDoneRef.current(), 3900);
        return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
    }, []);

    return (
        <div
            onClick={() => { setPhase(3); setTimeout(onDone, 400); }}
            style={{
                position: 'absolute',
                inset: 0,
                zIndex: 9999,
                background: '#000',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                opacity: phase === 3 ? 0 : 1,
                transition: 'opacity 0.7s ease-out',
            }}
        >
            {/* 上下睑闭合的眼睑感 — 两个黑条往中间夹 */}
            <div style={{
                position: 'absolute',
                top: 0, left: 0, right: 0,
                background: '#000',
                height: phase === 0 ? '50%' : phase === 1 ? '46%' : '0%',
                transition: 'height 1.1s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: '0 6px 24px rgba(0,0,0,0.7)',
            }} />
            <div style={{
                position: 'absolute',
                bottom: 0, left: 0, right: 0,
                background: '#000',
                height: phase === 0 ? '50%' : phase === 1 ? '46%' : '0%',
                transition: 'height 1.1s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: '0 -6px 24px rgba(0,0,0,0.7)',
            }} />

            {/* 朦胧光晕 */}
            <div style={{
                position: 'absolute',
                inset: 0,
                background: 'radial-gradient(ellipse at center, rgba(255,228,236,0.35) 0%, rgba(255,182,200,0.18) 30%, transparent 65%)',
                opacity: phase >= 1 ? 1 : 0,
                transition: 'opacity 1.2s ease-in',
                filter: 'blur(8px)',
            }} />

            {/* 提示文字 */}
            <div style={{
                color: 'rgba(255,228,236,0.65)',
                fontFamily: "'Cormorant Garamond', serif",
                fontStyle: 'italic',
                fontSize: 13,
                letterSpacing: 6,
                opacity: phase === 2 ? 1 : 0,
                transition: 'opacity 0.9s ease-in',
                textAlign: 'center',
                lineHeight: 2,
            }}>
                <div style={{ fontSize: 10, letterSpacing: 10, marginBottom: 6 }}>—— 慢慢 ——</div>
                <div>睁&nbsp;开&nbsp;眼&nbsp;睛</div>
                <div style={{ fontSize: 10, letterSpacing: 4, marginTop: 12, opacity: 0.6 }}>（点击跳过）</div>
            </div>
        </div>
    );
};

// ============================================================
// 慢慢闭上眼 —— 回到现实（DoneView 退场前用）
// ============================================================

const EyesClosingOverlay: React.FC<{ onDone: () => void }> = ({ onDone }) => {
    // 0: 透明 — 让 DoneView 还看得见
    // 1: 朦胧光晕渐起、眼睑开始合拢
    // 2: 眼睑几乎合上
    // 3: 全黑 → onDone
    const [phase, setPhase] = useState<0 | 1 | 2 | 3>(0);
    // 用 ref 锁住 onDone —— 父组件 inline arrow 会让 onDone 每次 render 变身份，
    // 如果直接放进 [onDone] dep，父任意 re-render 都会把 setTimeout 链清光重启，
    // 动画就永远走不到 3200ms 那一步（卡在半路）。
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;
    useEffect(() => {
        const t1 = setTimeout(() => setPhase(1), 80);
        const t2 = setTimeout(() => setPhase(2), 1300);
        const t3 = setTimeout(() => setPhase(3), 2400);
        const t4 = setTimeout(() => onDoneRef.current(), 3200);
        return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
    }, []);

    return (
        <div
            style={{
                position: 'absolute',
                inset: 0,
                zIndex: 9999,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'auto',
                background: phase >= 3 ? '#000' : 'transparent',
                transition: 'background 0.7s ease-in',
            }}
        >
            {/* 上下睑慢慢往中间合拢 */}
            <div style={{
                position: 'absolute',
                top: 0, left: 0, right: 0,
                background: '#000',
                height: phase === 0 ? '0%' : phase === 1 ? '28%' : phase === 2 ? '46%' : '50%',
                transition: 'height 1.3s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: phase >= 1 ? '0 6px 24px rgba(0,0,0,0.6)' : 'none',
            }} />
            <div style={{
                position: 'absolute',
                bottom: 0, left: 0, right: 0,
                background: '#000',
                height: phase === 0 ? '0%' : phase === 1 ? '28%' : phase === 2 ? '46%' : '50%',
                transition: 'height 1.3s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: phase >= 1 ? '0 -6px 24px rgba(0,0,0,0.6)' : 'none',
            }} />

            {/* 中间过渡光晕：从粉色 → 渐弱 */}
            <div style={{
                position: 'absolute',
                inset: 0,
                background: 'radial-gradient(ellipse at center, rgba(255,228,236,0.35) 0%, rgba(255,182,200,0.12) 30%, transparent 65%)',
                opacity: phase === 1 ? 1 : phase === 2 ? 0.4 : 0,
                transition: 'opacity 1.0s ease-out',
                filter: 'blur(8px)',
                pointerEvents: 'none',
            }} />

            {/* 闭眼提示文字 */}
            <div style={{
                color: 'rgba(255,228,236,0.7)',
                fontFamily: "'Cormorant Garamond', serif",
                fontStyle: 'italic',
                fontSize: 13,
                letterSpacing: 6,
                opacity: phase === 1 || phase === 2 ? 1 : 0,
                transition: 'opacity 0.7s ease-in-out',
                textAlign: 'center',
                lineHeight: 2,
                pointerEvents: 'none',
            }}>
                <div style={{ fontSize: 10, letterSpacing: 10, marginBottom: 6 }}>—— 慢慢 ——</div>
                <div>闭&nbsp;上&nbsp;眼&nbsp;睛</div>
                <div style={{ fontSize: 9, letterSpacing: 4, marginTop: 14, opacity: 0.55 }}>see you ~</div>
            </div>
        </div>
    );
};

// ============================================================
// Y520Scene — 持久化养成场景（珍重 风格）
// 覆盖 eyes_opening → opening → 吐槽 → free（锚点+抚摸）→ reveal → 自我意识
// ============================================================

type Y520Stage =
    | 'eyes_opening'
    | 'opening'
    | 'tucao_choose'
    | 'tucao_reply'
    | 'free'
    | 'anchor_action_choose'
    | 'anchor_playing'
    | 'touch_playing'
    | 'reveal'
    | 'self_reveal_hint'
    | 'self_reveal_choose';

const SELF_REVEAL_HINT_LINES = ['（你下意识低头看了看自己——）'];
const SELF_REVEAL_OPTIONS: { key: string; label: string }[] = [
    { key: 'eh', label: '「诶？」' },
    { key: 'silence', label: '「……」' },
    { key: 'look', label: '（你仔细看了看）' },
];

interface Y520SceneProps {
    callA: Like520CallAResult;
    charName: string;
    charAvatar?: string;
    charChibiUrl: string;
    onTucaoSelected: (key: Like520TucaoKey) => void;
    onComplete: () => void;
    /** 回放模式：传入则自动用这个吐槽选项，跳过 tucao_choose 阶段 */
    initialChosenTucao?: Like520TucaoKey;
}

const Y520Scene: React.FC<Y520SceneProps> = ({ callA, charName, charAvatar, charChibiUrl, onTucaoSelected, onComplete, initialChosenTucao }) => {
    const isReplay = !!initialChosenTucao;
    const [stage, setStage] = useState<Y520Stage>(isReplay ? 'opening' : 'eyes_opening');
    const [queue, setQueue] = useState<string[]>(callA.opening);
    const [lineIdx, setLineIdx] = useState(0);
    const [usedAnchors, setUsedAnchors] = useState<Set<number>>(new Set());
    const [activeAnchorIdx, setActiveAnchorIdx] = useState<number | null>(null);
    const [wishPaperOpen, setWishPaperOpen] = useState(false);
    const [chosenUserAction, setChosenUserAction] = useState<string | null>(null);
    const [touchIdx, setTouchIdx] = useState(0);
    const [showHint, setShowHint] = useState(true);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [petting, setPetting] = useState(false);
    const [stats, setStats] = useState({ mood: 62, love: 48, food: 50, energy: 78 });

    const stageRef = useRef<HTMLDivElement>(null);
    const fxRef = useRef<HTMLDivElement>(null);

    const allAnchorsUsed = usedAnchors.size >= callA.anchors.length;
    const currentLine = queue[lineIdx];
    const hasMoreLines = lineIdx < queue.length - 1;
    const activeAnchor = activeAnchorIdx !== null ? callA.anchors[activeAnchorIdx] : null;
    const showSceneNarration = stage === 'anchor_playing' && chosenUserAction;
    const nameTag = stage === 'self_reveal_hint' ? '——' : charName;

    // free + 全部锚点用完 → 自动 reveal
    useEffect(() => {
        if (stage === 'free' && allAnchorsUsed) {
            const t = setTimeout(() => {
                setQueue(callA.reveal_transition);
                setLineIdx(0);
                setStage('reveal');
            }, 800);
            return () => clearTimeout(t);
        }
    }, [stage, allAnchorsUsed, callA.reveal_transition]);

    const spawnParticles = (x: number, y: number, count: number) => {
        const fx = fxRef.current;
        if (!fx) return;
        const glyphs = ['♡', '♥', '✦', '✧', '❀', '❦', '·'];
        for (let i = 0; i < count; i++) {
            const el = document.createElement('div');
            el.className = 'l520-particle';
            el.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
            el.style.setProperty('--tx', `${Math.random() * 140 - 70}px`);
            el.style.setProperty('--rot', `${Math.random() * 60 - 30}deg`);
            el.style.left = `${x - 7}px`;
            el.style.top = `${y - 7}px`;
            el.style.animationDelay = `${Math.random() * 0.2}s`;
            el.style.fontSize = `${10 + Math.random() * 10}px`;
            if (Math.random() > 0.6) el.style.color = '#b27566';
            fx.appendChild(el);
            setTimeout(() => el.remove(), 1700);
        }
    };
    const spawnReact = (text: string, x: number, y: number) => {
        const fx = fxRef.current;
        if (!fx) return;
        const el = document.createElement('div');
        el.className = 'l520-react';
        el.textContent = text;
        el.style.left = `${x - 40}px`;
        el.style.top = `${y}px`;
        fx.appendChild(el);
        setTimeout(() => el.remove(), 1800);
    };
    const spawnScore = (text: string, x: number, y: number) => {
        const fx = fxRef.current;
        if (!fx) return;
        const el = document.createElement('div');
        el.className = 'l520-floatscore';
        el.textContent = text;
        el.style.left = `${x - 30}px`;
        el.style.top = `${y}px`;
        fx.appendChild(el);
        setTimeout(() => el.remove(), 1600);
    };

    const advance = () => {
        // 心愿小纸条展开中：点哪都是先收起纸条，对白下一次再推
        if (wishPaperOpen) { setWishPaperOpen(false); return; }
        if (!queue.length) return;
        if (hasMoreLines) {
            setLineIdx(i => i + 1);
            return;
        }
        if (stage === 'opening') {
            // 回放模式：吐槽选项已经选好了，直接跳到 tucao_reply 用之前的回应
            if (initialChosenTucao) {
                setQueue(callA.tucao_responses[initialChosenTucao]);
                setLineIdx(0);
                setStage('tucao_reply');
            } else {
                setStage('tucao_choose'); setQueue([]); setLineIdx(0);
            }
        } else if (stage === 'tucao_reply') {
            setStage('free'); setQueue([]); setLineIdx(0);
        } else if (stage === 'anchor_playing') {
            if (activeAnchorIdx !== null) setUsedAnchors(prev => new Set(prev).add(activeAnchorIdx));
            setActiveAnchorIdx(null);
            setChosenUserAction(null);
            setWishPaperOpen(false);
            // 数值波动（纯装饰）
            setStats(s => ({
                mood: Math.min(100, s.mood + 4 + Math.floor(Math.random() * 4)),
                love: Math.min(100, s.love + 5 + Math.floor(Math.random() * 5)),
                food: Math.min(100, s.food + 3 + Math.floor(Math.random() * 4)),
                energy: Math.max(0, Math.min(100, s.energy + Math.floor(Math.random() * 6) - 2)),
            }));
            setStage('free'); setQueue([]); setLineIdx(0);
        } else if (stage === 'touch_playing') {
            setStage('free'); setQueue([]); setLineIdx(0);
        } else if (stage === 'reveal') {
            setQueue(SELF_REVEAL_HINT_LINES); setLineIdx(0); setStage('self_reveal_hint');
        } else if (stage === 'self_reveal_hint') {
            setQueue([]); setLineIdx(0); setStage('self_reveal_choose');
        }
    };

    const pickTucao = (key: Like520TucaoKey) => {
        if (stage !== 'tucao_choose') return;
        onTucaoSelected(key);
        setQueue(callA.tucao_responses[key]);
        setLineIdx(0);
        setStage('tucao_reply');
    };

    const startAnchor = (idx: number) => {
        if (stage !== 'free' || usedAnchors.has(idx)) return;
        setDrawerOpen(false);
        setActiveAnchorIdx(idx);
        setChosenUserAction(null);
        setStage('anchor_action_choose');
    };

    const pickUserAction = (action: string) => {
        if (stage !== 'anchor_action_choose' || activeAnchorIdx === null) return;
        const anchor = callA.anchors[activeAnchorIdx];
        setChosenUserAction(action);
        setQueue(anchor.dialogue);
        setLineIdx(0);
        setStage('anchor_playing');
        // 心愿锚点：先展开小纸条让 user 读完，再放对白
        if (anchor.is_photo_anchor) setWishPaperOpen(true);
    };

    const pickSelfReveal = (_k: string) => {
        if (stage !== 'self_reveal_choose') return;
        onComplete();
    };

    const petCharacter = (ev?: { clientX?: number; clientY?: number }) => {
        if (stage !== 'free' || callA.touch_lines.length === 0) return;
        setShowHint(false);
        setPetting(true);
        setTimeout(() => setPetting(false), 750);

        const stageEl = stageRef.current;
        if (stageEl && ev) {
            const rect = stageEl.getBoundingClientRect();
            const cx = (ev.clientX ?? rect.left + rect.width / 2) - rect.left;
            const cy = (ev.clientY ?? rect.top + rect.height * 0.4) - rect.top;
            spawnParticles(cx, cy, 7);
            const triggerReact = (touchIdx + 1) % 3 === 0;
            if (triggerReact) {
                setStats(s => ({ ...s, mood: Math.min(100, s.mood + 3), love: Math.min(100, s.love + 2) }));
                spawnScore('+ 悦 · 情', cx, cy - 40);
                const reacts = ['…心动了', '再一次嘛', '你的手好温', '♡', '…嗯'];
                spawnReact(reacts[Math.floor(Math.random() * reacts.length)], cx, cy - 80);
            } else {
                setStats(s => ({ ...s, mood: Math.min(100, s.mood + 1) }));
                spawnScore('+1', cx, cy - 30);
            }
        }

        const line = callA.touch_lines[touchIdx % callA.touch_lines.length];
        setQueue([line]);
        setLineIdx(0);
        setStage('touch_playing');
        setTouchIdx(i => i + 1);
    };

    const isChoiceStage = stage === 'tucao_choose' || stage === 'anchor_action_choose' || stage === 'self_reveal_choose';
    const remainingAnchors = callA.anchors.length - usedAnchors.size;

    const renderHint = () => {
        if (stage === 'tucao_choose') return '请于上方做出抉择';
        if (stage === 'anchor_action_choose') return '请于上方做出抉择';
        if (stage === 'self_reveal_choose') return '……';
        if (stage === 'free' && !allAnchorsUsed) return `轻拥${charName}，或自礼匣中取一件`;
        if (stage === 'free' && allAnchorsUsed) return '……';
        return '……';
    };

    // 点画面任意处都能推进对白（除非在选项阶段、或者点到了 data-stop-advance 的按钮 / 浮层）
    const handleStageClick = (e: React.MouseEvent) => {
        if (isChoiceStage) return;
        if (stage === 'eyes_opening') return;
        // 检查点击目标是否声明了"不要触发推进"
        let el = e.target as HTMLElement | null;
        while (el && el !== e.currentTarget) {
            if (el.dataset?.stopAdvance) return;
            el = el.parentElement;
        }
        if (queue.length > 0) advance();
        else if (stage === 'free') petCharacter({ clientX: e.clientX, clientY: e.clientY });
    };

    return (
        <div className="l520-root" onClick={handleStageClick}>
            <Like520StyleTag />
            <CornerOrnaments />
            <AmbientLayer />

            {/* 慢慢睁开眼 —— 进入梦境 */}
            {stage === 'eyes_opening' && (
                <EyesOpeningOverlay onDone={() => setStage('opening')} />
            )}

            {/* 心愿小纸条 —— 展开来给 user 看 */}
            {wishPaperOpen && activeAnchor?.is_photo_anchor && (
                <WishPaperOverlay
                    sceneText={activeAnchor.scene}
                    userAction={chosenUserAction || ''}
                    onDismiss={() => setWishPaperOpen(false)}
                />
            )}

            {/* Top bar */}
            <div className="l520-topbar" data-stop-advance="1">
                <div className="l520-header-row">
                    <div className="l520-occasion">
                        <span className="num">520</span>
                        <span style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 11, letterSpacing: 2 }}>限定典藏</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div className="l520-charpill">
                            {charAvatar?.startsWith('http') || charAvatar?.startsWith('data:')
                                ? <img src={charAvatar} alt={charName} />
                                : <span className="l520-charpill-emoji">{charAvatar || '🌸'}</span>}
                            <span>{charName}</span>
                        </div>
                        <BGMToggle />
                    </div>
                </div>
                <div className="l520-title-strip">
                    <span className="line" />
                    <span className="title">Mon Trésor</span>
                    <span className="line" />
                </div>
                <div className="l520-stats">
                    {([
                        { k: 'mood', label: '悦', cls: 'mood' },
                        { k: 'love', label: '情', cls: 'love' },
                        { k: 'food', label: '膳', cls: 'food' },
                        { k: 'energy', label: '神', cls: 'energy' },
                    ] as const).map(s => (
                        <div key={s.k} className="l520-stat">
                            <span className="l520-stat-label">{s.label}</span>
                            <div className="l520-bar-wrap">
                                <div className={`l520-bar ${s.cls}`}>
                                    <i style={{ width: `${stats[s.k as keyof typeof stats]}%` }} />
                                </div>
                                <span className="l520-bar-num">{stats[s.k as keyof typeof stats]}</span>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Stage */}
            <div className="l520-stage" ref={stageRef}>
                {showHint && stage === 'free' && (
                    <div className="l520-tap-hint">touch me ♡</div>
                )}
                {showSceneNarration && (
                    <div className="l520-scene-narration">
                        <span>（{chosenUserAction}）</span>
                    </div>
                )}
                <div className={`l520-char-wrap ${petting ? 'petting' : ''}`}>
                    <div className="l520-nameplate">
                        <span className="deco">❦</span>
                        <span style={{ marginLeft: 4, marginRight: 4 }}>{charName}</span>
                        <span className="deco">❦</span>
                    </div>
                    <div className="l520-halo" />
                    <div className="l520-ring" />
                    <img className="l520-char-img" src={charChibiUrl} alt={charName} />
                </div>
            </div>

            {/* Dialog */}
            <div style={{ position: 'relative', zIndex: 3, paddingTop: 4 }}>
                <OrnateDialog
                    charName={nameTag}
                    onAdvance={!isChoiceStage && queue.length > 0 ? advance : undefined}
                    showArrow={!isChoiceStage && queue.length > 0}
                    arrowText={stage === 'self_reveal_hint' && !hasMoreLines ? '— continue —' : '— next —'}
                >
                    {currentLine
                        ? <div className="body-text">{currentLine}</div>
                        : <div className="body-text hint-text">（{renderHint()}）</div>}
                </OrnateDialog>
            </div>

            {/* Actions */}
            <div className="l520-actions" data-stop-advance="1">
                <button
                    className="l520-act"
                    disabled={isChoiceStage}
                    onClick={() => {
                        if (queue.length > 0) advance();
                        else petCharacter();
                    }}
                >
                    <svg viewBox="0 0 24 24"><path d="M4 6 C4 5, 5 4, 6 4 L18 4 C19 4, 20 5, 20 6 L20 14 C20 15, 19 16, 18 16 L9 16 L5 19 L5 16 C4.5 16, 4 15.5, 4 15 Z" /></svg>
                    <span>絮&nbsp;语</span>
                </button>
                <button
                    className="l520-act primary"
                    disabled={stage !== 'free'}
                    onClick={(e) => petCharacter({ clientX: (e as any).clientX, clientY: (e as any).clientY })}
                >
                    <svg viewBox="0 0 24 24"><path d="M12 20 C 6 16, 3 12, 3 9 C 3 6, 5 4, 7.5 4 C 9.5 4, 11 5, 12 7 C 13 5, 14.5 4, 16.5 4 C 19 4, 21 6, 21 9 C 21 12, 18 16, 12 20 Z" /></svg>
                    <span>轻&nbsp;拥</span>
                </button>
                <button
                    className="l520-act"
                    disabled={stage !== 'free'}
                    onClick={() => setDrawerOpen(true)}
                >
                    <svg viewBox="0 0 24 24"><path d="M3 8 L21 8 L21 20 L3 20 Z M3 8 L12 4 L21 8 M12 4 L12 20 M8 14 L16 14" /></svg>
                    <span>礼&nbsp;匣</span>
                    {remainingAnchors > 0 && <span className="badge">{remainingAnchors}</span>}
                </button>
            </div>

            {/* FX layer */}
            <div ref={fxRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 7 }} />

            {/* Drawer (items / 礼匣) */}
            {drawerOpen && (
                <>
                    <div
                        className="l520-drawer-mask"
                        data-stop-advance="1"
                        onClick={(e) => { e.stopPropagation(); setDrawerOpen(false); }}
                    />
                    <div className="l520-drawer" data-stop-advance="1">
                        <div className="l520-drawer-handle" />
                        <div className="l520-drawer-head">
                            <h4>礼&nbsp;匣</h4>
                            <div className="sub">L A &nbsp; B O Î T E &nbsp; À &nbsp; T R É S O R</div>
                            <div className="line">❦</div>
                        </div>
                        <div className="l520-items">
                            {callA.anchors.map((a, i) => {
                                const used = usedAnchors.has(i);
                                return (
                                    <button
                                        key={i}
                                        className={`l520-item ${a.is_photo_anchor ? 'rare' : ''} ${used ? 'used' : ''}`}
                                        disabled={used}
                                        onClick={() => startAnchor(i)}
                                    >
                                        {a.is_photo_anchor && <span className="ribbon">RARE</span>}
                                        <span className="emoji">{a.item_icon}</span>
                                        <span className="label">{a.item_label}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </>
            )}

            {/* Centered choice overlays */}
            {stage === 'tucao_choose' && (
                <OrnateChoice
                    title="今日，你的反应是"
                    sub="— Choose Thy Reaction —"
                    options={TUCAO_OPTIONS.map(o => ({ key: o.key, label: `「${o.label}」` }))}
                    onPick={(k) => pickTucao(k as Like520TucaoKey)}
                />
            )}
            {stage === 'anchor_action_choose' && activeAnchor && (
                <OrnateChoice
                    title={`你 要 ${activeAnchor.item_label}`}
                    sub="— Choose Thy Gesture —"
                    options={activeAnchor.user_action_options.map((label, i) => ({ key: String(i), label }))}
                    onPick={(k) => pickUserAction(activeAnchor.user_action_options[Number(k)])}
                />
            )}
            {stage === 'self_reveal_choose' && (
                <OrnateChoice
                    title="你 的 反 应"
                    sub="— Choose Thy Awakening —"
                    options={SELF_REVEAL_OPTIONS}
                    onPick={pickSelfReveal}
                />
            )}
        </div>
    );
};

// ============================================================
// LineQueueView — 短数组对白序列（wake_up 用）
// ============================================================

const LineQueueView: React.FC<{
    lines: string[];
    charName: string;
    charAvatar?: string;
    onComplete: () => void;
}> = ({ lines, charName, charAvatar, onComplete }) => {
    const [idx, setIdx] = useState(0);
    const isLast = idx >= lines.length - 1;
    return (
        <div className="l520-root">
            <Like520StyleTag />
            <CornerOrnaments />
            <AmbientLayer />
            <div style={{ flex: 1 }} />
            <div style={{ position: 'relative', zIndex: 3, paddingBottom: 24 }}>
                <OrnateDialog
                    charName={charName}
                    onAdvance={() => { if (isLast) onComplete(); else setIdx(i => i + 1); }}
                    showArrow
                    arrowText={isLast ? '— continue —' : '— next —'}
                    tall
                >
                    <div key={idx} className="body-text">{lines[idx]}</div>
                </OrnateDialog>
            </div>
        </div>
    );
};

// ============================================================
// WakeUpView — "梦醒"时刻：黑→晨光淡入，"醒 来"浮现，然后对白
// ============================================================

const WakeUpView: React.FC<{
    lines: string[];
    charName: string;
    onComplete: () => void;
}> = ({ lines, charName, onComplete }) => {
    const [stage, setStage] = useState<'dim' | 'awakening' | 'dialog'>('dim');
    const [idx, setIdx] = useState(0);

    useEffect(() => {
        const t1 = setTimeout(() => setStage('awakening'), 1100);
        const t2 = setTimeout(() => setStage('dialog'), 3300);
        return () => { clearTimeout(t1); clearTimeout(t2); };
    }, []);

    const isLast = idx >= lines.length - 1;
    const advance = () => { if (isLast) onComplete(); else setIdx(i => i + 1); };

    const bg =
        stage === 'dim' ? '#0e0608' :
        stage === 'awakening' ? 'linear-gradient(180deg, #0e0608 0%, #3a1f1a 35%, #b27566 75%, #fde8d4 100%)' :
        'linear-gradient(180deg, #faf3e7 0%, #f5ead4 40%, #f3dcd8 100%)';

    return (
        <div
            className="l520-root"
            style={{
                background: bg,
                transition: 'background 1.8s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
        >
            <Like520StyleTag />
            <style>{`
                @keyframes l520-wake-text-in {
                    0%   { opacity: 0; letter-spacing: 24px; }
                    40%  { opacity: 1; letter-spacing: 10px; }
                    80%  { opacity: 1; letter-spacing: 10px; }
                    100% { opacity: 0; letter-spacing: 14px; }
                }
            `}</style>

            {/* "醒 来" 中央浮现 */}
            {stage === 'awakening' && (
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'grid',
                        placeItems: 'center',
                        color: 'rgba(255, 248, 236, 0.92)',
                        fontFamily: "'Noto Serif SC', serif",
                        fontWeight: 300,
                        fontSize: 18,
                        letterSpacing: 10,
                        textIndent: 10,
                        textShadow: '0 0 16px rgba(212, 177, 106, 0.6)',
                        animation: 'l520-wake-text-in 2.2s ease-out both',
                        pointerEvents: 'none',
                    }}
                >
                    醒 · 来
                </div>
            )}

            {/* dialog 阶段：完整装饰 + 对白 */}
            {stage === 'dialog' && (
                <>
                    <CornerOrnaments />
                    <AmbientLayer />
                    <div style={{ flex: 1 }} />
                    <div
                        style={{
                            position: 'relative',
                            zIndex: 3,
                            paddingBottom: 28,
                            animation: 'l520-fade-in 0.8s ease-out both',
                        }}
                    >
                        <OrnateDialog
                            charName={charName}
                            onAdvance={advance}
                            showArrow
                            arrowText={isLast ? '— continue —' : '— next —'}
                            tall
                        >
                            <div key={idx} className="body-text" style={{ animation: 'l520-fade-in 0.6s ease-out both' }}>
                                {lines[idx]}
                            </div>
                        </OrnateDialog>
                    </div>
                    <style>{`
                        @keyframes l520-fade-in {
                            from { opacity: 0; transform: translateY(8px); }
                            to   { opacity: 1; transform: translateY(0); }
                        }
                    `}</style>
                </>
            )}
        </div>
    );
};

// ============================================================
// UncoveredLineView — 第二次捏脸后的长篇真心话
// 双 chibi 居中、user chibi 摇摆挪入
// ============================================================

const UncoveredLineView: React.FC<{
    lines: string[];
    charName: string;
    charAvatar?: string;
    charChibi: string;
    userChibi: string;
    onComplete: () => void;
}> = ({ lines, charName, charAvatar, charChibi, userChibi, onComplete }) => {
    const [idx, setIdx] = useState(0);
    const isLast = idx >= lines.length - 1;

    return (
        <div className="l520-root">
            <Like520StyleTag />
            <CornerOrnaments />
            <AmbientLayer />
            <style>{`
                @keyframes l520-userwaddle {
                    0%   { transform: translateX(160%) rotate(0deg); opacity: 0; }
                    20%  { transform: translateX(120%) rotate(-6deg); opacity: 1; }
                    35%  { transform: translateX(80%) rotate(6deg); }
                    50%  { transform: translateX(45%) rotate(-5deg); }
                    65%  { transform: translateX(18%) rotate(4deg); }
                    80%  { transform: translateX(0) rotate(-3deg); }
                    90%  { transform: translateX(0) rotate(2deg); }
                    100% { transform: translateX(0) rotate(0); }
                }
            `}</style>
            <div className="l520-topbar" style={{ paddingBottom: 0 }}>
                <div className="l520-header-row">
                    <div className="l520-charpill">
                        {charAvatar?.startsWith('http') || charAvatar?.startsWith('data:')
                            ? <img src={charAvatar} alt={charName} />
                            : <span className="l520-charpill-emoji">{charAvatar || '🌸'}</span>}
                        <span>{charName}</span>
                    </div>
                    <div style={{ flex: 1 }} />
                    <BGMToggle />
                </div>
            </div>
            <div className="l520-stage" style={{ paddingBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 12, height: '100%', width: '100%' }}>
                    <img
                        src={charChibi}
                        alt="char"
                        style={{
                            maxHeight: '100%',
                            maxWidth: '42%',
                            objectFit: 'contain',
                            objectPosition: 'bottom',
                            filter: 'drop-shadow(0 12px 18px rgba(122,46,58,0.3))',
                        }}
                    />
                    <img
                        src={userChibi}
                        alt="user"
                        style={{
                            maxHeight: '100%',
                            maxWidth: '42%',
                            objectFit: 'contain',
                            objectPosition: 'bottom',
                            filter: 'drop-shadow(0 12px 18px rgba(122,46,58,0.3))',
                            animation: 'l520-userwaddle 1.6s cubic-bezier(0.34, 1.56, 0.64, 1) both',
                            transformOrigin: 'bottom center',
                        }}
                    />
                </div>
            </div>
            <div style={{ position: 'relative', zIndex: 3, paddingBottom: 18 }}>
                <OrnateDialog
                    charName={charName}
                    onAdvance={() => { if (isLast) onComplete(); else setIdx(i => i + 1); }}
                    showArrow
                    arrowText={isLast ? '— continue —' : '— next —'}
                    pageInfo={`${idx + 1} / ${lines.length}`}
                    tall
                >
                    <div key={idx} className="body-text">{lines[idx]}</div>
                </OrnateDialog>
            </div>
        </div>
    );
};

// ============================================================
// ChoiceOverlay — 居中浮层选项（galgame 选择菜单）
// 不框在对话框里，覆盖在场景中央
// ============================================================

interface ChoiceOverlayProps {
    prompt?: string;
    options: { key: string; label: string }[];
    onPick: (key: string) => void;
}

const ChoiceOverlay: React.FC<ChoiceOverlayProps> = ({ prompt, options, onPick }) => (
    <div className="absolute inset-0 z-[40] flex flex-col items-center justify-center px-6 animate-fade-in pointer-events-none">
        <div className="absolute inset-0 bg-black/35 backdrop-blur-[1px] pointer-events-auto" />
        <div className="relative w-full max-w-[18rem] flex flex-col items-center gap-3 pointer-events-auto">
            {prompt && (
                <div className="text-white text-xs tracking-[6px] mb-1 drop-shadow-lg">{prompt}</div>
            )}
            {options.map((opt, i) => (
                <button
                    key={opt.key}
                    onClick={() => onPick(opt.key)}
                    className="w-full px-5 py-3 rounded-2xl bg-white/95 text-[#5C3A4A] text-[14px] font-medium shadow-xl active:scale-95 active:bg-[#FFE4D5] transition-all border-2 border-white"
                    style={{
                        animation: `fadeSlideIn 0.3s ease ${i * 80}ms backwards`,
                    }}
                >
                    {opt.label}
                </button>
            ))}
        </div>
        <style>{`
            @keyframes fadeSlideIn {
                from { opacity: 0; transform: translateY(8px); }
                to { opacity: 1; transform: translateY(0); }
            }
        `}</style>
    </div>
);

// ============================================================
// 结局画面（黑屏 → 合照 → 标题 → TRUE HAPPY END → description）
// ============================================================

const EndingScreen: React.FC<{
    title: string;
    description: string;
    charChibi: string;
    userChibi: string;
    onNext: () => void;
}> = ({ title, description, charChibi, userChibi, onNext }) => {
    const [step, setStep] = useState(0);

    useEffect(() => {
        const seq = [600, 1400, 1100, 1600, 1300];
        if (step >= seq.length) return;
        const t = setTimeout(() => setStep(s => s + 1), seq[step]);
        return () => clearTimeout(t);
    }, [step]);

    return (
        <div className="absolute inset-0 bg-black flex flex-col items-center justify-center px-6">
            {step >= 1 && (
                <div className="flex items-end justify-center gap-2 mb-8 animate-fade-in">
                    <img src={charChibi} alt="char" className="h-40 object-contain" style={{ filter: 'drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 3px rgba(255,255,255,0.85))' }} />
                    <img src={userChibi} alt="user" className="h-40 object-contain" style={{ filter: 'drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 3px rgba(255,255,255,0.85))' }} />
                </div>
            )}
            {step >= 2 && (
                <div className="text-white/85 text-base tracking-wider mb-3 animate-fade-in text-center">
                    {title}
                </div>
            )}
            {step >= 3 && (
                <div className="text-white text-2xl tracking-[6px] font-light mt-2 mb-6 animate-fade-in">
                    TRUE HAPPY END
                </div>
            )}
            {step >= 4 && (
                <div className="text-white/65 text-sm leading-relaxed mt-4 px-4 text-center animate-fade-in whitespace-pre-wrap">
                    {description}
                </div>
            )}
            {step >= 5 && (
                <button
                    onClick={onNext}
                    className="mt-10 px-8 py-2.5 rounded-full bg-white/15 backdrop-blur text-white text-sm tracking-widest border border-white/30 active:scale-95 transition-transform animate-fade-in"
                >
                    继 续
                </button>
            )}
        </div>
    );
};

// ============================================================
// 信
// ============================================================

const ExitButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
    <button
        onClick={onClick}
        title="关闭"
        style={{
            position: 'absolute', top: 10, right: 10, zIndex: 50,
            width: 30, height: 30, borderRadius: '50%',
            background: 'rgba(255,248,236,0.92)',
            border: '1px solid #b8923f',
            color: '#7a2e3a',
            fontSize: 14,
            fontFamily: "'Cormorant Garamond', serif",
            cursor: 'pointer',
            boxShadow: '0 2px 6px rgba(122,46,58,0.22)',
            display: 'grid', placeItems: 'center',
            userSelect: 'none',
        }}
    >✕</button>
);

const LetterView: React.FC<{ text: string; onNext: () => void; onClose: () => void; charName: string; userName: string }> = ({ text, onNext, onClose, charName, userName }) => {
    const letterRef = useRef<HTMLDivElement>(null);
    const saveAreaRef = useRef<HTMLDivElement>(null);
    const [saving, setSaving] = useState(false);
    const handleSavePng = async () => {
        if (saving) return;
        setSaving(true);
        try {
            const h2c = (window as any).html2canvas;
            const loadH2C = h2c ? Promise.resolve(h2c) : new Promise<any>((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
                s.onload = () => resolve((window as any).html2canvas);
                s.onerror = reject;
                document.head.appendChild(s);
            });
            const html2canvas = await loadH2C;
            // 等字体加载完再截图 —— 否则 'Cormorant Garamond' / 'Noto Serif SC'
            // 还没就绪时会退回系统 serif，header 颜色和字距看起来都不一样
            try { await (document as any).fonts?.ready; } catch { /* ignore */ }
            const target = saveAreaRef.current;
            if (!target) return;
            // backgroundColor 用 wrapper 顶部的颜色 —— html2canvas 渲染不出
            // radial-gradient 时会拿这个色填整块 wrapper，挑顶端色能让"上面那一节"
            // 不再突变
            const canvas = await html2canvas(target, { backgroundColor: '#fefbf4', scale: 2, useCORS: true });
            const url = canvas.toDataURL('image/png');
            const a = document.createElement('a');
            a.href = url;
            a.download = `520_letter_${Date.now()}.png`;
            a.click();
        } catch (e) {
            console.error('[520] letter save failed', e);
        } finally {
            setSaving(false);
        }
    };
    return (
        <div className="l520-root">
            <Like520StyleTag />
            <CornerOrnaments />
            <AmbientLayer />
            {/* 信件页不放退出按钮——走完看完信再"收下"进入下一步 */}
            <div className="l520-letter-stage">
                <div
                    ref={saveAreaRef}
                    style={{
                        position: 'relative',
                        padding: '28px 22px',
                        // 用 linear-gradient（html2canvas 1.4.1 对 linear 支持稳定，
                        // 对 radial-gradient(ellipse at top, ...) 经常退回到 backgroundColor
                        // 平色，导致存为 PNG 后上半段颜色和屏幕看到的不一致）
                        background: 'linear-gradient(180deg, #fefbf4 0%, #f9f2e1 60%, #f1e7d0 100%)',
                        borderRadius: 6,
                        boxShadow: 'inset 0 0 50px rgba(157,107,120,0.06), inset 0 0 0 1px rgba(212,177,106,0.32)',
                    }}
                >
                    <div className="l520-letter-paper" ref={letterRef}>
                        <span className="lp-tl" />
                        <span className="lp-tr" />
                        <div className="l520-letter-header">
                            <div className="l520-letter-eyebrow">致 · 我的</div>
                            <div className="l520-letter-title">{userName}</div>
                            <div className="l520-letter-divider">❦ ⸙ ❦</div>
                        </div>
                        <div className="l520-letter-body">{text}</div>
                        <div className="l520-letter-foot">
                            <div className="l520-letter-flourish">~ ❦ ~</div>
                            <div className="l520-letter-signature">— {charName}</div>
                            <div className="l520-letter-seal">♡</div>
                        </div>
                    </div>
                    <div style={{
                        position: 'absolute', top: 8, left: 8, right: 8, bottom: 8,
                        pointerEvents: 'none',
                        border: '0.5px solid rgba(212,177,106,0.42)',
                        borderRadius: 3,
                    }} />
                    <div style={{
                        position: 'absolute', bottom: 6, left: 0, right: 0,
                        textAlign: 'center',
                        fontFamily: "'Cormorant Garamond', serif",
                        fontStyle: 'italic',
                        fontSize: 9,
                        letterSpacing: 6,
                        color: 'rgba(157,107,120,0.5)',
                    }}>
                        — 5 · 20 · MMXXVI —
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 16 }}>
                    <button
                        onClick={handleSavePng}
                        disabled={saving}
                        style={{
                            padding: '9px 18px',
                            background: 'linear-gradient(180deg, #fffefb, #f7eedb)',
                            color: '#9d6b78',
                            fontFamily: "'Noto Serif SC', serif",
                            fontSize: 12,
                            letterSpacing: 3,
                            textIndent: 3,
                            border: '1px solid rgba(212,177,106,0.65)',
                            borderRadius: 2,
                            cursor: saving ? 'wait' : 'pointer',
                            opacity: saving ? 0.6 : 1,
                            boxShadow: '0 3px 8px rgba(157,107,120,0.12)',
                        }}
                    >
                        {saving ? '⏳ 出件中…' : '存 为 图 片'}
                    </button>
                    <button className="l520-letter-accept" onClick={onNext} style={{ margin: 0 }}>收&nbsp;下</button>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// 拼图（char chibi + user chibi 并列在背景上）
// ============================================================

/**
 * 拼图卡片背景图（"像我们耶" 那张）。
 * 1200×780 左右的横版 520 DAY 装饰框（蕾丝 doily + 爱心/星星/小花），
 * 中间是空白的圆形 doily，让两个 chibi 居中靠下排进去。
 */
const LIKE520_PHOTO_BG_URL = 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/img/2.png';

async function composePuzzlePhoto(charChibiUrl: string, userChibiUrl: string): Promise<string> {
    const load = (src: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
    const [bg, charImg, userImg] = await Promise.all([
        load(LIKE520_PHOTO_BG_URL),
        load(charChibiUrl),
        load(userChibiUrl),
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = bg.naturalWidth || 1200;
    canvas.height = bg.naturalHeight || 780;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas ctx');
    ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);
    const targetH = canvas.height * 0.55;
    const charScale = targetH / (charImg.naturalHeight || 1);
    const userScale = targetH / (userImg.naturalHeight || 1);
    const charW = (charImg.naturalWidth || 1) * charScale;
    const userW = (userImg.naturalWidth || 1) * userScale;
    const gap = canvas.width * 0.01;
    const totalW = charW + userW + gap;
    const startX = (canvas.width - totalW) / 2;
    const bottomY = canvas.height * 0.94;

    const charX = startX;
    const userX = startX + charW + gap;
    const topY = bottomY - targetH;

    // 第一遍：白色柔光描边（防止黑色头发/配件融入背景）
    // 用多个白色 0-offset 的 drop-shadow 叠加模拟白色 outline + 轻发光
    const drawWithWhiteOutline = (img: HTMLImageElement, x: number, y: number, w: number, h: number) => {
        ctx.shadowColor = 'rgba(255,255,255,0.95)';
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        // 多次重叠 1-2px shadow 让 outline 实在一点
        for (const blur of [3, 3, 5]) {
            ctx.shadowBlur = blur;
            ctx.drawImage(img, x, y, w, h);
        }
        // 再叠一层浅粉柔光，远处那种 halo
        ctx.shadowColor = 'rgba(255,228,236,0.55)';
        ctx.shadowBlur = 14;
        ctx.drawImage(img, x, y, w, h);
        // 最后清掉 shadow，画一遍干净的 chibi 在最上面
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.drawImage(img, x, y, w, h);
    };

    drawWithWhiteOutline(charImg, charX, topY, charW, targetH);
    drawWithWhiteOutline(userImg, userX, topY, userW, targetH);

    return canvas.toDataURL('image/png');
}

const PuzzleView: React.FC<{
    charChibi: string;
    userChibi: string;
    title: string;
    onDone: () => void;
    onClose: () => void;
}> = ({ charChibi, userChibi, title, onDone, onClose }) => {
    const [photoUrl, setPhotoUrl] = useState<string | null>(null);
    const [composing, setComposing] = useState(true);
    useEffect(() => {
        let canceled = false;
        composePuzzlePhoto(charChibi, userChibi)
            .then(url => { if (!canceled) { setPhotoUrl(url); setComposing(false); } })
            .catch(err => { console.error('[520] compose puzzle failed', err); if (!canceled) setComposing(false); });
        return () => { canceled = true; };
    }, [charChibi, userChibi]);
    return (
        <div className="l520-root">
            <Like520StyleTag />
            <CornerOrnaments />
            <AmbientLayer />
            <ExitButton onClick={onClose} />
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px 16px', position: 'relative', zIndex: 5, display: 'flex', flexDirection: 'column', alignItems: 'center', maxWidth: 420, margin: '0 auto' }}>
                <div style={{ color: '#7a2e3a', fontFamily: "'Noto Serif SC', serif", fontSize: 13, letterSpacing: 5, marginBottom: 4 }}>♥ 拼 图 卡 片 ♥</div>
                <div style={{ color: '#9D7585', fontFamily: "'Cormorant Garamond', serif", fontStyle: 'italic', fontSize: 11, letterSpacing: 3, marginBottom: 14 }}>{title}</div>
                {photoUrl ? (
                    <img
                        src={photoUrl}
                        alt="合照"
                        draggable={false}
                        style={{ width: '100%', display: 'block', borderRadius: 16, boxShadow: '0 12px 32px rgba(199, 97, 130, 0.22), 0 0 0 1px rgba(184, 146, 63, 0.4)' }}
                    />
                ) : (
                    <div style={{ width: '100%', aspectRatio: '1200 / 780', borderRadius: 16, background: 'linear-gradient(180deg, #FFE0E8, #FFD3DC)', display: 'grid', placeItems: 'center', color: '#9D7585', fontSize: 11, letterSpacing: 4 }}>{composing ? '正在合成…' : '合成失败'}</div>
                )}
                <div style={{ color: '#9D7585', fontFamily: "'Cormorant Garamond', serif", fontStyle: 'italic', fontSize: 10.5, letterSpacing: 2, marginTop: 6 }}>长按图片保存到相册</div>
                <div style={{ color: '#5C3A4A', fontStyle: 'italic', fontSize: 13, marginTop: 14, textAlign: 'center' }}>「这很像我们耶。」</div>
                <button
                    onClick={onDone}
                    style={{ marginTop: 22, padding: '11px 32px', borderRadius: 9999, background: 'linear-gradient(90deg, #FFB6C8, #F18AAA)', color: '#fff', fontWeight: 700, border: 'none', boxShadow: '0 6px 14px rgba(199,97,130,0.35)', cursor: 'pointer' }}
                >完成 ♥</button>
            </div>
        </div>
    );
};

// ============================================================
// Done 视图 —— 温馨结尾
// ============================================================

const DoneView: React.FC<{
    charName: string;
    charAvatar?: string;
    userName: string;
    charChibi?: string;
    userChibi?: string;
    onClose: () => void;
}> = ({ charName, charAvatar, userName, charChibi, userChibi, onClose }) => {
    const [heartsKey] = useState(() => Date.now());
    const [closing, setClosing] = useState(false);
    const handleSlowExit = () => {
        if (closing) return;
        setClosing(true);
    };
    return (
        <div className="absolute inset-0 overflow-hidden" style={{
            background: 'radial-gradient(ellipse at 50% 30%, #FFE8EF 0%, #FFD7E1 45%, #F5B8C9 100%)',
        }}>
            {closing && <EyesClosingOverlay onDone={onClose} />}
            {/* 漂浮的爱心粒子 */}
            <style>{`
                @keyframes l520-done-float {
                    0% { transform: translateY(20vh) translateX(0) scale(0.6); opacity: 0; }
                    20% { opacity: 0.8; }
                    100% { transform: translateY(-110vh) translateX(var(--dx, 0)) scale(1); opacity: 0; }
                }
                @keyframes l520-done-pulse {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.06); }
                }
                @keyframes l520-done-shimmer {
                    0%, 100% { opacity: 0.7; }
                    50% { opacity: 1; }
                }
                @keyframes l520-done-fadein {
                    from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .l520-done-heart {
                    position: absolute;
                    bottom: -10vh;
                    font-size: 14px;
                    animation: l520-done-float linear infinite;
                    pointer-events: none;
                }
            `}</style>
            {Array.from({ length: 14 }).map((_, i) => {
                const left = (i * 7.3 + 5) % 95;
                const delay = (i * 0.85) % 9;
                const duration = 11 + (i % 5) * 1.5;
                const size = 12 + (i % 4) * 6;
                const dx = ((i % 3) - 1) * 30;
                const colors = ['#F18AAA', '#FFB6C8', '#FFC8D2', '#E893B0'];
                return (
                    <span
                        key={`${heartsKey}-${i}`}
                        className="l520-done-heart"
                        style={{
                            left: `${left}%`,
                            animationDelay: `${delay}s`,
                            animationDuration: `${duration}s`,
                            fontSize: size,
                            color: colors[i % colors.length],
                            ['--dx' as any]: `${dx}px`,
                        }}
                    >♥</span>
                );
            })}

            <div className="relative flex flex-col items-center justify-center min-h-full px-6 py-12 max-w-md mx-auto" style={{ animation: 'l520-done-fadein 0.8s ease-out' }}>
                {/* 头像 + chibi 合影 */}
                <div className="flex items-end justify-center gap-2 mb-5" style={{ animation: 'l520-done-pulse 3.5s ease-in-out infinite' }}>
                    {charChibi ? (
                        <img src={charChibi} alt="" style={{ height: 110, objectFit: 'contain', filter: 'drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 3px rgba(255,255,255,0.85)) drop-shadow(0 6px 12px rgba(199,97,130,0.35))' }} />
                    ) : charAvatar ? (
                        <img src={charAvatar} alt="" style={{ width: 80, height: 80, borderRadius: '50%', objectFit: 'cover', boxShadow: '0 6px 14px rgba(199,97,130,0.3)' }} />
                    ) : null}
                    {userChibi && (
                        <img src={userChibi} alt="" style={{ height: 110, objectFit: 'contain', filter: 'drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 3px rgba(255,255,255,0.85)) drop-shadow(0 6px 12px rgba(199,97,130,0.35))' }} />
                    )}
                </div>

                {/* 标题 */}
                <div style={{
                    fontFamily: "'Cormorant Garamond', serif",
                    fontStyle: 'italic',
                    fontSize: 12,
                    letterSpacing: 8,
                    color: '#C76182',
                    marginBottom: 6,
                    textTransform: 'uppercase',
                    animation: 'l520-done-shimmer 2.4s ease-in-out infinite',
                }}>a dream like this</div>
                <h2 style={{
                    fontFamily: "'Noto Serif SC', serif",
                    fontSize: 22,
                    fontWeight: 600,
                    color: '#7A2E3A',
                    letterSpacing: 4,
                    textIndent: 4,
                    marginBottom: 14,
                }}>感觉做了一场不错的梦</h2>

                {/* 寄语 */}
                <div style={{
                    background: 'rgba(255,255,255,0.55)',
                    backdropFilter: 'blur(6px)',
                    border: '1px solid rgba(255,255,255,0.7)',
                    borderRadius: 18,
                    padding: '14px 18px',
                    marginBottom: 22,
                    maxWidth: 320,
                    boxShadow: '0 8px 24px rgba(199,97,130,0.18)',
                }}>
                    <p style={{
                        fontFamily: "'Noto Serif SC', serif",
                        fontSize: 13.5,
                        lineHeight: 2,
                        color: '#5C3A4A',
                        textAlign: 'center',
                        margin: 0,
                        letterSpacing: 0.5,
                    }}>
                        醒过来之后，<br />
                        身上还带着一点 ta 的温度。<br />
                        ——好像 ta 还在看着。
                    </p>
                </div>

                <div style={{ fontSize: 9, letterSpacing: 10, color: '#C76182', marginBottom: 22, opacity: 0.75 }}>
                    ❦ &nbsp; TRUE HAPPY END &nbsp; ❦
                </div>

                <button
                    onClick={handleSlowExit}
                    disabled={closing}
                    style={{
                        padding: '12px 38px',
                        borderRadius: 9999,
                        background: 'linear-gradient(90deg, #FFB6C8, #F18AAA)',
                        color: '#fff',
                        fontWeight: 700,
                        border: 'none',
                        boxShadow: '0 8px 18px rgba(199,97,130,0.35)',
                        cursor: 'pointer',
                        fontSize: 14,
                        letterSpacing: 4,
                        textIndent: 4,
                    }}
                >回到日常</button>

                <div style={{ marginTop: 10, fontSize: 10, color: '#9D7585', letterSpacing: 1 }}>
                    ta 一直在的 ♥
                </div>
            </div>
        </div>
    );
};

// ============================================================
// Loading 视图
// ============================================================

const LoadingView: React.FC<{ hint?: string }> = ({ hint }) => (
    <div className="flex flex-col items-center justify-center min-h-full px-6 py-12 max-w-md mx-auto">
        <div className="text-2xl mb-4 animate-pulse">♥</div>
        <div className="text-[#9D7585] text-xs tracking-widest">{hint ?? '正在准备这个下午…'}</div>
    </div>
);

// ============================================================
// 「珍重」BGM — 4 组按 phase 切换，开局各抽一条预加载，crossfade
// ============================================================

type BGMGroupKey = 'nieren' | 'yangcheng' | 'jieju' | 'letter';

/**
 * 4 组 BGM URL 池：
 *   - nieren    捏人界面（char_creator / user_creator）
 *   - yangcheng 养成界面（loading_a / yangcheng）
 *   - jieju     结局展示（uncovered_line / ending_screen / loading_b / wake_up / puzzle）
 *   - letter    读信（letter）
 * 进入活动时各组随机抽一条预加载，phase 切换时在已抽的 4 条之间 crossfade。
 */
const LIKE520_BGM_GROUPS: Record<BGMGroupKey, string[]> = {
    nieren: [
        'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/nieren/1.mp3',
        'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/nieren/2.mp3',
    ],
    yangcheng: [
        'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/yangcheng/1.mp3',
        'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/yangcheng/2.mp3',
        'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/yangcheng/3.mp3',
        'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/yangcheng/4.mp3',
    ],
    jieju: [
        'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/jiejuhezhao/1.mp3',
        'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/jiejuhezhao/2.mp3',
        'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/jiejuhezhao/3.mp3',
    ],
    letter: [
        'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/letter/1.mp3',
        'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/letter/2.mp3',
        'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/letter/3.mp3',
        'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/letter/4.mp3',
    ],
};

const BGM_MUTED_KEY = 'sullyos_like520_bgm_muted';
const BGM_TARGET_VOLUME = 0.35;
const BGM_FADE_MS = 1200;

const phaseToBGMGroup = (phase: string): BGMGroupKey | null => {
    switch (phase) {
        case 'char_creator':
        case 'user_creator':
            return 'nieren';
        case 'loading_a':
        case 'yangcheng':
            return 'yangcheng';
        case 'uncovered_line':
        case 'ending_screen':
        case 'loading_b':
        case 'wake_up':
        case 'puzzle':
            return 'jieju';
        case 'letter':
        case 'done':
            return 'letter';
        default:
            return null; // intro / error
    }
};

function pickRandom<T>(arr: T[]): T | null {
    if (!arr || arr.length === 0) return null;
    return arr[Math.floor(Math.random() * arr.length)];
}

function useLike520BGM(active: boolean, currentGroup: BGMGroupKey | null) {
    const [muted, setMuted] = useState<boolean>(() => {
        try { return localStorage.getItem(BGM_MUTED_KEY) === '1'; } catch { return false; }
    });

    const audiosRef = useRef<Partial<Record<BGMGroupKey, HTMLAudioElement>>>({});
    const fadingRef = useRef<Map<HTMLAudioElement, number>>(new Map());
    const mutedRef = useRef(muted);
    mutedRef.current = muted;

    const fade = useCallback((audio: HTMLAudioElement, target: number, durationMs: number = BGM_FADE_MS) => {
        const prev = fadingRef.current.get(audio);
        if (prev) { clearInterval(prev); fadingRef.current.delete(audio); }
        const steps = 12;
        const intervalMs = durationMs / steps;
        const startVol = audio.volume;
        const delta = target - startVol;
        let i = 0;
        const timer = window.setInterval(() => {
            i++;
            audio.volume = Math.max(0, Math.min(1, startVol + (delta * i / steps)));
            if (i >= steps) {
                clearInterval(timer);
                fadingRef.current.delete(audio);
                if (target === 0 && !audio.paused) {
                    audio.pause();
                }
            }
        }, intervalMs);
        fadingRef.current.set(audio, timer);
    }, []);

    // 初始化：active 第一次为 true 时，各组随机抽一条 + 预加载
    useEffect(() => {
        if (!active) return;
        if (Object.keys(audiosRef.current).length > 0) return; // 已初始化

        console.log('[520][BGM] init | muted=', mutedRef.current, '| HAS_BGM=', HAS_BGM);
        (Object.keys(LIKE520_BGM_GROUPS) as BGMGroupKey[]).forEach(key => {
            const url = pickRandom(LIKE520_BGM_GROUPS[key]);
            if (!url) return;
            try {
                const audio = new Audio();
                audio.loop = true;
                audio.volume = 0;
                audio.preload = 'auto';
                audio.addEventListener('error', () => console.warn(`[520][BGM] ${key} audio error`, audio.error?.code, audio.src));
                audio.addEventListener('canplay', () => console.log(`[520][BGM] ${key} canplay`));
                // 注：不设 crossOrigin —— HTMLAudioElement 普通播放不需要 CORS，
                // 设了反而要求 CDN 必须返回 CORS 头，否则整段播放失败
                audio.src = url;
                audio.load();
                audiosRef.current[key] = audio;
                console.log(`[520][BGM] ${key} → ${url}`);
            } catch (err) {
                console.warn(`[520][BGM] failed to init ${key}:`, err);
            }
        });

        return () => {
            // active 切回 false 或 session 卸载：停掉全部
            fadingRef.current.forEach(t => clearInterval(t));
            fadingRef.current.clear();
            Object.values(audiosRef.current).forEach(audio => {
                if (audio) {
                    try {
                        audio.pause();
                        audio.src = '';
                    } catch { /* ignore */ }
                }
            });
            audiosRef.current = {};
        };
    }, [active]);

    // currentGroup 切换：当前组淡入，其他组淡出
    useEffect(() => {
        if (!active) return;
        const targetVol = mutedRef.current ? 0 : BGM_TARGET_VOLUME;

        let needsGestureRetry = false;
        const tryPlay = (audio: HTMLAudioElement, key: BGMGroupKey) => {
            audio.play().then(() => {
                fade(audio, targetVol);
            }).catch(err => {
                console.warn(`[520][BGM] play ${key} failed:`, err?.name || err);
                if (err?.name === 'NotAllowedError') {
                    needsGestureRetry = true;
                }
            });
        };

        (Object.keys(audiosRef.current) as BGMGroupKey[]).forEach(key => {
            const audio = audiosRef.current[key];
            if (!audio) return;
            if (key === currentGroup) {
                if (audio.paused) {
                    tryPlay(audio, key);
                } else {
                    fade(audio, targetVol);
                }
            } else {
                if (!audio.paused) fade(audio, 0);
            }
        });

        // 兜底：如果首次 play 被 autoplay policy 拒了，监听下一次用户交互再试
        if (needsGestureRetry && currentGroup) {
            const retry = () => {
                const a = audiosRef.current[currentGroup];
                if (a && a.paused) tryPlay(a, currentGroup);
                document.removeEventListener('pointerdown', retry);
                document.removeEventListener('keydown', retry);
            };
            document.addEventListener('pointerdown', retry, { once: true, passive: true });
            document.addEventListener('keydown', retry, { once: true });
            return () => {
                document.removeEventListener('pointerdown', retry);
                document.removeEventListener('keydown', retry);
            };
        }
    }, [currentGroup, active, fade]);

    // muted 切换：实时调当前组音量
    useEffect(() => {
        try { localStorage.setItem(BGM_MUTED_KEY, muted ? '1' : '0'); } catch { /* ignore */ }
        if (!active) return;
        (Object.keys(audiosRef.current) as BGMGroupKey[]).forEach(key => {
            const audio = audiosRef.current[key];
            if (!audio) return;
            if (key === currentGroup) {
                const target = muted ? 0 : BGM_TARGET_VOLUME;
                if (muted) {
                    fade(audio, 0, 500);
                } else {
                    if (audio.paused) {
                        audio.play().catch(() => { /* ignore */ });
                    }
                    fade(audio, target, 500);
                }
            }
        });
    }, [muted, active, currentGroup, fade]);

    const toggleMute = useCallback(() => setMuted(m => !m), []);
    return { muted, toggleMute };
}

const BGMContext = React.createContext<{ muted: boolean; toggleMute: () => void } | null>(null);

const HAS_BGM = Object.values(LIKE520_BGM_GROUPS).some(arr => arr && arr.length > 0);

const BGM_HINT_DISMISSED_KEY = 'sullyos_like520_bgm_hint_dismissed';

const BGMToggle: React.FC = () => {
    const ctx = React.useContext(BGMContext);
    const [hintVisible, setHintVisible] = useState<boolean>(() => {
        try {
            return localStorage.getItem(BGM_HINT_DISMISSED_KEY) !== '1';
        } catch { return true; }
    });
    useEffect(() => {
        if (!hintVisible) return;
        const t = setTimeout(() => {
            setHintVisible(false);
            try { localStorage.setItem(BGM_HINT_DISMISSED_KEY, '1'); } catch { /* ignore */ }
        }, 5500);
        return () => clearTimeout(t);
    }, [hintVisible]);

    if (!ctx || !HAS_BGM) return null;
    const { muted, toggleMute } = ctx;

    const handleClick = () => {
        if (hintVisible) {
            setHintVisible(false);
            try { localStorage.setItem(BGM_HINT_DISMISSED_KEY, '1'); } catch { /* ignore */ }
        }
        toggleMute();
    };

    return (
        <div style={{ position: 'relative', display: 'inline-block' }}>
            <button
                onClick={handleClick}
                title={muted ? '播放 BGM' : '静音'}
                style={{
                    background: muted
                        ? 'linear-gradient(180deg, rgba(255,248,236,0.95), rgba(245,234,212,0.85))'
                        : 'linear-gradient(135deg, #f4e0a8 0%, #d4b16a 35%, #b8923f 65%, #8b6914 100%)',
                    color: muted ? '#8b6914' : '#fff8ec',
                    border: '1px solid #b8923f',
                    borderRadius: '50%',
                    width: 28,
                    height: 28,
                    display: 'inline-grid',
                    placeItems: 'center',
                    fontSize: 13,
                    cursor: 'pointer',
                    fontFamily: "'Cormorant Garamond', serif",
                    boxShadow: hintVisible
                        ? '0 0 0 3px rgba(212,177,106,0.45), 0 4px 12px rgba(122,46,58,0.3), inset 0 1px 0 rgba(255,255,255,0.4)'
                        : '0 2px 6px rgba(122,46,58,0.25), inset 0 1px 0 rgba(255,255,255,0.4)',
                    userSelect: 'none',
                    animation: hintVisible ? 'l520-bgm-hint-pulse 1.6s ease-in-out infinite' : 'none',
                }}
            >
                {muted ? '🔇' : '♪'}
            </button>
            {hintVisible && (
                <>
                    <style>{`
                        @keyframes l520-bgm-hint-pulse {
                            0%,100% { box-shadow: 0 0 0 3px rgba(212,177,106,0.45), 0 4px 12px rgba(122,46,58,0.3), inset 0 1px 0 rgba(255,255,255,0.4); }
                            50%     { box-shadow: 0 0 0 7px rgba(212,177,106,0.18), 0 6px 16px rgba(122,46,58,0.35), inset 0 1px 0 rgba(255,255,255,0.4); }
                        }
                        @keyframes l520-bgm-tip-in {
                            0%   { opacity: 0; transform: translateY(-4px); }
                            18%  { opacity: 1; transform: translateY(0); }
                            82%  { opacity: 1; transform: translateY(0); }
                            100% { opacity: 0; transform: translateY(-4px); }
                        }
                    `}</style>
                    <div
                        style={{
                            position: 'absolute',
                            top: 'calc(100% + 6px)',
                            right: 0,
                            zIndex: 30,
                            background: 'rgba(255,248,236,0.97)',
                            color: '#7a2e3a',
                            border: '1px solid #b8923f',
                            borderRadius: '4px 4px 4px 14px',
                            padding: '5px 10px',
                            fontSize: 10.5,
                            fontFamily: "'Cormorant Garamond', 'Noto Serif SC', serif",
                            fontStyle: 'italic',
                            letterSpacing: '1px',
                            whiteSpace: 'nowrap',
                            boxShadow: '0 4px 10px rgba(122,46,58,0.25)',
                            animation: 'l520-bgm-tip-in 5.5s ease-in-out forwards',
                            pointerEvents: 'none',
                        }}
                    >
                        ♪ 这里有音乐 · 嫌吵就点 ↑
                    </div>
                </>
            )}
        </div>
    );
};

// ============================================================
// Like520Session — 主状态机
// ============================================================

interface SessionProps {
    charId: string;
    onClose: () => void;
}

type SessionMode = 'fresh' | 'replay' | 'skip-to-letter';

export const Like520Session: React.FC<SessionProps> = ({ charId, onClose }) => {
    const { characters, userProfile, apiConfig, updateCharacter, addToast } = useOS();
    const char = characters.find(c => c.id === charId);

    // 已有完成记录？拿出来判断要不要弹回放选择卡
    const existingRecord = char?.specialMomentRecords?.[LIKE520_RECORD_KEY];
    const existingData = existingRecord?.customData as {
        callA: Like520CallAResult;
        callB: Like520CallBResult;
        chosenTucao: Like520TucaoKey;
        charChibi: { dataUrl: string; state?: any };
        userChibi: { dataUrl: string; state?: any };
    } | undefined;
    const hasExisting = !!(existingData && existingData.callA && existingData.callB);

    // 没有记录 → 直接 fresh；有记录 → 等用户在选择卡上选模式
    const [sessionMode, setSessionMode] = useState<SessionMode | null>(hasExisting ? null : 'fresh');

    const [phase, setPhase] = useState<Phase>('intro');
    const [errorMsg, setErrorMsg] = useState<string>('');

    // BGM：根据当前 phase 切换 4 组 BGM。intro / 选择卡 阶段不启动（等用户点击进入再开始，避开 autoplay policy）
    const bgmActive = sessionMode !== null && phase !== 'intro' && phase !== 'error';
    const bgmGroup = phaseToBGMGroup(phase);
    const bgm = useLike520BGM(bgmActive, bgmGroup);

    const [charChibi, setCharChibi] = useState<ChibiResult | null>(null);
    const [userChibi, setUserChibi] = useState<ChibiResult | null>(null);
    const [callA, setCallA] = useState<Like520CallAResult | null>(null);
    const [callB, setCallB] = useState<Like520CallBResult | null>(null);
    const [chosenTucao, setChosenTucao] = useState<Like520TucaoKey | null>(null);

    // 启动 Call A / B 标记
    const callAStartedRef = useRef(false);
    const callBStartedRef = useRef(false);

    // sessionMode 决定后：如果是 replay / skip-to-letter，预填全部 state，跳过 LLM 调用
    useEffect(() => {
        if (!sessionMode || !existingData) return;
        if (sessionMode === 'fresh') return;

        const rebuildChibi = (saved: { dataUrl: string; state?: any }): ChibiResult => ({
            dataUrl: saved.dataUrl,
            frameDataUrl: saved.dataUrl,
            transparentDataUrl: saved.dataUrl,
            state: saved.state,
        });

        setCallA(existingData.callA);
        setCallB(existingData.callB);
        setChosenTucao(existingData.chosenTucao);
        setCharChibi(rebuildChibi(existingData.charChibi));
        setUserChibi(rebuildChibi(existingData.userChibi));
        callAStartedRef.current = true;
        callBStartedRef.current = true;

        if (sessionMode === 'skip-to-letter') {
            setPhase('letter');
        } else {
            // replay：从 yangcheng 开始（跳过 intro / char_creator / loading_a）
            setPhase('yangcheng');
        }
    }, [sessionMode, existingData]);

    const startCallA = useCallback(async () => {
        if (callAStartedRef.current || !char || !apiConfig) return;
        callAStartedRef.current = true;
        try {
            const recent = await DB.getMessagesByCharId(char.id);
            const result = await runLike520CallA(char, userProfile, apiConfig, recent || []);
            setCallA(result);
        } catch (err: any) {
            console.error('[520] Call A failed:', err);
            setErrorMsg(`生成剧本失败：${err?.message || '请重试'}`);
            setPhase('error');
        }
    }, [char, userProfile, apiConfig]);

    const startCallB = useCallback(async (aResult: Like520CallAResult, tucao: Like520TucaoKey) => {
        if (callBStartedRef.current || !char || !apiConfig) return;
        callBStartedRef.current = true;
        try {
            const recent = await DB.getMessagesByCharId(char.id);
            const r = await runLike520CallB(char, userProfile, apiConfig, aResult, tucao, recent || []);
            setCallB(r);
        } catch (err) {
            console.error('[520] Call B failed:', err);
            setCallB({
                wake_up: ['……我们好像一起做了一个梦呀。', '不过，不是坏的那种。'],
                letter: '（信生成出了点小问题。这是一段属于你的、未完成的话——但它一直在。）',
            });
        }
    }, [char, userProfile, apiConfig]);

    // === Phase 导航 ===

    const handleCharChibiConfirm = useCallback((r: ChibiResult) => {
        setCharChibi(r);
        // 等 Call A 结果决定下一步
        if (callA) setPhase('yangcheng');
        else setPhase('loading_a');
    }, [callA]);

    const handleUserChibiConfirm = useCallback((r: ChibiResult) => {
        setUserChibi(r);
        setPhase('uncovered_line');
    }, []);

    // 当 callA 在 loading_a 阶段返回时，自动推进到 yangcheng
    useEffect(() => {
        if (phase === 'loading_a' && callA) {
            setPhase('yangcheng');
        }
    }, [phase, callA]);

    // 当用户选了吐槽 → 开始 Call B
    useEffect(() => {
        if (callA && chosenTucao && !callBStartedRef.current) {
            startCallB(callA, chosenTucao);
        }
    }, [callA, chosenTucao, startCallB]);

    // loading_b 阶段，Call B 一就绪自动推进
    useEffect(() => {
        if (phase === 'loading_b' && callB) {
            setPhase('wake_up');
        }
    }, [phase, callB]);

    // === 保存结果到 char.specialMomentRecords ===
    const savedRef = useRef(false);
    const saveRecord = useCallback(async () => {
        if (savedRef.current) return;                          // 本次 session 已保存
        if (sessionMode !== 'fresh') return;                   // 回放/看信模式不重存
        if (!char || !callA || !callB || !charChibi || !userChibi || !chosenTucao) return;
        savedRef.current = true;
        const previousRecords = char.specialMomentRecords || {};
        const record: SpecialMomentRecord = {
            content: callB.letter,
            image: charChibi.frameDataUrl,
            timestamp: Date.now(),
            source: 'generated',
            customData: {
                callA,
                callB,
                chosenTucao,
                charChibi: { dataUrl: charChibi.transparentDataUrl, state: charChibi.state },
                userChibi: { dataUrl: userChibi.transparentDataUrl, state: userChibi.state },
            },
        };
        updateCharacter(char.id, {
            specialMomentRecords: { ...previousRecords, [LIKE520_RECORD_KEY]: record },
        });
        try {
            localStorage.setItem(LIKE520_COMPLETED_KEY, '1');
        } catch { /* ignore */ }
        // 写一条 chat 卡片消息留痕：score_card kind=like520_card，含合照 PNG + 信全文 + 标题
        try {
            const userName = userProfile.name || '你';
            const photoDataUrl = await composePuzzlePhoto(
                charChibi.transparentDataUrl,
                userChibi.transparentDataUrl,
            );
            const cardData = {
                type: 'like520_card',
                charName: char.name,
                charAvatar: char.avatar || '',
                userName,
                title: callA.ending.title,
                description: callA.ending.description,
                photoDataUrl,
                letter: callB.letter,
                timestamp: Date.now(),
            };
            await DB.saveMessage({
                charId: char.id,
                role: 'assistant',
                type: 'score_card',
                content: JSON.stringify(cardData),
                timestamp: Date.now(),
                metadata: {
                    source: 'like520_event',
                    like520Event: true,
                    scoreCard: cardData,
                },
            });
        } catch (e) {
            console.warn('[520] save chat card failed', e);
        }
    }, [char, callA, callB, charChibi, userChibi, chosenTucao, updateCharacter]);

    // === 错误页 ===
    if (!char) {
        return (
            <div className="fixed inset-0 z-[9997] flex items-center justify-center bg-[#FFF1E6]">
                <div className="text-[#9D7585]">角色不存在</div>
            </div>
        );
    }

    if (phase === 'error') {
        return (
            <div className="fixed inset-0 z-[9997] flex flex-col items-center justify-center bg-[#FFF1E6] px-8">
                <div className="text-[#C76182] mb-3">⚠</div>
                <div className="text-[#5C3A4A] text-sm text-center mb-6">{errorMsg}</div>
                <button onClick={onClose} className="px-7 py-2.5 rounded-full bg-white text-[#C76182] text-sm font-bold border border-[#FFB6C8] active:scale-95 transition-transform">
                    关闭
                </button>
            </div>
        );
    }

    // === Phase 渲染 ===
    const background = 'linear-gradient(180deg, #FFF1E6 0%, #FFE4EC 100%)';

    // 有完成记录但用户还没在选择卡上选模式：先弹回放选择卡
    if (hasExisting && sessionMode === null) {
        const pickMode = (mode: SessionMode) => {
            if (mode === 'fresh') {
                // 重来：清掉记录
                const prev = char.specialMomentRecords || {};
                const updated = { ...prev };
                delete updated[LIKE520_RECORD_KEY];
                updateCharacter(char.id, { specialMomentRecords: updated });
                try { localStorage.removeItem(LIKE520_COMPLETED_KEY); } catch { /* ignore */ }
            }
            setSessionMode(mode);
        };
        return (
            <div className="fixed inset-0 z-[9997]">
                <div className="l520-root">
                    <Like520StyleTag />
                    <CornerOrnaments />
                    <AmbientLayer />
                    <div className="l520-mask">
                        <div className="l520-choice-card">
                            <span className="cc-tl" />
                            <span className="cc-tr" />
                            <div className="l520-choice-head">
                                <div className="ornament">❦ ⸙ ❦</div>
                                <h3>这个下午已经度过过</h3>
                                <div className="sub">— Your Treasured Moment —</div>
                            </div>
                            <button className="l520-choice-row" onClick={() => pickMode('replay')}>
                                <span className="num">I</span>
                                <span className="text">重 看 — 把那个下午再过一遍</span>
                            </button>
                            <button className="l520-choice-row" onClick={() => pickMode('skip-to-letter')}>
                                <span className="num">II</span>
                                <span className="text">看 信 — 直接打开 ta 写的信</span>
                            </button>
                            <button className="l520-choice-row" onClick={() => pickMode('fresh')}>
                                <span className="num">III</span>
                                <span className="text">重 来 — 清掉记录，重新做一次</span>
                            </button>
                            <button
                                onClick={onClose}
                                style={{
                                    display: 'block',
                                    margin: '14px auto 0',
                                    padding: '6px 16px',
                                    background: 'transparent',
                                    border: 'none',
                                    color: 'var(--ink-soft)',
                                    fontSize: 11,
                                    fontFamily: "'Cormorant Garamond', serif",
                                    fontStyle: 'italic',
                                    letterSpacing: 2,
                                    cursor: 'pointer',
                                }}
                            >
                                — 关 闭 —
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <BGMContext.Provider value={bgm}>
        <div className="fixed inset-0 z-[9997] overflow-y-auto" style={{ background }}>
            {phase === 'intro' && (
                <div className="flex flex-col items-center justify-center min-h-full px-8 py-16 max-w-md mx-auto">
                    <div className="text-[10px] tracking-[8px] text-[#C76182] mb-3">5 · 2 · 0</div>
                    <div className="text-[#C76182] text-xl font-bold mb-1 tracking-widest">特别活动</div>
                    <div className="text-[#5C3A4A] text-lg leading-relaxed text-center my-8">
                        如果<span className="mx-1 text-[#C76182]">{char.name}</span>变得小小的，<br />
                        那ta会是——？
                    </div>
                    <button
                        onClick={() => { startCallA(); setPhase('char_creator'); }}
                        className="mt-6 px-10 py-3 rounded-full bg-gradient-to-r from-[#FFB6C8] to-[#F18AAA] text-white font-bold shadow-lg active:scale-95 transition-transform"
                    >
                        开始装扮 ♥
                    </button>
                    <button
                        onClick={onClose}
                        className="mt-4 text-xs text-[#9D7585]"
                    >
                        以后再说
                    </button>
                </div>
            )}

            {phase === 'char_creator' && (
                <div className="absolute inset-0">
                    <CreatorIframe
                        mode="char"
                        charName={char.name}
                        presets={isSullyChar(char) ? sullyPresets() : undefined}
                        isSully={isSullyChar(char)}
                        onConfirm={handleCharChibiConfirm}
                    />
                </div>
            )}

            {phase === 'loading_a' && <LoadingView hint="ta 在准备这个下午…" />}

            {phase === 'yangcheng' && callA && charChibi && (
                <Y520Scene
                    callA={callA}
                    charName={char.name}
                    charAvatar={char.avatar}
                    charChibiUrl={charChibi.transparentDataUrl}
                    onTucaoSelected={(k) => setChosenTucao(k)}
                    onComplete={() => {
                        // replay 模式下已经有 userChibi，直接跳过 user_creator 进 uncovered_line
                        if (sessionMode === 'replay' && userChibi) {
                            setPhase('uncovered_line');
                        } else {
                            setPhase('user_creator');
                        }
                    }}
                    initialChosenTucao={sessionMode === 'replay' ? chosenTucao ?? undefined : undefined}
                />
            )}

            {phase === 'user_creator' && (
                <div className="absolute inset-0">
                    <CreatorIframe
                        mode="user"
                        charName={char.name}
                        onConfirm={handleUserChibiConfirm}
                    />
                </div>
            )}

            {phase === 'uncovered_line' && callA && charChibi && userChibi && (
                <UncoveredLineView
                    lines={callA.uncovered_line}
                    charName={char.name}
                    charAvatar={char.avatar}
                    charChibi={charChibi.transparentDataUrl}
                    userChibi={userChibi.transparentDataUrl}
                    onComplete={() => setPhase('ending_screen')}
                />
            )}

            {phase === 'ending_screen' && callA && charChibi && userChibi && (
                <EndingScreen
                    title={callA.ending.title}
                    description={callA.ending.description}
                    charChibi={charChibi.transparentDataUrl}
                    userChibi={userChibi.transparentDataUrl}
                    onNext={() => {
                        if (callB) setPhase('wake_up');
                        else setPhase('loading_b');
                    }}
                />
            )}

            {phase === 'loading_b' && <LoadingView hint="醒过来之前…" />}

            {phase === 'wake_up' && callB && (
                <WakeUpView
                    lines={callB.wake_up}
                    charName={char.name}
                    onComplete={() => setPhase('letter')}
                />
            )}

            {phase === 'letter' && callB && (
                <LetterView
                    text={callB.letter}
                    charName={char.name}
                    userName={userProfile.name || '你'}
                    onClose={onClose}
                    onNext={() => {
                        saveRecord();
                        setPhase('puzzle');
                    }}
                />
            )}

            {phase === 'puzzle' && callA && charChibi && userChibi && (
                <PuzzleView
                    charChibi={charChibi.transparentDataUrl}
                    userChibi={userChibi.transparentDataUrl}
                    title={callA.ending.title}
                    onDone={() => setPhase('done')}
                    onClose={onClose}
                />
            )}

            {phase === 'done' && (
                <DoneView
                    charName={char.name}
                    charAvatar={char.avatar}
                    userName={userProfile.name || '你'}
                    charChibi={charChibi?.transparentDataUrl}
                    userChibi={userChibi?.transparentDataUrl}
                    onClose={onClose}
                />
            )}
        </div>
        </BGMContext.Provider>
    );
};

// ============================================================
// Controller — 弹窗 → 角色选择 → Session
// ============================================================

// 520 弹窗内嵌的 API 配置面板 —— 配完直接传送进活动，不再绕去设置 App
const Like520InlineApiSetup: React.FC<{ onDone: () => void; onBack: () => void }> = ({ onDone, onBack }) => {
    const { apiConfig, updateApiConfig, addToast, availableModels, setAvailableModels, apiPresets } = useOS();

    const [localUrl, setLocalUrl] = useState(apiConfig.baseUrl);
    const [localKey, setLocalKey] = useState(apiConfig.apiKey);
    const [localModel, setLocalModel] = useState(apiConfig.model);
    const [localStream, setLocalStream] = useState(apiConfig.stream === true);
    const [isLoadingModels, setIsLoadingModels] = useState(false);
    const [statusMsg, setStatusMsg] = useState('');
    const [showModelList, setShowModelList] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<string | null>(null);

    const loadPreset = (preset: typeof apiPresets[0]) => {
        setLocalUrl(preset.config.baseUrl);
        setLocalKey(preset.config.apiKey);
        setLocalModel(preset.config.model);
        setLocalStream(preset.config.stream === true);
        setTestResult(null);
        addToast(`已加载预设: ${preset.name}`, 'info');
    };

    const handleSave = () => {
        updateApiConfig({ baseUrl: localUrl, apiKey: localKey, model: localModel, stream: localStream });
        setStatusMsg('配置已保存');
        addToast('API 配置已保存', 'success');
        setTimeout(() => setStatusMsg(''), 2000);
    };

    const fetchModels = async () => {
        if (!localUrl) { setStatusMsg('请先填写 URL'); return; }
        setIsLoadingModels(true);
        setStatusMsg('正在连接...');
        try {
            const baseUrl = localUrl.replace(/\/+$/, '');
            const response = await fetch(`${baseUrl}/models`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${localKey}`, 'Content-Type': 'application/json' }
            });
            if (!response.ok) throw new Error(`Status ${response.status}`);
            const data = await safeResponseJson(response);
            const list = data.data || data.models || [];
            if (Array.isArray(list)) {
                const models = list.map((m: any) => m.id || m);
                setAvailableModels(models);
                if (models.length > 0 && !models.includes(localModel)) setLocalModel(models[0]);
                setStatusMsg(`获取到 ${models.length} 个模型`);
                setShowModelList(true);
            } else { setStatusMsg('格式不兼容'); }
        } catch {
            setStatusMsg('连接失败');
        } finally {
            setIsLoadingModels(false);
        }
    };

    const handleTest = async () => {
        if (!localUrl.trim() || !localKey.trim() || !localModel.trim()) return;
        setTesting(true);
        setTestResult(null);
        try {
            const res = await fetch(`${localUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localKey.trim()}` },
                body: JSON.stringify({
                    model: localModel.trim(),
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 5,
                    stream: localStream,
                }),
            });
            if (res.ok) {
                const data = await safeResponseJson(res);
                const reply = data.choices?.[0]?.message?.content || '';
                setTestResult(`✅ 连接成功 — 模型回复: "${reply.slice(0, 30)}"`);
            } else {
                const text = await res.text().catch(() => '');
                setTestResult(`❌ HTTP ${res.status}: ${text.slice(0, 100)}`);
            }
        } catch (err: any) {
            setTestResult(`❌ 连接失败: ${err.message}`);
        } finally {
            setTesting(false);
        }
    };

    const handleContinue = () => {
        updateApiConfig({ baseUrl: localUrl, apiKey: localKey, model: localModel, stream: localStream });
        onDone();
    };

    const testDisabled = testing || !localUrl.trim() || !localKey.trim() || !localModel.trim();

    return (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-md" />
            <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-pink-200/50 overflow-hidden animate-slide-up max-h-[85vh] flex flex-col">
                <div className="px-6 pt-6 pb-2 text-center shrink-0">
                    <div className="text-2xl mb-1">🔧</div>
                    <h3 className="text-lg font-bold text-slate-800">API 配置</h3>
                    <p className="text-[11px] text-slate-400 mt-1">配置完成后即可前往今天的特别活动</p>
                </div>

                <div className="px-6 py-4 space-y-4 overflow-y-auto no-scrollbar flex-1">
                    {apiPresets.length > 0 && (
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">我的预设</label>
                            <div className="flex gap-2 flex-wrap">
                                {apiPresets.map(preset => (
                                    <button
                                        key={preset.id}
                                        onClick={() => loadPreset(preset)}
                                        className="text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg px-3 py-1.5 shadow-sm hover:text-pink-500 hover:border-pink-200 active:scale-95 transition-all"
                                    >
                                        {preset.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                        <input type="text" value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} placeholder="https://..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                        <input type="password" value={localKey} onChange={(e) => setLocalKey(e.target.value)} placeholder="sk-..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    </div>
                    <div>
                        <div className="flex justify-between items-center mb-1.5 pl-1">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                            <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-pink-500 font-bold">{isLoadingModels ? 'Fetching...' : '刷新模型列表'}</button>
                        </div>
                        <input type="text" value={localModel} onChange={(e) => setLocalModel(e.target.value)} placeholder="gpt-4o-mini" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />

                        {showModelList && availableModels.length > 0 && (
                            <div className="mt-2 max-h-32 overflow-y-auto no-scrollbar bg-slate-50 rounded-xl border border-slate-200/60 p-1">
                                {availableModels.map(m => (
                                    <button key={m} onClick={() => { setLocalModel(m); setShowModelList(false); }} className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono ${m === localModel ? 'bg-pink-500/10 text-pink-500 font-bold' : 'text-slate-600 hover:bg-slate-100'}`}>
                                        {m}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <button onClick={handleSave} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-pink-200 bg-gradient-to-r from-[#FFB6C8] to-[#F18AAA] active:scale-95 transition-all">
                        {statusMsg || '保存配置'}
                    </button>

                    <button
                        onClick={handleTest}
                        disabled={testDisabled}
                        className={`w-full py-2.5 rounded-2xl font-bold text-sm border active:scale-95 transition-all ${
                            testDisabled
                                ? 'border-slate-200 text-slate-400 bg-slate-50'
                                : 'border-pink-300 text-pink-500 bg-pink-50 hover:bg-pink-100'
                        }`}
                    >
                        {testing ? '测试中...' : '🧪 测试连接'}
                    </button>

                    {testResult && (
                        <div className={`text-xs px-3 py-2 rounded-xl ${
                            testResult.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                        }`}>
                            {testResult}
                        </div>
                    )}
                </div>

                <div className="px-6 pb-6 pt-2 flex gap-3 shrink-0">
                    <button onClick={onBack} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform text-sm">
                        返回
                    </button>
                    <button onClick={handleContinue} className="flex-1 py-3 bg-gradient-to-r from-pink-500 to-rose-500 text-white font-bold rounded-2xl shadow-lg shadow-pink-200 active:scale-95 transition-transform text-sm">
                        前往活动 ♥
                    </button>
                </div>
            </div>
        </div>
    );
};

interface Like520ControllerProps {
    onClose: () => void;
    initialCharId?: string;
}

export const Like520Controller: React.FC<Like520ControllerProps> = ({ onClose, initialCharId }) => {
    const { characters } = useOS();
    const [stage, setStage] = useState<'popup' | 'api' | 'select' | 'session'>(initialCharId ? 'session' : 'popup');
    const [charId, setCharId] = useState<string>(initialCharId || '');
    const [defaultCharId, setDefaultCharId] = useState<string>('');

    // 一次性弹窗：用户在弹窗里点过任何按钮都标记 dismissed，下次刷新就不会再弹
    const markDismissed = () => {
        try { localStorage.setItem(LIKE520_DISMISSED_KEY, '1'); } catch { /* ignore */ }
    };

    // popup 一打开就预选一个角色：优先 Sully，没有 Sully 选聊得最频繁的那个
    useEffect(() => {
        if (stage !== 'popup' || initialCharId) return;
        let cancelled = false;
        pickDefaultLike520Char(characters).then(id => {
            if (!cancelled) setDefaultCharId(id);
        });
        return () => { cancelled = true; };
    }, [stage, characters, initialCharId]);

    const defaultChar = useMemo(() => characters.find(c => c.id === defaultCharId), [characters, defaultCharId]);
    const isSullyDefault = defaultChar ? (defaultChar.name || '').toLowerCase().includes('sully') : false;

    const dismiss = () => {
        markDismissed();
        onClose();
    };

    const enterWithDefault = () => {
        if (!defaultCharId) return;
        markDismissed();
        setCharId(defaultCharId);
        setStage('session');
    };

    const goToApi = () => {
        markDismissed();
        setStage('api');
    };

    if (stage === 'popup') {
        const charName = defaultChar?.name || (characters.length === 0 ? '' : '...');
        const popupHeading = defaultChar
            ? (isSullyDefault ? 'Sully 好像有事找你？' : `${charName} 好像有事找你？`)
            : '特别活动';
        const popupBody = defaultChar
            ? (isSullyDefault
                ? 'ta 突然变得小小的——\n要不要去看看？'
                : `${charName} 今天有点不一样——\nta 突然变得小小的。`)
            : '今天是 5 月 20 号——\n但还没有可以陪你的角色。';

        return (
            <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
                <div className="absolute inset-0 bg-black/50 backdrop-blur-md" />
                <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-pink-200/50 overflow-hidden animate-slide-up">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-pink-100/60 to-transparent rounded-bl-full pointer-events-none" />
                    <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-rose-50/40 to-transparent rounded-tr-full pointer-events-none" />

                    <div className="pt-8 pb-4 px-6 text-center relative">
                        <div className="text-4xl mb-3">🌸</div>
                        <div className="text-[10px] tracking-[8px] text-[#C76182] mb-2">5 · 2 · 0</div>
                        <h2 className="text-lg font-extrabold text-slate-800">{popupHeading}</h2>
                        <p className="text-[11px] text-pink-400 mt-1.5 font-medium">2026 May 20 Special</p>
                        <p className="text-[12px] text-slate-500 mt-3 leading-relaxed whitespace-pre-line">{popupBody}</p>
                        <p className="text-[10px] text-slate-400 mt-3 leading-relaxed">
                            {defaultChar && !isSullyDefault
                                ? '（想换个 ta？桌面「特别时光」里所有 ta 都在）'
                                : '（这条提醒只会出现一次，活动随时可以在桌面「特别时光」里找到）'}
                        </p>
                    </div>

                    <div className="px-6 pb-7 pt-2 space-y-3 relative">
                        <button
                            onClick={enterWithDefault}
                            disabled={!defaultCharId}
                            className="w-full py-3.5 bg-gradient-to-r from-[#FFB6C8] to-[#F18AAA] text-white font-bold rounded-2xl shadow-lg shadow-pink-200 active:scale-95 transition-transform text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <span>确&nbsp;定</span>
                            <span>♥</span>
                        </button>

                        <button
                            onClick={goToApi}
                            className="w-full py-3 bg-pink-50 text-pink-500 font-semibold rounded-2xl text-sm active:scale-95 transition-transform"
                        >
                            API 配置
                        </button>

                        <button
                            onClick={dismiss}
                            className="w-full py-2 text-slate-400 text-xs"
                        >
                            不感兴趣
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (stage === 'api') {
        return (
            <Like520InlineApiSetup
                onDone={() => {
                    // 配完直接进入活动 —— 优先用预选角色，没有就让用户挑
                    if (defaultCharId) {
                        setCharId(defaultCharId);
                        setStage('session');
                    } else {
                        setStage('select');
                    }
                }}
                onBack={() => setStage('popup')}
            />
        );
    }

    if (stage === 'select') {
        return (
            <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
                <div className="absolute inset-0 bg-black/40 backdrop-blur" onClick={onClose} />
                <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2rem] shadow-2xl border border-white/40 overflow-hidden max-h-[80vh] flex flex-col">
                    <div className="px-6 pt-6 pb-3 text-center shrink-0">
                        <h3 className="text-lg font-bold text-[#5C3A4A]">选一个 ta</h3>
                        <p className="text-[11px] text-[#9D7585] mt-1">一起度过这个下午</p>
                    </div>
                    <div className="px-4 pb-4 overflow-y-auto flex-1">
                        {characters.length === 0 ? (
                            <div className="text-center text-sm text-[#9D7585] py-8">还没有角色呢</div>
                        ) : (
                            <div className="grid grid-cols-2 gap-3">
                                {characters.map(c => (
                                    <button
                                        key={c.id}
                                        onClick={() => { setCharId(c.id); setStage('session'); }}
                                        className="flex flex-col items-center gap-2 p-3 bg-[#FFF8F1] rounded-2xl border border-[#FCEDD9] active:scale-95 transition-transform"
                                    >
                                        {c.avatar?.startsWith('http') || c.avatar?.startsWith('data:') ? (
                                            <img src={c.avatar} alt={c.name} className="w-12 h-12 rounded-full object-cover" />
                                        ) : (
                                            <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center text-2xl">
                                                {c.avatar || '🌸'}
                                            </div>
                                        )}
                                        <div className="text-[12px] font-bold text-[#5C3A4A] truncate w-full">{c.name}</div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-[9998]">
            <Like520Session charId={charId} onClose={onClose} />
        </div>
    );
};
