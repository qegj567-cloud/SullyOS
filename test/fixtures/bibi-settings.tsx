import React from 'react';
import {createRoot} from 'react-dom/client';
import {OSPreviewProvider} from '../../context/OSContext';
import FriendFeedApp from '../../apps/FriendFeedApp';
import {handleLocalBack} from '../../utils/localBackHandlers';

// Used by the isolated Playwright context; never mounts the live OS provider.
const many=new URLSearchParams(location.search).has('many');
const embedded=new URLSearchParams(location.search).has('embedded');
const state = {
    characters: many?Array.from({length:125},(_,i)=>({id:`preview-${i}`,name:`角色${String(i).padStart(3,'0')}`,groupId:i<60?'friends':i<120?'story':undefined,avatar:'',memories:[]})):[{id: 'preview-a', name: '阿青', avatar: '', memories: []}],
    characterGroups: [{id:'friends',name:'日常伙伴',order:1},{id:'story',name:'故事角色',order:2}],
    userProfile: {name: '小雨'}, apiPresets: [],
    closeApp: () => {document.body.dataset.closed = 'true';}, openApp: () => {},
};
window.addEventListener('keydown', event => {
    if (event.key === 'Escape') handleLocalBack();
});
createRoot(document.getElementById('root')!).render(<>
    <style>{`html,body,#root{margin:0;width:100%;height:100%;font-family:system-ui,sans-serif}:where(:root){--chrome-top:0px;--safe-bottom:0px}button,input,textarea{font-family:inherit}`}</style>
    <OSPreviewProvider value={state as React.ComponentProps<typeof OSPreviewProvider>['value']}><FriendFeedApp embedded={embedded}/></OSPreviewProvider>
</>);
