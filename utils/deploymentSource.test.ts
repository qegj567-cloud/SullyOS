import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { getInstalledAndroidAppInfo } from './androidAppUpdate';
import { classifyAndroidDeployment, classifyWebDeployment, detectDeploymentSource } from './deploymentSource';

vi.mock('@capacitor/core', () => ({ Capacitor: {
  isNativePlatform: vi.fn(() => false), getPlatform: vi.fn(() => 'web'),
  isPluginAvailable: vi.fn(() => true),
} }));
vi.mock('./androidAppUpdate', () => ({ getInstalledAndroidAppInfo: vi.fn() }));

const officialApk = {
  packageName: 'com.aetheros.simulator', versionCode: 30511, versionName: '3.5.11',
  certificateSha256: 'd644dddeeb6e00191f90cf621cca2649f372a653c2c37066def2f8f9c81ef1c8',
  canRequestPackageInstalls: false,
};
beforeEach(() => { vi.resetAllMocks(); vi.mocked(Capacitor.isPluginAvailable).mockReturnValue(true); });
afterEach(() => vi.useRealTimers());

describe('web deployment identity', () => {
  it.each(['https://qegj567-cloud.github.io/SullyOS/', 'https://sully-os-nu.vercel.app/', 'https://friedsully.com/'])('recognizes the official site %s', url => {
    expect(classifyWebDeployment(url)).toBe('official');
  });
  it.each(['https://fork.github.io/SullyOS/', 'https://fork.vercel.app/', 'https://fork.example.com/',
    'https://friedsully.com.evil.com/', 'https://evilfriedsully.com/', 'https://friedsully.com@evil.com/'])('warns on a nonofficial public address %s', url => {
    expect(classifyWebDeployment(url)).toBe('unofficial');
  });
  it.each(['http://localhost:5173/', 'http://test.localhost/', 'http://127.0.0.1/', 'http://192.168.1.2/',
    'http://10.0.0.2/', 'http://172.16.0.2/', 'http://[::1]/', 'http://computer.local/',
    'http://computer/', 'file:///index.html', 'capacitor://localhost/', 'invalid'])('does not claim a local or unidentifiable source is unofficial: %s', url => {
    expect(classifyWebDeployment(url)).toBe('unknown');
  });
});

it('requires both the APK package and signing certificate, independent of version', () => {
  expect(classifyAndroidDeployment(officialApk)).toBe('official');
  expect(classifyAndroidDeployment({ ...officialApk, versionCode: 99999 })).toBe('official');
  expect(classifyAndroidDeployment({ ...officialApk, certificateSha256: officialApk.certificateSha256.toUpperCase().match(/../g)!.join(':') })).toBe('official');
  expect(classifyAndroidDeployment({ ...officialApk, packageName: 'com.other.app' })).toBe('unofficial');
  expect(classifyAndroidDeployment({ ...officialApk, certificateSha256: 'b'.repeat(64) })).toBe('unofficial');
  expect(classifyAndroidDeployment({ ...officialApk, certificateSha256: '' })).toBe('unknown');
  expect(classifyAndroidDeployment(null)).toBe('unknown');
});

it('uses the native signature instead of trusting a native WebView hostname', async () => {
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  vi.mocked(Capacitor.getPlatform).mockReturnValue('android');
  vi.mocked(getInstalledAndroidAppInfo).mockResolvedValue(officialApk);
  expect(await detectDeploymentSource('https://localhost/')).toBe('official');
  vi.mocked(getInstalledAndroidAppInfo).mockResolvedValue({ ...officialApk, certificateSha256: 'b'.repeat(64) });
  expect(await detectDeploymentSource('https://friedsully.com/')).toBe('unofficial');
});

it('handles missing, failed and hanging native identity bridges without blocking startup forever', async () => {
  vi.useFakeTimers();
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  vi.mocked(Capacitor.getPlatform).mockReturnValue('android');
  vi.mocked(Capacitor.isPluginAvailable).mockReturnValue(false);
  expect(await detectDeploymentSource('https://localhost/')).toBe('unknown');
  vi.mocked(Capacitor.isPluginAvailable).mockReturnValue(true);
  vi.mocked(getInstalledAndroidAppInfo).mockRejectedValue(new Error('old APK'));
  expect(await detectDeploymentSource('https://localhost/')).toBe('unknown');
  vi.mocked(getInstalledAndroidAppInfo).mockReturnValue(new Promise(() => {}));
  const pending = detectDeploymentSource('https://localhost/');
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toBe('unknown');
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps ordinary browser localhost unknown and official web pages official', async () => {
  expect(await detectDeploymentSource('http://localhost:5173/')).toBe('unknown');
  expect(await detectDeploymentSource('https://friedsully.com/')).toBe('official');
});
