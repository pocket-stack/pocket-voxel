class PocketVoxelPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(1 << 16);
    this.right = new Float32Array(1 << 16);
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.phase = 0;
    this.sourceRate = 44100;
    this.muted = false;
    // rAF supplies one 16.7 ms packet per logic tick. Wait for a modest lead
    // before consuming, and rebuild that lead after an underrun, so ordinary
    // scheduling jitter does not turn into a permanent stream of clicks.
    this.started = false;
    this.prebufferFrames = 2048;
    this.port.onmessage = ({ data }) => {
      if (data.type === "mute") {
        this.muted = Boolean(data.muted);
        if (this.muted) {
          this.read = 0;
          this.write = 0;
          this.count = 0;
          this.phase = 0;
          this.started = false;
        }
        return;
      }
      if (this.muted || data.type !== "pcm" || !(data.pcm instanceof Int16Array)) return;
      this.sourceRate = data.rate || 44100;
      for (let i = 0; i + 1 < data.pcm.length; i += 2) {
        if (this.count === this.left.length) {
          this.read = (this.read + 1) & (this.left.length - 1);
          this.count -= 1;
        }
        this.left[this.write] = data.pcm[i] / 32768;
        this.right[this.write] = data.pcm[i + 1] / 32768;
        this.write = (this.write + 1) & (this.left.length - 1);
        this.count += 1;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    const step = this.sourceRate / sampleRate;
    if (!this.muted && !this.started && this.count >= this.prebufferFrames) {
      this.started = true;
    }
    for (let i = 0; i < outL.length; i++) {
      if (!this.muted && this.started && this.count >= 2) {
        const next = (this.read + 1) & (this.left.length - 1);
        outL[i] = this.left[this.read] + (this.left[next] - this.left[this.read]) * this.phase;
        outR[i] = this.right[this.read] + (this.right[next] - this.right[this.read]) * this.phase;
        this.phase += step;
        while (this.phase >= 1 && this.count > 1) {
          this.phase -= 1;
          this.read = (this.read + 1) & (this.left.length - 1);
          this.count -= 1;
        }
      } else {
        outL[i] = 0;
        outR[i] = 0;
        if (this.started && this.count < 2) {
          this.read = 0;
          this.write = 0;
          this.count = 0;
          this.phase = 0;
          this.started = false;
        }
      }
    }
    return true;
  }
}

registerProcessor("pocket-voxel-pcm", PocketVoxelPcm);
