import { PRESET_THEMES } from '../../components/chat/ChatConstants';
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {OSProvider,useOS} from '../../context/OSContext';
import {MusicProvider} from '../../context/MusicContext';
import WorldbookApp from '../../apps/WorldbookApp';
import Character from '../../apps/Character';
import CollaborationWindow from '../../features/collaboration/CollaborationWindow';
import {CollaborationStore} from '../../features/collaboration/store';
import {DEFAULT_COLLABORATION_SETTINGS} from '../../features/collaboration/types';
import {DB} from '../../utils/db';
(window as any).qaBooks={DB,CollaborationStore,DEFAULT_COLLABORATION_SETTINGS,transfers:[]};
function App(){
 const os=useOS(); const [mode,setMode]=useState('books');
 const char=os.characters.find(c=>c.id==='qa-book-char');
 return <div className="flex h-full flex-col"><nav className="shrink-0 flex gap-4 p-2">{['books','character','cowork'].map(m=><button key={m} onClick={()=>setMode(m)}>{m}</button>)}</nav><main className="relative min-h-0 flex-1">{mode==='books'?<WorldbookApp/>:mode==='character'?<Character/>:char?<CollaborationWindow open character={char} user={os.userProfile} theme={PRESET_THEMES.default} chatApi={os.apiConfig} apiPresets={[]} availableModels={[]} characters={os.characters} groups={[]} emojis={[]} emojiCategories={[]} recentChatMessages={[]} chatCollaborationEnabled={false} onClose={()=>setMode('books')} onSendToChat={async(title,messages)=>{(window as any).qaBooks.transfers.push({title,messages});}} onInstallArtifact={async()=>''} onArchiveToMemory={async()=>''} onToggleChatCollaboration={()=>{}} notify={os.addToast}/>:null}</main></div>;
}
createRoot(document.getElementById('root')!).render(<OSProvider><MusicProvider><App/></MusicProvider></OSProvider>);
