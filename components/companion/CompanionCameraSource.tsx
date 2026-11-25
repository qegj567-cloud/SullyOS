import React, { useCallback, useEffect, useRef, useState } from 'react';

/** Device identities stay in this page, never in settings, prompts or telemetry. */
export function CompanionCameraSource({ selected, active, activeLabel, change, selectRef }: {
  selected: string; active: boolean; activeLabel: string; change: (id: string) => void;
  selectRef?: React.Ref<HTMLSelectElement>;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [problem, setProblem] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (!navigator.mediaDevices?.enumerateDevices) {
      setProblem('浏览器未提供设备列表，请在浏览器的相机设置中选择输入设备。');
      return;
    }
    setRefreshing(true);
    try {
      const next = await navigator.mediaDevices.enumerateDevices();
      if (current !== generation.current) return;
      setDevices(next.filter(device => device.kind === 'videoinput' && device.deviceId));
      setProblem('');
    } catch {
      if (current === generation.current) setProblem('暂时无法读取摄像头列表，请允许此站使用相机后刷新设备。');
    } finally { if (current === generation.current) setRefreshing(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const media = navigator.mediaDevices;
    const changed = () => { void refresh(); };
    media?.addEventListener?.('devicechange', changed);
    return () => { generation.current++; media?.removeEventListener?.('devicechange', changed); };
  }, [refresh, active]);

  return <div className="companion-camera-source">
    <div>
      <label>摄像头来源<select ref={selectRef} aria-label="摄像头来源" value={selected} onChange={event => change(event.target.value)}>
        <option value="">自动选择（手机优先后摄）</option>
        {selected && !devices.some(device => device.deviceId === selected) && <option value={selected}>所选设备暂不可见，请刷新设备</option>}
        {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `摄像头 ${index + 1}（名称待授权）`}</option>)}
      </select></label>
      <button type="button" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? '正在刷新' : '刷新设备'}</button>
    </div>
    {active && <p role="status">当前输入：{activeLabel || '摄像头（浏览器未提供名称）'}</p>}
    {problem && <p role="status">{problem}</p>}
    <details><summary>使用 VTS / OBS 虚拟摄像头</summary>
      <p>先在 VTS 开启 Activate Virtual Webcam，或在 OBS 点击「启动虚拟摄像机」，然后刷新设备，选择 VTubeStudioCam 或 OBS Virtual Camera，再点「开启镜头」。切换来源会关闭当前镜头并停止本轮回复。</p>
      <p>列表不全或没有设备名称时，先在浏览器地址栏允许此站使用相机，再刷新设备；新装虚拟摄像头后可能需要重启浏览器。本次选择仅在当前页面保留。</p>
    </details>
  </div>;
}
