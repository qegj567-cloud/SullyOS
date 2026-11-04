import sully from '../presets/appearance/sully.json';
import type { AppearancePreset, OSTheme } from '../types';

/** Small manifest only; images are loaded when previewed or applied.
 * Existing installs: see docs/builtin-appearance-upgrades.md for the targeted icon backfill. */
export const BUILTIN_APPEARANCE_PRESETS = [sully] as Array<AppearancePreset & { type: 'sully_appearance_preset'; version: number }>;

export function isBuiltinAppearance(id: string): boolean {
  return BUILTIN_APPEARANCE_PRESETS.some(preset => preset.id === id);
}

async function embeddedImage(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('内置主题素材未能载入，请重试');
  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('内置主题素材格式不正确，请刷新后重试');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('内置主题素材读取失败'));
    reader.readAsDataURL(blob);
  });
}

/** Materialize every asset before any state write. The normal apply path persists
 * these as blob refs, so restart, offline use and personal backups stay portable.
 * Desktop artwork must not replace chat, journal, schedule or animation settings. */
export async function readBuiltinAppearance(id: string, currentTheme: OSTheme): Promise<AppearancePreset> {
  const bundled = BUILTIN_APPEARANCE_PRESETS.find(preset => preset.id === id);
  if (!bundled) throw new Error('内置主题不存在');
  const preset = structuredClone(bundled);
  const images = new Map<string, Promise<string>>();
  const image = (url: string) => {
    if (!images.has(url)) images.set(url, embeddedImage(url));
    return images.get(url)!;
  };
  const [wallpaper, widgets, icons] = await Promise.all([
    image(preset.theme.wallpaper),
    Promise.all(Object.entries(preset.theme.launcherWidgets || {}).map(async ([slot, url]) => [slot, await image(url)])),
    Promise.all(Object.entries(preset.customIcons || {}).map(async ([app, url]) => [app, await image(url)])),
  ]);
  return { ...preset, theme: { ...currentTheme, ...preset.theme, wallpaper, launcherWidgets: Object.fromEntries(widgets) }, customIcons: Object.fromEntries(icons) };
}
