import React, {useState} from 'react';
import {readTikHubKey, saveTikHubKey} from '../utils/tikhub';
import {sourceLabel, type FriendFeedSource} from '../utils/friendFeedSource';

export function FriendFeedTikHubSettings() {
    const [hasKey, setHasKey] = useState(() => !!readTikHubKey()), [status, setStatus] = useState('');
    return <details className="friend-feed-advanced">
        <summary>旧版导入<span>兼容设置</span></summary>
        <p>TikHub 付费接入已停用，已导入的帖子仍可查看和参与圈内讨论。微博连接和绑定请在主页设置或首页「微博同步」中管理。</p>
        {hasKey && <button type="button" onClick={() => {
            try {saveTikHubKey(''); setHasKey(false); setStatus('已移除本机旧 Key');}
            catch {setStatus('移除失败，请检查浏览器存储权限');}
        }}>移除旧 Key</button>}
        {status && <p role="status">{status}</p>}
    </details>;
}

export function FriendFeedSourceQuote({source}: {source: FriendFeedSource}) {
    return <aside className="friend-feed-source">
        <div><strong>{source.author}</strong><span>{sourceLabel(source)} · 真实帖子</span></div>
        <details><summary>{source.text.slice(0, 180)}{source.text.length > 180 ? '… 展开原帖' : ' · 展开'}</summary><p>{source.text}</p></details>
        {source.truncated && <small>正文为摘录，完整内容请查看原文。</small>}
        <a href={source.url} target="_blank" rel="noopener noreferrer">查看原文 ↗</a>
    </aside>;
}

export function FriendFeedImport({onCancel}: {circleId: string; onDone: () => void; onCancel: () => void}) {
    return <div className="friend-feed-import"><h2>现实帖子接入调整中</h2>
        <p>TikHub 付费接入已停用。已导入的帖子仍然保留。</p><button type="button" onClick={onCancel}>返回</button></div>;
}
