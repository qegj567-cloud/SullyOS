import { pcmToWav } from '../voiceStream';

/** Keep single files byte-for-byte. Join independently encoded TTS chunks into one seekable file. */
export async function companionHistoryAudio(parts: readonly Blob[]): Promise<Blob> {
  if (!parts.length) throw new Error('这句话还没有语音');
  if (parts.length === 1) return parts[0];
  const sampleRate = 44100;
  const decoder = new OfflineAudioContext(1, 1, sampleRate);
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const buffer = await decoder.decodeAudioData(await part.arrayBuffer());
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const bytes = new Uint8Array(buffer.length * 2), samples = new DataView(bytes.buffer);
    for (let i = 0; i < buffer.length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i];
      value = Math.max(-1, Math.min(1, value / channels.length));
      samples.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    chunks.push(bytes);
  }
  return pcmToWav(chunks, sampleRate);
}
