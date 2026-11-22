/**
 * Pixel Home — 7房间俯瞰地图
 *
 * 星露谷风格俯视平面图。
 * 客厅最大，用户房和个人房相邻。
 * 角色小人在当前房间随机走动。
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import type { PixelHomeState, PixelHomeTheme, PixelAsset } from './types';
import { DEFAULT_HOME_THEME, decodeColorField } from './types';
import type { MemoryRoom } from '../../utils/memoryPalace/types';
import { ROOM_META, ROOM_SIZES } from './roomTemplates';
import TokenImg from '../../components/os/TokenImg';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

interface Props {
  homeState: PixelHomeState;
  assets: PixelAsset[];
  charSprite?: string;
  userName: string;
  onEnterRoom: (roomId: MemoryRoom) => void;
  /** 修改全局主题色（外围墙体/背景）。父层负责落盘。 */
  onUpdateTheme?: (theme: PixelHomeTheme) => void;
}

// 重新排布：客厅大，用户房和个人房相邻
// 布局 (单位: 格子, 每格 CELL px)
//
//   [  露台/窗台 10x3  ]
//   [卧室 5x5][书房 5x5]
//   [    客厅  10x6    ]  ← 最大
//   [个人房5x4][用户房5x4]
//   [  阁楼  4x4  ]
//
const FLOOR_PLAN: { roomId: MemoryRoom; x: number; y: number; w: number; h: number }[] = [
  { roomId: 'windowsill',  x: 0,  y: 0,  w: 10, h: 3 },
  { roomId: 'bedroom',     x: 0,  y: 4,  w: 5,  h: 5 },
  { roomId: 'study',       x: 5,  y: 4,  w: 5,  h: 5 },
  { roomId: 'living_room', x: 0,  y: 10, w: 10, h: 6 },  // 大客厅
  { roomId: 'self_room',   x: 0,  y: 17, w: 5,  h: 4 },
  { roomId: 'user_room',   x: 5,  y: 17, w: 5,  h: 4 },  // 挨着个人房
  { roomId: 'attic',       x: 3,  y: 22, w: 4,  h: 4 },
];

const CELL = 28;
const WALL_THICK = 5;
const WALL_TOP_RATIO = 0.38;

const ROOM_STYLE: Record<MemoryRoom, {
  wallFace: string; wallFaceDark: string;
  floor: string; floorAlt: string; floorType: 'wood' | 'tile' | 'stone';
}> = {
  living_room: { wallFace: '#e8d5b8', wallFaceDark: '#d4c1a4', floor: '#c4a882', floorAlt: '#b89b75', floorType: 'wood' },
  bedroom:     { wallFace: '#e8ddd0', wallFaceDark: '#d8cdc0', floor: '#d4b896', floorAlt: '#c9ab87', floorType: 'wood' },
  study:       { wallFace: '#c9b99a', wallFaceDark: '#b5a586', floor: '#8b6f47', floorAlt: '#7d6340', floorType: 'wood' },
  attic:       { wallFace: '#6b5d50', wallFaceDark: '#5a4d42', floor: '#706050', floorAlt: '#655545', floorType: 'stone' },
  self_room:   { wallFace: '#f0d0e0', wallFaceDark: '#e0c0d0', floor: '#d4a8c0', floorAlt: '#c99db5', floorType: 'tile' },
  user_room:   { wallFace: '#c8e0d0', wallFaceDark: '#b8d0c0', floor: '#a8c4b0', floorAlt: '#9db9a5', floorType: 'tile' },
  windowsill:  { wallFace: '#a8bfb0', wallFaceDark: '#98af9f', floor: '#92a89c', floorAlt: '#879d91', floorType: 'stone' },
};

// 以下三色可被 homeState.theme 覆盖；留作回退默认
const WALL_BORDER_FALLBACK = DEFAULT_HOME_THEME.wallBorder;
const WALL_BORDER_LIGHT_FALLBACK = DEFAULT_HOME_THEME.wallBorderLight;
const BG_COLOR_FALLBACK = DEFAULT_HOME_THEME.bgColor;

