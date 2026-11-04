import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCameraPreview } from './cameraPreview';

class Track extends EventTarget {
  readyState = 'live'; muted = false;
  stop = vi.fn(() => { this.readyState = 'ended'; });
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  mute(value: boolean) { this.muted = value; this.dispatchEvent(new Event(value ? 'mute' : 'unmute')); }
}
function source(track = new Track()) {
  return { track, media: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream };
}
function setup(getUserMedia = vi.fn()) {
  const video = Object.assign(new EventTarget(), {
    srcObject: null as MediaStream | null, readyState: 2, videoWidth: 1440, videoHeight: 1080,
    muted: false, autoplay: false, playsInline: false, setAttribute: vi.fn(),
    pause: vi.fn(), play: vi.fn().mockResolvedValue(undefined),
  });
  const ready = vi.fn(), error = vi.fn(), status = vi.fn();
  const session = createCameraPreview({ video: () => video as any, getUserMedia, ready, error, status });
  return { session, video, ready, error, status, getUserMedia };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
it('keeps an explicitly chosen lens through the compatible retry without adding a crop',async()=>{
 const a=source(),f=setup(vi.fn().mockRejectedValueOnce(Object.assign(new Error('retry'),{name:'OverconstrainedError'})).mockResolvedValue(a.media));
 f.session.start('environment','rear-main');await flush();
 expect(f.getUserMedia.mock.calls[0][0].video).toMatchObject({deviceId:{exact:'rear-main'},resizeMode:{ideal:'none'}});
 await vi.advanceTimersByTimeAsync(400);await flush();
 expect(f.getUserMedia.mock.calls[1][0].video.deviceId).toEqual({exact:'rear-main'});f.session.stop();
});
it('requests portrait pixels for portrait phones and changes orientation without reacquiring or losing the lens/zoom',async()=>{
 const a=source(),f=setup(vi.fn().mockResolvedValue(a.media));let portrait=true;
 const constraints={deviceId:{exact:'main'},facingMode:{ideal:'environment'},advanced:[{zoom:1.5}]};
 const applyConstraints=vi.fn().mockResolvedValue(undefined);
 Object.assign(a.track,{getConstraints:()=>constraints,applyConstraints});
 const session=createCameraPreview({video:()=>f.video as any,getUserMedia:f.getUserMedia,ready:f.ready,error:f.error,status:f.status,portrait:()=>portrait});
 session.start('environment','main');await flush();
 expect(f.getUserMedia.mock.calls[0][0].video).toMatchObject({width:{ideal:1080},height:{ideal:1440}});
 portrait=false;session.reframe();await flush();
 expect(f.getUserMedia).toHaveBeenCalledOnce();expect(applyConstraints).toHaveBeenCalledWith({...constraints,width:{ideal:1440},height:{ideal:1080},resizeMode:{ideal:'none'}});
 session.stop();session.reframe();await flush();expect(applyConstraints).toHaveBeenCalledOnce();
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('accepts only a live, unmuted stream with decoded pixels; configures inline silent playback', async () => {
  const a = source(); a.track.muted = true;
  const f = setup(vi.fn().mockResolvedValue(a.media));
  f.session.start('environment'); await flush();
  expect(f.video.playsInline).toBe(true); expect(f.video.muted).toBe(true);
  expect(f.ready).not.toHaveBeenCalledWith(true);
  a.track.mute(false); expect(f.ready).toHaveBeenLastCalledWith(true);
  f.session.stop(); expect(f.video.srcObject).toBeNull(); expect(a.track.stop).toHaveBeenCalledOnce();
});

it('serializes rapid switches, discards obsolete requests and stops their late streams before acquiring another', async () => {
  const a = source(), b = source(); let resolve!: (m: MediaStream) => void;
  const f = setup(vi.fn().mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValueOnce(b.media));
  f.session.start('environment'); await flush();
  f.session.start('environment'); f.session.start('user'); await flush();
  expect(f.getUserMedia).toHaveBeenCalledTimes(1);
  resolve(a.media); await flush();
  expect(a.track.stop).toHaveBeenCalledOnce(); expect(f.getUserMedia).toHaveBeenCalledTimes(2);
  expect(f.getUserMedia.mock.calls[1][0].video.facingMode.ideal).toBe('user');
  expect(f.video.srcObject).toBe(b.media); f.session.stop();
});

it('reconnects once after an immediate ended stream, then stops instead of looping forever', async () => {
  const a = source(), b = source();
  const f = setup(vi.fn().mockResolvedValueOnce(a.media).mockResolvedValueOnce(b.media));
  f.session.start('environment'); await flush(); a.track.end();
  expect(f.ready).toHaveBeenLastCalledWith(false); expect(f.video.srcObject).toBeNull();
  await vi.advanceTimersByTimeAsync(400);
  expect(f.video.srcObject).toBe(b.media); expect(f.ready).toHaveBeenLastCalledWith(true);
  b.track.end(); await vi.advanceTimersByTimeAsync(20000);
  expect(f.getUserMedia).toHaveBeenCalledTimes(2);
  expect(f.error).toHaveBeenLastCalledWith(expect.stringContaining('仍无法连接')); f.session.stop();
});

it('cleans an already-ended initial track and retries at lower resolution', async () => {
  const a = source(), b = source(); a.track.readyState = 'ended';
  const f = setup(vi.fn().mockResolvedValueOnce(a.media).mockResolvedValueOnce(b.media));
  f.session.start('user'); await flush(); await vi.advanceTimersByTimeAsync(400);
  expect(a.track.stop).toHaveBeenCalledOnce(); expect(f.video.srcObject).toBe(b.media);
  expect(f.getUserMedia.mock.calls[1][0].video.width.ideal).toBe(960); f.session.stop();
});

it('waits through a brief mute without reacquiring the camera, but recovers a prolonged mute', async () => {
  const a = source(), b = source();
  const f = setup(vi.fn().mockResolvedValueOnce(a.media).mockResolvedValueOnce(b.media));
  f.session.start('user'); await flush();
  a.track.mute(true); await vi.advanceTimersByTimeAsync(500); a.track.mute(false);
  await vi.advanceTimersByTimeAsync(2000); expect(f.getUserMedia).toHaveBeenCalledTimes(1);
  a.track.mute(true); await vi.advanceTimersByTimeAsync(2200);
  expect(f.getUserMedia).toHaveBeenCalledTimes(2); expect(f.ready).toHaveBeenLastCalledWith(true); f.session.stop();
});

it.each(['NotAllowedError', 'NotFoundError'])('does not repeatedly request permission/devices after %s', async name => {
  const f = setup(vi.fn().mockRejectedValue(new DOMException('denied', name)));
  f.session.start('environment'); await flush(); await vi.advanceTimersByTimeAsync(30000);
  expect(f.getUserMedia).toHaveBeenCalledTimes(1); expect(f.error.mock.lastCall?.[0]).toMatch(/权限|摄像头/); f.session.stop();
});

it('uses one compatibility retry after acquisition failure and cancels all recovery work on close', async () => {
  const f = setup(vi.fn().mockRejectedValue(new DOMException('busy', 'NotReadableError')));
  f.session.start('environment'); await flush(); await vi.advanceTimersByTimeAsync(400);
  expect(f.getUserMedia).toHaveBeenCalledTimes(2);
  f.session.start('user'); await flush(); f.session.stop();
  await vi.advanceTimersByTimeAsync(30000); expect(f.getUserMedia).toHaveBeenCalledTimes(3);
});

it('does not let old playback errors tear down the new camera', async () => {
  const a = source(), b = source(); let reject!: (error: Error) => void;
  const f = setup(vi.fn().mockResolvedValueOnce(a.media).mockResolvedValueOnce(b.media));
  f.video.play.mockReturnValueOnce(new Promise((_r, r) => { reject = r; }));
  f.session.start('environment'); await flush(); f.session.start('user'); await flush();
  reject(new Error('old play interrupted')); await flush();
  expect(f.video.srcObject).toBe(b.media); expect(b.track.stop).not.toHaveBeenCalled(); f.session.stop();
});

it('stops a late permission result after the camera was closed without mounting or reconnecting', async () => {
  const a = source(); let resolve!: (m: MediaStream) => void;
  const f = setup(vi.fn().mockReturnValue(new Promise(r => { resolve = r; })));
  f.session.start('environment'); await flush(); f.session.stop(); resolve(a.media); await flush();
  expect(a.track.stop).toHaveBeenCalledOnce(); expect(f.video.play).not.toHaveBeenCalled();
  expect(f.ready).not.toHaveBeenCalledWith(true);
});

it('does not enable shutter for an empty video and bounds the no-frame timeout', async () => {
  const a = source(), b = source(); const f = setup(vi.fn().mockResolvedValueOnce(a.media).mockResolvedValueOnce(b.media));
  f.video.videoWidth = 0; f.video.readyState = 0;
  f.session.start('environment'); await flush(); await vi.advanceTimersByTimeAsync(22000);
  expect(f.getUserMedia).toHaveBeenCalledTimes(2); expect(f.ready).not.toHaveBeenCalledWith(true);
  expect(f.error).toHaveBeenLastCalledWith(expect.stringContaining('没有返回画面')); f.session.stop();
});
