import React, { useEffect, useState } from 'react';
import { FileText, X } from '@phosphor-icons/react';
import { DB } from '../utils/db';
import type { Emoji } from '../types';
import { SULLY_HELP_DESK_ID } from '../utils/sullyIdentity';
import type { HelpAttachment } from '../utils/sullyHelpAttachments';
import EmojiImage from './chat/EmojiImage';
import TokenImg from './os/TokenImg';

export function HelpAttachmentView({ item }: { item: HelpAttachment }) {
    if (item.kind === 'file') return <details className="s11-file">
        <summary><FileText /> {item.name}{item.clipped && ' · 节选'}</summary>
        <pre>{item.text}</pre>
    </details>;
    return <figure className={'s11-media ' + item.kind}>
        {!item.url ? <span>文字备份未包含图片，可导入媒体备份补回。</span> : item.kind === 'sticker' ? <EmojiImage value={item.url} alt={item.name} loading="lazy" />
            : <TokenImg value={item.url} alt={item.name} loading="lazy" />}
        <figcaption>{item.name}</figcaption>
    </figure>;
}

export function HelpStickerPicker({ onPick, onClose }: { onPick: (item: HelpAttachment) => void; onClose: () => void }) {
    const [items, setItems] = useState<Emoji[] | null>(null);
    const [error, setError] = useState(false);
    const [filter, setFilter] = useState('');
    const [limit, setLimit] = useState(48);
    useEffect(() => {
        let active = true;
        Promise.all([DB.getEmojis(), DB.getEmojiCategories()]).then(([library, categories]) => {
            const restricted = new Set(categories.filter(c => c.personalOnly || (c.allowedCharacterIds?.length && !c.allowedCharacterIds.includes(SULLY_HELP_DESK_ID))).map(c => c.id));
            if (active) setItems(library.filter(e => !restricted.has(e.categoryId || 'default')));
        }).catch(() => { if (active) setError(true); });
        return () => { active = false; };
    }, []);
    const matches = (items ?? []).filter(item => item.name.toLowerCase().includes(filter.trim().toLowerCase()));
    return <section className="s11-stickers" aria-label="选择表情包">
        <header><strong>表情包</strong><button type="button" aria-label="收起表情包" onClick={onClose}><X /></button></header>
        {items?.length ? <input type="search" aria-label="按名称找表情" placeholder="按名称找表情" value={filter} onChange={e => { setFilter(e.target.value); setLimit(48); }} /> : null}
        <div className="s11-sticker-list">
            {matches.slice(0, limit).map(item => <button type="button" key={item.name} onClick={() => onPick({ kind: 'sticker', name: item.name, url: item.url })}>
                <EmojiImage value={item.url} loading="lazy" alt="" /><span>{item.name}</span>
            </button>)}
        </div>
        {matches.length > limit && <button type="button" onClick={() => setLimit(n => n + 48)}>显示更多</button>}
        {!matches.length && <p>{error ? '表情包没读出来，可以收起后重试。' : !items ? '正在读取表情包…' : !items.length ? '还没有可用表情。到聊天 App 的笑脸面板添加通用表情包。' : '没找到这个名称。'}</p>}
    </section>;
}
