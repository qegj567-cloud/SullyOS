import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider, useOS } from '../../context/OSContext';
import { MusicProvider } from '../../context/MusicContext';
import Chat from '../../apps/Chat';
import Character from '../../apps/Character';
import { AppID, type CharacterProfile, type ScheduleSlot } from '../../types';
import { DB } from '../../utils/db';
import { characterLaunch } from '../../utils/characterLaunch';
import { getScheduleDateKey } from '../../utils/scheduleTime';
import { lastInnerStateKey } from '../../utils/emotionState';

const character: CharacterProfile = {
    id: 'preview-bookshop-cat', name: 'Sully-11', avatar: '/sully/sully-11.png', description: '海边书店的猫',
    systemPrompt: '你住在旧港口的书店。熟客推门时，先把窗边的位置让出来。说话简短，喜欢留意别人随口提过的小事。',
    worldview: '书店临海，楼下卖旧书，阁楼留给读者。每晚打烊前，猫会在朝着灯塔的窗台放一杯温水。',
    memories: [], timeAwarenessEnabled: true, customTimezoneEnabled: true, customTimezone: 'Asia/Shanghai',
    lifeRecordEnabled: true, scheduleFeatureEnabled: true, scheduleStyle: 'lifestyle', emotionConfig: { enabled: true },
    activeBuffs: [
        { id: 'expectant', name: 'expectant', label: '悄悄的期待', description: '门铃一响，耳朵先于目光转向了门口。', intensity: 1 },
        { id: 'peaceful', name: 'peaceful', label: '雨后的松弛', description: '窗子透进了凉风，书页正好翻到折过角的地方。', intensity: 1 },
    ],
};
const scenes = [
    { startTime: '00:00', activity: '整理夜读手稿', location: '书店阁楼', description: '把散落的页码理顺，给没写完的那封信留一盏灯。', lines: ['[夜灯] 最后一盏灯落在稿纸上，铅笔在边缘滚了半圈。', '[专注] 猫用爪子按住第七页，把折角轻轻抚平。', '[窗外] 港口传来一声船笛。它抬了抬耳朵，把那半句话留到明天。'] },
    { startTime: '08:30', activity: '开门迎客', location: '临街书店', description: '翻过营业牌，把昨天修好的旧书摆回橱窗。', lines: ['[晨光] 木门被推开，门铃轻轻碰了两下。', '[窗台] 它把那本修好的书往阳光里挪了一寸。'] },
    { startTime: '15:00', activity: '去码头收信', location: '旧码头', description: '沿着石阶走到信箱，取回寄给书店的明信片。', lines: ['[海风] 它在石阶上停住，伸手护住差点吹走的明信片。', '[背面] 明信片上只写着一句，下次还来。'] },
    { startTime: '21:00', activity: '灯下读书', location: '靠窗的座位', description: '抄下一句喜欢的话，夹进今晚的书签。', lines: ['[灯下] 它把额头靠在椅背上，读到第三行又折了回来。', '[铅笔] 那句话最后落在一张旧船票的背面。'] },
];
const sampleApi = location.origin + '/__profile_sample/v1';
const tabParam = new URLSearchParams(location.search).get('tab');
const initialTab = tabParam === 'settings' ? '设定' : tabParam === 'schedule' ? '日程' : '当前';

async function prepareExample() {
    const previous = (await DB.getAllCharacters()).find(c => c.id === character.id);
    if (!previous) {
        await DB.saveCharacter(character);
        await DB.saveMessage({ charId: character.id, role: 'assistant', type: 'text', content: '窗边的位置给你留着。' });
        localStorage.setItem(lastInnerStateKey(character.id), '雨停了一会儿，我才发现自己还撑着伞。要是你现在路过，我大概会把伞往你那边挪一点。');
    }
    const date = getScheduleDateKey(previous || character);
    if (!await DB.getDailySchedule(character.id, date)) {
        const slots: ScheduleSlot[] = scenes.map(({ lines, ...slot }, i) => i === 1
            ? { ...slot, theater: { generatedAt: Date.now(), lines: lines.map(text => ({ text: text.replace(/^\[.*?\]\s*/, '') })) } }
            : slot);
        await DB.saveDailySchedule({ id: `${character.id}_${date}`, charId: character.id, date, generatedAt: Date.now(), slots });
    }
    localStorage.setItem('os_last_active_char_id', character.id);
    localStorage.setItem('os_api_config', JSON.stringify({ baseUrl: sampleApi, apiKey: 'local-preview', model: '示例演出' }));
    localStorage.setItem('os_realtime_config', JSON.stringify({ weatherEnabled: false, newsEnabled: false }));
}

// Only the response bytes are a sample. Chat builds the request, parses the lines and saves the performance.
const fetchLocal = window.fetch.bind(window);
window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.href !== sampleApi + '/chat/completions') return fetchLocal(input, init);
    const body = await new Request(input, init).json();
    const prompt = body.messages?.at(-1)?.content;
    const scene = scenes.find(s => typeof prompt === 'string' && prompt.includes(`正在「${s.activity}」`));
    if (!scene) return Response.json({ error: { message: '本预览的示例接口只提供日程小剧场。' } }, { status: 400 });
    return Response.json({ choices: [{ message: { role: 'assistant', content: scene.lines.join('\n') } }] });
};

function Preview() {
    const { activeApp, openApp, isDataLoaded, characters } = useOS();
    const chatHost = useRef<HTMLElement>(null);
    useEffect(() => { openApp(AppID.Chat); }, []);
    const ready = isDataLoaded && characters.some(c => c.id === character.id);
    // Exercise the actual avatar entry. Stop as soon as the requested tab is open.
    useEffect(() => {
        const root = chatHost.current;
        if (!ready || activeApp !== AppID.Chat || !root) return;
        const launch = () => {
            const tab = root.querySelector<HTMLButtonElement>(`[role="tab"][data-tab="${initialTab}"]`);
            if (tab) { observer.disconnect(); tab.click(); }
            else root.querySelector<HTMLButtonElement>('.sully-chat-message-avatar-slot button[aria-label$="的角色名片"]')?.click();
        };
        const observer = new MutationObserver(launch);
        observer.observe(root, { childList: true, subtree: true });
        launch();
        return () => observer.disconnect();
    }, [activeApp, ready]);
    return <>
        <nav><small>示例角色 · 本地演出</small><button onClick={() => openApp(AppID.Chat)}>聊天</button>
            <button onClick={() => { characterLaunch.request({ charId: character.id, detailTab: 'identity' }); openApp(AppID.Character); }}>神经链接</button>
        </nav>
        <main ref={chatHost}>{ready && (activeApp === AppID.Character ? <Character /> : activeApp === AppID.Chat ? <Chat /> : null)}</main>
    </>;
}

const root = createRoot(document.getElementById('root')!);
prepareExample().then(() => root.render(<OSProvider><MusicProvider><Preview /></MusicProvider></OSProvider>))
    .catch(error => root.render(<p>预览载入失败。{String(error)}</p>));
