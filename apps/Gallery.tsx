
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { GalleryImage, CharacterProfile } from '../types';
import { safeResponseJson } from '../utils/safeApi';
import ConfirmDialog from '../components/os/ConfirmDialog';
import TokenImg from '../components/os/TokenImg';
import { trackEvent } from '../utils/analytics';
import { Star } from '@phosphor-icons/react';
import {
    CONTENT_FAVORITES_CHANGED_EVENT,
    getContentFavoriteById,
    makeImageContentFavoriteId,
    removeContentFavoriteById,
    saveGalleryImageContentFavorite,
} from '../utils/contentFavorites';

const Gallery: React.FC = () => {
    const { closeApp, characters, apiConfig, addToast } = useOS();
    const [view, setView] = useState<'albums' | 'grid' | 'detail'>('albums');
    const [activeCharId, setActiveCharId] = useState<string | null>(null);
    useAppShortcut(ShortcutAppID.Gallery, intent => {
        if (activeCharId !== intent.characterId) setImages([]);
        setSelectedImage(null); setActiveCharId(intent.characterId || null);
        setView(intent.characterId ? 'grid' : 'albums');
    });
    const [images, setImages] = useState<GalleryImage[]>([]);
    const [selectedImage, setSelectedImage] = useState<GalleryImage | null>(null);
    const [isReviewing, setIsReviewing] = useState(false);
    const [showChatContext, setShowChatContext] = useState(false);
    const [imageFavorited, setImageFavorited] = useState(false);

    // Long-press delete state
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [confirmDialog, setConfirmDialog] = useState<{ isOpen: boolean; title: string; message: string; variant: 'danger' | 'warning' | 'info'; onConfirm: () => void; } | null>(null);

    // Album image counts
    const [albumCounts, setAlbumCounts] = useState<Record<string, number>>({});

    useEffect(() => {
        // Load image counts for all characters
        const loadCounts = async () => {
            const counts: Record<string, number> = {};
            for (const char of characters) {
                const imgs = await DB.getGalleryImages(char.id);
                counts[char.id] = imgs.length;
            }
            setAlbumCounts(counts);
        };
        if (view === 'albums') loadCounts();
    }, [characters, view]);

    useEffect(() => {
        if (activeCharId) {
            DB.getGalleryImages(activeCharId).then(imgs => {
                setImages(imgs.sort((a, b) => b.timestamp - a.timestamp));
            });
        }
    }, [activeCharId]);

    const handleCharClick = (id: string) => {
        setActiveCharId(id);
        setView('grid');
        trackEvent('打开角色相册');
    };

    const handleImageClick = (img: GalleryImage) => {
        setSelectedImage(img);
        setView('detail');
    };

    const refreshSelectedFavorite = useCallback(async () => {
        if (!selectedImage) {
            setImageFavorited(false);
            return;
        }
        const favorite = await getContentFavoriteById(makeImageContentFavoriteId(selectedImage.url)).catch(() => null);
        setImageFavorited(!!favorite);
    }, [selectedImage?.id]);

    useEffect(() => {
        void refreshSelectedFavorite();
        window.addEventListener(CONTENT_FAVORITES_CHANGED_EVENT, refreshSelectedFavorite);
        return () => window.removeEventListener(CONTENT_FAVORITES_CHANGED_EVENT, refreshSelectedFavorite);
    }, [refreshSelectedFavorite]);

    const handleToggleImageFavorite = async () => {
        if (!selectedImage) return;
        const favoriteId = makeImageContentFavoriteId(selectedImage.url);
        try {
            if (imageFavorited) {
                await removeContentFavoriteById(favoriteId);
                setImageFavorited(false);
                addToast('已取消收藏图片', 'info');
                return;
            }
            const charName = characters.find(character => character.id === selectedImage.charId)?.name || '未知角色';
            await saveGalleryImageContentFavorite(selectedImage, charName);
            setImageFavorited(true);
            addToast('已收藏图片（仅保存引用）', 'success');
            trackEvent('收藏相册图片');
        } catch (error) {
            console.warn('[Gallery] favorite image failed', error);
            addToast('收藏失败，请稍后重试', 'error');
        }
    };

    const handleBack = () => {
        if (view === 'detail') { setView('grid'); setShowChatContext(false); }
        else if (view === 'grid') { setView('albums'); setActiveCharId(null); }
        else closeApp();
    };

    // Long-press handlers for album deletion
    const handleAlbumPressStart = useCallback((charId: string) => {
        longPressTimer.current = setTimeout(() => {
            const char = characters.find(c => c.id === charId);
            setConfirmDialog({
                isOpen: true,
                title: '删除相册',
                message: `确定要删除「${char?.name || ''}」的所有照片吗？此操作无法撤销。`,
                variant: 'danger',
                onConfirm: async () => {
                    const imgs = await DB.getGalleryImages(charId);
                    for (const img of imgs) {
                        await DB.deleteGalleryImage(img.id);
                    }
                    setAlbumCounts(prev => ({ ...prev, [charId]: 0 }));
                    addToast('相册已清空', 'success');
                    trackEvent('清空一个角色的相册');
                    setConfirmDialog(null);
                }
            });
        }, 600);
    }, [characters, addToast]);

    const handleAlbumPressEnd = useCallback(() => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    }, []);

    // Delete single image
    const handleDeleteImage = async () => {
        if (!selectedImage) return;
        setConfirmDialog({
            isOpen: true,
            title: '删除照片',
            message: '确定要删除这张照片吗？',
            variant: 'danger',
            onConfirm: async () => {
                await DB.deleteGalleryImage(selectedImage.id);
                setImages(prev => prev.filter(img => img.id !== selectedImage.id));
                setView('grid');
                setSelectedImage(null);
                addToast('照片已删除', 'success');
                trackEvent('删除一张照片');
                setConfirmDialog(null);
            }
        });
    };

    const handleReview = async () => {
        if (!selectedImage || !activeCharId || !apiConfig.apiKey) {
            addToast('缺少配置或图片信息', 'error');
            return;
        }

        const char = characters.find(c => c.id === activeCharId);
        if (!char) return;

        setIsReviewing(true);
        trackEvent('让角色点评这张照片');
        try {
            // Build context-aware prompt
            const chatContextStr = selectedImage.chatContext?.length
                ? `\n\nContext: This photo was shared during a conversation. Here's what was being discussed:\n${selectedImage.chatContext.join('\n')}\n\nIMPORTANT: Your comment should feel natural given the conversation context above. Do NOT say things that contradict or are completely unrelated to what was being talked about.`
                : '';

            const dateStr = selectedImage.savedDate
                ? `\nThis photo is from ${selectedImage.savedDate}.`
                : '';

            const systemContent = `You are ${char.name}. ${char.systemPrompt || 'You are a helpful assistant.'}
Task: The user sent you a photo. Comment on it briefly (1-3 sentences) based on your personality.${dateStr}${chatContextStr}
Style: Casual, conversational, strictly NO AI-assistant tone. React as if you received this on a chat app.
CRITICAL: Stay in character. If there's conversation context, your comment should naturally fit that context. Don't say anything that would be bizarre given what you two were just talking about.`;

            const payload = {
                model: apiConfig.model,
                messages: [
                    { role: 'system', content: systemContent },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: "Look at this photo I sent you." },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: selectedImage.url
                                }
                            }
                        ]
                    }
                ],
                max_tokens: 8000,
                temperature: 0.7,
                stream: false
            };

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiConfig.apiKey}`
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                let errorMsg = `HTTP Error ${response.status}`;
                try {
                    const errData = await safeResponseJson(response);
                    errorMsg = errData.error?.message || JSON.stringify(errData.error) || errorMsg;
                    if (errorMsg.includes('vision') || errorMsg.includes('image')) {
                        errorMsg = '当前模型可能不支持图片识别(Vision)，请切换模型。';
                    }
                } catch (e) {
                    const text = await response.text();
                    if(text) errorMsg = text.slice(0, 100);
                }
                throw new Error(errorMsg);
            }

            const data = await safeResponseJson(response);
            const choice = data.choices?.[0];

            if (choice?.finish_reason === 'content_filter') {
                throw new Error('AI 拒绝回复 (图片可能包含敏感内容)');
            }

            let reviewText = choice?.message?.content;
            if (!reviewText && choice?.message?.reasoning_content) {
                reviewText = choice.message.reasoning_content;
            }
            if (!reviewText && choice?.text) reviewText = choice.text;
            if (!reviewText && choice?.delta?.content) reviewText = choice.delta.content;

            if (!reviewText) {
                const debugStr = JSON.stringify(choice || data);
                console.warn('AI Empty Response Structure:', data);
                throw new Error(`AI 返回内容为空. Raw: ${debugStr.substring(0, 100)}...`);
            }

            await DB.updateGalleryImageReview(selectedImage.id, reviewText);

            const updatedImage = { ...selectedImage, review: reviewText, reviewTimestamp: Date.now() };
            setSelectedImage(updatedImage);
            setImages(prev => prev.map(img => img.id === selectedImage.id ? updatedImage : img));

            addToast('点评生成成功', 'success');

        } catch (e: any) {
            console.error('Review Error:', e);
            addToast(`点评失败: ${e.message}`, 'error');
        } finally {
            setIsReviewing(false);
        }
    };

    // --- Sub-Components ---

    const [imgStatus, setImgStatus] = useState<Record<string, 'loading' | 'loaded' | 'error'>>({});

    const getCharGradient = (name: string): string => {
        const gradients = [
            'linear-gradient(to bottom right, #fb7185, #ec4899)',
            'linear-gradient(to bottom right, #a78bfa, #8b5cf6)',
            'linear-gradient(to bottom right, #60a5fa, #6366f1)',
            'linear-gradient(to bottom right, #22d3ee, #14b8a6)',
            'linear-gradient(to bottom right, #34d399, #22c55e)',
            'linear-gradient(to bottom right, #fbbf24, #f97316)',
            'linear-gradient(to bottom right, #f87171, #f43f5e)',
            'linear-gradient(to bottom right, #e879f9, #ec4899)',
        ];
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        return gradients[Math.abs(hash) % gradients.length];
    };

    const renderAlbums = () => (
        <div className="grid grid-cols-2 gap-5 p-5 animate-fade-in">
            {characters.map(char => {
                const count = albumCounts[char.id] || 0;
                const status = imgStatus[char.id] || 'loading';
                return (
                    <button
                        key={char.id}
                        onClick={() => handleCharClick(char.id)}
                        onTouchStart={() => handleAlbumPressStart(char.id)}
                        onTouchEnd={handleAlbumPressEnd}
                        onTouchCancel={handleAlbumPressEnd}
                        onMouseDown={() => handleAlbumPressStart(char.id)}
                        onMouseUp={handleAlbumPressEnd}
                        onMouseLeave={handleAlbumPressEnd}
                        className="flex flex-col gap-2.5 group active:scale-95 transition-all"
                    >
                        {/* Use w-full + padding-bottom hack for aspect ratio (better mobile compat than aspect-square) */}
                        <div className="w-full relative rounded-3xl shadow-md overflow-hidden border border-white/60" style={{ paddingBottom: '100%', backgroundImage: getCharGradient(char.name), backgroundColor: '#94a3b8' }}>
                            {/* Always-visible fallback: character initial + name color bg */}
                            <div className="absolute inset-0 z-0 flex items-center justify-center pointer-events-none">
                                <span className="text-white/60 text-5xl font-bold select-none drop-shadow-md">{char.name.charAt(0)}</span>
                            </div>
                            {/* Image layer - hidden until loaded to prevent blank rectangles on mobile */}
                            {status !== 'error' && (
                                <TokenImg
                                    value={char.avatar}
                                    alt={char.name}
                                    className={`absolute inset-0 w-full h-full object-cover z-10 transition-opacity duration-300 group-hover:scale-105 ${status === 'loaded' ? 'opacity-90 group-hover:opacity-100' : 'opacity-0'}`}
                                    loading="lazy"
                                    decoding="async"
                                    onLoad={() => setImgStatus(prev => ({ ...prev, [char.id]: 'loaded' }))}
                                    onError={() => setImgStatus(prev => ({ ...prev, [char.id]: 'error' }))}
                                />
                            )}
                            <div className="absolute inset-0 z-20 bg-gradient-to-t from-black/60 via-black/10 to-transparent"></div>
                            <div className="absolute bottom-0 left-0 right-0 z-30 px-3 pb-2.5 pt-6 bg-gradient-to-t from-black/50 to-transparent flex items-end justify-between">
                                <span className="text-white text-sm font-bold drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">{char.name}</span>
                                {count > 0 && <span className="text-white/90 text-[10px] font-mono bg-black/40 backdrop-blur-sm px-2 py-0.5 rounded-full">{count}</span>}
                            </div>
                        </div>
                    </button>
                );
            })}
            {characters.length === 0 && <div className="col-span-2 text-center text-slate-400 py-16 text-xs">暂无角色相册</div>}
        </div>
    );

    const renderGrid = () => (
        <div className="flex-1 overflow-y-auto p-1.5 animate-fade-in">
            {images.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-300 gap-3 py-20">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor" className="w-14 h-14 opacity-40"><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
                    <span className="text-sm">还没有照片</span>
                </div>
            ) : (
                <div className="grid grid-cols-3 gap-1">
                    {images.map(img => (
                        <div key={img.id} onClick={() => handleImageClick(img)} className="aspect-square bg-slate-100 relative cursor-pointer overflow-hidden rounded-sm">
                            {/* 相册图存的是 blobref 令牌（见 utils/blobRef.ts），TokenImg 会解析成 objectURL；
                                旧的 base64 / http 图原样透传，两种都显示得出来 */}
                            <TokenImg value={img.url} className="w-full h-full object-cover hover:scale-105 transition-transform duration-300" loading="lazy" />
                            {img.review && <div className="absolute top-1.5 right-1.5 w-2 h-2 bg-primary rounded-full ring-2 ring-white shadow-sm"></div>}
                            {img.savedDate && <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/50 to-transparent px-1.5 pb-1 pt-3"><span className="text-[8px] text-white/80 font-mono">{img.savedDate}</span></div>}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    const renderDetail = () => selectedImage && (
        <div className="flex flex-col h-full bg-black relative animate-fade-in">
            {/* Header */}
            <div className="absolute top-0 left-0 w-full p-4 flex justify-between items-start z-50 pointer-events-none" style={{ paddingTop: 'max(1rem, var(--safe-top))' }}>
                <button onClick={() => setView('grid')} className="text-white bg-black/40 backdrop-blur-md p-2 rounded-full pointer-events-auto active:scale-95 transition-transform hover:bg-black/60 border border-white/10">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                </button>
                <div className="flex items-center gap-2 pointer-events-auto">
                    <button onClick={() => void handleToggleImageFavorite()} className={`text-white backdrop-blur-md p-2 rounded-full active:scale-95 transition-transform border border-white/10 ${imageFavorited ? 'bg-amber-500/80' : 'bg-black/40 hover:bg-black/60'}`} aria-label={imageFavorited ? '取消收藏图片' : '收藏图片'}>
                        <Star size={20} weight={imageFavorited ? 'fill' : 'regular'} />
                    </button>
                    <button onClick={handleDeleteImage} className="text-white bg-black/40 backdrop-blur-md p-2 rounded-full active:scale-95 transition-transform hover:bg-red-600/60 border border-white/10">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                    </button>
                </div>
            </div>

            {/* Date badge */}
            {selectedImage.savedDate && (
                <div className="absolute left-1/2 -translate-x-1/2 z-50" style={{ top: 'max(4rem, calc(var(--safe-top) + 0.5rem))' }}>
                    <span className="text-[10px] text-white/60 bg-black/40 backdrop-blur-sm px-3 py-1 rounded-full font-mono">{selectedImage.savedDate}</span>
                </div>
            )}

            {/* Main Image */}
            <div className="flex-1 min-h-0 w-full flex items-center justify-center bg-black relative overflow-hidden">
                <TokenImg
                    value={selectedImage.url}
                    className="max-w-full max-h-full object-contain"
                    alt="Detail"
                />
            </div>

            {/* Review & Context Section */}
            <div className="shrink-0 w-full bg-[#161616] border-t border-white/10 z-40 pb-safe">
                {selectedImage.review ? (
                    <div className="p-5 animate-slide-up">
                        <div className="flex items-start gap-3 mb-3">
                            <TokenImg value={characters.find(c => c.id === activeCharId)?.avatar} className="w-9 h-9 rounded-full border border-white/20 object-cover shadow-sm" />
                            <div className="flex-1">
                                <div className="text-xs font-bold text-white/50 mb-1.5 uppercase tracking-wide">{characters.find(c => c.id === activeCharId)?.name} 的点评</div>
                                <p className="text-[15px] text-white/90 leading-relaxed font-light select-text">"{selectedImage.review}"</p>
                            </div>
                        </div>
                        <div className="flex justify-between items-center border-t border-white/5 pt-2 mt-2">
                            {selectedImage.chatContext && selectedImage.chatContext.length > 0 && (
                                <button onClick={() => setShowChatContext(!showChatContext)} className="text-[10px] text-white/30 hover:text-white/60 transition-colors flex items-center gap-1 px-2 py-1">
                                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" /></svg>
                                    {showChatContext ? '收起对话' : '当时的对话'}
                                </button>
                            )}
                            <button onClick={handleReview} disabled={isReviewing} className="text-[10px] text-white/40 hover:text-primary transition-colors flex items-center gap-1 px-2 py-1 ml-auto">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                                {isReviewing ? 'Thinking...' : '重新生成'}
                            </button>
                        </div>
                        {/* Chat context expandable */}
                        {showChatContext && selectedImage.chatContext && (
                            <div className="mt-3 bg-white/5 rounded-xl p-3 space-y-1.5 max-h-40 overflow-y-auto">
                                <div className="text-[9px] text-white/30 uppercase tracking-wider mb-2 font-bold">拍照时的对话记录</div>
                                {selectedImage.chatContext.map((line, i) => (
                                    <div key={i} className="text-[11px] text-white/50 leading-relaxed">{line}</div>
                                ))}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="p-5 flex flex-col items-center gap-3">
                        <button
                            onClick={handleReview}
                            disabled={isReviewing}
                            className="bg-white text-black px-6 py-3 rounded-full text-sm font-bold shadow-[0_0_20px_rgba(255,255,255,0.15)] active:scale-95 transition-transform flex items-center gap-2 hover:bg-slate-200"
                        >
                            {isReviewing ? (
                                <><div className="w-4 h-4 border-2 border-slate-300 border-t-black rounded-full animate-spin"></div> 正在思考...</>
                            ) : (
                                <>让 TA 点评照片</>
                            )}
                        </button>
                        {selectedImage.chatContext && selectedImage.chatContext.length > 0 && (
                            <button onClick={() => setShowChatContext(!showChatContext)} className="text-[10px] text-white/30 hover:text-white/50 transition-colors">
                                {showChatContext ? '收起对话记录' : '查看当时的对话'}
                            </button>
                        )}
                        {showChatContext && selectedImage.chatContext && (
                            <div className="w-full bg-white/5 rounded-xl p-3 space-y-1.5 max-h-40 overflow-y-auto">
                                <div className="text-[9px] text-white/30 uppercase tracking-wider mb-2 font-bold">拍照时的对话记录</div>
                                {selectedImage.chatContext.map((line, i) => (
                                    <div key={i} className="text-[11px] text-white/50 leading-relaxed">{line}</div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col font-light relative">
            <ConfirmDialog isOpen={!!confirmDialog} title={confirmDialog?.title || ''} message={confirmDialog?.message || ''} variant={confirmDialog?.variant} confirmText="确认" onConfirm={confirmDialog?.onConfirm || (() => setConfirmDialog(null))} onCancel={() => setConfirmDialog(null)} />

            {/* Header */}
            {view !== 'detail' && (
                <div className="bg-white/80 backdrop-blur-xl border-b border-slate-100/60 shrink-0 z-10 sticky top-0" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="h-16 flex items-center px-4">
                        <button onClick={handleBack} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <h1 className="text-lg font-semibold text-slate-800 ml-2 tracking-tight">
                            {view === 'albums' ? '相册' : characters.find(c => c.id === activeCharId)?.name || '相册'}
                        </h1>
                        {view === 'grid' && <span className="text-xs text-slate-400 ml-2 font-mono">{images.length}</span>}
                    </div>
                </div>
            )}

            {view === 'albums' && <div className="flex-1 overflow-y-auto min-h-0">{renderAlbums()}</div>}
            {view === 'grid' && renderGrid()}
            {view === 'detail' && renderDetail()}
        </div>
    );
};

export default Gallery;
import { useAppShortcut } from '../utils/appShortcutLaunch';
import { AppID as ShortcutAppID } from '../types';
