import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {OSPreviewProvider} from '../../context/OSContext';
import CollaborationBeautyLibrary from '../../features/collaboration/CollaborationBeautyLibrary';
import {DEFAULT_COLLABORATION_SETTINGS} from '../../features/collaboration/types';
import {CollaborationStore} from '../../features/collaboration/store';
import {validateCollaborationAppearance} from '../../features/collaboration/appearance';
import BeautyPresetPreview from '../../components/share/BeautyPresetPreview';
import {saveLibraryDecoration} from '../../utils/decorationLibrary';

if (location.port !== '5196') throw Error('协同装扮验收请使用隔离端口 5196');
const appearance=validateCollaborationAppearance({uiTheme:'midnight',customCss:'.collab-ui-root { --collab-accent: #ffb7d5; }',avatarMode:'both'});
const defaults={...DEFAULT_COLLABORATION_SETTINGS,...appearance};
const os={theme:{},characters:[],customThemes:[],customIcons:{},appearancePresets:[],registerBackHandler:()=>()=>{},closeApp:()=>{},exportAppearancePreset:async()=>new Blob(),importAppearancePreset:async()=>'',updateTheme:async()=>{}} as any;
function Fixture(){
  const [draft,setDraft]=useState(defaults),[open,setOpen]=useState(false),[status,setStatus]=useState('隔离验收，不读取真实协同任务与 API');
  const preset={format:'sullyos-chat-decoration' as const,version:1 as const,name:'午夜花园',parts:{collaboration:validateCollaborationAppearance(draft)}};
  return <OSPreviewProvider value={os}><main style={{maxWidth:440,margin:'auto',padding:16}}><h1>协同工作装扮验收</h1><p role="status">{status}</p>
    <button onClick={async()=>{await CollaborationStore.saveSettings(draft);await saveLibraryDecoration(preset,{kind:'self',credit:'测试作者'});setOpen(true);}}>打开协同装扮收藏</button>
    <BeautyPresetPreview data={preset}/>
    {open&&<CollaborationBeautyLibrary draft={draft} onClose={()=>setOpen(false)} onApplied={value=>{setDraft(old=>({...old,...value}));setStatus('已应用 '+value.uiTheme);}}/>}
  </main></OSPreviewProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
