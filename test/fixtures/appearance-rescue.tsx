import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider } from '../../context/OSContext';
import { MusicProvider } from '../../context/MusicContext';
import Settings from '../../apps/Settings';
import Appearance from '../../apps/Appearance';
function App() {
    const [appearance, setAppearance] = useState(false);
    return <div className="qa-shell"><nav><button onClick={() => setAppearance(false)}>QA 设置</button> · <button onClick={() => setAppearance(true)}>QA 外观</button></nav>
        <div className="qa-app">{appearance ? <Appearance/> : <Settings/>}</div></div>;
}
createRoot(document.getElementById('root')!).render(<OSProvider><MusicProvider><App/></MusicProvider></OSProvider>);
