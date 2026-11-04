import React from 'react';
import type { StreamingVoiceState } from '../../hooks/useStreamingVoice';
import { voiceCaptionAt } from '../../utils/voiceStream';

/** Captions use the actual output language, rather than pretending a translation has word timing. */
export default function StreamingVoiceBar({ state, onStop }: { state: StreamingVoiceState | null; onStop: () => void }) {
  if (!state || state.status === 'done') return null;
  const { spoken, upcoming } = voiceCaptionAt(state.cues, state.time);
  return <div className="relative z-30 mx-3 my-2 flex shrink-0 items-center gap-3 rounded-2xl border border-emerald-200/60 bg-white/95 px-4 py-3 text-slate-700 shadow-sm" role="region" aria-label="语音同步字幕" onClick={event => event.stopPropagation()}>
    <div className="min-w-0 flex-1 text-sm leading-relaxed">
      {state.status === 'error' ? <span role="alert">{state.error}</span>
        : state.status === 'loading' ? <span>正在准备语音…</span>
        : spoken || upcoming ? <><span className="text-emerald-700">{spoken}</span><span className="text-slate-400">{upcoming}</span></>
        : <span>正在播放…</span>}
    </div>
    <button type="button" onClick={onStop} className="shrink-0 rounded-full bg-slate-100 px-3 py-1.5 text-xs">{state.status === 'error' ? '关闭' : '停止'}</button>
  </div>;
}
