import { Capacitor } from '@capacitor/core';

export type DeploymentSource = 'official' | 'unofficial' | 'unknown';

const OFFICIAL_HOSTS = new Set([
  'qegj567-cloud.github.io',
  'sully-os-nu.vercel.app',
  'friedsully.com',
]);

// Verified against the signed android-v3.5.11 Release APK; see docs/deployment-notice.md.
const OFFICIAL_ANDROID_PACKAGE = 'com.aetheros.simulator';
const OFFICIAL_ANDROID_CERTIFICATES = new Set([
  'd644dddeeb6e00191f90cf621cca2649f372a653c2c37066def2f8f9c81ef1c8',
]);

export function classifyWebDeployment(href: string): DeploymentSource {
  try {
    const { protocol, hostname } = new URL(href);
    if (protocol !== 'http:' && protocol !== 'https:') return 'unknown';
    if (OFFICIAL_HOSTS.has(hostname)) return 'official';
    // Local hostnames and IP addresses cannot establish who supplied the app.
    if (!hostname.includes('.') || hostname.endsWith('.localhost') || hostname.endsWith('.local')
      || hostname.startsWith('[') || /^\d+(\.\d+){3}$/.test(hostname)) return 'unknown';
    return 'unofficial';
  } catch {
    return 'unknown';
  }
}

export function classifyAndroidDeployment(info: unknown): DeploymentSource {
  if (!info || typeof info !== 'object') return 'unknown';
  const { packageName, certificateSha256 } = info as Record<string, unknown>;
  if (typeof packageName !== 'string' || !packageName.trim() || typeof certificateSha256 !== 'string') return 'unknown';
  const certificate = certificateSha256.replace(/:/g, '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(certificate)) return 'unknown';
  return packageName === OFFICIAL_ANDROID_PACKAGE && OFFICIAL_ANDROID_CERTIFICATES.has(certificate)
    ? 'official' : 'unofficial';
}

export async function detectDeploymentSource(href: string): Promise<DeploymentSource> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!Capacitor.isNativePlatform()) return classifyWebDeployment(href);
    if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('ApkInstaller')) return 'unknown';
    // No network or update check: read the installed APK's own signing identity.
    // Old/broken bridges must not leave the startup screen waiting indefinitely.
    const identity = async (): Promise<DeploymentSource> => {
      const { getInstalledAndroidAppInfo } = await import('./androidAppUpdate');
      return classifyAndroidDeployment(await getInstalledAndroidAppInfo());
    };
    return await Promise.race([
      identity(),
      new Promise<DeploymentSource>(resolve => { timeout = setTimeout(() => resolve('unknown'), 3000); }),
    ]);
  } catch {
    return 'unknown';
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