const PixelHomeMap: React.FC<Props> = ({ homeState, assets, charSprite, userName, onEnterRoom, onUpdateTheme }) => {
  const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
  const theme = homeState.theme || DEFAULT_HOME_THEME;
  const WALL_BORDER = theme.wallBorder || WALL_BORDER_FALLBACK;
  const WALL_BORDER_LIGHT = theme.wallBorderLight || WALL_BORDER_LIGHT_FALLBACK;
  const BG_COLOR = theme.bgColor || BG_COLOR_FALLBACK;
  const CORRIDOR_STEP = theme.corridorStep || DEFAULT_HOME_THEME.corridorStep;

  const [themePanelOpen, setThemePanelOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const initialPinchDist = useRef(0);
  const initialPinchScale = useRef(1);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  // 角色小人（像素步行）
  const [charPos, setCharPos] = useState({ roomIdx: 3, x: 50, y: 60 });
  const [charFlip, setCharFlip] = useState(false);
  const [charWalking, setCharWalking] = useState(false);
  const [charStep, setCharStep] = useState(0);
  const charTargetRef = useRef({ x: 50, y: 60 });
  const charPosRef = useRef({ x: 50, y: 60 });

  useEffect(() => {
    const pickTarget = () => {
      const cur = charPosRef.current;
      charTargetRef.current = {
        x: Math.max(20, Math.min(80, cur.x + (Math.random() - 0.5) * 30)),
        y: Math.max(40, Math.min(80, cur.y + (Math.random() - 0.5) * 20)),
      };
    };
    pickTarget();

    const stepTimer = setInterval(() => {
      const cur = charPosRef.current;
      const tgt = charTargetRef.current;
      const dx = tgt.x - cur.x;
      const dy = tgt.y - cur.y;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) { setCharWalking(false); return; }
      let nx = cur.x, ny = cur.y;
      if (Math.abs(dx) >= Math.abs(dy)) {
        nx += dx > 0 ? 8 : -8;
        setCharFlip(dx < 0);
      } else {
        ny += dy > 0 ? 8 : -8;
      }
      nx = Math.max(15, Math.min(85, nx));
      ny = Math.max(35, Math.min(85, ny));
      charPosRef.current = { x: nx, y: ny };
      setCharPos(prev => ({ ...prev, x: nx, y: ny }));
      setCharWalking(true);
      setCharStep(s => 1 - s);
    }, 600);

    const targetTimer = setInterval(pickTarget, 5000 + Math.random() * 4000);

    // 每隔 12~20 秒有概率换个房间；避免永远只待在客厅
    const roomSwitchTimer = setInterval(() => {
      if (Math.random() < 0.55) {
        const nextIdx = Math.floor(Math.random() * FLOOR_PLAN.length);
        charPosRef.current = { x: 50, y: 60 };
        charTargetRef.current = { x: 50, y: 60 };
        setCharPos({ roomIdx: nextIdx, x: 50, y: 60 });
      }
    }, 12000 + Math.random() * 8000);

    return () => { clearInterval(stepTimer); clearInterval(targetTimer); clearInterval(roomSwitchTimer); };
  }, []);

  // wheel
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      setScale(s => Math.max(0.4, Math.min(3, s + (e.deltaY > 0 ? -0.15 : 0.15))));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // 统一用 touch 事件处理移动端，pointer 事件只处理桌面端鼠标
  const isPinching = useRef(false);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return; // 触摸交由 touch 事件处理
    if ((e.target as HTMLElement).closest('[data-room]')) return;
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  }, [offset]);
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (!isDragging.current) return;
    setOffset({ x: dragStart.current.ox + (e.clientX - dragStart.current.x), y: dragStart.current.oy + (e.clientY - dragStart.current.y) });
  }, []);
  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch') return;
    isDragging.current = false;
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // 双指 → 缩放（绝对比例，避免跳变）
      isPinching.current = true;
      isDragging.current = false;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      initialPinchDist.current = Math.sqrt(dx * dx + dy * dy);
      initialPinchScale.current = scale;
    } else if (e.touches.length === 1 && !isPinching.current) {
      if ((e.target as HTMLElement).closest('[data-room]')) return;
      isDragging.current = true;
      dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, ox: offset.x, oy: offset.y };
    }
  }, [offset, scale]);
  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && isPinching.current) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (initialPinchDist.current > 0) {
        setScale(Math.max(0.4, Math.min(3, initialPinchScale.current * (dist / initialPinchDist.current))));
      }
    } else if (e.touches.length === 1 && isDragging.current && !isPinching.current) {
      setOffset({ x: dragStart.current.ox + (e.touches[0].clientX - dragStart.current.x), y: dragStart.current.oy + (e.touches[0].clientY - dragStart.current.y) });
    }
  }, []);
  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 0) {
      isDragging.current = false;
      isPinching.current = false;
      initialPinchDist.current = 0;
    }
  }, []);

  const totalW = Math.max(...FLOOR_PLAN.map(r => r.x + r.w)) * CELL + WALL_THICK * 2 + 20;
  const totalH = Math.max(...FLOOR_PLAN.map(r => r.y + r.h)) * CELL + WALL_THICK * 2 + 20;

  // 初始化：自动缩放适配屏幕宽度
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    // 以宽度为主，同时确保高度不超出
    const fitScale = Math.min(cw / totalW, ch / totalH) * 0.95;
    setScale(Math.max(0.4, Math.min(3, fitScale)));
    setOffset({ x: 0, y: 0 });
  }, []);

  // 获取房间显示名
  const getRoomName = (roomId: MemoryRoom) => {
    if (roomId === 'user_room') return `${userName}的房`;
    return ROOM_META[roomId].name;
  };

  const updateTheme = useCallback((patch: Partial<PixelHomeTheme>) => {
    if (!onUpdateTheme) return;
    onUpdateTheme({ ...theme, ...patch });
  }, [theme, onUpdateTheme]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden touch-none relative"
      style={{ backgroundColor: BG_COLOR }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* 主题面板按钮（可修改外围墙体 + 画布背景色）——只在有回调时出现 */}
      {onUpdateTheme && (
        <>
          <button onClick={e => { e.stopPropagation(); setThemePanelOpen(v => !v); }}
            onPointerDown={e => e.stopPropagation()}
            className="absolute top-2 right-2 z-50 px-2.5 py-1.5 rounded-lg text-[10px] font-bold text-white/90 bg-slate-800/80 hover:bg-slate-700 active:scale-95 border border-slate-600/50">
            主题
          </button>
          {themePanelOpen && (
            <div className="absolute top-12 right-2 z-50 w-52 p-3 rounded-xl bg-slate-900/95 border border-slate-700 shadow-2xl space-y-2 text-[10px]"
              onPointerDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between">
                <span className="text-slate-200 font-bold text-[11px]">家园主题</span>
                <button onClick={() => setThemePanelOpen(false)}
                  className="text-slate-500 hover:text-slate-200">×</button>
              </div>
              <ThemeRow label="外围墙体" value={WALL_BORDER} onChange={v => updateTheme({ wallBorder: v })} />
              <ThemeRow label="墙体高光" value={WALL_BORDER_LIGHT} onChange={v => updateTheme({ wallBorderLight: v })} />
              <ThemeRow label="画布背景" value={BG_COLOR} onChange={v => updateTheme({ bgColor: v })} />
              <ThemeRow label="楼梯亮条" value={CORRIDOR_STEP} onChange={v => updateTheme({ corridorStep: v })} />
              <button onClick={async () => {
                const ok = await requestConfirm({
                  title: '还原默认家园主题配色？',
                  message: '外围墙体、墙体高光、画布背景与楼梯亮条将恢复默认颜色。',
                  confirmText: '确认还原',
                  variant: 'warning',
                });
                if (ok) updateTheme(DEFAULT_HOME_THEME);
              }}
                className="w-full py-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-300">
                还原默认
              </button>
            </div>
          )}
        </>
      )}

      <div className="w-full h-full flex items-center justify-center" style={{
        transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
        transformOrigin: 'center center',
      }}>
        <div className="relative" style={{ width: totalW, height: totalH }}>
          {FLOOR_PLAN.map(({ roomId, x, y, w, h }, idx) => {
            const meta = ROOM_META[roomId];
            const style = ROOM_STYLE[roomId];
            const roomLayout = homeState.rooms.find(r => r.roomId === roomId);
            const px = x * CELL + WALL_THICK + 10;
            const py = y * CELL + WALL_THICK + 10;
            const pw = w * CELL;
            const ph = h * CELL;
            const wallH = Math.round(ph * WALL_TOP_RATIO);

            return (
              <button key={roomId} data-room={roomId} onClick={() => onEnterRoom(roomId)}
                className="absolute group" style={{ left: px, top: py, width: pw, height: ph }}>
                {/* 墙壁边框 */}
                <div className="absolute rounded-sm" style={{ inset: -WALL_THICK, backgroundColor: WALL_BORDER }}>
                  <div className="absolute inset-x-0 top-0 rounded-t-sm" style={{ height: 2, backgroundColor: WALL_BORDER_LIGHT }} />
                  <div className="absolute inset-y-0 left-0 rounded-l-sm" style={{ width: 2, backgroundColor: WALL_BORDER_LIGHT }} />
                </div>

                {/* 墙面带 */}
                <div className="absolute inset-x-0 top-0 overflow-hidden" style={{ height: wallH }}>
                  {(() => {
                    const d = decodeColorField(roomLayout?.wallColor);
                    if (d.kind === 'image') {
                      return (
                        <div className="absolute inset-0" style={
                          roomLayout?.wallFillMode === 'stretch'
                            ? {
                                backgroundImage: `url(${d.value})`,
                                backgroundSize: 'cover',
                                backgroundRepeat: 'no-repeat',
                                backgroundPosition: `${roomLayout.wallOffsetX ?? 50}% ${roomLayout.wallOffsetY ?? 50}%`,
                                imageRendering: 'pixelated' as any,
                              }
                            : {
                                backgroundImage: `url(${d.value})`,
                                backgroundSize: `${CELL * 2}px ${CELL * 2}px`,
                                backgroundRepeat: 'repeat',
                                imageRendering: 'pixelated' as any,
                              }
                        } />
                      );
                    }
                    if (d.kind === 'color') {
                      return (
                        <>
                          <div className="absolute inset-0" style={{ backgroundColor: d.value }} />
                          <div className="absolute inset-0" style={{
                            backgroundImage: `linear-gradient(rgba(0,0,0,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.06) 1px, transparent 1px)`,
                            backgroundSize: `${CELL * 2}px ${Math.round(CELL * 0.6)}px`,
                          }} />
                        </>
                      );
                    }
                    return (
                      <>
                        <div className="absolute inset-0" style={{ backgroundColor: style.wallFace }} />
                        <div className="absolute inset-0" style={{
                          backgroundImage: `linear-gradient(${style.wallFaceDark} 1px, transparent 1px), linear-gradient(90deg, ${style.wallFaceDark}40 1px, transparent 1px)`,
                          backgroundSize: `${CELL * 2}px ${Math.round(CELL * 0.6)}px`,
                        }} />
                      </>
                    );
                  })()}
                  <div className="absolute inset-x-0 bottom-0 h-[2px]" style={{ background: `linear-gradient(to bottom, ${style.wallFaceDark}, ${style.floor})` }} />
                </div>

                {/* 地板 */}
                <div className="absolute inset-x-0 bottom-0 overflow-hidden" style={{ top: wallH }}>
                  {(() => {
                    const d = decodeColorField(roomLayout?.floorColor);
                    if (d.kind === 'image') {
                      return (
                        <div className="absolute inset-0" style={
                          roomLayout?.floorFillMode === 'stretch'
                            ? {
                                backgroundImage: `url(${d.value})`,
                                backgroundSize: 'cover',
                                backgroundRepeat: 'no-repeat',
                                backgroundPosition: `${roomLayout.floorOffsetX ?? 50}% ${roomLayout.floorOffsetY ?? 50}%`,
                                imageRendering: 'pixelated' as any,
                              }
                            : {
                                backgroundImage: `url(${d.value})`,
                                backgroundSize: `${CELL}px ${CELL}px`,
                                backgroundRepeat: 'repeat',
                                imageRendering: 'pixelated' as any,
                              }
                        } />
                      );
                    }
                    if (d.kind === 'color') {
                      return (
                        <>
                          <div className="absolute inset-0" style={{ backgroundColor: d.value }} />
                          <FloorTexture type={style.floorType} base={d.value} alt={style.floorAlt} />
                        </>
                      );
                    }
                    return (
                      <>
                        <div className="absolute inset-0" style={{ backgroundColor: style.floor }} />
                        <FloorTexture type={style.floorType} base={style.floor} alt={style.floorAlt} />
                      </>
                    );
                  })()}
                </div>

                {/* 家具（仅用户放置的素材）—— 包一层 overflow:hidden，这样大家具的
                   角落溢出部分会被裁掉，而不是溢进隔壁房间；也不影响外层墙体边框。 */}
                <div className="absolute inset-0 overflow-hidden pointer-events-none">
                {roomLayout?.furniture.map(f => {
                  if (!f.assetId) return null;
                  const asset = assets.find(a => a.id === f.assetId);
                  if (!asset) return null;
                  const imgSrc = asset.pixelImage;
                  const furSize = Math.round(Math.min(pw, ph) * 0.22 * f.scale);
                  // 软 clamp：中心点必须在房间内（0..pw, 0..ph），允许最多半个家具宽度溢出；
                  // 溢出部分由外层 overflow-hidden 裁掉。原来的硬 clamp (furSize/2, pw-furSize/2)
                  // 会把角落大家具整体偏移（"右下角家具在全景里整体上移"），完全没 clamp 则
                  // 有用户把小家具 f.y 置到 >100 的位置时会画在"房子外面"，肉眼看像楼梯/家具
                  // "跑出房子"。软 clamp 两害相权取其轻。
                  const cxMap = Math.max(0, Math.min(pw, (f.x / 100) * pw));
                  const cyMap = Math.max(0, Math.min(ph, (f.y / 100) * ph));
                  const posX = Math.round(cxMap - furSize / 2);
                  const posY = Math.round(cyMap - furSize / 2);
                  // 和 PixelRoomEditor 一致：按中心 y 分桶
                  // （避免墙上大家具因视觉底边虚高而压住角色头）
                  const autoZ = Math.round(f.y * 4) + 20;
                  const zIdx = f.zOrder === 'back'
                    ? 2 + Math.round(autoZ / 200)
                    : f.zOrder === 'front'
                      ? 1000 + autoZ
                      : autoZ;
                  return (
                    <img key={f.slotId} src={imgSrc} alt={f.slotId}
                      className="absolute pointer-events-none"
                      style={{
                        left: posX, top: posY,
                        width: furSize, height: 'auto',
                        transform: `rotate(${f.rotation}deg)`,
                        imageRendering: 'pixelated' as any,
                        zIndex: zIdx,
                      }}
                      draggable={false}
                    />
                  );
                })}
                </div>

                {/* 角色小人（像素步行） */}
                {idx === charPos.roomIdx && charSprite && (
                  <div className="absolute z-40 pointer-events-none"
                    style={{
                      left: `${charPos.x}%`, top: `${charPos.y}%`,
                      width: 24,
                      height: 24,
                      transform: `translate(-50%, -100%) scaleX(${charFlip ? -1 : 1})`,
                    }}>
                    <TokenImg value={charSprite} className="drop-shadow-sm"
                      style={{
                        display: 'block',
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        imageRendering: 'pixelated',
                        transform: charWalking
                          ? `rotate(${charStep === 0 ? -4 : 4}deg) translateY(${charStep === 0 ? -1 : 0}px)`
                          : 'none',
                      }} draggable={false} />
                    <div className="mx-auto rounded-full bg-black/20" style={{
                      width: charWalking ? 10 : 12, height: 2,
                    }} />
                  </div>
                )}

                {/* 房间名 */}
                <div className="absolute inset-x-0 bottom-1 flex justify-center pointer-events-none z-50">
                  <span className="text-[7px] font-bold px-1.5 py-0.5 rounded bg-black/60 text-white/90 whitespace-nowrap">
                    {getRoomName(roomId)}
                  </span>
                </div>
                <div className="absolute inset-0 bg-white/0 group-hover:bg-white/10 transition-colors duration-150 z-30" />
              </button>
            );
          })}

          {/* 走廊/楼梯：连接相邻房间之间 1 格空隙。y 坐标要跟 FLOOR_PLAN 同步：
               窗台 0..2 | 间隙 3 | 卧室/书房 4..8 | 间隙 9 | 客厅 10..15 | 间隙 16 | 个人/用户 17..20 | 间隙 21 | 阁楼 22..25 */}
          <Corridor x={4} y1={3}  y2={4}  border={WALL_BORDER} step={CORRIDOR_STEP} />
          <Corridor x={4} y1={9}  y2={10} border={WALL_BORDER} step={CORRIDOR_STEP} />
          <Corridor x={4} y1={16} y2={17} border={WALL_BORDER} step={CORRIDOR_STEP} />
          <Corridor x={4} y1={21} y2={22} border={WALL_BORDER} step={CORRIDOR_STEP} />
        </div>
      </div>
      <div style={{ display: 'contents' }} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>{confirmDialog}</div>
    </div>
  );
};

