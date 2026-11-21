import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Archived update references', () => {
  it('links the handbook collaboration entry to its detailed release note', () => {
    const faqSource = readFileSync(path.resolve(__dirname, '../apps/FAQApp.tsx'), 'utf8');
    const detailSource = readFileSync(path.resolve(__dirname, '../public/changelogs/2026-8-30.html'), 'utf8');
    expect(faqSource).toContain('id: CHANGELOG_2026_08_30');
    expect(faqSource).toContain("src: 'changelogs/2026-8-30.html'");
    expect(detailSource).toContain('ChatApp');
    expect(detailSource).toContain('设置 → 导出');
    expect(detailSource).toContain('长按删除');
  });

  it('keeps the handbook card and detail page linked to the same changelog id', () => {
    const faqSource = readFileSync(path.resolve(__dirname, '../apps/FAQApp.tsx'), 'utf8');
    const detailSource = readFileSync(path.resolve(__dirname, '../public/changelogs/2026-8-10.html'), 'utf8');

    expect(faqSource).toContain('id: CHANGELOG_2026_08_10');
    expect(faqSource).toContain("src: 'changelogs/2026-8-10.html'");
    expect(detailSource).toContain('新增视频通话');
    expect(detailSource).toContain('新增面向 L2D 的桌面主题');
  });
});
