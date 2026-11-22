import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    BankShopState, DollhouseState, DollhouseRoom, DollhouseSticker,
    ShopStaff, CharacterProfile, UserProfile, APIConfig, RoomLayout
} from '../../types';
import {
    ROOM_LAYOUTS, WALLPAPER_PRESETS, FLOOR_PRESETS, STICKER_LIBRARY, INITIAL_DOLLHOUSE
} from './BankGameConstants';
import BankAssetIcon, { isBankAssetUrl } from './BankAssetIcon';
import TokenImg from '../os/TokenImg';
import { isBlobRef } from '../../utils/blobRef';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { processImage } from '../../utils/file';
import { Armchair, PaintBucket, SquaresFour, Image as ImageIcon, HouseSimple, PencilSimple } from '@phosphor-icons/react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

const ROOM_UNLOCK_COSTS: Record<string, number> = {
    'room-1f-left': 0,
    'room-1f-right': 120,
    'room-2f-left': 200,
    'room-2f-right': 300,
};

const MAIN_ROOM_ID = 'room-1f-left';
const FLOOR_H_RATIO = 0.24;
const WALL_H_RATIO = 0.76;
const CUSTOM_FURNITURE_ASSET_KEY = 'bank_custom_furniture_assets_v1';

type DecorTab = 'layout' | 'rename' | 'wallpaper' | 'furniture' | 'floor' | 'roomTexture';

const DECOR_TAB_ICONS: Record<DecorTab, PhosphorIcon> = {
    furniture: Armchair,
    wallpaper: PaintBucket,
    floor: SquaresFour,
    roomTexture: ImageIcon,
    layout: HouseSimple,
    rename: PencilSimple,
};

const DECOR_TABS: { id: DecorTab; label: string }[] = [
    { id: 'furniture', label: '家具' },
    { id: 'wallpaper', label: '墙纸' },
    { id: 'floor', label: '地板' },
    { id: 'roomTexture', label: '全屋贴图' },
    { id: 'layout', label: '房型' },
    { id: 'rename', label: '改名' },
];

interface CustomFurnitureAsset {
    id: string;
    name: string;
    url: string;
}

interface Props {
    shopState: BankShopState;
    dollhouseState: DollhouseState;
    onDollhouseChange: (updater: DollhouseState | ((prev: DollhouseState) => DollhouseState)) => Promise<void>;
    characters: CharacterProfile[];
    userProfile: UserProfile;
    apiConfig: APIConfig;
    updateState: (updater: (prev: BankShopState) => BankShopState) => Promise<void>;
    onStaffClick?: (staff: ShopStaff) => void;
    onOpenGuestbook: () => void;
}