const FloorTexture: React.FC<{ type: string; base: string; alt: string }> = ({ type, base, alt }) => {
  if (type === 'wood') return <div className="absolute inset-0" style={{
    backgroundImage: `repeating-linear-gradient(90deg, ${alt} 0px, ${alt} 1px, transparent 1px, transparent ${CELL}px), repeating-linear-gradient(0deg, transparent 0px, transparent ${CELL - 1}px, ${alt}80 ${CELL - 1}px, ${alt}80 ${CELL}px)`,
  }} />;
  if (type === 'tile') return <div className="absolute inset-0" style={{
    backgroundImage: `linear-gradient(${alt} 1px, transparent 1px), linear-gradient(90deg, ${alt} 1px, transparent 1px)`,
    backgroundSize: `${CELL}px ${CELL}px`,
  }} />;
  return <div className="absolute inset-0" style={{
    backgroundImage: `linear-gradient(${alt} 1px, transparent 1px), linear-gradient(90deg, ${alt} 1px, transparent 1px)`,
    backgroundSize: `${Math.round(CELL * 1.5)}px ${CELL}px`,
  }} />;
};

const ThemeRow: React.FC<{ label: string; value: string; onChange: (v: string) => void }> = ({ label, value, onChange }) => (
  <label className="flex items-center justify-between gap-2 py-0.5 cursor-pointer">
    <span className="text-slate-400">{label}</span>
    <span className="flex items-center gap-1.5">
      <span className="w-4 h-4 rounded border border-slate-600" style={{ backgroundColor: value }} />
      <span className="text-slate-500 tabular-nums">{value}</span>
      <input type="color" className="sr-only" value={value}
        onChange={e => onChange(e.target.value)} />
    </span>
  </label>
);

const Corridor: React.FC<{ x: number; y1: number; y2: number; border: string; step: string }> = ({ x, y1, y2, border, step }) => {
  const left = x * CELL + WALL_THICK + 10;
  const top = y1 * CELL + WALL_THICK + 10;
  const h = (y2 - y1) * CELL;
  return <div className="absolute pointer-events-none" style={{
    left, top, width: CELL * 2, height: h,
    background: `repeating-linear-gradient(180deg, ${border} 0px, ${border} 3px, ${step} 3px, ${step} ${Math.round(CELL / 2)}px)`,
    borderLeft: `${WALL_THICK}px solid ${border}`,
    borderRight: `${WALL_THICK}px solid ${border}`,
  }} />;
};

export default PixelHomeMap;
