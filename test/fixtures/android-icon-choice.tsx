import React from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor, registerPlugin } from '@capacitor/core';
// Isolated QA only: no real device API or user's OS database is accessed.
Capacitor.getPlatform = () => 'android';
Capacitor.isNativePlatform = () => true;
Capacitor.isPluginAvailable = name => name === 'LauncherIcon';
// Capacitor's registration closure still runs in a browser; provide only this fixture's web mock.
registerPlugin('LauncherIcon', { web: async () => ({
    getIcon: async () => ({ icon: sessionStorage.getItem('fixture-icon') || 'jellyfish' }),
    setIcon: async ({icon}:{icon:string}) => { sessionStorage.setItem('fixture-icon',icon); return {icon}; },
}) });
const {default:NativeAppIconEditor} = await import('../../components/appearance/NativeAppIconEditor');
createRoot(document.getElementById('root')!).render(<main style={{padding:16,maxWidth:480,margin:'auto'}}><NativeAppIconEditor/></main>);
