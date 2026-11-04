import React from 'react';
import {createRoot} from 'react-dom/client';
import {OSPreviewProvider} from '../../context/OSContext';
import FriendFeedApp from '../../apps/FriendFeedApp';
import HomePhone from '../../apps/room3d/HomePhone';
import {DB} from '../../utils/db';
import {readFriendFeed, saveFriendCircle, publishFriendPost, commentOnFriendPost} from '../../utils/friendFeed';
import type {CharacterProfile} from '../../types';
import {setProxyWorkerUrlOverride} from '../../utils/proxyWorker';
if(new URLSearchParams(location.search).get('localWeibo')==='1')setProxyWorkerUrlOverride('http://127.0.0.1:5188');
// Use a dedicated preview origin. No live API calls or model-created sample posts.
const characters = ['小白', '小绿'].map((name, i) => ({
    id: `friend-feed-preview-${i}`, name, avatar: '', description: '', systemPrompt: '', memories: [],
} as CharacterProfile));
for (const character of characters) await DB.saveCharacter(character);
const state = await readFriendFeed();
if (!state.circles.length) {
    const circleId = await saveFriendCircle({name: '下班后的客厅', description: '城市里的几位老朋友，偶尔认真生活，经常互相吐槽。', memberIds: characters.map(c => c.id)});
    const id = await publishFriendPost(circleId, '小雨', '今天终于把咖啡机研究明白了。\n先声明：上次的焦味不算。', 'preview-coffee');
    await commentOnFriendPost(id, '小雨', '杯子已经摆好，谁先来试喝？', 'preview-comment');
}
const editor = {setPhoneReply() {}, getHomeScene: () => ({present: true, roomName: '客厅'})};
createRoot(document.getElementById('root')!).render(
    <OSPreviewProvider value={{characters, userProfile: {name: '小雨'}, closeApp() {}} as any}>
        <div className="preview">
            <div className="preview-frame"><FriendFeedApp/></div>
            <div className="preview-frame preview-home"><p>家园手机 · 双入口共享预览</p><HomePhone editor={editor as any} characterId={characters[0].id} onOpenChange={() => {}}/></div>
        </div>
    </OSPreviewProvider>,
);
