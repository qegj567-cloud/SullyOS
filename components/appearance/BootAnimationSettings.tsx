import React from 'react';
import type { OSTheme } from '../../types';

export default function BootAnimationSettings({theme,updateTheme}: {
  theme: OSTheme;
  updateTheme: (patch: Partial<OSTheme>) => void;
}) {
  return <div className="mt-5 border-t border-slate-100 pt-4">
    <h3 className="text-xs font-bold text-slate-700">开机动画风格</h3>
    <p className="mt-1 text-[10px] leading-relaxed text-slate-400">下次启动时生效。动画开关在「动画与过场」中，关闭后仍会记住所选风格。</p>
    <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="开机动画风格">
      {([
        {id:'classic',name:'原版',description:'壁纸柔光 · 文字浮现'},
        {id:'jellyfish',name:'水母',description:'紫色星光 · 小水母'},
      ] as const).map(option => <button key={option.id} type="button"
        aria-pressed={(theme.bootAnimationStyle || 'jellyfish') === option.id}
        onClick={()=>updateTheme({bootAnimationStyle:option.id})}
        className={`rounded-2xl border px-3 py-3 text-left transition-colors ${(theme.bootAnimationStyle || 'jellyfish') === option.id ? 'border-primary bg-primary/5' : 'border-slate-200 bg-white'}`}>
        <span className="block text-xs font-semibold text-slate-700">{option.name}</span>
        <span className="mt-1 block text-[10px] text-slate-400">{option.description}</span>
      </button>)}
    </div>
  </div>;
}
