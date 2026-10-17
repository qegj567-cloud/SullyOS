import { describe, expect, it } from 'vitest';
import { resolveCollaborationAppearance, validateCollaborationCss } from '../features/collaboration/appearance';
import { CollaborationStore } from '../features/collaboration/store';
import { DEFAULT_COLLABORATION_SETTINGS } from '../features/collaboration/types';

describe('collaboration appearance', () => {
  it('keeps old backups usable and ignores unknown themes', () => {
    expect(resolveCollaborationAppearance({})).toMatchObject({ uiTheme: 'sully', dark: false, customCss: '' });
    expect(resolveCollaborationAppearance({ uiTheme: 'future-theme' as any })).toMatchObject({ uiTheme: 'sully', dark: false });
  });

  it.each(['charcoal', 'warm-night', 'midnight'] as const)('restores %s and custom CSS through backup', async uiTheme => {
    const customCss = '.collab-ui-root { --collab-accent: #b8d8c0; }';
    await CollaborationStore.saveSettings({ ...DEFAULT_COLLABORATION_SETTINGS, uiTheme, customCss });
    const backup = await CollaborationStore.exportBackup(false, true);
    await CollaborationStore.saveSettings({ ...DEFAULT_COLLABORATION_SETTINGS });
    await CollaborationStore.importBackup(backup);
    expect(resolveCollaborationAppearance(await CollaborationStore.loadSettings())).toMatchObject({ uiTheme, dark: true, customCss });
  });

  it('accepts scoped overrides including responsive rules', () => {
    expect(validateCollaborationCss('.collab-ui-root { --collab-bg: #202020; } @media (max-width: 600px) { .collab-ui-root .collab-message-bubble { border-radius: 12px; } }').isValid).toBe(true);
  });

  it.each([
    'body { color: red; }',
    '.collab-ui-root, body { color: red; }',
    '.collab-ui-root + main { display: none; }',
    '.collab-ui-root ~ * { display: none; }',
    '@import url("https://example.com/style.css");',
    '@font-face { font-family: example; src: url(example.woff); }',
    '.collab-ui-root { color: red;',
  ])('rejects invalid or unscoped CSS: %s', css => {
    expect(validateCollaborationCss(css).isValid).toBe(false);
    expect(resolveCollaborationAppearance({ customCss: css }).customCss).toBe('');
  });
});
