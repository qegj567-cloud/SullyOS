// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppID, type CharacterProfile, type Message } from '../../types';
import type { Live2DAvatarConfig } from '../../utils/live2dModelStore';

vi.mock('../../context/OSContext', () => ({
  isPaperWallpaper: () => false,
  useOS: () => ({
    customIcons: {},
    theme: { skin: 'default', contentColor: '#ffffff', wallpaper: '' },
  }),
}));
vi.mock('../../utils/blobRef', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/blobRef')>()),
  useBlobRefUrl: () => undefined,
}));
vi.mock('../../components/os/acnhIcons', () => ({
  getAcnhIcon: () => null,
}));
vi.mock('../../components/os/appPreload', () => ({
  preloadApp: () => {},
}));
vi.mock('../../utils/blurPolicy', () => ({
  isReducedBlurActive: () => false,
  useReducedBlur: () => false,
}));
vi.mock('../../components/call/Live2DAvatarCanvas', () => ({
  default: () => React.createElement('div', { 'data-testid': 'mock-live2d-canvas' }),
}));

import ThinkingChainSettingsModal from '../../components/chat/ThinkingChainSettingsModal';
import ChatHeaderShell from '../../components/chat/ChatHeaderShell';
import { ChatCardSurface } from '../../components/chat/ChatCardSurface';
import ConfirmDialog from '../../components/os/ConfirmDialog';
import AppIcon from '../../components/os/AppIcon';
import CallUpdateAnnouncement from '../../components/call/CallUpdateAnnouncement';
import CallPreferencesSheet from '../../components/call/CallPreferencesSheet';
import VRoidBetaWarning from '../../components/call/VRoidBetaWarning';
import Live2DActionSettings from '../../components/call/Live2DActionSettings';
import { CALL_LIGHT_THEME_CSS } from '../../components/call/callLightTheme';
import { CharacterGroupFilterBar } from '../../components/character/CharacterGroupFilter';
import ObserveHUD from '../../components/date/ObserveHUD';

const REPO_ROOT = path.resolve(__dirname, '../..');
const readRepo = (relPath: string) => fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');

type SpecTuple = [number, number, number];