const BankDollhouse: React.FC<Props> = ({
    shopState, dollhouseState, onDollhouseChange, characters, updateState, onStaffClick, onOpenGuestbook
}) => {
    const { addToast } = useOS();
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
    const [showUnlockConfirm, setShowUnlockConfirm] = useState<string | null>(null);
    const [renameTarget, setRenameTarget] = useState<DollhouseRoom | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [showDecorPanel, setShowDecorPanel] = useState(false);
    const [decorTab, setDecorTab] = useState<DecorTab>('furniture');
    const [editMode, setEditMode] = useState(false);
    const [draggingActorId, setDraggingActorId] = useState<string | null>(null);
    const [actorPositions, setActorPositions] = useState<Record<string, { x: number; y: number }>>({});

    const longPressTimerRef = useRef<number | null>(null);
    const dragStateRef = useRef<{ actorId: string; roomId: string; isVisitor: boolean } | null>(null);
    const suppressActorClickRef = useRef(false);
    const actorMovedRef = useRef(false);
    const suppressNextStaffOpenRef = useRef(false);

    const [customAssets, setCustomAssets] = useState<CustomFurnitureAsset[]>([]);
    const [showAssetModal, setShowAssetModal] = useState(false);
    const [assetName, setAssetName] = useState('');
    const [assetUrl, setAssetUrl] = useState('');
    const [assetUploadedData, setAssetUploadedData] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [showTextureModal, setShowTextureModal] = useState(false);
    const [textureTarget, setTextureTarget] = useState<'room' | 'wallpaper' | 'floor'>('room');
    const [textureUrl, setTextureUrl] = useState('');        // preview (low-res or external URL)
    const textureFullRef = useRef<string>('');               // full-res base64 for saving
    const [textureScale, setTextureScale] = useState(1);
    const textureInputRef = useRef<HTMLInputElement>(null);

    // Sticker drag state
    const [draggingStickerInfo, setDraggingStickerInfo] = useState<{ stickerId: string; roomId: string; surface: string } | null>(null);
    const stickerLongPressRef = useRef<number | null>(null);
    // Local sticker positions during drag (avoids rapid DB writes)
    const [localStickerPos, setLocalStickerPos] = useState<Record<string, { x: number; y: number }>>({});
    // Trash zone hover during sticker drag
    const [overTrash, setOverTrash] = useState(false);
    const trashRef = useRef<HTMLDivElement>(null);

    // --- Local scale for debounced slider ---
    const [localRoomScale, setLocalRoomScale] = useState<number | null>(null);

    // Convert base64 room textures to stable Blob URLs to prevent flickering on re-render.
    // When the parent re-renders (e.g. actor idle movement every 3.2s), a base64 src forces
    // the browser to re-decode the image, causing white flashes. Blob URLs are short stable
    // references that the browser caches the decoded bitmap for.
    const textureBlobUrls = useRef<Record<string, string>>({});
    const getStableSrc = useCallback((raw?: string): string | undefined => {
        if (!raw?.trim()) return undefined;
        const val = raw.trim();
        // Only convert data: URIs; external URLs are already stable
        if (!val.startsWith('data:')) return val;
        // Re-use existing blob URL for the same base64 source
        if (textureBlobUrls.current[val]) return textureBlobUrls.current[val];
        try {
            const [header, b64] = val.split(',');
            const mime = header.match(/data:([^;]+)/)?.[1] || 'image/png';
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const url = URL.createObjectURL(new Blob([arr], { type: mime }));
            textureBlobUrls.current[val] = url;
            return url;
        } catch { return val; }
    }, []);
    // Clean up blob URLs on unmount
    useEffect(() => {
        return () => {
            Object.values(textureBlobUrls.current).forEach(u => URL.revokeObjectURL(u));
        };
    }, []);
    // --- Furniture placement mode ---
    const [placingFurniture, setPlacingFurniture] = useState<{ url: string; surface: 'floor' | 'leftWall'; name: string; isEmoji: boolean } | null>(null);
    const [furniturePreviewPos, setFurniturePreviewPos] = useState({ x: 50, y: 50 });

    const dh = dollhouseState;

    const clampActorPos = (x: number, y: number) => ({
        x: Math.max(8, Math.min(92, x)),
        y: Math.max(56, Math.min(92, y)),
    });

    // Save dollhouse directly to its own DB record (same pattern as RoomApp's saveRoom)
    const saveDollhouse = async (updater: DollhouseState | ((prev: DollhouseState) => DollhouseState)) => {
        await onDollhouseChange(updater);
    };

    useEffect(() => {
        const loadAssets = async () => {
            try {
                const fromDb = await DB.getAsset(CUSTOM_FURNITURE_ASSET_KEY);
                if (fromDb) {
                    const parsed = JSON.parse(fromDb);
                    if (Array.isArray(parsed)) {
                        setCustomAssets(parsed);
                        return;
                    }
                }
                const legacy = localStorage.getItem(CUSTOM_FURNITURE_ASSET_KEY);
                if (!legacy) return;
                const parsed = JSON.parse(legacy);
                if (Array.isArray(parsed)) {
                    setCustomAssets(parsed);
                    await DB.saveAsset(CUSTOM_FURNITURE_ASSET_KEY, JSON.stringify(parsed));
                    localStorage.removeItem(CUSTOM_FURNITURE_ASSET_KEY);
                }
            } catch {
                setCustomAssets([]);
            }
        };
        loadAssets();
    }, []);

    // Migration: resolve any legacy bank-asset:// references to direct URLs on first load
    useEffect(() => {
        const migrateRefs = async () => {
            const roomsWithRefs = dh.rooms.filter(r => r.roomTextureUrl?.startsWith('bank-asset://'));
            if (roomsWithRefs.length === 0) return;

            let updated = false;
            const newRooms = await Promise.all(dh.rooms.map(async (r) => {
                if (!r.roomTextureUrl?.startsWith('bank-asset://')) return r;
                const key = r.roomTextureUrl.replace('bank-asset://', '');
                try {
                    const raw = await DB.getAssetRaw(key);
                    if (raw instanceof Blob) {
                        // Convert Blob to base64 (same as RoomApp stores images)
                        const base64 = await new Promise<string>((resolve) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result as string);
                            reader.readAsDataURL(raw);
                        });
                        updated = true;
                        return { ...r, roomTextureUrl: base64 };
                    }
                } catch { /* ignore migration errors */ }
                // If can't resolve, clear the broken reference
                updated = true;
                return { ...r, roomTextureUrl: undefined };
            }));

            if (updated) {
                await saveDollhouse(prev => ({ ...prev, rooms: newRooms }));
            }
        };
        migrateRefs();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const mainRoom = dh.rooms.find(r => r.id === MAIN_ROOM_ID);
        if (!mainRoom || shopState.staff.length === 0) return;

        const mainHasStaff = mainRoom.staffIds.length > 0;
        const staffIdsInAnyRoom = dh.rooms.flatMap(r => r.staffIds);
        const missingStaff = shopState.staff.filter(s => !staffIdsInAnyRoom.includes(s.id)).map(s => s.id);

        if (mainHasStaff && missingStaff.length === 0) return;

        const allStaffIds = shopState.staff.map(s => s.id);
        const newRooms = dh.rooms.map(r => (
            r.id === MAIN_ROOM_ID
                ? { ...r, staffIds: Array.from(new Set([...allStaffIds, ...r.staffIds])) }
                : { ...r, staffIds: r.staffIds.filter(id => !allStaffIds.includes(id)) }
        ));
        saveDollhouse(prev => ({ ...prev, rooms: newRooms }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shopState.staff.length]);

    const normalizedRooms = useMemo(() => dh.rooms.map(room => (
        room.id === MAIN_ROOM_ID ? { ...room, name: '咖啡店' } : room
    )), [dh.rooms]);

    const roomOrder = ['room-2f-left', 'room-1f-left', 'room-1f-right', 'room-2f-right'];
    const orderedRooms = roomOrder
        .map(id => normalizedRooms.find(r => r.id === id))
        .filter((room): room is DollhouseRoom => Boolean(room));

    const [activeRoomId, setActiveRoomId] = useState<string>(MAIN_ROOM_ID);
    const activeRoom = orderedRooms.find(r => r.id === activeRoomId) || orderedRooms[0];
    const activeRoomIndex = orderedRooms.findIndex(r => r.id === activeRoom.id);

    useEffect(() => {
        const next: Record<string, { x: number; y: number }> = {};
        shopState.staff.forEach(staff => {
            next[staff.id] = clampActorPos(staff.x ?? 50, staff.y ?? 74);
        });
        if (shopState.activeVisitor?.charId) {
            next[shopState.activeVisitor.charId] = clampActorPos(shopState.activeVisitor.x ?? 55, shopState.activeVisitor.y ?? 76);
        }
        setActorPositions(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shopState.staff, shopState.activeVisitor?.charId, shopState.activeVisitor?.x, shopState.activeVisitor?.y]);

    useEffect(() => {
        const timer = window.setInterval(() => {
            if (dragStateRef.current) return;
            setActorPositions(prev => {
                const updated: Record<string, { x: number; y: number }> = { ...prev };
                Object.entries(prev).forEach(([id, pos]) => {
                    if (Math.random() > 0.4) return;
                    const dx = (Math.random() - 0.5) * 3;
                    const dy = (Math.random() - 0.5) * 1.8;
                    updated[id] = clampActorPos(pos.x + dx, pos.y + dy);
                });
                return updated;
            });
        }, 3200);

        return () => {
            window.clearInterval(timer);
            cancelLongPress();
            cancelStickerLongPress();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const getLayout = (layoutId: string): RoomLayout | undefined => ROOM_LAYOUTS.find(l => l.id === layoutId);

    const handleUnlockRoom = async (roomId: string) => {
        const cost = ROOM_UNLOCK_COSTS[roomId] || 150;
        if (shopState.actionPoints < cost) {
            addToast(`AP 不足 (需 ${cost})`, 'error');
            return;
        }
        // Save dollhouse changes separately from AP deduction
        await saveDollhouse(prev => ({
            ...prev,
            rooms: prev.rooms.map(r =>
                r.id === roomId ? {
                    ...r,
                    isUnlocked: true,
                    wallpaperLeft: 'linear-gradient(180deg, #FEF9F0, #F5EBD8)',
                    wallpaperRight: 'linear-gradient(180deg, #FEF9F0, #F5EBD8)',
                    floorStyle: 'linear-gradient(135deg, #C4A77D, #B8956E)',
                } : r
            )
        }));
        await updateState(prev => ({
            ...prev,
            actionPoints: prev.actionPoints - cost,
        }));
        setShowUnlockConfirm(null);
        addToast(`房间已解锁！-${cost} AP`, 'success');
    };

    const handleRenameRoom = (room: DollhouseRoom) => {
        if (room.id === MAIN_ROOM_ID) {
            addToast('初始房间固定为「咖啡店」', 'error');
            return;
        }
        setRenameValue(room.name);
        setRenameTarget(room);
    };

    const confirmRenameRoom = async () => {
        if (!renameTarget) return;
        const name = renameValue.trim().slice(0, 10);
        if (!name) return;
        await saveDollhouse(prev => ({
            ...prev,
            rooms: prev.rooms.map(r => r.id === renameTarget.id ? { ...r, name } : r)
        }));
        setRenameTarget(null);
        addToast('房间名已更新', 'success');
    };

    const persistActorPosition = async (actorId: string, x: number, y: number, isVisitor: boolean) => {
        const next = clampActorPos(x, y);
        if (isVisitor) {
            if (!shopState.activeVisitor || shopState.activeVisitor.charId !== actorId) return;
            await updateState(prev => ({
                ...prev,
                activeVisitor: prev.activeVisitor ? { ...prev.activeVisitor, x: next.x, y: next.y } : prev.activeVisitor,
            }));
            return;
        }
        await updateState(prev => ({
            ...prev,
            staff: prev.staff.map(s => s.id === actorId ? { ...s, x: next.x, y: next.y } : s)
        }));
    };

    const cancelLongPress = () => {
        if (longPressTimerRef.current !== null) {
            window.clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    };

    const handleActorPressStart = (actorId: string, roomId: string, isVisitor: boolean) => {
        cancelLongPress();
        actorMovedRef.current = false;
        longPressTimerRef.current = window.setTimeout(() => {
            dragStateRef.current = { actorId, roomId, isVisitor };
            setDraggingActorId(actorId);
            suppressActorClickRef.current = true;
        }, 220);
    };

    const handleRoomPointerMove = (roomId: string, e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragStateRef.current;
        if (!drag || drag.roomId !== roomId) return;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const xPct = ((e.clientX - rect.left) / rect.width) * 100;
        const yPct = ((e.clientY - rect.top) / rect.height) * 100;
        const next = clampActorPos(xPct, yPct);
        actorMovedRef.current = true;
        setActorPositions(prev => ({ ...prev, [drag.actorId]: next }));
    };

    const handleRoomPointerUp = async (): Promise<boolean> => {
        cancelLongPress();
        const drag = dragStateRef.current;
        if (!drag) {
            const moved = actorMovedRef.current;
            actorMovedRef.current = false;
            suppressActorClickRef.current = false;
            return moved;
        }

        const moved = actorMovedRef.current;
        const pos = actorPositions[drag.actorId];
        if (pos) {
            await persistActorPosition(drag.actorId, pos.x, pos.y, drag.isVisitor);
        }
        dragStateRef.current = null;
        setDraggingActorId(null);
        actorMovedRef.current = false;
        window.setTimeout(() => { suppressActorClickRef.current = false; }, 120);
        return moved;
    };

    const handleSetWallpaper = async (roomId: string, style: string) => {
        await saveDollhouse(prev => ({
            ...prev,
            rooms: prev.rooms.map(r => r.id === roomId ? { ...r, wallpaperLeft: style, wallpaperRight: style } : r)
        }));
        addToast('墙纸已更换', 'success');
    };

    const handleSetFloor = async (roomId: string, style: string) => {
        await saveDollhouse(prev => ({
            ...prev,
            rooms: prev.rooms.map(r => r.id === roomId ? { ...r, floorStyle: style } : r)
        }));
        addToast('地板已更换', 'success');
    };

    const handleAddFurniture = async (roomId: string, stickerUrl: string, surface: 'floor' | 'leftWall', pos?: { x: number; y: number }) => {
        const newSticker: DollhouseSticker = {
            id: `stk-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            url: stickerUrl,
            x: pos?.x ?? 50,
            y: pos?.y ?? (surface === 'leftWall' ? 45 : 55),
            scale: 1,
            rotation: 0,
            zIndex: 10,
            surface,
        };
        await saveDollhouse(prev => ({
            ...prev,
            rooms: prev.rooms.map(r => r.id === roomId ? { ...r, stickers: [...r.stickers, newSticker] } : r)
        }));
        addToast('已放置家具', 'success');
    };

    const handleDeleteSticker = async (roomId: string, stickerId: string) => {
        await saveDollhouse(prev => ({
            ...prev,
            rooms: prev.rooms.map(r => r.id === roomId ? { ...r, stickers: r.stickers.filter(s => s.id !== stickerId) } : r)
        }));
    };

    const cancelStickerLongPress = () => {
        if (stickerLongPressRef.current !== null) {
            window.clearTimeout(stickerLongPressRef.current);
            stickerLongPressRef.current = null;
        }
    };

    const handleStickerPressStart = (stickerId: string, roomId: string, surface: string) => {
        cancelStickerLongPress();
        stickerLongPressRef.current = window.setTimeout(() => {
            setDraggingStickerInfo({ stickerId, roomId, surface });
        }, 280);
    };

    const handleStickerPointerMove = (roomId: string, surface: 'floor' | 'leftWall' | 'rightWall', e: React.PointerEvent<HTMLDivElement>) => {
        if (!draggingStickerInfo || draggingStickerInfo.roomId !== roomId) return;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const xPct = ((e.clientX - rect.left) / rect.width) * 100;
        const yPct = ((e.clientY - rect.top) / rect.height) * 100;
        const clampedX = Math.max(5, Math.min(95, xPct));
        const clampedY = Math.max(5, Math.min(95, yPct));

        // Only update local visual state during drag (no DB writes)
        setLocalStickerPos(prev => ({ ...prev, [draggingStickerInfo.stickerId]: { x: clampedX, y: clampedY } }));

        // Check if pointer is over trash zone
        if (editMode && trashRef.current) {
            const trashRect = trashRef.current.getBoundingClientRect();
            const isOver = e.clientX >= trashRect.left && e.clientX <= trashRect.right && e.clientY >= trashRect.top && e.clientY <= trashRect.bottom;
            setOverTrash(isOver);
        }
    };

    const handleStickerPointerUp = async (e?: React.PointerEvent | PointerEvent) => {
        cancelStickerLongPress();
        if (draggingStickerInfo) {
            // Check if dropped on trash zone
            let droppedOnTrash = overTrash;
            if (!droppedOnTrash && e && trashRef.current) {
                const rect = trashRef.current.getBoundingClientRect();
                droppedOnTrash = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
            }
            if (droppedOnTrash && editMode) {
                await handleDeleteSticker(draggingStickerInfo.roomId, draggingStickerInfo.stickerId);
                addToast('家具已删除', 'success');
            } else {
                // Persist final position to DB on pointer up
                const pos = localStickerPos[draggingStickerInfo.stickerId];
                if (pos) {
                    await saveDollhouse(prev => ({
                        ...prev,
                        rooms: prev.rooms.map(r => {
                            if (r.id !== draggingStickerInfo.roomId) return r;
                            return {
                                ...r,
                                stickers: r.stickers.map(s =>
                                    s.id === draggingStickerInfo.stickerId ? { ...s, x: pos.x, y: pos.y } : s
                                )
                            };
                        })
                    }));
                }
            }
            setLocalStickerPos(prev => {
                const next = { ...prev };
                delete next[draggingStickerInfo.stickerId];
                return next;
            });
            setOverTrash(false);
            setDraggingStickerInfo(null);
        }
    };

    const handleStickerScaleChange = async (roomId: string, stickerId: string, delta: number) => {
        await saveDollhouse(prev => ({
            ...prev,
            rooms: prev.rooms.map(r => r.id === roomId ? {
                ...r,
                stickers: r.stickers.map(s =>
                    s.id === stickerId ? { ...s, scale: Math.max(0.3, Math.min(3, s.scale + delta)) } : s
                )
            } : r)
        }));
    };

    const handleStaffScaleChange = async (staffId: string, delta: number) => {
        await updateState(prev => ({
            ...prev,
            staff: prev.staff.map(s =>
                s.id === staffId ? { ...s, scale: Math.max(0.4, Math.min(4, (s.scale ?? 1) + delta)) } : s
            )
        }));
    };

    const handleVisitorScaleChange = async (delta: number) => {
        await updateState(prev => {
            if (!prev.activeVisitor) return prev;
            const nextScale = Math.max(0.4, Math.min(4, (prev.activeVisitor.scale ?? 4) + delta));
            return {
                ...prev,
                activeVisitor: { ...prev.activeVisitor, scale: nextScale },
            };
        });
    };


    const handleChangeLayout = async (roomId: string, layoutId: string) => {
        const layout = getLayout(layoutId);
        if (!layout) return;
        if (layout.apCost > 0 && shopState.actionPoints < layout.apCost) {
            addToast(`AP 不足 (需 ${layout.apCost})`, 'error');
            return;
        }
        // Save dollhouse changes separately from AP deduction
        await saveDollhouse(prev => ({
            ...prev,
            rooms: prev.rooms.map(r => r.id === roomId ? { ...r, layoutId } : r)
        }));
        if (layout.apCost > 0) {
            await updateState(prev => ({
                ...prev,
                actionPoints: prev.actionPoints - layout.apCost,
            }));
        }
        addToast('房型已更换！', 'success');
    };

    const goPrevRoom = () => {
        const prev = activeRoomIndex <= 0 ? orderedRooms.length - 1 : activeRoomIndex - 1;
        setActiveRoomId(orderedRooms[prev].id);
    };

    const goNextRoom = () => {
        const next = activeRoomIndex >= orderedRooms.length - 1 ? 0 : activeRoomIndex + 1;
        setActiveRoomId(orderedRooms[next].id);
    };

    const toCssBackground = (value?: string, fallback?: string) => {
        const source = (value || fallback || '').trim();
        if (!source) return fallback || 'transparent';
        if (/gradient\(|^#|^rgb\(|^hsl\(/i.test(source)) return source;
        // Convert base64 to stable blob URL to prevent flicker on re-render
        const stableSrc = getStableSrc(source) || source;
        return `url("${stableSrc}") center / cover no-repeat`;
    };

    const openTextureModal = (target: 'room' | 'wallpaper' | 'floor') => {
        setTextureTarget(target);
        setTextureUrl('');
        textureFullRef.current = '';
        setTextureScale(1);
        setShowTextureModal(true);
    };

    // Upload: high-res for saving, low-res for modal preview
    const handleTextureUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        try {
            const [full, preview] = await Promise.all([
                processImage(file, { maxWidth: 1200, quality: 0.85 }),
                processImage(file, { maxWidth: 400, quality: 0.6 }),
            ]);
            textureFullRef.current = full;
            setTextureUrl(preview);
            addToast('图片已载入', 'success');
        } catch {
            addToast('图片读取失败', 'error');
        }
    };

    const handleSaveCustomTexture = async () => {
        if (!textureUrl.trim()) {
            addToast('请填写图床 URL 或上传本地图片', 'error');
            return;
        }
        // Use full-res image if available (local upload), otherwise use the URL as-is
        const url = (textureFullRef.current || textureUrl).trim();
        if (textureTarget === 'room') {
            // Store base64 or URL directly in dollhouse state (same as RoomApp's roomConfig)
            await saveDollhouse(prev => ({
                ...prev,
                rooms: prev.rooms.map(r => r.id === activeRoom.id ? { ...r, roomTextureUrl: url, roomTextureScale: textureScale } : r)
            }));
            addToast('全屋贴图已更新', 'success');
        } else if (textureTarget === 'wallpaper') {
            await handleSetWallpaper(activeRoom.id, url);
        } else {
            await handleSetFloor(activeRoom.id, url);
        }
        textureFullRef.current = '';
        setShowTextureModal(false);
    };

    const persistCustomAssets = async (nextAssets: CustomFurnitureAsset[]) => {
        setCustomAssets(nextAssets);
        await DB.saveAsset(CUSTOM_FURNITURE_ASSET_KEY, JSON.stringify(nextAssets));
    };

    const handleAddCustomAsset = async () => {
        const finalAssetUrl = assetUrl.trim() || assetUploadedData;
        if (!assetName.trim() || !finalAssetUrl) {
            addToast('请填写家具名称并提供图片（URL 或本地上传）', 'error');
            return;
        }
        const next = [...customAssets, { id: `custom-${Date.now()}`, name: assetName.trim(), url: finalAssetUrl }];
        await persistCustomAssets(next);
        setAssetName('');
        setAssetUrl('');
        setAssetUploadedData('');
        setShowAssetModal(false);
        addToast('自定义家具已保存', 'success');
    };

    const handleDeleteCustomAsset = async (id: string) => {
        const asset = customAssets.find(a => a.id === id);
        const confirmed = await requestConfirm({
            title: '删除自定义家具？',
            message: asset ? `确定删除「${asset.name}」吗？（已摆进房间的不会消失）` : '确定删除这个自定义家具吗？',
            confirmText: '删除',
            variant: 'danger',
        });
        if (!confirmed) return;
        await persistCustomAssets(customAssets.filter(a => a.id !== id));
        addToast('已删除自定义家具', 'success');
    };

    const handleUploadCustomAsset = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        try {
            const base64 = await processImage(file, { maxWidth: 400, quality: 0.85 });
            setAssetUploadedData(base64);
            addToast('本地图片已载入（不会自动改写 URL 输入框）', 'success');
        } catch {
            addToast('图片读取失败', 'error');
        }
    };

    // --- NEW: Debounced scale save ---
    const handleScaleSliderChange = useCallback((value: number) => {
        setLocalRoomScale(value);
    }, []);

    const handleScaleSliderCommit = useCallback(async () => {
        if (localRoomScale === null) return;
        await saveDollhouse(prev => ({
            ...prev,
            rooms: prev.rooms.map(r => r.id === activeRoom.id ? { ...r, roomTextureScale: localRoomScale } : r)
        }));
        setLocalRoomScale(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [localRoomScale, activeRoom.id]);

    // Enter furniture placement mode - surface auto-detected from click position
    const startPlacingFurniture = (url: string, surface: 'floor' | 'leftWall', name: string) => {
        const isEmoji = !isBankAssetUrl(url);
        setPlacingFurniture({ url, surface, name, isEmoji });
        setFurniturePreviewPos({ x: 50, y: 50 });
        setShowDecorPanel(false);
    };

    const handlePlacementPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!placingFurniture) return;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const xPct = ((e.clientX - rect.left) / rect.width) * 100;
        const yPct = ((e.clientY - rect.top) / rect.height) * 100;
        setFurniturePreviewPos({
            x: Math.max(5, Math.min(95, xPct)),
            y: Math.max(5, Math.min(95, yPct)),
        });
    };

    const handlePlacementConfirm = async () => {
        if (!placingFurniture) return;
        // Auto-detect surface from click Y position: top 76% = wall, bottom 24% = floor
        const surface = furniturePreviewPos.y < (WALL_H_RATIO * 100) ? 'leftWall' as const : 'floor' as const;
        // Remap position to be relative within the surface area
        const adjustedPos = surface === 'leftWall'
            ? { x: furniturePreviewPos.x, y: (furniturePreviewPos.y / (WALL_H_RATIO * 100)) * 100 }
            : { x: furniturePreviewPos.x, y: ((furniturePreviewPos.y - WALL_H_RATIO * 100) / (FLOOR_H_RATIO * 100)) * 100 };
        await handleAddFurniture(activeRoom.id, placingFurniture.url, surface, adjustedPos);
        setPlacingFurniture(null);
    };

    // Effective scale (use local slider value if dragging, else persisted)
    const getEffectiveScale = (room: DollhouseRoom) => {
        if (localRoomScale !== null && room.id === activeRoom.id) return localRoomScale;
        return room.roomTextureScale ?? 1;
    };

    // Resolve texture URL via stable blob reference (prevents flickering)
    const resolveTextureUrl = getStableSrc;

    const renderArrowButton = (direction: 'left' | 'right', onClick: () => void) => (
        <button
            onClick={onClick}
            className="w-10 h-10 rounded-full bg-white/80 border border-[#E8D5C4] shadow-sm flex items-center justify-center active:scale-90 transition-all"
            aria-label={direction === 'left' ? '上一房间' : '下一房间'}
        >
            <svg viewBox="0 0 24 24" className="w-4 h-4 text-[#8B5E43]" fill="none" stroke="currentColor" strokeWidth="2.5">
                {direction === 'left'
                    ? <path strokeLinecap="round" strokeLinejoin="round" d="M15 4 7 12l8 8" />
                    : <path strokeLinecap="round" strokeLinejoin="round" d="m9 4 8 8-8 8" />}
            </svg>
        </button>
    );

    const renderRoom = (room: DollhouseRoom) => {
        const locked = !room.isUnlocked;
        const wallBg = toCssBackground(room.wallpaperLeft || room.wallpaperRight, 'linear-gradient(180deg, #FFF5E9, #FDE5D8)');
        const floorBg = toCssBackground(room.floorStyle, 'linear-gradient(135deg, #D6B48C, #C69767)');
        const roomTexture = resolveTextureUrl(room.roomTextureUrl);
        const roomTextureScale = Math.max(0.5, Math.min(2.5, getEffectiveScale(room)));

        const roomStaff = shopState.staff.filter(s => {
            const targetRoom = dh.rooms.find(rm => rm.staffIds.includes(s.id));
            if (targetRoom) return targetRoom.id === room.id;
            return room.id === MAIN_ROOM_ID;
        });

        const visitor = shopState.activeVisitor && shopState.activeVisitor.roomId === room.id
            ? characters.find(c => c.id === shopState.activeVisitor?.charId)
            : null;

        const wallStickers = room.stickers.filter(s => s.surface === 'leftWall' || s.surface === 'rightWall');
        const floorStickers = room.stickers.filter(s => s.surface === 'floor');

        const isPlacing = placingFurniture && room.id === activeRoom.id;

        return (
            <div className="w-full h-full rounded-2xl overflow-hidden border border-[#E2D4C4] shadow-[0_4px_20px_rgba(131,96,66,0.12)] bg-[#F9F3E6]">
                <div
                    className="relative w-full h-full min-h-[420px] touch-none"
                    onPointerMove={(e) => {
                        handleRoomPointerMove(room.id, e);
                        if (isPlacing) handlePlacementPointerMove(e);
                    }}
                    onPointerUp={handleRoomPointerUp}
                    onPointerCancel={handleRoomPointerUp}
                    onPointerLeave={handleRoomPointerUp}
                    onClick={() => {
                        if (isPlacing) handlePlacementConfirm();
                    }}
                >
                    {/* Wall */}
                    <div
                        className="absolute left-0 right-0 top-0"
                        style={{ height: `${WALL_H_RATIO * 100}%`, background: wallBg }}
                        onPointerMove={(e) => draggingStickerInfo && handleStickerPointerMove(room.id, 'leftWall', e)}
                        onPointerUp={(e) => { void handleStickerPointerUp(e.nativeEvent); }}
                        onPointerCancel={() => { void handleStickerPointerUp(); }}
                    >
                        <div className="absolute inset-0 opacity-[0.08]" style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, #fff 1px, transparent 1.5px)', backgroundSize: '18px 18px' }} />
                        {!locked && wallStickers.map(sticker => {
                            const isDraggingThis = draggingStickerInfo?.stickerId === sticker.id;
                            const isUrl = sticker.url.startsWith('http') || sticker.url.startsWith('data');
                            const stkPos = localStickerPos[sticker.id] || { x: sticker.x, y: sticker.y };
                            return (
                                <div
                                    key={sticker.id}
                                    className={`absolute select-none group/sticker ${isDraggingThis ? 'cursor-grabbing ring-2 ring-[#FF8E6B] ring-offset-1 rounded-lg' : 'cursor-grab'} transition-transform`}
                                    style={{ left: `${stkPos.x}%`, top: `${stkPos.y}%`, transform: `translate(-50%, -50%) scale(${sticker.scale}) ${isDraggingThis ? 'scale(1.1)' : ''}`, zIndex: isDraggingThis ? 50 : sticker.zIndex, fontSize: '1.5rem' }}
                                    onPointerDown={(e) => { e.stopPropagation(); handleStickerPressStart(sticker.id, room.id, sticker.surface); }}
                                    onPointerUp={(e) => { e.stopPropagation(); void handleStickerPointerUp(e.nativeEvent); }}
                                >
                                    {isUrl ? <img src={sticker.url} alt="" className="w-10 h-10 object-contain drop-shadow-sm" draggable={false} /> : sticker.url}
                                    {editMode && (
                                        <div className="absolute -right-8 top-0 flex flex-col gap-0.5 z-40">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); void handleStickerScaleChange(room.id, sticker.id, 0.15); }}
                                                onPointerDown={(e) => { e.stopPropagation(); cancelStickerLongPress(); }}
                                                className="w-5 h-5 rounded-full bg-white/90 border border-[#E0CBBA] shadow-sm flex items-center justify-center text-[10px] font-bold text-[#6B4528] active:scale-90 transition-transform"
                                            >+</button>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); void handleStickerScaleChange(room.id, sticker.id, -0.15); }}
                                                onPointerDown={(e) => { e.stopPropagation(); cancelStickerLongPress(); }}
                                                className="w-5 h-5 rounded-full bg-white/90 border border-[#E0CBBA] shadow-sm flex items-center justify-center text-[10px] font-bold text-[#6B4528] active:scale-90 transition-transform"
                                            >-</button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Floor */}
                    <div
                        className="absolute left-0 right-0 bottom-0"
                        style={{ height: `${FLOOR_H_RATIO * 100}%`, background: floorBg, borderTop: '2px solid rgba(156,104,64,0.15)' }}
                        onPointerMove={(e) => draggingStickerInfo && handleStickerPointerMove(room.id, 'floor', e)}
                        onPointerUp={(e) => { void handleStickerPointerUp(e.nativeEvent); }}
                        onPointerCancel={() => { void handleStickerPointerUp(); }}
                    >
                        <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'linear-gradient(0deg, rgba(0,0,0,0.15) 1px, transparent 1px),linear-gradient(90deg, rgba(0,0,0,0.15) 1px, transparent 1px)', backgroundSize: '22px 22px' }} />
                        {!locked && floorStickers.map(sticker => {
                            const isDraggingThis = draggingStickerInfo?.stickerId === sticker.id;
                            const isUrl = sticker.url.startsWith('http') || sticker.url.startsWith('data');
                            const stkPos = localStickerPos[sticker.id] || { x: sticker.x, y: sticker.y };
                            return (
                                <div
                                    key={sticker.id}
                                    className={`absolute select-none group/sticker ${isDraggingThis ? 'cursor-grabbing ring-2 ring-[#FF8E6B] ring-offset-1 rounded-lg' : 'cursor-grab'} transition-transform`}
                                    style={{ left: `${stkPos.x}%`, top: `${stkPos.y}%`, transform: `translate(-50%, -50%) scale(${sticker.scale}) ${isDraggingThis ? 'scale(1.1)' : ''}`, zIndex: isDraggingThis ? 50 : sticker.zIndex, fontSize: '1.5rem' }}
                                    onPointerDown={(e) => { e.stopPropagation(); handleStickerPressStart(sticker.id, room.id, sticker.surface); }}
                                    onPointerUp={(e) => { e.stopPropagation(); void handleStickerPointerUp(e.nativeEvent); }}
                                >
                                    {isUrl ? <img src={sticker.url} alt="" className="w-10 h-10 object-contain drop-shadow-sm" draggable={false} /> : sticker.url}
                                    {editMode && (
                                        <div className="absolute -right-8 top-0 flex flex-col gap-0.5 z-40">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); void handleStickerScaleChange(room.id, sticker.id, 0.15); }}
                                                onPointerDown={(e) => { e.stopPropagation(); cancelStickerLongPress(); }}
                                                className="w-5 h-5 rounded-full bg-white/90 border border-[#E0CBBA] shadow-sm flex items-center justify-center text-[10px] font-bold text-[#6B4528] active:scale-90 transition-transform"
                                            >+</button>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); void handleStickerScaleChange(room.id, sticker.id, -0.15); }}
                                                onPointerDown={(e) => { e.stopPropagation(); cancelStickerLongPress(); }}
                                                className="w-5 h-5 rounded-full bg-white/90 border border-[#E0CBBA] shadow-sm flex items-center justify-center text-[10px] font-bold text-[#6B4528] active:scale-90 transition-transform"
                                            >-</button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Room Texture Overlay - uses blob URL for stable rendering */}
                    {!locked && roomTexture && (
                        <div className="absolute inset-0 pointer-events-none z-[5]">
                            <img
                                src={roomTexture}
                                alt=""
                                draggable={false}
                                className="absolute inset-0 w-full h-full object-contain"
                                style={{
                                    transform: `scale(${roomTextureScale})`,
                                    transformOrigin: 'center center',
                                }}
                            />
                        </div>
                    )}

                    {/* Furniture Placement Ghost Preview */}
                    {isPlacing && (
                        <div
                            className="absolute z-[45] pointer-events-none"
                            style={{
                                left: `${furniturePreviewPos.x}%`,
                                top: `${furniturePreviewPos.y}%`,
                                transform: 'translate(-50%, -50%)',
                            }}
                        >
                            <div className="relative animate-pulse">
                                {placingFurniture.isEmoji ? (
                                    <span className="text-3xl opacity-70 drop-shadow-lg">{placingFurniture.url}</span>
                                ) : (
                                    <img src={placingFurniture.url} alt="" className="w-12 h-12 object-contain opacity-70 drop-shadow-lg" draggable={false} />
                                )}
                                <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap">
                                    <span className="text-[9px] bg-[#FF8E6B] text-white px-2 py-0.5 rounded-full font-bold shadow-sm">
                                        点击放置
                                    </span>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Staff Actors */}
                    {!locked && roomStaff.map(staff => {
                        const pos = actorPositions[staff.id] || clampActorPos(staff.x || 50, staff.y || 72);
                        const staffScale = staff.scale ?? 1;
                        // 店员头像可能是 emoji 字符，也可能是图（外链 / data: / blobref 令牌）
                        const isStaffUrl = staff.avatar.startsWith('http') || staff.avatar.startsWith('data') || isBlobRef(staff.avatar);
                        return (
                            <div
                                key={staff.id}
                                className={`absolute ${draggingActorId === staff.id ? 'cursor-grabbing' : 'cursor-pointer'} select-none group/staff transition-[left,top] ${draggingActorId === staff.id ? 'duration-0' : 'duration-200'} ease-out`}
                                style={{ left: `${pos.x}%`, top: `${pos.y}%`, transform: 'translate(-50%, -100%)', zIndex: 30 }}
                                onPointerDown={(e) => { e.stopPropagation(); handleActorPressStart(staff.id, room.id, false); }}
                                onPointerUp={async (e) => {
                                    e.stopPropagation();
                                    const hadDrag = await handleRoomPointerUp();
                                    if (suppressNextStaffOpenRef.current) {
                                        suppressNextStaffOpenRef.current = false;
                                        return;
                                    }
                                    if (!hadDrag && !suppressActorClickRef.current) onStaffClick?.(staff);
                                }}
                            >
                                <div className="drop-shadow-md origin-bottom" style={{ transform: `scale(${staffScale})` }}>
                                    {isStaffUrl
                                        ? <TokenImg value={staff.avatar} className="w-10 h-10 object-contain" draggable={false} />
                                        : <span className="text-3xl">{staff.avatar}</span>
                                    }
                                </div>
                                <div className="mt-0.5 px-2 py-0.5 rounded-full bg-white/90 border border-[#F2D5BE] text-[10px] font-bold text-[#8A5A3D] text-center shadow-sm">{staff.name}</div>
                                {/* Resize controls */}
                                <div className="absolute -right-8 top-0 flex flex-col gap-0.5 opacity-0 group-hover/staff:opacity-100 transition-opacity z-40">
                                    <button
                                        onClick={(e) => { e.stopPropagation(); suppressNextStaffOpenRef.current = true; void handleStaffScaleChange(staff.id, 0.15); }}
                                        onPointerDown={(e) => { e.stopPropagation(); suppressNextStaffOpenRef.current = true; }}
                                        className="w-5 h-5 rounded-full bg-white/90 border border-[#E0CBBA] shadow-sm flex items-center justify-center text-[10px] font-bold text-[#6B4528] active:scale-90 transition-transform"
                                    >+</button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); suppressNextStaffOpenRef.current = true; void handleStaffScaleChange(staff.id, -0.15); }}
                                        onPointerDown={(e) => { e.stopPropagation(); suppressNextStaffOpenRef.current = true; }}
                                        className="w-5 h-5 rounded-full bg-white/90 border border-[#E0CBBA] shadow-sm flex items-center justify-center text-[10px] font-bold text-[#6B4528] active:scale-90 transition-transform"
                                    >-</button>
                                </div>
                            </div>
                        );
                    })}

                    {/* Visitor */}
                    {!locked && visitor && shopState.activeVisitor && (() => {
                        const visitorPos = actorPositions[visitor.id] || clampActorPos(shopState.activeVisitor.x ?? 55, shopState.activeVisitor.y ?? 76);
                        return (
                            <div
                                className={`absolute ${draggingActorId === visitor.id ? 'cursor-grabbing' : 'cursor-grab'} select-none group/staff transition-[left,top] ${draggingActorId === visitor.id ? 'duration-0' : 'duration-200'} ease-out`}
                                style={{ left: `${visitorPos.x}%`, top: `${visitorPos.y}%`, transform: 'translate(-50%, -100%)', zIndex: 35 }}
                                onPointerDown={(e) => { e.stopPropagation(); handleActorPressStart(visitor.id, room.id, true); }}
                                onPointerUp={(e) => { e.stopPropagation(); void handleRoomPointerUp(); }}
                            >
                                <div className="drop-shadow-md origin-bottom" style={{ transform: `scale(${shopState.activeVisitor?.scale ?? 4})` }}>
                                    <TokenImg value={visitor.sprites?.chibi || visitor.avatar} className="w-10 h-10 object-contain" draggable={false} />
                                </div>
                                <div className="mt-0.5 px-2 py-0.5 rounded-full bg-white/95 border border-[#D9C1AE] text-[10px] font-bold text-[#8A5A3D] text-center">{visitor.name}</div>
                                <div className="absolute -right-8 top-0 flex flex-col gap-0.5 opacity-0 group-hover/staff:opacity-100 transition-opacity z-40">
                                    <button
                                        onClick={(e) => { e.stopPropagation(); void handleVisitorScaleChange(0.15); }}
                                        onPointerDown={(e) => e.stopPropagation()}
                                        className="w-5 h-5 rounded-full bg-white/90 border border-[#E0CBBA] shadow-sm flex items-center justify-center text-[10px] font-bold text-[#6B4528] active:scale-90 transition-transform"
                                    >+</button>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); void handleVisitorScaleChange(-0.15); }}
                                        onPointerDown={(e) => e.stopPropagation()}
                                        className="w-5 h-5 rounded-full bg-white/90 border border-[#E0CBBA] shadow-sm flex items-center justify-center text-[10px] font-bold text-[#6B4528] active:scale-90 transition-transform"
                                    >-</button>
                                </div>
                            </div>
                        );
                    })()}

                    {/* Lock Overlay */}
                    {locked && (
                        <button
                            onClick={() => setShowUnlockConfirm(room.id)}
                            className="absolute inset-0 z-40 bg-black/20 backdrop-blur-[2px] flex items-center justify-center"
                        >
                            <div className="bg-white/90 backdrop-blur-sm px-5 py-4 rounded-2xl shadow-lg text-center">
                                <div className="text-2xl mb-1">🔒</div>
                                <div className="text-sm font-bold text-[#8A5A3D]">解锁 {ROOM_UNLOCK_COSTS[room.id] || 150} AP</div>
                            </div>
                        </button>
                    )}
                </div>
            </div>
        );
    };

    const builtinFurniture = STICKER_LIBRARY.map(s => ({ id: s.id, name: s.name, url: s.url, category: s.category }));
    const furnitureCategories = [
        { id: 'all', label: '全部' },
        { id: 'furniture', label: '家具' },
        { id: 'decor', label: '装饰' },
        { id: 'wall', label: '挂饰' },
        { id: 'food', label: '美食' },
        { id: 'pet', label: '宠物' },
    ];
    const [furnitureFilter, setFurnitureFilter] = useState('all');

    const filteredFurniture = furnitureFilter === 'all'
        ? builtinFurniture
        : builtinFurniture.filter(f => f.category === furnitureFilter);

    const displayScaleValue = localRoomScale ?? (activeRoom.roomTextureScale ?? 1);

    return (
        <div className="relative w-full h-full pt-2 pb-3 rounded-2xl flex flex-col" style={{ background: 'linear-gradient(180deg, #FBF5EB 0%, #F5EDE0 100%)' }}>
            {/* Room Navigation Header */}
            <div className="flex items-center justify-between px-2 mb-2">
                {renderArrowButton('left', goPrevRoom)}
                <div className="text-center flex-1 mx-2">
                    <div className="text-[10px] text-[#C4956A] font-medium tracking-wider uppercase">ROOM</div>
                    <div className="text-base font-black text-[#6B4528] tracking-wide">{activeRoom.name}</div>
                    <div className="flex justify-center gap-1 mt-1">
                        {orderedRooms.map((r, i) => (
                            <div key={r.id} className={`w-1.5 h-1.5 rounded-full transition-all ${i === activeRoomIndex ? 'bg-[#FF8E6B] w-4' : 'bg-[#DCC8B4]'}`} />
                        ))}
                    </div>
                </div>
                {renderArrowButton('right', goNextRoom)}
            </div>

            {/* Action Buttons */}
            <div className="absolute right-2.5 top-[76px] z-[40] flex flex-col gap-2">
                <button
                    onClick={() => { setShowDecorPanel(true); setDecorTab('furniture'); }}
                    className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#FF9A75] to-[#FF6B55] text-white text-base shadow-[0_3px_12px_rgba(255,107,85,0.35)] flex items-center justify-center active:scale-90 transition-transform"
                    aria-label="装修"
                >
                    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.049.58.025 1.193-.14 1.743" />
                    </svg>
                </button>
                {/* Edit Mode Toggle */}
                <button
                    onClick={() => setEditMode(prev => !prev)}
                    className={`w-10 h-10 rounded-xl border text-base shadow-sm flex items-center justify-center active:scale-90 transition-all ${
                        editMode
                            ? 'bg-gradient-to-br from-[#4CAF50] to-[#388E3C] text-white border-[#388E3C] shadow-[0_3px_12px_rgba(76,175,80,0.35)]'
                            : 'bg-white/90 border-[#E8D5C4] text-[#7A5238]'
                    }`}
                    aria-label="装修模式"
                >
                    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                </button>
                <button
                    onClick={onOpenGuestbook}
                    className="w-10 h-10 rounded-xl bg-white/90 border border-[#E8D5C4] text-[#7A5238] shadow-sm flex items-center justify-center active:scale-90 transition-transform"
                    aria-label="翻开情报志"
                >
                    <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
                    </svg>
                </button>
            </div>

            {/* Edit Mode Banner */}
            {editMode && (
                <div className="mx-2 mb-1 px-3 py-1.5 rounded-xl bg-[#E8F5E9] border border-[#A5D6A7] flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-[#4CAF50] animate-pulse" />
                    <span className="text-[10px] font-bold text-[#2E7D32]">装修模式</span>
                    <span className="text-[10px] text-[#4CAF50]">可调整大小 / 拖到垃圾桶删除</span>
                </div>
            )}

            {/* Room View */}
            <div className="flex-1 min-h-0 px-1">
                {renderRoom(activeRoom)}
            </div>

            {/* Trash Zone - visible when dragging a sticker in edit mode */}
            {editMode && draggingStickerInfo && (
                <div
                    ref={trashRef}
                    onPointerEnter={() => setOverTrash(true)}
                    onPointerLeave={() => setOverTrash(false)}
                    onPointerUp={(e) => { void handleStickerPointerUp(e.nativeEvent); }}
                    className={`absolute bottom-3 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 px-6 py-3 rounded-2xl border-2 border-dashed transition-all ${
                        overTrash
                            ? 'bg-[#FFEBEE] border-[#EF5350] scale-110'
                            : 'bg-white/95 border-[#E0CBBA] scale-100'
                    }`}
                >
                    <svg viewBox="0 0 24 24" className={`w-6 h-6 transition-colors ${overTrash ? 'text-[#EF5350]' : 'text-[#B8956E]'}`} fill="none" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                    </svg>
                    <span className={`text-xs font-bold transition-colors ${overTrash ? 'text-[#EF5350]' : 'text-[#B8956E]'}`}>
                        {overTrash ? '松手删除' : '拖到这里删除'}
                    </span>
                </div>
            )}

            {/* Placement Mode Bar */}
            {placingFurniture && (
                <div className="absolute bottom-0 left-0 right-0 z-[50] bg-gradient-to-t from-[#FFF5EB] via-[#FFF5EB] to-transparent pt-6 pb-4 px-4">
                    <div className="bg-white rounded-2xl shadow-lg border border-[#F2D5BE] p-3 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-[#FFF4E8] border border-[#F2D2B6] flex items-center justify-center text-xl flex-shrink-0">
                            {placingFurniture.isEmoji ? placingFurniture.url : (
                                <img src={placingFurniture.url} alt="" className="w-8 h-8 object-contain" />
                            )}
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-xs font-bold text-[#6B4528]">{placingFurniture.name}</div>
                            <div className="text-[10px] text-[#B8956E]">在房间内点击或拖动选择位置</div>
                        </div>
                        <button
                            onClick={() => setPlacingFurniture(null)}
                            className="px-3 py-1.5 rounded-lg bg-[#F5E6DA] text-[#8A5A3D] text-xs font-bold flex-shrink-0"
                        >
                            取消
                        </button>
                    </div>
                </div>
            )}

            {/* Decor Panel */}
            {showDecorPanel && (
                <div className="absolute inset-0 z-[80] bg-black/30 flex items-end" onClick={() => setShowDecorPanel(false)}>
                    <div
                        className="w-full rounded-t-3xl bg-gradient-to-b from-white to-[#FFFCF7] max-h-[65vh] overflow-hidden flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                        style={{ paddingBottom: 'max(0.75rem, var(--safe-bottom, 0px))' }}
                    >
                        {/* Panel Header */}
                        <div className="flex items-center justify-between px-4 pt-4 pb-2">
                            <div className="flex items-center gap-2">
                                <div className="w-1 h-5 rounded-full bg-gradient-to-b from-[#FF8E6B] to-[#FF6B55]" />
                                <span className="text-sm font-black text-[#6B4528]">装修面板</span>
                            </div>
                            <button
                                onClick={() => setShowDecorPanel(false)}
                                className="w-8 h-8 rounded-full bg-[#F5EDE0] text-[#8A5A3D] flex items-center justify-center active:scale-90 transition-transform"
                            >
                                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        {/* Tabs - Scrollable pill style */}
                        <div className="px-3 pb-2">
                            <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
                                {DECOR_TABS.map(tab => (
                                    <button
                                        key={tab.id}
                                        onClick={() => setDecorTab(tab.id)}
                                        className={`flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all flex-shrink-0 ${
                                            decorTab === tab.id
                                                ? 'bg-gradient-to-r from-[#6B4528] to-[#8B5E43] text-white shadow-sm'
                                                : 'bg-[#F5EDE0] text-[#8A5A3D] hover:bg-[#EDE1D2]'
                                        }`}
                                    >
                                        <span className="text-sm">{(() => { const Icon = DECOR_TAB_ICONS[tab.id]; return <Icon size={14} weight="bold" />; })()}</span>
                                        {tab.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Tab Content */}
                        <div className="flex-1 overflow-y-auto px-4 pb-3">
                            {decorTab === 'layout' && (
                                <div className="space-y-2">
                                    {ROOM_LAYOUTS.map(layout => {
                                        const isActive = activeRoom.layoutId === layout.id;
                                        return (
                                            <button
                                                key={layout.id}
                                                onClick={() => handleChangeLayout(activeRoom.id, layout.id)}
                                                className={`w-full p-3 rounded-2xl border flex items-center gap-3 text-left transition-all ${
                                                    isActive
                                                        ? 'border-[#FF8E6B] bg-[#FFF5EE] shadow-sm'
                                                        : 'border-[#F0E3D6] bg-white hover:border-[#E0CBBA]'
                                                }`}
                                            >
                                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl ${isActive ? 'bg-[#FF8E6B]/10' : 'bg-[#F8F0E6]'}`}>
                                                    <BankAssetIcon
                                                        value={layout.icon}
                                                        alt={layout.name}
                                                        imgClassName="w-6 h-6 object-contain"
                                                        textClassName="text-xl leading-none"
                                                    />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-xs font-bold text-[#6B4528]">{layout.name}</div>
                                                    <div className="text-[10px] text-[#B8956E] mt-0.5">{layout.description}</div>
                                                </div>
                                                <div className={`text-[10px] font-bold px-2 py-1 rounded-lg ${
                                                    isActive ? 'bg-[#FF8E6B] text-white' : layout.apCost > 0 ? 'bg-[#FFF4E8] text-[#C4956A]' : 'bg-[#E8F5E9] text-[#4CAF50]'
                                                }`}>
                                                    {isActive ? '当前' : layout.apCost > 0 ? `${layout.apCost} AP` : '免费'}
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}

                            {decorTab === 'rename' && (
                                <div className="flex flex-col items-center py-6">
                                    <div className="text-3xl mb-3">✏️</div>
                                    <div className="text-xs text-[#B8956E] mb-4 text-center">为「{activeRoom.name}」取一个新名字</div>
                                    <button
                                        onClick={() => handleRenameRoom(activeRoom)}
                                        className="px-6 py-3 rounded-2xl bg-gradient-to-r from-[#FF8E6B] to-[#FF7D5A] text-white text-sm font-bold shadow-md active:scale-95 transition-transform"
                                    >
                                        重命名房间
                                    </button>
                                </div>
                            )}

                            {decorTab === 'wallpaper' && (
                                <div className="space-y-3">
                                    <button
                                        onClick={() => openTextureModal('wallpaper')}
                                        className="w-full py-2.5 rounded-2xl bg-white border-2 border-dashed border-[#E0CBBA] text-[#8A5A3D] text-xs font-bold flex items-center justify-center gap-2 hover:border-[#FF8E6B] hover:text-[#FF8E6B] transition-colors"
                                    >
                                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                                        </svg>
                                        上传自定义墙纸
                                    </button>
                                    <div className="grid grid-cols-2 gap-2">
                                        {WALLPAPER_PRESETS.map(wp => (
                                            <button
                                                key={wp.id}
                                                onClick={() => handleSetWallpaper(activeRoom.id, wp.style)}
                                                className="rounded-2xl border border-[#F0E3D6] p-2.5 text-left hover:border-[#FF8E6B] transition-colors bg-white group"
                                            >
                                                <div className="h-12 rounded-xl mb-1.5 border border-[#F0E3D6]/50" style={{ background: wp.style }} />
                                                <div className="text-[11px] font-bold text-[#6B4528] group-hover:text-[#FF8E6B] transition-colors">{wp.name}</div>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {decorTab === 'floor' && (
                                <div className="space-y-3">
                                    <button
                                        onClick={() => openTextureModal('floor')}
                                        className="w-full py-2.5 rounded-2xl bg-white border-2 border-dashed border-[#E0CBBA] text-[#8A5A3D] text-xs font-bold flex items-center justify-center gap-2 hover:border-[#FF8E6B] hover:text-[#FF8E6B] transition-colors"
                                    >
                                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                                        </svg>
                                        上传自定义地板
                                    </button>
                                    <div className="grid grid-cols-2 gap-2">
                                        {FLOOR_PRESETS.map(fl => (
                                            <button
                                                key={fl.id}
                                                onClick={() => handleSetFloor(activeRoom.id, fl.style)}
                                                className="rounded-2xl border border-[#F0E3D6] p-2.5 text-left hover:border-[#FF8E6B] transition-colors bg-white group"
                                            >
                                                <div className="h-12 rounded-xl mb-1.5 border border-[#F0E3D6]/50" style={{ background: fl.style }} />
                                                <div className="text-[11px] font-bold text-[#6B4528] group-hover:text-[#FF8E6B] transition-colors">{fl.name}</div>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {decorTab === 'roomTexture' && (
                                <div className="space-y-3">
                                    <button
                                        onClick={() => openTextureModal('room')}
                                        className="w-full py-3 rounded-2xl bg-gradient-to-r from-[#FF8E6B] to-[#FF6B55] text-white text-xs font-bold shadow-[0_3px_12px_rgba(255,107,85,0.3)] flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
                                    >
                                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
                                        </svg>
                                        上传全屋贴图
                                    </button>

                                    {activeRoom.roomTextureUrl ? (
                                        <div className="bg-white rounded-2xl p-3.5 border border-[#F0E3D6] space-y-3">
                                            <div className="flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    <div className="w-2 h-2 rounded-full bg-[#4CAF50]" />
                                                    <span className="text-[11px] text-[#6B4528] font-bold">当前贴图</span>
                                                </div>
                                                <button
                                                    onClick={async () => {
                                                        const confirmed = await requestConfirm({
                                                            title: '清除全屋贴图？',
                                                            message: `确定清除「${activeRoom.name}」当前的全屋贴图吗？`,
                                                            confirmText: '清除',
                                                            variant: 'danger',
                                                        });
                                                        if (!confirmed) return;
                                                        await saveDollhouse(prev => ({ ...prev, rooms: prev.rooms.map(r => r.id === activeRoom.id ? { ...r, roomTextureUrl: undefined, roomTextureScale: 1 } : r) }));
                                                        addToast('已清除全屋贴图', 'success');
                                                    }}
                                                    className="text-[10px] text-[#E53935] font-bold px-2 py-1 rounded-lg hover:bg-[#FFEBEE] transition-colors"
                                                >
                                                    清除
                                                </button>
                                            </div>

                                            {/* Preview */}
                                            <div className="rounded-xl overflow-hidden border border-[#E8DAC6] shadow-inner" style={{ aspectRatio: '16/10' }}>
                                                <div className="relative w-full h-full" style={{ background: toCssBackground(activeRoom.wallpaperLeft, 'linear-gradient(180deg, #FFF5E9, #FDE5D8)') }}>
                                                    <div className="absolute left-0 right-0 bottom-0" style={{ height: `${FLOOR_H_RATIO * 100}%`, background: toCssBackground(activeRoom.floorStyle, 'linear-gradient(135deg, #D6B48C, #C69767)') }} />
                                                    <img
                                                        src={resolveTextureUrl(activeRoom.roomTextureUrl) || ''}
                                                        alt="texture"
                                                        className="absolute inset-0 w-full h-full object-contain"
                                                        style={{ transform: `scale(${displayScaleValue})`, transformOrigin: 'center center' }}
                                                    />
                                                </div>
                                            </div>

                                            {/* Scale Slider - FIXED: debounced to prevent flickering */}
                                            <div className="bg-[#FDF8F2] rounded-xl p-3 border border-[#F5EDE0]">
                                                <div className="flex items-center justify-between mb-2">
                                                    <div className="text-[11px] text-[#8A5A3D] font-bold flex items-center gap-1.5">
                                                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607ZM10.5 7.5v6m3-3h-6" />
                                                        </svg>
                                                        缩放
                                                    </div>
                                                    <div className="text-[11px] text-[#B8956E] font-mono bg-white px-2 py-0.5 rounded-md border border-[#F0E3D6]">
                                                        {displayScaleValue.toFixed(2)}x
                                                    </div>
                                                </div>
                                                <input
                                                    type="range" min={0.5} max={2.5} step={0.05}
                                                    value={displayScaleValue}
                                                    onChange={(e) => handleScaleSliderChange(parseFloat(e.target.value))}
                                                    onPointerUp={() => handleScaleSliderCommit()}
                                                    onTouchEnd={() => handleScaleSliderCommit()}
                                                    className="w-full accent-[#FF8E6B] h-2"
                                                />
                                                <div className="flex justify-between text-[9px] text-[#C4A882] mt-1">
                                                    <span>0.5x</span>
                                                    <span>1.0x</span>
                                                    <span>1.5x</span>
                                                    <span>2.0x</span>
                                                    <span>2.5x</span>
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="text-center py-8 bg-white rounded-2xl border border-[#F0E3D6]">
                                            <div className="text-3xl mb-2 opacity-30">🖼️</div>
                                            <div className="text-xs text-[#B8956E]">暂无全屋贴图</div>
                                            <div className="text-[10px] text-[#D4B99A] mt-1">点击上方按钮上传图片</div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {decorTab === 'furniture' && (
                                <div className="space-y-3">
                                    {/* Add custom furniture button */}
                                    <button
                                        onClick={() => setShowAssetModal(true)}
                                        className="w-full py-2.5 rounded-2xl bg-white border-2 border-dashed border-[#E0CBBA] text-[#8A5A3D] text-xs font-bold flex items-center justify-center gap-2 hover:border-[#FF8E6B] hover:text-[#FF8E6B] transition-colors"
                                    >
                                        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                                        </svg>
                                        上传自定义家具
                                    </button>

                                    {/* Category filter pills */}
                                    <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
                                        {furnitureCategories.map(cat => (
                                            <button
                                                key={cat.id}
                                                onClick={() => setFurnitureFilter(cat.id)}
                                                className={`px-3 py-1.5 rounded-full text-[10px] font-bold whitespace-nowrap transition-all flex-shrink-0 ${
                                                    furnitureFilter === cat.id
                                                        ? 'bg-[#6B4528] text-white'
                                                        : 'bg-[#F5EDE0] text-[#8A5A3D]'
                                                }`}
                                            >
                                                {cat.label}
                                            </button>
                                        ))}
                                    </div>

                                    {/* Furniture Grid - Improved: larger items with names */}
                                    <div className="grid grid-cols-4 gap-2">
                                        {filteredFurniture.map(sticker => (
                                            <button
                                                key={sticker.id}
                                                onClick={() => startPlacingFurniture(
                                                    sticker.url,
                                                    sticker.category === 'wall' ? 'leftWall' : 'floor',
                                                    sticker.name
                                                )}
                                                className="flex flex-col items-center gap-1 p-2 rounded-xl bg-white border border-[#F0E3D6] hover:border-[#FF8E6B] hover:shadow-sm transition-all active:scale-95 group"
                                            >
                                                <div className="w-8 h-8 flex items-center justify-center">
                                                    <BankAssetIcon
                                                        value={sticker.url}
                                                        alt={sticker.name}
                                                        imgClassName="w-8 h-8 object-contain group-hover:scale-110 transition-transform"
                                                        textClassName="text-2xl leading-none group-hover:scale-110 transition-transform"
                                                    />
                                                </div>
                                                <span className="text-[9px] text-[#B8956E] font-medium group-hover:text-[#FF8E6B] transition-colors">{sticker.name}</span>
                                            </button>
                                        ))}

                                        {/* Custom Assets */}
                                        {(furnitureFilter === 'all' || furnitureFilter === 'furniture') && customAssets.map(asset => (
                                            <div key={asset.id} className="relative group">
                                                <button
                                                    onClick={() => startPlacingFurniture(asset.url, 'floor', asset.name)}
                                                    className="w-full flex flex-col items-center gap-1 p-2 rounded-xl bg-white border border-[#F0E3D6] hover:border-[#FF8E6B] hover:shadow-sm transition-all active:scale-95"
                                                >
                                                    <div className="w-8 h-8 flex items-center justify-center">
                                                        <img src={asset.url} className="max-w-full max-h-full object-contain" alt={asset.name} />
                                                    </div>
                                                    <span className="text-[9px] text-[#B8956E] font-medium truncate w-full text-center">{asset.name}</span>
                                                </button>
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); handleDeleteCustomAsset(asset.id); }}
                                                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[#FF5252] text-white text-[10px] font-bold flex items-center justify-center shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="flex items-start gap-2 bg-[#FFF8F0] rounded-xl p-2.5 border border-[#F5EDE0]">
                                        <svg viewBox="0 0 24 24" className="w-4 h-4 text-[#C4956A] flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
                                        </svg>
                                        <div className="text-[10px] text-[#A67E62] leading-relaxed">
                                            点击家具即可进入摆放模式，在房间内选择位置。长按已放置的家具可拖动。开启右侧「装修模式」可调整大小，拖入垃圾桶删除。
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Custom Asset Modal - Improved */}
            {showAssetModal && (
                <div className="absolute inset-0 z-[90] bg-black/30 flex items-center justify-center p-4" onClick={() => setShowAssetModal(false)}>
                    <div className="w-full max-w-sm bg-white rounded-3xl overflow-hidden shadow-xl" onClick={e => e.stopPropagation()}>
                        <div className="bg-gradient-to-r from-[#FF8E6B] to-[#FF6B55] px-5 py-4">
                            <div className="text-white font-bold text-sm">添加自定义家具</div>
                            <div className="text-white/70 text-[10px] mt-0.5">支持图床URL或本地上传</div>
                        </div>
                        <div className="p-4 space-y-3">
                            {/* Preview */}
                            <div className="w-full h-24 rounded-xl bg-[#F8F0E6] border border-[#F0E3D6] flex items-center justify-center overflow-hidden">
                                {(assetUploadedData || assetUrl) ? (
                                    <img src={assetUploadedData || assetUrl} alt="preview" className="max-w-full max-h-full object-contain" />
                                ) : (
                                    <div className="text-center">
                                        <div className="text-2xl opacity-20">🪑</div>
                                        <div className="text-[10px] text-[#C4A882] mt-1">上传图片后预览</div>
                                    </div>
                                )}
                            </div>

                            <div>
                                <label className="text-[10px] text-[#8A5A3D] font-bold mb-1 block">家具名称</label>
                                <input
                                    value={assetName}
                                    onChange={(e) => setAssetName(e.target.value)}
                                    placeholder="例如：可爱沙发"
                                    className="w-full px-3 py-2.5 rounded-xl border border-[#E9D0BD] text-sm bg-[#FDFAF5] focus:outline-none focus:border-[#FF8E6B] focus:ring-1 focus:ring-[#FF8E6B]/20 transition-all"
                                />
                            </div>
                            <div>
                                <label className="text-[10px] text-[#8A5A3D] font-bold mb-1 block">图片地址</label>
                                <input
                                    value={assetUrl}
                                    onChange={(e) => setAssetUrl(e.target.value)}
                                    placeholder="粘贴图床URL 或点击下方上传"
                                    className="w-full px-3 py-2.5 rounded-xl border border-[#E9D0BD] text-sm bg-[#FDFAF5] focus:outline-none focus:border-[#FF8E6B] focus:ring-1 focus:ring-[#FF8E6B]/20 transition-all"
                                />
                            </div>
                            <div className="flex gap-2 pt-1">
                                <button
                                    onClick={() => fileInputRef.current?.click()}
                                    className="flex-1 py-2.5 rounded-xl bg-[#F5EDE0] text-[#6B4528] text-xs font-bold flex items-center justify-center gap-1.5 active:scale-95 transition-transform"
                                >
                                    <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                                    </svg>
                                    本地上传
                                </button>
                                <button
                                    onClick={handleAddCustomAsset}
                                    className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-[#FF8E6B] to-[#FF6B55] text-white text-xs font-bold shadow-sm active:scale-95 transition-transform"
                                >
                                    保存家具
                                </button>
                            </div>
                            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleUploadCustomAsset} className="hidden" />
                        </div>
                    </div>
                </div>
            )}

            {/* Texture Upload Modal - Improved */}
            {showTextureModal && (
                <div className="absolute inset-0 z-[95] bg-black/30 flex items-center justify-center p-3" onClick={() => setShowTextureModal(false)}>
                    <div className="w-full max-w-sm max-h-[88vh] bg-white rounded-3xl overflow-hidden shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
                        {/* Header */}
                        <div className="bg-gradient-to-r from-[#FF8E6B] to-[#FF6B55] px-5 py-4 flex items-center justify-between flex-shrink-0">
                            <div>
                                <div className="text-white font-bold text-sm">
                                    {textureTarget === 'room' ? '全屋贴图' : textureTarget === 'wallpaper' ? '自定义墙纸' : '自定义地板'}
                                </div>
                                <div className="text-white/70 text-[10px] mt-0.5">
                                    {textureTarget === 'room' ? '覆盖在整个房间上方的图层' : '替换当前墙面/地板样式'}
                                </div>
                            </div>
                            <button
                                onClick={() => setShowTextureModal(false)}
                                className="w-7 h-7 rounded-full bg-white/20 text-white flex items-center justify-center"
                            >
                                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-4 space-y-3">
                            {/* Live Preview */}
                            {textureTarget === 'room' && (
                                <div className="rounded-2xl overflow-hidden border border-[#E8DAC6] shadow-inner" style={{ aspectRatio: '16/10' }}>
                                    <div className="relative w-full h-full" style={{ background: toCssBackground(activeRoom.wallpaperLeft, 'linear-gradient(180deg, #FFF5E9, #FDE5D8)') }}>
                                        <div className="absolute left-0 right-0 bottom-0" style={{ height: `${FLOOR_H_RATIO * 100}%`, background: toCssBackground(activeRoom.floorStyle, 'linear-gradient(135deg, #D6B48C, #C69767)') }} />
                                        {textureUrl && (
                                            <img
                                                src={textureUrl}
                                                alt="preview"
                                                draggable={false}
                                                className="absolute inset-0 w-full h-full object-contain transition-transform duration-200"
                                                style={{ transform: `scale(${textureScale})`, transformOrigin: 'center center' }}
                                            />
                                        )}
                                        {!textureUrl && (
                                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                                                <svg viewBox="0 0 24 24" className="w-8 h-8 text-[#D4C0A8]" fill="none" stroke="currentColor" strokeWidth="1.5">
                                                    <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
                                                </svg>
                                                <span className="text-[11px] text-[#B8956E] font-medium">上传图片后实时预览</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {textureTarget !== 'room' && (
                                <div className="h-20 rounded-2xl overflow-hidden border border-[#E8DAC6]">
                                    {textureUrl ? (
                                        <div className="w-full h-full" style={{ background: toCssBackground(textureUrl) }} />
                                    ) : (
                                        <div className="w-full h-full bg-[#F8F0E6] flex items-center justify-center">
                                            <span className="text-[11px] text-[#B8956E]">上传后预览</span>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* URL Input */}
                            <div>
                                <label className="text-[10px] text-[#8A5A3D] font-bold mb-1 block">图片地址</label>
                                <input
                                    value={textureUrl}
                                    onChange={(e) => { textureFullRef.current = ''; setTextureUrl(e.target.value); }}
                                    placeholder="粘贴图床URL 或点击下方上传"
                                    className="w-full px-3 py-2.5 rounded-xl border border-[#E9D0BD] text-sm bg-[#FDFAF5] focus:outline-none focus:border-[#FF8E6B] focus:ring-1 focus:ring-[#FF8E6B]/20 transition-all"
                                />
                            </div>

                            {/* Scale Control - only for room texture */}
                            {textureTarget === 'room' && (
                                <div className="bg-[#FDF8F2] rounded-xl p-3 border border-[#F5EDE0]">
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="text-[11px] text-[#8A5A3D] font-bold flex items-center gap-1.5">
                                            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                                                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607ZM10.5 7.5v6m3-3h-6" />
                                            </svg>
                                            缩放比例
                                        </div>
                                        <div className="text-[11px] text-[#B8956E] font-mono bg-white px-2 py-0.5 rounded-md border border-[#F0E3D6]">
                                            {textureScale.toFixed(2)}x
                                        </div>
                                    </div>
                                    <input
                                        type="range" min={0.5} max={2.5} step={0.05}
                                        value={textureScale}
                                        onChange={(e) => setTextureScale(parseFloat(e.target.value))}
                                        className="w-full accent-[#FF8E6B] h-2"
                                    />
                                    <div className="flex justify-between text-[9px] text-[#C4A882] mt-1">
                                        <span>0.5x</span>
                                        <span>1.0x</span>
                                        <span>1.5x</span>
                                        <span>2.0x</span>
                                        <span>2.5x</span>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Footer Actions */}
                        <div className="flex gap-2 p-4 border-t border-[#F5EDE0] flex-shrink-0">
                            <button
                                onClick={() => textureInputRef.current?.click()}
                                className="flex-1 py-2.5 rounded-xl bg-[#F5EDE0] text-[#6B4528] text-xs font-bold flex items-center justify-center gap-1.5 active:scale-95 transition-transform"
                            >
                                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                                </svg>
                                本地上传
                            </button>
                            <button
                                onClick={handleSaveCustomTexture}
                                className={`flex-1 py-2.5 rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all ${
                                    textureUrl.trim()
                                        ? 'bg-gradient-to-r from-[#FF8E6B] to-[#FF6B55] text-white'
                                        : 'bg-[#E0D4C6] text-[#A89580] cursor-not-allowed'
                                }`}
                                disabled={!textureUrl.trim()}
                            >
                                确认保存
                            </button>
                        </div>
                        <input ref={textureInputRef} type="file" accept="image/*" onChange={handleTextureUpload} className="hidden" />
                    </div>
                </div>
            )}

            {/* Unlock Confirm Modal */}
            {showUnlockConfirm && (() => {
                const room = dh.rooms.find(r => r.id === showUnlockConfirm);
                const cost = ROOM_UNLOCK_COSTS[showUnlockConfirm] || 150;
                return (
                    <div className="absolute inset-0 z-[70] bg-black/30 flex items-center justify-center p-4" onClick={() => setShowUnlockConfirm(null)}>
                        <div className="w-full max-w-xs bg-white rounded-3xl p-5 shadow-xl" onClick={e => e.stopPropagation()}>
                            <div className="text-center mb-4">
                                <div className="text-3xl mb-2">🔓</div>
                                <div className="text-sm font-bold text-[#6B4528]">解锁「{room?.name || '房间'}」</div>
                                <div className="text-xs text-[#B8956E] mt-1">需要消耗 {cost} AP</div>
                            </div>
                            <div className="flex gap-2">
                                <button
                                    className="flex-1 py-2.5 rounded-xl bg-[#F5EDE0] text-[#8A5A3D] text-xs font-bold active:scale-95 transition-transform"
                                    onClick={() => setShowUnlockConfirm(null)}
                                >
                                    取消
                                </button>
                                <button
                                    className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-[#FF8E6B] to-[#FF6B55] text-white text-xs font-bold shadow-sm active:scale-95 transition-transform"
                                    onClick={() => handleUnlockRoom(showUnlockConfirm)}
                                >
                                    解锁
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })()}

            {/* Rename Room Modal */}
            {renameTarget && (
                <div className="absolute inset-0 z-[100] bg-black/40 flex items-center justify-center px-6">
                    <div className="w-full max-w-sm bg-white rounded-3xl p-5 shadow-2xl">
                        <div className="text-sm font-bold text-slate-700 mb-3">重命名房间</div>
                        <input
                            type="text"
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            maxLength={10}
                            autoFocus
                            onKeyDown={e => { if (e.key === 'Enter') confirmRenameRoom(); if (e.key === 'Escape') setRenameTarget(null); }}
                            className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/30 mb-4"
                            placeholder="最多10字"
                        />
                        <div className="flex gap-3">
                            <button onClick={() => setRenameTarget(null)} className="flex-1 py-2.5 rounded-2xl bg-slate-100 text-slate-600 font-bold text-sm">取消</button>
                            <button onClick={confirmRenameRoom} className="flex-1 py-2.5 rounded-2xl bg-primary text-white font-bold text-sm shadow-lg">确认</button>
                        </div>
                    </div>
                </div>
            )}
            {confirmDialog}
        </div>
    );
};

export default BankDollhouse;
