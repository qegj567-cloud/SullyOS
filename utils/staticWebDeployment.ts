const STATIC_HOST_SUFFIXES = ['.github.io', '.workers.dev'];
const STATIC_HOSTS = new Set(['github.io', 'friedsully.com', 'test.friedsully.com']);

export function isStaticWebDeployment(protocol: string, hostname: string): boolean {
  if (String(protocol || '').toLowerCase() === 'file:') return true;
  const host = String(hostname || '').trim().toLowerCase();
  return STATIC_HOSTS.has(host) || STATIC_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}
