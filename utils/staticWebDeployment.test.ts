import { describe, expect, it } from 'vitest';
import { isStaticWebDeployment } from './staticWebDeployment';

describe('isStaticWebDeployment', () => {
  it.each([
    ['https:', 'qegj567-cloud.github.io'],
    ['https:', 'friedsully.com'],
    ['https:', 'test.friedsully.com'],
    ['https:', 'sully-os-site.qegj567.workers.dev'],
    ['file:', ''],
  ])('recognizes static hosting at %s//%s', (protocol, hostname) => {
    expect(isStaticWebDeployment(protocol, hostname)).toBe(true);
  });

  it.each([
    ['https:', 'sully-os-nu.vercel.app'],
    ['http:', 'localhost'],
    ['https:', 'api.minimaxi.com'],
    ['https:', 'test.friedsully.com.evil.example'],
  ])('keeps server-backed or upstream hosts unchanged at %s//%s', (protocol, hostname) => {
    expect(isStaticWebDeployment(protocol, hostname)).toBe(false);
  });
});
