/** Static synthetic messages through the production renderer; no DB writes or API calls. */
import React from 'react';
import {createRoot} from 'react-dom/client';
import ChatMessage from '../../components/chat/MessageItem';
import {PRESET_THEMES} from '../../components/chat/ChatConstants';
import {CHAT_TYPE_SAMPLES} from '../../utils/chatPreviewFixtures';
import '../../components/chat/chatPreview.generated.css';
import type {Message} from '../../types';

const avatar = (name: string, fill: string) => 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="23" fill="${fill}"/><text x="32" y="43" text-anchor="middle" fill="#79623e" font-size="26">${name}</text></svg>`);
const rows: Message[] = [
    {...CHAT_TYPE_SAMPLES.text, id: 101, role: 'user', content: '今天下午有什么安排？'},
    {...CHAT_TYPE_SAMPLES.text, id: 102, content: '还没想好，先把手上的事情做完。'},
    {...CHAT_TYPE_SAMPLES.friend_feed_card, id: 104, metadata: {friendFeedComment: {
        kind: 'post', postId: 'sample-post', commentId: '', postAuthor: '小白',
        postExcerpt: '咖啡终于做好了。今天的第一杯，留给最早起床的人。', comment: '',
    }}},
    {...CHAT_TYPE_SAMPLES.friend_feed_card, id: 105, metadata: {friendFeedComment: {
        kind: 'received', postId: 'sample-post', commentId: 'sample-comment', postAuthor: '小白',
        postExcerpt: '咖啡终于做好了。今天的第一杯，留给最早起床的人。', comment: '小雨：给我留一杯！',
    }}},
    CHAT_TYPE_SAMPLES.friend_feed_card,
    {...CHAT_TYPE_SAMPLES.text, id: 103, role: 'user', content: '好，那我晚点再找你。'},
];
createRoot(document.getElementById('root')!).render(<main>
    <header><strong>小白</strong><small>哔哔日常 · 私聊显示预览</small></header>
    <div className="conversation">{rows.map(msg => <ChatMessage key={msg.id} msg={msg} isFirstInGroup isLastInGroup
        activeTheme={PRESET_THEMES.default} charAvatar={avatar('白', '#d9e6cb')} charName="小白" userAvatar={avatar('雨', '#f5dca1')}
        onLongPress={() => {}} onReply={() => {}} selectionMode={false} isSelected={false} onToggleSelect={() => {}}/>)}</div>
    <footer>发帖、收到评论、自己评论都以轻量记录收起。此页为静态样例，不会发表真实动态或评论。</footer>
</main>);
