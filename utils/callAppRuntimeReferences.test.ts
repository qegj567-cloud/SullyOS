import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CallApp runtime references', () => {
  it('uses the exported avatar prompt builder and no missing high-quality builder', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

    expect(source).not.toContain('buildHighQualityAvatarPerformancePrompt');
    expect(source).toContain('buildAvatarPerformancePrompt(allowedModelActions)');
    expect(source).toContain("selectedChar?.videoCallPerformanceQuality === 'high'");
  });

  it('keeps the master call-runtime bridges present beside the custom video stage', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

    expect(source).toContain("import { getPendingReplyText } from '../utils/pendingReply'");
    expect(source).toContain("import { markAmsgStateDirty } from '../utils/amsgStateSync'");
    expect(source).toContain("const [memoryPalaceStatus, setMemoryPalaceStatus] = useState('')");
    expect(source).toContain('const retryBubble = latestBubble?.role === \'user\'');
    expect(source.match(/markCallTurnDirty\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('keeps the call analytics restored from the master-side merge', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

    for (const eventName of [
      '发起通话',
      '设置通话语音语种',
      '重掷角色的通话台词',
      '重播一条通话语音',
    ]) {
      expect(source).toContain(`trackEvent('${eventName}'`);
    }
    expect(source).toMatch(/const beginSelectedCall[\s\S]*?trackEvent\('发起通话'\)/);
  });

  it('routes every memory-palace trigger through the defined call hook', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

    expect(source).not.toContain('runMemoryPalacePostHook');
    expect(source).toContain('const runCallMemoryPalaceHook = (char: CharacterProfile) =>');
    expect(source.match(/runCallMemoryPalaceHook\(selectedChar\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('restores optional character initiative without changing explicit user sends', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    const preferenceSource = readFileSync(path.resolve(__dirname, './callPreferences.ts'), 'utf8');
    const preferenceSheetSource = readFileSync(path.resolve(__dirname, '../components/call/CallPreferencesSheet.tsx'), 'utf8');

    const dictation = source.slice(source.indexOf('onFinal: (t) => {'), source.indexOf('onTranscribing: (busy)'));
    expect(dictation).toContain('setDraftInput(draftPrefix + t)');
    expect(dictation).not.toContain('requestAssistantReply');
    expect(source).toContain("await requestAssistantReply(input, userDbId, pendingTouchesForTurn, true, userCameraSnapshotForTurn)");
    expect(source).toContain("{sendingBusy ? '…' : '发送'}");
    expect(source).toMatch(/const beginSelectedCall[\s\S]*?setViewMode\('in-call'\);\s+setCallStartedAt\(Date\.now\(\)\);\s+setCallState\('listening'\);/);
    expect(source).toContain('fireIdleNudge');
    expect(source).toContain('idleNudgeCountRef');
    expect(source).toContain('电话刚接通。你先开口');
    expect(source).toContain('callPreferences.characterInitiative');
    expect(source).toContain('callPreferences.idleNudgeEnabled');
    expect(preferenceSource).toContain('characterInitiative: true');
    expect(preferenceSource).toContain('idleNudgeEnabled: false');
    expect(preferenceSheetSource).toContain('谁先开口');
    expect(preferenceSheetSource).toContain('对方先说');
    expect(preferenceSheetSource).toContain('我先说');
  });

  it('keeps call autoplay separate from ChatApp and defers TTS when it is disabled', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    const preferenceSource = readFileSync(path.resolve(__dirname, './callPreferences.ts'), 'utf8');
    const preferenceSheetSource = readFileSync(path.resolve(__dirname, '../components/call/CallPreferencesSheet.tsx'), 'utf8');

    expect(preferenceSource).toContain('voiceAutoPlay: true');
    expect(source).toContain('primeCallAudioFromGesture();');
    expect(source).toContain('SILENT_CALL_AUDIO_DATA_URL');
    expect(source).toContain('if (callPreferences.voiceAutoPlay)');
    expect(source).toContain('if (!callPreferences.voiceAutoPlay || !canSpeakVoice()) return');
    expect(source).toMatch(/if \(!callPreferences\.voiceAutoPlay\) \{\s+setCallState\('listening'\);\s+return;/);
    expect(source).toContain('const handlePlayBubbleAudio = async (bubble: CallBubble) =>');
    expect(source).toContain("trackEvent('按需生成并播放通话语音')");
    expect(source).toContain('shouldKeepNativeCallAudio');
    expect(source).not.toContain('<audio');
    expect(preferenceSheetSource).toContain('不改变聊天页的语音设置');
    expect(preferenceSheetSource).toContain('语音和视频通话都只在你点“播放语音”时才生成');
  });

  it('opens call preferences directly from the existing entry without an update notice', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    expect(source).not.toContain('<CallUpdateAnnouncement');
    expect(source).toContain('onClick={openCallPreferencesPanel} title="通话偏好"');
    expect(source).toContain('setShowCallPreferences(true)');
  });

  it('offers game-like video layouts and a collapsible immersive subtitle', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

    for (const id of ['stage', 'story', 'mini']) {
      expect(source).toContain(`id: '${id}'`);
    }
    expect(source).toContain('data-testid="video-call-layout-picker"');
    expect(source).toContain('data-testid="video-call-subtitle"');
    expect(source).toContain('data-testid={callMode === \'video\' ? \'video-call-compact-controls\' : undefined}');
    expect(source).toContain("videoCallLayout === 'stage' ? 'flex-1 min-h-0' : 'shrink-0'");
    expect(source).toContain('[data-call-video-layout="stage"] .sully-video-stage-shell { max-height: none; }');
    expect(source).toContain('body.ios-keyboard-open [data-call-video-layout="stage"] .sully-video-stage-shell { max-height: 0; }');
    expect(source).toContain("? 'min-h-0'");
    expect(source).not.toContain('min-h-[260px]');
    expect(source).toContain('relative z-10 flex h-full min-h-0 flex-col overflow-hidden');
    expect(source).toContain("'px-7 pb-2 pt-1.5'");
    expect(source).not.toContain('px-7 pb-7');
    expect(source).toContain("callMode === 'video' ? 'h-10 w-10'");
    expect(source).toContain("videoCallLayout === 'stage'");
    expect(source).toContain('setVideoTranscriptExpanded(true)');
  });

  it('keeps the character picker visible before optional video settings', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    expect(source).toContain('data-testid="call-character-picker"');
    expect(source).toContain('min-h-[5rem] flex-1 overflow-y-auto overscroll-contain');
    expect(source).not.toContain('min-h-[5rem] max-h-[15rem]');
    expect(source).toContain('data-testid="video-call-advanced-settings"');
    expect(source).toContain('模型画质、导入与动作排练');
  });

  it('pins voice and video setup actions to the same viewport bottom edge', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

    expect(source).toContain('relative z-10 flex h-full min-h-0 flex-col overflow-hidden px-5');
    expect(source).toContain("paddingBottom: 'max(1.25rem, var(--safe-bottom, 0px))'");
    expect(source).toContain('className="shrink-0 pt-4 space-y-2.5" data-testid="call-role-actions"');
  });

  it('schedules opening and closing performance beats against the real audio duration', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    expect(source).toContain('expandAvatarPerformanceCueBeats(cues, durationMs)');
    expect(source).toContain('applyPerformanceDirection(beat.direction)');
  });

  it('keeps lip sync and performance running when call audio is unavailable', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    expect(source).toContain('const playSilentAvatarSpeech = (');
    expect(source).toContain("if (callMode === 'video') playSilentAvatarSpeech(assistantText, turnPerformanceCues)");
    expect(source).toContain('playSilentAvatarSpeech(rerolled, rerollReply.performanceCues)');
    expect(source).toContain("playSilentAvatarSpeech('', cues, estimatedDurationMs)");
  });

  it('shows precise touch targets without blurring the feedback copy', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    const feedbackSource = readFileSync(path.resolve(__dirname, '../components/call/AvatarTouchFeedback.tsx'), 'utf8');
    expect(source).toContain('label: avatarTouchTargetLabel(hit)');
    expect(source).toContain('...(part ? { part } : {})');
    expect(feedbackSource).not.toContain('filter: blur');
    expect(feedbackSource).not.toMatch(/sully-touch-float-copy[\s\S]*?scale\(/);
  });

  it('keeps the built-in Sully model lightweight by default', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');

    expect(source).toContain('data-testid="builtin-sully-quality-picker"');
    expect(source).toContain("value: 'balanced' as const");
    expect(source).toContain("value: 'hd' as const");
    expect(source).toContain('maxFps={30}');
  });

  it('keeps all four user-camera modes isolated and opt-in', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    const pickerSource = readFileSync(path.resolve(__dirname, '../components/call/UserCameraModePicker.tsx'), 'utf8');

    for (const mode of ['off', 'fake', 'emotion', 'snapshot']) {
      expect(pickerSource).toContain(`id: '${mode}'`);
    }
    expect(source).toContain("includeUserCameraContext");
    expect(source).toContain("userCameraMode === 'emotion'");
    expect(source).toContain('await captureUserCameraEmotionContext()');
    expect(source).toContain("userCameraMode === 'snapshot'");
    expect(source).toContain('captureUserCameraSnapshotContext()');
    expect(source).toContain('prepareUserCameraSnapshot(messages, userCameraSnapshot)');
    expect(source).toContain('userCameraSnapshot ? 0 : 2');
    expect(source).toContain('isVisionInputUnsupportedError(error)');
    expect(source).toContain('await requestAssistantReply(input, userDbId, pendingTouchesForTurn, true, userCameraSnapshotForTurn)');
    expect(source).toContain('await pruneCallSnapshots(selectedChar.id, currentSessionId)');
    expect(source).toContain('cameraSnapshotExpired: true');
    expect(source).toContain('<CallSnapshotImage imageRef={item.cameraSnapshotRef} expired={item.cameraSnapshotExpired} />');
    expect(source).toContain('for (const snapshotRef of snapshotRefs) await deleteBlobRef(snapshotRef)');
    expect(source).toContain('data-testid="user-camera-emotion-readout"');
    expect(source).toContain('className="absolute right-4 top-4 z-30"');
    expect(source).toContain('data-testid="user-camera-preview-size-picker"');
    expect(source).toContain('data-testid={`user-camera-preview-size-${option.id}`}');
    expect(source).toContain("return saved === 'small' || saved === 'medium' || saved === 'large' ? saved : 'medium'");
    for (const size of ['small', 'medium', 'large']) {
      expect(source).toContain(`id: '${size}'`);
    }
    expect(source).toContain("const [userCameraMode, setUserCameraMode] = useState<UserCameraMode>('off')");
    expect(source).toContain('这张图只用于画面，不会发送给角色');
    expect(source).toContain("userCameraStreamRef.current?.getTracks().forEach(track => track.stop())");
  });

  it('backs retained call snapshots up as media while text-only exports keep [图片]', () => {
    const exportSource = readFileSync(path.resolve(__dirname, '../context/OSContext.tsx'), 'utf8');

    // v3 起快照令牌不再逐 store 解析：onSerialized 从落包文本统一收集、二进制走 blobs/* 旁路。
    // 这里锚收集管线本体——它一旦被移走，cameraSnapshotRef 的二进制就不再随备份。
    expect(exportSource).toContain('onSerialized: collectSerialized');
    expect(exportSource).toContain('collectBlobRefs(s, referencedBlobTokens)');
    expect(exportSource).toContain('await writeBlobsToZip(');
    expect(exportSource).toContain("metadata.cameraSnapshotExpired = true");
    expect(exportSource).toContain("|| item.metadata?.cameraSnapshotRef");
    expect(exportSource).toContain("companionAvatar: c.companionAvatar");
  });

  it('guides dynamic/static avatar selection, wardrobe and camera privacy before the first video call', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    const guideSource = readFileSync(path.resolve(__dirname, '../components/call/CallSetupGuide.tsx'), 'utf8');
    const stageSource = readFileSync(path.resolve(__dirname, '../components/call/VRMVideoCallStage.tsx'), 'utf8');

    expect(source).toContain("const CALL_SETUP_GUIDE_KEY = 'sully-call-setup-guide-v2'");
    expect(source).toContain("openCallSetupGuide(roleCamera.view !== 'avatar' ? 'camera' : 'model')");
    expect(source).toContain('beginSelectedCall(setupCameraMode)');
    expect(source).toContain('onChooseFakeImage={() => chooseFakeUserCameraImage(false)}');
    expect(source).toContain('useCallAvatarSetup(selectedChar');
    expect(source).toContain("roleCamera.view !== 'model'");
    expect(source).toContain('staticPortraitValue={staticVideoPortrait}');
    expect(guideSource).toContain('data-testid="call-setup-guide"');
    expect(guideSource).toContain("['upload', '静态图片']");
    expect(guideSource).toContain("['date', '见面立绘']");
    expect(guideSource).toContain('校准构图、动作与真·衣橱');
    expect(guideSource).toContain('下次打开仍从关闭开始');
    expect(guideSource).toContain('本地情绪只注入');
    expect(guideSource).toContain('静态机位永远不随消息发送');
    expect(stageSource).toContain('testId="video-call-static-portrait-stage"');
    expect(stageSource).toContain('staticAvatarActive ? `static-${staticAvatarSource}`');
  });

  it('stores static companion imports as the original File in blob_assets from both entry points', () => {
    const callSource = readFileSync(path.resolve(__dirname, '../components/call/useCallAvatarSetup.tsx'), 'utf8');
    const appearanceSource = readFileSync(path.resolve(__dirname, '../apps/Appearance.tsx'), 'utf8');
    const callImport = callSource.slice(
      callSource.indexOf('const chooseStaticAvatarImage = () =>'),
      callSource.indexOf('const chooseVideoAvatarSource ='),
    );
    const appearanceImport = appearanceSource.slice(
      appearanceSource.indexOf('const handleCompanionPortraitUpload = async'),
      appearanceSource.indexOf('const chooseCompanionOutfit ='),
    );

    for (const importer of [callImport, appearanceImport]) {
      expect(importer).toContain('const imageRef = await putImageBlob(file)');
      expect(importer).not.toMatch(/processImage(?:ToBlob)?\(|FileReader|canvas|toDataURL|toBlob/);
    }
  });

  it('requires explicit acknowledgement before saving a VRM test import', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/call/useCallAvatarSetup.tsx'), 'utf8');
    const warningSource = readFileSync(path.resolve(__dirname, '../components/call/VRoidBetaWarning.tsx'), 'utf8');

    expect(source).toContain('setPendingVRoidImport({ file, characterId: character.id, projectFile: false })');
    expect(source).toContain('const confirmVRoidImport = async () =>');
    expect(warningSource).toContain('并不是本次版本的开发重点');
    expect(warningSource).toContain('可能存在各种 Bug');
  });
});
