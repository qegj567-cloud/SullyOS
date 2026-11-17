import type { CompanionSttConfig } from '../../types';
import { getProxyWorkerUrl } from '../proxyWorker';
import { asrPacket, asrStartPacket, AsrTranscript, parseAsrPacket } from './doubaoProtocol';
import type { ListeningCallbacks, ListeningDiagnostics } from './listening';

export function doubaoRelayUrl(location = window.location) {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const url = new URL(`${local ? location.origin : getProxyWorkerUrl()}/doubao/asr`);
  if (url.username || url.password || !['https:', ...(local ? ['http:'] : [])].includes(url.protocol)) throw new Error('豆包识别需要安全的语音转发连接');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export function canUseDoubaoListening() {
  return typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.AudioContext === 'function'
    && typeof window.AudioWorkletNode === 'function' && typeof window.WebSocket === 'function';
}

/** Returns disposal immediately, including while microphone permission or the WS handshake is pending. */
export function startDoubaoListening(config: CompanionSttConfig, callbacks: ListeningCallbacks) {
  if (!config.apiKey.trim()) throw new Error('请先在同行 API 接入中填写豆包语音 Key');
  if (!canUseDoubaoListening()) throw new Error('此浏览器不支持豆包连续收音，请使用新版浏览器或文字输入');
  let stopped = false, ready = false;
  let stream: MediaStream | undefined, socket: WebSocket | undefined, node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined, mute: GainNode | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const context = new AudioContext({ latencyHint: 'interactive' });
  const diagnostics: ListeningDiagnostics = { device: '', contextState: context.state, sampleRate: context.sampleRate,
    rms: 0, packets: 0, responses: 0, quietSeconds: 0, muted: false };
  let lastPacketAt = performance.now();
  const report = () => {
    if (stopped) return;
    const track = stream?.getAudioTracks()[0];
    callbacks.diagnostics?.({ ...diagnostics, contextState: context.state,
      device: track?.label || '默认麦克风', muted: track?.muted ?? false });
  };
  const transcript = new AsrTranscript();
  const stop = () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer); clearInterval(watchdog);
    stream?.getTracks().forEach(track => track.stop());
    if (node) { node.port.onmessage = null; node.onprocessorerror = null; node.disconnect(); }
    source?.disconnect(); mute?.disconnect();
    if (socket && socket.readyState < 2) socket.close(1000, 'stopped');
    void context.close().catch(() => {});
  };
  const fail = (message: string) => { if (!stopped) { stop(); callbacks.error(message); } };
  // Attach rejection handling immediately, even while microphone permission is still pending.
  const resume = context.resume().catch(() => fail('音频设备未能启动，请重新开启连续听'));
  callbacks.state?.('正在申请麦克风');
  void (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (stopped) { stream.getTracks().forEach(track => track.stop()); return; }
      callbacks.state?.('麦克风已允许，正在启动收音'); report();
      timer = setTimeout(() => fail('麦克风已允许，但浏览器音频仍未启动；请回到此页面，点击重新开启连续听'), 10_000);
      await resume;
      if (stopped) return;
      await context.audioWorklet.addModule(new URL('./doubaoPcm.worklet.js', import.meta.url));
      if (stopped) return;
      clearTimeout(timer);
      callbacks.state?.('正在连接豆包识别');
      socket = new WebSocket(doubaoRelayUrl()); socket.binaryType = 'arraybuffer';
      timer = setTimeout(() => fail('豆包识别连接超时，请检查网络和语音服务配置'), 20_000);
      socket.onopen = () => { if (!stopped) socket!.send(JSON.stringify({ type: 'start', apiKey: config.apiKey, resourceId: config.resourceId })); };
      let incoming = Promise.resolve();
      socket.onmessage = event => {
        incoming = incoming.then(async () => {
          if (stopped) return;
          if (typeof event.data === 'string') {
            const message = JSON.parse(event.data);
            if (message.type === 'error') {
              const code = typeof message.code === 'string' && /^(http-\d{3}|[a-z]+(?:-[a-z]+){0,2})$/.test(message.code) ? message.code : 'relay';
              fail(code === 'session-limit' ? '本次连续听已满 30 分钟，请重新开启' : `豆包识别连接失败（${code}），请检查语音 Key、开通状态及应用代理版本`); return;
            }
            if (message.type !== 'ready' || ready) return;
            ready = true; clearTimeout(timer);
            socket!.send(asrStartPacket());
            source = context.createMediaStreamSource(stream!);
            node = new AudioWorkletNode(context, 'companion-pcm');
            node.onprocessorerror = () => fail('麦克风音频处理停止，已释放收音；请刷新页面后重试');
            mute = context.createGain(); mute.gain.value = 0;
            source.connect(node); node.connect(mute); mute.connect(context.destination);
            node.port.onmessage = ({ data }) => {
              if (stopped || socket?.readyState !== WebSocket.OPEN) return;
              if (!(data instanceof ArrayBuffer) || data.byteLength !== 6400) { fail('麦克风音频分包异常'); return; }
              if (socket.bufferedAmount > 128 * 1024) { fail('语音上传网络过慢，已停止收音，请重新开启'); return; }
              socket.send(asrPacket(2, new Uint8Array(data)));
              // Measure the same PCM bytes sent upstream, not a separate microphone path.
              const samples = new DataView(data); let squares = 0;
              for (let i = 0; i < 3200; i++) { const value = samples.getInt16(i * 2, true) / 32768; squares += value * value; }
              diagnostics.rms = Math.sqrt(squares / 3200);
              diagnostics.packets++;
              diagnostics.quietSeconds = diagnostics.rms < 0.002 ? diagnostics.quietSeconds + 0.2 : 0;
              lastPacketAt = performance.now(); report();
            };
            lastPacketAt = performance.now();
            watchdog = setInterval(() => {
              report();
              if (performance.now() - lastPacketAt > 5000) fail(context.state === 'running'
                ? '麦克风已连接，但连续 5 秒没有音频数据；请检查 Edge 使用的输入设备后重新开启'
                : '浏览器暂停了收音，已停止识别；请回到此页面重新开启连续听');
            }, 1000);
            report();
            callbacks.state?.('豆包正在听'); return;
          }
          if (!(event.data instanceof ArrayBuffer)) throw new Error('豆包识别响应格式异常');
          const result = await parseAsrPacket(event.data);
          if (stopped) return;
          diagnostics.responses++; report();
          const update = transcript.consume(result);
          if (update.partial || update.finals.length) callbacks.speech();
          callbacks.partial(update.partial);
          // Several definite segments from one snapshot are a single user turn.
          if (update.finals.length) callbacks.final(update.finals.join(''));
        }).catch(error => fail(error instanceof Error ? error.message : '豆包识别响应未能解析'));
      };
      socket.onerror = () => fail('豆包识别连接失败；本地请重启预览，线上需更新应用主代理');
      socket.onclose = () => fail('豆包识别连接已结束，请重新开启连续听');
      for (const track of stream.getAudioTracks()) track.onended = () => fail('麦克风已断开');
    } catch (error) {
      fail(error instanceof Error && error.name === 'NotAllowedError' ? '麦克风权限未允许' : '豆包收音未能启动，请检查麦克风和浏览器支持');
    }
  })();
  return stop;
}
