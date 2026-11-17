// Microphone -> 16 kHz mono PCM16, bounded 200 ms chunks. No file or persistent storage.
class CompanionPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.remaining = this.ratio; this.sum = 0;
    this.packet = new Int16Array(3200); this.position = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      let available = 1;
      while (available > 1e-8) {
        const weight = Math.min(available, this.remaining);
        this.sum += sample * weight; this.remaining -= weight; available -= weight;
        if (this.remaining < 1e-8) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.packet[this.position++] = Math.round(value * (value < 0 ? 32768 : 32767));
          this.sum = 0; this.remaining = this.ratio;
          if (this.position === this.packet.length) {
            // Serialize explicitly: ASR PCM is little-endian on every host.
            const buffer = new ArrayBuffer(this.packet.length * 2), view = new DataView(buffer);
            for (let i = 0; i < this.packet.length; i++) view.setInt16(i * 2, this.packet[i], true);
            this.port.postMessage(buffer, [buffer]); this.position = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('companion-pcm', CompanionPcm);
