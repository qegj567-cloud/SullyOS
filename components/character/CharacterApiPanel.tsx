import React, { useState } from 'react';
import type { CharacterProfile, DialogueApiConfig } from '../../types';
import { useOS } from '../../context/OSContext';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { describeDialogueApi } from '../../utils/characterApi';
import Modal from '../os/Modal';
import ApiSlotEditor from '../settings/ApiSlotEditor';

export default function CharacterApiPanel({
  character,
  onChange,
}: {
  character: CharacterProfile;
  onChange: (api: DialogueApiConfig | undefined) => void;
}) {
  const { apiConfig, apiPresets } = useOS();
  const [isOpen, setIsOpen] = useState(false);

  // 高于私聊角色名片 <dialog>（优先级 30），按返回键或 Escape 只关闭本弹窗，不误关名片。
  useLocalBackHandler(() => {
    setIsOpen(false);
    return true;
  }, 80, isOpen);

  return (
    <section className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-3 text-slate-800">
      <h3 className="text-xs font-bold text-slate-700">独立 API</h3>
      <p className="text-xs text-slate-600 break-words" data-testid="character-api-status">
        {character.dialogueApi ? '目前使用的为：' : '目前跟随设置中的 API：'}
        {describeDialogueApi(character.dialogueApi || apiConfig, apiPresets)}
      </p>
      <p className="text-[11px] text-slate-400 leading-relaxed">
        用于私聊、见面、电话、群聊逐人回复、彼方角色活动和主动消息。App 独立 API 优先；TRPG 等统一生成和记忆、情绪、识图、语音合成仍用原配置。
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="px-3 py-2 text-xs font-bold rounded-xl bg-primary/10 text-primary active:scale-95 transition-transform"
        >
          {character.dialogueApi ? '修改独立 API' : '为角色使用独立 API'}
        </button>
        {character.dialogueApi && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="px-3 py-2 text-xs text-slate-500 rounded-xl bg-slate-100 active:scale-95 transition-transform"
          >
            跟随设置中的 API
          </button>
        )}
      </div>

      <Modal isOpen={isOpen} title="角色独立 API" onClose={() => setIsOpen(false)}>
        <ApiSlotEditor
          slotName="角色独立"
          value={character.dialogueApi}
          onCommit={(next) => onChange(next)}
          followButtonLabel="跟随设置中的 API"
          followSummary={describeDialogueApi(apiConfig, apiPresets)}
          helperText="选择预设后，修改该预设会同时更新这里；只想修改当前角色，可复制为独立配置。"
          meta={{
            appId: 'character',
            appName: '神经链接',
            charId: character.id,
            charName: character.name,
          }}
        />
      </Modal>
    </section>
  );
}
