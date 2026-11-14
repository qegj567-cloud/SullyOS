import React, {useState, type ComponentProps} from 'react';
import {createPortal} from 'react-dom';
import {useOS} from '../../context/OSContext';
import BeautyShareChannel from '../appearance/BeautyShareChannel';
import ChatDecorationPanel from './ChatDecorationPanel';
import {exportDecoration} from '../../utils/chatDecoration';

/** Chat and Appearance share one library; only the application target differs. */
export default function ChatAppearanceWardrobe(props: ComponentProps<typeof ChatDecorationPanel>) {
  const {appearancePresets, exportAppearancePreset, importAppearancePreset} = useOS();
  const [busy, setBusy] = useState(false);
  return createPortal(<div className="chat-appearance-wardrobe text-slate-800" role="dialog" aria-modal="true" aria-label={`给 ${props.character.name} 换装`} onKeyDown={event => {if(event.key === 'Escape' && !busy && event.target === event.currentTarget){event.stopPropagation();props.onClose();}}}>
    <BeautyShareChannel presets={appearancePresets} onExport={exportAppearancePreset} onImport={importAppearancePreset} onOpenWorkshop={props.onOpenWorkshop}
      targetCharacterId={props.character.id} onBusyChange={setBusy} onBack={props.onClose} onApplied={props.onClose} createDraft={()=>exportDecoration('我的聊天装扮',props.theme,props.character,props.themes.find(item=>item.id===(props.character.bubbleStyle||props.theme.chatDefaultBubbleStyle))||props.themes[0])}/>
  </div>, document.body);
}
