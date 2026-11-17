import React from 'react';
import type { ListeningDiagnostics } from '../../utils/companion/listening';
import './CompanionMicMeter.css';

export function CompanionMicMeter({ data, active }: { data?: ListeningDiagnostics; active: boolean }) {
  if (!data) return null;
  const db = data.rms > 0 ? 20 * Math.log10(data.rms) : -60;
  const level = Math.round(Math.max(0, Math.min(100, (db + 60) / 60 * 100)));
  const note = !active ? '收音已停止；以上为停止前的数据。' : data.muted ? '输入设备暂时没有提供音频，请检查麦克风是否静音。'
    : data.contextState !== 'running' ? '浏览器收音尚未运行，请回到此页面重新开启。'
    : !data.packets ? '等待第一包音频…'
    : data.quietSeconds >= 5 ? '最近 5 秒输入很轻或无声。若你正在说话，请检查 Edge 选中的麦克风。'
    : data.responses ? '豆包已响应，确认文字后才发送给角色。' : '音频正在发送，等待豆包返回识别结果。';
  return <div className="companion-mic-meter" aria-label="麦克风收音状态">
    <div className="companion-mic-device">麦克风：{data.device}</div>
    <div className="companion-mic-level"><span>输入音量</span><meter aria-label="麦克风输入音量" min={0} max={100} value={level}/><span>{level}%</span></div>
    <div>已发送 {(data.packets * 0.2).toFixed(1)} 秒 · {data.packets} 包 · 收到 {data.responses} 次响应</div>
    <small>{note}</small>
  </div>;
}
