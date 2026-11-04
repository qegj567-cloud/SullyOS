import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, ImageSquare, X, ArrowsClockwise, ArrowCounterClockwise, PaperPlaneTilt, Trash, Sticker as StickerIcon, FrameCorners, SlidersHorizontal, Eye } from '@phosphor-icons/react';
import './ChatCamera.css';
import { createCameraAnalytics } from '../../utils/cameraAnalytics';
import type { CharacterProfile } from '../../types';
import { cameraStickerSources, type CameraStickerGroup, type CameraStickerSource } from '../../utils/cameraStickerSources';
import TokenImg from '../os/TokenImg';
import { getBlobForRef, isBlobRef } from '../../utils/blobRef';
import { lightCameraSticker, trimCameraSticker } from '../../utils/cameraLighting';
import { applyCameraPhotoEffects, CAMERA_FILTERS, DEFAULT_CAMERA_EFFECTS } from '../../utils/cameraPhotoEffects';
import { CAMERA_DECORATIONS } from '../../utils/cameraDecorations';
import type { createCameraGpuEffects } from '../../utils/cameraGpuEffects';
import { CAMERA_FRAMES as FRAMES, cameraFrameLayout, drawCameraFrame } from '../../utils/cameraFrames';
import { CameraStickerGesture, type StickerTransform } from '../../utils/cameraStickerGesture';
import { cameraCaptureLayout, cameraIsPortrait } from '../../utils/cameraCapture';
import { createCameraPreview } from '../../utils/cameraPreview';
import { applyCameraZoom, cameraZoomRange, type CameraZoom } from '../../utils/cameraZoom';

const Live2DAvatarCanvas = lazy(() => import('../call/Live2DAvatarCanvas'));

type Sticker = { id: number; text: string; x: number; y: number; size: number; angle: number; image?: HTMLCanvasElement; light?: boolean; lightStrength?: number; rim?: number; softness?: number; skinWarmth?: number; opacity?: number; glow?: boolean };

