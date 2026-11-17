// Isolated browser context only. The harness uses the actual cloud/export/restore functions.
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider, useOS } from '../../context/OSContext';
import Settings from '../../apps/Settings';
import Chat from '../../apps/Chat';
import { AppID } from '../../types';
import { MusicProvider } from '../../context/MusicContext';
import { ActiveMsgStore } from '../../utils/activeMsgStore';
import { DB, openSpaceDB } from '../../utils/db';
import { saveUserSpaces, createSpaceStorage, rawSpaceStorage, installSpaceStorage } from '../../utils/userSpaces';
import { exportUserLocationSettings } from '../../utils/userLocationBackup';
import { USER_LOCATION_STORAGE_KEY } from '../../utils/userLocationPrivacy';
import { rememberFontDataUrl, readSavedFont } from '../../utils/fontLibrary';
import { commitSpaceRows, readSpaceStore } from '../../utils/userSpaceData';

function Harness() {
    const os = useOS();
    const showChat = new URLSearchParams(location.search).has('chat');
    useEffect(() => { if (showChat) os.openApp(AppID.Chat); }, [showChat]);
    useEffect(() => { Object.assign(window, { amsgBackupQA: { os, ActiveMsgStore, DB, openSpaceDB, saveUserSpaces, commitSpaceRows, readSpaceStore,
        rememberFontDataUrl, readSavedFont,
        setLocation: (id: string, value: unknown) => createSpaceStorage(rawSpaceStorage!, id).setItem(USER_LOCATION_STORAGE_KEY, JSON.stringify(value)),
        readLocation: (id: string) => exportUserLocationSettings(createSpaceStorage(rawSpaceStorage!, id)),
    } }); });
    return showChat ? <MusicProvider><Chat /></MusicProvider> : <Settings />;
}
installSpaceStorage();
createRoot(document.getElementById('root')!).render(<OSProvider><Harness /></OSProvider>);
