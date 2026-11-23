// 通道切换与加入黄光的独立预览：真实加入只在 friedsully.com 上能走到，本地看不到动画。
// ?glow 只看黄光；默认显示正式版上解锁后的切换标签。
import React from 'react';
import { createRoot } from 'react-dom/client';
import CanaryChannelControl, { CanaryJoinGlow } from '../../components/settings/CanaryChannelControl';

const glow = new URLSearchParams(location.search).has('glow');
createRoot(document.getElementById('root')!).render(
  <div className="flex h-full flex-col items-center justify-center gap-6">
    <div className="text-[10px] font-mono tracking-widest text-slate-300">V3.17 (PREVIEW)</div>
    <CanaryChannelControl unlocked />
    {glow && <CanaryJoinGlow />}
  </div>,
);
