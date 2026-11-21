import React, { useEffect, useRef, useState } from 'react';
import { AppID, type CharacterProfile } from '../../types';
import { useOS } from '../../context/OSContext';
import { trackEvent } from '../../utils/analytics';
import { inspectAvatarFile, deleteAvatarModel, saveAvatarModel } from '../../utils/avatarModelStore';
import { saveLive2DModelFromFiles, saveLive2DModelFromZip } from '../../utils/live2dModelStore';
import { preloadLive2DRuntime } from '../../utils/live2dCore';
import { putImageBlob } from '../../utils/blobRef';
import { hasDatePortraits, type CompanionAvatarSource } from '../../utils/companionAvatar';
import { addCompanionModelOutfit, addUploadedCompanionOutfit } from '../../utils/companionWardrobe';
import VRoidBetaWarning from './VRoidBetaWarning';

type PendingVRoidImport = {
  file: File;
  characterId: string;
  projectFile: boolean;
};

export function useCallAvatarSetup(selectedChar: CharacterProfile | null, onSelected: () => void,
  onImported: (format: 'live2d' | 'vrm' | 'upload') => void) {
  const { addToast, updateCharacter, characters, openApp } = useOS();
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const selectedId = useRef(selectedChar?.id);
  selectedId.current = selectedChar?.id;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [avatarImportStatus, setAvatarImportStatus] = useState('');
  const [pendingVRoidImport, setPendingVRoidImport] = useState<PendingVRoidImport | null>(null);
  const [vroidImportBusy, setVRoidImportBusy] = useState(false);

  const bindVideoAvatar = (character: CharacterProfile, videoAvatar: NonNullable<CharacterProfile['videoAvatar']>) => {
    const current = charactersRef.current.find(item => item.id === character.id);
    if (!current || !mounted.current) return false;
    character = current;
    const previous = character.videoAvatar;
    const modelPatch = previous?.format === videoAvatar.format
      ? addCompanionModelOutfit(character, videoAvatar)
      : {
          videoAvatar,
          videoAvatarWardrobe: (character.videoAvatarWardrobe || []).filter(model => model.format === videoAvatar.format),
        };
    updateCharacter(character.id, {
      ...modelPatch,
      companionAvatar: {
        version: 1,
        ...character.companionAvatar,
        source: 'model',
      },
    });
    if (selectedId.current === character.id) {
      onSelected();
      onImported(videoAvatar.format);
    }
    addToast(
      videoAvatar.format === 'live2d'
        ? `${videoAvatar.fileName} 导入完成：请标记哪些按键动作属于服装切换`
        : `${videoAvatar.fileName} 已绑定给 ${character.name}`,
      'success',
    );
    if (previous?.assetId !== videoAvatar.assetId && previous?.format !== videoAvatar.format) {
      void deleteAvatarModel(previous).catch(() => { /* orphan GC can clean later */ });
    }
    return true;
  };

  const chooseStaticAvatarImage = () => {
    if (!selectedChar) {
      addToast('先选择一个角色', 'info');
      return;
    }
    const character = selectedChar;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.png,.gif,image/png,image/gif';
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return removeInput();
      const extension = file.name.split('.').pop()?.toLowerCase();
      if (!['png', 'gif'].includes(extension || '') || !['image/png', 'image/gif'].includes(file.type)) {
        addToast('静态形象仅支持 PNG / GIF', 'error');
        return removeInput();
      }
      if (file.size > 20 * 1024 * 1024) {
        addToast('图片超过 20 MB，请压缩后再导入', 'error');
        return removeInput();
      }
      try {
        const imageRef = await putImageBlob(file);
        const current = charactersRef.current.find(item => item.id === character.id);
        if (!current || !mounted.current) return;
        updateCharacter(character.id, {
          companionAvatar: addUploadedCompanionOutfit(current.companionAvatar, {
            id: imageRef,
            imageRef,
            fileName: file.name,
            mimeType: file.type,
            importedAt: Date.now(),
          }),
        });
        if (selectedId.current === character.id) {
          onSelected();
          onImported('upload');
        }
        trackEvent('导入桌面静态形象', { 格式: file.type === 'image/gif' ? 'GIF' : 'PNG' });
        addToast(`${file.name} 已设为角色形象`, 'success');
      } catch (error: any) {
        addToast(error?.message || '静态形象导入失败', 'error');
      } finally {
        removeInput();
      }
    };
    input.click();
  };

  const chooseVideoAvatarSource = (source: CompanionAvatarSource) => {
    if (!selectedChar) return;
    if (source === 'model' && !selectedChar.videoAvatar) {
      chooseAvatarModel();
      return;
    }
    if (source === 'upload' && !selectedChar.companionAvatar?.imageRef) {
      chooseStaticAvatarImage();
      return;
    }
    if (source === 'date' && !hasDatePortraits(selectedChar)) {
      addToast('还没有见面立绘，先去见面模式补一套表情', 'info');
      openApp(AppID.Date);
      return;
    }
    updateCharacter(selectedChar.id, {
      companionAvatar: {
        version: 1,
        ...selectedChar.companionAvatar,
        source,
      },
    });
    onSelected();
    addToast(source === 'model' ? '已使用动态模型' : source === 'date' ? '已沿用见面立绘' : '已使用静态图片', 'success');
  };

  const chooseAvatarModel = () => {
    if (!selectedChar) {
      addToast('先选择一个角色', 'info');
      return;
    }
    const character = selectedChar;
    const input = document.createElement('input');
    input.type = 'file';
    // iOS 可能无法识别 .vrm 的系统文件类型；不设 accept，选中后再校验扩展名和文件头。
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return removeInput();
      // 挑到文件之后有五种结局，过去只有 toast，「多少人卡在导入这一步」在数据里是空白。
      // 两条路共用一个 catch，先按扩展名把来源定死，报错时才分得清是哪条挂的。
      // 来源和结果都是这里写死的字面量，文件名和报错原文一个字都不带。
      const source = /\.zip$/i.test(file.name) ? 'Live2D ZIP' : 'VRM';
      try {
        if (/\.zip$/i.test(file.name)) {
          if (file.size > 200 * 1024 * 1024) {
            trackEvent('导入通话形象', { 来源: source, 结果: '体积超限' });
            addToast('Live2D ZIP 超过 200 MB，移动端很可能无法稳定解压加载', 'error');
            return;
          }
          void preloadLive2DRuntime().catch(() => { /* loading UI will surface a retryable error */ });
          setAvatarImportStatus('正在打开 Live2D ZIP，请耐心等待…');
          if (!bindVideoAvatar(character, await saveLive2DModelFromZip(file, setAvatarImportStatus))) return;
          trackEvent('导入通话形象', { 来源: source, 结果: '成功' });
          return;
        }
        setAvatarImportStatus('正在检查 VRM 模型…');
        const inspection = await inspectAvatarFile(file);
        if (inspection.kind === 'vroid-project') {
          // .vroid 工程文件只弹说明、不导入，跟「文件坏了」是两回事，单独占一档。
          trackEvent('导入通话形象', { 来源: source, 结果: '要先导出VRM' });
          setPendingVRoidImport({ file, characterId: character.id, projectFile: true });
          return;
        }
        if (inspection.kind === 'unsupported') {
          trackEvent('导入通话形象', { 来源: source, 结果: '格式不支持' });
          addToast(inspection.reason, 'error');
          return;
        }
        if (file.size > 80 * 1024 * 1024) {
          trackEvent('导入通话形象', { 来源: source, 结果: '体积超限' });
          addToast('模型超过 80 MB，移动端通话可能无法稳定加载，请在导出时降低纹理尺寸', 'error');
          return;
        }
        // VRM 到这里只是通过体检，真正落库在确认 beta 提示之后，成功与否由 confirmVRoidImport 记。
        setPendingVRoidImport({ file, characterId: character.id, projectFile: false });
      } catch (error: any) {
        trackEvent('导入通话形象', { 来源: source, 结果: '失败' });
        addToast(error?.message || '模型导入失败', 'error');
      } finally {
        setAvatarImportStatus('');
        removeInput();
      }
    };
    input.click();
  };

  const confirmVRoidImport = async () => {
    const pending = pendingVRoidImport;
    if (!pending || pending.projectFile || vroidImportBusy) return;
    const character = charactersRef.current.find(item => item.id === pending.characterId);
    if (!character) {
      setPendingVRoidImport(null);
      addToast('原角色已不存在，已取消导入', 'error');
      return;
    }
    setVRoidImportBusy(true);
    setAvatarImportStatus('正在保存 VRM 测试模型…');
    try {
      const videoAvatar = await saveAvatarModel(pending.file);
      if (!bindVideoAvatar(character, videoAvatar)) return;
      trackEvent('导入通话形象', { 来源: 'VRM', 结果: '成功' });
      setPendingVRoidImport(null);
    } catch (error: any) {
      trackEvent('导入通话形象', { 来源: 'VRM', 结果: '失败' });
      addToast(error?.message || 'VRM 测试模型导入失败；原模型未被覆盖', 'error');
    } finally {
      setAvatarImportStatus('');
      setVRoidImportBusy(false);
    }
  };

  const chooseLive2DDirectory = () => {
    if (!selectedChar) {
      addToast('先选择一个角色', 'info');
      return;
    }
    void preloadLive2DRuntime().catch(() => { /* loading UI will surface a retryable error */ });
    const character = selectedChar;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return removeInput();
      try {
        const totalSize = files.reduce((sum, file) => sum + file.size, 0);
        if (totalSize > 250 * 1024 * 1024) {
          trackEvent('导入通话形象', { 来源: 'Live2D 文件夹', 结果: '体积超限' });
          addToast('Live2D 文件夹超过 250 MB，请先压缩纹理尺寸或删掉无关文件', 'error');
          return;
        }
        setAvatarImportStatus(`已选择 ${files.length} 个文件，正在扫描模型…`);
        if (!bindVideoAvatar(character, await saveLive2DModelFromFiles(files, setAvatarImportStatus))) return;
        trackEvent('导入通话形象', { 来源: 'Live2D 文件夹', 结果: '成功' });
      } catch (error: any) {
        trackEvent('导入通话形象', { 来源: 'Live2D 文件夹', 结果: '失败' });
        addToast(error?.message || 'Live2D 文件夹导入失败', 'error');
      } finally {
        setAvatarImportStatus('');
        removeInput();
      }
    };
    input.click();
  };
  const avatarImportOverlay = avatarImportStatus ? (
    <div className="sully-stage-dark absolute inset-0 z-[120] flex items-center justify-center bg-[#07050c]/88 px-8 text-center backdrop-blur-xl">
      <div className="max-w-[20rem]">
        <span className="mx-auto mb-4 block h-9 w-9 animate-spin rounded-full border-2 border-white/15 border-t-violet-300" />
        <div className="text-sm leading-relaxed text-white/85">{avatarImportStatus}</div>
        <div className="mt-3 text-[10px] leading-relaxed text-white/40">包含 8K 贴图的模型首次导入可能需要 10–30 秒。请保持当前页面打开，不要重复点击按钮；完成后会自动进入动作权限页面。</div>
      </div>
    </div>
  ) : null;
  const vroidBetaOverlay = pendingVRoidImport ? (
    <VRoidBetaWarning
      fileName={pendingVRoidImport.file.name}
      projectFile={pendingVRoidImport.projectFile}
      busy={vroidImportBusy}
      onCancel={() => { if (!vroidImportBusy) setPendingVRoidImport(null); }}
      onContinue={pendingVRoidImport.projectFile ? undefined : () => { void confirmVRoidImport(); }}
    />
  ) : null;
  return { chooseAvatarModel, chooseStaticAvatarImage, chooseVideoAvatarSource, chooseLive2DDirectory, avatarImportOverlay, vroidBetaOverlay };
}
