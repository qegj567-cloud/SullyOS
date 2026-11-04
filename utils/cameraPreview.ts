type Facing = 'user' | 'environment';
type Options = {
  video: () => HTMLVideoElement | null;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  ready: (value: boolean) => void;
  error: (message: string) => void;
  status: (message: string) => void;
  track?: (value: MediaStreamTrack | null) => void;
  portrait?: () => boolean;
};

/** One owner for permission requests, tracks and playback, including late iOS results. */
export function createCameraPreview(options: Options) {
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  let media: MediaStream | null = null;
  let attachedVideo: HTMLVideoElement | null = null;
  let detach = () => {};
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let compatibleMode = false;
  let orientationQueue: Promise<void> = Promise.resolve();
  const dimensions = (compatible = false): MediaTrackConstraints => {
    const portrait = options.portrait?.() === true;
    const long = compatible ? 960 : 1440, short = compatible ? 720 : 1080;
    return { width: { ideal: portrait ? short : long }, height: { ideal: portrait ? long : short }, ...(!compatible ? { resizeMode: { ideal: 'none' } } : {}) };
  };
  function reframe() {
    const track = media?.getVideoTracks()[0], token = generation;
    if (!track?.applyConstraints || track.readyState !== 'live') return;
    orientationQueue = orientationQueue.catch(() => {}).then(async () => {
      if (token !== generation || track.readyState !== 'live') return;
      // Keep lens, facing mode and hardware zoom while adjusting only orientation.
      try { await track.applyConstraints({ ...track.getConstraints?.(), ...dimensions(compatibleMode) }); } catch {}
    });
  }
  const later = (callback: () => void, delay: number) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
    return timer;
  };
  function stop() {
    generation++;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    detach(); detach = () => {};
    const owned = media; media = null;
    const video = attachedVideo; attachedVideo = null;
    if (owned && video?.srcObject === owned) { video.pause(); video.srcObject = null; }
    owned?.getTracks().forEach(track => track.stop());
    options.track?.(null);
    options.ready(false);
  }
  function start(facing: Facing, deviceId?: string) {
    let recovered = false;
    const request = (compatible = false) => {
      stop();
      compatibleMode = compatible;
      const token = generation;
      const current = () => token === generation;
      options.error(''); options.status(compatible ? '正在重新连接相机…' : '正在打开相机…');
      const fail = (message: string) => { if (current()) { stop(); options.error(message); } };
      const recover = (message: string) => {
        if (!current()) return;
        if (recovered) { fail(message); return; }
        recovered = true;
        stop();
        options.status('相机短暂中断，正在重新连接…');
        later(() => request(true), 400);
      };
      // Do not acquire a second iOS camera while an earlier permission request is unresolved.
      // Orientation is a crop concern, not a reason to repeatedly stop/reacquire the sensor.
      const pending = queue.then(async () => {
        if (!current()) return null;
        const result = await options.getUserMedia({ audio: false, video: {
          facingMode: { ideal: facing },
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          ...dimensions(compatible),
          frameRate: { ideal: 24, max: 30 },
        } });
        if (!current()) { result.getTracks().forEach(track => track.stop()); return null; }
        return result;
      });
      queue = pending.then(() => {}, () => {});
      void pending.then(result => {
        if (!result) return;
        if (!current()) { result.getTracks().forEach(track => track.stop()); return; }
        media = result;
        const video = options.video(), tracks = result.getVideoTracks();
        if (!video || !tracks.length || tracks.some(track => track.readyState === 'ended')) {
          recover('摄像头无法保持连接。请关闭其他使用相机的页面或应用后重试。'); return;
        }
        const removers: Array<() => void> = [];
        const listen = (target: EventTarget, name: string, handler: () => void) => {
          target.addEventListener(name, handler); removers.push(() => target.removeEventListener(name, handler));
        };
        detach = () => removers.forEach(remove => remove());
        let muteTimer: ReturnType<typeof setTimeout> | undefined;
        let startupTimer: ReturnType<typeof setTimeout> | undefined;
        const ready = () => {
          if (!current() || video.srcObject !== result) return;
          if (tracks.some(track => track.readyState !== 'live' || track.muted)) return;
          if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
          if (startupTimer) { clearTimeout(startupTimer); timers.delete(startupTimer); }
          if (muteTimer) { clearTimeout(muteTimer); timers.delete(muteTimer); }
          options.error(''); options.status(''); options.ready(true);
        };
        const muted = () => {
          if (!current()) return;
          options.ready(false); options.status('相机暂时中断，正在等待画面…');
          if (muteTimer) { clearTimeout(muteTimer); timers.delete(muteTimer); }
          muteTimer = later(() => recover('相机仍未恢复，请关闭其他使用相机的页面或应用后重试。'), 1800);
        };
        for (const track of tracks) {
          listen(track, 'ended', () => recover('摄像头仍无法连接，请关闭其他使用相机的页面或应用后重试。'));
          listen(track, 'mute', muted);
          listen(track, 'unmute', () => {
            if (muteTimer) { clearTimeout(muteTimer); timers.delete(muteTimer); muteTimer = undefined; }
            ready();
          });
        }
        for (const name of ['loadeddata', 'canplay', 'playing']) listen(video, name, ready);
        video.muted = true; video.autoplay = true; video.playsInline = true;
        video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '');
        attachedVideo = video;
        video.srcObject = result;
        options.track?.(tracks[0]);
        startupTimer = later(() => recover('相机没有返回画面，请重试或从相册选择。'), 10000);
        if (tracks.some(track => track.muted)) muted();
        void video.play().then(ready, () => fail('相机预览未能播放，请点重试；仍失败可从相册选择。'));
      }, error => {
        if (!current()) return;
        const name = error?.name;
        if (name === 'NotReadableError' || name === 'OverconstrainedError' || name === 'AbortError') {
          recover('摄像头暂时不可用，请关闭其他使用相机的页面或应用后重试。'); return;
        }
        fail(name === 'NotAllowedError' ? '未获得相机权限，请在浏览器设置中允许访问相机后重试。'
          : name === 'NotFoundError' ? '没有找到可用摄像头。'
          : error instanceof Error ? error.message : '无法打开相机，请重试。');
      });
    };
    request();
  }
  return { start, stop, reframe };
}
