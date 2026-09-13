import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider, useOS } from '../../context/OSContext';
import { MusicProvider } from '../../context/MusicContext';
import Chat from '../../apps/Chat';
import { SARModuleMonitor } from '../../components/sar/SARModuleMonitor';
import { DB } from '../../utils/db';
import { AppID } from '../../types';
import { installSARModuleOnUser, installSARModuleOnCharacter } from '../../utils/vrWorld/sarModuleRuntime';
import { SAR_MODULE_CATALOG } from '../../utils/vrWorld/sarModuleShop';
(window as any).sarQA = { DB, installSARModuleOnUser, installSARModuleOnCharacter, module: SAR_MODULE_CATALOG[0] };
function App() {
    const { openApp, characters, activeCharacterId } = useOS();
    useEffect(() => { openApp(AppID.Chat); }, []);
    return characters.some(character => character.id === activeCharacterId)
        ? <><Chat/><SARModuleMonitor/></> : <p>等待角色载入</p>;
}
createRoot(document.getElementById('root')!).render(<OSProvider><MusicProvider><App/></MusicProvider></OSProvider>);
