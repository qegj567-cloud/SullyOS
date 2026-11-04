import React, { useState } from 'react';
import type { APIConfig } from '../../types';
import { useStreamingVoice } from '../../hooks/useStreamingVoice';
import type { DialogueLine, StreamedVoice } from '../../utils/elevenLabsStream';
import { shareOrDownloadBlob } from '../../utils/shareExport';
import Modal from '../os/Modal';
import StreamingVoiceBar from './StreamingVoiceBar';

export default function DialogueVoicePanel({ lines: initialLines, apiConfig, onClose }: {
  lines: DialogueLine[]; apiConfig: APIConfig; onClose: () => void;
}) {
  const [lines, setLines] = useState(initialLines);
  const [recording, setRecording] = useState<StreamedVoice | null>(null);
  const [error, setError] = useState('');
  const voice = useStreamingVoice('dialogue');
  const busy = voice.state?.status === 'loading' || voice.state?.status === 'playing';
  const generate = async () => {
    setError(''); setRecording(null);
    try { setRecording(await voice.dialogue('dialogue', lines, apiConfig)); }
    catch (e) { if ((e as Error).name !== 'AbortError') setError((e as Error).message); }
  };
  return <Modal isOpen onClose={() => { voice.stop(); onClose(); }} title="多人配音">
    <div className="space-y-4">
      <p className="text-xs text-slate-500">按消息顺序配音，使用各角色已设置的 ElevenLabs 音色。可先修改台词；不会修改原聊天记录。只包含选中的角色文字消息。</p>
      <div className="max-h-64 space-y-3 overflow-y-auto">
        {lines.map((line, index) => <label key={index} className="block rounded-xl bg-slate-50 p-3">
          <span className="mb-1 block text-xs font-semibold text-slate-600">{line.character.name}{!line.character.voiceProfile?.elevenLabsVoiceId ? ' · 尚未配置音色' : ''}</span>
          <textarea aria-label={`${line.character.name}的台词 ${index + 1}`} disabled={busy} className="w-full resize-y rounded-lg border border-slate-200 bg-white p-2 text-sm" value={line.text} onChange={event => setLines(previous => previous.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} />
        </label>)}
      </div>
      <StreamingVoiceBar state={voice.state} onStop={voice.stop} />
      {error && voice.state?.status !== 'error' && <p role="alert" className="text-xs text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button disabled={busy || !lines.length} onClick={() => void generate()} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-40">生成并播放整段</button>
        {recording && <>
          <button disabled={busy} onClick={() => void voice.replay('dialogue', recording).catch(e => { if (e.name !== 'AbortError') setError(e.message); })} className="rounded-xl bg-slate-100 px-4 py-2 text-sm">重播</button>
          <button onClick={() => void shareOrDownloadBlob({ blob: recording.blob, fileName: '多人配音.wav', shareTitle: '多人配音' }).catch(e => setError(e.message))} className="rounded-xl bg-slate-100 px-4 py-2 text-sm">保存整段音频</button>
        </>}
      </div>
    </div>
  </Modal>;
}
