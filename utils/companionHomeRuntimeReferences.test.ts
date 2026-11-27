import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CompanionHome touch request boundaries', () => {
  it('only requests a generated pack and rotates reactions locally on tap', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');

    expect(source).toContain('requestAvatarTouchReactionPack');
    expect(source).toContain('avatarTouchTargetLabel(hit)');
    expect(source).toContain('reactions[cursor % reactions.length]');
    expect(source).not.toContain('requestAvatarTouchReply');
    expect(source).not.toContain('DB.saveMessage');
  });
  it('makes one touch-pack model attempt without retry or an artificial 60s cutoff', () => {
    const touchSource = readFileSync(path.resolve(__dirname, './avatarTouch.ts'), 'utf8');

    expect(touchSource).toContain("purpose: '一次性生成桌面触摸反馈包（不重试）'");
    expect(touchSource).toContain('}, 0, 0, {');
    expect(touchSource).not.toContain('}, 0, 60_000, {');
    expect(touchSource).not.toContain('自动补全缺失部位');
    expect(touchSource).not.toContain('requestForZones');
    expect(touchSource).not.toContain('repairData');
  });

  it('pre-generates touch voice only when opted in and plays persisted audio without per-tap TTS', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const voiceSource = readFileSync(path.resolve(__dirname, './avatarTouchVoice.ts'), 'utf8');
    const voiceAssetSource = readFileSync(path.resolve(__dirname, './companionVoiceAssets.ts'), 'utf8');

    expect(source).toContain('data-testid="companion-touch-generate-voice"');
    expect(source).toContain('if (touchGenerateVoice)');
    expect(source).toContain('createAvatarTouchVoiceUrl(voice)');
    expect(source).not.toContain('synthesizeSpeechDetailed(');
    expect(voiceSource).toContain('synthesizeSpeechDetailed(');
    expect(voiceSource).toContain('saveCompanionVoiceBlob');
    expect(voiceSource).toContain('VOICE_CONCURRENCY = 2');
    expect(source).toContain('data-testid="companion-generate-startup-voice"');
    expect(source).toContain('data-testid="companion-startup-voice-language"');
    expect(source).toContain('data-testid="companion-touch-voice-language"');
    expect(source).toContain('data-testid="companion-startup-translation"');
    expect(source).toContain('generateCompanionStartupVoice');
    expect(voiceAssetSource).toContain("COMPANION_STARTUP_VOICE_ASSET_PREFIX = 'companion-startup-voice:'");
    expect(voiceSource).toContain('voiceText: options.text');
    expect(voiceSource).toContain('languageBoost: options.voiceLanguage || undefined');
    expect(source).toContain('data-testid="companion-startup-preset-select"');
    expect(source).toContain('data-testid="companion-touch-preset-select"');
    expect(source).toContain('保存为新预设');
    expect(source).toContain('生成并保存新预设');
  });

  it('sequences a local touch impulse and uses the center star for real apps', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const constantsSource = readFileSync(path.resolve(__dirname, '../constants.tsx'), 'utf8');

    expect(source).toContain('touchImpulseNonce={lastHit?.nonce}');
    expect(source).toContain('touchDialogueTimerRef.current = window.setTimeout');
    expect(source).toContain('data-testid="companion-app-star-button"');
    expect(source).toContain('data-testid="companion-app-star-panel"');
    expect(source).toContain('INSTALLED_APPS');
    expect(source).toContain("label: app.name");
    expect(constantsSource).toContain("{ id: AppID.Songwriting, name: '写歌'");
  });
  it('renders an ornate flat action rail and clips only the dialogue background', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const dialogueStart = source.indexOf('data-testid="companion-dialogue"');
    const dialogueEnd = source.indexOf('手游底部主导航', dialogueStart);
    const dialogueSource = source.slice(dialogueStart, dialogueEnd);
    const dockStart = source.indexOf('data-testid="companion-ornate-dock"');
    const dockEnd = source.indexOf('右侧角色检查器', dockStart);
    const dockSource = source.slice(dockStart, dockEnd);
    const railStart = source.indexOf('data-testid="companion-ornate-action-rail"');
    const railEnd = source.indexOf('触摸设置抽屉', railStart);
    const railSource = source.slice(railStart, railEnd);

    expect(source).toContain('data-testid="companion-ornate-action-rail"');
    expect(source).toContain('data-visual-style="ornate-flat"');
    expect(source).toContain('viewBox="0 0 82 356"');
    expect(source).toContain('data-testid="companion-ornate-dock"');
    expect(source).not.toContain('companion-star-pulse');
    expect(dockSource).not.toContain('radial-gradient');
    expect(dockSource).not.toContain('boxShadow');
    expect(dockSource).toContain('grid h-full grid-cols-5 items-center');
    expect(dockSource).toContain('flex h-14 w-14 shrink-0 items-center justify-center rounded-full border');
    expect(dockSource).not.toContain('items-end gap-1');
    expect(railSource).not.toContain("{ id: AppID.Chat");
    expect(dockSource).toContain('{ id: AppID.Chat, icon: Icons.Chat');
    expect(dialogueSource).toContain('data-testid="companion-dialogue-surface"');
    expect(dialogueSource).toContain('pointer-events-none absolute inset-0 -z-10 border');
    expect(dialogueSource.indexOf('clipPath')).toBeLessThan(dialogueSource.indexOf('absolute -top-3'));
  });

  it('uses one medium HUD scale and surfaces real character context', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');

    expect(source).toContain('data-testid="companion-context-hud"');
    expect(source).toContain('data-testid="companion-hud-thought"');
    expect(source).toContain('data-testid="companion-hud-chat"');
    expect(source).toContain('data-testid="companion-hud-schedule"');
    expect(source).toContain('DB.getRecentMessagesWithCount(character.id, 1');
    expect(source).toContain('isChatPreviewMessage(message)');
    expect(source).toContain('getLastInnerState(character.id)');
    expect(source).toContain('getDailyScheduleForChar(character)');
    expect(source).toContain('data-ui-scale="medium"');
  });

  it('routes the three context tiles to distinct character destinations', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');

    expect(source).toContain('onClick={() => openApp(AppID.CheckPhone)} className="min-w-0 border-r');
    expect(source).toContain('onClick={() => openApp(AppID.Chat)} className="min-w-0 border-r');
    expect(source).toContain('data-testid="companion-hud-schedule"');
  });

  it('keeps one stage layout and offers six frame languages in the right composition inspector', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const appearanceSource = readFileSync(path.resolve(__dirname, '../apps/Appearance.tsx'), 'utf8');
    const frameSource = readFileSync(path.resolve(__dirname, '../components/os/companionFrameStyles.ts'), 'utf8');
    const layoutSource = readFileSync(path.resolve(__dirname, '../components/os/companionLayoutStyles.ts'), 'utf8');
    const backupSource = readFileSync(path.resolve(__dirname, './desktopSkinBackup.ts'), 'utf8');

    expect(source).toContain('data-companion-frame={frameStyle}');
    expect(source).toContain('data-companion-layout="stage"');
    expect(source).not.toContain('data-testid="companion-layout-picker"');
    expect(source).not.toContain('data-testid="companion-layout-editor"');
    expect(source).toContain('data-testid="companion-character-crop-editor"');
    expect(source).toContain('showCropGuide={editing && editingPanel === \'character\' && compositionFramingMode === \'base\'}');
    expect(source).toContain('data-testid="companion-face-anchor-mode"');
    expect(source).toContain('faceFraming: faceAnchorDraftEnabled ? faceFramingDraft : undefined');
    expect(source).toContain('data-testid="companion-touch-region-mode"');
    expect(source).toContain('data-testid="companion-touch-region-editor-panel"');
    expect(source).toContain('touchRegions: touchRegionsDraft.length ? touchRegionsDraft : undefined');
    expect(source).toContain("compositionFramingMode === 'touch'");
    expect(source).toContain('onTouchRegionsChange={editing ? setTouchRegionsDraft : undefined}');
    expect(source).toContain('data-testid="companion-collapse-composition"');
    expect(source).toContain('data-testid="companion-expand-composition"');
    expect(source).toContain("data-collapsed={compositionEditorCollapsed ? 'true' : 'false'}");
    expect(source).toContain('data-testid="companion-live2d-texture-quality-picker"');
    expect(source).toContain("textureQuality: quality");
    expect(source).toContain("isBuiltinSullyLive2D(character.videoAvatar) && (hit.zone === 'head' || hit.zone === 'face')");
    expect(source).toContain('data-testid="companion-appearance-rail-button"');
    expect(source).toContain('data-testid="companion-real-wardrobe-button"');
    expect(source).toContain('<CompanionWardrobeDrawer');
    expect(source).toContain('onOpenComposition={openCompositionEditor}');
    expect(source).toContain('data-placement="right-inspector"');
    expect(source).toContain('data-testid="companion-frame-style-picker"');
    expect(source).toContain('data-testid={`companion-frame-style-${style.id}`}');
    expect(source).toContain('companion-dock-primary-frame');
    expect(source).toContain('companion-dock-primary-core');
    expect(source).toContain('companion-dock-primary-glyph');
    expect(source).toContain("[data-companion-frame='magazine'] .companion-dock-primary-frame");
    expect(source).toContain("[data-companion-frame='archive'] .companion-dock-primary-frame");
    expect(source).toContain("[data-companion-frame='idol'] .companion-dock-primary-frame");
    expect(source).toContain('aria-label="打开全部功能"');
    for (const id of ['tech', 'otome', 'cat', 'magazine', 'archive', 'idol']) {
      expect(frameSource).toContain(`id: '${id}'`);
    }
    expect(source).not.toContain('☝');
    expect(source).not.toContain('top-[31%] h-[48vw]');
    expect(appearanceSource).not.toContain('data-testid="companion-frame-style-picker"');
    for (const id of ['mobilegame', 'storycard', 'editorial']) expect(frameSource).not.toContain(`id: '${id}'`);
    expect(layoutSource).toContain("id: 'stage'");
    for (const id of ['focus', 'mini']) expect(layoutSource).not.toContain(`id: '${id}'`);
    expect(backupSource).toContain("'companion_frame_style_v1'");
    expect(backupSource).toContain("'companion_layout_v1'");
  });

  it('gives the otome frame an original portrait chrome with event flow and schedule-aware routes', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const otomeSource = readFileSync(path.resolve(__dirname, '../components/os/OtomeCompanionChrome.tsx'), 'utf8');
    const otomeCss = readFileSync(path.resolve(__dirname, '../components/os/OtomeCompanionChrome.css'), 'utf8');

    expect(source).toContain("frameStyle === 'otome'");
    expect(source).toContain('<OtomeCompanionChrome');
    expect(source).toContain('<ScheduleFullscreenViewer');
    expect(source).toContain("line?.kind === 'touch'");
    expect(source).not.toContain('otomeIdleLine');
    expect(source).toContain("@media (orientation:landscape) and (min-width:720px)");
    expect(source).toContain("[data-companion-frame='otome'] .companion-stage-canvas");
    expect(source).toContain('width:100%');
    expect(otomeSource).toContain("key: AppID.Date, label: '见面'");
    expect(otomeSource).toContain("testId: 'companion-otome-date-button'");
    expect(otomeSource).toContain('className="otome-day-progress"');
    expect(otomeSource).toContain('className="otome-episode-ribbon pointer-events-auto" onClick={openCharacterSchedule}');
    expect(otomeSource).toContain('当前行程 ·');
    expect(otomeSource).not.toContain("id: AppID.Schedule, label: '日程'");
    expect(otomeSource).not.toContain("{ id: AppID.SpecialMoments, label: '日程'");
    expect(otomeSource).toContain("{ key: AppID.SpecialMoments, label: '时光'");
    expect(otomeSource).toContain("key: AppID.Call, label: '通话'");
    expect(otomeSource).toContain('openApp(AppID.VRWorld)');
    expect(otomeSource).not.toContain('openApp(AppID.WorldHome)');
    expect(otomeSource).toContain("key: AppID.Date, label: '篇章'");
    expect(otomeSource).not.toContain('otome-signal-dot');
    expect(otomeSource).not.toContain('ResourceBar');
    expect(otomeSource).not.toContain('otome-rank-badge');
    expect(otomeCss).toContain('grid-template-columns:repeat(4,1fr)');
    expect(otomeCss).toContain('.otome-scene-backdrop');
    expect(otomeCss).toContain('var(--chrome-top,var(--safe-top,0px))');
    expect(otomeCss).toContain('var(--safe-bottom,0px)');
    expect(otomeCss).not.toContain('.otome-feature-entries');
    expect(otomeCss).toContain("[data-companion-frame='otome'] .companion-dialogue-shell");
  });

  it('adds an independent black-purple cat layout and paired companion lock screens', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const catSource = readFileSync(path.resolve(__dirname, '../components/os/CatCompanionChrome.tsx'), 'utf8');
    const catCss = readFileSync(path.resolve(__dirname, '../components/os/CatCompanionChrome.css'), 'utf8');
    const shellSource = readFileSync(path.resolve(__dirname, '../components/PhoneShell.tsx'), 'utf8');
    const lockSource = readFileSync(path.resolve(__dirname, '../components/os/CompanionLockChrome.tsx'), 'utf8');

    expect(source).toContain("frameStyle === 'cat'");
    expect(source).toContain('<CatCompanionChrome');
    expect(source).toContain("frameStyle === 'otome' || frameStyle === 'cat' || frameStyle === 'magazine' || frameStyle === 'archive' || frameStyle === 'idol'");
    expect(catSource).toContain('NIGHT COMPANION');
    expect(catSource).toContain('CURRENT ROUTE · 当前行程');
    expect(catSource).toContain('onClick={openCharacterSchedule}');
    expect(catSource).toContain("id: AppID.Date, label: '见面'");
    expect(catSource).toContain("id: 'wardrobe'");
    expect(catSource).toContain('action: openWardrobe');
    expect(catCss).toContain("[data-companion-frame='cat'] .companion-dialogue-shell");
    expect(catCss).toContain('--cat-eye:#b9f36a');
    expect(shellSource).toContain('const companionLockFrame = storedCompanionFrame');
    expect(shellSource).toContain('<CompanionLockChrome');
    expect(lockSource).toContain('variant: CompanionFrameStyleId');
  });

  it('gives every companion frame a matching default lock wallpaper and upgrades idol live to its own stage chrome', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const idolSource = readFileSync(path.resolve(__dirname, '../components/os/IdolCompanionChrome.tsx'), 'utf8');
    const idolCss = readFileSync(path.resolve(__dirname, '../components/os/IdolCompanionChrome.css'), 'utf8');
    const lockSource = readFileSync(path.resolve(__dirname, '../components/os/CompanionLockChrome.tsx'), 'utf8');
    const lockCss = readFileSync(path.resolve(__dirname, '../components/os/CompanionLockChrome.css'), 'utf8');

    expect(source).toContain('<IdolCompanionChrome');
    expect(source).toContain("frameStyle === 'idol'");
    expect(source).toContain('idol-scene-backdrop');
    expect(idolSource).toContain('data-testid="companion-idol-chrome"');
    expect(idolSource).toContain('PRIVATE LIVE SESSION');
    expect(idolSource).toContain("testId: 'companion-idol-wardrobe-button'");
    expect(idolSource).toContain('CURRENT SET');
    expect(idolCss).toContain('.idol-live-dock .is-live');
    expect(idolCss).toContain('@keyframes idol-light-sweep');
    for (const id of ['tech', 'otome', 'cat', 'magazine', 'archive', 'idol']) {
      expect(lockSource).toContain(`${id}: { eyebrow:`);
      expect(lockCss).toContain(`.companion-themed-lock--${id}`);
    }
    expect(lockSource).toContain('const copy = LOCK_COPY[variant]');
    expect(lockCss).toContain('opacity:var(--lock-theme-opacity,1)');
    expect(lockSource).not.toContain('companion-lock-idol-head');
    expect(lockSource).not.toContain('companion-lock-idol-name');
    expect(lockSource).not.toContain('companion-lock-idol-floor');
    expect(lockCss).not.toContain('.companion-themed-lock--idol .companion-lock-wallpaper::after');
  });

  it('renders the magazine frame as a layered publication cover instead of the generic game HUD', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const magazineSource = readFileSync(path.resolve(__dirname, '../components/os/MagazineCompanionChrome.tsx'), 'utf8');
    const magazineCss = readFileSync(path.resolve(__dirname, '../components/os/MagazineCompanionChrome.css'), 'utf8');

    expect(source).toContain('<MagazineCompanionChrome');
    expect(source).toContain("frameStyle === 'magazine'");
    expect(magazineSource).toContain('data-testid="companion-magazine-chrome"');
    expect(magazineSource).toContain('VISUAL CHARACTER JOURNAL');
    expect(magazineSource).toContain('ISSUE 08');
    expect(magazineSource).toContain('THE PRIVATE HOURS OF');
    expect(magazineSource).toContain('mag-cover-code');
    expect(magazineSource).toContain('mag-cover-qr');
    expect(magazineSource).toContain('data-testid="companion-magazine-wardrobe-button"');
    expect(magazineCss).toContain('.mag-cover-masthead');
    expect(magazineCss).toContain('.mag-cover-vertical');
    expect(magazineCss).toContain('.mag-cover-feature');
    expect(magazineCss).toContain('.mag-cover-code');
  });

  it('renders the archive option as an independent pastel cardbook layout', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const frameSource = readFileSync(path.resolve(__dirname, '../components/os/companionFrameStyles.ts'), 'utf8');
    const cardbookSource = readFileSync(path.resolve(__dirname, '../components/os/CardbookCompanionChrome.tsx'), 'utf8');
    const cardbookCss = readFileSync(path.resolve(__dirname, '../components/os/CardbookCompanionChrome.css'), 'utf8');

    expect(source).toContain('<CardbookCompanionChrome');
    expect(source).toContain("frameStyle === 'archive'");
    expect(source).toContain('cardbook-scene-backdrop');
    expect(cardbookSource).toContain('data-testid="companion-cardbook-chrome"');
    expect(cardbookSource).toContain('LUMINA CARD ARCHIVE');
    expect(cardbookSource).toContain("testId: 'companion-cardbook-wardrobe-button'");
    expect(cardbookSource).toContain('今日卡面 · CURRENT ROUTE');
    expect(cardbookCss).toContain('.cardbook-tools');
    expect(cardbookCss).toContain('.cardbook-dock .is-primary');
    expect(frameSource).toContain("name: '星愿卡册'");
  });

  it('edits every desktop sentence as opening, held middle, and closing actions', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const directorSource = readFileSync(path.resolve(__dirname, './companionPerformanceDirector.ts'), 'utf8');

    expect(source).toContain("useState<'start' | 'end'>('start')");
    expect(source).toContain('data-testid="companion-startup-cue-phase"');
    expect(source).toContain('data-testid="companion-startup-cue-hold"');
    expect(source).toContain('endDirection: cue.endDirection');
    expect(source).toContain('expandAvatarPerformanceCueBeats(cues, durationMs)');
    expect(directorSource).toContain('start、hold_ms、end');
  });

  it('makes imported Live2D outfits an explicit manual-only wardrobe workflow', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const typeSource = readFileSync(path.resolve(__dirname, '../types.ts'), 'utf8');
    const callSource = readFileSync(path.resolve(__dirname, '../apps/CallApp.tsx'), 'utf8');
    const settingsSource = readFileSync(path.resolve(__dirname, '../components/call/Live2DActionSettings.tsx'), 'utf8');
    const stageSource = readFileSync(path.resolve(__dirname, '../components/call/VRMVideoCallStage.tsx'), 'utf8');
    const wardrobeSource = readFileSync(path.resolve(__dirname, '../components/os/CompanionWardrobeDrawer.tsx'), 'utf8');

    expect(typeSource).toContain('wardrobe?: boolean');
    expect(typeSource).toContain('activeWardrobeActionId?: string');
    expect(callSource).toContain('setLive2DWardrobeOnboarding(true)');
    expect(callSource).toContain("setupMode={live2DWardrobeOnboarding ? 'import' : 'advanced'}");
    expect(settingsSource).toContain('data-testid="live2d-wardrobe-onboarding"');
    expect(settingsSource).toContain('data-testid="live2d-floating-settings-toggle"');
    expect(settingsSource).toContain('data-testid="live2d-floating-settings-panel"');
    expect(settingsSource).toContain("useState<'actions' | 'framing'>('actions')");
    expect(settingsSource).toContain('toggleWardrobe');
    expect(settingsSource).toContain("action.wardrobe ? { ...action, permission: 'manual' as const } : action");
    expect(stageSource).toContain('externalManualAction?: Live2DActionTrigger | null');
    expect(stageSource).toContain('manualAction={externalManualAction || manualAction}');
    expect(stageSource).toContain('!action.wardrobe');
    expect(wardrobeSource).toContain('data-testid="companion-real-wardrobe"');
    expect(wardrobeSource).toContain('onOpenComposition');
    expect(wardrobeSource).toContain('data-testid="companion-wardrobe-delete-confirm"');
    expect(wardrobeSource).toContain('onLongPress');
    expect(source).toContain('storeCompanionModelOutfit(character, model)');
    expect(source).not.toContain('|| avatar.actions.find(item => item.wardrobe)');
  });

  it('teaches the wardrobe scene entry once and keeps it available for static portraits', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const wardrobeSource = readFileSync(path.resolve(__dirname, '../components/os/CompanionWardrobeDrawer.tsx'), 'utf8');

    expect(source).toContain("const COMPANION_WARDROBE_DISCOVERY_KEY = 'sully-companion-wardrobe-discovery-v1'");
    expect(source).toContain('data-wardrobe-hint-active={wardrobeDiscoveryActive');
    expect(source).toContain('data-testid="companion-wardrobe-discovery-nudge"');
    expect(source).toContain("setEditingPanel('character')");
    expect(source).toContain('data-testid="companion-portrait-composition"');
    expect(source).toContain('staticMode={staticCompanionActive}');
    expect(wardrobeSource).toContain('data-testid="companion-wardrobe-discovery-tip"');
    expect(wardrobeSource).toContain('场景与构图');
  });

  it('offers built-in model quality control and pauses hidden Live2D stages', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const live2dSource = readFileSync(path.resolve(__dirname, '../components/call/Live2DAvatarCanvas.tsx'), 'utf8');

    expect(source).toContain('data-testid="companion-builtin-quality-picker"');
    expect(source).toContain('maxFps={30}');
    expect(live2dSource).toContain("document.addEventListener('visibilitychange', onDocumentVisibilityChange)");
    expect(live2dSource).toContain('new IntersectionObserver');
    expect(live2dSource).toContain("host.dataset.live2dTicker = shouldRun ? 'running' : 'paused'");
  });

  it('keeps the desktop model behind a themed curtain until its framing is stable', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const curtainSource = readFileSync(path.resolve(__dirname, '../components/os/CompanionStageLoadingCurtain.tsx'), 'utf8');
    const stageSource = readFileSync(path.resolve(__dirname, '../components/call/VRMVideoCallStage.tsx'), 'utf8');

    expect(source).toContain('<CompanionStageLoadingCurtain');
    expect(source).toContain('onModelReady={handleStageModelReady}');
    expect(source).toContain('onModelError={handleStageModelError}');
    expect(source).toContain('const settleDelay = Math.max(180, 720 - elapsed)');
    expect(source).toContain("setStageCurtainPhase('opening')");
    expect(curtainSource).toContain('data-testid="companion-stage-loading-curtain"');
    expect(curtainSource).toContain("data-phase={phase}");
    expect(curtainSource).toContain('校准舞台比例');
    expect(curtainSource).toContain('translate3d(-104%,0,0)');
    expect(stageSource).toContain('onModelError?: (message: string) => void');
  });

  it('keeps system settings on opaque neutral surfaces', () => {
    const source = readFileSync(path.resolve(__dirname, '../apps/Settings.tsx'), 'utf8');

    expect(source).toContain('bg-[#f3f4f8]');
    expect(source).toContain('bg-[#fffefe]');
    expect(source).not.toContain('bg-slate-50/50 flex flex-col');
  });

  it('runs only user-owned startup dialogue with a focused authored performance', () => {
    const source = readFileSync(path.resolve(__dirname, '../components/os/CompanionHome.tsx'), 'utf8');
    const startupSource = readFileSync(path.resolve(__dirname, './companionStartup.ts'), 'utf8');
    const tamagotchiSource = readFileSync(path.resolve(__dirname, '../components/os/TamagotchiHome.tsx'), 'utf8');
    const live2dSource = readFileSync(path.resolve(__dirname, '../components/call/Live2DAvatarCanvas.tsx'), 'utf8');
    const stageSource = readFileSync(path.resolve(__dirname, '../components/call/VRMVideoCallStage.tsx'), 'utf8');
    const vrmSource = readFileSync(path.resolve(__dirname, '../components/call/VRMAvatarCanvas.tsx'), 'utf8');
    const companionDirectorSource = readFileSync(path.resolve(__dirname, './companionPerformanceDirector.ts'), 'utf8');

    expect(source).toContain('data-testid="companion-startup-enabled"');
    expect(source).toContain('const [startupSettingsExpanded, setStartupSettingsExpanded] = useState(false)');
    expect(source).toContain('data-testid="companion-startup-settings-toggle"');
    expect(source).toContain('aria-expanded={startupSettingsExpanded}');
    expect(source).toContain('{startupSettingsExpanded && (');
    expect(source).toContain('data-testid="companion-startup-settings-body"');
    expect(source).toContain('data-testid="companion-startup-line"');
    expect(source).toContain('data-testid="companion-startup-precision"');
    expect(source).toContain('data-testid="companion-startup-cue-editor"');
    expect(source).toContain('startupEditorPerformance');
    expect(source).toContain('精调只修改当前这一句，不会清空动作编排');
    expect(source).toContain('data-testid="companion-generate-startup-performance"');
    expect(source).toContain('data-testid="companion-save-startup"');
    expect(source).not.toContain('requestCompanionStartupDraft');
    expect(source).not.toContain('data-testid="companion-generate-startup"');
    expect(source).toContain('中文原文（界面显示）');
    expect(source).toContain('语音译文（实际朗读）');
    expect(source).toContain("label: '开场预演'");
    expect(source).toContain('onModelReady={handleStageModelReady}');
    expect(source).toContain('COMPANION_BOOT_LOCK_PERFORMANCE');
    expect(source).toContain('const companionStartupPlayedThisSession = new Set<string>()');
    expect(source).toContain('const [startupHeadLocked, setStartupHeadLocked] = useState(() => !startupAlreadyPlayed)');
    expect(source).toContain('companionStartupPlayedThisSession.add(character.id)');
    expect(source).toContain('从 App 返回桌面不会重复播放');
    expect(source).toContain('headMotionLocked={startupHeadLocked}');
    expect(source).toContain("if (kind === 'startup') setStartupHeadLocked(false)");
    expect(source).toContain('audio.onended = () => {');
    expect(source).toContain('scheduleCompanionPerformanceCues(performanceCues, audio.duration * 1000)');
    expect(source).toContain('audioFeed={getCompanionAudioFeed()}');
    expect(source).toContain('feed.attach(audio)');
    expect(source).toContain("playPersistedCompanionVoice(startup, nonce, 'startup', cues)");
    expect(source).not.toContain('period.lines');
    expect(source).not.toContain('greetPerformance');
    expect(startupSource).toContain('lockAutonomy: true');
    expect(startupSource).toContain('lockHead: true');
    expect(live2dSource).toContain('const LIVE2D_HEAD_AXIS_SCALE = { x: 22, y: 16, z: 14 }');
    expect(live2dSource).toContain('const LIVE2D_BODY_AXIS_SCALE = { x: 12, y: 14, z: 12 }');
    expect(live2dSource).toContain('const LIVE2D_VTUBE_BODY_GAIN = 1.18');
    expect(live2dSource).toContain("smooth('ParamAngleX', frame.headX * LIVE2D_HEAD_AXIS_SCALE.x");
    expect(live2dSource).toContain("smooth('ParamBodyAngleX', frame.bodyX * LIVE2D_BODY_AXIS_SCALE.x");
    expect(live2dSource).toContain("smooth('ParamBodyAngleY', frame.bodyY * LIVE2D_BODY_AXIS_SCALE.y");
    expect(live2dSource).toContain("smooth('ParamBodyAngleZ', frame.bodyZ * LIVE2D_BODY_AXIS_SCALE.z");
    expect(live2dSource).toContain("x: hasParameter('xinb')");
    expect(live2dSource).toContain("y: hasParameter('yinb')");
    expect(live2dSource).toContain("z: hasParameter('zinb')");
    expect(live2dSource).toContain('for (const id of HEAD_LOCK_PARAMETER_IDS)');
    expect(live2dSource).toContain('headMotionLockedRef.current && !directedHead.enabled ? HEAD_LOCK_PARAMETER_IDS : []');
    expect(live2dSource).toContain('headMotionLockedRef.current && !allowDirectedHead');
    expect(live2dSource).toContain('getRuntimeDirectedHeadControl(authoredDirection, window.performance.now())');
    expect(live2dSource).toContain("const angleX = readParameter('ParamAngleX')");
    expect(live2dSource).toContain("const angleY = readParameter('ParamAngleY')");
    expect(live2dSource).toContain('getViewerEyeContactCompensation(normalizedHeadX, normalizedHeadY)');
    expect(live2dSource).toContain("core.setParameterValueById(resolveId('ParamEyeBallX'), finalEyeX)");
    expect(live2dSource).toContain("host.dataset.live2dFinalEyes = `${finalEyeX.toFixed(3)},${finalEyeY.toFixed(3)}`");
    expect(live2dSource).toContain("const finalMouth = motionStateRef.current === 'speaking' ? lastMouthLevel : 0");
    expect(live2dSource).toContain('for (const id of mouthOpenParameterIds)');
    expect(live2dSource).not.toContain("for (const id of config.lipSyncParameterIds.length ? config.lipSyncParameterIds : ['ParamMouthOpenY'])");
    expect(live2dSource).toContain("core.setParameterValueById(resolveId(id), finalMouth)");
    expect(live2dSource).toContain("host.dataset.live2dFinalMouth = finalMouth.toFixed(3)");
    expect(live2dSource).toContain('if (!locked || directedHead.motionOwnsHead || directedHead.paramsOwnHead) return;');
    expect(live2dSource).toContain("typeof value === 'number' && Math.abs(value) > 0.001");
    expect(live2dSource).toContain("channel: 'pending'");
    expect(live2dSource).toContain('if (!active) directedHeadMotionLeaseRef.current = null;');
    expect(live2dSource).toContain("direction.gesture === 'nod'");
    expect(live2dSource).toContain("direction.gesture === 'shake'");
    expect(live2dSource).toContain("direction.gesture === 'tilt'");
    expect(live2dSource).toContain("internal.on('beforeModelUpdate', applyFinalHeadLock)");
    expect(live2dSource).toContain("internal.off('beforeModelUpdate', applyFinalHeadLock)");
    expect(live2dSource).toContain('if (host.dataset.live2dHeadLocked !== headLock) host.dataset.live2dHeadLocked = headLock');
    expect(live2dSource).toContain('if (host.dataset.live2dAmbientHeadSuppressed !== ambientLock) host.dataset.live2dAmbientHeadSuppressed = ambientLock');
    expect(live2dSource).toContain('model.rotation = headMotionLockedRef.current || ambientAutonomyDisabledRef.current ? 0 : frame.rotation');
    expect(live2dSource).not.toContain('if (headMotionLockedRef.current) {\n      stopPerformanceMotions();');
    expect(live2dSource).toContain('stopPerformanceMotions();');
    expect(live2dSource).toContain('mainManager.stopAllMotions?.()');
    expect(live2dSource).toContain('const frame = headLocked && !directedHead.enabled ? {');
    expect(live2dSource).not.toContain('headZ: 0,\n            bodyX: 0,');
    expect(vrmSource).not.toContain('headZ: 0,\n          bodyX: 0,');
    expect(stageSource).toContain('headMotionLocked={headMotionLocked}');
    expect(stageSource).toContain("? 'companion-stage-fade 180ms ease-out both'");
    expect(vrmSource).toContain('lockAutonomy: true');
    expect(vrmSource).toContain('headLocked ? 1 : blend');
    expect(vrmSource).toContain('? modelBaseRotationY');
    expect(companionDirectorSource).toContain('buildAvatarPerformanceRehearsalPrompt');
    expect(companionDirectorSource).toContain('parseAvatarPerformanceRehearsal');
    expect(companionDirectorSource).toContain('}, 0, 30_000, {');
    expect(companionDirectorSource).not.toContain('inferAvatarPerformanceFromText');
    expect(companionDirectorSource).toContain('禁止任何随机左右转头');
    expect(companionDirectorSource).toContain('才可在对应句 cue 中有意指定一次');
    expect(companionDirectorSource).toContain('faces 只是叠加层，不能作为整句的唯一变化');
    expect(companionDirectorSource).toContain('充分调动头部 XYZ、身体 XYZ 和手臂');
    expect(source).toContain('kind: action.kind');
    expect(source).toContain('tags: action.tags');
    expect(startupSource).toContain('不要替桌面主题说话');
    expect(tamagotchiSource).not.toContain('POKE_FALLBACK');
  });
});
