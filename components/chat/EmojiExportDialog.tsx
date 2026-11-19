import { trackEvent } from '../../utils/analytics';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Emoji } from '../../types';
import Modal from '../os/Modal';
import { prepareEmojiExport } from '../../utils/emojiExport';
import { shareOrDownloadBlob } from '../../utils/shareExport';

export default function EmojiExportDialog({ emojis, title = '表情包', onClose }: { emojis: Pick<Emoji, 'name' | 'url'>[]; title?: string; onClose: () => void }) {
    const [file, setFile] = useState<{ blob: Blob; fileName: string } | null>(null);
    const [error, setError] = useState('');
    const [sharing, setSharing] = useState(false);
    useEffect(() => {
        let cancelled = false;
        setFile(null); setError('');
        prepareEmojiExport(emojis, title).then(result => { if (!cancelled) setFile(result); }, e => { if (!cancelled) setError(e instanceof Error ? e.message : '读取原文件失败'); });
        return () => { cancelled = true; };
    }, [emojis, title]);
    const share = async () => {
        if (!file || sharing) return;
        setSharing(true); setError('');
        try {
            const result = await shareOrDownloadBlob({ ...file, shareTitle: title, nativeChunked: true });
            if (result !== 'cancelled') trackEvent('导出表情原图', { 格式: emojis.length === 1 ? '单图' : '压缩包' });
            if (result !== 'cancelled') onClose();
        } catch (e) { setError(e instanceof Error ? e.message : '无法拉起分享，请重试'); }
        finally { setSharing(false); }
    };
    return createPortal(<Modal isOpen title="下载表情原图" onClose={onClose} footer={<button disabled={!file || sharing} onClick={share} className="w-full py-3 bg-primary text-white rounded-2xl disabled:opacity-40">{sharing ? '正在分享…' : '分享 / 保存文件'}</button>}>
        <p className="text-sm text-slate-600">{file ? `${emojis.length} 张表情已准备好。${emojis.length > 1 ? 'ZIP 内保留每张图片的原始格式与动图。' : '保留原始格式与动图。'}` : error ? '文件准备失败，请关闭后重试。' : '正在读取表情原文件…'}</p>
        {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
    </Modal>, document.body);
}
