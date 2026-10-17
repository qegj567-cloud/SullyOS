import React, {lazy, Suspense, useState} from 'react';
import {createPortal} from 'react-dom';
import {useOS} from '../../context/OSContext';
import {validateCollaborationAppearance, type CollaborationAppearance} from './appearance';
import type {CollaborationSettings} from './types';

const BeautyShareChannel = lazy(() => import('../../components/appearance/BeautyShareChannel'));

export default function CollaborationBeautyLibrary({draft, onApplied, onClose}: {
  draft: CollaborationSettings;
  onApplied: (appearance: CollaborationAppearance) => void;
  onClose: () => void;
}) {
  const {appearancePresets, exportAppearancePreset, importAppearancePreset} = useOS();
  const [busy, setBusy] = useState(false);
  return createPortal(<div role="dialog" aria-modal="true" aria-label="协同工作装扮" style={{position:'fixed',inset:0,zIndex:11000,overflowY:'auto',background:'#f5f5f5',padding:'max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))'}}>
    <Suspense fallback={<p role="status">正在打开协同工作装扮…</p>}>
      <BeautyShareChannel presets={appearancePresets} onExport={exportAppearancePreset} onImport={importAppearancePreset}
        onBusyChange={setBusy} onBack={() => {if (!busy) onClose();}} initialCategory="collaboration"
        createDraft={async () => ({format:'sullyos-chat-decoration',version:1,name:'我的协同工作',parts:{collaboration:validateCollaborationAppearance(draft)}})}
        onCollaborationApplied={onApplied}/>
    </Suspense>
  </div>, document.body);
}
