/**
 * Pixel Home — 单房间编辑器（俯视视角）
 *
 * 按格子移动家具（像素游戏风格）
 * 支持自定义墙纸/地砖上传
 * 内嵌记忆空间可视化面板
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { PixelRoomLayout, PlacedFurniture, PixelAsset } from './types';
import { decodeColorField } from './types';
import type { MemoryRoom } from '../../utils/memoryPalace/types';
import type { MemoryNode } from '../../utils/memoryPalace/types';
import { ROOM_SLOTS, ROOM_META, ROOM_SIZES } from './roomTemplates';
import { PixelLayoutDB } from './pixelHomeDb';
import { MemoryNodeDB } from '../../utils/memoryPalace/db';
import { processImage } from '../../utils/file';
import { pixelizeImage, removeBackground } from '../../utils/pixelizer';
import { trackEvent } from '../../utils/analytics';
import TokenImg from '../../components/os/TokenImg';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

interface Props {
  charId: string;
  charName: string;
  charSprite?: string;
  userName: string;
  roomId: MemoryRoom;
  layout: PixelRoomLayout;
  assets: PixelAsset[];
  onUpdate: () => void;
  onOpenLibrary: (slotId: string | null) => void;
}

const TILE = 28;
const WALL_TOP_RATIO = 0.38;
// 编辑器放大倍率（用整数避免子像素渲染问题）
const EDITOR_SCALE = 1.5;
const SNAP_SUBDIVISIONS = 3; // 每格细分3段，拖拽更精细

/** 吸附到细分格子。允许中心点略微溢出房间边界（-30..130），这样
 *  大家具也能把视觉底边 / 边缘放到房间边上，而不是停在"中心点贴边"。 */
function snapToGrid(cols: number, rows: number, x: number, y: number): { x: number; y: number } {
  const fineCols = cols * SNAP_SUBDIVISIONS;
  const fineRows = rows * SNAP_SUBDIVISIONS;
  const stepX = 100 / fineCols;
  const stepY = 100 / fineRows;
  return {
    x: Math.max(-30, Math.min(130, Math.round(x / stepX) * stepX)),
    y: Math.max(-30, Math.min(130, Math.round(y / stepY) * stepY)),
  };
}

const FLOOR_STYLES: Record<string, {
  wallFace: string; wallFaceDark: string;
  base: string; alt: string; pattern: 'wood' | 'tile' | 'stone';
}> = {
  living_room: { wallFace: '#e8d5b8', wallFaceDark: '#d4c1a4', base: '#c4a882', alt: '#b89b75', pattern: 'wood' },
  bedroom:     { wallFace: '#e8ddd0', wallFaceDark: '#d8cdc0', base: '#d4b896', alt: '#c9ab87', pattern: 'wood' },
  study:       { wallFace: '#c9b99a', wallFaceDark: '#b5a586', base: '#8b6f47', alt: '#7d6340', pattern: 'wood' },
  attic:       { wallFace: '#6b5d50', wallFaceDark: '#5a4d42', base: '#706050', alt: '#655545', pattern: 'stone' },
  self_room:   { wallFace: '#f0d0e0', wallFaceDark: '#e0c0d0', base: '#d4a8c0', alt: '#c99db5', pattern: 'tile' },
  user_room:   { wallFace: '#c8e0d0', wallFaceDark: '#b8d0c0', base: '#a8c4b0', alt: '#9db9a5', pattern: 'tile' },
  windowsill:  { wallFace: '#a8bfb0', wallFaceDark: '#98af9f', base: '#92a89c', alt: '#879d91', pattern: 'stone' },
};

const WALL_COLOR = '#3d2b1f';
const WALL_LIGHT = '#5c4332';
const WALL_THICK = 6;

// 情绪色
const MOOD_COLORS: Record<string, string> = {
  happy: '#fbbf24', sad: '#60a5fa', angry: '#ef4444', anxious: '#f97316',
  tender: '#f472b6', peaceful: '#34d399', confused: '#a78bfa', neutral: '#94a3b8',
};

/** 判断家具是否为地毯类（角色可踩，不遮挡，不碰撞） */
function isRugAsset(f: PlacedFurniture, assets: PixelAsset[]): boolean {
  if (!f.assetId) return false;
  const asset = assets.find(a => a.id === f.assetId);
  return !!asset?.tags?.includes('rug');
}

