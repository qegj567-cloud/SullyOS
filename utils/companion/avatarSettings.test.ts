// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { CharacterProfile } from '../../types';
import type { Live2DAvatarConfig } from '../live2dModelStore';
import { saveLive2DModelFromZip } from '../live2dModelStore';
import CompanionAvatarSettings from '../../components/companion/CompanionAvatarSettings';

const os = vi.hoisted(() => ({ characters: [] as CharacterProfile[], updateCharacter: vi.fn(), openApp: vi.fn(), addToast: vi.fn() }));
vi.mock('../../context/OSContext', () => ({ useOS: () => os }));
vi.mock('../live2dCore', () => ({ preloadLive2DRuntime: vi.fn(async () => {}) }));
vi.mock('../live2dModelStore', async original => ({ ...await original<typeof import('../live2dModelStore')>(), saveLive2DModelFromZip: vi.fn() }));
vi.mock('../../components/call/Live2DAvatarCanvas', () => ({ default: () => null }));

const model: Live2DAvatarConfig = {
  format: 'live2d', version: 1, assetId: 'existing', fileName: 'existing.zip', modelPath: 'model.model3.json',
  byteLength: 10, fileCount: 3, importedAt: 1, lipSyncParameterIds: [],
  actions: [{ id: 'coat', name: '街头外套', kind: 'expression', file: 'coat.exp3.json', tags: [], permission: 'manual', wardrobe: true }],
};

it('uses the character’s video-call model, selects clothing and keeps it when another model is imported', async () => {
  const initial = { id: 'actor', name: '测试角色', avatar: '', videoAvatar: model } as CharacterProfile;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Fixture() {
    const [char, setChar] = React.useState(initial);
    os.characters = [char];
    os.updateCharacter.mockImplementation((id: string, patch: Partial<CharacterProfile>) => {
      expect(id).toBe(initial.id);
      setChar(current => ({ ...current, ...patch }));
    });
    return React.createElement(CompanionAvatarSettings, { char, close: () => {} });
  }
  const button = (text: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.includes(text))!;
  try {
    await act(async () => root.render(React.createElement(Fixture)));
    const clothes = [...host.querySelectorAll('label')].find(label => label.textContent?.includes('穿戴服装'))!.querySelector('select')!;
    await act(async () => { clothes.value = 'coat'; clothes.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(os.characters[0].videoAvatar).toMatchObject({ assetId: 'existing', activeWardrobeActionId: 'coat' });
    await act(async () => button('校准构图').click());
    expect(host.textContent).toContain('街头外套');
    await act(async () => button('保存权限').click());
    expect(os.characters[0].videoAvatar).toMatchObject({ actions: [{ id: 'coat', permission: 'manual', wardrobe: true }] });
    vi.mocked(saveLive2DModelFromZip).mockResolvedValue({ ...model, assetId: 'summer', fileName: 'summer.zip' });
    await act(async () => button('模型文件').click());
    const picker = document.body.querySelector<HTMLInputElement>('input[type=file]')!;
    const file = new File(['demo'], 'summer.zip');
    Object.defineProperty(picker, 'files', { value: [file] });
    await act(async () => { picker.dispatchEvent(new Event('change')); });
    expect(saveLive2DModelFromZip).toHaveBeenCalledWith(file, expect.any(Function));
    expect(os.characters[0]).toMatchObject({
      videoAvatar: { assetId: 'summer' }, videoAvatarWardrobe: [{ assetId: 'existing', activeWardrobeActionId: 'coat' }],
      companionAvatar: { source: 'model' },
    });
    expect(button('保存并完成导入')).toBeTruthy();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