export default function ChatCamera({ onClose, onGallery, onCapture, character }: {
    onClose: () => void; onGallery: () => void; onCapture: (file: File) => void; character?: CharacterProfile;
}) {
    const [mode, setMode] = useState<'choose' | 'camera'>('choose');
    const [trackCamera] = useState(createCameraAnalytics);
    const openGallery = () => { trackCamera('gallery'); onGallery(); };
    const [facing, setFacing] = useState<'user' | 'environment'>('environment');
    const [portrait, setPortrait] = useState(cameraIsPortrait);
    const [viewfinder, setViewfinder] = useState({ width: 0, height: 0 });
    const [retry, setRetry] = useState(0);
    const [ready, setReady] = useState(false);
    const [cameraTrack, setCameraTrack] = useState<MediaStreamTrack | null>(null);
    const currentCameraTrack = useRef(cameraTrack); currentCameraTrack.current = cameraTrack;
    const cameraFacing = cameraTrack?.getSettings?.().facingMode || facing;
    const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
    const [deviceId, setDeviceId] = useState('');
    const [zoom, setZoom] = useState<CameraZoom>({ min: 1, max: 3, step: 0.1, value: 1, hardware: false });
    const zoomQueue = useRef<Promise<void>>(Promise.resolve());
    const [error, setError] = useState('');
    const [cameraStatus, setCameraStatus] = useState('正在打开相机…');
    const [photo, setPhoto] = useState<HTMLCanvasElement | null>(null);
    const [frame, setFrame] = useState(0);
    const [tool, setTool] = useState<'stickers' | 'frames' | 'filters'>('stickers');
    const [effects, setEffects] = useState({ ...DEFAULT_CAMERA_EFFECTS });
    const [compareOriginal, setCompareOriginal] = useState(false);
    const [decorationGroup, setDecorationGroup] = useState('立体');
    const [gpuEffects, setGpuEffects] = useState({ dispersion: 0, miniature: 0 });
    const [rendering, setRendering] = useState(false);
    const gpu = useRef<ReturnType<typeof createCameraGpuEffects> | null>(null);
    const [stickers, setStickers] = useState<Sticker[]>([]);
    const [selected, setSelected] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [loadingSticker, setLoadingSticker] = useState(false);
    const [livePreview, setLivePreview] = useState(false);
    const [liveReady, setLiveReady] = useState(false);
    const [sourcePicker, setSourcePicker] = useState(false);
    const [sourceGroup, setSourceGroup] = useState<CameraStickerGroup>('彼方');
    const [lightRevision, setLightRevision] = useState(0);
    const lightCache = useRef(new Map<number, { key: string; image: HTMLCanvasElement }>());
    const snapshot = useRef<(() => HTMLCanvasElement) | null>(null);
    const sources = useMemo(() => cameraStickerSources(character), [character]);
    const sourceGroups = [...new Set(sources.map(s => s.group))];
    const shownGroup = sourceGroups.includes(sourceGroup) ? sourceGroup : sourceGroups[0];
    const liveConfig = character?.videoAvatar?.format === 'live2d' ? character.videoAvatar : null;
    const dialog = useRef<HTMLDivElement>(null);
    const stickerUpload = useRef<HTMLInputElement>(null);
    const video = useRef<HTMLVideoElement>(null);
    const view = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const composite = useRef<HTMLCanvasElement | null>(null);
    const preview = useMemo(() => createCameraPreview({
        video: () => video.current,
        getUserMedia: constraints => {
            if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error('当前环境无法使用站内相机，请使用 HTTPS 浏览器打开。'));
            return navigator.mediaDevices.getUserMedia(constraints);
        },
        ready: setReady, error: setError, status: setCameraStatus, track: setCameraTrack, portrait: cameraIsPortrait,
    }), []);
    const nextId = useRef(0);
    const drag = useRef<CameraStickerGesture | null>(null);
    const dragFrame = useRef<number | null>(null);
    const pendingDrag = useRef<({ id: number } & StickerTransform) | null>(null);
    const alive = useRef(true);
    const previewPhoto = useMemo(() => {
        if (!photo) return null;
        const resize = (edge: number) => {
            const small = document.createElement('canvas');
            const scale = Math.min(1, edge / Math.max(photo.width, photo.height));
            small.width = Math.max(1, Math.round(photo.width * scale)); small.height = Math.max(1, Math.round(photo.height * scale));
            small.getContext('2d')!.drawImage(photo, 0, 0, small.width, small.height);
            return small;
        };
        return {idle: resize(720), gesture: resize(360)};
    }, [photo]);
    const filterPreviews = useMemo(() => {
        if (!photo) return [];
        return CAMERA_FILTERS.map(preset => {
            const thumb = document.createElement('canvas'); thumb.width = 60; thumb.height = 76;
            thumb.getContext('2d')!.drawImage(photo, 0, 0, 60, 76);
            applyCameraPhotoEffects(thumb, { ...DEFAULT_CAMERA_EFFECTS, filter: preset.id, intensity: 1 });
            return { ...preset, preview: thumb.toDataURL('image/jpeg', 0.8) };
        });
    }, [photo]);
    const stop = () => preview.stop();

    useEffect(() => {
        if (!cameraTrack) return;
        let cancelled = false;
        const range = cameraZoomRange(cameraTrack);
        setZoom(range);
        if (range.hardware) zoomQueue.current = applyCameraZoom(cameraTrack, range.value).catch(() => {
            if (!cancelled) setZoom({ min: 1, max: 3, step: 0.1, value: 1, hardware: false });
        });
        void navigator.mediaDevices?.enumerateDevices?.().then(devices => {
            if (!cancelled) setCameras(devices.filter(device => device.kind === 'videoinput' && device.deviceId));
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [cameraTrack]);
    const changeZoom = (value: number) => {
        if (!zoom.hardware || !cameraTrack) { setZoom(current => ({ ...current, value })); return; }
        // Serialize hardware changes so an older slider request cannot finish last.
        zoomQueue.current = zoomQueue.current.catch(() => {}).then(async () => {
            if (cameraTrack.readyState !== 'live' || currentCameraTrack.current !== cameraTrack) return;
            try { await applyCameraZoom(cameraTrack, value); if(currentCameraTrack.current === cameraTrack) setZoom(current => ({ ...current, value })); }
            catch { if(currentCameraTrack.current === cameraTrack) setError('这个镜头无法调整变焦，请切换镜头或重试。'); }
        });
    };

    useEffect(() => {
        const update = () => { setPortrait(cameraIsPortrait()); preview.reframe(); };
        window.addEventListener('resize', update);
        window.addEventListener('orientationchange', update);
        screen.orientation?.addEventListener('change', update);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('orientationchange', update);
            screen.orientation?.removeEventListener('change', update);
        };
    }, []);

    useEffect(() => {
        const element = view.current;
        if (!element || mode !== 'camera') return;
        const resize = () => {
            const layout = photo ? cameraFrameLayout(photo.width, photo.height, compareOriginal ? 0 : frame) : null;
            const aspect = layout ? layout.width / layout.height : portrait ? 3 / 4 : 4 / 3;
            const width = Math.min(element.clientWidth, element.clientHeight * aspect);
            setViewfinder({ width, height: width / aspect });
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(element);
        return () => observer.disconnect();
    }, [mode, photo, portrait, frame, compareOriginal]);

    useEffect(() => {
        lightCache.current.clear();
        composite.current = null;
        drag.current = null;
        pendingDrag.current = null;
        if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
        dragFrame.current = null;
    }, [photo]);

    useEffect(() => () => {
        if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    }, []);

    useEffect(() => {
        alive.current = true;
        const previous = document.activeElement as HTMLElement | null;
        dialog.current?.focus();
        return () => { alive.current = false; stop(); previous?.focus(); const pending = gpu.current; gpu.current = null; void pending?.then(renderer => renderer.destroy()).catch(() => {}); };
    }, []);

    useEffect(() => {
        if (mode !== 'camera' || photo) return;
        let suspended = false;
        const pause = () => { suspended = true; preview.stop(); setError(''); setCameraStatus('相机已暂停，返回后恢复'); };
        const resume = () => { if (!document.hidden && suspended) { suspended = false; preview.start(facing, deviceId); } };
        const visibility = () => {
            if (document.hidden) pause(); else resume();
        };
        if (document.hidden) pause(); else preview.start(facing, deviceId);
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('pagehide', pause); window.addEventListener('pageshow', resume);
        return () => {
            preview.stop(); document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('pagehide', pause); window.removeEventListener('pageshow', resume);
        };
    }, [mode, facing, deviceId, retry, photo, preview]);

    const renderPhoto = async (display: HTMLCanvasElement, fullSize: boolean, cancelled: () => boolean) => {
        if (!photo || !previewPhoto) return;
        const base = fullSize ? photo : drag.current ? previewPhoto.gesture : previewPhoto.idle;
        const output = fullSize ? document.createElement('canvas') : (composite.current ??= document.createElement('canvas'));
        if (output.width !== base.width) output.width = base.width;
        if (output.height !== base.height) output.height = base.height;
        const ctx = output.getContext('2d');
        if (!ctx) throw new Error('无法处理照片，请重试。');
        const { width: w, height: h } = output;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(base, 0, 0, w, h);
        if (compareOriginal) { drawCameraFrame(output, display, 0); return; }
        for (const s of stickers) {
            ctx.save(); ctx.translate(s.x * w, s.y * h); ctx.rotate(s.angle * Math.PI / 180);
            ctx.globalAlpha = s.opacity ?? 1;
            if (s.glow) ctx.globalCompositeOperation = 'screen';
            if (s.image) {
                const height = s.size * Math.min(w, h), width = height * s.image.width / s.image.height;
                let image = s.image;
                if (s.light) {
                    const key = [s.x, s.y, s.size, s.angle, s.lightStrength ?? 0.7, s.rim ?? 0.4, s.softness ?? 0, s.skinWarmth ?? 0.35].join(':');
                    let cached = fullSize ? undefined : lightCache.current.get(s.id);
                    if (!cached || (cached.key !== key && !drag.current)) {
                        cached = { key, image: lightCameraSticker(s.image, photo, { x: s.x, y: s.y, width: width / w, height: height / h, angle: s.angle, strength: s.lightStrength ?? 0.7, aspect: w / h, rim: s.rim ?? 0.4, softness: s.softness ?? 0, skinWarmth: s.skinWarmth ?? 0.35 }, !fullSize) };
                        if (!fullSize) lightCache.current.set(s.id, cached);
                    }
                    image = cached.image;
                }
                ctx.drawImage(image, -width / 2, -height / 2, width, height); ctx.restore(); continue;
            }
            ctx.font = `${s.size * Math.min(w, h)}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s.text, 0, 0); ctx.restore();
        }
        applyCameraPhotoEffects(output, effects);
        if (gpuEffects.dispersion > 0 || gpuEffects.miniature > 0) {
            gpu.current ??= import('../../utils/cameraGpuEffects').then(module => module.createCameraGpuEffects());
            const renderer = await gpu.current;
            if (cancelled()) return;
            renderer.apply(output, gpuEffects.dispersion, gpuEffects.miniature);
        }
        if (cancelled()) return;
        drawCameraFrame(output, display, frame);
        for (const id of lightCache.current.keys()) if (!stickers.some(s => s.id === id)) lightCache.current.delete(id);
    };
    useEffect(() => {
        const display = canvas.current;
        if (!photo || !display || busy) return;
        let cancelled = false;
        setRendering(true);
        // Coalesce slider/gesture changes; never rebuild full-resolution effects while editing.
        const task = requestAnimationFrame(() => {
            void renderPhoto(display, false, () => cancelled).catch(() => {
                if (cancelled) return;
                if (gpuEffects.dispersion > 0 || gpuEffects.miniature > 0) {
                    setError('当前设备无法使用进阶特效，已保留原有滤镜。'); setGpuEffects({ dispersion: 0, miniature: 0 });
                } else setError('照片预览处理失败，请重试。');
            }).finally(() => { if (!cancelled) setRendering(false); });
        });
        return () => { cancelled = true; cancelAnimationFrame(task); };
    }, [photo, frame, stickers, lightRevision, effects, compareOriginal, gpuEffects, busy]);

    const capture = () => {
        const v = video.current;
        if (!v || !ready) return;
        const layout = cameraCaptureLayout(v.videoWidth, v.videoHeight, portrait, 1440, zoom.hardware ? 1 : zoom.value);
        if (!layout) return;
        const image = document.createElement('canvas');
        image.width = layout.width; image.height = layout.height;
        const ctx = image.getContext('2d');
        if (!ctx) { setError('无法处理照片，请重试。'); return; }
        if (cameraFacing === 'user') { ctx.translate(image.width, 0); ctx.scale(-1, 1); }
        ctx.drawImage(v, layout.x, layout.y, layout.sourceWidth, layout.sourceHeight, 0, 0, image.width, image.height);
        stop(); setPhoto(image); setError('');
    };
    const send = async () => {
        if (!photo || busy || compareOriginal || rendering || drag.current) return;
        setBusy(true); setError('');
        try {
            // Let the busy state paint before the one full-size export pass.
            await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
            if (!alive.current) return;
            const output = document.createElement('canvas');
            await renderPhoto(output, true, () => !alive.current);
            if (!alive.current) return;
            const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(
                result => result ? resolve(result) : reject(new Error('照片处理失败，请重试。')), 'image/jpeg', 0.9,
            ));
            if (!alive.current) return;
            onCapture(new File([blob], 'camera-photo.jpg', { type: 'image/jpeg' })); onClose();
        } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : '照片处理失败，请重试。'); }
        finally { if (alive.current) setBusy(false); }
    };
    const active = stickers.find(s => s.id === selected);
    const addImage = (source: HTMLCanvasElement, name: string, decoration?: { glow: boolean }) => {
        const image = trimCameraSticker(source), id = ++nextId.current;
        setStickers(items => items.length < 12 ? [...items, { id, text: name, x: 0.5, y: 0.55, size: decoration ? 0.22 : 0.4, angle: 0, image, glow: decoration?.glow }] : items);
        setSelected(id); setError('');
    };
    const addSource = async (item: Pick<CameraStickerSource, 'image' | 'name' | 'flip'>, decoration?: { glow: boolean }, uploaded = false) => {
        if (loadingSticker || stickers.length >= 12) return;
        setLoadingSticker(true); setError('');
        let localUrl: string | undefined;
        try {
            const image = new window.Image(); image.crossOrigin = 'anonymous';
            let sourceUrl = item.image;
            if (isBlobRef(sourceUrl)) {
                const blob = await getBlobForRef(sourceUrl);
                if (!blob) throw new Error('贴纸素材已丢失');
                sourceUrl = localUrl = URL.createObjectURL(blob);
            }
            image.src = sourceUrl;
            await image.decode();
            if (!alive.current) return;
            const source = document.createElement('canvas');
            const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
            source.width = Math.max(1, Math.round(image.naturalWidth * scale)); source.height = Math.max(1, Math.round(image.naturalHeight * scale));
            const ctx = source.getContext('2d')!;
            if (item.flip) { ctx.translate(source.width, 0); ctx.scale(-1, 1); }
            ctx.drawImage(image, 0, 0, source.width, source.height);
            addImage(source, item.name, decoration); setSourcePicker(false);
            trackCamera(uploaded ? 'upload' : decoration ? 'decoration' : 'stickers');
        } catch { if (alive.current) setError('无法读取图片，请换一张浏览器支持的图片重试；远程图片需要允许跨域读取。'); }
        finally { if (localUrl) URL.revokeObjectURL(localUrl); if (alive.current) setLoadingSticker(false); }
    };
    const uploadSticker = async (file?: File) => {
        if (!file || loadingSticker || stickers.length >= 12) return;
        if (file.size > 20 * 1024 * 1024) { setError('贴纸图片请控制在 20MB 以内。'); return; }
        if (!/^image\/(png|jpeg|webp|gif|avif)$/i.test(file.type) && !(file.type === '' && /\.(png|jpe?g|webp|gif|avif)$/i.test(file.name))) {
            setError('请选择 PNG、JPEG、WebP、GIF 或 AVIF 图片。'); return;
        }
        const url = URL.createObjectURL(file);

        try { await addSource({ image: url, name: file.name || '自定义图片' }, { glow: false }, true); }
        finally { URL.revokeObjectURL(url); }
    };
    const updateSticker = (patch: Partial<Sticker>) => setStickers(items => items.map(s => s.id === selected ? { ...s, ...patch } : s));
    const flushDrag = () => {
        dragFrame.current = null;
        const pending = pendingDrag.current;
        pendingDrag.current = null;
        if (pending) setStickers(items => items.map(s => s.id === pending.id ? { ...s, ...pending } : s));
    };
    const finishDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const gesture = drag.current;
        if (!gesture?.has(e.pointerId)) return;
        if (e.type === 'pointerup') {
            const next = gesture.move(e.pointerId, pointer(e));
            if (next) pendingDrag.current = {id: gesture.id, ...next};
        }
        if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
        flushDrag();
        gesture.remove(e.pointerId);
        if (!gesture.count) {drag.current = null; setLightRevision(n => n + 1);}
    };
    const pointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const bounds = e.currentTarget.getBoundingClientRect();
        const layout = cameraFrameLayout(photo!.width, photo!.height, frame);
        return { x: ((e.clientX - bounds.left) / bounds.width * layout.width - layout.x) / layout.photoWidth * photo!.width, y: ((e.clientY - bounds.top) / bounds.height * layout.height - layout.y) / layout.photoHeight * photo!.height };
    };
    const keyboard = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        if (e.key === 'Tab') {
            const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') || []).filter(el => el.getClientRects().length > 0);
            const first = controls[0], last = controls[controls.length - 1];
            if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
    };
    return createPortal(<div className="chat-camera-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        <div className={`chat-camera ${mode === 'choose' ? 'chat-camera-chooser' : ''}`} ref={dialog} role="dialog" aria-modal="true" aria-label={mode === 'choose' ? '选择图片来源' : '拍照'} tabIndex={-1} onKeyDown={keyboard}>
            <header><strong><Camera size={20} weight="duotone" />{mode === 'choose' ? '分享照片' : photo ? '装饰照片' : '相机'}</strong><div>{photo && <button type="button" title="按住查看原图" aria-label="按住查看原图" onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); setCompareOriginal(true); }} onPointerUp={() => setCompareOriginal(false)} onPointerCancel={() => setCompareOriginal(false)} onBlur={() => setCompareOriginal(false)} onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setCompareOriginal(true); } }} onKeyUp={() => setCompareOriginal(false)}><Eye size={22} /></button>}<button type="button" aria-label="关闭相机" title="关闭" onClick={onClose}><X size={22} /></button></div></header>
            {mode === 'choose' ? <div className="chat-camera-sources">
                <button type="button" onClick={() => { trackCamera('camera'); setMode('camera'); }}><Camera size={28} /><span>拍照</span></button>
                <button type="button" onClick={openGallery}><ImageSquare size={28} /><span>从相册选择</span></button>
            </div> : <>
                <div className="chat-camera-view" ref={view}>
                    {photo ? <canvas ref={canvas} style={{width:viewfinder.width,height:viewfinder.height}} aria-label="照片预览" onPointerDown={e => {
                        if (compareOriginal || busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
                        const p = pointer(e), w = photo.width, h = photo.height;
                        if (drag.current) {
                            if (drag.current.add(e.pointerId, p)) {e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);}
                            return;
                        }
                        const hit = [...stickers].reverse().find(s => {
                            const angle = -s.angle * Math.PI / 180, dx = p.x - s.x * w, dy = p.y - s.y * h;
                            const height = s.size * Math.min(w, h), width = height * (s.image ? s.image.width / s.image.height : 1);
                            return Math.abs(dx * Math.cos(angle) - dy * Math.sin(angle)) <= width * 0.6 && Math.abs(dx * Math.sin(angle) + dy * Math.cos(angle)) <= height * 0.6;
                        });
                        setSelected(hit?.id ?? null);
                        if (hit) {
                            drag.current = new CameraStickerGesture(hit.id, hit, w, h, hit.image ? 1.2 : 0.4);
                            drag.current.add(e.pointerId, p); e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
                        }
                    }} onPointerMove={e => {
                        const moving = drag.current;
                        if (!moving) return;
                        const next = moving.move(e.pointerId, pointer(e));
                        if (!next) return;
                        e.preventDefault(); pendingDrag.current = { id: moving.id, ...next };
                        if (dragFrame.current === null) dragFrame.current = requestAnimationFrame(flushDrag);
                    }} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={finishDrag} />
                        : <div className="chat-camera-sensor" style={{width:viewfinder.width,height:viewfinder.height}}><video ref={video} autoPlay muted playsInline style={{
                            width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'center',
                            transform: `scale(${zoom.hardware ? 1 : zoom.value})${cameraFacing === 'user' ? ' scaleX(-1)' : ''}`,
                        }} /></div>}
                    {!photo && !ready && !error && <p className="chat-camera-status" role="status">{cameraStatus}</p>}
                </div>
                {!photo && <div className="chat-camera-lenses">
                    {cameras.length > 1 && <label>镜头<select aria-label="选择摄像头" value={deviceId || cameraTrack?.getSettings?.().deviceId || ''} onChange={e => setDeviceId(e.target.value)}><option value="">自动选择</option>{cameras.map((camera, i) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label || `镜头 ${i + 1}`}</option>)}</select></label>}
                    <label>{zoom.hardware ? '变焦' : '画面缩放'}<input aria-label="相机变焦" type="range" min={zoom.min} max={zoom.max} step={zoom.step} value={zoom.value} disabled={!ready} onChange={e => changeZoom(Number(e.target.value))}/><output>{zoom.value.toFixed(1)}×</output></label>
                </div>}
                {error && <div className="chat-camera-error" role="alert">{error}{photo ? <button type="button" onClick={() => setError('')}>知道了</button> : <><button type="button" onClick={() => setRetry(n => n + 1)}>重试</button><button type="button" onClick={openGallery}>从相册选择</button></>}</div>}
                {photo && <fieldset className="chat-camera-editor" disabled={busy}>
                    {selected !== null && <p className="chat-camera-gesture-hint">单指拖动 · 双指缩放、旋转</p>}
                    <div className="chat-camera-tools" role="tablist" aria-label="照片装饰"><button type="button" role="tab" aria-selected={tool === 'stickers'} onClick={() => setTool('stickers')}><StickerIcon size={20} />贴纸</button><button type="button" role="tab" aria-selected={tool === 'frames'} onClick={() => setTool('frames')}><FrameCorners size={20} />相框</button><button type="button" role="tab" aria-selected={tool === 'filters'} onClick={() => { setTool('filters'); setLivePreview(false); }}><SlidersHorizontal size={20} />滤镜</button></div>
                    {tool === 'stickers' && <>
                    <div className="chat-camera-characters">
                        <input ref={stickerUpload} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/avif" aria-label="上传贴纸图片" onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void uploadSticker(file); }} />
                        <button type="button" disabled={loadingSticker || stickers.length >= 12} onClick={() => stickerUpload.current?.click()}><ImageSquare size={18} />上传图片</button>
                        {sources.length > 0 && <button type="button" aria-expanded={sourcePicker} disabled={loadingSticker || stickers.length >= 12} onClick={() => { setSourcePicker(v => !v); setLivePreview(false); }}>{loadingSticker ? '读取中…' : '角色贴纸'}</button>}
                        {liveConfig && <button type="button" disabled={stickers.length >= 12} onClick={() => { setLivePreview(v => !v); setLiveReady(false); }}>Live2D</button>}
                        {active?.image && <label><input type="checkbox" checked={!!active.light} onChange={e => { if (e.target.checked) trackCamera('lighting'); updateSticker({ light: e.target.checked }); }} />匹配环境光</label>}
                    </div>
                    {sourcePicker && <div className="chat-camera-source-picker">
                        <select aria-label="贴纸来源" value={shownGroup} onChange={e => setSourceGroup(e.target.value as CameraStickerGroup)}>{sourceGroups.map(group => <option key={group}>{group}</option>)}</select>
                        <div className="chat-camera-source-grid">{sources.filter(s => s.group === shownGroup).map(s => <button key={s.id} type="button" disabled={loadingSticker || stickers.length >= 12} onClick={() => void addSource(s)} title={s.name} aria-label={`添加 ${s.name}`}><TokenImg value={s.image} alt="" loading="lazy" /><span>{s.name}</span></button>)}</div>
                    </div>}
                    {livePreview && liveConfig && <div className="chat-camera-live">
                        <div className="chat-camera-live-stage"><Suspense fallback={<span>正在加载角色…</span>}><Live2DAvatarCanvas config={liveConfig} motionState="idle" ambientAutonomyDisabled preserveActiveWardrobe maxFps={24} onSnapshotReady={capture => { snapshot.current = capture; setLiveReady(!!capture); }} onError={message => { setError(message); setLiveReady(false); }} /></Suspense></div>
                        <button type="button" disabled={!liveReady} onClick={() => { try { if (snapshot.current) { addImage(snapshot.current(), 'Live2D'); trackCamera('live2d'); setLivePreview(false); } } catch (e) { setError(e instanceof Error ? e.message : '截图失败'); } }}>使用当前姿态</button>
                    </div>}
                    <div className="chat-camera-decoration-tabs" role="group" aria-label="装饰分类">{['立体', '光效'].map(group => <button type="button" key={group} aria-pressed={decorationGroup === group} onClick={() => setDecorationGroup(group)}>{group}</button>)}<a href={`${import.meta.env.BASE_URL}licenses/camera.html`} target="_blank" rel="noreferrer">素材许可</a></div>
                    <div className="chat-camera-stickers" role="group" aria-label="贴纸">{CAMERA_DECORATIONS.filter(s => s.group === decorationGroup).map(s => <button type="button" key={s.id} title={s.name} aria-label={`添加贴纸 ${s.name}`} disabled={loadingSticker || stickers.length >= 12} onClick={() => void addSource(s, { glow: s.group === '光效' })}><img className={s.group === '光效' ? 'chat-camera-glow-thumb' : ''} src={s.image} alt="" loading="lazy" /></button>)}</div>
                    </>}
                    {tool === 'frames' && <div className="chat-camera-frames" role="group" aria-label="相框">{FRAMES.map((f, i) => <button type="button" key={f.name} title={f.name} aria-label={f.name} aria-pressed={frame === i} onClick={() => { if (i) trackCamera('frames'); setFrame(i); }}><span style={{ borderColor: f.color || 'transparent', borderBottomWidth: f.format === 'mini' || f.format === 'square' ? 12 : 5, width: f.format === 'square' ? 36 : 28 }}>{!i && <X size={18} />}</span><small>{f.name}</small></button>)}</div>}
                    {tool === 'filters' && <div className="chat-camera-filters">
                        <div className="chat-camera-filter-presets">{filterPreviews.map(preset => <button type="button" key={preset.id} aria-label={`滤镜 ${preset.name}`} aria-pressed={effects.filter === preset.id} onClick={() => { if (preset.id !== 'original') trackCamera(preset.id === 'ccd' ? 'ccd' : 'filters'); setEffects(v => ({ ...v, filter: preset.id })); }}><img alt="" src={preset.preview} /><span>{preset.name}</span></button>)}</div>
                        {effects.filter !== 'original' && <label>滤镜强度<input aria-label="滤镜强度" type="range" min="0" max="1" step="0.05" value={effects.intensity} onChange={e => setEffects(v => ({ ...v, intensity: Number(e.target.value) }))} /></label>}
                        {([{ key: 'bloom', name: '高光柔光' }, { key: 'grain', name: '胶片颗粒' }, { key: 'vignette', name: '暗角' }] as const).map(({ key, name }) => <label key={key}>{name}<input aria-label={name} type="range" min="0" max="1" step="0.05" value={effects[key]} onChange={e => setEffects(v => ({ ...v, [key]: Number(e.target.value) }))} /></label>)}
                        {([{ key: 'dispersion', name: '镜头色散' }, { key: 'miniature', name: '微缩移轴' }] as const).map(({ key, name }) => <label key={key}>{name}<input aria-label={name} type="range" min="0" max="1" step="0.05" value={gpuEffects[key]} onChange={e => setGpuEffects(v => ({ ...v, [key]: Number(e.target.value) }))} /></label>)}
                        <button type="button" title="重置滤镜和光效" aria-label="重置滤镜和光效" onClick={() => { setEffects({ ...DEFAULT_CAMERA_EFFECTS }); setGpuEffects({ dispersion: 0, miniature: 0 }); }}><ArrowCounterClockwise size={18} /></button>
                    </div>}
                    {tool === 'stickers' && <>
                    {stickers.length > 0 && <div className="chat-camera-layers" aria-label="已添加的贴纸">{stickers.map((s, i) => <button type="button" key={s.id} aria-label={`选择贴纸 ${i + 1}`} aria-pressed={selected === s.id} onClick={() => setSelected(s.id)}>{s.text}</button>)}</div>}
                    {active?.image && active.light && <label className="chat-camera-light-strength">溶图强度<input aria-label="溶图强度" type="range" min="0" max="1" step="0.05" value={active.lightStrength ?? 0.7} onChange={e => updateSticker({ lightStrength: Number(e.target.value) })} /></label>}
                    {active?.image && active.light && <label className="chat-camera-light-strength">边缘光<input aria-label="边缘光" type="range" min="0" max="1" step="0.05" value={active.rim ?? 0.4} onChange={e => updateSticker({ rim: Number(e.target.value) })} /></label>}
                    {active?.image && active.light && <label className="chat-camera-light-strength">角色柔化<input aria-label="角色柔化" type="range" min="0" max="1" step="0.05" value={active.softness ?? 0} onChange={e => updateSticker({ softness: Number(e.target.value) })} /></label>}
                    {active?.image && active.light && <label className="chat-camera-light-strength">肤色暖光<input aria-label="肤色暖光" type="range" min="0" max="1" step="0.05" value={active.skinWarmth ?? 0.35} onChange={e => updateSticker({ skinWarmth: Number(e.target.value) })} /></label>}
                    {active?.image && <label className="chat-camera-light-strength">不透明度<input aria-label="贴纸不透明度" type="range" min="0.05" max="1" step="0.05" value={active.opacity ?? 1} onChange={e => updateSticker({ opacity: Number(e.target.value) })} /></label>}
                    {active && <div className="chat-camera-adjust"><label>大小<input aria-label="贴纸大小" type="range" min="0.08" max={active.image ? '1.2' : '0.4'} step="0.01" value={active.size} onChange={e => updateSticker({ size: Number(e.target.value) })} /></label><label>旋转<input aria-label="贴纸旋转" type="range" min="-180" max="180" value={active.angle} onChange={e => updateSticker({ angle: Number(e.target.value) })} /></label><button type="button" title="删除贴纸" aria-label="删除贴纸" onClick={() => { setStickers(items => items.filter(s => s.id !== selected)); setSelected(null); }}><Trash size={20} /></button></div>}
                    </>}
                </fieldset>}
                <footer>{photo ? <><button type="button" disabled={busy || loadingSticker} onClick={() => { setPhoto(null); setStickers([]); setSelected(null); setReady(false); setLivePreview(false); }}><ArrowCounterClockwise size={20} />重拍</button><button type="button" className="chat-camera-send" disabled={busy || loadingSticker || rendering || compareOriginal} onClick={send}><PaperPlaneTilt size={20} />{busy || rendering ? '处理中…' : '发送照片'}</button></> : <><button type="button" aria-label="从相册选择" title="从相册选择" onClick={openGallery}><ImageSquare size={24} /></button><button type="button" className="chat-camera-shutter" aria-label="拍摄照片" title="拍摄照片" disabled={!ready} onClick={capture}><span /></button><button type="button" aria-label="切换镜头" title="切换镜头" onClick={() => { setReady(false); setDeviceId(''); setFacing(f => f === 'user' ? 'environment' : 'user'); }}><ArrowsClockwise size={24} /></button></>}</footer>
            </>}
        </div>
    </div>, document.body);
}