const PixelRoomEditor: React.FC<Props> = ({ charId, charName, charSprite, userName, roomId, layout, assets, onUpdate, onOpenLibrary }) => {
  const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
  const [furniture, setFurniture] = useState<PlacedFurniture[]>(layout.furniture);
  const [wallColor, setWallColor] = useState(layout.wallColor);
  const [floorColor, setFloorColor] = useState(layout.floorColor);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [zoom, setZoom] = useState(1);
  const [showMemory, setShowMemory] = useState(false);
  const [memories, setMemories] = useState<MemoryNode[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);

  // 自定义墙纸/地砖
  const [customWall, setCustomWall] = useState<string | null>(layout.wallColor.startsWith('data:') ? layout.wallColor : null);
  const [customFloor, setCustomFloor] = useState<string | null>(layout.floorColor.startsWith('data:') ? layout.floorColor : null);
  const [floorTileSize, setFloorTileSize] = useState(TILE); // 地砖平铺大小（可调）
  // 铺设模式 + 偏移
  const [wallFillMode, setWallFillMode] = useState<'tile' | 'stretch'>(layout.wallFillMode || 'tile');
  const [wallOffsetX, setWallOffsetX] = useState(layout.wallOffsetX ?? 50);
  const [wallOffsetY, setWallOffsetY] = useState(layout.wallOffsetY ?? 50);
  const [floorFillMode, setFloorFillMode] = useState<'tile' | 'stretch'>(layout.floorFillMode || 'tile');
  const [floorOffsetX, setFloorOffsetX] = useState(layout.floorOffsetX ?? 50);
  const [floorOffsetY, setFloorOffsetY] = useState(layout.floorOffsetY ?? 50);

  // 纹理上传预览
  const [texturePreview, setTexturePreview] = useState<{
    target: 'wall' | 'floor';
    originalUri: string;
    pixelizedUri: string;
    tileSize: number;
    fillMode: 'tile' | 'stretch';
    offsetX: number;  // 0..100, 50 = 居中
    offsetY: number;
  } | null>(null);
  const [textureUseOriginal, setTextureUseOriginal] = useState(false);

  // 角色小人（像素走路）
  const [charPos, setCharPos] = useState({ x: 50, y: 62 });
  const [charFlip, setCharFlip] = useState(false);
  const [charWalking, setCharWalking] = useState(false);
  const [charStep, setCharStep] = useState(0); // 走路帧 0/1
  const charTargetRef = useRef({ x: 50, y: 62 });
  const charPosRef = useRef({ x: 50, y: 62 });

  const stageRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<string | null>(null);
  const dragConfirmedRef = useRef(false); // 是否已超过拖拽阈值
  const dragStartRef = useRef<{ x: number; y: number; fx: number; fy: number }>({ x: 0, y: 0, fx: 0, fy: 0 });
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const wallInputRef = useRef<HTMLInputElement>(null);
  const floorInputRef = useRef<HTMLInputElement>(null);

  // 多指触控状态（pinch-to-zoom）
  const touchStateRef = useRef<{
    active: boolean;        // 是否正在双指操作
    initialDist: number;    // 初始双指距离
    initialZoom: number;    // 初始缩放值
  }>({ active: false, initialDist: 0, initialZoom: 1 });

  const DRAG_THRESHOLD = 8; // 像素，超过才算拖拽

  // 碰撞检测：缓存每个资产的 alpha 遮罩
  const collisionMasksRef = useRef<Map<string, ImageData>>(new Map());
  const collisionBlockedRef = useRef<Set<string>>(new Set());

  const meta = ROOM_META[roomId];
  const slotDefs = ROOM_SLOTS[roomId];
  const floorStyle = FLOOR_STYLES[roomId] || FLOOR_STYLES.living_room;
  const roomSize = ROOM_SIZES[roomId];
  const GRID_COLS = roomSize.w;
  const GRID_ROWS = roomSize.h;
  const GRID_STEP_X = 100 / GRID_COLS;
  const GRID_STEP_Y = 100 / GRID_ROWS;

  // 像素走路：每 600ms 走一格，走 2-3 步就停，停 4-8 秒再动
  useEffect(() => {
    const pickTarget = () => {
      // 只走附近 2-3 格，不横穿整个房间
      const cur = charPosRef.current;
      const range = GRID_STEP_X * 3;
      charTargetRef.current = snapToGrid(GRID_COLS, GRID_ROWS,
        cur.x + (Math.random() - 0.5) * range * 2,
        cur.y + (Math.random() - 0.5) * range * 1.5,
      );
    };
    pickTarget();

    const stepTimer = setInterval(() => {
      const cur = charPosRef.current;
      const tgt = charTargetRef.current;
      const dx = tgt.x - cur.x;
      const dy = tgt.y - cur.y;

      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
        setCharWalking(false);
        return;
      }

      let nx = cur.x, ny = cur.y;
      if (Math.abs(dx) >= Math.abs(dy)) {
        nx += dx > 0 ? GRID_STEP_X : -GRID_STEP_X;
        setCharFlip(dx < 0);
      } else {
        ny += dy > 0 ? GRID_STEP_Y : -GRID_STEP_Y;
      }
      nx = Math.max(GRID_STEP_X, Math.min(100 - GRID_STEP_X, nx));
      // 角色只走地面区域（墙面以下）
      const floorMinY = Math.ceil(WALL_TOP_RATIO * 100 / GRID_STEP_Y) * GRID_STEP_Y;
      ny = Math.max(floorMinY, Math.min(100 - GRID_STEP_Y, ny));

      // 碰撞检测：检查目标位置是否有不透明家具像素
      const COLLISION_RES = 2;
      const cgx = Math.round((nx / 100) * GRID_COLS * COLLISION_RES);
      const cgy = Math.round((ny / 100) * GRID_ROWS * COLLISION_RES);
      if (collisionBlockedRef.current.has(`${cgx},${cgy}`)) {
        // 被家具挡住，不移动，换一个目标
        charTargetRef.current = snapToGrid(GRID_COLS, GRID_ROWS,
          cur.x + (Math.random() - 0.5) * GRID_STEP_X * 4,
          cur.y + (Math.random() - 0.5) * GRID_STEP_Y * 4,
        );
        setCharWalking(false);
        return;
      }

      charPosRef.current = { x: nx, y: ny };
      setCharPos({ x: nx, y: ny });
      setCharWalking(true);
      setCharStep(s => 1 - s);
    }, 600);

    const targetTimer = setInterval(pickTarget, 5000 + Math.random() * 4000);
    return () => { clearInterval(stepTimer); clearInterval(targetTimer); };
  }, []);

  useEffect(() => {
    setFurniture(layout.furniture);
    setWallColor(layout.wallColor);
    setFloorColor(layout.floorColor);
    setCustomWall(layout.wallColor.startsWith('data:') ? layout.wallColor : null);
    setCustomFloor(layout.floorColor.startsWith('data:') ? layout.floorColor : null);
    setWallFillMode(layout.wallFillMode || 'tile');
    setWallOffsetX(layout.wallOffsetX ?? 50);
    setWallOffsetY(layout.wallOffsetY ?? 50);
    setFloorFillMode(layout.floorFillMode || 'tile');
    setFloorOffsetX(layout.floorOffsetX ?? 50);
    setFloorOffsetY(layout.floorOffsetY ?? 50);
  }, [layout]);

  // 碰撞地图构建：从家具像素的 alpha 通道判断哪些位置被遮挡
  useEffect(() => {
    const roomW = GRID_COLS * TILE * EDITOR_SCALE;
    const roomH = GRID_ROWS * TILE * EDITOR_SCALE;
    const COLLISION_RES = 2; // 每个原始格子细分2倍检测精度
    const cCols = GRID_COLS * COLLISION_RES;
    const cRows = GRID_ROWS * COLLISION_RES;

    const build = async () => {
      const blocked = new Set<string>();
      for (const f of furniture) {
        if (!f.assetId) continue;
        const asset = assets.find(a => a.id === f.assetId);
        if (!asset) continue;
        // 地毯不参与碰撞
        if (asset.tags?.includes('rug')) continue;

        // 获取或缓存 ImageData
        let imgData = collisionMasksRef.current.get(asset.id);
        if (!imgData) {
          try {
            const img = await loadImage(asset.pixelImage);
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const ctx = c.getContext('2d')!;
            ctx.drawImage(img, 0, 0);
            imgData = ctx.getImageData(0, 0, c.width, c.height);
            collisionMasksRef.current.set(asset.id, imgData);
          } catch { continue; }
        }

        const furSize = Math.min(roomW, roomH) * 0.22 * f.scale;
        const centerX = (f.x / 100) * roomW;
        const centerY = (f.y / 100) * roomH;
        const left = centerX - furSize / 2;
        const top = centerY - furSize / 2;
        const cellW = roomW / cCols;
        const cellH = roomH / cRows;

        for (let gy = 0; gy < cRows; gy++) {
          for (let gx = 0; gx < cCols; gx++) {
            const px = (gx + 0.5) * cellW;
            const py = (gy + 0.5) * cellH;
            const lx = (px - left) / furSize;
            const ly = (py - top) / furSize;
            if (lx < 0 || lx >= 1 || ly < 0 || ly >= 1) continue;
            const sx = Math.floor(lx * imgData.width);
            const sy = Math.floor(ly * imgData.height);
            const alpha = imgData.data[(sy * imgData.width + sx) * 4 + 3];
            if (alpha > 128) blocked.add(`${gx},${gy}`);
          }
        }
      }
      collisionBlockedRef.current = blocked;

      // 安全转送：家具重排后，如果角色当前正好被压在家具底下（卡住），
      // 用 BFS 找最近的一个地面空格把它送过去，避免卡死。
      const cur = charPosRef.current;
      const cgxCur = Math.round((cur.x / 100) * GRID_COLS * COLLISION_RES);
      const cgyCur = Math.round((cur.y / 100) * GRID_ROWS * COLLISION_RES);
      if (blocked.has(`${cgxCur},${cgyCur}`)) {
        const floorMinY = Math.ceil(WALL_TOP_RATIO * 100 / GRID_STEP_Y) * GRID_STEP_Y;
        const floorMinCgy = Math.ceil((floorMinY / 100) * GRID_ROWS * COLLISION_RES);
        const maxCgy = GRID_ROWS * COLLISION_RES - 1;
        const maxCgx = GRID_COLS * COLLISION_RES - 1;
        const seen = new Set<string>([`${cgxCur},${cgyCur}`]);
        const queue: Array<[number, number]> = [[cgxCur, cgyCur]];
        let safe: [number, number] | null = null;
        while (queue.length) {
          const [gx, gy] = queue.shift()!;
          if (gy >= floorMinCgy && !blocked.has(`${gx},${gy}`)) { safe = [gx, gy]; break; }
          for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nx = gx + dx, ny = gy + dy;
            if (nx < 0 || nx > maxCgx || ny < 0 || ny > maxCgy) continue;
            const k = `${nx},${ny}`;
            if (seen.has(k)) continue;
            seen.add(k);
            queue.push([nx, ny]);
          }
        }
        if (safe) {
          const nx = (safe[0] / (GRID_COLS * COLLISION_RES)) * 100;
          const ny = (safe[1] / (GRID_ROWS * COLLISION_RES)) * 100;
          charPosRef.current = { x: nx, y: ny };
          charTargetRef.current = { x: nx, y: ny };
          setCharPos({ x: nx, y: ny });
        }
      }
    };
    build();
  }, [furniture, assets, GRID_COLS, GRID_ROWS, GRID_STEP_Y]);

  // 桌面端 wheel 缩放
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      setZoom(z => Math.max(0.5, Math.min(3, z + (e.deltaY > 0 ? -0.15 : 0.15))));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  // 移动端 pinch-to-zoom
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;

    const getDist = (t: TouchList) => {
      if (t.length < 2) return 0;
      const dx = t[0].clientX - t[1].clientX;
      const dy = t[0].clientY - t[1].clientY;
      return Math.hypot(dx, dy);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        // 双指 → 进入缩放，取消任何正在进行的拖拽
        if (draggingRef.current) {
          draggingRef.current = null;
          dragConfirmedRef.current = false;
        }
        touchStateRef.current = {
          active: true,
          initialDist: getDist(e.touches),
          initialZoom: zoom,
        };
        e.preventDefault();
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      const ts = touchStateRef.current;
      if (!ts.active || e.touches.length < 2) return;
      e.preventDefault();
      const dist = getDist(e.touches);
      if (ts.initialDist > 0) {
        const scale = dist / ts.initialDist;
        setZoom(Math.max(0.5, Math.min(3, ts.initialZoom * scale)));
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        touchStateRef.current.active = false;
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [zoom]);

  const saveLayout = useCallback((updatedFurniture: PlacedFurniture[], overrides?: Partial<PixelRoomLayout>) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await PixelLayoutDB.save({
        ...layout,
        furniture: updatedFurniture,
        wallColor,
        floorColor,
        wallFillMode,
        wallOffsetX,
        wallOffsetY,
        floorFillMode,
        floorOffsetX,
        floorOffsetY,
        ...overrides,
        lastUpdatedAt: Date.now(),
        lastDecoratedBy: 'user',
      });
      onUpdate();
    }, 500);
  }, [layout, wallColor, floorColor, wallFillMode, wallOffsetX, wallOffsetY, floorFillMode, floorOffsetX, floorOffsetY, onUpdate]);

  // 拖拽 → 格子吸附（带阈值防误触）
  const handlePointerDown = useCallback((e: React.PointerEvent, slotId: string) => {
    if (mode !== 'edit') return;
    // 双指操作中忽略
    if (touchStateRef.current.active) return;
    e.preventDefault(); e.stopPropagation();
    draggingRef.current = slotId;
    dragConfirmedRef.current = false; // 还没超过阈值
    const f = furniture.find(f => f.slotId === slotId);
    if (!f) return;
    dragStartRef.current = { x: e.clientX, y: e.clientY, fx: f.x, fy: f.y };
    setSelectedSlot(slotId);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [mode, furniture]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current || !stageRef.current) return;
    // 双指操作中取消拖拽
    if (touchStateRef.current.active) {
      draggingRef.current = null;
      dragConfirmedRef.current = false;
      return;
    }
    // 检查是否超过拖拽阈值
    if (!dragConfirmedRef.current) {
      const px = Math.abs(e.clientX - dragStartRef.current.x);
      const py = Math.abs(e.clientY - dragStartRef.current.y);
      if (px < DRAG_THRESHOLD && py < DRAG_THRESHOLD) return;
      dragConfirmedRef.current = true;
    }
    const rect = stageRef.current.getBoundingClientRect();
    const dx = ((e.clientX - dragStartRef.current.x) / (rect.width / zoom)) * 100;
    const dy = ((e.clientY - dragStartRef.current.y) / (rect.height / zoom)) * 100;
    const rawX = dragStartRef.current.fx + dx;
    const rawY = dragStartRef.current.fy + dy;
    const snapped = snapToGrid(GRID_COLS, GRID_ROWS, rawX, rawY);
    setFurniture(prev => prev.map(f =>
      f.slotId === draggingRef.current ? { ...f, ...snapped } : f
    ));
  }, [zoom]);

  const handlePointerUp = useCallback(() => {
    if (draggingRef.current) {
      if (dragConfirmedRef.current) {
        // 真正拖拽过 → 吸附保存
        setFurniture(prev => {
          const next = prev.map(f => {
            if (f.slotId === draggingRef.current) {
              const s = snapToGrid(GRID_COLS, GRID_ROWS, f.x, f.y);
              return { ...f, ...s };
            }
            return f;
          });
          saveLayout(next);
          return next;
        });
      }
      // 没超过阈值 = 只是点击选中，不移动家具
      draggingRef.current = null;
      dragConfirmedRef.current = false;
    }
  }, [saveLayout]);

  const updateFurniture = useCallback((slotId: string, updates: Partial<PlacedFurniture>) => {
    setFurniture(prev => {
      const next = prev.map(f => f.slotId === slotId ? { ...f, ...updates, placedBy: 'user' as const } : f);
      saveLayout(next);
      return next;
    });
  }, [saveLayout]);

  const deleteFurniture = useCallback(async (slotId: string) => {
    const target = furniture.find(f => f.slotId === slotId);
    const assetName = target?.assetId ? assets.find(a => a.id === target.assetId)?.name : '';
    const ok = await requestConfirm({
      title: assetName ? `删除「${assetName}」？` : '删除这件家具？',
      message: '将从当前房间移除这件自由放置的家具（仓库里的原素材会保留）。',
      confirmText: '确认删除',
      variant: 'danger',
    });
    if (!ok) return;
    setFurniture(prev => { const next = prev.filter(f => f.slotId !== slotId); saveLayout(next); return next; });
    setSelectedSlot(null);
    trackEvent('删除一件像素家具');
  }, [furniture, assets, saveLayout, requestConfirm]);

  const resetFurnitureSlot = useCallback(async (slotId: string) => {
    const slotName = slotDefs.find(s => s.id === slotId)?.name || '该槽位';
    const ok = await requestConfirm({
      title: `还原「${slotName}」？`,
      message: '将清空该默认槽位中放置的家具素材，恢复为空槽位。',
      confirmText: '确认还原',
      variant: 'warning',
    });
    if (!ok) return;
    updateFurniture(slotId, { assetId: null });
  }, [slotDefs, updateFurniture, requestConfirm]);

  /** 一键清空：移除所有用户自由放置家具 + 把默认槽位的素材都清空 */
  const clearAllFurniture = useCallback(async () => {
    const userCount = furniture.filter(f => f.isDefault === false).length;
    const filledDefaults = furniture.filter(f => f.isDefault !== false && f.assetId).length;
    const total = userCount + filledDefaults;
    if (total === 0) return;
    const ok = await requestConfirm({
      title: `清空房间里的 ${total} 件家具？`,
      message: `自由放置的 ${userCount} 件会被删除，默认槽位的 ${filledDefaults} 件会恢复为空，无法撤销。`,
      confirmText: '确认清空',
      variant: 'danger',
    });
    if (!ok) return;

    setFurniture(prev => {
      const next = prev
        .filter(f => f.isDefault !== false)        // 扔掉用户自由放置的
        .map(f => ({ ...f, assetId: null }));      // 默认槽位清空素材
      saveLayout(next);
      return next;
    });
    setSelectedSlot(null);
    trackEvent('清空像素房间的家具');
  }, [furniture, saveLayout, requestConfirm]);

  const getFurnitureImage = useCallback((f: PlacedFurniture): string | null => {
    if (f.assetId) {
      const asset = assets.find(a => a.id === f.assetId);
      if (asset) return asset.pixelImage;
    }
    // 无自定义素材时不显示默认家具
    return null;
  }, [assets]);

  // 墙纸/地砖上传 → 先预览，再确认
  const handleTextureUpload = useCallback(async (file: File, target: 'wall' | 'floor') => {
    try {
      const dataUri = await processImage(file, { maxWidth: 256, skipCompression: true });
      // 生成像素化版本
      const img = await loadImage(dataUri);
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = pixelizeImage(imageData, 32);
      const tileCanvas = document.createElement('canvas');
      tileCanvas.width = result.width * 2; tileCanvas.height = result.height * 2;
      const tCtx = tileCanvas.getContext('2d')!;
      tCtx.imageSmoothingEnabled = false;
      const smallCanvas = document.createElement('canvas');
      smallCanvas.width = result.width; smallCanvas.height = result.height;
      smallCanvas.getContext('2d')!.putImageData(result.imageData, 0, 0);
      tCtx.drawImage(smallCanvas, 0, 0, tileCanvas.width, tileCanvas.height);
      const pixelizedUri = tileCanvas.toDataURL('image/png');

      setTexturePreview({
        target,
        originalUri: dataUri,
        pixelizedUri,
        tileSize: target === 'floor' ? floorTileSize : TILE * 2,
        // 按当前房间的既有设置预填（同一面再传一张也能保留偏移）
        fillMode: target === 'wall' ? wallFillMode : floorFillMode,
        offsetX: target === 'wall' ? wallOffsetX : floorOffsetX,
        offsetY: target === 'wall' ? wallOffsetY : floorOffsetY,
      });
      setTextureUseOriginal(false);
    } catch (err) {
      console.error('Texture upload failed:', err);
    }
  }, []);

  // 确认应用纹理
  const applyTexture = useCallback(() => {
    if (!texturePreview) return;
    const tileUri = textureUseOriginal ? texturePreview.originalUri : texturePreview.pixelizedUri;
    if (texturePreview.target === 'wall') {
      setCustomWall(tileUri); setWallColor(tileUri);
      setWallFillMode(texturePreview.fillMode);
      setWallOffsetX(texturePreview.offsetX);
      setWallOffsetY(texturePreview.offsetY);
      saveLayout(furniture, {
        wallColor: tileUri,
        wallFillMode: texturePreview.fillMode,
        wallOffsetX: texturePreview.offsetX,
        wallOffsetY: texturePreview.offsetY,
      });
    } else {
      setCustomFloor(tileUri); setFloorColor(tileUri);
      setFloorTileSize(texturePreview.tileSize);
      setFloorFillMode(texturePreview.fillMode);
      setFloorOffsetX(texturePreview.offsetX);
      setFloorOffsetY(texturePreview.offsetY);
      saveLayout(furniture, {
        floorColor: tileUri,
        floorFillMode: texturePreview.fillMode,
        floorOffsetX: texturePreview.offsetX,
        floorOffsetY: texturePreview.offsetY,
      });
    }
    setTexturePreview(null);
    trackEvent('换上自定义墙纸或地砖', { target: texturePreview.target, fillMode: texturePreview.fillMode });
  }, [texturePreview, textureUseOriginal, furniture, saveLayout]);

  // 还原默认纹理
  const resetTexture = useCallback(async (target: 'wall' | 'floor') => {
    const label = target === 'wall' ? '墙纸' : '地砖';
    const ok = await requestConfirm({
      title: `移除当前自定义${label}？`,
      message: `将恢复${target === 'wall' ? '默认墙面' : '默认地板'}纹理。`,
      confirmText: '确认还原',
      variant: 'warning',
    });
    if (!ok) return;
    if (target === 'wall') {
      setCustomWall(null); setWallColor('');
      setWallFillMode('tile'); setWallOffsetX(50); setWallOffsetY(50);
      saveLayout(furniture, { wallColor: '', wallFillMode: 'tile', wallOffsetX: 50, wallOffsetY: 50 });
    } else {
      setCustomFloor(null); setFloorColor('');
      setFloorFillMode('tile'); setFloorOffsetX(50); setFloorOffsetY(50);
      saveLayout(furniture, { floorColor: '', floorFillMode: 'tile', floorOffsetX: 50, floorOffsetY: 50 });
    }
  }, [furniture, saveLayout, requestConfirm]);

  // 加载记忆
  const loadMemories = useCallback(async () => {
    setMemoryLoading(true);
    try {
      const nodes = await MemoryNodeDB.getByRoom(charId, roomId);
      nodes.sort((a, b) => b.importance - a.importance);
      setMemories(nodes.slice(0, 30));
    } catch (err) {
      console.error('Load memories failed:', err);
    }
    setMemoryLoading(false);
  }, [charId, roomId]);

  useEffect(() => { if (showMemory) loadMemories(); }, [showMemory, loadMemories]);

  const selectedFurniture = selectedSlot ? furniture.find(f => f.slotId === selectedSlot) : null;
  const selectedSlotDef = selectedSlot ? slotDefs.find(s => s.id === selectedSlot) : null;
  const roomPxW = GRID_COLS * TILE * EDITOR_SCALE;
  const roomPxH = GRID_ROWS * TILE * EDITOR_SCALE;
  const roomDisplayName = roomId === 'user_room' ? `${userName}的房` : meta.name;

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ backgroundColor: '#1a1410' }}>
      <div ref={outerRef} className="flex-1 overflow-hidden flex items-center justify-center"
        style={{ touchAction: 'none' }}
        onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerLeave={handlePointerUp}
        onClick={() => { if (!draggingRef.current) setSelectedSlot(null); }}>
        <div style={{ transform: `scale(${zoom})`, transformOrigin: 'center center', transition: touchStateRef.current.active ? 'none' : 'transform 0.1s ease-out' }}>
          <div ref={stageRef} className="relative select-none overflow-visible" style={{ width: roomPxW, height: roomPxH }}>
            {/* 墙壁外框 */}
            <div className="absolute rounded-sm" style={{ inset: -WALL_THICK, backgroundColor: WALL_COLOR }}>
              <div className="absolute inset-x-0 top-0 rounded-t-sm" style={{ height: 2, backgroundColor: WALL_LIGHT }} />
              <div className="absolute inset-y-0 left-0 rounded-l-sm" style={{ width: 2, backgroundColor: WALL_LIGHT }} />
            </div>

            {/* 墙面带 */}
            <div className="absolute inset-x-0 top-0 overflow-hidden" style={{ height: `${WALL_TOP_RATIO * 100}%` }}>
              {(() => {
                const d = decodeColorField(wallColor);
                if (d.kind === 'image') {
                  return (
                    <div className="absolute inset-0" style={
                      wallFillMode === 'stretch'
                        ? {
                            backgroundImage: `url(${d.value})`,
                            backgroundSize: 'cover',
                            backgroundRepeat: 'no-repeat',
                            backgroundPosition: `${wallOffsetX}% ${wallOffsetY}%`,
                            imageRendering: 'pixelated' as any,
                          }
                        : {
                            backgroundImage: `url(${d.value})`,
                            backgroundSize: `${TILE * 2}px ${TILE * 2}px`,
                            backgroundRepeat: 'repeat',
                            imageRendering: 'pixelated' as any,
                          }
                    } />
                  );
                }
                if (d.kind === 'color') {
                  // 纯色：叠一个轻微的砖纹让它不会完全死板
                  return (
                    <>
                      <div className="absolute inset-0" style={{ backgroundColor: d.value }} />
                      <div className="absolute inset-0" style={{
                        backgroundImage: `linear-gradient(rgba(0,0,0,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.06) 1px, transparent 1px)`,
                        backgroundSize: `${TILE * 2}px ${Math.round(TILE * 0.6)}px`,
                      }} />
                    </>
                  );
                }
                return (
                  <>
                    <div className="absolute inset-0" style={{ backgroundColor: floorStyle.wallFace }} />
                    <div className="absolute inset-0" style={{
                      backgroundImage: `linear-gradient(${floorStyle.wallFaceDark} 1px, transparent 1px), linear-gradient(90deg, ${floorStyle.wallFaceDark}40 1px, transparent 1px)`,
                      backgroundSize: `${TILE * 2}px ${Math.round(TILE * 0.6)}px`,
                    }} />
                  </>
                );
              })()}
              <div className="absolute inset-x-0 bottom-0 h-[3px]" style={{ background: `linear-gradient(to bottom, ${floorStyle.wallFaceDark}, ${floorStyle.base})` }} />
            </div>

            {/* 地板 */}
            <div className="absolute inset-x-0 bottom-0 overflow-hidden" style={{ top: `${WALL_TOP_RATIO * 100}%` }}>
              {(() => {
                const d = decodeColorField(floorColor);
                if (d.kind === 'image') {
                  return (
                    <div className="absolute inset-0" style={
                      floorFillMode === 'stretch'
                        ? {
                            backgroundImage: `url(${d.value})`,
                            backgroundSize: 'cover',
                            backgroundRepeat: 'no-repeat',
                            backgroundPosition: `${floorOffsetX}% ${floorOffsetY}%`,
                            imageRendering: 'pixelated' as any,
                          }
                        : {
                            backgroundImage: `url(${d.value})`,
                            backgroundSize: `${floorTileSize}px ${floorTileSize}px`,
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
                      <FloorTexture type={floorStyle.pattern} alt={floorStyle.alt} />
                    </>
                  );
                }
                return (
                  <>
                    <div className="absolute inset-0" style={{ backgroundColor: floorStyle.base }} />
                    <FloorTexture type={floorStyle.pattern} alt={floorStyle.alt} />
                  </>
                );
              })()}
            </div>

            {/* 格子网格：只有正在拖动 / 选中某件家具时才显示，避免平时看到满屏白十字 */}
            {mode === 'edit' && (selectedSlot || draggingRef.current) && (
              <>
                <div className="absolute inset-0 pointer-events-none z-10" style={{
                  backgroundImage: `linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)`,
                  backgroundSize: `${GRID_STEP_X / SNAP_SUBDIVISIONS}% ${GRID_STEP_Y / SNAP_SUBDIVISIONS}%`,
                }} />
                <div className="absolute inset-0 pointer-events-none z-10" style={{
                  backgroundImage: `linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)`,
                  backgroundSize: `${GRID_STEP_X}% ${GRID_STEP_Y}%`,
                }} />
              </>
            )}

            {/* 家具（仅有素材的），地毯在底层先渲染 */}
            {[...furniture].sort((a, b) => {
              // 地毯类在最底层
              const aRug = isRugAsset(a, assets);
              const bRug = isRugAsset(b, assets);
              if (aRug !== bRug) return aRug ? -1 : 1;
              return a.y - b.y; // 同层按 y 排序
            }).map(f => {
              const imgSrc = getFurnitureImage(f);
              if (!imgSrc) return null;
              const isSelected = selectedSlot === f.slotId;
              const furSize = Math.round(Math.min(roomPxW, roomPxH) * 0.22 * f.scale);
              const isRug = isRugAsset(f, assets);
              // 居中放置，大家具允许超出房间（不钳制）
              const posX = Math.round((f.x / 100) * roomPxW - furSize / 2);
              const posY = Math.round((f.y / 100) * roomPxH - furSize / 2);
              // z-index 按家具中心点 f.y 排（俯视视角里 y 越大越靠前）。
              // 之前用"视觉底边"(f.y + halfHPct) 排序，对挂在墙上的大件家具会严重虚高：
              // 它们的视觉底边会向下延伸、甚至超过角色脚下，z 就比角色还大——
              // 结果是墙上的烤箱/储物柜挡住了路过角色的头。回到中心点 y 更符合直觉。
              // "背后大家具应该压住前面小家具"的场景由用户手动"置顶"解决。
              //
              // 分桶策略（必须全部为正整数，否则负 z-index 会沉到墙壁/地板背后）：
              //   rug:   1
              //   back:  2..5          （比普通家具低，但仍在地板/墙之上）
              //   auto:  20..~420      （按中心 y 递增）
              //   front: 1000..~1400   （永远压住 auto 家具）
              //   selected: 2000       （操作焦点）
              const autoZ = Math.round(f.y * 4) + 20;
              let zIdx: number;
              if (isSelected) zIdx = 2000;
              else if (isRug) zIdx = 1;
              else if (f.zOrder === 'back') zIdx = 2 + Math.round(autoZ / 200); // 2..5
              else if (f.zOrder === 'front') zIdx = 1000 + autoZ;
              else zIdx = autoZ;
              return (
                <div key={f.slotId} style={{
                  position: 'absolute',
                  left: posX,
                  top: posY,
                  // 显式钉死容器宽度为整数像素（高度随图自适配，保留原有纵横比），
                  // 避免 img 默认 inline 的基线行间隙 + 亚像素舍入让"越往右看起来越大/越小"
                  width: furSize,
                  zIndex: zIdx,
                  cursor: mode === 'edit' ? 'grab' : 'default',
                  transition: draggingRef.current === f.slotId ? 'none' : 'left 0.15s, top 0.15s',
                  pointerEvents: mode === 'edit' ? 'auto' : 'none',
                }}
                  onClick={e => { e.stopPropagation(); }}
                  onPointerDown={e => {
                    if (touchStateRef.current.active) return;
                    handlePointerDown(e, f.slotId);
                  }}>
                  {isSelected && <div className="absolute -inset-1 rounded border-2 animate-pulse" style={{ borderColor: meta.color, boxShadow: `0 0 8px ${meta.color}80` }} />}
                  <img src={imgSrc} className="pointer-events-none" style={{
                    display: 'block',            // 去掉 inline baseline gap
                    width: '100%',
                    height: 'auto',              // 保留原图纵横比
                    imageRendering: 'pixelated',
                    transform: `rotate(${f.rotation}deg)`,
                  }} draggable={false} />
                </div>
              );
            })}

            {/* 角色小人（像素步行）
               z-index 和家具共享一套坐标：锚点是脚底（translate -100%），视觉底边 = charPos.y，
               所以直接用 Math.round(charPos.y * 4) + 20 和家具的 autoZ 保持同一尺度，
               否则家具的 autoZ（~20..420）永远远大于原来的 charPos.y+2，角色就会被压在家具底下。

               宽高显式钉死为整数像素（40×40），避免 inline img + h-auto 在不同 x 位置上
               因亚像素舍入让角色"走到右边变小"。 */}
            {charSprite && (
              <div className="absolute pointer-events-none" style={{
                left: `${charPos.x}%`, top: `${charPos.y}%`,
                width: 40,
                height: 40,
                transform: `translate(-50%, -100%) scaleX(${charFlip ? -1 : 1})`,
                zIndex: Math.round(charPos.y * 4) + 20,
              }}>
                <TokenImg value={charSprite} className="drop-shadow-md"
                  style={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    imageRendering: 'pixelated',
                    // 走路时左右脚交替倾斜 + 上下弹跳
                    transform: charWalking
                      ? `rotate(${charStep === 0 ? -3 : 3}deg) translateY(${charStep === 0 ? -1 : 0}px)`
                      : 'none',
                  }} draggable={false} />
                <div className="mx-auto rounded-full bg-black/20" style={{
                  width: charWalking ? 16 : 18,
                  height: 3,
                  transition: 'width 0.1s',
                }} />
              </div>
            )}

          </div>
        </div>
      </div>

      {/* 底部工具栏 */}
      <div
        className="shrink-0 bg-slate-800/95 backdrop-blur-sm border-t border-slate-700/50 px-3 pt-2 max-h-[50%] overflow-y-auto no-scrollbar"
        style={{ paddingBottom: 'calc(0.5rem + var(--safe-bottom, 0px))' }}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex gap-1">
            <ModeBtn label="浏览" active={mode === 'view'} onClick={() => { setMode('view'); setSelectedSlot(null); trackEvent('切换像素房间装修模式', { mode: 'view' }); }} />
            <ModeBtn label="编辑" active={mode === 'edit'} onClick={() => { setMode('edit'); trackEvent('切换像素房间装修模式', { mode: 'edit' }); }} />
            <ModeBtn label="记忆" active={showMemory} onClick={() => setShowMemory(!showMemory)} />
          </div>
          <div className="flex gap-1 flex-wrap justify-end items-center">
            <ToolBtn label="放家具" color="bg-green-700" onClick={() => onOpenLibrary('__add__')} />
            <ToolBtn label="墙纸" color="bg-violet-700" onClick={() => wallInputRef.current?.click()} />
            {/* 纯色墙：label 包 input[type=color] 做成按钮 */}
            {(() => {
              const d = decodeColorField(wallColor);
              const curColor = d.kind === 'color' ? d.value : floorStyle.wallFace;
              return (
                <label className="px-2 py-1.5 rounded-lg text-[10px] font-bold text-white bg-violet-800 active:scale-95 transition-transform cursor-pointer flex items-center gap-1">
                  <span>墙色</span>
                  <span className="w-3 h-3 rounded-sm border border-white/30" style={{ backgroundColor: curColor }} />
                  <input type="color" className="sr-only" value={curColor}
                    onChange={e => {
                      const v = e.target.value;
                      setCustomWall(null);
                      setWallColor(v);
                      saveLayout(furniture, { wallColor: v });
                    }} />
                </label>
              );
            })()}
            {customWall && <ToolBtn label="×墙" color="bg-violet-900" onClick={() => void resetTexture('wall')} />}
            <ToolBtn label="地砖" color="bg-amber-800" onClick={() => floorInputRef.current?.click()} />
            {(() => {
              const d = decodeColorField(floorColor);
              const curColor = d.kind === 'color' ? d.value : floorStyle.base;
              return (
                <label className="px-2 py-1.5 rounded-lg text-[10px] font-bold text-white bg-amber-900 active:scale-95 transition-transform cursor-pointer flex items-center gap-1">
                  <span>地色</span>
                  <span className="w-3 h-3 rounded-sm border border-white/30" style={{ backgroundColor: curColor }} />
                  <input type="color" className="sr-only" value={curColor}
                    onChange={e => {
                      const v = e.target.value;
                      setCustomFloor(null);
                      setFloorColor(v);
                      saveLayout(furniture, { floorColor: v });
                    }} />
                </label>
              );
            })()}
            {customFloor && <ToolBtn label="×地" color="bg-amber-950" onClick={() => void resetTexture('floor')} />}
            <ToolBtn label="清空" color="bg-red-700" onClick={() => void clearAllFurniture()} />
          </div>
        </div>

        {/* 隐藏文件输入 */}
        <input ref={wallInputRef} type="file" accept="image/*" className="hidden"
          onChange={e => { if (e.target.files?.[0]) { handleTextureUpload(e.target.files[0], 'wall'); e.target.value = ''; } }} />
        <input ref={floorInputRef} type="file" accept="image/*" className="hidden"
          onChange={e => { if (e.target.files?.[0]) { handleTextureUpload(e.target.files[0], 'floor'); e.target.value = ''; } }} />

        {/* 纹理预览面板 */}
        {texturePreview && (
          <div className="p-2.5 bg-slate-700/60 rounded-xl space-y-2 mb-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-200 font-bold">
                {texturePreview.target === 'wall' ? '墙纸预览' : '地砖预览'}
              </span>
              <button onClick={() => setTexturePreview(null)}
                className="text-[10px] text-slate-400 hover:text-red-400">取消</button>
            </div>
            <div className="flex gap-2">
              <div className="flex-1 text-center">
                <div className="aspect-square rounded border border-slate-600 overflow-hidden mb-1" style={{
                  backgroundImage: `url(${texturePreview.pixelizedUri})`,
                  backgroundSize: `${texturePreview.tileSize}px ${texturePreview.tileSize}px`, backgroundRepeat: 'repeat',
                  imageRendering: 'pixelated' as any,
                }} />
                <span className="text-[9px] text-slate-400">像素化</span>
              </div>
              <div className="flex-1 text-center">
                <div className="aspect-square rounded border border-slate-600 overflow-hidden mb-1" style={{
                  backgroundImage: `url(${texturePreview.originalUri})`,
                  backgroundSize: `${texturePreview.tileSize}px ${texturePreview.tileSize}px`, backgroundRepeat: 'repeat',
                  imageRendering: 'pixelated' as any,
                }} />
                <span className="text-[9px] text-slate-400">原图直接用</span>
              </div>
            </div>
            <div className="flex gap-1">
              <button onClick={() => setTextureUseOriginal(false)}
                className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold transition-all ${!textureUseOriginal ? 'bg-amber-500 text-white' : 'bg-slate-600 text-slate-300'}`}>
                像素化
              </button>
              <button onClick={() => setTextureUseOriginal(true)}
                className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold transition-all ${textureUseOriginal ? 'bg-emerald-500 text-white' : 'bg-slate-600 text-slate-300'}`}>
                直接用原图
              </button>
            </div>
            {/* 平铺 vs 拉伸 */}
            <div className="flex gap-1">
              <button onClick={() => setTexturePreview(prev => prev ? { ...prev, fillMode: 'tile' } : null)}
                className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold transition-all ${texturePreview.fillMode === 'tile' ? 'bg-sky-500 text-white' : 'bg-slate-600 text-slate-300'}`}>
                循环平铺
              </button>
              <button onClick={() => setTexturePreview(prev => prev ? { ...prev, fillMode: 'stretch' } : null)}
                className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold transition-all ${texturePreview.fillMode === 'stretch' ? 'bg-sky-500 text-white' : 'bg-slate-600 text-slate-300'}`}>
                整张铺满
              </button>
            </div>
            {/* 平铺模式：只有地板能调大小 */}
            {texturePreview.fillMode === 'tile' && texturePreview.target === 'floor' && (
              <SliderRow label="大小" min={16} max={128} step={4} value={texturePreview.tileSize}
                onChange={v => setTexturePreview(prev => prev ? { ...prev, tileSize: v } : null)}
                display={`${texturePreview.tileSize}px`} />
            )}
            {/* 拉伸模式：提供位置调整 */}
            {texturePreview.fillMode === 'stretch' && (
              <div className="space-y-1">
                <SliderRow label="水平" min={0} max={100} step={1} value={texturePreview.offsetX}
                  onChange={v => setTexturePreview(prev => prev ? { ...prev, offsetX: v } : null)}
                  display={`${texturePreview.offsetX}%`} />
                <SliderRow label="垂直" min={0} max={100} step={1} value={texturePreview.offsetY}
                  onChange={v => setTexturePreview(prev => prev ? { ...prev, offsetY: v } : null)}
                  display={`${texturePreview.offsetY}%`} />
              </div>
            )}
            <button onClick={applyTexture}
              className="w-full py-2 bg-amber-500 text-white text-xs font-bold rounded-lg active:scale-95">
              确认应用
            </button>
          </div>
        )}

        {/* 选中家具面板 */}
        {selectedFurniture && (
          <div className="p-2.5 bg-slate-700/60 rounded-xl space-y-2 mb-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-200 font-bold">
                {selectedSlotDef?.name || (selectedFurniture.assetId ? assets.find(a => a.id === selectedFurniture.assetId)?.name : '家具')}
              </span>
              {selectedSlotDef && <span className="text-[10px] text-slate-400 italic">{selectedSlotDef.category}</span>}
            </div>
            <SliderRow label="大小" min={0.3} max={10} step={0.1} value={selectedFurniture.scale}
              onChange={v => updateFurniture(selectedSlot!, { scale: v })} display={selectedFurniture.scale.toFixed(1)} />
            <SliderRow label="旋转" min={-180} max={180} step={15} value={selectedFurniture.rotation}
              onChange={v => updateFurniture(selectedSlot!, { rotation: v })} display={`${selectedFurniture.rotation}°`} />
            {/* 前后遮挡手动覆盖 */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-400 w-8">遮挡</span>
              <div className="flex-1 flex gap-1">
                <ZOrderBtn label="置底" active={selectedFurniture.zOrder === 'back'}
                  onClick={() => updateFurniture(selectedSlot!, { zOrder: selectedFurniture.zOrder === 'back' ? 'auto' : 'back' })} />
                <ZOrderBtn label="自动" active={!selectedFurniture.zOrder || selectedFurniture.zOrder === 'auto'}
                  onClick={() => updateFurniture(selectedSlot!, { zOrder: 'auto' })} />
                <ZOrderBtn label="置顶" active={selectedFurniture.zOrder === 'front'}
                  onClick={() => updateFurniture(selectedSlot!, { zOrder: selectedFurniture.zOrder === 'front' ? 'auto' : 'front' })} />
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => onOpenLibrary(selectedSlot)}
                className="flex-1 py-1.5 bg-amber-600 text-white text-[10px] font-bold rounded-lg active:scale-95">替换素材</button>
              {selectedFurniture.isDefault === false && (
                <button onClick={() => void deleteFurniture(selectedSlot!)}
                  className="px-3 py-1.5 bg-red-600 text-white text-[10px] font-bold rounded-lg active:scale-95">删除</button>
              )}
              {selectedFurniture.assetId && selectedFurniture.isDefault !== false && (
                <button onClick={() => void resetFurnitureSlot(selectedSlot!)}
                  className="px-3 py-1.5 bg-slate-600 text-slate-200 text-[10px] font-bold rounded-lg active:scale-95">还原</button>
              )}
            </div>
          </div>
        )}

        {/* 记忆空间面板 */}
        {showMemory && (
          <div className="p-2.5 bg-slate-900/80 rounded-xl border border-slate-700/50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold text-slate-300 uppercase tracking-widest">
                {roomDisplayName}的记忆 ({memories.length})
              </span>
              <button onClick={loadMemories} className="text-[9px] text-slate-400 hover:text-slate-200">刷新</button>
            </div>
            {memoryLoading ? (
              <div className="text-center py-4 text-slate-500 text-xs">加载中...</div>
            ) : memories.length === 0 ? (
              <div className="text-center py-4 text-slate-500 text-xs">暂无记忆</div>
            ) : (
              <div className="space-y-1 max-h-[200px] overflow-y-auto no-scrollbar">
                {memories.map(mem => {
                  const moodColor = MOOD_COLORS[mem.mood] || MOOD_COLORS.neutral;
                  const age = Math.round((Date.now() - mem.createdAt) / 86400000);
                  return (
                    <div key={mem.id} className="flex items-start gap-2 p-1.5 rounded-lg bg-slate-800/60 hover:bg-slate-700/60 transition-colors">
                      {/* 像素化重要度指示器 */}
                      <div className="shrink-0 flex flex-col items-center gap-0.5 mt-0.5">
                        <div className="flex gap-px">
                          {Array.from({ length: Math.min(5, Math.ceil(mem.importance / 2)) }).map((_, i) => (
                            <div key={i} className="w-1.5 h-1.5" style={{ backgroundColor: moodColor, imageRendering: 'pixelated' as any }} />
                          ))}
                        </div>
                        <span className="text-[7px] text-slate-500">{mem.importance}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] text-slate-300 leading-tight line-clamp-2">{mem.content}</p>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className="text-[8px] px-1 rounded" style={{ backgroundColor: moodColor + '30', color: moodColor }}>{mem.mood}</span>
                          {mem.tags.slice(0, 2).map(t => (
                            <span key={t} className="text-[8px] text-slate-500">#{t}</span>
                          ))}
                          <span className="text-[8px] text-slate-600 ml-auto">{age}天前</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ display: 'contents' }} onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>{confirmDialog}</div>
    </div>
  );
};

// 地板纹理
const FloorTexture: React.FC<{ type: string; alt: string }> = ({ type, alt }) => {
  if (type === 'wood') return <div className="absolute inset-0" style={{
    backgroundImage: `repeating-linear-gradient(90deg, ${alt} 0px, ${alt} 1px, transparent 1px, transparent ${TILE}px), repeating-linear-gradient(0deg, transparent 0px, transparent ${TILE - 1}px, ${alt}80 ${TILE - 1}px, ${alt}80 ${TILE}px)`,
  }} />;
  if (type === 'tile') return <div className="absolute inset-0" style={{
    backgroundImage: `linear-gradient(${alt} 1px, transparent 1px), linear-gradient(90deg, ${alt} 1px, transparent 1px)`,
    backgroundSize: `${TILE}px ${TILE}px`,
  }} />;
  return <div className="absolute inset-0" style={{
    backgroundImage: `linear-gradient(${alt} 1px, transparent 1px), linear-gradient(90deg, ${alt} 1px, transparent 1px)`,
    backgroundSize: `${Math.round(TILE * 1.5)}px ${TILE}px`,
  }} />;
};

const ModeBtn: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
  <button onClick={onClick} className={`px-2.5 py-1.5 rounded-lg text-[10px] font-bold transition-all ${active ? 'bg-amber-500 text-white' : 'bg-slate-700 text-slate-300'}`}>{label}</button>
);

const ToolBtn: React.FC<{ label: string; color: string; onClick: () => void }> = ({ label, color, onClick }) => (
  <button onClick={onClick} className={`px-2 py-1.5 rounded-lg text-[10px] font-bold text-white active:scale-95 transition-transform ${color}`}>{label}</button>
);

const ZOrderBtn: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
  <button onClick={onClick}
    className={`flex-1 py-1.5 rounded-lg text-[10px] font-bold transition-all ${active ? 'bg-amber-500 text-white' : 'bg-slate-600 text-slate-300'}`}>
    {label}
  </button>
);

const SliderRow: React.FC<{ label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; display: string }> = ({ label, min, max, step, value, onChange, display }) => (
  <div className="flex items-center gap-2">
    <span className="text-[10px] text-slate-400 w-8">{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value))} className="flex-1 h-1 accent-amber-500" />
    <span className="text-[10px] text-slate-400 w-8 text-right">{display}</span>
  </div>
);

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
}

export default PixelRoomEditor;
