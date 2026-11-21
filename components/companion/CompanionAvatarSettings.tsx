import React, { useState } from 'react';
import { AppID, type CharacterProfile } from '../../types';
import { useOS } from '../../context/OSContext';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { companionAvatarSource, hasDatePortraits, listCompanionDateOutfits, normalizeCompanionSkinSetId } from '../../utils/companionAvatar';
import { listCompanionModelOutfits, selectCompanionModelOutfit } from '../../utils/companionWardrobe';
import { CallAvatarOptions } from '../call/CallSetupGuide';
import { useCallAvatarSetup } from '../call/useCallAvatarSetup';
import Live2DActionSettings from '../call/Live2DActionSettings';

export default function CompanionAvatarSettings({ char, close }: { char: CharacterProfile; close(): void }) {
  const { openApp, updateCharacter, addToast } = useOS();
  const [editor, setEditor] = useState<'import' | 'advanced'>();
  const setup = useCallAvatarSetup(char, () => {}, format => { if (format === 'live2d') setEditor('import'); });
  const back = () => {
    if (setup.avatarImportOverlay || setup.vroidBetaOverlay) return true;
    if (editor) setEditor(undefined); else close();
    return true;
  };
  useLocalBackHandler(back, 35);
  const source = companionAvatarSource(char);
  const model = char.videoAvatar;
  const models = listCompanionModelOutfits(char);
  const dateOutfits = listCompanionDateOutfits(char);
  const accentColor = '#ba9be8';
  return <div className="sully-stage-dark absolute inset-0 z-[40] flex flex-col bg-[#1d1827] text-white" role="dialog" aria-modal="true" aria-label="角色形象"
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); back(); } }}>
    <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
      <h2 className="text-lg font-semibold">{char.name}的角色形象</h2>
      <button type="button" autoFocus onClick={close} className="rounded-lg border border-white/20 px-3 py-2">完成</button>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <CallAvatarOptions modelName={model?.fileName} modelFormat={model?.format} avatarSource={source}
        staticImageName={char.companionAvatar?.fileName} hasDatePortraits={hasDatePortraits(char)}
        dateOutfitName={(dateOutfits.find(item => item.id === normalizeCompanionSkinSetId(char.companionAvatar?.skinSetId)) ?? dateOutfits[0])?.name}
        accentColor={accentColor} muted="#c6bdcd" line="#ffffff22" onChooseModelFile={setup.chooseAvatarModel}
        onChooseLive2DFolder={setup.chooseLive2DDirectory} onChooseAvatarSource={setup.chooseVideoAvatarSource}
        onChooseStaticImage={setup.chooseStaticAvatarImage} onManageDatePortraits={() => openApp(AppID.Date)}
        onConfigureLive2D={model?.format === 'live2d' ? () => setEditor('advanced') : undefined}/>
      {source === 'model' && model?.format === 'live2d' && model.actions.some(action => action.wardrobe) &&
        <label className="block px-5 py-3 text-sm">穿戴服装
          <select className="ml-2 rounded bg-[#332c40] px-2 py-1" value={model.activeWardrobeActionId ?? ''} onChange={event => {
            updateCharacter(char.id, { videoAvatar: { ...model, activeWardrobeActionId: event.target.value || undefined } });
          }}>
            <option value="">模型原始服装</option>
            {model.actions.filter(action => action.wardrobe).map(action => <option key={action.id} value={action.id}>{action.name}</option>)}
          </select>
        </label>}
      {source === 'model' && models.length > 1 && <label className="block px-5 py-3 text-sm">模型衣橱
        <select className="ml-2 rounded bg-[#332c40] px-2 py-1" value={model?.assetId} onChange={event => {
          const patch = selectCompanionModelOutfit(char, event.target.value);
          if (patch) updateCharacter(char.id, patch);
        }}>{models.map(item => <option value={item.assetId} key={item.assetId}>{item.fileName}</option>)}</select>
      </label>}
    </div>
    {setup.avatarImportOverlay}{setup.vroidBetaOverlay}
    {editor && model?.format === 'live2d' && <Live2DActionSettings key={model.assetId} config={model} characterName={char.name}
      accentColor={accentColor} setupMode={editor} onClose={() => setEditor(undefined)} onSave={videoAvatar => {
        updateCharacter(char.id, { videoAvatar }); setEditor(undefined); addToast('已保存角色动作与衣橱', 'success');
      }}/>}
  </div>;
}
