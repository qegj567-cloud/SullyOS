import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

// An isolated browser benchmark, not production telemetry. Frame timings are
// event-to-post-animation-frame estimates; they are not phone hardware INP.
export async function measureAmsgSettings(page, base, out) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => {
    const samples = [], longTasks = [];
    const state = { samples, longTasks, startedAt: 0 };
    window.amsgPerformance = state;
    new PerformanceObserver(list => {
      for (const item of list.getEntries()) if (item.startTime >= state.startedAt) longTasks.push({ start: item.startTime, duration: item.duration });
    }).observe({ type: 'longtask', buffered: false });
    for (const eventName of ['input', 'change', 'click']) document.addEventListener(eventName, event => {
      if (!state.startedAt) return;
      const element = event.target;
      const kind = element.matches('input[aria-label="搜索角色"]') ? 'search'
        : element.closest('[role="tab"]') ? 'navigation'
          : element.closest('.amsg-character-pagination, .amsg-character-filters') ? 'filter-or-page' : null;
      if (!kind) return;
      const started = performance.now();
      requestAnimationFrame(() => setTimeout(() => samples.push({ kind, ms: performance.now() - started }), 0));
    }, true);
  });
  await page.goto(`${base}?stress&platform=apk`);
  await page.getByRole('button', { name: /^主动消息 2.0/ }).click();
  await page.getByText('共 3002 位', { exact: true }).waitFor();
  await page.waitForTimeout(200);
  const initialNodes = await page.locator('.amsg-workspace-page *').count();
  if (process.env.AMSG_QA_PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  await page.evaluate(() => {
    window.amsgPerformance.samples.length = 0;
    window.amsgPerformance.longTasks.length = 0;
    window.amsgPerformance.startedAt = performance.now();
  });
  const search = page.getByRole('searchbox', { name: '搜索角色', exact: true });
  for (const text of ['角色 2999', '角色 ２９８', '林', '角色 1234']) {
    await search.fill('');
    await search.pressSequentially(text, { delay: 20 });
    await page.waitForTimeout(120);
    assert.ok(await page.locator('.amsg-overview-character').count() <= 12);
  }
  await search.fill('');
  await page.getByRole('combobox', { name: '角色分类', exact: true }).selectOption('story');
  await page.getByRole('combobox', { name: '角色分类', exact: true }).selectOption('all');
  await page.getByRole('button', { name: '下一页角色', exact: true }).click();
  await page.getByRole('combobox', { name: '角色页码', exact: true }).selectOption('250');
  assert.equal(await page.locator('.amsg-overview-character').count(), 2);
  const nav = page.getByRole('tablist', { name: '主动消息分区', exact: true });
  await nav.getByRole('tab', { name: '功能设置', exact: true }).click();
  const sections = page.getByRole('tablist', { name: '功能设置分区', exact: true });
  await sections.getByRole('tab', { name: '高级维护', exact: true }).click();
  await nav.getByRole('tab', { name: '通知与设备', exact: true }).click();
  await nav.getByRole('tab', { name: '功能总览', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: '角色页码', exact: true }).inputValue(), '250');
  await page.waitForTimeout(150);
  const raw = await page.evaluate(() => window.amsgPerformance);
  if (process.env.AMSG_QA_PROFILE) {
    const { profile } = await cdp.send('Profiler.stop');
    writeFileSync(`${out}/performance-profile.json`, JSON.stringify(profile));
  }
  const percentile = (values, fraction) => values.length ? Math.round([...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] * 10) / 10 : 0;
  const report = {
    characters: 3002, cpuSlowdown: 4, initiallyMountedElements: initialNodes,
    renderedCharacterRows: await page.locator('.amsg-overview-character').count(),
    events: Object.fromEntries(['search', 'navigation', 'filter-or-page'].map(kind => {
      const values = raw.samples.filter(sample => sample.kind === kind).map(sample => sample.ms);
      return [kind, { samples: values.length, medianMs: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: percentile(values, 1) }];
    })),
    longTasks: raw.longTasks.length,
    longestTaskMs: percentile(raw.longTasks.map(task => task.duration), 1),
  };
  const label = process.env.AMSG_QA_PERF_LABEL || 'latest';
  writeFileSync(`${out}/performance-${label}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
}
