/** An explicit source must never silently fall back to a different camera. */
export function companionCameraConstraints(deviceId: string): MediaStreamConstraints {
  return { audio: false, video: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
    width: { ideal: 640 }, frameRate: { ideal: 12 },
  } };
}

export interface CameraSourceHint {
  message: string;
  setting: 'camera';
  suggestVts?: boolean;
}

export function companionCameraError(error: unknown): string | CameraSourceHint {
  const { name = '', message = '' } = error && typeof error === 'object' ? error as { name?: string; message?: string } : {};
  if (name === 'NotAllowedError' || name === 'SecurityError') return '未获得摄像头权限，请在浏览器地址栏允许此站使用相机后重试。';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return { message: '没有找到所选摄像头。请连接设备，再打开', setting: 'camera' };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || /device in use|could not start video source|failed to allocate videosource/i.test(message)) {
    return { message: '摄像头可能被占用或驱动尚未就绪。请打开', setting: 'camera', suggestVts: true };
  }
  if (name === 'OverconstrainedError') return { message: '所选摄像头不支持当前采集设置。请打开', setting: 'camera' };
  return `摄像头未能开启：${message || '请检查浏览器权限和输入设备后重试'}`;
}
