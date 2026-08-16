export class BrowserAudio {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private muted = false;
  private failed = false;

  get available(): boolean {
    return !this.failed && typeof AudioContext !== "undefined";
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Call directly from the ROM picker/drop gesture. */
  async arm(): Promise<boolean> {
    if (this.failed) return false;
    try {
      this.context ??= new AudioContext({ latencyHint: "interactive" });
      // Invoke resume while this method is still on the file-picker/drop
      // gesture stack. Loading the worklet first can lose user activation.
      await this.context.resume();
      if (!this.node) {
        await this.context.audioWorklet.addModule("./audio-worklet.js");
        this.node = new AudioWorkletNode(this.context, "pocket-voxel-pcm", {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        this.node.connect(this.context.destination);
        this.node.port.postMessage({ type: "mute", muted: this.muted });
      }
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  push(pcm: Int16Array, rate: number): void {
    if (!this.node || this.muted || pcm.length === 0) return;
    const copy = pcm.slice();
    this.node.port.postMessage({ type: "pcm", pcm: copy, rate }, [copy.buffer]);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.node?.port.postMessage({ type: "mute", muted });
  }

  async close(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    if (this.context) await this.context.close();
    this.context = null;
  }
}
