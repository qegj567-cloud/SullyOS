import { describe, expect, it } from 'vitest';
import {
  COLLABORATION_MAKER_MAP,
  buildInstallablePreviewDocument,
  installableToThemePatch,
  installableToWorldbooks,
  parseInstallableArtifactBlocks,
  validateInstallableArtifact,
} from '../features/collaboration/makers';

describe('collaboration installable makers', () => {
  it('whitebox defaults to core content while accepting optional card styles',()=>{
    const css='.sully-psyche-body{color:#345!important}.sully-chat-card[data-card-kind="world_card"] .sully-chat-card-surface{border-radius:12px}';
    expect(validateInstallableArtifact({kind:'whitebox-css',title:'完整白框',payload:{css}})).toEqual([]);
    expect(COLLABORATION_MAKER_MAP['whitebox-css'].prompt).toContain('其他 App 卡片仅在用户明确点名时增加样式');
    expect(COLLABORATION_MAKER_MAP['whitebox-css'].prompt).toContain('.sully-psyche-body');
    expect(COLLABORATION_MAKER_MAP['whitebox-css'].prompt).toContain('diary_card');
    expect(COLLABORATION_MAKER_MAP['whitebox-css'].prompt).toContain('完整接口清单不等于必须逐项输出');
  });
  it('parses typed installable blocks without exposing the internal protocol', () => {
    const parsed = parseInstallableArtifactBlocks(`我按你的气质做了一版。\n\n\`\`\`sully-artifact
kind: journal-css
title: 夜航日记
---
{"css":".sully-journal-root{background:#111827!important;}"}
\`\`\``);
    expect(parsed.visibleText).toBe('我按你的气质做了一版。');
    expect(parsed.artifacts).toEqual([{
      kind: 'journal-css',
      title: '夜航日记',
      payload: { css: '.sully-journal-root{background:#111827!important;}' },
    }]);
  });

  it('keeps malformed generated blocks visible so content is not silently lost', () => {
    const raw = '```sully-artifact\nkind: bubble-theme\ntitle: 坏掉的作品\n---\n{not-json}\n```';
    expect(parseInstallableArtifactBlocks(raw)).toEqual({ visibleText: raw, artifacts: [] });
  });

  it('rejects CSS that escapes its native product scope', () => {
    const errors = validateInstallableArtifact({
      kind: 'journal-css',
      title: '越界 CSS',
      payload: { css: 'body{display:none}.sully-journal-root{color:red}' },
    });
    expect(errors.join('\n')).toContain('body');
    expect(validateInstallableArtifact({
      kind: 'psyche-css',
      title: '安全 CSS',
      payload: { css: '.sully-psyche-card{border-radius:18px!important;animation:pulse 2s infinite}@keyframes pulse{from{opacity:.8}50%{opacity:1}to{opacity:.8}}' },
    })).toEqual([]);
  });

  it('only installs whitelisted appearance fields and native worldbook data', () => {
    const patch = installableToThemePatch({
      kind: 'appearance-preset',
      title: '清晨',
      payload: { theme: { hue: 32, darkMode: false, chatHeaderStyle: 'minimal', chatTimestampPosition: 'top_center', apiKey: 'must-not-pass' } },
    });
    expect(patch).toEqual({ hue: 32, darkMode: false, chatHeaderStyle: 'minimal', chatTimestampPosition: 'top_center' });
    expect(JSON.stringify(patch)).not.toContain('apiKey');

    const worldbooks = installableToWorldbooks({
      kind: 'worldbook',
      title: '雨城',
      payload: {
        category: '雨城',
        entries: {
          '0': { uid: 0, comment: '雨城规则', content: '城里总在下雨。', constant: true, key: [], position: 0 },
          '1': { uid: 1, comment: '旧车站', content: '提到车站时，她会想起离别。', constant: false, key: ['车站'], position: 4, depth: 2, role: 2 },
        },
      },
    });
    expect(worldbooks).toHaveLength(2);
    expect(worldbooks[0]).toMatchObject({ title: '雨城规则', category: '雨城', content: '城里总在下雨。', constant: true, position: 0, sourceUid: 0 });
    expect(worldbooks[1]).toMatchObject({ title: '旧车站', key: ['车站'], position: 4, depth: 2, role: 2, sourceUid: 1 });
  });

  it('validates a worldbook as one category containing SillyTavern entries', () => {
    expect(validateInstallableArtifact({
      kind: 'worldbook',
      title: '学院设定',
      payload: {
        category: '学院设定',
        entries: {
          '0': { comment: '校规', content: '午夜后禁止离开宿舍。', constant: true, position: 1 },
          '1': { comment: '钟楼', content: '钟楼只在雨夜开放。', key: ['钟楼'], constant: false, position: 4 },
        },
      },
    })).toEqual([]);
    expect(validateInstallableArtifact({ kind: 'worldbook', title: '空书', payload: { category: '空书', entries: {} } })).toContain('世界书里没有条目。');
  });

  it('upgrades an older single-entry worldbook artifact into a one-entry group', () => {
    const books = installableToWorldbooks({
      kind: 'worldbook',
      title: '旧作品',
      payload: { category: '旧分类', title: '旧条目', content: '旧格式正文', constant: true, position: 1 },
    });
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ category: '旧分类', title: '旧条目', content: '旧格式正文', constant: true, position: 1 });
  });

  it('covers every user-facing maker in the registry', () => {
    expect(Object.keys(COLLABORATION_MAKER_MAP).sort()).toEqual([
      'appearance-preset', 'bubble-theme', 'character-card', 'journal-css',
      'psyche-css', 'schedule-css', 'whitebox-css', 'worldbook',
    ]);
  });

  it('injects the complete real selector catalog for each CSS maker', () => {
    const bubblePrompt = COLLABORATION_MAKER_MAP['bubble-theme'].prompt;
    const whiteboxPrompt = COLLABORATION_MAKER_MAP['whitebox-css'].prompt;
    const journalPrompt = COLLABORATION_MAKER_MAP['journal-css'].prompt;
    const schedulePrompt = COLLABORATION_MAKER_MAP['schedule-css'].prompt;
    const psychePrompt = COLLABORATION_MAKER_MAP['psyche-css'].prompt;
    expect(bubblePrompt).toContain('.sully-voice-bar-wave-segment');
    expect(whiteboxPrompt).toContain('.sully-chat-turn-avatar-slot');
    expect(whiteboxPrompt).toContain('.sully-chat-time-divider');
    expect(whiteboxPrompt).toContain('.sully-chat-timestamp');
    expect(whiteboxPrompt).toContain('.sully-collaboration-file-action');
    for (const part of ['card', 'receipt', 'header', 'icon', 'brand', 'watermark', 'amount', 'note', 'recipient', 'status', 'overlay', 'dialog', 'accept', 'return']) {
      expect(whiteboxPrompt).toContain(`.sully-chat-transfer-${part}`);
    }
    expect(whiteboxPrompt).toContain('.sully-chat-avatar-wrap');
    expect(whiteboxPrompt).toContain('.sully-chat-avatar-frame');
    expect(validateInstallableArtifact({ kind: 'whitebox-css', title: '转账和头像框', payload: { css: '.sully-chat-transfer-card[data-status="pending"]{color:red}.sully-chat-avatar-wrap::after{content:"";pointer-events:none}' } })).toEqual([]);
    expect(journalPrompt).toContain('.sully-journal-cursor-spark');
    expect(schedulePrompt).toContain('.sully-schedule-change-shine');
    expect(psychePrompt).toContain('.sully-psyche-body');
    for (const prompt of [bubblePrompt, whiteboxPrompt, journalPrompt, schedulePrompt, psychePrompt]) {
      expect(prompt).toContain('prefers-reduced-motion');
      expect(prompt).toContain('全部可用选择器');
    }
  });

  it('builds a network-isolated full-screen CSS preview document', () => {
    const doc = buildInstallablePreviewDocument({
      kind: 'whitebox-css',
      title: '星夜白框',
      payload: { css: '.sully-chat-header{background:#111827!important;}' },
    });
    expect(doc).toContain('Content-Security-Policy');
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain('.sully-chat-header{background:#111827!important;}');
    expect(doc).toContain('sully-chat-inputbar');
  });
});
