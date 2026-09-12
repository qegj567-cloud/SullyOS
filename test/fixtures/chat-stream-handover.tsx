import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider, useOS } from '../../context/OSContext';
import { MusicProvider } from '../../context/MusicContext';
import Chat from '../../apps/Chat';
import { DB } from '../../utils/db';
import { AppID } from '../../types';

// Test-only gate: delay each persisted bubble so intermediate renders can be inspected.
const gate = { enabled: false, attempts: 0, failAt: 0, release: null as null | (() => void) };
const saveMessage = DB.saveMessage;
DB.saveMessage = async message => {
    if (gate.enabled && message.charId === 'qa-stream' && message.role === 'assistant') {
        gate.attempts++;
        if (gate.attempts > 1) await new Promise<void>(resolve => { gate.release = resolve; });
        if (gate.attempts === gate.failAt) throw new Error('QA simulated persistence failure');
    }
    return saveMessage(message);
};
(window as any).streamQA = { DB, gate };
function App() {
    const { openApp, characters, activeCharacterId } = useOS();
    useEffect(() => { openApp(AppID.Chat); }, []);
    return characters.some(character => character.id === activeCharacterId) ? <Chat/> : <p>等待角色载入</p>;
}
createRoot(document.getElementById('root')!).render(<OSProvider><MusicProvider><App/></MusicProvider></OSProvider>);
