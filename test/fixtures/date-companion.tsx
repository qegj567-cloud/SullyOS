import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OSPreviewProvider } from '../../context/OSContext';
import DateApp from '../../apps/DateApp';
import { DB } from '../../utils/db';
import type { CharacterProfile, SuspendedDate } from '../../types';
import { markDateEntryGuideSeen } from '../../utils/dateEntryGuide';

// Opt-in manual demo: local placeholder replies, never a production fallback.
const demo = new URLSearchParams(location.search).get('demo') === '1';
if (demo) {
    markDateEntryGuideSeen();
    const originalFetch = window.fetch.bind(window);
    let turn = 0;
    window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!url.startsWith('https://date-companion.example.invalid/')) return originalFetch(input, init);
        turn++;
        const content = `${turn === 1 ? '[happy] "茶刚泡好。今天想聊什么？"' : '[happy] "好，听你的。我们慢慢聊。"'}\n⟦ACTIONS⟧\ndaily｜接过茶，聊聊今天遇到的小事。\nplot｜（让门外响起敲门声，带来一个小变数。）\njoke｜笑着问：这杯茶是不是还附赠陪聊服务？\noppose｜把茶放下：我现在不想聊这个，换个话题吧。\n⟦/ACTIONS⟧`;
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { headers: { 'Content-Type': 'application/json' } });
    };
    import.meta.hot?.dispose(() => { window.fetch = originalFetch; });
}

// Real DateApp and IndexedDB on a test-only origin; model responses are intercepted by the browser test.
const role = { id: 'fixture-date-companion', name: '林间', avatar: '', description: '一起把这一刻慢下来', systemPrompt: '独立、有自己的想法，表达自然。', memories: [],
    dateObserve: { enabled: true }, dateVoiceEnabled: false, dateStyleConfig: { style: 'cinematic', pov: 'first-you' },
    ...(demo ? { dateActionChoicesEnabled: true, dateObserve: { enabled: false } } : {}),
} as CharacterProfile;
function App() {
    const [characters, setCharacters] = useState([role]);
    const [activeCharacterId, setActiveCharacterId] = useState(role.id);
    const [suspendedDate, suspendDate] = useState<SuspendedDate | null>(null);
    const [show, setShow] = useState(true);
    const [notice, setNotice] = useState('');
    const os = {
        theme: {}, characters, activeCharacterId, setActiveCharacterId,
        userProfile: { name: '小禾', bio: '' }, groups: [], characterGroups: [],
        apiConfig: { baseUrl: 'https://date-companion.example.invalid', apiKey: 'fixture', model: 'fixture' },
        virtualTime: { day: 'Thu', hours: 12, minutes: 0 }, realtimeConfig: {},
        addToast: setNotice, closeApp: () => setShow(false), openApp: () => setShow(false),
        updateCharacter: (id: string, patch: any) => setCharacters(previous => previous.map(c => {
            if (c.id !== id) return c;
            const next = { ...c, ...(typeof patch === 'function' ? patch(c) : patch) };
            void DB.saveCharacter(next); return next;
        })), updateUserProfile: () => {},
        registerBackHandler: () => () => {}, consumeDateAutoStart: () => {},
        suspendedDate, suspendDate, takeSuspendedDate: () => { suspendDate(null); return suspendedDate; },
    } as any;
    return <OSPreviewProvider value={os}><div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: '#111' }}>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>{show && <DateApp />}</div>
        <div style={{ flexShrink: 0, padding: 8, background: '#f5f5f5', color: '#333', fontSize: 12 }}>
            {demo && <span style={{ marginRight: 12 }}>本地演示 · 聊天与行动为占位内容</span>}
            <button onClick={() => setShow(v => !v)}>{show ? '测试挂起' : '测试恢复'}</button>
            <span role="status" style={{ marginLeft: 12 }}>{notice}</span>
            <output data-default-style>{characters[0].dateStyleConfig?.style}</output>
        </div>
    </div></OSPreviewProvider>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<App />);
import.meta.hot?.dispose(() => root.unmount());
