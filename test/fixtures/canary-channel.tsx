// 通道切换与加入黄光的独立预览：真实加入只在 friedsully.com 上能走到，本地看不到动画。
// ?glow 只看黄光；?arrive 看进 canary 后的落地动画；?update 看 canary 里的更新卡片；
// ?changelog 看更新后第一次打开弹的更新日志（示例条目）；
// 默认显示正式版上解锁后的切换标签。
import React from 'react';
import { createRoot } from 'react-dom/client';
import CanaryChannelControl, { CanaryJoinGlow } from '../../components/settings/CanaryChannelControl';
import { CanaryArrival, CanaryBird } from '../../components/CanaryBird';
import CanaryChangelog from '../../components/CanaryChangelog';
import '../../components/WebUpdateNotice.css';

const SAMPLE_CHANGELOG = [
  { date: '2026-11-24', items: ['canary 有了更新日志：每次更新后第一次打开，会按天列出新加的改动。', '设置里的通道标签加了小金丝雀。'] },
  { date: '2026-11-23', items: ['亲手保存 API 时，云端凭据会一起更新。', '音乐 Cookie 与 Brave Key 输入框默认遮挡。', '设置页合并同类卡片，改用页签切换。'] },
  { date: '2026-11-22', items: ['多用户备份逐页导出与恢复。'] },
];

const params = new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(
  <div className="flex h-full flex-col items-center justify-center gap-6">
    <div className="text-[10px] font-mono tracking-widest text-slate-300">V3.17 (PREVIEW)</div>
    <CanaryChannelControl unlocked />
    {params.has('glow') && <CanaryJoinGlow />}
    {params.has('arrive') && <CanaryArrival onDone={() => setTimeout(() => location.reload(), 800)} />}
    {params.has('changelog') && <CanaryChangelog preview days={SAMPLE_CHANGELOG} onClose={() => setTimeout(() => location.reload(), 800)} />}
    {params.has('update') && (
      <aside className="sully-web-update" data-channel="canary" role="region" aria-label="网页更新">
        <CanaryBird size={34} mode="idle" className="sully-web-update-bird" />
        <strong>新版本已准备好</strong>
        <p>可以现在更新，也可以忙完后到设置里点「检查网页更新」。</p>
        <div><button type="button">立即更新</button><button type="button">稍后</button></div>
      </aside>
    )}
  </div>,
);