function splitTopLevelCommas(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

/**
 * Computes W3C Selectors Level 4 specificity (a, b, c), properly giving :where(...)
 * zero weight and :is(...)/:not(...)/:has(...) the max specificity of their arguments.
 * Used because jsdom's CSSOM resolves competing !important rules by source order alone.
 */
function selectorSpecificity(sel: string): SpecTuple {
  let a = 0;
  let b = 0;
  let c = 0;
  let i = 0;
  while (i < sel.length) {
    if (sel.startsWith(':where(', i)) {
      let depth = 1;
      i += 7;
      while (i < sel.length && depth > 0) {
        if (sel[i] === '(') depth++;
        else if (sel[i] === ')') depth--;
        i++;
      }
      continue;
    }
    const fnMatch = sel.slice(i).match(/^:(?:is|not|has)\(/);
    if (fnMatch) {
      i += fnMatch[0].length;
      const argStart = i;
      let depth = 1;
      while (i < sel.length && depth > 0) {
        if (sel[i] === '(') depth++;
        else if (sel[i] === ')') depth--;
        i++;
      }
      const inner = sel.slice(argStart, i - 1);
      let maxSub: SpecTuple = [0, 0, 0];
      for (const sub of splitTopLevelCommas(inner)) {
        const sp = selectorSpecificity(sub);
        if (sp[0] > maxSub[0] || (sp[0] === maxSub[0] && sp[1] > maxSub[1]) || (sp[0] === maxSub[0] && sp[1] === maxSub[1] && sp[2] > maxSub[2])) {
          maxSub = sp;
        }
      }
      a += maxSub[0];
      b += maxSub[1];
      c += maxSub[2];
      continue;
    }
    if (sel[i] === '[') {
      b++;
      while (i < sel.length && sel[i] !== ']') i++;
      i++;
      continue;
    }
    if (sel.startsWith('::', i)) {
      c++;
      i += 2;
      while (i < sel.length && /[\w-]/.test(sel[i])) i++;
      continue;
    }
    if (sel[i] === ':') {
      b++;
      i++;
      while (i < sel.length && /[\w-]/.test(sel[i])) i++;
      continue;
    }
    if (sel[i] === '#') {
      a++;
      i++;
      while (i < sel.length && /[\w\\-]/.test(sel[i])) i++;
      continue;
    }
    if (sel[i] === '.') {
      b++;
      i++;
      while (i < sel.length && /[\w\\/-]/.test(sel[i])) i++;
      continue;
    }
    if (/[a-zA-Z]/.test(sel[i])) {
      c++;
      while (i < sel.length && /[\w-]/.test(sel[i])) i++;
      continue;
    }
    i++;
  }
  return [a, b, c];
}

function resolveW3cCascade(cssText: string, el: Element, props: string[]): string | undefined {
  // Strip comments and @media blocks so we match top-level element rules deterministically
  const cleaned = cssText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{([\s\S]*?\})\s*\}/g, '');
  const ruleRe = /([^{}]+)\{([^{}]+)\}/g;
  let winner: { imp: number; spec: SpecTuple; order: number; val: string } | undefined;
  let order = 0;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(cleaned)) !== null) {
    order++;
    const selGroup = m[1].trim();
    const body = m[2];
    if (!selGroup || selGroup.startsWith('@')) continue;

    let bestMatchSpec: SpecTuple | undefined;
    for (const singleSel of splitTopLevelCommas(selGroup)) {
      if (!singleSel || singleSel.includes('::')) continue;
      try {
        if (el.matches(singleSel)) {
          const sp = selectorSpecificity(singleSel);
          if (
            !bestMatchSpec ||
            sp[0] > bestMatchSpec[0] ||
            (sp[0] === bestMatchSpec[0] && sp[1] > bestMatchSpec[1]) ||
            (sp[0] === bestMatchSpec[0] && sp[1] === bestMatchSpec[1] && sp[2] > bestMatchSpec[2])
          ) {
            bestMatchSpec = sp;
          }
        }
      } catch {
        // Ignore selectors unsupported by jsdom's nwsapi if any
      }
    }
    if (!bestMatchSpec) continue;

    for (const rawDecl of body.split(';')) {
      const colon = rawDecl.indexOf(':');
      if (colon < 0) continue;
      const p = rawDecl.slice(0, colon).trim().toLowerCase();
      if (!props.includes(p)) continue;
      let v = rawDecl.slice(colon + 1).trim();
      const imp = /!important\s*$/i.test(v) ? 1 : 0;
      if (imp) v = v.replace(/!important\s*$/i, '').trim();
      const cand = { imp, spec: bestMatchSpec, order, val: v };
      if (
        !winner ||
        cand.imp > winner.imp ||
        (cand.imp === winner.imp &&
          (cand.spec[0] > winner.spec[0] ||
            (cand.spec[0] === winner.spec[0] && cand.spec[1] > winner.spec[1]) ||
            (cand.spec[0] === winner.spec[0] && cand.spec[1] === winner.spec[1] && cand.spec[2] > winner.spec[2]) ||
            (cand.spec[0] === winner.spec[0] &&
              cand.spec[1] === winner.spec[1] &&
              cand.spec[2] === winner.spec[2] &&
              cand.order >= winner.order)))
      ) {
        winner = cand;
      }
    }
  }
  return winner?.val;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('theme contrast & style inheritance boundaries', () => {
  it('keeps ThinkingChainSettingsModal and ConfirmDialog readable under dark inherited text color', async () => {
    host.style.color = '#f0edff';

    await act(async () => {
      root.render(
        React.createElement(ThinkingChainSettingsModal, {
          isOpen: true,
          onClose: vi.fn(),
          onChange: vi.fn(),
          value: {
            enabled: true,
            styleId: 'stellar',
            customColors: { bg: '', accent: '', text: '' },
            customPrompt: '',
            customCss: '',
          },
        }),
      );
    });

    const modalCard = host.querySelector('.bg-white');
    const textarea = host.querySelector('textarea');
    expect(modalCard?.className).toContain('text-slate-800');
    expect(textarea?.className).toContain('text-slate-800');
    expect(textarea?.className).toContain('placeholder:text-slate-400');

    await act(async () => {
      root.render(
        React.createElement(ConfirmDialog, {
          isOpen: true,
          title: '删除确认',
          message: '确定要继续吗？',
          onConfirm: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });

    const confirmCard = host.querySelector('.bg-white.rounded-2xl');
    expect(confirmCard?.className).toContain('text-slate-800');
  });

  it('isolates .sully-chat-root to the chat stage while preserving HomePhone palette and overlay portals', () => {
    const chatSource = readRepo('apps/Chat.tsx');
    const chatOuterIdx = chatSource.indexOf("<div className={`h-full w-full relative overflow-hidden ${homePhone ? '' : 'text-slate-900'}`}>");
    const chatStyleIdx = chatSource.indexOf('<ChatRuntimeStyle', chatOuterIdx);
    const chatRootIdx = chatSource.indexOf('className={`sully-chat-root', chatOuterIdx);
    const chatBoundaryIdx = chatSource.indexOf('.sully-chat-root 仅包裹聊天舞台');
    const chatRootCloseBeforeBoundary = chatSource.lastIndexOf('</div>', chatBoundaryIdx);
    const chatInputIdx = chatSource.lastIndexOf('<ChatInputArea', chatBoundaryIdx);
    const chatModalsIdx = chatSource.indexOf('<ChatModals');
    const chatConfirmIdx = chatSource.indexOf('<ConfirmDialog');

    expect(chatOuterIdx).toBeGreaterThan(-1);
    expect(chatStyleIdx).toBeGreaterThan(chatOuterIdx);
    expect(chatRootIdx).toBeGreaterThan(chatStyleIdx);
    expect(chatInputIdx).toBeGreaterThan(chatRootIdx);
    expect(chatRootCloseBeforeBoundary).toBeGreaterThan(chatInputIdx);
    expect(chatBoundaryIdx).toBeGreaterThan(chatRootCloseBeforeBoundary);
    expect(chatModalsIdx).toBeGreaterThan(chatBoundaryIdx);
    expect(chatConfirmIdx).toBeGreaterThan(chatBoundaryIdx);

    const homePhoneCss = readRepo('apps/room3d/homePhone.css');
    expect(homePhoneCss).toContain('.home-phone .fixed{max-height:100%}');

    const groupSource = readRepo('apps/GroupChat.tsx');
    const groupOuterIdx = groupSource.indexOf('<div className="h-full w-full relative overflow-hidden text-slate-900">');
    const groupStyleIdx = groupSource.indexOf('<ChatRuntimeStyle', groupOuterIdx);
    const groupRootIdx = groupSource.indexOf('className={`sully-chat-root', groupOuterIdx);
    const groupBoundaryIdx = groupSource.indexOf('.sully-chat-root 仅包裹群聊舞台');
    const groupRootCloseBeforeBoundary = groupSource.lastIndexOf('</div>', groupBoundaryIdx);
    const groupInputIdx = groupSource.lastIndexOf('<ChatInputArea', groupBoundaryIdx);
    const groupVoiceIdx = groupSource.indexOf('<DialogueVoicePanel');
    const groupImageIdx = groupSource.indexOf('<ImageViewer');

    expect(groupOuterIdx).toBeGreaterThan(-1);
    expect(groupStyleIdx).toBeGreaterThan(groupOuterIdx);
    expect(groupRootIdx).toBeGreaterThan(groupStyleIdx);
    expect(groupInputIdx).toBeGreaterThan(groupRootIdx);
    expect(groupRootCloseBeforeBoundary).toBeGreaterThan(groupInputIdx);
    expect(groupBoundaryIdx).toBeGreaterThan(groupRootCloseBeforeBoundary);
    expect(groupVoiceIdx).toBeGreaterThan(groupBoundaryIdx);
    expect(groupImageIdx).toBeGreaterThan(groupBoundaryIdx);

    const messageItemSource = readRepo('components/chat/MessageItem.tsx');
    expect(messageItemSource).toContain('sully-chat-transfer-dialog w-full max-w-[320px] bg-white text-slate-800');
    expect(messageItemSource).toContain('expanded && renderChatOverlayPortal(');
    expect(messageItemSource).toContain('open && renderChatOverlayPortal(');
  });

  it('preserves Qixi/Like520 card artwork, active bubble chips, pill buttons, and header status hooks in built-in whiteboxes', async () => {
    const acidOrbit = JSON.parse(readRepo('presets/chat/acid-orbit.json')) as { parts: { css: string } };
    const lavender = JSON.parse(readRepo('presets/chat/acid-orbit-lavender.json')) as { parts: { css: string } };
    const nocturneCss = readRepo('art/acid-orbit/nocturne-line.css');

    const qixiMsg: Message = {
      id: 1,
      charId: 'c1',
      role: 'assistant',
      type: 'score_card',
      content: '',
      timestamp: 1,
      metadata: { scoreCard: { type: 'qixi_event_card', title: '星月梦境' } },
    };
    const like520Msg: Message = {
      id: 2,
      charId: 'c1',
      role: 'assistant',
      type: 'score_card',
      content: '',
      timestamp: 2,
      metadata: { scoreCard: { type: 'like520_card', title: '我们的下午' } },
    };

    const phoneMsg: Message = {
      id: 3,
      charId: 'c1',
      role: 'assistant',
      type: 'phone_card',
      content: '',
      timestamp: 3,
    };

    for (const css of [acidOrbit.parts.css, lavender.parts.css, nocturneCss]) {
      await act(async () => {
        root.render(
          React.createElement(
            'div',
            { className: 'sully-chat-root' },
            React.createElement('style', null, css),
            React.createElement(
              ChatCardSurface,
              { message: qixiMsg },
              React.createElement('div', { 'data-testid': 'qixi-art', style: { backgroundColor: 'rgb(36, 20, 58)' } }, '七夕'),
            ),
            React.createElement(
              ChatCardSurface,
              { message: like520Msg },
              React.createElement('div', { 'data-testid': 'l520-art', style: { backgroundColor: 'rgb(253, 246, 227)' } }, '520'),
            ),
            React.createElement(
              ChatCardSurface,
              { message: phoneMsg },
              React.createElement(
                'details',
                { 'data-testid': 'phone-details', style: { backgroundColor: 'rgb(16, 12, 28)' } },
                React.createElement('summary', { 'data-testid': 'phone-summary' }, '折叠详情'),
                React.createElement('pre', { 'data-testid': 'phone-pre' }, '日志'),
              ),
            ),
            React.createElement(
              'div',
              { className: 'sully-chat-panel' },
              React.createElement(
                'div',
                { role: 'group' },
                React.createElement('button', { 'data-testid': 'action-tile' }, React.createElement('div', null, '+')),
              ),
              React.createElement('button', { className: 'sully-chat-bubble-chip', 'data-testid': 'chip-inactive' }, '默认'),
              React.createElement('button', { className: 'sully-chat-bubble-chip', 'data-active': 'true', 'data-testid': 'chip-active' }, '水色'),
              React.createElement(
                'div',
                { className: 'sully-chat-bubble-pill', 'data-active': 'true', 'data-testid': 'pill-active' },
                React.createElement('button', { 'data-testid': 'pill-inner-btn' }, '自设气泡'),
                React.createElement('button', { className: 'sully-chat-bubble-danger', 'data-testid': 'pill-danger-btn' }, '确删'),
              ),
            ),
          ),
        );
      });

      const qixiArt = host.querySelector('[data-testid="qixi-art"]') as HTMLElement;
      const l520Art = host.querySelector('[data-testid="l520-art"]') as HTMLElement;
      expect(getComputedStyle(qixiArt).backgroundColor).toBe('rgb(36, 20, 58)');
      expect(getComputedStyle(l520Art).backgroundColor).toBe('rgb(253, 246, 227)');

      const phoneDetails = host.querySelector('[data-testid="phone-details"]') as HTMLElement;
      const phoneSummary = host.querySelector('[data-testid="phone-summary"]') as HTMLElement;
      const phonePre = host.querySelector('[data-testid="phone-pre"]') as HTMLElement;
      expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(getComputedStyle(phoneDetails).backgroundColor);
      expect(resolveW3cCascade(css, phoneDetails, ['background-image'])).toBe('none');
      expect(resolveW3cCascade(css, phoneSummary, ['color'])).toBeDefined();
      expect(resolveW3cCascade(css, phonePre, ['color'])).toBeDefined();

      if (css !== nocturneCss) {
        const actionTile = host.querySelector('[data-testid="action-tile"]') as HTMLElement;
        expect(resolveW3cCascade(css, actionTile, ['background', 'background-color'])).toBe('transparent');
      }

      const chipInactive = host.querySelector('[data-testid="chip-inactive"]') as HTMLElement;
      const chipActive = host.querySelector('[data-testid="chip-active"]') as HTMLElement;
      const pillActive = host.querySelector('[data-testid="pill-active"]') as HTMLElement;
      const pillInnerBtn = host.querySelector('[data-testid="pill-inner-btn"]') as HTMLElement;
      const pillDangerBtn = host.querySelector('[data-testid="pill-danger-btn"]') as HTMLElement;

      // Validate using true W3C Selectors Level 4 specificity (not jsdom source-order)
      expect(resolveW3cCascade(css, chipActive, ['color'])).toBe('#ffffff');
      expect(resolveW3cCascade(css, chipActive, ['background', 'background-color'])).not.toBe(
        resolveW3cCascade(css, chipInactive, ['background', 'background-color']),
      );
      expect(resolveW3cCascade(css, pillActive, ['color'])).toBe('#ffffff');
      expect(resolveW3cCascade(css, pillInnerBtn, ['color'])).toBe('inherit');
      expect(resolveW3cCascade(css, pillDangerBtn, ['background', 'background-color'])).toBe('#dc2626');
      expect(resolveW3cCascade(css, pillDangerBtn, ['color'])).toBe('#ffffff');
    }

    // Verify ChatHeaderShell treats sample "在线" as online status and group member count as custom status
    const noop = () => {};
    await act(async () => {
      root.render(
        React.createElement(
          'div',
          null,
          React.createElement(ChatHeaderShell, {
            selectionMode: false,
            selectedCount: 0,
            onCancelSelection: noop,
            activeCharacter: { id: 'c1', name: '示例角色', avatar: '' },
            isTyping: false,
            isSummarizing: false,
            statusText: '在线',
            onClose: noop,
            onTriggerAI: noop,
            onShowCharsPanel: noop,
          }),
        ),
      );
    });
    expect(host.querySelector('.sully-chat-online-status')).not.toBeNull();
    expect(host.querySelector('.sully-chat-custom-status')).toBeNull();

    await act(async () => {
      root.render(
        React.createElement(
          'div',
          null,
          React.createElement(ChatHeaderShell, {
            selectionMode: false,
            selectedCount: 0,
            onCancelSelection: noop,
            activeCharacter: { id: 'g1', name: '测试群', avatar: '' },
            isTyping: false,
            isSummarizing: false,
            statusText: '3 成员',
            onClose: noop,
            onTriggerAI: noop,
            onShowCharsPanel: noop,
          }),
        ),
      );
    });
    expect(host.querySelector('.sully-chat-custom-status')).not.toBeNull();
  });

  it('applies AppIcon contentColorOverride and updates cleanly across React.memo', async () => {
    const app = { id: AppID.Chat, name: 'Chat', icon: 'Chat', color: 'bg-blue-500' };

    await act(async () => {
      root.render(React.createElement(AppIcon, { app, contentColorOverride: '#112233', onClick: () => {} }));
    });
    const label1 = host.querySelector('span');
    expect(label1?.style.color).toBe('rgb(17, 34, 51)');

    await act(async () => {
      root.render(React.createElement(AppIcon, { app, contentColorOverride: '#445566', onClick: () => {} }));
    });
    const label2 = host.querySelector('span');
    expect(label2?.style.color).toBe('rgb(68, 85, 102)');
  });

  it('shields dark overlays (including self-elements and spotlight siblings) from CALL_LIGHT_THEME_CSS and styles optgroup options', async () => {
    const baseUtilities = '.text-white{color:#fff}.text-white\\/70{color:rgba(255,255,255,0.7)}.text-white\\/28{color:rgba(255,255,255,0.28)}';

    await act(async () => {
      root.render(
        React.createElement(
          'div',
          { className: 'sully-call-light text-white' },
          React.createElement('style', null, `${baseUtilities}\n${CALL_LIGHT_THEME_CSS}`),
          React.createElement(CallUpdateAnnouncement, {
            accentColor: '#c084fc',
            onDismiss: vi.fn(),
            onOpenSettings: vi.fn(),
          }),
          React.createElement(VRoidBetaWarning, {
            fileName: 'avatar.vrm',
            onCancel: vi.fn(),
            onContinue: vi.fn(),
          }),
        ),
      );
    });

    const spotlightBubble = host.querySelector('[data-testid="call-settings-spotlight"] .text-white\\/70') as HTMLElement;
    expect(spotlightBubble).not.toBeNull();
    expect(getComputedStyle(spotlightBubble).color).toBe('rgba(255, 255, 255, 0.7)');

    const vroidDialog = host.querySelector('[aria-labelledby="vroid-beta-title"]') as HTMLElement;
    expect(vroidDialog).not.toBeNull();
    expect(getComputedStyle(vroidDialog).color).toBe('rgb(255, 255, 255)');

    const config: Live2DAvatarConfig = {
      format: 'live2d',
      assetId: 'asset-1',
      fileName: 'model.zip',
      modelPath: 'model/model.model3.json',
      byteLength: 1024,
      fileCount: 2,
      importedAt: 1,
      actions: [],
    };
    await act(async () => {
      root.render(
        React.createElement(Live2DActionSettings, {
          config,
          characterName: '测试角色',
          accentColor: '#c084fc',
          onSave: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    const live2dRoot = host.querySelector('.sully-stage-dark');
    expect(live2dRoot).not.toBeNull();
    expect(live2dRoot?.className).toContain('[color-scheme:dark]');

    const live2dSource = readRepo('components/call/Live2DActionSettings.tsx');
    expect(live2dSource).toContain('[&_option]:bg-[#12101b] [&_option]:text-white');

    expect(CALL_LIGHT_THEME_CSS).toContain('.sully-call-light .sully-stage-dark{color-scheme:dark}');
    expect(CALL_LIGHT_THEME_CSS).toContain('.sully-call-light .text-white\\/25');
    expect(CALL_LIGHT_THEME_CSS).toContain('.sully-call-light .text-white\\/28');

    // Light-mode CallApp group filter chip & preferences switch thumb keep white foreground/background
    await act(async () => {
      root.render(
        React.createElement(
          'div',
          { className: 'sully-call-light text-white' },
          React.createElement('style', null, `.bg-white{background-color:#fff}${baseUtilities}\n${CALL_LIGHT_THEME_CSS}`),
          React.createElement(CharacterGroupFilterBar, {
            characters: [{ id: 'c1', name: 'A', groupId: 'g1' } as CharacterProfile],
            groups: [{ id: 'g1', name: '分组1', order: 0 }],
            value: 'g1',
            dark: false,
            onChange: vi.fn(),
          }),
          React.createElement(CallPreferencesSheet, {
            preferences: { characterInitiative: true, voiceAutoPlay: true, idleNudgeEnabled: false },
            accentColor: '#8b5cf6',
            lightTheme: true,
            onChange: vi.fn(),
            onOpenSystemSettings: vi.fn(),
            onClose: vi.fn(),
          }),
        ),
      );
    });
    const activeChip = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('分组1')) as HTMLElement;
    expect(activeChip).not.toBeUndefined();
    expect(getComputedStyle(activeChip).color).toBe('rgb(255, 255, 255)');

    const switchThumb = host.querySelector('[role="switch"] span') as HTMLElement;
    expect(switchThumb).not.toBeNull();
    expect(getComputedStyle(switchThumb).backgroundColor).toBe('rgb(255, 255, 255)');
  });

  it('remaps Collaboration dark themes without substring-matching placeholder:/active: or hiding switch thumbs', async () => {
    const collabCss = readRepo('features/collaboration/appearance.css');
    await act(async () => {
      root.render(
        React.createElement(
          'div',
          { className: 'collab-ui-root collab-ui-dark collab-ui-charcoal' },
          React.createElement(
            'input',
            { 'data-testid': 'collab-input', className: 'text-slate-800 placeholder:text-slate-400' },
          ),
          React.createElement(
            'button',
            { 'data-testid': 'collab-idle-btn', className: 'text-slate-500 active:bg-slate-100 hover:bg-white/55' },
            '未选中',
          ),
          React.createElement('span', { 'data-testid': 'collab-thumb', className: 'collab-switch-thumb bg-white' }),
        ),
      );
    });
    const collabInput = host.querySelector('[data-testid="collab-input"]') as Element;
    const collabIdleBtn = host.querySelector('[data-testid="collab-idle-btn"]') as Element;
    const collabThumb = host.querySelector('[data-testid="collab-thumb"]') as Element;

    expect(resolveW3cCascade(collabCss, collabInput, ['color'])).toBe('var(--collab-ink)');
    expect(resolveW3cCascade(collabCss, collabIdleBtn, ['background', 'background-color'])).toBeUndefined();
    expect(resolveW3cCascade(collabCss, collabThumb, ['background', 'background-color'])).toBe('var(--collab-ink)');
  });

  it('switches ObserveHUD crystal card to dark value ink on light reading surfaces', async () => {
    const observation = { state: '神情平稳，眼神柔和' };
    const config = { enabled: true, style: 'crystal' as const };

    await act(async () => {
      root.render(React.createElement(ObserveHUD, { observation, variant: 'card', config, lightSurface: false }));
    });
    const darkBgValue = host.querySelector('p');
    expect(darkBgValue?.className).toContain('text-white');

    await act(async () => {
      root.render(React.createElement(ObserveHUD, { observation, variant: 'card', config, lightSurface: true }));
    });
    const lightBgValue = host.querySelector('p');
    expect(lightBgValue?.className).toContain('text-slate-800');
    expect(lightBgValue?.className).not.toContain('text-white');
  });
});

// 保持 CharacterProfile 类型引用未漂移
export type _CharacterProfileGuard = CharacterProfile;
