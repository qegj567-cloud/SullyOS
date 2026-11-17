import React, { useEffect, useState } from 'react';

export function CompanionVideoStatus({ active, analyzing, paused, configured, clip, lastSeen, problem, retry, configure }: {
  active: boolean; analyzing: boolean; paused: boolean; configured: boolean;
  clip?: { from: number; to: number }; lastSeen?: number; problem: string;
  retry(): void; configure(): void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!active) return null;
  const age = (timestamp: number) => Math.max(0, Math.floor((now - timestamp) / 1000));
  return <div className="companion-video-status" aria-label="视频理解状态" data-state={paused ? 'paused' : analyzing ? 'analyzing' : 'recording'}>
    <div><strong>{!configured ? '仅实时预览' : paused ? '视频理解已暂停' : analyzing ? '正在分析一段视频' : '正在采集下一段视频'}</strong>
      {configured && paused && <button type="button" onClick={retry}>重试视频理解</button>}
      {!configured && <button type="button" onClick={configure}>配置视频 API</button>}
    </div>
    <small>{analyzing && clip ? `分析中的片段：${Math.max(1, Math.round((clip.to - clip.from) / 1000))} 秒，结束于 ${age(clip.to)} 秒前。` : '上方一直是当前摄像头画面。'}
      {lastSeen !== undefined ? ` 最近已理解的画面结束于 ${age(lastSeen)} 秒前${age(lastSeen) > 20 ? '，可能已过时' : ''}。` : ' 尚无视频理解结果。'}</small>
    {problem && <p role="alert">{problem} 实时预览仍保留。</p>}
  </div>;
}
