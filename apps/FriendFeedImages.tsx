import React, {useEffect, useRef, useState} from 'react';
import {CaretLeft, CaretRight, X, MagnifyingGlassPlus, MagnifyingGlassMinus, ImageSquare} from '@phosphor-icons/react';
import {useLocalBackHandler} from '../hooks/useLocalBackHandler';
import type {FriendFeedImage} from '../utils/friendFeedSource';
import {getProxyWorkerUrl, PROXY_WORKER_CHANGED_EVENT} from '../utils/proxyWorker';
import './friendFeedImages.css';
import {isFriendImage, isLocalFriendImage} from '../utils/friendFeedImages';
import {useBlobRefUrl} from '../utils/blobRef';
import FriendFeedImageCards from './FriendFeedImageCards';
import type {FriendImageCard} from '../utils/friendFeedImages';

function Photo({image, full = false, alt}: {image: FriendFeedImage; full?: boolean; alt: string}) {
    const [failed, setFailed] = useState(0), [proxy,setProxy] = useState(getProxyWorkerUrl);
    useEffect(() => {const changed=()=>{setProxy(getProxyWorkerUrl());setFailed(0);};
        const storage=(e:StorageEvent)=>{if(e.key==='sully_proxy_worker_url_v1'||e.key===null)changed();};
        window.addEventListener(PROXY_WORKER_CHANGED_EVENT,changed);window.addEventListener('storage',storage);
        return()=>{window.removeEventListener(PROXY_WORKER_CHANGED_EVENT,changed);window.removeEventListener('storage',storage);};},[]);
    const original = full && failed < 2 ? image.url : image.thumbnail;
    const local = isLocalFriendImage(original);
    const localUrl = useBlobRefUrl(local ? original : undefined);
    const src = local ? localUrl : failed === 0 ? original : proxy.replace(/\/+$/,'')+'/weibo-image?url='+encodeURIComponent(original);
    if (failed >= 3) return <span className="ff-photo-unavailable"><ImageSquare size={24}/>图片暂时无法加载
        {full && !local && <a href={image.url} target="_blank" rel="noopener noreferrer">查看原图 ↗</a>}</span>;
    return <img src={src} alt={alt} loading={full ? 'eager' : 'lazy'} decoding="async" referrerPolicy="no-referrer"
        onError={() => setFailed(n => local ? 3 : n === 0 ? 1 : full && n === 1 && image.url !== image.thumbnail ? 2 : 3)}/>;
}

function Viewer({images, initial, onClose}: {images: FriendFeedImage[]; initial: number; onClose: () => void}) {
    const [index, setIndex] = useState(initial), [zoom, setZoom] = useState(false);
    const dialog = useRef<HTMLDialogElement>(null);
    const move = (step: number) => {setIndex(n => (n + step + images.length) % images.length); setZoom(false);};
    useLocalBackHandler(() => {onClose(); return true;}, 100);
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const element = dialog.current!; element.showModal();
        return () => {element.close(); previous?.focus();};
    }, []);
    return <dialog ref={dialog} className="ff-photo-viewer" aria-label="动态配图预览" onCancel={e => {e.preventDefault(); onClose();}}
        onClick={e => {if (e.target === e.currentTarget) onClose();}}
        onKeyDown={e => {if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {e.preventDefault(); move(e.key === 'ArrowLeft' ? -1 : 1);}}}>
        <header><button type="button" onClick={onClose} aria-label="关闭配图预览" autoFocus><X size={24}/></button>
            <span aria-live="polite">{index + 1} / {images.length}</span>
            <button type="button" onClick={() => setZoom(v => !v)} aria-label={zoom ? '缩小配图' : '放大配图'}>
                {zoom ? <MagnifyingGlassMinus size={23}/> : <MagnifyingGlassPlus size={23}/>}</button></header>
        <div className={`ff-photo-stage${zoom ? ' is-zoomed' : ''}`} key={`${index}:${zoom}`}>
            <Photo key={images[index].url} image={images[index]} full alt={`动态配图 ${index + 1}`}/>
        </div>
        {images.length > 1 && <footer><button type="button" aria-label="上一张配图" onClick={() => move(-1)}><CaretLeft size={22}/></button>
            <span>查看完整配图</span><button type="button" aria-label="下一张配图" onClick={() => move(1)}><CaretRight size={22}/></button></footer>}
    </dialog>;
}

export default function FriendFeedImages({images, imageCards, previewLimit = 9, carousel = false}: {images: FriendFeedImage[]; imageCards?:FriendImageCard[]; previewLimit?: 4 | 9; carousel?: boolean}) {
    const [opened, setOpened] = useState<number | null>(null);
    const [slide, setSlide] = useState(0), strip = useRef<HTMLDivElement>(null);
    const safe = images.filter(isFriendImage).slice(0,18);
    if (!safe.length) return <FriendFeedImageCards cards={imageCards}/>;
    const limit = carousel ? safe.length : previewLimit;
    return <><div ref={strip} className={`ff-photo-grid${carousel ? ' ff-photo-carousel' : ''}`} data-count={Math.min(safe.length,limit)} aria-label="动态配图"
        onScroll={carousel ? e => setSlide(Math.max(0, Math.min(safe.length - 1, Math.round(e.currentTarget.scrollLeft / Math.max(1, e.currentTarget.clientWidth))))) : undefined}>
        {safe.slice(0,limit).map((image, i) => <button type="button" key={`${i}:${image.url}`} aria-label={`查看配图 ${i + 1}，共 ${safe.length} 张`}
            onClick={() => setOpened(i)}><Photo image={image} alt={`动态配图 ${i + 1}`}/>
            {i === limit-1 && safe.length > limit && <span className="ff-photo-extra">+{safe.length - limit}</span>}</button>)}
    </div>{carousel && safe.length > 1 && <div className="ff-carousel-controls"><button type="button" aria-label="轮播上一张" disabled={slide === 0}
        onClick={() => strip.current?.scrollTo({left: (slide - 1) * strip.current.clientWidth})}><CaretLeft size={16}/></button><span>{slide + 1} / {safe.length} · 左右滑动</span>
        <button type="button" aria-label="轮播下一张" disabled={slide >= safe.length - 1} onClick={() => strip.current?.scrollTo({left: (slide + 1) * strip.current.clientWidth})}><CaretRight size={16}/></button></div>}
    {opened !== null && <Viewer images={safe} initial={Math.min(opened,safe.length-1)} onClose={() => setOpened(null)}/>}<FriendFeedImageCards cards={imageCards}/></>;
}
