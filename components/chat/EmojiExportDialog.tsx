import { trackEvent } from '../../utils/analytics';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Emoji, EmojiCategory } from '../../types';
import Modal from '../os/Modal';
import { stickerLink } from '../../utils/emojiOriginals';
import { prepareEmojiExport } from '../../utils/emojiExport';
import { shareOrDownloadBlob } from '../../utils/shareExport';

export default function EmojiExportDialog({ emojis, title = '表情包', groups, onClose }: { emojis: Emoji[]; groups?: EmojiCategory[]; title?: string; onClose: () => void }) {
    const [file, setFile] = useState<{ blob: Blob; fileName: string } | null>(null);
    const [error, setError] = useState('');
    const links = emojis.filter(e => stickerLink(e)).length;
    const [sharing, setSharing] = useState(false);
    useEffect(() => {
        let cancelled = false;
        setFile(null); setError('');
        prepareEmojiExport(emojis, title, groups).then(result => { if (!cancelled) setFile(result); }, e => { if (!cancelled) { setError(e instanceof Error ? e.message : '读取原文件失败'); trackEvent('表情导出未完成',{原因:'读取失败'}); } });
        return () => { cancelled = true; };
    }, [emojis, title, groups]);
    const share = async () => {
        if (!file || sharing) return;
        setSharing(true); setError('');
        try {
            const result = await shareOrDownloadBlob({ ...file, shareTitle: title, nativeChunked: true });
            if (result !== 'cancelled') trackEvent('导出表情原图', { 格式: file.fileName.endsWith('.zip') ? '压缩包' : '单图' });
            if (result === 'cancelled') trackEvent('表情导出未完成',{原因:'取消分享'});
            else onClose();
        } catch (e) { trackEvent('表情导出未完成',{原因:'保存失败'}); setError(e instanceof Error ? e.message : '无法拉起分享，请重试'); }
        finally { setSharing(false); }
    };
    return createPortal(<Modal isOpen title="导出表情" onClose={onClose} footer={<button disabled={!file || sharing} onClick={share} className="w-full py-3 bg-primary text-white rounded-2xl disabled:opacity-40">{sharing ? '正在分享…' : '分享 / 保存文件'}</button>}>
        <p className="text-sm text-slate-600">{file ? [emojis.length > links && `${emojis.length - links} 张本地表情随文件导出`, links > 0 && `${links} 条图床表情只导出链接`].filter(Boolean).join('，') + '。' : error ? '文件准备失败，请关闭后重试。' : '正在准备导出文件…'}</p>
        {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
    </Modal>, document.body);
}
