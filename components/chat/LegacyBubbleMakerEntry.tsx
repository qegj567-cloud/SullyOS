import React, {useState} from 'react';
import {useOS} from '../../context/OSContext';
import {AppID} from '../../types';
import BeautyShareChannel from '../appearance/BeautyShareChannel';

/** Compatibility for old shortcuts/backups. No separate workshop app or storage. */
export default function LegacyBubbleMakerEntry() {
  const os = useOS();
  const [,setBusy] = useState(false);
  const character = os.characters.find(item=>item.id===os.activeCharacterId)||os.characters[0];
  if (!character) return <div className="p-6"><p>气泡制作已搬到聊天装扮，先创建一个聊天角色吧。</p><button onClick={()=>os.openApp(AppID.Character)}>创建角色</button><button onClick={os.closeApp}>返回桌面</button></div>;
  // The app shell clips overflow; the wardrobe pages need their own scroller here.
  return <div className="h-full overflow-y-auto overscroll-contain">
    <BeautyShareChannel targetCharacterId={character.id} initialMaker="bubbles"
      presets={os.appearancePresets} onImport={os.importAppearancePreset} onExport={os.exportAppearancePreset}
      onBusyChange={setBusy} onBack={os.closeApp}/>
  </div>;
}
