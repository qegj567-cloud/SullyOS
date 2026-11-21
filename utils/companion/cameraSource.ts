/** An explicit source must never silently fall back to a different camera. */
export function companionCameraConstraints(deviceId: string): MediaStreamConstraints {
  return { audio: false, video: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
    width: { ideal: 640 }, frameRate: { ideal: 12 },
  } };
}

export function companionCameraError(error: unknown): string {
  const { name = '', message = '' } = error && typeof error === 'object' ? error as { name?: string; message?: string } : {};
  if (name === 'NotAllowedError' || name === 'SecurityError') return '未获得摄像头权限，请在浏览器地址栏允许此站使用相机后重试。';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到所选摄像头。请确认设备已连接、虚拟摄像头已开启，再刷新设备并重新选择。';
  if (name === 'NotReadableError' || name === 'TrackStartError' || /device in use|could not start video source|failed to allocate videosource/i.test(message)) {
    return '所选摄像头无法启动，可能被占用或驱动尚未就绪。使用 VTS 时，请在「摄像头来源」选择 VTubeStudioCam，并确认 VTS 已开启虚拟摄像头输出。';
  }
  if (name === 'OverconstrainedError') return '所选摄像头无法满足采集设置，请刷新设备并重新选择；使用虚拟摄像头时请确认输出已启动。';
  return `摄像头未能开启：${message || '请检查浏览器权限和输入设备后重试'}`;
}
